# Roasting-Curve

A lightweight web viewer for roasting log CSVs packaged inside a zip archive. Upload the zip, the app will extract the CSV in-browser, parse the data, and render a roasting curve with Chart.js.

## Usage

1. Open `index.html` in your browser (no build step required).
2. Click **Choose zip file** and select a zip that contains one CSV.
3. The CSV is parsed with headers. Expected columns include:
   - Time in seconds (e.g., `time`, `Time (s)`, `sec`).
   - Bean temperature (`bean`, `BT`).
   - Environment temperature (`environment`, `env`, `ET`) – optional.
4. The chart updates automatically after parsing and displays both bean and environment traces when available.

## Notes

- The CSV is detected automatically; the first `.csv` file inside the archive is used.
- Parsing is done locally using [JSZip](https://stuk.github.io/jszip/), [PapaParse](https://www.papaparse.com/), and [Chart.js](https://www.chartjs.org/).
- If required columns are missing or contain no numeric data, an error message appears in the status area.
