const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const chartCanvas = document.getElementById('curve');
const phaseTextEl = document.getElementById('phase-text');
const dropTextEl = document.getElementById('drop-text');
const downloadBtn = document.getElementById('download');

let chart;

fileInput.addEventListener('change', async (event) => {
  const [file] = event.target.files || [];
  if (!file) return;

  updateStatus(`處理檔案：${file.name}…`);
  metaEl.textContent = '';
  phaseTextEl.textContent = '';
  dropTextEl.textContent = '';
  downloadBtn.disabled = true;

  try {
    const csvText = await readTextFromFile(file);
    const parsed = parseCsv(csvText);
    const prepared = prepareSeries(parsed);
    renderChart(prepared);
    renderMeta(prepared, parsed.headers);
    downloadBtn.disabled = false;
    updateStatus('圖表更新完成。');
  } catch (error) {
    console.error(error);
    updateStatus(error.message || '無法讀取烘焙資料。');
  }
});

downloadBtn.addEventListener('click', () => {
  if (!chart) return;
  const url = chart.toBase64Image('image/png', 1);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'roast-curve.png';
  link.click();
});

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
  const btRaw = records.map((r) => r.bt);
  const etRaw = records.map((r) => r.et);
  const powerRaw = records.map((r) => r.power);
  const fanRaw = records.map((r) => r.fan);

  const bt = forwardFill(btRaw, 0);
  const et = forwardFill(etRaw, 0);
  const power = forwardFill(powerRaw, 0);
  const fan = forwardFill(fanRaw, 0);

  const chargeIndex = records.findIndex((r) => /charge/i.test(r.event));
  const baseTime = Number.isFinite(timeSec[chargeIndex]) ? timeSec[chargeIndex] : Math.min(...timeSec.filter(Number.isFinite));
  const times = timeSec.map((t) => (Number.isFinite(t) ? Math.max(0, t - baseTime) : 0));

  const samples = times.map((t, idx) => ({
    t,
    bt: bt[idx],
    et: et[idx],
    power: power[idx],
    fan: fan[idx],
    event: records[idx].event,
  }));

  const sorted = samples.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const ror = computeRoR(sorted);

  const maxPositiveRoR = Math.max(...ror.filter((v) => Number.isFinite(v) && v > 0), 1);
  const rightMax = Math.floor(maxPositiveRoR) + 5;
  const tempMax = rightMax * 10;

  const xLabels = sorted.map((s) => formatTimeLabel(s.t));

  const events = extractEvents(sorted);
  const phases = buildPhases(sorted, events);

  phaseTextEl.textContent = phases.display;
  dropTextEl.textContent = phases.dropText;

  return { samples: sorted, ror, xLabels, rightMax, tempMax, events };
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
  metaEl.textContent = `資料點：${prepared.samples.length}｜欄位：${headers.join(', ')}`;
}

function renderChart({ samples, ror, xLabels, rightMax, tempMax, events }) {
  if (!samples.length) {
    throw new Error('CSV 中沒有可用的資料點。');
  }
  if (chart) chart.destroy();

  const btData = samples.map((s) => s.bt);
  const etData = samples.map((s) => s.et);
  const powerData = samples.map((s) => s.power * 5);
  const fanData = samples.map((s) => s.fan * 5);

  const datasets = [
    {
      label: '豆溫 (BT)',
      data: btData,
      borderColor: '#f97316',
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 0,
      yAxisID: 'temp',
    },
    {
      label: '排氣 (ET)',
      data: etData,
      borderColor: '#94a3b8',
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 0,
      yAxisID: 'temp',
    },
    {
      label: '升溫率（RoR）',
      data: ror,
      borderColor: '#3b82f6',
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 0,
      yAxisID: 'ror',
    },
    {
      label: '火力',
      data: powerData,
      borderColor: '#ef4444',
      borderWidth: 2,
      borderDash: [6, 4],
      stepped: true,
      pointRadius: 0,
      yAxisID: 'temp',
    },
    {
      label: '風門',
      data: fanData,
      borderColor: '#10b981',
      borderWidth: 2,
      borderDash: [4, 4],
      stepped: true,
      pointRadius: 0,
      yAxisID: 'temp',
    },
  ];

  const eventDataset = {
    label: '事件',
    data: events.map((e) => ({ x: xLabels[e.idx], y: samples[e.idx].bt, label: e.label })),
    backgroundColor: '#f97316',
    borderColor: '#f97316',
    pointRadius: 4,
    showLine: false,
    yAxisID: 'temp',
  };
  if (eventDataset.data.length) {
    datasets.push(eventDataset);
  }

  chart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels: xLabels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      aspectRatio: 16 / 9,
      animation: false,
      plugins: {
        legend: {
          labels: { color: '#e2e8f0' },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}：${ctx.formattedValue}`,
          },
        },
        annotation: false,
      },
      interaction: {
        mode: 'nearest',
        intersect: false,
      },
      layout: {
        padding: {
          top: 12,
          bottom: 32,
        },
      },
      scales: {
        x: {
          title: { display: true, text: '時間 (mm:ss)', color: '#e2e8f0' },
          grid: {
            color: (ctx) => (ctx.tick.value % 60 === 0 ? 'rgba(148, 163, 184, 0.35)' : 'rgba(148, 163, 184, 0.12)'),
          },
          ticks: {
            color: '#cbd5e1',
            maxRotation: 0,
            callback: (val, idx) => xLabels[idx],
          },
        },
        temp: {
          position: 'left',
          min: 0,
          max: tempMax,
          grid: {
            drawTicks: false,
            color: (ctx) => (ctx.tick.value % 10 === 0 ? 'rgba(148, 163, 184, 0.25)' : 'transparent'),
            borderDash: [4, 4],
          },
          ticks: {
            color: '#cbd5e1',
            callback: (val) => (val % 50 === 0 ? `${val}` : ''),
            stepSize: 10,
          },
          title: { display: true, text: '溫度 (°C)', color: '#e2e8f0' },
        },
        ror: {
          position: 'right',
          min: 0,
          max: rightMax,
          grid: { drawOnChartArea: false },
          ticks: {
            color: '#cbd5e1',
            stepSize: 5,
          },
          title: { display: true, text: '升溫率 (°C/分)', color: '#e2e8f0' },
        },
      },
    },
    plugins: [eventLabelPlugin()],
  });
}

function eventLabelPlugin() {
  return {
    id: 'event-labels',
    afterDatasetsDraw(chartInstance) {
      const { ctx } = chartInstance;
      const datasetIndex = chartInstance.data.datasets.findIndex((d) => d.label === '事件');
      if (datasetIndex === -1) return;
      const meta = chartInstance.getDatasetMeta(datasetIndex);
      ctx.save();
      ctx.fillStyle = '#f8fafc';
      ctx.font = '12px "Inter", sans-serif';
      meta.data.forEach((point, idx) => {
        const label = chartInstance.data.datasets[datasetIndex].data[idx].label;
        ctx.textAlign = 'left';
        ctx.fillText(label, point.x + 6, point.y - 6);
      });
      ctx.restore();
    },
  };
}
