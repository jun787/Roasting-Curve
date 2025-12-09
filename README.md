# Roasting-Curve

一個輕量的網頁檢視器，可在瀏覽器中解壓 zip 檔內的烘焙紀錄 CSV、解析資料並以 Chart.js 繪製烘焙曲線。

## 使用方式

1. 直接在瀏覽器開啟 `index.html`（不需額外建置）。
2. 點擊 **選擇 zip 檔**，挑選含有一個 CSV 的壓縮檔。
3. CSV 會以標題列進行解析，預期包含以下欄位：
   - 時間（秒），如：`time`、`Time (s)`、`sec`。
   - 豆溫，如：`bean`、`BT`。
   - 環境溫度（選填），如：`environment`、`env`、`ET`。
4. 解析完成後會自動更新圖表，若有環境溫度則一併顯示。

## 注意事項

- 會自動尋找壓縮檔中的第一個 `.csv` 檔並使用它。
- 解析與繪圖均在本機瀏覽器中完成，使用 [JSZip](https://stuk.github.io/jszip/)、[PapaParse](https://www.papaparse.com/)、[Chart.js](https://www.chartjs.org/)。
- 若缺少必要欄位或沒有數值資料，狀態區域會顯示錯誤訊息。
