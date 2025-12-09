const fileInput = document.getElementById('zip-input');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const chartCanvas = document.getElementById('curve');
let chart;

fileInput.addEventListener('change', async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }
  updateStatus(`處理檔案：${file.name}…`);
  metaEl.textContent = '';

  try {
    const csvText = await readCsvFromZip(file);
    const parsed = parseCsv(csvText);
    renderChart(parsed);
    metaEl.textContent = `${parsed.rows.length} 筆資料 | 欄位：${parsed.fields.join(', ')}`;
    updateStatus('圖表更新完成。');
  } catch (error) {
    console.error(error);
    updateStatus(error.message || '無法讀取烘焙資料。');
  }
});

function updateStatus(message) {
  statusEl.textContent = message;
}

async function readCsvFromZip(file) {
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const csvEntries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.csv'));

  if (!csvEntries.length) {
    throw new Error('壓縮檔內沒有找到 CSV 檔。');
  }

  const entry = csvEntries[0];
  const text = await entry.async('text');
  return text;
}

function parseCsv(csvText) {
  const result = Papa.parse(csvText, { header: true, skipEmptyLines: true, dynamicTyping: true });
  if (result.errors?.length) {
    throw new Error(result.errors[0].message || 'CSV 解析失敗');
  }

  const rows = result.data.filter((row) => Object.values(row).some((value) => value !== null && value !== ''));
  const fields = result.meta.fields || [];
  const mapping = mapColumns(fields);

  if (!mapping.time || !mapping.bean) {
    throw new Error('CSV 必須包含時間與豆溫欄位。');
  }

  const samples = rows
    .map((row) => {
      const time = Number(row[mapping.time]);
      const bean = Number(row[mapping.bean]);
      const environment = mapping.environment ? Number(row[mapping.environment]) : null;
      if (Number.isFinite(time) && Number.isFinite(bean)) {
        return { time, bean, environment };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  return { samples, fields, rows };
}

function mapColumns(fields) {
  const normalized = fields.map((field) => ({
    original: field,
    key: field.toLowerCase().replace(/[^a-z0-9]/gi, ''),
  }));

  const findKey = (keywords) => {
    const match = normalized.find(({ key }) => keywords.some((word) => key.includes(word)));
    return match?.original;
  };

  return {
    time: findKey(['time', 'sec']),
    bean: findKey(['bean', 'bt']),
    environment: findKey(['environment', 'env', 'et']),
  };
}

function renderChart({ samples }) {
  if (!samples.length) {
    throw new Error('CSV 中沒有可用的資料點。');
  }

  const labels = samples.map((sample) => sample.time);
  const datasets = [
    {
      label: '豆溫',
      data: samples.map((sample) => sample.bean),
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.2)',
      borderWidth: 2,
      tension: 0.25,
    },
  ];

  const environmentPoints = samples
    .map((sample) => sample.environment)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));

  if (environmentPoints.length) {
    datasets.push({
      label: '環境溫度',
      data: samples.map((sample) => sample.environment),
      borderColor: '#38bdf8',
      backgroundColor: 'rgba(56, 189, 248, 0.18)',
      borderWidth: 2,
      tension: 0.25,
    });
  }

  const config = {
    type: 'line',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: {
          labels: {
            color: '#e2e8f0',
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}：${ctx.formattedValue}°`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: '時間（秒）' },
          ticks: { color: '#cbd5e1' },
          grid: { color: 'rgba(148, 163, 184, 0.2)' },
        },
        y: {
          title: { display: true, text: '溫度（°C）' },
          ticks: { color: '#cbd5e1' },
          grid: { color: 'rgba(148, 163, 184, 0.2)' },
        },
      },
    },
  };

  if (chart) {
    chart.destroy();
  }

  chart = new Chart(chartCanvas, config);
}
