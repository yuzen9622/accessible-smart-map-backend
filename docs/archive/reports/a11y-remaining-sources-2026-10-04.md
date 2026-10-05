# 無障礙路網剩餘資料來源實測

查證日期：2026-10-04。範圍：輪行臺北公開 API、2026 年版臺北市 20 m DEM。本文記錄下載與資料結構驗證，不代表已完成路網匯入、現地確認或正式部署。

## 結論

輪行臺北**有正式公開、可下載的設施 API**；可以補充人行道及行穿線面幾何、入口和電梯點位。實際 API 沒有室內通道、樓層拓樸、獨立設施 ID、設備即時狀態或資料更新時間。寬度單位存在文件與資料數值的疑點，不能直接投入輪椅限制判斷。

2026 DEM 的臺北 ZIP 可正常下載，且可讀出測量與產製年代；但檔頭並未消除 DTM／DSM 標示矛盾。可用於隔離候選資料檢查，尚不能宣稱是最新地面實測坡度。

## 輪行臺北：公開介面及授權

官方[資料集](https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7)列為交通局提供、免費、公開、不定時更新，並連結[介接說明 PDF](https://www-ws.gov.taipei/Download.ashx?u=LzAwMS9VcGxvYWQvMzkwL3JlbGZpbGUvMC8xMjQ2ODkvNjcwOWE0ZjEtMjIwYS00ZWU1LWIwMTUtOWZjNjQ0NjU3MjJmLnBkZg==&n=6Lyq6KGM6Ie65YyX6Kit5pa9QVBJ6Kqq5piOLnBkZg==&icon=.pdf)。採用平台[政府資料開放授權條款第 1 版](https://data.taipei/rule)，衍生利用應保留提供機關及來源顯名。此次只取該公開介面，未採集民眾障礙陳情資料或使用網站內部回報介面。

GET `https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/{facilitytype}`。以下 6 類均以 curl、正常 TLS 驗證取得 HTTP 200 JSON；Python 3.14 urllib 在本機遇到憑證 `Missing Subject Key Identifier`，未關閉驗證繞過。

| 類別 | 筆數 | 幾何形式 | 寬度／坡度實際情況 |
| --- | ---: | --- | --- |
| [1 坡道](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/1) | 28,290 | 點 | 28,247 筆 width/slope 同為 0，其餘 43 筆同為 -1；不能視為量測零坡度 |
| [3 電梯](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/3) | 226 | 點 | width/slope 全 -1；官方類別稱路外停車場電梯，實際名稱也包含捷運出口電梯 |
| [7 出入口](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/7) | 940 | 點 | 745 筆 width 非負，範圍 0.9–19.6；611 筆 slope > 0 |
| [11 人行道](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/11) | 15,291 | 面座標序列 | width 0.32–34.12；slope 全 -1 |
| [12 標線人行道](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/12) | 3,529 | 面座標序列 | width/slope 全 -1 |
| [13 行穿線](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/13) | 1,451 | 面座標序列 | width/slope 全 -1 |

以上為當次完整回應統計，後續下載可能變動。

### 資料契約與限制

- 點物件鍵：`kind, kname, lon, lat, X, Y, width, slope`。面物件鍵：`kind, kname, location, width, slope`。`location` 是 `lon|lat|lon|lat|...|`，不是 GeoJSON，也不是路由中心線。
- `kname` 多含顯示用編號，但部分捷運入口、電梯只有名稱；沒有獨立 ID 欄位。此次各類名稱沒有重複，不代表跨版本穩定。建議留原名稱及幾何雜湊作匯入追蹤，不自稱設備唯一識別碼。
- `X/Y` 不是一致的投影坐標欄位：入口有些是數字字串，有些是公園／入口名稱；幾何應解析 `lon/lat`。
- PDF 明列 slope 為百分比；轉成比值須除以 100。資料未提供方向，不可賦予有向路段正負坡度。`-1` 保留未知。類別 1 的整批零值缺少可驗證的量測語意，不能當作通行保證。
- PDF 將 width 標為公分，實際大量值約 1–3；網站[首頁原始 JavaScript](https://wheelroute.gov.taipei/)有已註解的「最小淨寬(m)」呈現碼。這是單位可能不一致的線索，**不是正式修訂單位的證據**。本次不自行推斷為公尺，不將數值乘除 100 後投入限制。
- API 無 `updatedAt`、`active`、通行等級、電梯故障起訖、樓層、TDX EquipmentID。官方不定時更新不能推導每筆設施現況。入口附近有電梯也不能證明入口通往同一月台。

### 幾何驗證

以 Shapely 實讀全量面資料。此處「有效」僅指 OGC 幾何有效性，不代表實地可走。

| 類別 | 全數可解析 | 原始座標已閉環 | 有效 Polygon | 正面積 |
| --- | ---: | ---: | ---: | ---: |
| 11 | 15,291 | 15,265 | 15,263 | 15,291 |
| 12 | 3,529 | 3,529 | 3,529 | 3,529 |
| 13 | 1,451 | 1,448 | 1,448 | 1,451 |

所有面落在粗略研究範圍 lon 121.25–121.8、lat 24.8–25.35。這是資料異常篩選框，非臺北市行政界。相同篩選下：類別 1 有 126 筆範圍外、類別 7 有 2 筆範圍外、類別 3 全在範圍內。坡道包含 `lat=0` 的明顯异常，不能全收。Invalid Polygon 應隔離或記錄修補前後證據；不可只因能建立 Polygon 就視為有效。

建議實作次序：先保存原始資料及來源 → 檢查幾何／去重 → 與既有同側人行道、入口做候選對照 → 把已確認資訊加入圖；不要以最近點距離直接連穿牆、跨街或跨樓層的邊。

## 2026 DEM：下載後仍有的標示矛盾

[資料集 178729](https://data.gov.tw/dataset/178729)頁面與 JSON-LD 標題、說明寫 DTM，資源列名稱寫 DSM。本次 web reader 無法讀該頁，但本機 curl HTTP 200 取得完整 HTML，並沿 JSON-LD `contentUrl` 取得[官方 CSV](https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/B6219841-E247-4743-958D-77FB61067092/resource/D788C60B-33CB-4A84-A438-EC6E8B7060F1/download)。CSV 使用「數值高程模型資料」、DEM 檔名及 TWD97 座標描述，沒有明確 DTM／DSM 區分。

進一步實讀 CSV 連出的[欄位定義 ZIP](https://www.tgos.tw/MDE/VirtualDir_TC/Product/342505d1-81bc-490a-8e10-9f7e1ec0ed98/schema_hdr.zip)及[臺北市 ZIP](https://www.tgos.tw/MDE/VirtualDir_TC/Product/6dc9f9a5-484d-45b4-9373-80b2d080c051/分幅_臺北市20MDEM(2026).zip)，皆 HTTP 200。後者 6,162,396 bytes，內含 64 組 `.grd/.hdr` 及檔名 manifest。

| 檔頭實測 | 結果 |
| --- | --- |
| 平面／高程基準 | 全 64 幅 TWD97[2020]／TWVD2001 |
| 東西／南北網格 | 全部 20 m／20 m |
| 生產方式 | 全部代碼 10，schema 解釋為光達且大部分人工編修 |
| 生產設備 | 全部 LiDAR-SCOPE |
| 原始資料日期 | 2021-06-18：6 幅；2021-08-30：26 幅；2022-11-22：32 幅 |
| 模型生成日期 | 2022-04-01：32 幅；2022-12-30：32 幅 |
| `.grd` | 文字列，實例 `298640 2785020 286.23`，對應 E/N/H；非直接 GeoTIFF |

**2026 代表該包版本，不能說資料在 2026 全新測量。** 檔头日期欄需保留，不以釋出版年覆寫。CSV 泛稱航空攝影測量，但臺北各幅實際檔頭標光達，應以可追溯檔頭記錄來源差異。

schema 把生成欄位通稱 `DTM（DSM）`，臺北 manifest 只有檔名，皆未說明是否排除建物或植被；僅靠 LiDAR 或 `dem` 副檔名無法判定地面／地表模型。**DTM／DSM 衝突仍待提供機關說明；本研究不把猜測當作解決。** 若要試算，可做明確標記的離線候選比較，不能把 20 m 地形估計當路緣或短坡道實測。

## 可重現原始材料

資料目錄：`/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/wheelroute/`。

- `facility-{1,3,7,11,12,13}.json`：HTTP 200 原始回應。
- `dtm2026-resource.csv`、`dtm-schema.zip`、`dtm-taipei-2026.zip`：依官方鏈結下載。
- `source-manifest.json`：URL、SHA-256、大小及取得日期；僅描述本次快照，不代表來源有效日期。

本研究只新增此報告並保存外部原始資料；未改 API 掛載路徑、路由程式或正式資料庫。未執行 build，因沒有程式修改；最終候選圖建置、來源匯入測試與 build 由主實作流程驗收。
