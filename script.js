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
  updateStatus(`Processing ${file.name}…`);
  metaEl.textContent = '';

  try {
    const csvText = await readCsvFromZip(file);
    const parsed = parseCsv(csvText);
    renderChart(parsed);
    metaEl.textContent = `${parsed.rows.length} rows | ${parsed.fields.join(', ')}`;
    updateStatus('Chart updated successfully.');
  } catch (error) {
    console.error(error);
    updateStatus(error.message || 'Unable to read roast data.');
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
    throw new Error('No CSV file found inside the zip.');
  }

  const entry = csvEntries[0];
  const text = await entry.async('text');
  return text;
}

function parseCsv(csvText) {
  const result = Papa.parse(csvText, { header: true, skipEmptyLines: true, dynamicTyping: true });
  if (result.errors?.length) {
    throw new Error(result.errors[0].message || 'CSV parsing error');
  }

  const rows = result.data.filter((row) => Object.values(row).some((value) => value !== null && value !== ''));
  const fields = result.meta.fields || [];
  const mapping = mapColumns(fields);

  if (!mapping.time || !mapping.bean) {
    throw new Error('CSV must include time and bean temperature columns.');
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
    throw new Error('No valid data points found in the CSV.');
  }

  const labels = samples.map((sample) => sample.time);
  const datasets = [
    {
      label: 'Bean temperature',
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
      label: 'Environment temperature',
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
            label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue}°`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Time (s)' },
          ticks: { color: '#cbd5e1' },
          grid: { color: 'rgba(148, 163, 184, 0.2)' },
        },
        y: {
          title: { display: true, text: 'Temperature (°C)' },
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
