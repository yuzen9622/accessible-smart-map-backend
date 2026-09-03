# 家屬開車路況查詢系統

## Functional Specification — Driving Traffic & Parking for Family Caregivers

**版本**：v1.1.0  
**狀態**：Implemented — 已實作完成  
**日期**：2026-09-03  
**作者**：yuzen9622

> **v1.1.0 變更**
>
> 1. **新增即時車流視覺化**（核心目標）：新增 `GET /api/v1/traffic/flow` 端點，回傳 **GeoJSON FeatureCollection** 形式的道路路段，每段附帶壅塞等級與色碼，供前端在地圖上以紅／黃／綠著色（等同 Google Maps 即時路況圖層）。資料源為 TDX 即時路況（Section 即時 + SectionShape 線型）。
> 2. **Fetch 封裝改為 Adapter**：對齊既有 `src/adapters/*.adapter.ts` 慣例，TISV 高公局 fetch 封裝為 `src/adapters/tisv.adapter.ts`；停車場與即時車流沿用既有 `src/adapters/tdx.adapter.ts`（`tdxTokenManager` + `tdxFetch()`），不另開 OAuth adapter。

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

### 1.1 功能定位

本功能面向**開車的家屬**，協助其在接送行動不便者（輪椅使用者、長者、視障者）時，預先掌握行車路況、停車位可用性與沿途測速照相位置，降低因塞車或繞行造成的被接送者等待困境。

**核心目標：即時車流視覺化。** 本功能最主要的能力，是讓駕駛人在地圖上「看到當前車流」——將每條道路路段依即時壅塞程度著色（順暢=綠、車多=黃、壅塞=紅、嚴重壅塞=深紅），如同 Google Maps 的即時路況圖層。後端負責把「路段線型（geometry）＋ 即時壅塞等級」打包成前端可直接繪製的 **GeoJSON**，前端只需把每段塗上後端給的色碼即可。停車場、測速照相、國道旅行時間為輔助資訊。

### 1.2 Scope 邊界（重要）

| 項目       | 本功能                                             | 無障礙核心路由                |
| ---------- | -------------------------------------------------- | ----------------------------- |
| 服務對象   | **開車的家屬**（駕駛人）                           | 輪椅 / 長者 / 視障使用者本人  |
| 查詢模式   | 自駕路況、停車場車位、測速照相                     | 大眾運輸、步行、無障礙路徑    |
| 資料來源   | TISV 高公局、traffic.transportdata.tw、data.gov.tw | TDX、GTFS、ORS、OSM           |
| 無障礙評分 | **不涉及**（無 a11y scoring）                      | 核心職責（`a11y-scoring.ts`） |
| 路由引擎   | 無（僅資訊查詢，不計算駕車路徑）                   | ORS + OTP2 + TDX MaaS         |

> **本功能為輔助性、資訊查詢性質，與行人無障礙核心路由完全分離，不影響無障礙路徑評分、不共用 a11y 相關資料模型。**

### 1.3 整合外部來源概覽

| 來源                                                        | 用途                                                                                    | 更新頻率                   | 授權                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| **TDX 即時路況**（`tdx.transportdata.tw` → `Road/Traffic`） | **市區即時車流著色**（Section 即時壅塞 + SectionShape 路段線型 + CongestionLevel 定義） | 1–3 分鐘（線型圖資準靜態） | 透過 TDX OAuth（沿用 `src/adapters/tdx.adapter.ts`） |
| **TDX 停車場**（`tdx.transportdata.tw` → `Parking`）        | 停車場即時車位                                                                          | 1–3 分鐘                   | 透過 TDX OAuth（沿用 `tdxFetch()`）                  |
| **TISV 高公局** (`tisvcloud.freeway.gov.tw`)                | 國道 eTag 旅行時間、VD 車流、交通事件、CCTV                                             | 1–5 分鐘                   | 公開，無需金鑰                                       |
| **data.gov.tw 測速照相** (`dataset/7320`)                   | 固定式測速照相位置（靜態）                                                              | 不定期（月/季更新）        | 公開，無需金鑰                                       |

---

## 2. 系統目標

### 2.1 核心能力

- **即時車流地圖視覺化（核心）**：依地圖可視範圍（bbox）回傳道路路段的即時壅塞著色資料，以 GeoJSON FeatureCollection 形式輸出，每段附 `congestionLevel` 與 `color`，前端可直接繪製紅／黃／綠路況圖層
- 查詢目的地附近停車場的即時剩餘車位（支援地理搜尋）
- 查詢路線沿途或指定區域的固定式測速照相位置
- 查詢國道指定路段的 eTag 旅行時間與壅塞程度（國道補充資訊）
- 提供聚合查詢介面，一次回傳行車所需的多項資訊

### 2.2 非功能目標

| 目標             | 說明                                                     |
| ---------------- | -------------------------------------------------------- |
| 與無障礙核心分離 | 不引用 `a11y-scoring.ts`、`accessible-route.service.ts`  |
| TDX 配額保護     | 停車場即時資料以 Redis 短 TTL 快取，避免連續呼叫觸發 429 |
| 靜態資料預匯入   | 測速照相以匯入腳本寫入 MongoDB，零查詢時外部呼叫         |
| Fail-soft 降級   | 某資料來源失敗仍部分回傳，不因單一來源壞掉導致整體 500   |
| 統一回應格式     | 所有端點沿用 `sendResponse()` 包裝格式                   |

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
Traffic Route Controller (src/modules/traffic/)
      ↓
┌─────────────────────────────────────────────┐
│            Traffic Service (聚合層)           │
│      src/modules/traffic/traffic.service.ts   │
│                                               │
│  ┌──────────────────────────────────────────┐│
│  │  Traffic Flow Service（核心：車流著色）   ││
│  │  Section 即時 × SectionShape 線型 → GeoJSON││
│  └──────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────┐│
│  │  Parking Service（即時停車場車位）         ││
│  └──────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────┐│
│  │  Speed Camera Service（MongoDB 2dsphere）  ││
│  └──────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────┐│
│  │  Freeway Service（國道 eTag 旅行時間）     ││
│  └──────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
      ↓ (services 只呼叫 adapter，不直接 fetch)
┌─────────────────────────────────────────────┐
│              Adapter 層 (src/adapters/)       │
│  ┌─────────────────────┐ ┌──────────────────┐ │
│  │ tdx.adapter.ts      │ │ tisv.adapter.ts  │ │
│  │ tdxTokenManager     │ │ tisvFetch()      │ │
│  │ + tdxFetch()        │ │ (公開, 無 OAuth)  │ │
│  │ → 車流/停車場        │ │ → 國道           │ │
│  └─────────────────────┘ └──────────────────┘ │
└─────────────────────────────────────────────┘
      ↓                ↓
  Redis 快取層     MongoDB (TrafficSection / SpeedCamera)
      ↓
ApiResponse<TrafficData>  (GeoJSON / JSON via sendResponse())
```

> **Adapter 邊界原則**：所有對外部服務的 HTTP 封裝（auth、timeout、retry）一律放在 `src/adapters/*.adapter.ts`；`*.service.ts` 只負責「呼叫 adapter → 轉換 / 聚合 / 快取」，不得直接 `fetch()` 外部 URL。此慣例對齊現有 `src/adapters/google.adapter.ts`、`src/adapters/tdx.adapter.ts`。

### 3.2 模組目錄結構

```
src/
├── adapters/                        # 既有 adapter 層（外部服務 HTTP 邊界）
│   ├── google.adapter.ts            # （既有）
│   ├── tdx.adapter.ts               # （既有）tdxTokenManager — 停車場/車流沿用
│   └── tisv.adapter.ts              # 新增：TISV 高公局 fetch 封裝（無 OAuth）
├── modules/
│   └── traffic/
│       ├── traffic.controller.ts    # 路由 handler
│       ├── traffic.router.ts        # /api/v1/traffic/*
│       ├── traffic.schema.ts        # Zod 驗證 schema
│       ├── traffic.service.ts       # 聚合邏輯
│       ├── traffic-flow.service.ts  # 核心：Section 即時 × SectionShape → GeoJSON 著色
│       ├── parking.service.ts       # TDX 停車場（呼叫 tdxFetch）
│       ├── speed-camera.service.ts  # SpeedCamera model 查詢
│       └── freeway.service.ts       # 國道 eTag（呼叫 tisv.adapter）
├── model/
│   ├── traffic-section.model.ts     # 新增：路段線型（GeoJSON LineString，2dsphere）
│   └── speed-camera.model.ts        # 新增靜態資料模型（2dsphere）
└── scripts/
    ├── import-traffic-sections.ts   # 新增：TDX SectionShape → MongoDB（WKT→GeoJSON）
    └── import-speed-cameras.ts      # 靜態資料匯入腳本
```

> `fetch.ts` 內既有的 `tdxFetch()` 已 `import { tdxTokenManager } from "../adapters/tdx.adapter"`，本功能不重複實作 TDX 認證；新增的 `tisv.adapter.ts` 僅為 TISV 公開端點補一個對應的封裝點。

### 3.3 路由掛載

```typescript
// src/app.ts（新增一行）
import trafficRouter from "./modules/traffic/traffic.router";
app.use("/api/v1/traffic", trafficRouter);
```

新路由群組 `/api/v1/traffic` 為**公開端點**，不經過 JWT middleware（與 `/api/transit` 一致）。

---

## 4. 外部資料來源整合

### 4.1 TISV 高公局（tisvcloud.freeway.gov.tw）

#### 基本資訊

| 項目     | 說明                                                        |
| -------- | ----------------------------------------------------------- |
| Base URL | `https://tisvcloud.freeway.gov.tw/history/TDCS/`            |
| 授權     | 公開，無需金鑰                                              |
| 格式     | **CSV（無表頭，逗號分隔）** — TDCS ETC 資料皆為 CSV，非 XML |
| 更新頻率 | 每 5 分鐘（每個 5 分鐘級距產生一檔，發布有數分鐘延遲）      |

#### 使用端點（TDCS ETC 動態資料）

| 代碼     | 功能                       | 說明                                                                       |
| -------- | -------------------------- | -------------------------------------------------------------------------- |
| **M03A** | 各門架車種別交通量         | 每 5 分鐘、單一門架（Gantry）之車種別流量                                  |
| **M04A** | 配對路段車種別**旅行時間** | 每 5 分鐘、起迄門架配對之旅行時間（秒）                                    |
| **M05A** | 配對路段車種別**平均速率** | 每 5 分鐘、起迄門架配對之空間平均速率（km/h）——**車流著色/壅塞推導用此檔** |

> ✅ **已確認（2026-06-19 實測線上目錄與檔案）**：精確 URL 格式為
> `https://tisvcloud.freeway.gov.tw/history/TDCS/M05A/{YYYYMMDD}/{HH}/TDCS_M05A_{YYYYMMDD}_{HHMMSS}.csv`
>
> - 檔名含 `TDCS_M05A_` 前綴、日期與時間以底線分隔、副檔名為 **`.csv`**（非 `.xml`）。
> - `{HHMMSS}` 一律對齊 5 分鐘邊界、秒固定 `00`（如 `080000`、`080500`…`085500`），每小時 12 檔。
> - 例：`.../M05A/20260619/08/TDCS_M05A_20260619_083000.csv`（實測存在，約 95 KB）。
> - **後端須自行計算最近一份有效時間戳**（此點原規格正確）：取「現在時間 floor 到 5 分鐘」組 URL；因發布延遲（實測 08:55 檔約 08:57 才出現），抓不到（404）時往前回退一個 5 分鐘級距，最多重試 2–3 次。
> - M03A/M04A 同樹同規則，僅代碼不同。歷史亦提供每日壓縮檔 `M05A_{YYYYMMDD}.tar.gz`（批次回補用，非即時）。

#### Fetch 封裝 → Adapter（`src/adapters/tisv.adapter.ts`）

TISV 不使用 TDX OAuth，但仍須**對齊既有 adapter 慣例**——外部 HTTP 邊界一律放 `src/adapters/`，不在 `*.service.ts` 內直接 `fetch()`。對照既有 `google.adapter.ts`（Google Maps）、`tdx.adapter.ts`（TDX token）：

```typescript
// src/adapters/tisv.adapter.ts
//
// TISV 高公局 TDCS 為公開端點、不需 OAuth；此 adapter 負責「計算最近 5 分鐘檔 URL
// → fetch → 404 時回退一個級距重試 → 回傳原始 CSV 字串」，freeway.service.ts 只負責解析。

const TISV_TIMEOUT_MS = () => Number(process.env.TISV_TIMEOUT_MS || 8000);
const TISV_BASE = "https://tisvcloud.freeway.gov.tw/history/TDCS";

/**
 * 取得 TISV TDCS 端點的原始 CSV 字串（無表頭，由呼叫端解析）。
 *
 * @param url 完整 TDCS 檔案 URL
 * @returns CSV 內容字串
 * @throws 當 HTTP 狀態非 2xx 或逾時
 */
export async function tisvFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: "text/csv,text/plain" },
    signal: AbortSignal.timeout(TISV_TIMEOUT_MS()),
  });
  if (!res.ok) throw new Error(`TISV ${res.status}`);
  return res.text();
}

/**
 * 抓取最近一份有效的 M05A 5 分鐘檔；最新檔尚未發布時往前回退級距。
 *
 * @param now 參考時間（預設現在）
 * @param maxBack 最多往前回退幾個 5 分鐘級距
 * @returns 原始 CSV 字串（找不到則 throw）
 */
export async function fetchLatestM05A(
  now = new Date(),
  maxBack = 3,
): Promise<string> {
  for (let i = 0; i <= maxBack; i++) {
    const t = new Date(now.getTime() - i * 5 * 60_000);
    t.setMinutes(Math.floor(t.getMinutes() / 5) * 5, 0, 0); // floor 到 5 分鐘邊界
    const YYYYMMDD = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`;
    const HH = pad(t.getHours());
    const HHMMSS = `${HH}${pad(t.getMinutes())}00`;
    const url = `${TISV_BASE}/M05A/${YYYYMMDD}/${HH}/TDCS_M05A_${YYYYMMDD}_${HHMMSS}.csv`;
    try {
      return await tisvFetch(url);
    } catch {
      /* 404/逾時 → 試前一個級距 */
    }
  }
  throw new Error("TISV M05A 最近檔不可得");
}
// 注意：時間以 Asia/Taipei 為準（沿用 src/config/taipei-time.ts），勿用 UTC 算 floor。
```

```typescript
// src/modules/traffic/freeway.service.ts
import { fetchLatestM05A } from "../../adapters/tisv.adapter";
// service 僅負責：取 CSV → 逐列 split(",") → 過濾車種 → 速率→壅塞推導 → 門架對照補名稱 → Redis 快取
```

> **停車場與即時車流不另開 adapter**：兩者皆走 TDX，沿用既有 `src/adapters/tdx.adapter.ts` 的 `tdxTokenManager` 與 `src/config/fetch.ts` 的 `tdxFetch()`（已內建 401 刷新、429 退避重試）。

CSV 為**無表頭、6 欄、逗號分隔**，逐列 `split(",")` 即可（與既有 import 腳本的 CSV 處理一致），不需 XML parser。

#### 欄位對應（M05A — 實測確認）

M05A 每列 6 欄、**無表頭**，為「起迄門架配對 × 車種」的平均速率。實測樣本：

```
2026/06/19 08:30,01F0017N,01F0005N,31,92,47
```

| 第幾欄 | TISV 欄位        | 後端欄位      | 說明                                                                      |
| :----: | ---------------- | ------------- | ------------------------------------------------------------------------- |
|   1    | `TimeInterval`   | `updatedAt`   | 級距起始時間，格式 `YYYY/MM/DD HH:MM`（**非 ISO**，需轉換）               |
|   2    | `GantryFrom`     | `gantryFrom`  | 起始門架代碼（如 `01F0017N`：國道1號+里程+方向 N/S）                      |
|   3    | `GantryTo`       | `gantryTo`    | 迄止門架代碼                                                              |
|   4    | `VehicleType`    | `vehicleType` | 車種：`31` 小客車 / `32` 小貨車 / `41` 大客車 / `42` 大貨車 / `5` 聯結車  |
|   5    | `SpaceMeanSpeed` | `speedKmh`    | 空間平均速率（km/h）；**`0` = 該車種該級距無車流/無資料**（非真的塞到 0） |
|   6    | `Traffic`        | `sampleCount` | 該配對該車種的車流/樣本數（可作可信度判斷）                               |

> **重要落差（原規格的欄位對應不成立）**：M05A **沒有** `SectionID` / `SectionName` / `TravelTime` / `Congestion` 欄位。因此：
>
> - **路段名稱與座標** → M05A 只有門架代碼，需另備**門架靜態對照表**（高公局 ETag 門架座標/里程資料）把 `GantryFrom`/`GantryTo` 映成路段名與經緯度。
> - **旅行時間** → 取自 **M04A**（非 M05A）。
> - **壅塞等級** → **由 `SpaceMeanSpeed` 推導**（建議只取 `VehicleType=31` 小客車那列，速率帶見 §5.3），並排除 `speedKmh=0`（無資料）誤判為嚴重壅塞。
>
> ⚠️ **待確認**：門架對照表的來源與更新方式（建議比照測速照相/路段線型，預匯入 MongoDB）。

---

### 4.2 TDX 停車場（traffic.transportdata.tw）

#### 基本資訊

| 項目     | 說明                                                                |
| -------- | ------------------------------------------------------------------- |
| Base URL | `https://tdx.transportdata.tw/api/basic/v1/Parking/`                |
| 授權     | TDX OAuth2 — **沿用** `tdxFetch()` + `TdxTokenManger`（無需新憑證） |
| 格式     | JSON                                                                |
| 更新頻率 | 即時（1–3 分鐘）                                                    |

> ⚠️ **TDX 配額警示**：停車場即時 API 每次查詢計入 TDX 額度。規格要求所有呼叫走 Redis TTL 2 分鐘快取，嚴禁前端高頻輪詢直接穿透後端至 TDX。

#### 使用端點

| 端點                                                       | 功能                           |
| ---------------------------------------------------------- | ------------------------------ |
| `GET /api/basic/v1/Parking/OffStreet/CarPark`              | 路外停車場清單（靜態基本資訊） |
| `GET /api/basic/v1/Parking/OffStreet/CarPark/Availability` | 路外停車場即時剩餘車位         |

#### 欄位對應

| TDX 欄位                      | 後端欄位                  | 說明           |
| ----------------------------- | ------------------------- | -------------- |
| `CarParkID`                   | `carParkId`               | 停車場代碼     |
| `CarParkName.Zh_tw`           | `name`                    | 停車場中文名稱 |
| `CarParkPosition.PositionLat` | `location.coordinates[1]` | 緯度           |
| `CarParkPosition.PositionLon` | `location.coordinates[0]` | 經度           |
| `SpaceFor.CarSpace`           | `totalSpaces`             | 總車位數       |
| `AvailableSpaces`             | `availableSpaces`         | 即時剩餘車位   |
| `UpdateTime`                  | `updatedAt`               | 資料更新時間   |

---

### 4.3 data.gov.tw 測速照相（dataset/7320）

#### 基本資訊

| 項目       | 說明                                                            |
| ---------- | --------------------------------------------------------------- |
| 資料集 URL | `https://data.gov.tw/dataset/7320`                              |
| 格式       | CSV                                                             |
| 授權       | 政府資料開放授權條款 v1.0（公開，無需金鑰）                     |
| 更新頻率   | **靜態**（不定期，月 / 季更新）                                 |
| 匯入策略   | 預匯入至 `SpeedCamera` collection（2dsphere），查詢時零外部呼叫 |

#### 匯入腳本

```bash
npx ts-node src/scripts/import-speed-cameras.ts
```

腳本流程：

1. 從 data.gov.tw 下載最新 CSV 檔（或手動放置於 `data/speed-cameras/speed_cameras.csv`）
2. 解析 CSV，欄位對應見 §7.1
3. 批次 `bulkWrite`（每批 500 筆），以 `cameraId` upsert
4. 輸出：匯入筆數 / 耗時 / 錯誤數

---

### 4.4 TDX 即時路況（Road/Traffic）— 車流著色核心資料源

即時車流著色由 TDX「即時路況資料標準 v2.0」的三組資料拼成：**路段線型（幾何）＋ 即時壅塞（速率/等級）＋ 壅塞等級定義**。三者皆走既有 TDX OAuth（`tdxFetch()`）。

#### 基本資訊

| 項目     | 說明                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| Base URL | `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/`                    |
| 授權     | TDX OAuth2 — 沿用 `src/adapters/tdx.adapter.ts` + `tdxFetch()`（無需新憑證） |
| 格式     | JSON（OData）                                                                |
| 更新頻率 | 即時 Section 1–3 分鐘；SectionShape 線型準靜態（道路變更才異動）             |

#### 使用端點（皆支援 `?$format=JSON`、`?$top`、`?$filter`）

| 端點                                               | 功能                                   | 性質                                       |
| -------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| `GET /v2/Road/Traffic/Live/Section/City/{City}`    | 路段**即時**旅行時間、速率、壅塞等級   | 即時（短 TTL 快取）                        |
| `GET /v2/Road/Traffic/SectionShape/City/{City}`    | 路段**線型幾何**（道路名稱、WKT 線段） | 準靜態（預匯入 MongoDB）                   |
| `GET /v2/Road/Traffic/CongestionLevel/City/{City}` | 各路段**壅塞等級的速率門檻定義**       | 準靜態（長 TTL 快取，用於補 label/速率帶） |

> `{City}` 採 TDX 英文市名（`Taipei`、`NewTaipei`、`Taichung`…）。可沿用 `src/adapters/google.adapter.ts` 的 `getCity(lat,lng)` 由座標反查市名（與 `air` 模組一致）。實際路徑大小寫與 `City` vs `Freeway` 分流需以 TDX Swagger 核對。

#### 欄位對應 — Live Section（即時）

| TDX 欄位          | 後端欄位          | 說明                                        |
| ----------------- | ----------------- | ------------------------------------------- |
| `SectionID`       | `sectionId`       | 路段代碼（**與 SectionShape 的 join key**） |
| `TravelTime`      | `travelTimeSec`   | 路段旅行時間（秒）                          |
| `TravelSpeed`     | `speedKmh`        | 路段平均速率（km/h）                        |
| `CongestionLevel` | `congestionLevel` | 壅塞等級代碼（見下表；`0`/缺值＝無資料）    |
| `DataCollectTime` | `updatedAt`       | 資料蒐集時間（ISO 8601）                    |

#### 欄位對應 — SectionShape（線型幾何）

| TDX 欄位    | 後端欄位    | 說明                                                                                |
| ----------- | ----------- | ----------------------------------------------------------------------------------- |
| `SectionID` | `sectionId` | 路段代碼                                                                            |
| `RoadName`  | `roadName`  | 道路名稱（如「市民大道」）                                                          |
| `RoadClass` | `roadClass` | 道路等級（國道/省道/市區道路…）                                                     |
| `Geometry`  | `geometry`  | **WKT 字串**（`LINESTRING(...)` / `MULTILINESTRING(...)`，WGS84）→ 匯入時轉 GeoJSON |

> **WKT → GeoJSON**：TDX 圖資以 WKT 字串提供。匯入腳本以輕量套件（建議 `wellknown`，零依賴）轉成 GeoJSON `LineString` / `MultiLineString` 存入 MongoDB；**執行期不重複解析 WKT**，前端直接拿 GeoJSON。

#### 壅塞等級（CongestionLevel）對應與色碼 — 著色的核心

這張表是「Google Maps 紅綠路況」的後端定義。後端把每段的 `congestionLevel` 直接對應到一個 `color`（hex），前端可直接套用，也可自行改色：

| `congestionLevel` | `congestionLabel` | 典型速率（依 CongestionLevel 端點定義） | `color`（後端給的色碼） | 對應 Google Maps   |
| :---------------: | ----------------- | --------------------------------------- | :---------------------: | ------------------ |
|        `1`        | 順暢              | 高速                                    |     `#22C55E`（綠）     | 綠色               |
|        `2`        | 車多              | 中速                                    |   `#F59E0B`（黃/橘）    | 橘黃               |
|        `3`        | 壅塞              | 低速                                    |     `#EF4444`（紅）     | 紅色               |
|        `4`        | 嚴重壅塞          | 極低速/接近停滯                         |    `#991B1B`（深紅）    | 深紅               |
|        `0`        | 無資料            | —                                       |     `#9CA3AF`（灰）     | 灰色（無偵測資料） |

> ⚠️ **待確認**：各等級的**速率邊界由 `CongestionLevel` 端點逐路段定義**（不同道路門檻不同），後端不硬編速率，而是直接採用 TDX 回傳的 `CongestionLevel` 代碼；色碼為本系統前端視覺約定，可由前端覆寫。等級代碼語意（1–4 / 是否含 5）需以 TDX 實際回傳核對，標記 `⚠️ 待確認` 直到驗證。

---

## 5. API 規格

### 5.1 端點總覽

| Method | Path                            | 功能                                                                        | 資料來源                        |
| ------ | ------------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `GET`  | `/api/v1/traffic/flow`          | **即時車流著色（核心）**：bbox 內路段 → GeoJSON FeatureCollection（含色碼） | TDX Live Section × SectionShape |
| `GET`  | `/api/v1/traffic/parking`       | 目的地附近停車場剩餘車位                                                    | TDX + Haversine                 |
| `GET`  | `/api/v1/traffic/speed-cameras` | 區域測速照相點查詢                                                          | SpeedCamera（MongoDB）          |
| `GET`  | `/api/v1/traffic/freeway`       | 國道路段速率/旅行時間查詢                                                   | TISV M05A + M04A                |
| `GET`  | `/api/v1/traffic/driving`       | **聚合端點**：停車場 + 測速照相合併回傳                                     | 上述 2–3 項                     |

#### 端點設計取捨說明

- **`/api/v1/traffic/flow`（核心）**：地圖視覺化專用。以**地圖可視範圍 bbox** 查詢（駕駛人會平移/縮放地圖），回傳 GeoJSON，與資訊型端點分離——它的查詢條件、快取週期、回應格式都與其它端點不同（地理範圍 vs 點半徑、短 TTL、GeoJSON vs 物件陣列）。
- **分端點**：各來源獨立，前端可依需求選擇呼叫，較靈活；適合僅需單項資訊的場景。
- **聚合端點 `/api/v1/traffic/driving`**：一次呼叫取得停車場 + 測速照相，減少前端往返次數；適合「到達目的地前的一次性查詢」場景。**車流著色與國道旅行時間不納入聚合端點**——前者資料量大且依地圖視窗刷新、後者查詢條件（路段 ID / 起迄）差異大，皆保持獨立。

---

### 5.2 即時車流著色查詢（核心端點）

**端點**：`GET /api/v1/traffic/flow`

把地圖可視範圍內的道路路段，連同即時壅塞等級與色碼，打包成前端可直接繪製的 **GeoJSON FeatureCollection**。這是「在地圖上看到當前車流（紅/黃/綠）」的後端契約。

**Zod Schema**

```typescript
const FlowQuerySchema = z
  .object({
    // 地圖可視範圍（WGS84）：minLng,minLat,maxLng,maxLat
    bbox: z
      .string()
      .regex(
        /^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/,
        "bbox 須為 minLng,minLat,maxLng,maxLat",
      )
      .optional(),
    city: z.string().optional(), // 未給 bbox 時以城市全域回傳
    minLevel: z.coerce.number().int().min(0).max(4).default(0), // 只回傳 >= 此壅塞等級（例：2＝只顯示車多以上）
  })
  .refine((d) => d.bbox || d.city, { message: "需提供 bbox 或 city 其一" });
```

> bbox 跨度過大（如整座城市）會回傳大量 features。實作端須加 **bbox 最大跨度上限**（建議經緯各 ≤ 0.5 度，超過回 `400 BBOX_TOO_LARGE`，引導前端縮小視窗或改用 `city` 模式）。⚠️ 上限值待實測調整。

**請求範例**

```http
GET /api/v1/traffic/flow?bbox=121.50,25.02,121.56,25.07&minLevel=0
```

**回應範例**（`data` 即為標準 GeoJSON FeatureCollection）

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "查詢成功",
  "data": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": {
          "type": "LineString",
          "coordinates": [
            [121.5102, 25.041],
            [121.5135, 25.0422],
            [121.5168, 25.0431]
          ]
        },
        "properties": {
          "sectionId": "TPE-SEC-00123",
          "roadName": "市民大道三段",
          "roadClass": "市區道路",
          "congestionLevel": 3,
          "congestionLabel": "壅塞",
          "speedKmh": 18,
          "travelTimeSec": 240,
          "color": "#EF4444",
          "updatedAt": "2026-06-19T08:30:00+08:00"
        }
      },
      {
        "type": "Feature",
        "geometry": {
          "type": "LineString",
          "coordinates": [
            [121.52, 25.0388],
            [121.524, 25.0381]
          ]
        },
        "properties": {
          "sectionId": "TPE-SEC-00210",
          "roadName": "忠孝東路四段",
          "roadClass": "市區道路",
          "congestionLevel": 1,
          "congestionLabel": "順暢",
          "speedKmh": 47,
          "travelTimeSec": 60,
          "color": "#22C55E",
          "updatedAt": "2026-06-19T08:30:00+08:00"
        }
      }
    ],
    "meta": {
      "city": "Taipei",
      "bbox": [121.5, 25.02, 121.56, 25.07],
      "count": 128,
      "levelCounts": { "0": 3, "1": 70, "2": 30, "3": 20, "4": 5 },
      "dataSource": "TDX Live Section × SectionShape",
      "liveUpdatedAt": "2026-06-19T08:30:00+08:00",
      "geometryImportedAt": "2026-06-10T03:00:00+08:00",
      "cachedAt": "2026-06-19T08:30:20+08:00"
    }
  }
}
```

**為什麼用 GeoJSON FeatureCollection（前端如何畫成紅綠路）**

- 主流地圖元件（Mapbox GL / MapLibre / Leaflet / Google Maps Data Layer）皆**原生吃 GeoJSON**，把 `data` 整包丟進去即可逐段渲染。
- 每段以 `properties.color` 直接著色（後端已對好色碼）；若前端要自訂色票，改用 `properties.congestionLevel`（`0–4`）對應自己的顏色即可。
- 後端已完成「幾何 ＋ 即時等級 ＋ 色碼」的拼裝與 WKT→GeoJSON 轉換，**前端零幾何運算**，只負責繪製與圖例。

**後端組裝流程**

1. 解析 `bbox`（或由 `city` 推城市範圍；bbox 中心點亦可經 `getCity()` 反查市名以決定要打哪個城市的 Live Section）。
2. MongoDB `TrafficSection` 以 `geometry $geoIntersects` bbox polygon 取出範圍內路段幾何（已是 GeoJSON）。
3. `tdxFetch()` 取該城市 **Live Section**（Redis TTL 60s），建 `sectionId → { level, speedKmh, travelTimeSec, updatedAt }` map。
4. 以 `sectionId` join 幾何與即時資料；查無即時資料的路段 `congestionLevel = 0`（灰）。
5. 依 `congestionLevel` 套 `color`（§4.4 色碼表）、以 `minLevel` 過濾，組成 FeatureCollection，`sendResponse()` 包裝回傳。

**降級處理**

- **即時資料缺、幾何在**：仍回傳路網，所有段 `congestionLevel: 0`（灰），`meta.liveUpdatedAt: null`，`message` 提示「車流即時資料暫時無法取得，僅顯示路網」，HTTP 仍 `200`。
- **幾何未匯入 / MongoDB 失敗**：回 `500 TRAFFIC_SECTION_DB_ERROR`。

```json
{
  "ok": false,
  "status": "error",
  "code": 500,
  "message": "路段線型資料尚未匯入",
  "data": {
    "reason": "TRAFFIC_SECTION_DB_ERROR",
    "suggestion": "請先執行 npx ts-node src/scripts/import-traffic-sections.ts"
  }
}
```

> **前端輪詢**：車流隨 Redis TTL（60s）更新，前端輪詢間隔建議 ≥ 60s；地圖平移/縮放後以新 bbox 重打。

---

### 5.3 國道路段旅行時間查詢

**端點**：`GET /api/v1/traffic/freeway`

**Zod Schema**

```typescript
const FreewayQuerySchema = z.object({
  gantryPairs: z.string().optional(), // 逗號分隔門架配對，如 "01F0017N-01F0005N"
  highway: z.enum(["1", "2", "3", "5", "6", "10"]).optional(), // 國道編號（由門架代碼前綴推導，如 01F=國道1號）
  direction: z.enum(["N", "S", "E", "W"]).optional(), // 行駛方向（門架代碼末碼 N/S/E/W）
});
```

> **篩選方式（實測後修正）**：M05A 檔本身**無篩選參數**——它是「全國道、全門架配對、5 欄速率」的一份完整 CSV。後端的 `highway`/`direction`/`gantryPairs` 篩選是**抓回整份 CSV 後在後端過濾**（門架代碼前綴含國道編號、末碼含方向），非 API 側參數。

**請求範例**

```http
GET /api/v1/traffic/freeway?highway=1&direction=N
```

**後端組裝**：以門架配對為一筆 section。`speedKmh` 取自 M05A 小客車（`VehicleType=31`）那列；`sectionName`/座標由門架對照表補（缺則 `null`）；`travelTimeSec` 取自 M04A（缺則 `null`）；`congestionLevel` 由速率推導，速率為 `0`（無資料）時等級記 `0`。

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "查詢成功",
  "data": {
    "sections": [
      {
        "sectionId": "01F0017N-01F0005N",
        "gantryFrom": "01F0017N",
        "gantryTo": "01F0005N",
        "sectionName": "圓山-台北",
        "highway": "1",
        "direction": "N",
        "speedKmh": 92,
        "travelTimeSec": 95,
        "sampleCount": 47,
        "congestionLevel": 1,
        "congestionLabel": "順暢",
        "updatedAt": "2026-06-19T08:30:00+08:00"
      },
      {
        "sectionId": "01F0029N-01F0017N",
        "gantryFrom": "01F0029N",
        "gantryTo": "01F0017N",
        "sectionName": null,
        "highway": "1",
        "direction": "N",
        "speedKmh": 35,
        "travelTimeSec": null,
        "sampleCount": 52,
        "congestionLevel": 4,
        "congestionLabel": "嚴重壅塞",
        "updatedAt": "2026-06-19T08:30:00+08:00"
      }
    ],
    "dataSource": "TISV M05A (speed) + M04A (travel time) + 門架對照表",
    "cachedAt": "2026-06-19T08:31:00+08:00"
  }
}
```

**壅塞等級對應**（由 M05A 小客車速率推導；與 §4.4 色碼共用 0–4 等級）

| `congestionLevel` | `congestionLabel` | 國道速率帶                     |    `color`     |
| :---------------: | ----------------- | ------------------------------ | :------------: |
|         1         | 順暢              | ≥ 80 km/h                      |  `#22C55E` 綠  |
|         2         | 車多              | 60–80 km/h                     |  `#F59E0B` 黃  |
|         3         | 壅塞              | 40–60 km/h                     |  `#EF4444` 紅  |
|         4         | 嚴重壅塞          | < 40 km/h（且 `speedKmh > 0`） | `#991B1B` 深紅 |
|         0         | 無資料            | `speedKmh = 0` 或無樣本        |  `#9CA3AF` 灰  |

> ⚠️ **待確認**：上表速率帶為國道常用門檻（與市區 §4.4 不同——國道流速較高）；正式門檻建議對齊高公局即時路況官方分級，標 `⚠️ 待確認` 直到核對。**務必排除 `speedKmh=0`（無資料哨兵）**，否則會誤判為嚴重壅塞。

**錯誤回應**

```json
{
  "ok": false,
  "status": "error",
  "code": 503,
  "message": "國道路況資料暫時無法取得",
  "data": {
    "reason": "TISV_UNAVAILABLE",
    "suggestion": "請稍後再試，或直接查詢高公局官網"
  }
}
```

---

### 5.4 目的地附近停車場剩餘車位查詢

**端點**：`GET /api/v1/traffic/parking`

**Zod Schema**

```typescript
const ParkingQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(2000).default(500),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  minAvailable: z.coerce.number().int().min(0).default(0), // 0 = 顯示全部（含滿）
});
```

**請求範例**

```http
GET /api/v1/traffic/parking?lat=25.0478&lng=121.5171&radiusM=500&minAvailable=1
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 5 個停車場",
  "data": {
    "parkings": [
      {
        "carParkId": "TPE001234",
        "name": "台北車站停車場",
        "distanceM": 180,
        "location": {
          "lat": 25.048,
          "lng": 121.5168
        },
        "totalSpaces": 320,
        "availableSpaces": 42,
        "occupancyRate": 0.87,
        "status": "available",
        "updatedAt": "2026-06-17T08:29:00+08:00"
      },
      {
        "carParkId": "TPE001235",
        "name": "忠孝東路地下停車場",
        "distanceM": 430,
        "location": {
          "lat": 25.0465,
          "lng": 121.52
        },
        "totalSpaces": 180,
        "availableSpaces": 0,
        "occupancyRate": 1.0,
        "status": "full",
        "updatedAt": "2026-06-17T08:28:00+08:00"
      }
    ],
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 },
    "radiusM": 500,
    "dataSource": "TDX Parking",
    "cachedAt": "2026-06-17T08:30:30+08:00"
  }
}
```

**`status` 欄位規則**

| 條件                               | `status`      |
| ---------------------------------- | ------------- |
| `availableSpaces > 0`              | `"available"` |
| `availableSpaces == 0`             | `"full"`      |
| TDX 未回傳即時車位（僅有靜態資料） | `"unknown"`   |

**後端實作說明**

停車場即時車位查詢**不使用 MongoDB 2dsphere**（TDX 回傳的是全市清單），而是：

1. 以 `tdxFetch()` 取得全市停車場即時車位（Redis TTL 2 分鐘快取）
2. 在後端以 Haversine 篩選 `radiusM` 範圍內的停車場
3. 依 `distanceM` 升冪排序，取 `limit` 筆

> ⚠️ **待確認**：TDX 停車場 API 是否支援 `$top` / 地理篩選參數（若有則優先用 API 側篩選以減少傳輸量）。

**錯誤回應**

```json
{
  "ok": false,
  "status": "error",
  "code": 503,
  "message": "停車場即時資料暫時無法取得",
  "data": {
    "reason": "TDX_PARKING_UNAVAILABLE"
  }
}
```

---

### 5.5 區域測速照相點查詢

**端點**：`GET /api/v1/traffic/speed-cameras`

**Zod Schema**

```typescript
const SpeedCameraQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(10000).default(3000),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  minSpeedLimit: z.coerce.number().int().optional(), // 篩選速限門檻，單位 km/h
});
```

**請求範例**

```http
GET /api/v1/traffic/speed-cameras?lat=25.0478&lng=121.5171&radiusM=5000
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 8 個測速照相",
  "data": {
    "cameras": [
      {
        "cameraId": "N1-001-N",
        "name": "國道1號 汐止路段（北上）",
        "location": {
          "lat": 25.0612,
          "lng": 121.6234
        },
        "distanceM": 1840,
        "roadName": "國道1號",
        "direction": "北上",
        "speedLimitKmh": 110,
        "cameraType": "fixed"
      },
      {
        "cameraId": "TPE-K002",
        "name": "忠孝東路四段定點測速",
        "location": {
          "lat": 25.0416,
          "lng": 121.5503
        },
        "distanceM": 3200,
        "roadName": "忠孝東路四段",
        "direction": null,
        "speedLimitKmh": 50,
        "cameraType": "fixed"
      }
    ],
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 },
    "radiusM": 5000,
    "dataSource": "SpeedCamera（data.gov.tw dataset/7320）",
    "dataUpdatedAt": "2026-05-01T00:00:00+08:00"
  }
}
```

---

### 5.6 聚合端點（停車場 + 測速照相）

**端點**：`GET /api/v1/traffic/driving`

**Zod Schema**

```typescript
const DrivingQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  parkingRadiusM: z.coerce.number().int().min(100).max(2000).default(500),
  cameraRadiusM: z.coerce.number().int().min(100).max(10000).default(3000),
  parkingLimit: z.coerce.number().int().min(1).max(20).default(5),
  cameraLimit: z.coerce.number().int().min(1).max(30).default(10),
});
```

**請求範例**

```http
GET /api/v1/traffic/driving?lat=25.0478&lng=121.5171&parkingRadiusM=500&cameraRadiusM=5000
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "查詢成功",
  "data": {
    "parking": {
      "items": [/* 同 §5.4 parkings 陣列 */],
      "ok": true,
      "error": null
    },
    "speedCameras": {
      "items": [/* 同 §5.5 cameras 陣列 */],
      "ok": true,
      "error": null
    },
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 }
  }
}
```

**降級處理**：某子查詢失敗時，對應的 `ok` 設為 `false`、`error` 填錯誤原因字串，另一子查詢結果仍正常回傳，整體 HTTP 狀態碼仍為 `200`。

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "部分資料暫時無法取得",
  "data": {
    "parking": {
      "items": [],
      "ok": false,
      "error": "TDX_PARKING_UNAVAILABLE"
    },
    "speedCameras": {
      "items": [/* 正常資料 */],
      "ok": true,
      "error": null
    },
    "queryLocation": { "lat": 25.0478, "lng": 121.5171 }
  }
}
```

---

### 5.7 共用錯誤碼

| Code                       | HTTP 狀態 | 說明                                                                                  |
| -------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `TRAFFIC_FLOW_UNAVAILABLE` | 503       | TDX Live Section 即時車流暫時無法取得（注意：幾何仍在時改採降級回傳灰色路網，非此碼） |
| `TRAFFIC_SECTION_DB_ERROR` | 500       | MongoDB `TrafficSection` 路段線型查詢失敗 / 尚未匯入                                  |
| `BBOX_TOO_LARGE`           | 400       | 車流查詢 bbox 跨度超過上限，請縮小地圖視窗或改用 `city`                               |
| `TISV_UNAVAILABLE`         | 503       | TISV 高公局 API 無法連線                                                              |
| `TDX_PARKING_UNAVAILABLE`  | 503       | TDX 停車場 API 無法連線或 429                                                         |
| `INVALID_COORDINATES`      | 400       | 座標超出台灣範圍（參考：緯度 21–26、經度 119–123）                                    |
| `SPEED_CAMERA_DB_ERROR`    | 500       | MongoDB SpeedCamera 查詢失敗                                                          |

---

## 6. 快取策略

### 6.1 Redis 快取設計

所有即時資料查詢結果寫入 Redis，Key 格式與 TTL 如下：

| 資料                                  | Redis Key 格式                          | TTL         | 說明                                                                                         |
| ------------------------------------- | --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| **TDX 即時車流（全市 Live Section）** | `traffic:flow:live:{city}`              | **60 秒**   | 著色核心。每城市一份即時資料，後端在記憶體 join 幾何後依 bbox 切，TTL 內 bbox 平移不再打 TDX |
| **TDX 壅塞等級定義（全市）**          | `traffic:flow:congestion-def:{city}`    | **24 小時** | 各路段速率帶定義，準靜態                                                                     |
| TDX 即時車流失敗結果                  | `traffic:flow:live:{city}`              | **30 秒**   | 失敗短快取，避免連續穿透；命中時走灰色路網降級                                               |
| TISV 國道路況                         | `traffic:freeway:{highway}:{direction}` | **3 分鐘**  | TISV 每 5 分鐘更新，3 分鐘 TTL 確保不過舊                                                    |
| TISV 路段（by ID）                    | `traffic:freeway:section:{sectionId}`   | **3 分鐘**  | 同上                                                                                         |
| TDX 停車場車位（全市）                | `traffic:parking:{cityCode}`            | **2 分鐘**  | 停車場更新頻繁，2 分鐘平衡即時性與配額                                                       |
| TDX API 失敗結果                      | `traffic:parking:{cityCode}`            | **30 秒**   | 失敗短快取，避免 429 造成 2 分鐘盲區（同 Phase 15 慣例）                                     |

> **路段線型 `TrafficSection`** 與 **SpeedCamera**（測速照相）皆為準靜態 MongoDB 查詢，不使用 Redis 快取；幾何只在匯入腳本更新。即時車流只快取「Live Section 數值」這一小份（每城市數百～數千筆數字），幾何不進 Redis，避免重複存大型 GeoJSON。

### 6.2 快取更新策略

- **即時資料（TISV / TDX）**：Cache-aside 模式（先查 Redis，miss 再打 API，寫回 Redis）。
- **靜態資料（SpeedCamera）**：透過 `import-speed-cameras.ts` 手動或排程重匯，與 Redis 無關。
- **TDX 停車場**：每次 cache miss 取整個城市的停車場清單（約數百筆），存入 Redis，後端在 Redis 的 JSON 內進行地理篩選，減少後續 TTL 內的 TDX 呼叫次數至 0。

### 6.3 TTL 參數表

| 環境變數（建議）                 | 預設值  | 說明                           |
| -------------------------------- | ------- | ------------------------------ |
| `TRAFFIC_FLOW_LIVE_TTL_SEC`      | `60`    | 即時車流 Live Section 快取秒數 |
| `TRAFFIC_FLOW_LIVE_ERR_TTL_SEC`  | `30`    | 即時車流失敗短快取秒數         |
| `TRAFFIC_CONGESTION_DEF_TTL_SEC` | `86400` | 壅塞等級定義快取秒數           |
| `TRAFFIC_FREEWAY_TTL_SEC`        | `180`   | TISV 路況快取秒數              |
| `TRAFFIC_PARKING_TTL_SEC`        | `120`   | TDX 停車場快取秒數             |
| `TRAFFIC_PARKING_ERR_TTL_SEC`    | `30`    | TDX 停車場失敗快取秒數         |
| `TISV_TIMEOUT_MS`                | `8000`  | TISV adapter fetch 逾時毫秒    |

---

## 7. 資料模型

### 7.1 SpeedCamera（`src/model/speed-camera.model.ts`）

測速照相為靜態政府資料，預匯入 MongoDB，使用 2dsphere index 支援地理查詢。

```typescript
interface ISpeedCamera {
  cameraId: string; // 唯一識別碼（data.gov.tw 欄位，⚠️ 待確認欄位名稱）
  name: string; // 設備名稱或描述
  roadName: string; // 所在道路名稱
  direction?: string; // 行駛方向（北上/南下/東行/西行，部分資料無此欄）
  speedLimitKmh?: number; // 速限（km/h）
  cameraType: "fixed"; // 目前 dataset/7320 僅含固定式；區間式視資料而定
  county?: string; // 縣市
  location: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]，GeoJSON
  };
  importedAt: Date; // 匯入時間戳
}

// Index
SpeedCameraSchema.index({ location: "2dsphere" });
SpeedCameraSchema.index({ cameraId: 1 }, { unique: true });
SpeedCameraSchema.index({ county: 1 });
```

> ⚠️ **待確認**：data.gov.tw dataset/7320 的 CSV 欄位名稱（如 `設備編號`、`架設地點`、`速限`）需下載實際資料後核對，匯入腳本欄位對應依此調整。

### 7.2 停車場（無新增 MongoDB 模型）

停車場即時車位資料**不建立 MongoDB 模型**，直接以 Redis 快取 TDX JSON 回應。理由：

- TDX 提供的停車場清單可能每月異動（新增 / 關閉），若存入 MongoDB 需維護同步機制
- 停車場數量（每城市數百筆）遠小於 SpeedCamera 或 GTFS，直接 in-memory 篩選可接受
- 節省模型維護成本

若未來需要「靜態停車場資料補強（如無障礙停車格數量）」，再規劃 `ParkingLot` model。

### 7.3 TrafficSection（`src/model/traffic-section.model.ts`）— 路段線型

路段線型為準靜態圖資，由 `import-traffic-sections.ts` 從 TDX SectionShape 預匯入（WKT→GeoJSON），2dsphere index 支援 bbox `$geoIntersects` 查詢。即時壅塞**不存此模型**（走 Redis），只靠 `sectionId` 與即時資料 join。

```typescript
interface ITrafficSection {
  sectionId: string; // 唯一識別碼（與 Live Section 的 join key）
  roadName?: string; // 道路名稱
  roadClass?: string; // 道路等級（國道/省道/市區道路…）
  city: string; // TDX 英文市名（Taipei…），匯入時依來源城市標註
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][]; // GeoJSON, WGS84 [lng, lat]
  };
  importedAt: Date; // 匯入時間戳（對外為 meta.geometryImportedAt）
}

// Index
TrafficSectionSchema.index({ geometry: "2dsphere" });
TrafficSectionSchema.index({ sectionId: 1 }, { unique: true });
TrafficSectionSchema.index({ city: 1 });
```

**為何幾何進 MongoDB（而停車場不進）**：

- 車流查詢以**地圖視窗 bbox** 為條件，2dsphere `$geoIntersects` 是最自然且高效的篩選方式（與 `A11y`、`Bathroom`、`SpeedCamera` 一致）。
- 線型為準靜態（道路改線才變），適合預匯入；即時壅塞數值才是高頻資料，留在 Redis。
- 把幾何與即時值分離，讓每次 TDX 即時呼叫只傳「數字」（輕量），不傳大型 WKT。

**匯入腳本 `import-traffic-sections.ts`**（比照 `import-tdx-*.ts`）：

```
1. 對每個目標城市呼叫 tdxFetch() 取 SectionShape（?$format=JSON）
2. 以 wellknown 將 WKT Geometry → GeoJSON LineString / MultiLineString
3. 批次 bulkWrite（每批 500 筆），以 sectionId upsert，標註 city / importedAt
4. 輸出：每城市匯入筆數 / 耗時 / WKT 解析失敗數
```

> ⚠️ **待確認**：SectionShape 的 `City` 涵蓋哪些縣市、`Geometry` 是否一律 WKT（少數端點可能回 GeoJSON），需以實際回傳核對。

---

## 8. 實作 Roadmap

### 待實作

| Phase           | 功能                                                                                                             | 優先度       | 前置條件                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------- |
| **Phase DT-0**  | Adapter 層：`src/adapters/tisv.adapter.ts`；確認停車場/車流沿用 `tdx.adapter.ts`                                 | **Critical** | —                               |
| **Phase DT-F1** | `TrafficSection` model + 匯入腳本 `import-traffic-sections.ts`（SectionShape → GeoJSON）                         | **Critical** | TDX SectionShape 欄位/City 確認 |
| **Phase DT-F2** | **即時車流著色端點 `GET /api/v1/traffic/flow`**（Live Section × 幾何 join → GeoJSON + 色碼）+ Redis 快取         | **Critical** | DT-F1、CongestionLevel 代碼確認 |
| **Phase DT-1**  | SpeedCamera model + 匯入腳本 `import-speed-cameras.ts`                                                           | **High**     | data.gov.tw CSV 欄位確認        |
| **Phase DT-2**  | 測速照相查詢端點 `GET /api/v1/traffic/speed-cameras`                                                             | **High**     | Phase DT-1                      |
| **Phase DT-3**  | 停車場即時車位端點 `GET /api/v1/traffic/parking` + Redis 快取                                                    | **High**     | TDX 停車場 API 端點確認         |
| **Phase DT-4**  | 聚合端點 `GET /api/v1/traffic/driving`                                                                           | **Medium**   | Phase DT-2 + DT-3               |
| **Phase DT-5**  | TISV 國道路況端點 `GET /api/v1/traffic/freeway`：M05A CSV 解析 + 速率→壅塞推導 + 門架對照表（URL 格式已確認 ✅） | **Medium**   | DT-0、門架對照表來源確認        |
| **Phase DT-6**  | 定期重匯（測速照相 + 路段線型）排程或手動 npm script                                                             | **Low**      | DT-1 / DT-F1                    |

### Phase DT-1 — SpeedCamera 匯入腳本（詳細）

**新增檔案**：

```
src/model/speed-camera.model.ts
src/scripts/import-speed-cameras.ts
data/speed-cameras/           ← 加入 .gitignore（CSV 不入 repo）
```

**匯入腳本流程**（比照 `src/scripts/import-gtfs-stops.ts`）：

```
1. 讀取 data/speed-cameras/speed_cameras.csv
2. readline 串流解析（不一次性讀入）
3. 批次 bulkWrite（每批 500 筆），以 cameraId upsert
4. 輸出：匯入筆數 / 耗時 / 錯誤數
```

**執行指令**：

```bash
npx ts-node src/scripts/import-speed-cameras.ts
```

---

## 9. 測試策略

> 測試框架已於 `build: add vitest test runner and config`（commit `331bfc7`）建立。

### 9.1 手動測試案例

| 測試案例             | 輸入                               | 預期結果                                                                                               |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 車流著色查詢         | 台北市中心 bbox                    | 回傳 GeoJSON FeatureCollection，每 Feature 含 `congestionLevel` 與對應 `color`，geometry 為 LineString |
| 車流即時降級         | 模擬 TDX Live Section 失聯、幾何在 | HTTP 200，全段 `congestionLevel:0`（灰），`meta.liveUpdatedAt:null`                                    |
| 車流幾何未匯入       | 未跑 `import-traffic-sections.ts`  | 500 `TRAFFIC_SECTION_DB_ERROR`                                                                         |
| 車流 bbox 過大       | 跨度 > 上限                        | 400 `BBOX_TOO_LARGE`                                                                                   |
| 車流 minLevel 過濾   | `minLevel=3`                       | 僅回傳 `congestionLevel >= 3` 的路段                                                                   |
| 停車場查詢（有空位） | 台北車站附近 500m                  | 回傳 `status: "available"` 停車場，distanceM 升冪排序                                                  |
| 停車場查詢（全滿）   | 尖峰時段高需求區域                 | 回傳 `status: "full"`，`availableSpaces: 0`                                                            |
| 測速照相查詢         | 國道 1 號汐止附近 5km              | 回傳 `speedLimitKmh: 110` 的高速公路照相點                                                             |
| 聚合端點降級         | 模擬 TDX 429                       | `parking.ok: false`，`speedCameras` 仍正常回傳                                                         |
| Redis 快取命中       | 連續兩次相同查詢                   | 第二次回應 `cachedAt` 與第一次相同（≤ TTL 內）                                                         |
| 座標超出台灣         | `lat: 0, lng: 0`                   | 400 `INVALID_COORDINATES`                                                                              |

### 9.2 驗證重點

- Redis 快取 Key 格式正確，TTL 到期後正常重打 TDX
- TDX 429 時失敗短快取（30s）生效，不造成 2 分鐘服務盲區
- SpeedCamera `$near` 查詢回傳正確 `distanceM`（以 GeoJSON `$near` 計算距離）
- 聚合端點兩個子查詢以 `Promise.allSettled` 並行執行，一個失敗不阻塞另一個

### 9.3 Vitest 單元測試建議

| 測試對象                     | 測試重點                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `traffic-flow.service.ts`    | sectionId join：即時資料對得上→帶等級/色碼；對不上→`congestionLevel:0`（灰）。等級→色碼對應表正確。`minLevel` 過濾正確      |
| `tisv.adapter.ts`            | `fetchLatestM05A` 的 5 分鐘 floor 與 404 回退（mock fetch 第一次 404、第二次 200）；timeout 觸發、非 2xx 轉拋               |
| `freeway.service.ts`         | M05A 速率→壅塞等級推導（含 `speedKmh=0` → level 0，不誤判嚴重壅塞）；只取 `VehicleType=31`；門架對不到時 `sectionName:null` |
| `import-traffic-sections.ts` | WKT→GeoJSON 轉換（LineString / MultiLineString），upsert by sectionId                                                       |
| `parking.service.ts`         | Haversine 篩選邏輯（模擬 TDX 全市清單，驗證只回傳 radiusM 內）                                                              |
| `speed-camera.service.ts`    | `$near` 查詢參數傳入正確（mock MongoDB）                                                                                    |
| `traffic.service.ts`         | `Promise.allSettled` 降級邏輯：一邊 reject 時另一邊結果正確合入                                                             |

---

## 10. 新增環境變數

| 變數                             | 用途                                      | 必要性 | 預設值  |
| -------------------------------- | ----------------------------------------- | ------ | ------- |
| `TRAFFIC_FLOW_LIVE_TTL_SEC`      | TDX 即時車流 Live Section Redis TTL（秒） | 選配   | `60`    |
| `TRAFFIC_FLOW_LIVE_ERR_TTL_SEC`  | 即時車流失敗短快取 TTL（秒）              | 選配   | `30`    |
| `TRAFFIC_CONGESTION_DEF_TTL_SEC` | 壅塞等級定義 Redis TTL（秒）              | 選配   | `86400` |
| `TRAFFIC_FREEWAY_TTL_SEC`        | TISV 國道路況 Redis TTL（秒）             | 選配   | `180`   |
| `TRAFFIC_PARKING_TTL_SEC`        | TDX 停車場即時車位 Redis TTL（秒）        | 選配   | `120`   |
| `TRAFFIC_PARKING_ERR_TTL_SEC`    | TDX 停車場失敗快取 TTL（秒）              | 選配   | `30`    |
| `TISV_TIMEOUT_MS`                | TISV adapter fetch 逾時（毫秒）           | 選配   | `8000`  |

> **無需新增 TDX 憑證**：停車場查詢沿用既有 `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`，透過 `tdxFetch()` 注入 Bearer token。  
> **無需 TISV 金鑰**：TISV 高公局 API 為公開端點。  
> **無需 data.gov.tw 金鑰**：測速照相資料集為公開授權。

---

## 11. 前端職責邊界

### 11.1 前端負責

| 職責               | 說明                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **車流圖層繪製**   | 把 `/flow` 回傳的 `data`（GeoJSON FeatureCollection）整包餵給地圖元件（Mapbox GL / MapLibre / Leaflet / Google Maps Data Layer），逐段以 `properties.color` 著色繪製紅／黃／綠路況。若要自訂配色，改讀 `properties.congestionLevel`（`0–4`）對應自家色票 |
| **依視窗刷新車流** | 監聽地圖平移/縮放，以新的可視範圍組 `bbox` 重打 `/flow`；輪詢間隔 ≥ 60s（配合 Redis 60s TTL）；可用 `minLevel` 只顯示壅塞以上路段以降低畫面雜訊                                                                                                          |
| 點位顯示           | 在地圖上標記停車場位置、測速照相點                                                                                                                                                                                                                       |
| 地點輸入           | 使用者輸入目的地地址或在地圖點擊，轉換為 `lat/lng` 後呼叫 API                                                                                                                                                                                            |
| 結果排序 / 篩選    | 依距離、剩餘車位數等條件在前端二次篩選（後端已回傳完整清單）                                                                                                                                                                                             |
| 定時輪詢           | 停車場輪詢間隔建議 ≥ 2 分鐘、車流 ≥ 60 秒，配合各自 Redis TTL                                                                                                                                                                                            |
| 路線繪製（駕車）   | 駕車導航路線以第三方地圖服務（Google Maps / Apple Maps）開啟，非本系統職責                                                                                                                                                                               |

### 11.2 前端不負責

| 禁止事項                    | 原因                                                   |
| --------------------------- | ------------------------------------------------------ |
| 直接呼叫 TDX / TISV API     | API 金鑰安全性，後端代理統一處理                       |
| 路段線型解析（WKT→GeoJSON） | 幾何轉換在匯入腳本一次性完成，前端拿到的已是 GeoJSON   |
| 壅塞等級 → 色碼換算         | 後端已附 `color`；前端可選擇覆寫，但等級語意以後端為準 |
| 駕車路徑計算                | 本系統不提供駕車 routing（由外部地圖服務處理）         |
| 測速照相資料下載與解析      | 靜態資料由後端匯入腳本處理                             |
| 快取管理                    | Redis 由後端管理，前端僅設定合理輪詢間隔               |

---

## 12. 風險與緩解

| 風險                                                       | 嚴重度 | 可能性                   | 緩解策略                                                                                                                |
| ---------------------------------------------------------- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **車流 bbox 過大回傳過多 features**                        | 中     | 中                       | bbox 最大跨度上限（超過回 `BBOX_TOO_LARGE`）；`minLevel` 過濾；回應為 LineString 不含多餘屬性，控制 payload             |
| **TDX 即時車流 API 429 / 失聯**                            | 高     | 中                       | 每城市一份 Live Section（TTL 60s）、失敗短快取 30s；失聯時走灰色路網降級（仍回幾何），不整體 500                        |
| **CongestionLevel 代碼語意 / SectionShape 幾何格式待確認** | 中     | 高                       | DT-F1/F2 前先以 TDX Swagger + 實際回傳核對等級代碼與 WKT/GeoJSON；色碼與 join 邏輯集中、標 `⚠️ 待確認` 直到驗證         |
| **路段線型 join key 對不上（SectionID 不一致）**           | 中     | 中                       | 匯入時記錄未配對數；join 不到即時資料的段落以 `congestionLevel:0`（灰）安全降級，不丟棄該段                             |
| **TDX 停車場 API 429**                                     | 高     | 中                       | Redis TTL 2 分鐘快取（每城市一份），失敗短快取 30s；禁止前端高頻穿透                                                    |
| **TISV M05A CSV 欄序/門架代碼異動**                        | 中     | 低                       | CSV 取檔與 5 分鐘回退集中在 `tisv.adapter.ts`、欄位解析集中在 `freeway.service.ts`，異動只需改一處；失敗回 503 + 建議語 |
| **M05A 最新檔發布延遲 / 跨午夜邊界**                       | 低     | 中                       | `fetchLatestM05A` 往前回退最多 3 個 5 分鐘級距；以 Asia/Taipei 計 floor，跨日/跨時自然落到前一資料夾                    |
| **門架對照表缺漏（sectionName=null）**                     | 低     | 中                       | 對不到門架的路段仍回傳速率與等級，`sectionName` 給 `null`，前端以門架代碼後備顯示                                       |
| **data.gov.tw 測速照相資料過舊**                           | 低     | 高（政府資料常延遲更新） | 回應包含 `dataUpdatedAt`，前端可提示使用者資料日期；規劃 DT-6 定期重匯                                                  |
| **TDX 停車場 API 端點變更**                                | 中     | 低                       | `parking.service.ts` 抽象化 TDX 呼叫，endpoint URL 以常數定義；fail-soft 降級                                           |
| **SpeedCamera 資料集欄位名稱待確認**                       | 中     | 高                       | DT-1 Phase 前先手動下載 CSV 驗證欄位，匯入腳本欄位對應標記 `⚠️ 待確認` 直到確認後解除                                   |
| **Redis 未啟動（開發環境）**                               | 低     | 中                       | 沿用既有 `config/redis.ts` 的降級模式（Redis 不可用時 miss-through，直打 API）；不影響正確性，僅 TDX 額度使用量增加     |
