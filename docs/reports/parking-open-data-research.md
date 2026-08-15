# 全台停車場與停車格開放資料研究報告

> 日期：2026-08-13
> 目的：盤點全台可用的「停車場／停車格（含身心障礙專用格）」公開資料來源，規劃匯入本專案資料庫的方案。
> 方法：逐來源實測（HTTP 狀態碼 + 實際下載檔內容），排除搜尋引擎二手資訊。

## 1. 結論摘要

- **沒有「一份打全台」的現成資料集**。TDX（交通部運輸資料流通服務）的停車資源**已停止供數**；OSM 台灣身障停車格幾乎為零。全台資料**只能逐縣市開放資料平台拼湊**，且各縣市格式不一（CSV / SHP / API / Google Drive）。
- 已實測可立即使用的來源：**台北（CSV，WGS84 直用）、新北（CSV，含身障標記）、台中（SHP）**。
- 建議架構：**每縣市一個 adapter**（同 `disabled-parking-parse.ts` 模式）＋ 統一標準化與 upsert 層；身障停車格維持現有 `DisabledParking` collection，一般停車格／路外停車場另建 collection，避免污染 a11y 查詢。

## 2. 資料來源實測結果

### 2.0 ⭐ 全台最佳來源：TDX advanced 停車空間查詢 API（2026-08-13 驗證）

使用者提供第二份 swagger（`/webapi/File/Swagger/V3/10187099-9e74-43d8-9bad-c60118e6baba`）：同為「停車資訊」服務，但 server 為 **`https://tdx.transportdata.tw/api/advanced`**（非 basic），只有 2 個端點：

| 端點                                          | 內容                          | 回應型別               |
| --------------------------------------------- | ----------------------------- | ---------------------- |
| `GET /v1/Parking/OffStreet/CarPark/NearBy`    | 指定位置+範圍的全台路外停車場 | `CarPark[]`            |
| `GET /v1/Parking/OnStreet/ParkingSpot/NearBy` | 指定位置+範圍的全台路邊停車格 | `ParkingSegmentSpot[]` |

- 必填參數 `$spatialFilter`：`nearby({Lat},{Lon},{DistanceInMeters})`，**最大半徑 1000m**（spec 原文）
- 需要 TDX 會員 token（本專案既有 `TDX_CLIENT_ID/SECRET` 實測可存取，0 次 429）

**全台覆蓋實測**：CarPark 全 8/8 縣市有資料（北/新北/中/南/高/桃/基/花蓮/嘉義/新竹/屏東）；ParkingSpot（路邊格）為**部分縣市供數**（台北/新北/台中/台南/高雄/屏東有，桃園/基隆/花蓮/嘉義/新竹無）。

**台北市 pilot 掃描（130km²、1.4km 網格、160 次呼叫、53 秒、0 次 429）**：

- `CarPark` 551 場（公有+民營路外停車場）；`WheelchairAccessible=1` 424 場；`Description` 含「身心障礙」532 場（如「小型車18格(含身心障礙車位1格)」文字描述）
- `ParkingSpot` 22,885 格；**身障格（`SpaceType`=9 汽車／10 機車）238 格**，含 WGS84 座標與格位 ID
- 對照：現有台北身障格 CSV（2.1#2）僅為路邊格彙整，TDX 資料含全部格位與官方 SpaceType 編碼

**全台成本粗估**：都會區網格掃描約 4,000–6,000 次呼叫（约 25–30 點，若按 spec 所述「計次 200次/1點」計費；實測現有 token 未觸發額度限制，需以官方「我的服務」頁為準）。

**✅ 2026-08-13 已實作並完成全台匯入**（`src/scripts/import-tdx-parking.ts`，`npm run import:parking-tdx`）：

- 24 個都會區 bbox（step 1.4km、radius 1000m、`$top=500`、順序呼叫+網路重試）→ 9.5 分鐘、約 2,600 次呼叫、0 次 429
- 匯入結果：**DisabledParking 888 格**（身障格，`source=tdx`）／**ParkingSpace 67,867 格**（一般格）／**ParkingLot 2,984 場**（含從 `Description` 解析的 `disabledSpaces`）
- 現有 `/api/v1/a11y/parking/nearby` 與 AI agent `findNearbyParking` **零改動直接可用**（實測高雄巨蛋 500m 回 3 格）
- 已知限制：bbox 邊緣 ±1km 帶的 `city` 標記可能偏差（geo 查詢用座標不受影響）；路邊身障格僅台北/新北/高雄有（TDX 僅對這三縣市標記 SpaceType 9/10，其他縣市為路段彙總 SpaceType 0）

> ⚠️ 這**推翻了本文件初版「TDX 停車資料停止供數」的結論**：正確狀況是 basic 層縣市端點（v1 `CarPark/City/{City}` 等）空資料，而 **advanced 層 NearBy 空間查詢有全台資料**。先前測試 basic/v2 404、v1 City 全空皆正確，但漏測 advanced 層。

### 2.1 可用（已實測 200 且內容正確）

| #   | 縣市           | 資料集                                                     | 來源 URL                                                                                                                      | 格式                 | 座標                                                    | 備註                                                                   |
| --- | -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | 新北市         | 路邊停車場身心障礙停車格                                   | `data/disabled-parking/新北市路邊停車場身心障礙停車格.csv`（本機已有）                                                        | CSV                  | TWD97/TM2 → WGS84（`disabled-parking-parse.ts` 已處理） | 現役匯入腳本                                                           |
| 2   | 臺北市         | 臺北市路邊停車格位（身障專用格 CSV 資源）                  | `https://data.taipei/api/dataset/5a911ea5-1694-4301-808e-e1780d971611/resource/a76540cb-b6ee-410f-a2ca-de9432d62390/download` | CSV                  | WGS84 直用                                              | 欄位：行政區,地址,格位數,周邊景點或商圈,場站緯度,場站經度              |
| 3   | 臺北市         | 臺北市路邊停車格位（全量 SHP 資源）                        | 同上資料集、resource `7e2f32a0-9201-4666-a0ed-11034e6c2b66`                                                                   | SHP (zip)            | WGS84                                                   | 含格位類別欄位（身障格可由類別篩出）                                   |
| 4   | 新北市         | 路邊停車空位查詢                                           | `https://data.ntpc.gov.tw/api/datasets/54a507c4-c038-41b5-bf60-bbecb9d052c6/csv/file`                                         | CSV                  | WGS84 直用                                              | 欄位含 `name`（如「汽車身心障礙專用」）可當身障標記；需帶瀏覽器 UA     |
| 5   | 臺中市         | 路邊停車格位資訊                                           | `https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=cccb8eb9-ad58-4e30-b078-cac890e7c56b`             | CSV→Google Drive SHP | WGS84                                                   | 下載檔是「地圖服務」說明 CSV，實際圖資在 Google Drive 連結             |
| 6   | 全台（交通部） | 指定[縣市]之路邊停車格位基本資料（data.gov.tw nid 161173） | `https://tdx.transportdata.tw/api/basic/v1/Parking/OnStreet/ParkingSpot/City/{City}`                                          | JSON API             | WGS84                                                   | **basic 層 2026-08 實測全空**；資料實際在 advanced 層 NearBy（見 2.0） |

### 2.2 已排除（實測不可用）

| 來源                                                                  | 實測結果                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| TDX basic v1 `Parking/*/City/{City}`（74 端點）                       | 200 但全空（**資料在 advanced 層 NearBy，見 2.0**）              |
| TDX v2 `Parking/*`                                                    | 404（停車資源為 v1-only）                                        |
| OSM Overpass：`amenity=parking_space` + `disabled=designated`         | 台灣全島 nodes 0、ways 1（近乎為零）                             |
| data.gov.tw 搜尋 API `POST /api/front/dataset/list`（`keyword` 參數） | 無視關鍵字（端點疑似棄用）；搜尋頁 `/search`、`/datasets` 皆 500 |
| data.taipei 資料集清單 API `/api/v1/dataset/all`                      | count 0（清單端點停用；**下載端點仍通**）                        |
| Bing 中文搜尋                                                         | 拆詞嚴重（「身心」→ 身心科），不可靠                             |

### 2.3 TDX「停車資訊」OpenAPI 完整定義（2026-08-13 使用者提供 swagger 後補測）

使用者提供的 swagger：`https://tdx.transportdata.tw/webapi/File/Swagger/V3/945f57da-f29d-4dfd-94ec-c35d9f62be7d`（已存檔為 `docs/reports/tdx-parking-swagger-v1.json`，451KB OpenAPI 3.0）。

- **server**：`https://tdx.transportdata.tw/api/basic`；版本 **v1-only**（v2 全 404）；City 參數 enum 為英文代碼（Taipei / NewTaipei / …）。
- **共 74 個端點**，三大家族：
  - `OffStreet/CarPark|ParkingAvailability|ParkingEntranceExit|ParkingFacility|ParkingRate|ParkingServiceTime|ParkingSpace|ParkingSpot|ParkingSpotAvailability|ParkingTicketing` ＋ `Air/Airport/{Authority}`、`Rail/Station/{RailOperator}`、`Ship/Port`、`Road/Freeway/ServiceArea`、`Tourism` 等場域變體
  - `OnStreet/ParkingSegment|ParkingSegmentAvailability|ParkingSegmentChargeTime|ParkingSegmentRate|ParkingSegmentSpace|ParkingSpot|ParkingSpotAvailability|ParkingSpotChargeTime`
  - `Alert/City`、`News/City`、`Authority`
- **對本專案有價值的欄位定義**（可做為自建 schema 的設計依據）：
  - `CarPark`：`CarParkPosition`（座標）、`Address`、`City/TownName`、`ParkingAreas[]`、`WheelchairAccessible`、`LiveOccuppancyAvailable`、`EVRechargingAvailable`、`OvernightPermitted`、`CarParkType`（1平面/2立體/3地下/4停車塔/5機械式…）、`ChargeTypes`（1計時/2計次/3月租/4免費）
  - `Space.SpaceType` 列舉 **9=身心障礙汽車車位、10=身心障礙機車車位**（另有孕婦親子 7、婦女 8、電動 11/12 等）→ 官方對「身障車位」的標準編碼
  - `Space.NumberOfSpaces`：車位數
- **實測結果（2026-08-13）**：21 縣市 `OnStreet/ParkingSegment`、六都 `OffStreet/CarPark`、`ParkingFacility/Rate/ServiceTime`、機場（TAC/CAA）、鐵路（TRA/THSR）、國道服務區、`Tourism` 全部 **HTTP 200 但 0 筆資料** → 縣市政府未供數，交通部僅保留 API 架構。token 有效性已對照驗證（v1 Parking 回 200 非 401）。
- 結論：TDX 是**未來官方彙整管道的架構預留**（欄位標準可直接沿用），目前不能當作全台資料來源。資料漂移詳細因應見 `docs/reports/TDX_QUOTA_AND_DATA_DRIFT.md`。

### 2.4 實測過程中的關鍵技術筆記

- **data.gov.tw 詳細頁 API**：`GET https://data.gov.tw/api/front/dataset/detail?nid={nid}` → payload 含 `resources[].download_url` 與 `coverage_spatial`。nid 可用 DuckDuckGo Lite（`https://lite.duckduckgo.com/lite/?q=...`）找 `data.gov.tw/dataset/{nid}` 頁。
- **data.taipei 新版下載端點**：`https://data.taipei/api/dataset/{datasetUuid}/resource/{resourceUuid}/download`（v1 端點已停用）。
- **data.ntpc.gov.tw 擋無 UA 爬蟲**：加 `User-Agent: Mozilla/5.0` 即回 200。
- **SHP 檔**：台北/台中為 shapefile（zip 內 .dbf/.cpg），需 `shpjs` 或 GDAL/OGR 解析（專案目前無此依賴）。

## 3. 各縣市覆蓋盤點（規劃用）

| 縣市                                   | 身障停車格              | 一般路邊停車格  | 路外停車場                                             | 狀態                 |
| -------------------------------------- | ----------------------- | --------------- | ------------------------------------------------------ | -------------------- |
| 臺北市                                 | ✅ CSV（2.1#2）         | ✅ SHP（2.1#3） | 待註冊（data.taipei「臺北市停車場資訊」）              | 可直接匯入           |
| 新北市                                 | ✅ CSV（本機）          | ✅ CSV（2.1#4） | 待查                                                   | 可直接匯入           |
| 臺中市                                 | 待查                    | ✅ SHP（2.1#5） | 待註冊（opendata.taichung.gov.tw「臺中市路外停車場」） | SHP 需處理           |
| 高雄市                                 | 待查（data.kcg.gov.tw） | 待查            | 待查                                                   | 需註冊資料集         |
| 臺南市                                 | 待查                    | 待查            | 待查                                                   | 需註冊資料集         |
| 桃園市                                 | 待查                    | 待查            | 待查                                                   | 需註冊資料集         |
| 其他縣市（基隆/新竹/嘉義/彰化/屏東等） | 多數未公開              | 多數未公開      | 部分有                                                 | 依開放資料成熟度遞減 |

> 註：依《身心障礙者權益保障法》第 56 條，各縣市都依法設置身障專用停車位，但**只有部分縣市將其開放為機器可讀資料**。全台「完整」覆蓋在資料源頭即不存在，務實目標是六都＋直轄市優先。

## 4. 匯入規劃（建議實作方案）

### 4.1 資料模型

**維持現有**：

- `DisabledParking`（身障停車格，a11y 查詢用）— 新增兩個欄位：
  - `source: string`（`taipei` / `ntpc` / `taichung` …）— 追蹤資料來源
  - `externalId: string` — 來源端唯一識別碼，供 upsert 去重（避免跨縣市重複匯入）

**新增（另建 collection，不污染 a11y 查詢）**：

- `ParkingLot`（路外停車場）：`name / address / district / totalSpaces / disabledSpaces / chargeType / lat/lng / source / externalId / importedAt`
- `ParkingSpace`（一般路邊停車格，含身障標記）：`city / district / roadName / spaceLabel / isDisabled / lat/lng / source / externalId / importedAt`

### 4.2 Adapter 層（`src/scripts/`，比照 `disabled-parking-parse.ts`）

每個縣市一個純函式 parser（輸入原始列、輸出標準化 doc），匯入腳本負責 fetch：

- `taipei-parking.ts`：data.taipei CSV（身障格）＋ SHP（一般格，需新增 `shpjs` 依賴）
- `ntpc-parking.ts`：data.ntpc CSV（`name` 欄位含「身心障礙」→ `isDisabled: true`）
- `taichung-parking.ts`：Google Drive SHP（需人工下載至 `data/` 後解析）
- 通用 `parking-common.ts`：TW 邊界座標檢查、`city/district` 正規化、upsert by `externalId`

### 4.3 匯入執行（比照 `import-tdx-metro.ts` 的 chunk + upsert 模式）

- `import-parking-all.ts`：依序跑各縣市 adapter，`bulkWrite` upsert（filter: `{externalId, source}`）
- 單縣市更新：`import-parking-all.ts --city=taipei`
- package.json 新 script：`import:parking-all`
- 排程：沿用現行手動執行慣例（無 cron 機制），每次更新 = 重跑腳本（全台掃描一次約 5–10 分鐘）

### 4.4 里程碑

- **M1（本次，低風險）**：台北身障格 CSV 匯入（`DisabledParking.source=“taipei”`）＋ 新北身障格補 `source/externalId` 欄位遷移。改動集中在 `import-disabled-parking.ts` + model 欄位。
- **M1b ⭐（TDX advanced 全台掃描，取代 M2–M4）**：`import-tdx-parking.ts` 網格掃描（step 1.4km、radius 1000m、`$top=500`）→ `CarPark` → 新 `ParkingLot` collection；`ParkingSpot` `SpaceType 9/10` → `DisabledParking`（全台身障格）；其餘格位 → `ParkingSpace`。資料標準（SpaceType/CarParkType/ChargeTypes）直接沿用 TDX 官方編碼。
- **M2**：新北一般路邊停車格 CSV（含身障標記）→ `ParkingSpace`；台北 SHP → `ParkingSpace`（加 `shpjs`）。（若 M1b 上路，本項可省略）
- **M3**：台中 SHP 人工下載 → `ParkingSpace`；高雄/台南/桃園註冊資料集（DDG Lite 找 data.gov.tw nid → detail API 拿資源網址）。
- **M4（架構預留）**：交通部 TDX `Parking/OnStreet/ParkingSpot/City/{City}` 若恢復供數，adapter 只需換來源，標準化層不動。（已被 M1b advanced NearBy 取代）
- **M5（路外停車場，另議）**：`ParkingLot` collection ＋ 台北「停車場資訊」等資料集；屬新 API 功能（非身障格），建議確認產品需求後再做。

### 4.5 風險與注意事項

- **資料版權**：data.gov.tw 資料集均為政府開放授權（OGDL-TW），可自由使用；Google Drive 上的台中 SHP 需人工確認授權頁。
- **SHP 依賴**：新增 `shpjs`（純 JS，無原生依賴）解析 dbf 欄位；或改用專案既有 Python 工具鏈（`scripts/*.py`）以 GDAL 轉換，再匯入 CSV。
- **資料時效**：台北 CSV 附更新日期（檔名 `park01_202605271503`），建議腳本記錄來源端更新時間。
- **一般停車格量級**：台北全量路邊停車格約數萬筆、含身障標記；`ParkingSpace` 若啟用，a11y 查詢**不可**納入一般格（維持只查 `DisabledParking`），否則 150 公尺 $near 回傳爆炸。

## 5. 附錄：本次研究使用的實測清單

- `GET /api/front/dataset/detail?nid={161173|128288|84296|122901}`（data.gov.tw 資源解析）
- 台北：`data.taipei/api/dataset/5a911ea5-1694-4301-808e-e1780d971611/resource/{7e2f32a0…|a76540cb…}/download`
- 新北：`data.ntpc.gov.tw/api/datasets/54a507c4-c038-41b5-bf60-bbecb9d052c6/csv/file`
- 台中：`newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=cccb8eb9-ad58-4e30-b078-cac890e7c56b`
- TDX：`/api/basic/v1/Parking/{OnStreet/ParkingSegment|OnStreet/ParkingSpot|OffStreet/CarPark|OffStreet/ParkingFacility|OffStreet/ParkingRate|OffStreet/ParkingServiceTime}/City/{21縣市}`（全部 200 空）；`/api/basic/v1/Parking/OffStreet/CarPark/{Air/Airport/TAC|Rail/Station/THSR|Rail/Station/TRA|Road/Freeway/ServiceArea|Tourism}`（全空）
- Overpass：`area["ISO3166-1"="TW"]; node/way["amenity"="parking_space"]["disabled"~"^(designated|yes)$"]` → nodes 0 / ways 1
