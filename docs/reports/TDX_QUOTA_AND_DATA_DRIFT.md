# TDX 額度與資料漂移（quota & data drift）

> 供各功能 spec 以 `[[tdx-quota-and-data-drift]]` 引用。本文件是**已知限制與緩解策略**的單一事實來源，改動前先讀。

## 1. 額度（quota / rate limit）

### 已知限制

- TDX 免費方案有速率限制；實測經驗：**burst 4–6 次呼叫即可觸發 429**（多個功能 spec 已記載）。
- 429 回應附 `Retry-After` 語意的機會低，目前以固定退避處理。
- token（`client_credentials`）每 6–8 小時過期，`TdxTokenManager` 自動刷新；401 時強制刷新重試一次。

### 專案既有防護（`src/config/fetch.ts` 的 `tdxFetch`）

1. 自動加 `Authorization: Bearer`；
2. **401 → 強制刷新 token 後重試一次**；
3. **429 → 退避 1.5s 後重試一次**（超過仍失敗則拋出）。

### 緩解策略（寫新程式碼時必須遵守）

| 情境 | 做法 |
| ------ | ------ |
| 靜態資料（公車路線/站位、捷運站、CityAPS 等） | **嚴禁在 query 時即時呼叫**；一律經 `src/scripts/import-tdx-*.ts` 預匯入 MongoDB，查詢只走本地 DB |
| 大量匯入 | 逐系統/逐縣市串列 + 批次間 sleep（既有腳本 `DELAY_MS` 慣例）；chunk 寫入 |
| 動態資料（即時車位、到站時間） | 集中快取（Redis 可用）；批次撈取後廣播，禁止每請求直連 |
| 多資源串接（如 `/ai/chat` tool loop） | 上限化：單一請求最多 N 次外部呼叫；優先本地查詢（見 `FUNCTIONAL_SPEC_AI_AGENT_PRODUCTION.md` §5.2） |
| 單一惡意使用者 | 使用者的呼叫配額（auth middleware 層）＋外部呼叫計數器 |

## 2. 資料漂移（data drift）

TDX 資料由各縣市政府／主管機關供數，**交通部只做彙整轉發**，因此：

- 資料集可能**下架、停供、欄位增刪、座標系變更**，且通常無事前通知；
- 「資源存在（HTTP 200）但回傳空陣列」是停供的典型症狀，**不是 bug**；
- API 版本（v1/v2、basic/advanced）對不同資源存在混用，同一資源可能只在特定版本存在。

### 實測案例（2026-08-13）

| 資源 | 狀態 |
| ------ | ------ |
| `v1/Parking/*/City/{City}`（basic 層 74 端點） | 全部 200 但**全縣市、全場域回空**（機場/鐵路/國道/旅遊亦空） |
| `v1/Parking/OffStreet/CarPark/NearBy`、`v1/Parking/OnStreet/ParkingSpot/NearBy`（**advanced 層**，`$spatialFilter=nearby(lat,lon,1000)`） | **有全台資料**（CarPark 全台；ParkingSpot 部分縣市）— 2026-08-13 實測 |
| `v2/Parking/*` | 404（停車資源為 v1-only） |
| `v2/Bus/*`、`v2/Metro/*` 等（本專案現役來源） | 正常供數 |
| OSM Overpass（非 TDX）身障停車格 | nodes 0 / ways 1（近乎為零，非 TDX 問題但同屬「資料不存在」陷阱） |

> ⚠️ 2026-08-13 修正：初版曾誤判「停車資料全台停供」——實際是 **basic 層縣市端點空、advanced 層 NearBy 空間查詢有資料**（不同 server 供數不同）。教訓：**同一資源在 basic/advanced 層可能供數不同，驗證時兩層都要試**。詳細盤點：`docs/reports/parking-open-data-research.md` §2.0；停車 API 完整欄位定義：`docs/reports/tdx-parking-swagger-v1.json`。

### 因應原則

1. **匯入腳本對「0 筆結果」要有感知**：回傳 0 時印出警告並以非零 exit code 結束（或至少 log 明顯），避免無聲漂移；
2. **記錄來源端更新時間**（如 `SrcUpdateTime`）到文件，比對漂移；
3. **upsert 以來源 UID 為主鍵**（`externalId`/`stationUid` 等），欄位改名時只需改 parser，不重建資料；
4. **規格文件不寫死資源版本**；引用的 URL 集中於 `src/config/transit.ts` 等 config，改版只動一處；
5. 停供的資源**保留 adapter 骨架**（架構預留），供數恢復時接回。

## 3. 申請與額度上限（若升級）

- TDX 有付費方案與更高額度，須在官網申請並提供用途說明；升級後 `TDX_CLIENT_ID/SECRET` 不變，僅額度變。
- 各資源的呼叫上限以官網「我的服務」頁為準；本專案未做自動額度監看（TODO）。
