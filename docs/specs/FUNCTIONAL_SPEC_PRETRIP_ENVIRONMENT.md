# 出發前環境資訊查詢

## Functional Specification — Pre-Trip Environment Aggregation

**版本**：v1.0.5  
**狀態**：Implemented（Phase E-1 ~ E-3 已實作並通過真實 API 煙霧測試）· Phase E-4（AI Agent Tool）選配未實作  
**日期**：2026-06-17（最後更新：2026-06-20）  
**作者**：yuzen9622

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [外部資料來源整合](#4-外部資料來源整合)
5. [API 規格](#5-api-規格)
6. [快取策略](#6-快取策略)
7. [資料模型](#7-資料模型)
8. [實作 Roadmap](#8-實作-roadmap)
9. [測試策略](#9-測試策略)
10. [新增環境變數](#10-新增環境變數)
11. [前端職責邊界](#11-前端職責邊界)
12. [風險與緩解](#12-風險與緩解)

---

## 1. 系統概述

本功能讓使用者在出發前，針對目標地點一次查詢三類即時環境資訊：

| 資訊類型                              | 資料來源                                     | 現有整合狀態                                               |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **天氣**（氣溫 / 降雨 / 風速 / 風向） | 中央氣象署 CWA 開放資料 API                  | 未整合                                                     |
| **空氣品質（AQI / PM2.5）**           | 台灣感測器平台 STA（`sta.ci.taiwan.gov.tw`） | ✅ 已整合（`getAirQuality` Agent Tool + `air.service.ts`） |
| **監視器（CCTV）路況**                | 台灣路況監視器平台 twipcam（`twipcam.com`）  | 未整合                                                     |

**系統定位**：純資訊查詢聚合端點，**不**修改路徑規劃邏輯，不影響無障礙評分，回傳結果供使用者自行判斷是否出發。

---

## 2. 系統目標

### 2.1 核心能力

- 依座標一次取得天氣、空品、鄰近監視器三類環境資料
- 各資料來源獨立降級——任一來源失敗時部分回傳，以 `unavailable` 標記失敗區塊
- 以 Redis 分層快取降低外部 API 呼叫頻率，各資料類型採不同 TTL

### 2.2 非功能目標

| 目標                   | 說明                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| 後端聚合               | 前端單一呼叫即取得三類資料，不直接呼叫外部 API                           |
| 降級不中斷             | 任一外部 API 失敗，其他區塊仍正常回傳                                    |
| 配額保護               | Redis 快取攔截重複查詢，避免超過外部 API 速率上限                        |
| 環境感知路徑不納入本期 | 本功能僅供資訊顯示，不與評分引擎整合（環境感知路徑規劃 S4 為獨立 phase） |

---

## 3. 系統架構

### 3.1 請求流程

```
Client Request
      ↓
Express (src/app.ts)
      ↓
Zod Validation Middleware
      ↓
GET /api/v1/a11y/environment
      ↓
environment.controller.ts
      ↓
┌──────────────────────────────────────────────────────────────┐
│ EnvironmentService — 降級「政策」層                              │
│ src/modules/environment/environment.service.ts                 │
│  ① Redis 快取讀取（cache-aside，各類型獨立 TTL）                  │
│  ② 未命中 → 呼叫對應 adapter                                     │
│  ③ Promise.allSettled：任一 adapter throw → 該區塊 unavailable  │
│  ④ 聚合三區塊                                                   │
└────┬──────────────────────┬───────────────────────┬───────────┘
     ▼                      ▼                       ▼
 cwa.adapter.ts        air.service             twipcam.adapter.ts
 (CWA 兩段式封裝)       getAirData()(現有)       (twipcam 清單封裝)
 失敗則 throw                                   失敗則 throw
     └──────────────────────┴───────────────────────┘
                            ▼
       config/resilience.ts — 降級「機制」層（infra）
       withResilience()：timeout・斷路・log・例外正規化
                            ↓
       sendResponse()  ← { weather, airQuality, nearbyCctv }
```

> 依賴方向單向：`service → adapter → config(infra)`；**adapter 永不回頭呼叫 service**（詳見 §3.3）。

### 3.2 模組配置

降級被拆成「機制」與「政策」兩塊（§3.3），分別落在 **infra** 與 **service** 兩層；外部 I/O 則一律住 **adapter**（符合本專案 CLAUDE.md「external I/O → `src/adapters/`、一檔一來源」的約定）：

```
src/adapters/
├── cwa.adapter.ts        # CWA HTTP I/O：兩段式抓取（089 → 縣市鄉鎮檔）回原始 payload；失敗則 throw
└── twipcam.adapter.ts    # twipcam cam-list.json HTTP I/O，回原始全台清單；失敗則 throw

src/config/
└── resilience.ts         # withResilience()：timeout / 斷路 / log / 例外正規化（infra，與 fetch.ts 同層）

src/constants/
├── environment.ts        # 外部 URL、Redis key 前綴 / TTL、reason 代碼（集中，無 magic literal）
└── cwa-county-codes.ts   # 靜態「縣市名 → F-D0047 resource ID」對照表（22 筆）

src/modules/environment/
├── environment.router.ts       # createEnvironmentRouter()：path + validateRequest，delegate 給 controller
├── environment.controller.ts   # GET handler：讀 req.validated.query、呼叫一個 service、sendResponse
├── environment.service.ts      # 降級「政策」：cache-aside + Promise.allSettled + 失敗→unavailable 對應
├── environment.parse.ts        # 純轉換：raw CWA / twipcam payload → environment.types（無 I/O、無 HTTP、無業務判斷）
├── environment.schema.ts       # Zod 請求驗證（registered to OpenAPI）
├── environment.types.ts        # 回應型別（§7.1）
└── index.ts                    # 唯一註冊點：export createEnvironmentRouter
```

> **空品（AQI）**：直接重用現有 `src/modules/air/air.service.ts` 的 `getAirData()`，不另建封裝（air 模組內部已自有 HTTP 封裝）。
>
> **不再有 `weather.service.ts` / `cctv.service.ts`**：CWA / twipcam 的 HTTP 封裝移至 `adapters/`；原本要散在各 service 的降級邏輯上收為單一「政策」層（`environment.service.ts`）＋單一「機制」層（`config/resilience.ts`）。
>
> **無 magic literal**：CWA / twipcam 外部 URL、Redis key 前綴與 TTL、`reason` 代碼集中於 `src/constants/environment.ts`；使用者可見訊息字串放 `src/constants/messages.ts`；HTTP 狀態碼用 `ResponseCode` enum（`src/types/code.ts`）。呼叫點不得內聯字面值。
>
> **解析獨立成 `environment.parse.ts`**：adapter 只管 HTTP I/O 與「該抓哪一筆」（CWA 兩段式就近比對用 `utils/geo.ts` 的 Haversine 決定抓哪個縣市 / 區檔），**回原始 payload**；raw → domain 的欄位正規化、twipcam 距離過濾 / 排序 / 取前 N / `snapshotUrl` 推導，全部移到 `environment.parse.ts`（純函式，無 I/O / HTTP / 業務判斷）。service 流程＝ `adapter（I/O）→ parse（轉換）→ allSettled（政策）`。

### 3.3 降級分層（機制 vs 政策）

「降級」不是塞在 adapter 與 service 之間的一層，而是拆成兩個**正交**的關注點，各自下沉 / 上收到正確的層，且依賴方向單向、永不回頭：

| 關注點   | 內容                                                                              | 住哪                                    | 理由                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **機制** | timeout、斷路、重試、例外正規化、log                                              | **infra**（`src/config/resilience.ts`） | 橫切關注點，不屬任何 domain；位於依賴圖最底層，誰都能用、不依賴任何人。與既有 `tdxFetch`（`src/config/fetch.ts`，掛 token + 401 重試）同層同理 |
| **政策** | `Promise.allSettled`、部分回 200、「unavailable 對本端點的語意」、cache-aside TTL | **service**（`environment.service.ts`） | 「本端點容忍缺哪幾塊」是業務決策                                                                                                               |

**adapter 失敗直接 throw、由 service 決定容忍**：

1. adapter 只做 HTTP I/O（呼叫 + 回原始 payload）；逾時 / 4xx / 5xx 經 `withResilience` 正規化後 **throw**，**不**自行決定降級。raw → domain 的解析交給 `environment.parse.ts`（純函式）。
2. `environment.service.ts` 以 `Promise.allSettled` 包住三個來源，catch 到某個 reject → 將該區塊標 `status: "unavailable"` 並填 `reason`。
3. 結果：**失敗→unavailable 的對應只寫在 service 一個方法裡，例外正規化只寫在 config 一處**——沒有任何降級邏輯散落在 adapter。死因由 `withResilience` 統一 log、`reason` 統一分類，先前「fallback 散落、`unavailable` 分不出死因」的 debug 問題因此消除。

依賴方向（所有箭頭朝 infra，adapter 永不呼叫 service）：

```
environment.service.ts ──→ cwa.adapter.ts ──────┐
            │              twipcam.adapter.ts ──┼──→ config/resilience.ts (infra)
            └───────────────────────────────────┘            ▲
                          （service 亦可直接用 infra，如 redis.ts）─┘
```

---

## 4. 外部資料來源整合

### 4.1 天氣資料 — 中央氣象署 CWA 開放資料 API

#### 4.1.1 API 資訊

| 項目                        | 內容                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件網址                    | `https://opendata.cwa.gov.tw/dist/opendata-swagger.html`                                                                                                                                                                                                 |
| 授權金鑰                    | CWA 開放資料平台申請，免費方案每日呼叫上限 100,000 次                                                                                                                                                                                                    |
| 環境變數                    | `CWA_API_KEY`                                                                                                                                                                                                                                            |
| 採用端點（兩段式，方案 E′） | **① 定縣市**：`GET /v1/rest/datastore/F-D0047-089` — 全台 22 縣市代表點（含 `Latitude`/`Longitude`），Haversine 取最近縣市。**② 定區**：依縣市查靜態表取該縣市鄉鎮檔（如臺北市 → `F-D0047-061`），Haversine 取最近區。皆每 6 小時更新（詳見 §4.1.2、§8） |

#### 4.1.2 請求範例

```http
# ① 定縣市：全台 22 縣市代表點（含座標）→ 後端 Haversine 取最近縣市
GET https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-089
  ?Authorization={CWA_API_KEY}&format=JSON

# ② 定區：對 ① 找到的縣市（例：臺北市 → F-D0047-061）取該縣市鄉鎮檔
#    → 後端 Haversine 取最近區的 Location
GET https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-061
  ?Authorization={CWA_API_KEY}&format=JSON
```

> 經實測（2026-06-19，實打 API）：過濾參數為 **PascalCase** —— `ElementName=溫度,3小時降雨機率,…`、`LocationName=<區>` 才會生效；舊版小寫 `elementName` / `locationName` 會被**靜默忽略**（回傳全部，這也是早期草稿誤以為可用的原因）。兩段式 stage ② 需全縣市各區座標做 Haversine，故**不**用 `LocationName` 過濾，但可用 `ElementName` 只取所需元素以縮小 payload。

> **方案演進**：原規劃方案 E（單一全台鄉鎮檔 `F-D0047-093` + 就近比對）經 2026-06-19 實打 API 確認**不可行**——`F-D0047-093` 在 REST datastore 為 404，且 API 上唯一的全台檔（`089`/`091`）只有 **22 個縣市代表點**、非全鄉鎮。改採**方案 E′（兩段式就近比對）**：先用 `089`（22 縣市點）Haversine 定縣市，再抓該縣市鄉鎮檔 Haversine 定區，全程**免 Google 反查**、僅需一張靜態縣市→ID 表。座標 → 行政區 反查方案比較（仍列為參考）：

| 方案 | 類型 | 成本 / 配額 | 精度 | 備註 |

> |------|------|------------|------|------|
> | **A. Google Maps Reverse Geocoding** | 外部 API | 付費、有配額 | 縣市 + 區 | 現有 `getCityZh()`，§4.2 空品已使用，可直接重用 |
> | **B. 靜態 GeoJSON 鄉鎮市區界 + point-in-polygon** | 離線 | 免費、無配額、無網路 | 鄉鎮/區（精確含括判斷） | 資料源：政府資料開放平臺「鄉鎮市區界線(TWD97經緯度)」（dataset 7441）；以 turf.js `booleanPointInPolygon` 判斷 |
> | **C. TGOS 地理資訊圖資雲服務平台（內政部）** | 外部 gov API | 免費（需註冊金鑰） | 鄉鎮/區/門牌 | 官方門牌資料（約 800 萬點）；端點：坐標查詢最近鄰地址 `PointAddr`、行政區定位 |
> | **D. OSM Nominatim reverse** | 外部 API | 免費但限速 1 req/s | 行政區未必對齊台灣界線 | 正式環境須自架，不建議 |
> | **E. （否決）單一全台鄉鎮檔 `F-D0047-093` + 就近比對** | — | — | — | ❌ 實測 `F-D0047-093` API 為 404，且全台檔 `089`/`091` 僅 22 縣市點，無法達鄉鎮粒度 |
> | **E′. 兩段式：`089` 定縣市 → 縣市鄉鎮檔定區（採用）** | 無需 geocoder | 免費（2 次呼叫） | 鄉鎮/區 | ① `089`（22 縣市點）Haversine 定縣市 → ② 靜態 22 筆「縣市→ID」表抓該縣市鄉鎮檔 → Haversine 定區 |
> | **F. 改用縣市層級預報 `F-C0032-001`** | 降低需求 | 免費 | 僅縣市 | 只需 `getCityZh()` 的縣市即足夠；天氣較粗、無需鄉鎮反查 |
>
> **採用：方案 E′（兩段式）**。fallback：若僅需縣市粒度可退至單段 `089`（方案 F 精神）；若需離線可改 **B**（GeoJSON）。靜態縣市→ID 對照表見 §8 Phase E-2（已實打 API 驗證，每 4 號一個、共 22 縣市）。
>
> **背景（實打 API 驗證，2026-06-19）**：`F-D0047-093`（全台鄉鎮）在 REST datastore = **404**；全台聚合檔 `089`（3天逐3小時）/ `091`（1週逐12小時）僅含 **22 縣市代表點**。鄉鎮/區粒度只能用逐縣市檔（臺北市 `F-D0047-061`、新北市 `F-D0047-069` …，每 4 號遞增）。座標欄位為 **`Latitude`/`Longitude`**（非 `Lat`/`Lon`）。

#### 4.1.3 欄位對應表（✅ 已對照實際回應，2026-06-19）

每個 `Location` 結構：`{ LocationName, Latitude, Longitude, WeatherElement[] }`。各 `WeatherElement` 以中文 `ElementName` 標示，值位於 `WeatherElement[].Time[].ElementValue[0].<key>`（瞬時值用 `Time[].DataTime`；區間值如降雨機率/天氣現象用 `Time[].StartTime`/`EndTime`）。

| CWA `ElementName`                          | `ElementValue` key                  | 回應欄位                           | 範例值                           |
| ------------------------------------------ | ----------------------------------- | ---------------------------------- | -------------------------------- |
| `溫度`                                     | `Temperature`                       | `weather.temperature`              | `"36"`（°C）                     |
| `3小時降雨機率`                            | `ProbabilityOfPrecipitation`        | `weather.precipitationProbability` | `"10"`（%，**3 小時**非 6 小時） |
| `風速`                                     | `WindSpeed`（另有 `BeaufortScale`） | `weather.windSpeed`                | `"2"`（m/s）                     |
| `風向`                                     | `WindDirection`                     | `weather.windDirection`            | `"西北風"`                       |
| `天氣現象`                                 | `Weather`（另有 `WeatherCode`）     | `weather.condition`                | `"晴"`                           |
| `天氣預報綜合描述`                         | `WeatherDescription`                | （選用，整段描述）                 | `"晴。降雨機率10%。溫度…"`       |
| `Location.Latitude` / `Location.Longitude` | —                                   | （Haversine 就近比對用）           | `"25.051608"` / `"121.568983"`   |

> 其餘可用元素：`露點溫度`(`DewPoint`)、`相對濕度`(`RelativeHumidity`)、`體感溫度`(`ApparentTemperature`)、`舒適度指數`(`ComfortIndex`/`ComfortIndexDescription`)。`F-D0047-091`（1週）改為 `平均溫度`/`最高溫度`/`最低溫度`、`12小時降雨機率`、`紫外線指數` 等彙總元素。

#### 4.1.4 錯誤處理

| 情境           | 處理方式                                                   |
| -------------- | ---------------------------------------------------------- |
| HTTP 4xx / 5xx | `weather` 區塊標記 `status: "unavailable"`，不中斷整體回應 |
| 查無地點資料   | 同上                                                       |
| 逾時（> 5 秒） | 同上，記錄 warning log                                     |

> **分層**（§3.3）：4xx / 5xx / 逾時由 `cwa.adapter.ts`（經 `withResilience`）正規化後 **throw**；「標記 `unavailable`、不中斷整體」是 `environment.service.ts` 的 `Promise.allSettled` 政策。本表描述的是**對外可觀察結果**，非實作所在層。

---

### 4.2 空氣品質（AQI） — 台灣感測器平台 STA

#### 4.2.1 現有整合

空品查詢已由 `src/modules/air/air.service.ts` 的 `getAirData(lat, lng)` 完整實作，以台灣感測器平台（STA）`sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams` 為資料來源，依座標反查縣市後抓取最近測站 PM2.5。

本功能不重複建立邏輯，直接呼叫 `getAirData()` 並以 `classifyPm25()` 轉換成健康建議文字。

#### 4.2.2 整合方式

```typescript
// environment.service.ts 內呼叫方式
import { getAirData, classifyPm25 } from "../air/air.service";

const airData = await getAirData(lat, lng);
if (!airData) {
  return { status: "unavailable" };
}
const pm25 = airData.readings[0].pm25;
const { quality, advice } = classifyPm25(pm25);
```

#### 4.2.3 欄位對應表

| air.service 欄位                 | 回應欄位                        | 說明                        |
| -------------------------------- | ------------------------------- | --------------------------- |
| `readings[0].pm25`               | `airQuality.pm25`               | PM2.5 濃度（μg/m³）         |
| `readings[0].area`               | `airQuality.area`               | 測站區域名稱                |
| `readings[0].coordinates`        | `airQuality.stationCoordinates` | 測站座標                    |
| `quality`（`classifyPm25` 輸出） | `airQuality.quality`            | 品質等級（良好 / 普通 / …） |
| `advice`（`classifyPm25` 輸出）  | `airQuality.advice`             | 健康建議文字                |

---

### 4.3 監視器（CCTV） — twipcam

#### 4.3.1 API 資訊

| 項目         | 內容                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 文件網址     | `https://www.twipcam.com/api/document`                                                                                              |
| 授權方式     | ✅ 已確認 — **不需要 API Key**（兩個端點皆為公開存取）                                                                              |
| 環境變數     | 無（不需金鑰）                                                                                                                      |
| 全台清單端點 | `GET https://www.twipcam.com/api/v1/cam-list.json` — 回傳全台攝影機清單（JSON 陣列，約 800+ 筆），無參數、無認證                    |
| 座標查詢端點 | `GET https://www.twipcam.com/widget/v1/query-cam-list-by-coordinate?lat=&lon=` — ⚠️ 回傳 **HTML widget（非 JSON）**，不適合後端聚合 |

> **採用策略（✅ 已確認）**：twipcam **沒有**「座標 + 半徑」的 JSON 查詢端點，座標端點僅回傳 HTML。因此後端採 **全台清單（`cam-list.json`）+ 本地 Haversine 過濾** 策略（見 §4.3.2、§8 Phase E-3）。

#### 4.3.2 請求方式（✅ 已確認）

後端只呼叫**全台清單端點**，再於本地過濾。無參數、無認證：

```http
GET https://www.twipcam.com/api/v1/cam-list.json
```

取得約 800+ 筆全台攝影機後，由後端：

1. 以 Haversine 計算各攝影機（`lat` / `lon`）與查詢座標的距離（公尺）。
2. 依 `radius`（§5.1 請求參數，公尺）過濾，距離升冪排序。
3. 取前 N 筆（`limit` 由後端固定上限，預設 5）。

> **twipcam 端點本身不接受 `radius` / `limit`**；半徑與筆數限制皆由後端套用。座標查詢端點 `query-cam-list-by-coordinate?lat=&lon=` 僅回傳 HTML widget，**不採用**。注意座標欄位 twipcam 使用 `lon`（非 `lng`）。

#### 4.3.3 欄位對應表（✅ 已對照 `cam-list.json` 實際回應）

實測單筆回應結構：

```json
{
  "id": "n2-w-1k-000",
  "lat": 25.0587,
  "lon": 121.2137,
  "name": "國道二號 1K+000 西向 大園交流道到桃園機場端",
  "cam_url": "https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=20100"
}
```

| twipcam 欄位     | 回應欄位            | 說明                                                                                                                                  |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `cctv.id`           | 攝影機識別碼（如 `n2-w-1k-000`、`tpe-000313`）                                                                                        |
| `name`           | `cctv.name`         | 地點描述（中文）                                                                                                                      |
| `lat`            | `cctv.location.lat` | 緯度                                                                                                                                  |
| `lon`            | `cctv.location.lng` | 經度（twipcam 欄位名為 `lon`，回應正規化為 `lng`）                                                                                    |
| `cam_url`        | `cctv.streamUrl`    | 影像來源 URL（國道為 MJPEG `abs2mjpg` 串流，可直接於 `<img>` 或播放器呈現）                                                           |
| （由 `id` 推導） | `cctv.snapshotUrl`  | twipcam 快照代理 `https://c01.twipcam.com/cam/snapshot/{id}.jpg`（⚠️ 待驗證：僅於座標 widget 觀察到市區攝影機適用，國道攝影機未驗證） |
| （計算值）       | `cctv.distanceM`    | 與查詢座標的距離（公尺），後端以 Haversine 計算                                                                                       |

> **無 `m3u8` / `RTSP` / `snapshot_url` 欄位**：實測 `cam-list.json` 僅提供單一 `cam_url`（MJPEG / 來源影像）；原規格假設的 `snapshot_url` / `stream_url` 欄位**不存在**。`snapshotUrl` 改由 `id` 推導 twipcam 快照代理 URL。

> **後端職責**：僅回傳影像 URL，**不**代理影像流量。串流渲染由前端處理（見第 11 節）。

#### 4.3.4 錯誤處理

| 情境           | 處理方式                                       |
| -------------- | ---------------------------------------------- |
| HTTP 4xx / 5xx | `nearbyCctv` 標記 `status: "unavailable"`      |
| 附近無監視器   | 回傳空陣列 `[]`，`status: "ok"`                |
| 逾時（> 5 秒） | 標記 `status: "unavailable"`，記錄 warning log |

> **分層**（§3.3）：HTTP 失敗 / 逾時由 `twipcam.adapter.ts`（經 `withResilience`）**throw**，「標 `unavailable`」是 service 政策。「附近無監視器 → 空陣列 + `status: "ok"`」屬**正常結果**（非降級）：adapter 正常回傳空清單，service 不特別處理。

---

## 5. API 規格

### 5.1 端點總覽

| Method | Path                       | 功能             | 狀態           |
| ------ | -------------------------- | ---------------- | -------------- |
| `GET`  | `/api/v1/a11y/environment` | 聚合環境資訊查詢 | ✅ Implemented |

### 5.2 聚合查詢端點

**端點**：`GET /api/v1/a11y/environment`

**認證**：公開端點，不需要 JWT。

**請求 Schema**（`environment.schema.ts`）

```typescript
const EnvironmentQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(100).max(2000).default(500), // 監視器搜尋半徑（公尺）
});
```

**請求範例**

```http
GET /api/v1/a11y/environment?lat=25.0478&lng=121.5318&radius=500
```

**成功回應（HTTP 200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "環境資訊查詢成功",
  "data": {
    "location": {
      "lat": 25.0478,
      "lng": 121.5318
    },
    "weather": {
      "status": "ok",
      "temperature": 31,
      "precipitationProbability": 20,
      "windSpeed": 3.2,
      "windDirection": "南風",
      "condition": "多雲時晴",
      "forecastTime": "2026-06-17T10:00:00+08:00"
    },
    "airQuality": {
      "status": "ok",
      "pm25": 18.5,
      "quality": "普通",
      "advice": "空氣品質尚可，敏感族群可考慮減少長時間戶外活動",
      "area": "大安區",
      "stationCoordinates": [121.5417, 25.026]
    },
    "nearbyCctv": {
      "status": "ok",
      "cameras": [
        {
          "id": "tpe-000313",
          "name": "台北市道路 313-松江路與長安東路口",
          "location": { "lat": 25.0501, "lng": 121.5333 },
          "distanceM": 340,
          "snapshotUrl": "https://c01.twipcam.com/cam/snapshot/tpe-000313.jpg",
          "streamUrl": "https://c01.twipcam.com/cam/snapshot/tpe-000313.jpg"
        },
        {
          "id": "tpe-000208",
          "name": "台北市道路 208-仁愛路四段（近大安森林公園）",
          "location": { "lat": 25.0338, "lng": 121.5347 },
          "distanceM": 480,
          "snapshotUrl": "https://c01.twipcam.com/cam/snapshot/tpe-000208.jpg",
          "streamUrl": null
        }
      ]
    }
  }
}
```

**部分降級回應（某來源失敗，HTTP 200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "環境資訊部分查詢成功（1 項來源不可用）",
  "data": {
    "location": { "lat": 25.0478, "lng": 121.5318 },
    "weather": {
      "status": "unavailable",
      "reason": "UPSTREAM_HTTP_ERROR"
    },
    "airQuality": {
      "status": "ok",
      "pm25": 18.5,
      "quality": "普通",
      "advice": "空氣品質尚可，敏感族群可考慮減少長時間戶外活動",
      "area": "大安區",
      "stationCoordinates": [121.5417, 25.026]
    },
    "nearbyCctv": {
      "status": "ok",
      "cameras": []
    }
  }
}
```

**錯誤回應（HTTP 400，參數驗證失敗）**

```json
{
  "ok": false,
  "status": "error",
  "code": 400,
  "message": "請求參數無效",
  "data": {
    "reason": "INVALID_PARAMS",
    "details": "lat 必須介於 -90 至 90 之間"
  }
}
```

### 5.3 狀態碼一覽

| HTTP 狀態碼 | Reason           | 說明                                  |
| ----------- | ---------------- | ------------------------------------- |
| `200`       | —                | 成功（含部分降級）                    |
| `400`       | `INVALID_PARAMS` | Zod 驗證失敗（lat/lng/radius 不合法） |
| `500`       | `INTERNAL_ERROR` | 非預期錯誤（所有外部呼叫皆無法降級）  |

### 5.4 `status` 欄位說明

各資料區塊（`weather` / `airQuality` / `nearbyCctv`）獨立攜帶 `status` 欄位：

| 值              | 含義                              |
| --------------- | --------------------------------- |
| `"ok"`          | 資料正常取得                      |
| `"unavailable"` | 外部 API 失敗或逾時，此區塊無資料 |

### 5.5 `reason` 代碼（常數，無 magic literal）

`status: "unavailable"` 時 `reason` 攜帶失敗分類。代碼為具名常數（`src/constants/environment.ts`），由 `withResilience`（§3.3 機制層）統一正規化後產生、service 原樣帶入該區塊——呼叫點不得內聯字面值：

| `reason`               | 含義                             | 適用來源 |
| ---------------------- | -------------------------------- | -------- |
| `UPSTREAM_TIMEOUT`     | 外部 API 逾時（> 5 秒）          | 任一來源 |
| `UPSTREAM_HTTP_ERROR`  | 外部 API 回 4xx / 5xx            | 任一來源 |
| `UPSTREAM_BAD_PAYLOAD` | 回應解析失敗 / 欄位缺漏          | 任一來源 |
| `CIRCUIT_OPEN`         | 斷路器開啟（連續失敗，暫停外呼） | 任一來源 |

> 取代先前範例內聯的 `"CWA_API_ERROR"`：`reason` 一律取自 `withResilience` 的統一分類（與來源無關，誰失敗就掛在哪個區塊），落實 §3.3「機制只寫一處」。

---

## 6. 快取策略

### 6.1 設計原則

各資料類型的更新頻率不同，採獨立 TTL 分層快取。快取層使用現有 `src/config/redis.ts`（ioredis）。

### 6.2 快取 TTL 表

| 資料類型                           | 快取 TTL | 理由                                            |
| ---------------------------------- | -------- | ----------------------------------------------- |
| **天氣**（CWA）                    | 20 分鐘  | 預報資料更新頻率低；20 分鐘對出發前決策已夠即時 |
| **空氣品質**（STA）                | 60 分鐘  | 測站每小時更新一次 PM2.5，TTL 與資料週期對齊    |
| **監視器清單**（twipcam 清單查詢） | 10 分鐘  | 攝影機列表變動少；列表快取，快照 URL 不儲存     |

### 6.3 快取 Key 設計

```
Key 格式：env:{type}:{lat_rounded}:{lng_rounded}

說明：
  - type       : "weather" | "air" | "cctv"
  - lat_rounded: 四捨五入至小數點後 3 位（約 111 公尺精度，減少快取碎片）
  - lng_rounded: 同上

範例：
  env:weather:25.048:121.532
  env:air:25.048:121.532
  env:cctv:all              ← 見下方說明
```

> **CCTV 例外（§4.3.2 已確認）**：twipcam 僅提供**全台單一清單** `cam-list.json`（與查詢座標無關），故 CCTV **不以座標分鍵**，而以單一 key `env:cctv:all` 快取整份清單（TTL 10 分鐘）。每次請求從快取讀全清單後於後端 Haversine 過濾，避免依座標重複抓取相同的 800+ 筆資料。天氣與空品仍維持座標分鍵。

### 6.4 快取讀寫流程

```
controller 接收請求
       ↓
environment.service 對三類資料各自執行：
  1. 嘗試讀取 Redis（GET env:{type}:{lat}:{lng}）
  2. 命中 → 直接回傳快取值
  3. 未命中 → 呼叫對應 adapter（adapter 經 withResilience 設 timeout / 斷路）
  4. 成功 → 寫入 Redis（SETEX，各自 TTL）
  5. adapter throw → service catch（allSettled）→ 不寫 Redis，該區塊回 { status: "unavailable" }
       ↓
三類資料並行（Promise.allSettled，互不阻塞）
       ↓
聚合結果後 sendResponse()
```

> **快取不寫入降級結果**：外部 API 失敗時不快取 `unavailable` 狀態，確保下次請求仍會重試外部 API。

### 6.5 Redis 不可用時的降級

若 Redis 連線失敗，`environment.service.ts` 捕捉錯誤後直接呼叫外部 API（無快取模式），不因 Redis 不可用而中斷服務。

---

## 7. 資料模型

本功能為純查詢端點，**不新增 MongoDB Collection**。

環境資料不持久化——每次請求由 Redis 快取或外部 API 即時取得，無需 MongoDB 儲存。

### 7.1 回應型別定義

```typescript
// src/modules/environment/environment.types.ts

type DataStatus = "ok" | "unavailable";

interface WeatherBlock {
  status: DataStatus;
  temperature?: number; // 氣溫（°C）
  precipitationProbability?: number; // 降雨機率（%，0–100）
  windSpeed?: number; // 風速（m/s）
  windDirection?: string; // 風向（中文）
  condition?: string; // 天氣描述
  forecastTime?: string; // ISO 8601，預報時段起始時間
  reason?: string; // 僅 status="unavailable" 時出現
}

interface AirQualityBlock {
  status: DataStatus;
  pm25?: number; // PM2.5 濃度（μg/m³）
  quality?: string; // 等級（良好 / 普通 / 對敏感族群不健康 / 不健康 / 非常不健康）
  advice?: string; // 健康建議文字
  area?: string | null; // 測站所在行政區
  stationCoordinates?: [number, number] | null; // [lng, lat]
  reason?: string;
}

interface CctvCamera {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  distanceM: number;
  snapshotUrl: string | null;
  streamUrl: string | null;
}

interface CctvBlock {
  status: DataStatus;
  cameras?: CctvCamera[];
  reason?: string;
}

interface EnvironmentData {
  location: { lat: number; lng: number };
  weather: WeatherBlock;
  airQuality: AirQualityBlock;
  nearbyCctv: CctvBlock;
}
```

---

## 8. 實作 Roadmap

### 8.1 Phase 總覽

| Phase                 | 功能                               | 優先度   | 依賴                  | 狀態              |
| --------------------- | ---------------------------------- | -------- | --------------------- | ----------------- |
| **Phase E-1**         | 聚合骨架 + 空品整合                | Critical | 現有 `air.service.ts` | ✅ 已實作         |
| **Phase E-2**         | CWA 天氣整合 + Redis 快取          | High     | `CWA_API_KEY`、Redis  | ✅ 已實作         |
| **Phase E-3**         | twipcam CCTV 整合                  | Medium   | twipcam API 確認      | ✅ 已實作         |
| **Phase E-4（選配）** | `getEnvironmentInfo` AI Agent Tool | Low      | Phase E-1 完成        | ⬜ 未實作（選配） |

---

### Phase E-1 — 聚合骨架 + 空品整合

**目標**：建立 `environment` 模組骨架，串接現有空品資料，完成端點與 Zod 驗證。

**新增檔案**：

```
src/config/
└── resilience.ts             # withResilience()：timeout / 斷路 / log / 例外正規化（機制層，§3.3）

src/modules/environment/
├── environment.controller.ts
├── environment.service.ts    # 政策層骨架：cache-aside + Promise.allSettled + 失敗→unavailable
├── environment.schema.ts     # Zod: lat / lng / radius
└── index.ts
```

**路由掛載**（本專案慣例：模組自建 `createXRouter()` 工廠 + 於 `app.ts` 單行掛載；**無** legacy `src/routes/`）：

```typescript
// environment.router.ts
export function createEnvironmentRouter() {
  const router = Router();
  router.get(
    "/environment",
    validateRequest({ query: EnvironmentQuerySchema }),
    getEnvironmentInfo,
  );
  return router;
}

// index.ts — 唯一註冊點
export { createEnvironmentRouter } from "./environment.router";

// src/app.ts — 與其他三個 a11y router 並列、單行掛載（公開端點，不掛 JWT middleware）
app.use("/api/v1/a11y", createEnvironmentRouter());
```

**驗收條件**：

- `GET /api/v1/a11y/environment?lat=25.0478&lng=121.5318` 回傳 `airQuality` 含 PM2.5 資料
- `weather` 與 `nearbyCctv` 回傳 `status: "unavailable"`（來源尚未整合）

---

### Phase E-2 — CWA 天氣整合 + Redis 快取

**目標**：串接 CWA 開放資料，加上三類資料的 Redis 快取層。

**新增檔案**：

```
src/adapters/
└── cwa.adapter.ts            # CWA HTTP I/O：兩段式抓取（089 → 縣市鄉鎮檔）回原始 payload；失敗則 throw（經 withResilience）

src/constants/
└── cwa-county-codes.ts       # 靜態「縣市名 → F-D0047 resource ID」對照表（22 筆；實作時置於 constants/，靜態資料表）

src/modules/environment/
└── environment.parse.ts      # 新增 parseWeather()：raw WeatherElement[] → 天氣欄位（§4.1.3）
```

**關鍵實作事項（方案 E′ 兩段式，**免** Google 反查）**——stage ①② 抓取（含就近比對）住 `cwa.adapter.ts`（失敗則 throw）、stage ③ 欄位正規化住 `environment.parse.ts`（純函式）、stage ④ 快取為 `environment.service.ts` 的 cache-aside 政策（§3.3）：

1. **Stage ① 定縣市**：呼叫 `GET /v1/rest/datastore/F-D0047-089`（全台 22 縣市代表點），以 Haversine 比較查詢座標與各 `Location` 的 `Latitude` / `Longitude`，取最近者的 `LocationName`（縣市）。
2. **Stage ② 定區**：以 Stage ① 縣市名查 `cwa-county-codes.ts` 取該縣市鄉鎮檔 resource ID → 呼叫該檔（可加 `ElementName=溫度,3小時降雨機率,風速,風向,天氣現象` 縮小 payload）→ 再 Haversine 取最近 `Location`（區）的 `WeatherElement`。
3. **欄位正規化（`environment.parse.ts`）**：依 §4.1.3 從 `WeatherElement[].Time[].ElementValue[0]` 取 `Temperature` / `ProbabilityOfPrecipitation` / `WindSpeed` / `WindDirection` / `Weather`（純轉換：adapter 回的原始 payload 進、domain 欄位出）。
4. **快取**：`089` 與各縣市鄉鎮檔分別以單一 key 快取（一次呼叫服務多查詢）；解析後天氣結果再依 §6.3 座標 key 快取，TTL 套用 §6.2（20 分鐘）。

**靜態縣市→ID 對照表（`cwa-county-codes.ts`，✅ 實打 API 驗證 2026-06-19，未來3天逐3小時版）**：

| ID            | 縣市   | ID            | 縣市   | ID            | 縣市   | ID            | 縣市   |
| ------------- | ------ | ------------- | ------ | ------------- | ------ | ------------- | ------ |
| `F-D0047-001` | 宜蘭縣 | `F-D0047-025` | 雲林縣 | `F-D0047-049` | 基隆市 | `F-D0047-073` | 臺中市 |
| `F-D0047-005` | 桃園市 | `F-D0047-029` | 嘉義縣 | `F-D0047-053` | 新竹市 | `F-D0047-077` | 臺南市 |
| `F-D0047-009` | 新竹縣 | `F-D0047-033` | 屏東縣 | `F-D0047-057` | 嘉義市 | `F-D0047-081` | 連江縣 |
| `F-D0047-013` | 苗栗縣 | `F-D0047-037` | 臺東縣 | `F-D0047-061` | 臺北市 | `F-D0047-085` | 金門縣 |
| `F-D0047-017` | 彰化縣 | `F-D0047-041` | 花蓮縣 | `F-D0047-065` | 高雄市 |               |        |
| `F-D0047-021` | 南投縣 | `F-D0047-045` | 澎湖縣 | `F-D0047-069` | 新北市 |               |        |

> 規律：未來3天逐3小時版每 4 號遞增（`001`→`085`）；全台聚合 = `089`。1 週逐12小時版為中間號（`003`、`007`…）+ 聚合 `091`。

**驗收條件**：

- 天氣區塊回傳 `temperature`、`condition`、`precipitationProbability`，且選用的「縣市 + 區」均為距查詢座標最近者
- 第一次查詢命中 CWA API；第二次相同座標命中 Redis（`forecastTime` 相同）

---

### Phase E-3 — twipcam CCTV 整合

**目標**：串接 twipcam，回傳查詢座標附近的監視器清單（含快照 URL）。

**新增檔案**：

```
src/adapters/
└── twipcam.adapter.ts    # twipcam cam-list.json HTTP I/O，回原始全台清單；失敗則 throw（經 withResilience）

src/modules/environment/
└── environment.parse.ts  # 擴充 parseCameras()：raw 清單 → Haversine 過濾 / 排序 / 取前 N + snapshotUrl 推導（§4.3.3）
```

**關鍵實作事項**：

1. **`twipcam.adapter.ts`（I/O）**：呼叫 `GET https://www.twipcam.com/api/v1/cam-list.json` 取得全台攝影機清單（無參數、無認證，§4.3.1），回原始陣列。
2. **`environment.parse.ts`（轉換）**：`parseCameras()` 以 `utils/geo.ts` Haversine 計算各攝影機與查詢座標的距離（公尺），依 `radius` 過濾、距離升冪排序，取前 N 筆。
3. **`environment.parse.ts`（轉換）**：對應欄位 `streamUrl` = `cam_url`、`snapshotUrl` = 由 `id` 推導（後端不代理影像內容）。
4. twipcam 為公開端點，**不需授權金鑰**。

> twipcam 端點與欄位已於 §4.3 對照實際回應確認；`snapshotUrl` 推導模式（`c01.twipcam.com/cam/snapshot/{id}.jpg`）仍待全站驗證。

**驗收條件**：

- `nearbyCctv.cameras` 回傳至少一筆，含 `snapshotUrl`
- `distanceM` 為正確計算值

---

### Phase E-4 — `getEnvironmentInfo` AI Agent Tool

**目標**：將聚合查詢包裝成第 8 個 AI Agent Tool，供 `/api/v1/ai/chat` 使用。

**在 `src/config/ai/tool.ts` 新增 Tool 宣告**：

```typescript
{
  type: "function",
  function: {
    name: "getEnvironmentInfo",
    description: "根據經緯度查詢目標地點的出發前環境資訊，包含即時天氣（氣溫、降雨、風速）、空氣品質（PM2.5）與附近監視器路況快照 URL。",
    parameters: {
      type: "object",
      properties: {
        latitude:  { type: "number", description: "目標地點緯度" },
        longitude: { type: "number", description: "目標地點經度" },
        radius:    { type: "number", description: "監視器搜尋半徑（公尺），預設 500" },
      },
      required: ["latitude", "longitude"],
    },
  },
},
```

**在 `src/modules/ai/agent-tools.ts` 新增執行函式**：

```typescript
export async function getEnvironmentInfo(args: {
  latitude: number;
  longitude: number;
  radius?: number;
}): Promise<string> {
  // 直接呼叫 environment.service.ts 的聚合函式
}
```

**`executeLocalTool` switch 新增 case**：

```typescript
case "getEnvironmentInfo":
  return getEnvironmentInfo({
    latitude: args.latitude,
    longitude: args.longitude,
    radius: args.radius,
  });
```

> **備注**：本 Phase 為選配，須等 Phase E-1 至 E-3 穩定後再評估。

---

## 9. 測試策略

### 9.1 手動測試案例

| 測試案例                 | 輸入                                  | 預期                                            |
| ------------------------ | ------------------------------------- | ----------------------------------------------- |
| 正常查詢                 | `lat=25.0478&lng=121.5318&radius=500` | 三區塊均有資料（status: "ok"）                  |
| 空品資料                 | 同上                                  | `airQuality.pm25` 為數值，`quality` 為中文等級  |
| 無 CCTV 覆蓋區域         | 偏遠地點座標                          | `nearbyCctv.cameras` 為空陣列，status: "ok"     |
| CWA API 停用（移除 key） | 正常座標                              | `weather.status: "unavailable"`，其餘區塊正常   |
| 無效座標                 | `lat=999&lng=0`                       | HTTP 400，reason: "INVALID_PARAMS"              |
| Redis 快取命中           | 相同座標連續查詢兩次                  | 第二次回應與第一次 `forecastTime` / `pm25` 相同 |

### 9.2 驗證重點

- `Promise.allSettled` 並行查詢：任一外部 API 拋例外不影響其他區塊
- Redis 快取寫入確認：TTL 與 §6.2 一致（`TTL env:weather:*` ≈ 1200 秒）
- 降級標記正確：失敗區塊有 `status: "unavailable"`，`reason` 非空
- 距離計算正確性：`distanceM` 誤差 < 50 公尺（Haversine vs 實際距離）
- 回應 envelope 符合 `sendResponse()` 格式（含 `ok`、`status`、`code`、`message`、`data`）

---

## 10. 新增環境變數

| 變數          | 用途                            | 必要性                | 使用位置         |
| ------------- | ------------------------------- | --------------------- | ---------------- |
| `CWA_API_KEY` | 中央氣象署開放資料 API 授權金鑰 | **必要**（Phase E-2） | `cwa.adapter.ts` |

> **說明**：
>
> - 空品資料使用現有 STA API（`sta.ci.taiwan.gov.tw`），為公開端點，不需新增金鑰。
> - twipcam（CCTV）端點亦為公開存取（✅ 已確認），**不需** `TWIPCAM_API_KEY`，故不新增此變數。

---

## 11. 前端職責邊界

### 11.1 前端負責

| 職責               | 說明                                               |
| ------------------ | -------------------------------------------------- |
| 天氣圖示與 UI 呈現 | 依 `condition` 文字顯示天氣 icon（晴 / 雨 / 陰…）  |
| 空品等級顏色標示   | 依 `quality` 欄位對應顏色（良好=綠、不健康=紅…）   |
| CCTV 快照圖片顯示  | 以 `snapshotUrl` 顯示靜態快照（`<img>` 標籤）      |
| CCTV 影像串流播放  | 以 `streamUrl` 播放即時串流（m3u8 / HLS 播放器）   |
| 提醒通知推播       | 依天氣 / 空品資料決定是否顯示提醒（前端邏輯）      |
| 降級 UI 處理       | `status: "unavailable"` 時顯示「資料暫時無法取得」 |

### 11.2 前端不負責（後端處理）

| 禁止事項                  | 原因                                         |
| ------------------------- | -------------------------------------------- |
| 直接呼叫 CWA API          | API Key 安全性，由後端代理                   |
| 直接呼叫 twipcam API      | API Key 安全性，由後端代理                   |
| 直接呼叫 STA 空品 API     | 後端統一封裝，前端不持有外部端點             |
| 代理 / 轉發 CCTV 影像串流 | 後端只提供 URL，串流由前端播放器直連 twipcam |
| 快取管理                  | Redis 由後端管理                             |
| 距離計算                  | 後端計算 `distanceM` 後回傳                  |

---

## 12. 風險與緩解

| 風險                                          | 影響                                                           | 緩解策略                                                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **twipcam 僅有全台清單端點、無座標查詢 JSON** | 每次未命中快取需處理 ~800 筆全台資料                           | 全台清單長時間快取（§6）；後端 Haversine 過濾半徑後僅回傳鄰近數筆（§4.3.2 已確認）                                                                                                                                      |
| **`snapshotUrl` 推導模式未全站驗證**          | 部分攝影機（如國道）快照 URL 可能 404                          | 僅於 widget 觀察到市區攝影機適用；前端圖片載入失敗時顯示 placeholder；Phase E-3 實作前抽樣驗證各類 `id`                                                                                                                 |
| **天氣需兩段呼叫（縣市→區）**                 | 未命中快取時 stage ①②各一次 CWA 呼叫，延遲較高                 | `089` 與各縣市鄉鎮檔分別快取（§6.2 20 分鐘）；多數查詢命中快取後 0 次外呼                                                                                                                                               |
| **縣市→ID 靜態表偏移風險**                    | CWA 若調整 resource ID 編號，對照表失準                        | 表已實打 API 驗證（22 筆，每 4 號遞增）；以 `LocationsName` 驗證對應、加單元測試比對；CWA 改版時重跑掃描腳本                                                                                                            |
| **CWA 新版 API 參數為 PascalCase**            | 用小寫 `locationName`/`elementName` 會被靜默忽略、payload 暴增 | 一律用 `ElementName`/`LocationName`（大寫）；stage ② 以 `ElementName` 限縮元素                                                                                                                                          |
| **外部 API 速率上限**                         | CWA 免費方案 10 萬次/日，twipcam 不明                          | Redis 快取攔截重複查詢（§6）；監控每日 API 呼叫量                                                                                                                                                                       |
| **STA 感測器離查詢點遠（>5km）**              | 空品資料代表性不足                                             | **本期不做**最近點補償（`$near`）——此屬第三方**資料品質**而非**可用性**問題，不在本聚合端點職責內（§3.3：可用性才降級，品質補償不做）；維持現有縣市層級 `getAirData()`，由前端以 `area`（測站區域）標示讓使用者自行判讀 |
| **Redis 無快取時三個外部 API 並行**           | 首次查詢回應時間可能 > 3 秒                                    | `Promise.allSettled` 並行執行（非串行）；各 API 設 5 秒 timeout；前端顯示 loading 狀態                                                                                                                                  |
| **CCTV 快照/串流 URL 過期**                   | 快取 10 分鐘內 URL 可能失效                                    | twipcam 快照 URL 通常有效期較短，前端圖片載入失敗時顯示 placeholder；串流 URL 失效後前端 reload                                                                                                                         |

---

_文件版本 v1.0.5 — **Phase E-1 ~ E-3 落地**：依本規格實作 `GET /api/v1/a11y/environment` 並通過 `npm run build` + 69 筆 vitest 與真實外部 API 煙霧測試（air STA 真資料、twipcam 真資料過濾最近 5 筆、無 `CWA_API_KEY` 時 weather 正確降級為 `UPSTREAM_HTTP_ERROR`）。落地差異：①「縣市→ID」對照表置於 `src/constants/cwa-county-codes.ts`（非 §8 原寫的 `adapters/`；靜態資料表本應於 constants）；② `withResilience` 以 `Promise.race([fn, timeout])` 實作 5 秒上限，因重用的 `getAirData()` 不接受 `AbortSignal`，純靠 `AbortController` 無法保證逾時；③ air「無感測器」（`getAirData` 回 `null`）→ `{status:"unavailable"}` **不帶** `reason`（屬資料缺口非上游失敗），僅真失敗帶 `reason`。快取 key（前綴皆 `env:`）：`env:weather:{lat3}:{lng3}`、`env:air:{lat3}:{lng3}`（service 存 parsed block）、`env:cwa:raw:{resourceId}` 與 `env:cctv:all`（adapter 存原始 payload），僅快取成功結果。Phase E-4（AI Agent Tool）依規格仍為選配、未實作。以下 v1.0.4 內容不變。_

_文件版本 v1.0.4 — **架構分層重構**：外部 I/O（CWA / twipcam）移至 `src/adapters/`（`cwa.adapter.ts` / `twipcam.adapter.ts`），降級拆為「機制」（`config/resilience.ts` 的 `withResilience`，與 `tdxFetch` 同層）與「政策」（`environment.service.ts` 的 `allSettled` + 失敗→unavailable）兩層；adapter 失敗一律 **throw**、永不呼叫 service，依賴方向單向 `service → adapter → config(infra)`（§3.2 / §3.3）。STA `$near` 最近點補償判定為**品質補償**、本期不做（§12）。同時對齊本專案 clean architecture：補 `environment.router.ts` + `createEnvironmentRouter()` 工廠、改於 `app.ts` 單行掛載（移除過時的 `src/routes/a11y.route.ts` + `validate()` 寫法）、`reason` 代碼與外部 URL / TTL 收斂至 `src/constants/environment.ts`（無 magic literal）；上游解析自 adapter 抽出為獨立的 `environment.parse.ts`（adapter 純 I/O 回原始 payload、parse 做 raw→domain 轉換、共用 `utils/geo.ts` Haversine）（§3.2 / §3.3 / §5.5 / §8）。以下 v1.0.3 內容不變。_

_文件版本 v1.0.3 — 天氣資料**實打 CWA API 驗證後**改採**方案 E′（兩段式）**：`F-D0047-089`（22 縣市點）Haversine 定縣市 → 靜態 22 筆「縣市→ID」表抓該縣市鄉鎮檔 → Haversine 定區，免 Google 反查（§4.1、§8 Phase E-2、§12）。原方案 E 的單一全台鄉鎮檔 `F-D0047-093` 經實測為 404、且全台檔僅 22 縣市點，已否決。同時校正：座標欄位 `Latitude`/`Longitude`、元素為中文 `ElementName`（值在 `Time[].ElementValue[0]`）、過濾參數為 PascalCase。twipcam API（§4.3）採全台清單 + 本地 Haversine、不需金鑰、欄位 `lon`/`cam_url`（已對照 `cam-list.json`）。本規格仍為 Proposed；待抽樣驗證 `snapshotUrl` 推導模式（§4.3.3）。_
