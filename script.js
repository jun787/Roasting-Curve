const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const chartCanvas = document.getElementById('curve');
const previewImg = document.getElementById('png-preview');
const phaseTextEl = document.getElementById('phase-text');
const dropTextEl = document.getElementById('drop-text');
const downloadBtn = document.getElementById('download');
const shareBtn = document.getElementById('share');

let currentBlobUrl = null;
let currentChartTitle = 'roast-curve';
let lastPngBlob = null;
let lastFileBaseName = 'roast-curve';

ensureEnvironment();
if (document.body) {
  document.body.style.backgroundColor = '#0f172a';
}

fileInput.addEventListener('change', async (event) => {
  ensureEnvironment();
  const [file] = event.target.files || [];
  if (!file) return;

  currentChartTitle = sanitizeTitle(file.name);
  lastFileBaseName = currentChartTitle || 'roast-curve';

  updateStatus(`處理檔案：${file.name}…`);
  metaEl.textContent = '';
  phaseTextEl.textContent = '';
  dropTextEl.textContent = '';
  downloadBtn.disabled = true;
  shareBtn.disabled = true;
  previewImg.removeAttribute('src');
  lastPngBlob = null;

  try {
    const csvText = await readTextFromFile(file);
    const parsed = parseCsv(csvText);
    const prepared = prepareSeries(parsed);
    renderMeta(prepared, parsed.headers);
    phaseTextEl.textContent = prepared.phases.display;
    dropTextEl.textContent = prepared.phases.dropText;

    const { blob, url } = await renderPng(prepared, currentChartTitle);
    lastPngBlob = blob;
    setPreview(url);
    downloadBtn.disabled = false;
    shareBtn.disabled = false;
    updateStatus('PNG 已產生，可預覽與下載。');
  } catch (error) {
    console.error(error);
    updateStatus(error.message || '無法讀取烘焙資料。');
  }
});

downloadBtn.addEventListener('click', () => {
  downloadCurrentPng();
});

shareBtn.addEventListener('click', async () => {
  if (!currentBlobUrl || !lastPngBlob) return;
  const fileName = `${lastFileBaseName || 'roast-curve'}.png`;
  const file = new File([lastPngBlob], fileName, { type: 'image/png' });
  const shareData = { files: [file] };
  const canNativeShare =
    typeof navigator !== 'undefined' &&
    navigator.canShare &&
    navigator.share &&
    navigator.canShare(shareData);

  if (canNativeShare) {
    try {
      await navigator.share(shareData);
      updateStatus('已分享圖片。');
      return;
    } catch (err) {
      if (err?.name === 'AbortError') {
        updateStatus('已取消分享');
        return;
      }
      console.error(err);
      updateStatus('無法分享，改用下載。');
    }
  }

  downloadCurrentPng();
});

function setPreview(url) {
  if (currentBlobUrl && currentBlobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(currentBlobUrl);
  }
  currentBlobUrl = url;
  previewImg.src = url;
}

function updateStatus(message) {
  statusEl.textContent = message;
}

function downloadCurrentPng() {
  if (!currentBlobUrl) return;
  const link = document.createElement('a');
  link.href = currentBlobUrl;
  link.download = `${lastFileBaseName || 'roast-curve'}.png`;
  link.click();
}

function ensureEnvironment() {
  if (!statusEl) {
    throw new Error('找不到 #status 元素。');
  }

  const missing = [];
  if (!fileInput) missing.push('找不到 #file-input');
  if (!metaEl) missing.push('找不到 #meta');
  if (!chartCanvas) missing.push('找不到 #curve');
  if (!previewImg) missing.push('找不到 #png-preview');
  if (!downloadBtn) missing.push('找不到 #download 按鈕');
  if (!shareBtn) missing.push('找不到 #share 按鈕');
  if (!window.Papa) missing.push('缺少 Papa Parse');
  if (!window.JSZip) missing.push('缺少 JSZip');
  const ctx = chartCanvas?.getContext?.('2d');
  if (!ctx) missing.push('無法取得畫布 2D context');

  if (missing.length) {
    const message = missing.join('；');
    updateStatus(message);
    throw new Error(message);
  }
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

function sanitizeTitle(filename) {
  if (!filename) return 'roast-curve';
  let name = filename.replace(/\.(zip|csv)$/i, '');
  name = name.replace(/[_\-\s]*csv$/i, '');
  name = name.replace(/[_\-]+$/g, '').trim();
  return name || 'roast-curve';
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(parts[1]);
  const len = binary.length;
  const array = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
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

  const trimmedRows = rows.map((row) => row.map((cell) => String(cell).trim()));
  const limit = Math.min(trimmedRows.length, 100);
  let best = null;

  for (let i = 0; i < limit; i++) {
    const candidateHeaders = trimmedRows[i];
    const mapping = buildMapping(candidateHeaders);
    if (mapping.time === undefined || mapping.bt === undefined) continue;

    const body = trimmedRows.slice(i + 1);
    const stats = evaluateTimeColumn(body, mapping.time, 80);
    const qualifies =
      stats.finiteCount >= 30 && stats.uniqueCount >= 30 && stats.range >= 60 && stats.positiveDtRatio > 0.7;
    if (!qualifies) continue;

    const score = stats.uniqueCount + stats.range + stats.positiveDtRatio * 100;
    if (!best || score > best.score) {
      best = { headers: candidateHeaders, rows: body, mapping, stats, headerRowIndex: i, score };
    }
  }

  if (best) {
    return {
      headers: best.headers,
      rows: best.rows,
      mapping: best.mapping,
      headerRowIndex: best.headerRowIndex,
      timeHeaderName: best.headers[best.mapping.time],
      btHeaderName: best.headers[best.mapping.bt],
      timeUniqueCount: best.stats.uniqueCount,
      timeRange: best.stats.range,
      positiveDtRatio: best.stats.positiveDtRatio,
    };
  }

  const headers = trimmedRows[0];
  const body = trimmedRows.slice(1);
  const mapping = buildMapping(headers);
  const fallbackStats = evaluateTimeColumn(body, mapping.time, 80);
  return {
    headers,
    rows: body,
    mapping,
    headerRowIndex: 0,
    timeHeaderName: headers[mapping.time],
    btHeaderName: headers[mapping.bt],
    timeUniqueCount: fallbackStats.uniqueCount,
    timeRange: fallbackStats.range,
    positiveDtRatio: fallbackStats.positiveDtRatio,
  };
}

function evaluateTimeColumn(rows, timeIndex, maxSamples) {
  if (timeIndex === undefined) {
    return { finiteCount: 0, uniqueCount: 0, range: 0, positiveDtRatio: 0 };
  }
  const sampleRows = rows.slice(0, maxSamples);
  const times = sampleRows.map((row) => parseTime(row[timeIndex]));
  const finiteTimes = times.filter(Number.isFinite);
  const finiteCount = finiteTimes.length;
  const uniqueTimes = new Set(finiteTimes);
  const uniqueCount = uniqueTimes.size;
  const range = finiteCount ? Math.max(...finiteTimes) - Math.min(...finiteTimes) : 0;

  let last = null;
  let positive = 0;
  let total = 0;
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    if (Number.isFinite(last)) {
      const dt = t - last;
      if (dt !== 0) {
        total++;
        if (dt > 0) positive++;
      }
    }
    last = t;
  }
  const positiveDtRatio = total ? positive / total : 0;

  return { finiteCount, uniqueCount, range, positiveDtRatio };
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

  const timeCandidates = ['time', 'timesec', 'sec', 'seconds', '時間', '時刻'];
  const timeBlacklist = ['totaltime', 'roastingtotaltime', 'roasttime'];
  const btBlacklist = ['loadbean', 'outbean'];

  const findTime = () => {
    const match = normalized.find(({ key }) => timeCandidates.includes(key) && !timeBlacklist.some((bad) => key.includes(bad)));
    return match?.index;
  };

  const find = (keywords, blacklist = []) => {
    const match = normalized.find(
      ({ key }) => keywords.some((word) => key.includes(word)) && !blacklist.some((bad) => key.includes(bad))
    );
    return match?.index;
  };

  return {
    time: findTime(),
    bt: find(['beantemp', 'bt', '豆溫', 'beantemperature'], btBlacklist),
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

function prepareSeries({ headers, rows, mapping: initialMapping, headerRowIndex, timeHeaderName, btHeaderName, timeUniqueCount, timeRange, positiveDtRatio }) {
  const mapping = initialMapping || buildMapping(headers);
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

  const positiveDt = [];
  let lastFinite = null;
  for (const t of timeSec) {
    if (!Number.isFinite(t)) continue;
    if (Number.isFinite(lastFinite)) {
      const dt = t - lastFinite;
      if (dt > 0) positiveDt.push(dt);
    }
    lastFinite = t;
  }
  const medianDt = positiveDt.length ? percentile(positiveDt, 0.5) : NaN;
  const maxTime = finiteTimes.length ? Math.max(...finiteTimes) : NaN;
  const looksMinute = Number.isFinite(medianDt) && Number.isFinite(maxTime) && medianDt < 0.2 && maxTime < 60;
  const timeUnit = looksMinute ? 'min->sec' : 'sec';
  const adjustedTimeSec = looksMinute ? timeSec.map((t) => (Number.isFinite(t) ? t * 60 : t)) : timeSec;
  const adjustedFiniteTimes = adjustedTimeSec.filter(Number.isFinite);

  const btRaw = records.map((r) => r.bt);
  const etRaw = records.map((r) => r.et);
  const powerRaw = records.map((r) => r.power);
  const fanRaw = records.map((r) => r.fan);

  const bt = forwardFill(btRaw, 0);
  const et = forwardFill(etRaw, 0);
  const powerLevels = normalizeControlLevels(forwardFill(powerRaw, 0), 10);
  const fanLevels = normalizeControlLevels(forwardFill(fanRaw, 0), 15);

  const chargeIndex = records.findIndex((r) => /charge/i.test(r.event));
  const chargeTime = Number.isFinite(adjustedTimeSec[chargeIndex]) ? adjustedTimeSec[chargeIndex] : NaN;
  let baseTime = Number.isFinite(chargeTime) ? chargeTime : adjustedFiniteTimes[0];
  if (!Number.isFinite(baseTime)) {
    throw new Error('無法決定時間基準點。');
  }

  const times = adjustedTimeSec.map((t) => {
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
  const positiveRoR = ror.filter((v) => Number.isFinite(v) && v > 0 && v < 200);
  let maxPositiveRoR = positiveRoR.length ? Math.max(...positiveRoR) : NaN;
  if (!Number.isFinite(maxPositiveRoR) || maxPositiveRoR <= 0) {
    maxPositiveRoR = 25;
  }
  maxPositiveRoR = clamp(maxPositiveRoR, 1, 80);
  const rightMax = clamp(Math.floor(maxPositiveRoR) + 5, 10, 60);
  const tempMax = rightMax * 10;

  const events = extractEvents(sorted);
  const tpEvent = detectTP(sorted);
  const hasTp = events.some((e) => e.label === 'TP');
  if (tpEvent && !hasTp) {
    events.push(tpEvent);
    events.sort((a, b) => a.t - b.t);
  }
  const phases = buildPhases(sorted, events);

  return {
    headers,
    samples: sorted,
    ror,
    rightMax,
    tempMax,
    events,
    phases,
    maxPositiveRoR,
    timeUnit,
    medianDt,
    maxTime,
    totalRecords: records.length,
    totalTime: sorted[sorted.length - 1].t,
    baseTime,
    firstTime: sorted[0].t,
    lastTime: sorted[sorted.length - 1].t,
    sampleCount: sorted.length,
    headerRowIndex,
    timeHeaderName: timeHeaderName ?? headers[mapping.time],
    btHeaderName: btHeaderName ?? headers[mapping.bt],
    timeUniqueCount,
    timeRange,
    positiveDtRatio,
  };
}

function computeRoR(samples) {
  const ror = new Array(samples.length).fill(null);
  let firstPositiveSeen = false;
  let start = 0;
  let sumT = 0;
  let sumBt = 0;
  let sumTT = 0;
  let sumTBt = 0;

  for (let i = 0; i < samples.length; i++) {
    const { t, bt } = samples[i];
    sumT += t;
    sumBt += bt;
    sumTT += t * t;
    sumTBt += t * bt;

    while (start <= i && samples[start].t < t - 30) {
      const oldT = samples[start].t;
      const oldBt = samples[start].bt;
      sumT -= oldT;
      sumBt -= oldBt;
      sumTT -= oldT * oldT;
      sumTBt -= oldT * oldBt;
      start++;
    }

    const n = i - start + 1;
    if (n < 2) continue;

    const meanT = sumT / n;
    const meanBt = sumBt / n;
    const numerator = sumTBt - n * meanT * meanBt;
    const denominator = sumTT - n * meanT * meanT;
    if (denominator === 0) continue;

    const slopePerSec = numerator / denominator;
    const slopePerMin = slopePerSec * 60;
    if (slopePerMin > 0) firstPositiveSeen = true;
    ror[i] = firstPositiveSeen ? slopePerMin : null;
  }

  return ror;
}

function detectTP(samples) {
  if (!samples.length) return null;
  const startIdx = samples.findIndex((s) => Number.isFinite(s.t) && s.t >= 20);
  let bestIdx = -1;
  let bestBt = Infinity;
  const searchFrom = startIdx === -1 ? 0 : startIdx;

  for (let i = searchFrom; i < samples.length; i++) {
    const { bt } = samples[i];
    if (!Number.isFinite(bt)) continue;
    if (bt < bestBt) {
      bestBt = bt;
      bestIdx = i;
    }
  }

  if (bestIdx === -1 && searchFrom > 0) {
    for (let i = 0; i < searchFrom; i++) {
      const { bt } = samples[i];
      if (!Number.isFinite(bt)) continue;
      if (bt < bestBt) {
        bestBt = bt;
        bestIdx = i;
      }
    }
  }

  if (bestIdx === -1) return null;
  return { idx: bestIdx, t: samples[bestIdx].t, bt: samples[bestIdx].bt, label: 'TP' };
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
  const formatVal = (val, digits = 2) => (Number.isFinite(val) ? val.toFixed(digits) : 'NaN');
  const warnings = [];
  if (prepared.totalTime < 30 || prepared.sampleCount < 30) {
    warnings.push('資料時間軸可能解析異常');
  }
  const warningText = warnings.length ? `｜警告：${warnings.join('；')}` : '';
  metaEl.textContent =
    `資料點：${prepared.totalRecords}｜有效資料點：${prepared.samples.length}｜timeUnit=${prepared.timeUnit}｜medianDt=${formatVal(prepared.medianDt)}｜maxTime=${formatVal(prepared.maxTime)}｜rightMax=${prepared.rightMax}｜tempMax=${prepared.tempMax}｜maxPositiveRoR=${formatVal(prepared.maxPositiveRoR)}｜baseTime=${formatVal(prepared.baseTime)}｜totalTime=${formatVal(prepared.totalTime)}｜firstTime=${formatVal(prepared.firstTime)}｜lastTime=${formatVal(prepared.lastTime)}｜sampleCount=${prepared.sampleCount}｜headerRowIndex=${prepared.headerRowIndex}｜timeHeaderName=${prepared.timeHeaderName ?? 'N/A'}｜btHeaderName=${prepared.btHeaderName ?? 'N/A'}｜timeUniqueCount=${formatVal(prepared.timeUniqueCount, 0)}｜timeRange=${formatVal(prepared.timeRange)}｜positiveDtRatio=${formatVal(prepared.positiveDtRatio)}${warningText}｜欄位：${headers.join(', ')}`;
}

function niceTimeStep(totalTime) {
  const candidates = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720, 900];
  const target = totalTime / 8;
  const match = candidates.find((c) => c >= target);
  return match || candidates[candidates.length - 1];
}

function strokeFillText(ctx, text, x, y, fillColor) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
  ctx.restore();
}

async function renderPng({ samples, ror, rightMax, tempMax, events, phases, totalTime }, chartTitle) {
  const cssWidth = 1600;
  const cssHeight = 900;
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = cssWidth * dpr;
  chartCanvas.height = cssHeight * dpr;
  chartCanvas.style.width = `${cssWidth}px`;
  chartCanvas.style.height = `${cssHeight}px`;
  const ctx = chartCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if ('textRendering' in ctx) {
    ctx.textRendering = 'geometricPrecision';
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const margin = { top: 60, right: 90, bottom: 150, left: 90 };
  const plotWidth = cssWidth - margin.left - margin.right;
  const plotHeight = cssHeight - margin.top - margin.bottom;

  const totalDuration = Math.max(totalTime, 1);

  const mapX = (t) => margin.left + (Math.max(0, t) / totalDuration) * plotWidth;
  const mapTempY = (temp) => margin.top + plotHeight - (clamp(temp, 0, tempMax) / tempMax) * plotHeight;
  const mapRorY = (rorVal) => mapTempY(rorVal * 10);

  drawGrid(ctx, margin, cssWidth, cssHeight, tempMax, totalDuration, mapTempY, mapX);
  drawAxes(ctx, margin, cssWidth, cssHeight, tempMax, rightMax, totalDuration, mapTempY, mapRorY, mapX);

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

  drawEvents(ctx, events, mapX, mapTempY, margin, cssWidth, cssHeight, times, btData, etData, ror, mapRorY, totalDuration, plotWidth);
  drawFooterText(ctx, cssWidth, cssHeight, margin, phases);

  ctx.save();
  ctx.font = '18px "Inter", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  strokeFillText(ctx, chartTitle || 'roast-curve', cssWidth / 2, 28, '#0f172a');
  ctx.restore();

  const blob = await new Promise((resolve) => chartCanvas.toBlob(resolve, 'image/png'));
  if (blob) {
    return { blob, url: URL.createObjectURL(blob) };
  }
  const dataUrl = chartCanvas.toDataURL('image/png');
  return { blob: dataUrlToBlob(dataUrl), url: dataUrl };
}

function drawGrid(ctx, margin, width, height, tempMax, totalDuration, mapTempY, mapX) {
  ctx.save();
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.18)';
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
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.12)';
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
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, height - margin.bottom);
  ctx.lineTo(width - margin.right, height - margin.bottom);
  ctx.stroke();

  ctx.fillStyle = '#0f172a';
  ctx.font = '15px "Inter", system-ui, sans-serif';
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
  ctx.fillStyle = '#0f172a';
  ctx.font = '16px "Inter", system-ui, sans-serif';
  strokeFillText(ctx, '時間 (mm:ss)', (width - margin.left - margin.right) / 2 + margin.left, height - margin.bottom + 40, '#0f172a');
  ctx.save();
  ctx.translate(30, margin.top + plotCenter(margin, height));
  ctx.rotate(-Math.PI / 2);
  strokeFillText(ctx, '溫度 (°C)', 0, 0, '#0f172a');
  ctx.restore();

  ctx.save();
  ctx.translate(width - 30, margin.top + plotCenter(margin, height));
  ctx.rotate(Math.PI / 2);
  strokeFillText(ctx, '升溫率 (°C/分)', 0, 0, '#0f172a');
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

function getInterpolatedY(t, seriesTimes, seriesValues, mapYFn) {
  if (!seriesTimes?.length || !mapYFn) return NaN;
  let prevIdx = -1;
  for (let i = 0; i < seriesTimes.length; i++) {
    const ti = seriesTimes[i];
    if (!Number.isFinite(ti)) continue;
    const vi = seriesValues[i];
    if (ti > t) {
      if (prevIdx !== -1 && Number.isFinite(seriesValues[prevIdx]) && ti !== seriesTimes[prevIdx]) {
        const t0 = seriesTimes[prevIdx];
        const v0 = seriesValues[prevIdx];
        const ratio = (t - t0) / (ti - t0);
        return mapYFn(v0 + ratio * (vi - v0));
      }
      return Number.isFinite(vi) ? mapYFn(vi) : NaN;
    }
    if (Number.isFinite(vi)) prevIdx = i;
  }
  if (prevIdx !== -1 && Number.isFinite(seriesValues[prevIdx])) {
    return mapYFn(seriesValues[prevIdx]);
  }
  return NaN;
}

function drawEvents(ctx, events, mapX, mapY, margin, width, height, times, btData, etData, rorData, mapRorY, totalDuration, plotWidth) {
  if (!events.length) return;
  ctx.save();
  ctx.fillStyle = '#f97316';
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 1.5;
  ctx.font = '13px "Inter", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const fontSize = 13;
  const safeGap = 14;
  const hasEt = etData?.some(Number.isFinite);
  const hasRor = rorData?.some((v) => Number.isFinite(v));
  const thresholdPx = 6;
  const padding = 4;
  const samplePoints = (bbox) => {
    const pts = [];
    const { x, y, width: w, height: h } = bbox;
    const x2 = x + w;
    const y2 = y + h;
    pts.push({ x: x + w / 2, y: y + h / 2 });
    pts.push({ x, y });
    pts.push({ x: x2, y });
    pts.push({ x, y: y2 });
    pts.push({ x: x2, y: y2 });
    pts.push({ x: x + w / 2, y });
    pts.push({ x: x + w / 2, y: y2 });
    pts.push({ x, y: y + h / 2 });
    pts.push({ x: x2, y: y + h / 2 });
    return pts;
  };

  const yBT = (t) => getInterpolatedY(t, times, btData, mapY);
  const yET = (t) => (hasEt ? getInterpolatedY(t, times, etData, mapY) : NaN);
  const yROR = (t) => (hasRor ? getInterpolatedY(t, times, rorData, mapRorY) : NaN);

  const measure = (text) => {
    const metrics = ctx.measureText(text);
    const h = (metrics.actualBoundingBoxAscent || fontSize) + (metrics.actualBoundingBoxDescent || 0);
    return { width: metrics.width, height: h };
  };

  const buildBBox = (textX, yBase, widthVal, heightVal, above) => ({
    x: textX - widthVal / 2 - padding,
    y: above ? yBase - heightVal - padding : yBase - padding,
    width: widthVal + padding * 2,
    height: heightVal + padding * 2,
  });

  const collisionScore = (bbox) => {
    let score = 0;
    const pts = samplePoints(bbox);
    for (const pt of pts) {
      if (pt.x < margin.left || pt.x > width - margin.right) continue;
      if (pt.y < margin.top || pt.y > height - margin.bottom) continue;
      const t = ((pt.x - margin.left) / plotWidth) * totalDuration;
      const btY = yBT(t);
      const etY = yET(t);
      const rorY = yROR(t);
      if (Number.isFinite(btY) && Math.abs(pt.y - btY) < thresholdPx) score += 1;
      if (Number.isFinite(etY) && Math.abs(pt.y - etY) < thresholdPx) score += 1;
      if (Number.isFinite(rorY) && Math.abs(pt.y - rorY) < thresholdPx) score += 1.2;
    }
    return score;
  };
  events.forEach((e) => {
    const x = mapX(e.t);
    const y = mapY(e.bt);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    const topLabel = `${formatTimeLabel(e.t)} ${e.label}`;
    const tempLabel = Number.isFinite(e.bt) ? `${Math.round(e.bt)}°C` : '--°C';
    const topMetrics = measure(topLabel);
    const tempMetrics = measure(tempLabel);
    const half = Math.max(topMetrics.width, tempMetrics.width) / 2;

    const candidates = [
      { dx: 0, topOffset: -10, bottomOffset: safeGap + fontSize },
      { dx: 0, topOffset: safeGap + fontSize, bottomOffset: -10 },
      { dx: -24, topOffset: -10, bottomOffset: safeGap + fontSize },
      { dx: 24, topOffset: -10, bottomOffset: safeGap + fontSize },
      { dx: -24, topOffset: safeGap + fontSize, bottomOffset: -10 },
      { dx: 24, topOffset: safeGap + fontSize, bottomOffset: -10 },
    ];

    let best = null;
    candidates.forEach((c) => {
      let textX = x + c.dx;
      if (textX - half < margin.left) textX = margin.left + half;
      if (textX + half > width - margin.right) textX = width - margin.right - half;

      let topY = y + c.topOffset;
      let bottomY = y + c.bottomOffset;
      if (topY < margin.top + 5) topY = y + safeGap + fontSize;
      if (bottomY > height - margin.bottom - 5) bottomY = y - safeGap - fontSize;
      const topAbove = topY < y;
      const tempBelow = bottomY > y;
      const topBox = buildBBox(textX, topY, topMetrics.width, topMetrics.height, topAbove);
      const tempBox = buildBBox(textX, bottomY, tempMetrics.width, tempMetrics.height, !tempBelow);
      const score = collisionScore(topBox) + collisionScore(tempBox);
      const dist = Math.abs(textX - x) + Math.abs(topY - y) + Math.abs(bottomY - y);
      if (!best || score < best.score || (score === best.score && dist < best.dist)) {
        best = { textX, topY, bottomY, topAbove, tempBelow, topBox, tempBox, score, dist };
      }
    });

    if (!best) return;
    const { textX, topY, bottomY, topAbove, tempBelow, tempBox } = best;

    ctx.textBaseline = topAbove ? 'bottom' : 'top';
    strokeFillText(ctx, topLabel, textX, topY, '#0f172a');

    ctx.textBaseline = tempBelow ? 'top' : 'bottom';
    if (tempBelow) {
      const rectX = tempBox.x;
      const rectY = tempBox.y;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      const radius = 4;
      ctx.moveTo(rectX + radius, rectY);
      ctx.lineTo(rectX + tempBox.width - radius, rectY);
      ctx.quadraticCurveTo(rectX + tempBox.width, rectY, rectX + tempBox.width, rectY + radius);
      ctx.lineTo(rectX + tempBox.width, rectY + tempBox.height - radius);
      ctx.quadraticCurveTo(rectX + tempBox.width, rectY + tempBox.height, rectX + tempBox.width - radius, rectY + tempBox.height);
      ctx.lineTo(rectX + radius, rectY + tempBox.height);
      ctx.quadraticCurveTo(rectX, rectY + tempBox.height, rectX, rectY + tempBox.height - radius);
      ctx.lineTo(rectX, rectY + radius);
      ctx.quadraticCurveTo(rectX, rectY, rectX + radius, rectY);
      ctx.fill();
      ctx.restore();
    }
    strokeFillText(ctx, tempLabel, textX, bottomY, '#0f172a');
  });
  ctx.restore();
}

function drawFooterText(ctx, width, height, margin, phases) {
  ctx.save();
  ctx.fillStyle = '#0f172a';
  ctx.font = '16px "Inter", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const center = (width - margin.left - margin.right) / 2 + margin.left;
  strokeFillText(ctx, phases.display, center, height - margin.bottom + 64, '#0f172a');
  ctx.fillStyle = '#334155';
  ctx.font = '15px "Inter", system-ui, sans-serif';
  strokeFillText(ctx, phases.dropText, center, height - margin.bottom + 96, '#334155');
  ctx.restore();
}
