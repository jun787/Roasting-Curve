# 曲線圖繪製器

上傳 CSV 或 ZIP（內含 CSV），瀏覽器會自動解析並繪製一張烘焙曲線圖，可直接下載 PNG。所有文字介面為中文。

## 安裝與啟動

1. 安裝依賴（僅需靜態伺服器即可）：
   ```bash
   npm install -g serve
   ```
2. 於專案根目錄啟動靜態伺服器：
   ```bash
   serve .
   ```
3. 瀏覽器開啟 `http://localhost:3000`。

## 使用步驟（驗證流程）

1. 在頁面點選「選擇檔案」，上傳 `.csv` 或 `.zip`（ZIP 會自動挑第一個 CSV，忽略 `.rop`）。
2. 上傳後頁面會自動解壓/解析並繪製曲線：
   - 同時繪出 BT（橙）、ET（灰）、RoR（藍，右軸）、火力（紅虛線階梯）、風門（綠虛線階梯）。
   - 時間軸以入豆（charge）為 0，顯示 mm:ss；下方附上 A/B/C 比例與 drop 時間/BT。
   - 若 Event 欄包含 `YELLOW`、`1st CRACK` 會在 BT 線上標點與短標籤。
   - RoR 以 30 秒線性回歸，轉為正值前不顯示；右軸與左軸對齊：RoR=10 對應 100°C。
   - 左軸 0°C 起跳，每 10°C 虛線網格、僅顯示 50°C 倍數刻度；右軸每 5 為刻度。
3. 按「下載 PNG」可存下目前圖表。

## CSV 格式支援與假設

- 支援欄位：Time、Bean temp/BT、Exhaust Temp/ET、Power（0-10 檔）、Fan（0-15 檔）、Event/Roast Mode。
- CSV 可能第 1 列是真實欄位名、資料自第 3 列開始；若同檔同時存在標準欄名與第 1 列自訂標籤，會以第 1 列為準。
- 時間欄接受秒數或 `mm:ss`/`hh:mm:ss`；若沒有 charge 事件，時間會以第一筆資料為 0 作基準。
- BT/ET/Power/Fan 允許混雜文字或單位，僅抽取數字；空白視為缺值並以前值遞補（第一筆預設 0）。
- RoR 以 BT 對時間的 30 秒移動線性回歸斜率計算，單位 °C/min。
- 若缺少 YELLOW / 1st CRACK 事件，A/B/C 比例將以總時長的 1/3、1/3、1/3 推估；drop 以最後一筆時間與 BT 顯示。
- 若資料中沒有任何正 RoR，圖軸會以 10 為基準推估右軸上限（10+5）。

## 驗收對應

- 控制帶：火力與風門以虛線階梯線繪於圖底部，不超過整體高度 25%，數值映射 y = 檔位 × 5°C。
- 網格與刻度：左軸固定下限 0°C、每 10°C 虛線；右軸 RoR 5 對應 50°C 對齊（RoR=值×10）。
- 介面：中文提示、狀態訊息、按鈕，無額外浮框；提供 PNG 下載。
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
