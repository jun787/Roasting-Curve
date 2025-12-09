const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const chartCanvas = document.getElementById('curve');
const previewImg = document.getElementById('png-preview');
const phaseTextEl = document.getElementById('phase-text');
const dropTextEl = document.getElementById('drop-text');
const downloadBtn = document.getElementById('download');

let currentBlobUrl = null;

fileInput.addEventListener('change', async (event) => {
  const [file] = event.target.files || [];
  if (!file) return;

  updateStatus(`處理檔案：${file.name}…`);
  metaEl.textContent = '';
  phaseTextEl.textContent = '';
  dropTextEl.textContent = '';
  downloadBtn.disabled = true;
  previewImg.removeAttribute('src');

  try {
    const csvText = await readTextFromFile(file);
    const parsed = parseCsv(csvText);
    const prepared = prepareSeries(parsed);
    renderMeta(prepared, parsed.headers);
    phaseTextEl.textContent = prepared.phases.display;
    dropTextEl.textContent = prepared.phases.dropText;

    const { url } = await renderPng(prepared);
    setPreview(url);
    downloadBtn.disabled = false;
    updateStatus('PNG 已產生，可預覽與下載。');
  } catch (error) {
    console.error(error);
    updateStatus(error.message || '無法讀取烘焙資料。');
  }
});

downloadBtn.addEventListener('click', () => {
  if (!currentBlobUrl) return;
  const link = document.createElement('a');
  link.href = currentBlobUrl;
  link.download = 'roast-curve.png';
  link.click();
});

function setPreview(url) {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
  }
  currentBlobUrl = url;
  previewImg.src = url;
}

function updateStatus(message) {
  statusEl.textContent = message;
}

async function readTextFromFile(file) {
  const ext = file.name.toLowerCase();
  if (ext.endsWith('.csv')) {
    return file.text();
  }
  if (!ext.endsWith('.zip')) {
    throw new Error('僅支援 CSV 或 ZIP 檔案。');
  }

  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const csvEntries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.csv'));
  if (!csvEntries.length) {
    throw new Error('壓縮檔內沒有找到 CSV 檔。');
  }
  const entry = csvEntries[0];
  return entry.async('text');
}

function parseCsv(csvText) {
  const parsed = Papa.parse(csvText, { skipEmptyLines: true });
  if (parsed.errors?.length) {
    throw new Error(parsed.errors[0].message || 'CSV 解析失敗');
  }
  const rows = parsed.data.filter((row) => row.some((cell) => String(cell).trim() !== ''));
  if (!rows.length) {
    throw new Error('CSV 中沒有資料。');
  }

  const headers = rows[0].map((cell) => String(cell).trim());
  const body = rows.slice(1);
  return { headers, rows: body };
}

function normalizeKey(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-龯]+/gi, '')
    .replace('temperature', 'temp');
}

function buildMapping(headers) {
  const normalized = headers.map((header, index) => ({
    header,
    index,
    key: normalizeKey(header),
  }));

  const find = (keywords) => {
    const match = normalized.find(({ key }) => keywords.some((word) => key.includes(word)));
    return match?.index;
  };

  return {
    time: find(['time', 'sec', '時間', '時刻']),
    bt: find(['beantemp', 'bt', '豆溫', 'beantemperature']),
    et: find(['exhaust', 'et', '環境', '排氣', 'exhausttemp']),
    power: find(['power', '火力', 'heater']),
    fan: find(['fan', '風門', 'air']),
    event: find(['event', '模式', 'roastmode', '事件']),
  };
}

function parseTime(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (!text) return NaN;
  const colonParts = text.split(':');
  if (colonParts.length > 1) {
    const numbers = colonParts.map((p) => parseFloat(p.replace(/[^0-9.]/g, '')) || 0);
    while (numbers.length < 3) numbers.unshift(0);
    const [h, m, s] = numbers.slice(-3);
    return h * 3600 + m * 60 + s;
  }
  const numeric = parseFloat(text.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function parseNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function forwardFill(values, initial = 0) {
  let last = initial;
  return values.map((val) => {
    if (Number.isFinite(val)) {
      last = val;
      return val;
    }
    return last;
  });
}

function percentile(values, ratio) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * ratio);
  return sorted[index];
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeControlLevels(values, maxLevel) {
  const finiteValues = values.filter(Number.isFinite);
  const maxVal = finiteValues.length ? Math.max(...finiteValues) : NaN;
  const p95 = finiteValues.length ? percentile(finiteValues, 0.95) : NaN;
  const looksPercent =
    (Number.isFinite(maxVal) && maxVal > 20 && maxVal <= 100) || (Number.isFinite(p95) && p95 > 20 && p95 <= 100);

  return values.map((val) => {
    const base = Number.isFinite(val) ? val : 0;
    if (looksPercent) {
      const pct = clamp(base, 0, 100);
      const level = maxLevel === 10 ? Math.round(pct / 10) : Math.round((pct / 100) * maxLevel);
      return clamp(level, 0, maxLevel);
    }
    return clamp(Math.round(base), 0, maxLevel);
  });
}

function prepareSeries({ headers, rows }) {
  const mapping = buildMapping(headers);
  if (mapping.time === undefined || mapping.bt === undefined) {
    throw new Error('CSV 必須至少包含時間與豆溫欄位。');
  }

  const records = rows
    .map((row) => ({
      rawTime: row[mapping.time],
      bt: mapping.bt !== undefined ? parseNumber(row[mapping.bt]) : NaN,
      et: mapping.et !== undefined ? parseNumber(row[mapping.et]) : NaN,
      power: mapping.power !== undefined ? parseNumber(row[mapping.power]) : NaN,
      fan: mapping.fan !== undefined ? parseNumber(row[mapping.fan]) : NaN,
      event: mapping.event !== undefined ? String(row[mapping.event] ?? '').trim() : '',
    }))
    .filter((row) => row.rawTime !== undefined && String(row.rawTime).trim() !== '');

  const timeSec = records.map((r) => parseTime(r.rawTime));
  const finiteTimes = timeSec.filter(Number.isFinite);
  if (!finiteTimes.length) {
    throw new Error('沒有有效時間資料點。');
  }

  const btRaw = records.map((r) => r.bt);
  const etRaw = records.map((r) => r.et);
  const powerRaw = records.map((r) => r.power);
  const fanRaw = records.map((r) => r.fan);

  const bt = forwardFill(btRaw, 0);
  const et = forwardFill(etRaw, 0);
  const powerLevels = normalizeControlLevels(forwardFill(powerRaw, 0), 10);
  const fanLevels = normalizeControlLevels(forwardFill(fanRaw, 0), 15);

  const chargeIndex = records.findIndex((r) => /charge/i.test(r.event));
  const chargeTime = Number.isFinite(timeSec[chargeIndex]) ? timeSec[chargeIndex] : NaN;
  let baseTime = Number.isFinite(chargeTime) ? chargeTime : finiteTimes[0];
  if (!Number.isFinite(baseTime)) {
    throw new Error('無法決定時間基準點。');
  }

  const times = timeSec.map((t) => {
    if (!Number.isFinite(t)) return NaN;
    return Math.max(0, t - baseTime);
  });

  const samples = times.map((t, idx) => ({
    t,
    bt: bt[idx],
    et: et[idx],
    power: powerLevels[idx],
    fan: fanLevels[idx],
    event: records[idx].event,
  }));

  const sorted = samples.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  if (!sorted.length) {
    throw new Error('CSV 中沒有可用的資料點。');
  }

  const ror = computeRoR(sorted);
  const positiveRoR = ror.filter((v) => Number.isFinite(v) && v > 0);
  let maxPositiveRoR = positiveRoR.length ? Math.max(...positiveRoR) : NaN;
  if (!Number.isFinite(maxPositiveRoR) || maxPositiveRoR <= 0) {
    maxPositiveRoR = 25;
  }
  maxPositiveRoR = clamp(maxPositiveRoR, 1, 80);
  const rightMax = clamp(Math.floor(maxPositiveRoR) + 5, 10, 60);
  const tempMax = rightMax * 10;

  const events = extractEvents(sorted);
  const phases = buildPhases(sorted, events);

  return {
    samples: sorted,
    ror,
    rightMax,
    tempMax,
    events,
    phases,
    maxPositiveRoR,
    totalRecords: records.length,
    totalTime: sorted[sorted.length - 1].t,
  };
}

function computeRoR(samples) {
  const ror = new Array(samples.length).fill(null);
  let firstPositiveSeen = false;
  for (let i = 0; i < samples.length; i++) {
    const currentTime = samples[i].t;
    const window = samples.filter((s) => s.t >= currentTime - 30 && s.t <= currentTime);
    if (window.length < 2) continue;
    const meanT = window.reduce((sum, s) => sum + s.t, 0) / window.length;
    const meanBt = window.reduce((sum, s) => sum + s.bt, 0) / window.length;
    const numerator = window.reduce((sum, s) => sum + (s.t - meanT) * (s.bt - meanBt), 0);
    const denominator = window.reduce((sum, s) => sum + (s.t - meanT) ** 2, 0);
    if (denominator === 0) continue;
    const slopePerSec = numerator / denominator;
    const slopePerMin = slopePerSec * 60;
    if (slopePerMin > 0) firstPositiveSeen = true;
    ror[i] = firstPositiveSeen ? slopePerMin : null;
  }
  return ror;
}

function extractEvents(samples) {
  return samples
    .map((s, idx) => {
      const label = s.event.toUpperCase();
      if (label.includes('YELLOW')) return { idx, t: s.t, bt: s.bt, label: 'YELLOW' };
      if (label.includes('1ST')) return { idx, t: s.t, bt: s.bt, label: '1st CRACK' };
      return null;
    })
    .filter(Boolean);
}

function buildPhases(samples, events) {
  const totalTime = samples[samples.length - 1]?.t ?? 0;
  const yellow = events.find((e) => e.label === 'YELLOW')?.t ?? totalTime / 3;
  const firstCrack = events.find((e) => e.label === '1st CRACK')?.t ?? (totalTime * 2) / 3;

  const a = clampTime(yellow, totalTime);
  const b = clampTime(firstCrack - yellow, totalTime);
  const c = clampTime(totalTime - firstCrack, totalTime);

  const toPct = (val) => (totalTime ? Math.round((val / totalTime) * 100) : 0);
  const display = `A ${toPct(a)}% ${formatTimeLabel(a)}｜B ${toPct(b)}% ${formatTimeLabel(b)}｜C ${toPct(c)}% ${formatTimeLabel(c)}`;
  const dropBt = samples[samples.length - 1]?.bt ?? 0;
  const dropText = `drop ${formatTimeLabel(totalTime)} / BT ${Math.round(dropBt)}°C`;
  return { display, dropText };
}

function clampTime(val, total) {
  if (!Number.isFinite(val) || val < 0) return 0;
  if (val > total) return total;
  return val;
}

function formatTimeLabel(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderMeta(prepared, headers) {
  metaEl.textContent = `資料點：${prepared.totalRecords}｜有效資料點：${prepared.samples.length}｜rightMax=${prepared.rightMax}｜tempMax=${prepared.tempMax}｜maxPositiveRoR=${prepared.maxPositiveRoR.toFixed(2)}｜欄位：${headers.join(', ')}`;
}

function niceTimeStep(totalTime) {
  const candidates = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720, 900];
  const target = totalTime / 8;
  const match = candidates.find((c) => c >= target);
  return match || candidates[candidates.length - 1];
}

async function renderPng({ samples, ror, rightMax, tempMax, events, phases, totalTime }) {
  const width = 1600;
  const height = 900;
  chartCanvas.width = width;
  chartCanvas.height = height;
  const ctx = chartCanvas.getContext('2d');

  const margin = { top: 60, right: 90, bottom: 150, left: 90 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  ctx.fillStyle = '#0b1021';
  ctx.fillRect(0, 0, width, height);

  const totalDuration = Math.max(totalTime, 1);

  const mapX = (t) => margin.left + (Math.max(0, t) / totalDuration) * plotWidth;
  const mapTempY = (temp) => margin.top + plotHeight - (clamp(temp, 0, tempMax) / tempMax) * plotHeight;
  const mapRorY = (rorVal) => mapTempY(rorVal * 10);

  drawGrid(ctx, margin, width, height, tempMax, totalDuration, mapTempY, mapX);
  drawAxes(ctx, margin, width, height, tempMax, rightMax, totalDuration, mapTempY, mapRorY, mapX);

  const times = samples.map((s) => s.t);
  const btData = samples.map((s) => s.bt);
  const etData = samples.map((s) => s.et);
  const powerData = samples.map((s) => s.power * 5);
  const fanData = samples.map((s) => s.fan * 5);

  drawLine(ctx, times, btData, mapX, mapTempY, '#f97316', 2, false);
  drawLine(ctx, times, etData, mapX, mapTempY, '#94a3b8', 2, false);
  drawLine(ctx, times, ror.map((v) => (Number.isFinite(v) ? v : null)), mapX, mapRorY, '#3b82f6', 2, false);
  drawStepped(ctx, times, powerData, mapX, mapTempY, '#ef4444', [6, 4]);
  drawStepped(ctx, times, fanData, mapX, mapTempY, '#10b981', [4, 4]);

  drawEvents(ctx, events, mapX, mapTempY);
  drawFooterText(ctx, width, height, margin, phases);

  const blob = await new Promise((resolve) => chartCanvas.toBlob(resolve, 'image/png'));
  const url = blob ? URL.createObjectURL(blob) : chartCanvas.toDataURL('image/png');
  return { blob, url };
}

function drawGrid(ctx, margin, width, height, tempMax, totalDuration, mapTempY, mapX) {
  ctx.save();
  ctx.strokeStyle = 'rgba(148,163,184,0.18)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let t = 0; t <= tempMax; t += 10) {
    const y = mapTempY(t);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const step = niceTimeStep(totalDuration);
  ctx.strokeStyle = 'rgba(148,163,184,0.12)';
  for (let t = 0; t <= totalDuration; t += step) {
    const x = mapX(t);
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, height - margin.bottom);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAxes(ctx, margin, width, height, tempMax, rightMax, totalDuration, mapTempY, mapRorY, mapX) {
  ctx.save();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, height - margin.bottom);
  ctx.lineTo(width - margin.right, height - margin.bottom);
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '14px "Inter", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let t = 0; t <= tempMax; t += 50) {
    const y = mapTempY(t);
    ctx.fillText(`${t}`, margin.left - 10, y);
    ctx.beginPath();
    ctx.moveTo(margin.left - 6, y);
    ctx.lineTo(margin.left, y);
    ctx.stroke();
  }

  ctx.textAlign = 'left';
  for (let r = 0; r <= rightMax; r += 5) {
    const y = mapRorY(r);
    ctx.fillText(`${r}`, width - margin.right + 10, y);
    ctx.beginPath();
    ctx.moveTo(width - margin.right, y);
    ctx.lineTo(width - margin.right + 6, y);
    ctx.stroke();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = niceTimeStep(totalDuration);
  for (let t = 0; t <= totalDuration; t += step) {
    const x = mapX(t);
    ctx.fillText(formatTimeLabel(t), x, height - margin.bottom + 8);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('時間 (mm:ss)', (width - margin.left - margin.right) / 2 + margin.left, height - margin.bottom + 40);
  ctx.save();
  ctx.translate(30, margin.top + plotCenter(margin, height));
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('溫度 (°C)', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(width - 30, margin.top + plotCenter(margin, height));
  ctx.rotate(Math.PI / 2);
  ctx.fillText('升溫率 (°C/分)', 0, 0);
  ctx.restore();
  ctx.restore();
}

function plotCenter(margin, height) {
  return (height - margin.top - margin.bottom) / 2;
}

function drawLine(ctx, times, values, mapX, mapY, color, width, dashed) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dashed) ctx.setLineDash(dashed);
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || values[i] === null || !Number.isFinite(values[i])) continue;
    const x = mapX(times[i]);
    const y = mapY(values[i]);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawStepped(ctx, times, values, mapX, mapY, color, dash) {
  if (!times.length) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash);
  ctx.beginPath();

  let prevX = null;
  let prevY = null;
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || !Number.isFinite(values[i])) continue;
    const x = mapX(times[i]);
    const y = mapY(values[i]);
    if (prevX === null) {
      ctx.moveTo(x, y);
      prevX = x;
      prevY = y;
      continue;
    }
    ctx.lineTo(x, prevY);
    ctx.lineTo(x, y);
    prevX = x;
    prevY = y;
  }
  ctx.stroke();
  ctx.restore();
}

function drawEvents(ctx, events, mapX, mapY) {
  if (!events.length) return;
  ctx.save();
  ctx.fillStyle = '#f97316';
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 1.5;
  ctx.font = '12px "Inter", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  events.forEach((e) => {
    const x = mapX(e.t);
    const y = mapY(e.bt);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(e.label, x + 6, y - 6);
  });
  ctx.restore();
}

function drawFooterText(ctx, width, height, margin, phases) {
  ctx.save();
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '16px "Inter", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const center = (width - margin.left - margin.right) / 2 + margin.left;
  ctx.fillText(phases.display, center, height - margin.bottom + 64);
  ctx.fillStyle = '#a5b4fc';
  ctx.font = '15px "Inter", system-ui, sans-serif';
  ctx.fillText(phases.dropText, center, height - margin.bottom + 96);
  ctx.restore();
}
