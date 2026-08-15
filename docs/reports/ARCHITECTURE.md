# 程式碼架構文件

> 版本：1.1　最後更新：2026-06-13  
> 說明：本文件描述現有架構的分層現況、已識別的耦合問題，以及建議的目標架構與重構路線圖。

> **v1.1 變更（Opus 深度複查）**：v1.0（Sonnet）的分析遺漏了 `user` 模組——它被誤標為「正常」，
> 實際上是全專案 DB 耦合最嚴重的檔案（已於 Phase 7 修正）。並新增了 v1.0 完全未提及的
> **深層結構問題**：路由領域型別的「倒置依賴」與動態 `import()` 繞圈（見 §9，這才是「架構好亂」的真正根源）。

## ✅ 已完成的重構（Phase 1–7）

| Phase | 內容                                                                                                                            | Commit           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1     | `a11y.service.ts` — controller + agent-tools 不再直接碰 MongoDB                                                                 | `8443583`        |
| 2     | `transit.service.ts` — TDX URL 組裝移出 controller / agent-tools                                                                | `20036e2`        |
| 3     | `air.service.ts` — Google Geocoding + STA API 集中                                                                              | `aea514e`        |
| 4     | `adapters/google.adapter.ts` — 刪除 `config/map.ts`、移除 `config/lib.ts::getCoordinates`                                       | `64e3181`        |
| 5     | `config/ors.ts` → `service/ors.service.ts`                                                                                      | `9992bee`        |
| 6     | `agent-tools.ts` 薄封裝化（534 → 365 行）                                                                                       | （併入 Phase 5） |
| **7** | **`user.service.ts` — user 模組原本完全沒有 service 層（v1.0 遺漏）**                                                           | `b4a9fa9`        |
| 補    | transit 服務改回傳明確 HTTP status（移除字串比對 hack）                                                                         | `fa24a65`        |
| **8** | **`src/types/route.ts` — 路由領域型別下沉，根治倒置依賴（見 §9）**                                                              | `1a5658b`        |
| **9** | **消滅頂層 `src/service/`：11 個 planner → `modules/accessible-route/planners/`、`TdxTokenManger` → `adapters/tdx.adapter.ts`** | （本分支）       |

> **§2/§6 的目錄樹早於 Phase 9**：頂層 `src/service/` 已不存在，`*.service.ts` 現在只出現在模組內。
> 最新結構與理由見 [`architecture-audit.md`](./architecture-audit.md) §3/§4。Phase 9 的動機：`src/service/`
> 名義上是「跨模組共用層」，實際上 11/12 檔只被 `accessible-route` 使用（非跨模組），唯一真．跨切面的
> `TdxTokenManger` 本質是外部 API client，故歸入既有的 `adapters/` 層。

---

## 目錄

1. [整體設計原則](#1-整體設計原則)
2. [現有目錄結構](#2-現有目錄結構)
3. [請求流程（現狀）](#3-請求流程現狀)
4. [耦合問題清單](#4-耦合問題清單)
5. [目標架構（To-Be）](#5-目標架構to-be)
6. [目標目錄結構](#6-目標目錄結構)
7. [重構路線圖](#7-重構路線圖)
8. [各層職責定義](#8-各層職責定義)
9. [深層結構問題：路由型別倒置依賴（Phase 8）](#9-深層結構問題路由型別倒置依賴phase-8)

---

## 1. 整體設計原則

本專案採用 **模組化分層架構**（Modular Layered Architecture）。每一層只能向下依賴，不得跨層：

```
Router → Controller → Service → Adapter / Repository → 外部資源
```

| 層次           | 職責                                                |
| -------------- | --------------------------------------------------- |
| **Router**     | 定義 HTTP 路由、套用 middleware                     |
| **Controller** | 解析請求、驗證參數、呼叫 Service、格式化回應        |
| **Service**    | 業務邏輯，協調多個 Repository / Adapter             |
| **Adapter**    | 封裝單一外部 API（Google、TDX、ORS、STA）           |
| **Repository** | 封裝 MongoDB 存取（可暫用 Mongoose Model 直接代替） |
| **Config**     | 純常數與客戶端初始化，**不含網路呼叫**              |

---

## 2. 現有目錄結構

```
src/
├── app.ts                          # Express 初始化、掛載路由
├── server.ts                       # 啟動入口
├── conn.ts                         # MongoDB 連線
│
├── modules/                        # 功能模組（目前 5 個）
│   ├── a11y/
│   │   ├── a11y.router.ts
│   │   ├── a11y.controller.ts      # ⚠️ 直接查詢 MongoDB
│   │   ├── a11y.schema.ts
│   │   └── index.ts
│   ├── transit/
│   │   ├── transit.router.ts
│   │   ├── transit.controller.ts   # ⚠️ 直接呼叫 TDX API
│   │   ├── transit.schema.ts
│   │   └── index.ts
│   ├── air/
│   │   ├── air.router.ts
│   │   ├── air.controller.ts       # ⚠️ 直接呼叫 Google + STA + Gemini
│   │   ├── air.schema.ts
│   │   └── index.ts
│   ├── accessible-route/
│   │   ├── accessible-route.router.ts
│   │   ├── accessible-route.controller.ts
│   │   ├── accessible-route.service.ts  # ✅ 有 service 層
│   │   ├── accessible-route.schema.ts
│   │   ├── facility-slim.ts
│   │   ├── transfer-finder.ts
│   │   └── index.ts
│   ├── ai/
│   │   ├── ai.router.ts
│   │   ├── ai.controller.ts        # ✅ 呼叫 config/ai，邏輯單純
│   │   ├── ai.chat.controller.ts   # ✅ 串流 agent loop
│   │   ├── agent-tools.ts          # ⚠️ God file：重複 DB + 三個外部 API
│   │   ├── ai.schema.ts
│   │   └── index.ts
│   └── user/
│       ├── user.router.ts
│       ├── user.controller.ts      # ✎ Phase 7 已修：原本直接 findOne/save/findOneAndUpdate
│       ├── user.service.ts         # ✦ Phase 7 新增：所有 User/Config DB 存取
│       └── index.ts
│
├── service/                        # 跨模組共用服務
│   ├── accessible-route.service.ts # 路線規劃主引擎（編排 OTP + TDX）
│   ├── realtime-transit.service.ts # TDX 即時資料 overlay
│   ├── otp-routing.service.ts      # OTP2 sidecar（主路由引擎）
│   ├── tdx-routing.service.ts      # TDX MaaS 補位（覆蓋 OTP 缺口）
│   ├── route-a11y.service.ts       # leg 無障礙 / 室內導引強化（OTP+TDX 共用）
│   ├── gtfs-time.ts                # GTFS 時間字串工具（realtime overlay 用）
│   ├── a11y-exit.service.ts
│   ├── facility-status.service.ts
│   ├── indoor-graph.service.ts
│   ├── reachable-stops.service.ts
│   ├── TdxTokenManger.ts
│   ├── walk-cache.service.ts
│   └── ...
│
├── model/                          # Mongoose schema 定義
│   ├── a11y.model.ts
│   ├── bathroom.model.ts
│   ├── osm-a11y.model.ts
│   └── ...（共 12 個）
│
├── config/                         # ⚠️ 部分檔案超出 config 範疇
│   ├── fetch.ts                    # ✅ tdxFetch wrapper
│   ├── transit.ts                  # ✅ TDX URL 常數
│   ├── ai.ts                       # ✅ Gemini / OpenAI 客戶端初始化
│   ├── jwt.ts                      # ✅ JWT 工具
│   ├── lib.ts                      # ⚠️ getCoordinates() 呼叫 Google API
│   ├── map.ts                      # ⚠️ getCity() 呼叫 Google Geocoding
│   ├── ors.ts                      # ⚠️ 完整 ORS HTTP client 邏輯
│   └── ...
│
└── middleware/
    ├── middleware.ts               # JWT auth
    └── validate-request.middleware.ts
```

---

## 3. 請求流程（現狀）

### 正常模組（accessible-route）✅

```
Request
  → accessible-route.router.ts
  → accessible-route.controller.ts  (parse / validate)
  → accessible-route.service.ts     (業務邏輯)
    → config/ors.ts                 (外部 ORS API)
    → service/otp-routing.service.ts / tdx-routing.service.ts
    → model/bus-stop.model.ts
  → sendResponse()
```

### 問題模組（a11y）⚠️

```
Request
  → a11y.router.ts
  → a11y.controller.ts
    ├── A11y.find()                 ← 直接查 DB
    ├── BathroomModel.find()        ← 直接查 DB
    └── OsmA11y.find()              ← 直接查 DB
  → sendResponse()
```

### 問題模組（transit）⚠️

```
Request
  → transit.router.ts
  → transit.controller.ts
    ├── getCity()                   ← 呼叫 Google Geocoding
    ├── detectBusApiType()          ← 業務邏輯
    ├── 組裝 TDX URL                ← 業務邏輯
    ├── tdxFetch(url)               ← 直接呼叫外部 API
    └── getRouteDirectionImproved() ← 業務邏輯
  → sendResponse()
```

### 問題模組（air）⚠️

```
Request
  → air.router.ts
  → air.controller.ts
    ├── fetch(Google Geocoding)     ← 直接外部 API
    ├── fetch(STA 空氣品質)         ← 直接外部 API
    └── googleGenAi.generateContent ← AI 呼叫
  → sendResponse()
```

### AI Agent Tools（agent-tools.ts）⚠️

```
agent-tools.ts
  ├── findA11yPlaces()
  │   ├── A11y.find()              ← 重複 a11y.controller 的 DB 查詢
  │   ├── BathroomModel.find()     ← 重複
  │   └── OsmA11y.find()           ← 重複
  ├── getBusArrivalEstimate()
  │   ├── getCity()                ← 重複 transit.controller 的邏輯
  │   ├── tdxFetch()               ← 重複
  │   └── getRouteDirectionImproved() ← 重複
  └── getAirQuality()
      ├── fetch(Google Geocoding)  ← 重複 air.controller 的邏輯
      └── fetch(STA API)           ← 重複
```

---

## 4. 耦合問題清單

### 🔴 P1 — 嚴重（Controller 直接操作 DB / 外部 API）

#### 問題 1：`a11y` 模組缺少 Service 層

**位置：** `src/modules/a11y/a11y.controller.ts`

```typescript
// ❌ 現況：controller 直接查 MongoDB
async function nearbyA11y(req, res) {
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm] = await Promise.all([
    A11y.find({ location: geoQuery }),
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery }),
    OsmA11y.find({ location: geoQuery }),
  ]);
}
```

**影響：** DB 查詢邏輯散落在 controller，`agent-tools.ts` 只能複製貼上同樣的 query。

---

#### 問題 2：`transit` 模組缺少 Service 層

**位置：** `src/modules/transit/transit.controller.ts`

```typescript
// ❌ 現況：URL 組裝、方向判斷、API 呼叫全在 controller
async function getBusData(req, res) {
  const city = await getCity(Number(arrival_lat), Number(arrival_lng));
  const formatRouteName = detectBusApiType(route_name);
  const url =
    formatRouteName.type === "City"
      ? `${busUrl.stopOfRouteUrl}/${city}?...`
      : `${busUrl.interCityStopOfRouteUrl}?...`;
  const busStopInfo = await tdxFetch(url);
  // ...
}
```

---

#### 問題 3：業務邏輯重複（`agent-tools.ts` 是 controller 的複製品）

| agent-tools 函式          | 重複自                             | 重複內容                           |
| ------------------------- | ---------------------------------- | ---------------------------------- |
| `findA11yPlaces()`        | `a11y.controller.nearbyA11y`       | 相同 3 個 MongoDB `$near` 查詢     |
| `getBusArrivalEstimate()` | `transit.controller.getBusData`    | TDX URL 組裝 + 方向判斷 + ETA 查詢 |
| `getAirQuality()`         | `air.controller.getAirQualityInfo` | Google Geocoding + STA API 呼叫    |

任何邏輯修改都需要改兩個地方，容易造成行為不一致。

---

### 🟠 P2 — 中度（Service 邏輯放錯層次）

#### 問題 4：`config/` 內含 HTTP 呼叫

| 檔案                | 問題函式                                  | 說明                                 |
| ------------------- | ----------------------------------------- | ------------------------------------ |
| `config/map.ts`     | `getCity()`                               | 呼叫 Google Geocoding API，不是常數  |
| `config/lib.ts:199` | `getCoordinates()`                        | 呼叫 Google Places API，不是工具函式 |
| `config/ors.ts`     | `orsWalkingRoute()`, `orsWalkingMatrix()` | 完整的 ORS HTTP client，應為 service |

**影響：** `config/` 被多個模組引入；一旦替換 Google 或 ORS，需要追蹤散落在 config 裡的呼叫點。

---

#### 問題 5：`air.controller.ts` 無 Service 層

**位置：** `src/modules/air/air.controller.ts`

一個 controller function 包含：Google Geocoding → STA API → 資料整理 → Gemini AI 呼叫。  
78 行全是副作用，無法在不啟動 HTTP server 的情況下單獨測試任何一步。

---

## 5. 目標架構（To-Be）

### 分層圖

```
┌─────────────────────────────────────────────────────────┐
│  Router                                                  │
│  *.router.ts  （定義路由，套用 middleware）              │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Controller                                              │
│  *.controller.ts  （parse → call service → respond）    │
│  職責：① 驗證參數  ② 呼叫 service  ③ sendResponse()    │
│  禁止：直接查 DB、直接呼叫外部 API                       │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Service                                                 │
│  *.service.ts  （業務邏輯、協調 Adapter + Repository）  │
│  新增：a11y.service  transit.service  air.service        │
│  修改：agent-tools.ts → 委派給各 service               │
└───────────┬────────────────────────────┬────────────────┘
            │                            │
┌───────────▼──────────┐   ┌────────────▼───────────────┐
│  Adapter             │   │  Repository / Model         │
│  src/adapters/       │   │  src/model/*.model.ts       │
│  google.adapter.ts   │   │  （Mongoose 直接存取，      │
│  sta.adapter.ts      │   │   後續可再包 repository）   │
│  ors.service.ts      │   └────────────────────────────┘
│  （從 config 移出）  │
└───────────┬──────────┘
            │
┌───────────▼──────────────────────────────────────────────┐
│  外部資源                                                 │
│  Google Maps API  ·  TDX API  ·  STA API  ·  ORS API     │
│  MongoDB                                                  │
└───────────────────────────────────────────────────────────┘
```

### 各模組的 Service 分工

```
agent-tools.ts::findA11yPlaces()
  → a11y.service.ts::findNearby()       ← 共用同一份 MongoDB 查詢

agent-tools.ts::getBusArrivalEstimate()
  → transit.service.ts::getBusEta()     ← 共用同一份 TDX 查詢

agent-tools.ts::getAirQuality()
  → air.service.ts::getAirQuality()     ← 共用同一份外部 API 查詢

a11y.controller::nearbyA11y()
  → a11y.service.ts::findNearby()       ← 同上

transit.controller::getBusData()
  → transit.service.ts::getBusEta()     ← 同上
```

---

## 6. 目標目錄結構

```
src/
├── adapters/                           # ✦ 新建：外部 API 薄封裝
│   ├── google.adapter.ts               # getCity(), getCoordinates(), findPlaces()
│   │                                   # （合併自 config/map.ts + config/lib.ts:199 + agent-tools 的 findGooglePlaces）
│   └── sta.adapter.ts                  # fetchAirQuality()（從 air.controller + agent-tools 移出）
│
├── modules/
│   ├── a11y/
│   │   ├── a11y.router.ts
│   │   ├── a11y.controller.ts          # ✎ 只剩 parse + sendResponse
│   │   ├── a11y.service.ts             # ✦ 新建：findNearby(), findAll(), findByOsmId()
│   │   ├── a11y.schema.ts
│   │   └── index.ts
│   ├── transit/
│   │   ├── transit.router.ts
│   │   ├── transit.controller.ts       # ✎ 只剩 parse + sendResponse
│   │   ├── transit.service.ts          # ✦ 新建：getBusEta(), getBusPosition()
│   │   ├── transit.schema.ts
│   │   └── index.ts
│   ├── air/
│   │   ├── air.router.ts
│   │   ├── air.controller.ts           # ✎ 只剩 parse + sendResponse
│   │   ├── air.service.ts              # ✦ 新建：getAirQualityWithAI()
│   │   ├── air.schema.ts
│   │   └── index.ts
│   └── ai/
│       ├── agent-tools.ts              # ✎ 精簡：委派給各 service，不含業務邏輯
│       └── ...
│
├── service/                            # 跨模組共用（維持現有）
│   ├── ors.service.ts                  # ↗ 從 config/ors.ts 移入
│   └── ...（其餘不動）
│
└── config/                             # 純常數 + 客戶端初始化
    ├── fetch.ts                        # ✅ 維持
    ├── transit.ts                      # ✅ 維持
    ├── ai.ts                           # ✅ 維持
    ├── jwt.ts                          # ✅ 維持
    ├── lib.ts                          # ✎ 移除 getCoordinates()，僅留純工具函式
    ├── map.ts                          # ✎ 刪除（移至 adapters/google.adapter.ts）
    └── ors.ts                          # ✎ 刪除（移至 service/ors.service.ts）
```

---

## 7. 重構路線圖

> 每個 Phase 可以獨立 PR，不影響其他功能。建議由 P1 開始，先消除重複再搬移。

### Phase 1 — 新增 `a11y.service.ts`（最高優先）

**目標：** Controller 不再直接碰 DB；`agent-tools.ts` 改呼叫 service。

```typescript
// src/modules/a11y/a11y.service.ts
export async function findNearby(lat: number, lng: number, radiusM = 150) {
  const geoQuery = {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
  const [nearbyMetroA11y, nearbyBathroom, nearbyOsm] = await Promise.all([
    A11y.find({ location: geoQuery }),
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery }),
    OsmA11y.find({ location: geoQuery }),
  ]);
  return { nearbyMetroA11y, nearbyBathroom, nearbyOsm };
}

export async function findAll() {
  return A11y.find();
}

export async function findByOsmIds(ids: string[]) {
  return OsmA11y.find({ osmId: { $in: ids } }).lean();
}
```

**改動清單：**

- `a11y.controller.ts`：`nearbyA11y()`, `getA11yData()`, `getA11yPlace()` 改呼叫 service
- `agent-tools.ts`：`findA11yPlaces()`, `getA11yFacilityDetails()` 改呼叫 service

---

### Phase 2 — 新增 `transit.service.ts`

**目標：** TDX URL 組裝邏輯從 controller 移出；消除 `agent-tools.ts` 的重複。

```typescript
// src/modules/transit/transit.service.ts
export async function getBusEta(params: {
  routeName: string; departureStop: string; arrivalStop: string; city: TaiwanCityEn;
}) { ... }

export async function getBusPosition(params: {
  plateNumber: string; routeName: string; city: TaiwanCityEn;
}) { ... }
```

**改動清單：**

- `transit.controller.ts`：`getBusData()`, `getRealtimeBusPosition()` 改呼叫 service
- `agent-tools.ts`：`getBusArrivalEstimate()`, `getBusPosition()` 改呼叫 service

---

### Phase 3 — 新增 `air.service.ts`

**目標：** Google Geocode + STA API + Gemini 邏輯從 controller 移出。

```typescript
// src/modules/air/air.service.ts
export async function getAirQualityWithAI(lat: number, lng: number): Promise<AIResponse> { ... }
export async function getRawAirReadings(city: string): Promise<AirReading[]> { ... }
```

**改動清單：**

- `air.controller.ts`：`getAirQualityInfo()` 改呼叫 service
- `agent-tools.ts`：`getAirQuality()` 改呼叫 service

---

### Phase 4 — 新增 `src/adapters/google.adapter.ts`

**目標：** Google API 呼叫集中管理，方便替換 / mock。

```typescript
// src/adapters/google.adapter.ts
export async function getCity(lat: number, lng: number): Promise<string> { ... }
export async function getCoordinates(query: string, ...): Promise<Coords | null> { ... }
export async function findPlaces(query: string, ...): Promise<Place[]> { ... }
```

**改動清單：**

- 刪除 `config/map.ts`，更新所有 import
- 從 `config/lib.ts` 移除 `getCoordinates()`（其餘工具函式留下）
- `agent-tools.ts` 的 `findGooglePlaces()` 改呼叫 adapter

---

### Phase 5 — 移動 `config/ors.ts` → `service/ors.service.ts`

**目標：** config/ 不再含 HTTP 呼叫。

**改動清單：**

- 移動並重新命名
- 更新 `accessible-route.service.ts` 的 import

---

### Phase 6 — 精簡 `agent-tools.ts`

完成 Phase 1–4 後，`agent-tools.ts` 僅剩薄封裝：

```typescript
// Before（534 行，自己實作）
export async function findA11yPlaces(args) {
  const geoQuery = { $near: ... };
  const [a, b, c] = await Promise.all([A11y.find(...), ...]);
  return JSON.stringify(...);
}

// After（委派給 service）
export async function findA11yPlaces(args) {
  const coords = await resolveCoords(args);
  const result = await a11yService.findNearby(coords.lat, coords.lng, args.range);
  return JSON.stringify({ ok: true, places: result });
}
```

---

## 8. 各層職責定義

### Controller 職責（改後）

```typescript
// ✅ 正確的 controller
async function nearbyA11y(req: Request, res: Response) {
  const { lat, lng } = req.query;
  if (!lat || !lng) return sendResponse(res, false, "error", 400, "缺少參數");

  try {
    const result = await a11yService.findNearby(Number(lat), Number(lng));
    return sendResponse(res, true, "success", 200, "OK", result);
  } catch (error) {
    return sendResponse(res, false, "error", 500, "Internal Server Error");
  }
}
```

Controller **禁止**：

- `Model.find()` / `Model.save()` 直接呼叫
- `fetch()` / `axios()` 直接呼叫外部 API
- URL 組裝邏輯
- 業務規則判斷（如方向計算）

### Service 職責

- 協調多個 Model 或 Adapter 的呼叫
- 包含業務規則（方向判斷、資料合併、快取決策）
- **不直接接觸 Request / Response 物件**
- 回傳 plain object，不呼叫 `sendResponse()`

### Adapter 職責

- 封裝單一外部 API 的 HTTP 呼叫
- 負責錯誤處理與 fallback
- 介面語意化（`getCity(lat, lng)` 而非直接暴露 API URL）
- 可被 mock 以利測試

### Config 職責

- 環境變數讀取與預設值
- API 客戶端初始化（`new GoogleGenerativeAI()`, `new OpenAI()`）
- URL 前綴常數（`busUrl`, `metroUrl`）
- **不含網路呼叫、不含業務邏輯**

---

## 9. 深層結構問題：路由型別倒置依賴（Phase 8）

> 這是 v1.0 完全沒看到、也是你會覺得「架構好亂」的**真正結構性根源**。
> 它不會造成 runtime 錯誤（目前用一個 workaround 撐著），但它讓整個路由子系統的依賴方向是「反的」。

### 9.1 現象

`src/modules/accessible-route/accessible-route.service.ts` 是一個 **1995 行的巨型協調器（orchestrator）**，
它同時扮演三個角色：

1. **定義整個領域模型**：`WaitInfo`, `NearestBus`, `WalkLeg`, `BusLeg`, `MetroLeg`, `ThsrLeg`, `TraLeg`, `AccessibleRoute` 八個型別
2. **協調入口**：`findAccessibleRoutes()`
3. **被所有 planner 反向依賴的型別來源**

下層的各個 planner（位於 `src/service/`）需要這些型別，於是**向上 import**：

| 下層 planner（`src/service/`） | 向上 import 的型別                    | 行號   |
| ------------------------------ | ------------------------------------- | ------ |
| `tdx-routing.service.ts`       | AccessibleRoute, WalkLeg, …           | :34–41 |
| `otp-routing.service.ts`       | AccessibleRoute, WalkLeg, …, WaitInfo | :18–26 |
| `realtime-transit.service.ts`  | AccessibleRoute, BusLeg, TraLeg       | :46–50 |
| `facility-status.service.ts`   | AccessibleRoute, MetroLeg             | :25–28 |
| `a11y-exit.service.ts`         | WalkLeg                               | :18    |

### 9.2 依賴方向是反的（倒置）

```
        ┌─────────────────────────────────────────────┐
        │  modules/accessible-route/                   │
        │  accessible-route.service.ts (1995 行)       │
        │  ① 定義 8 個領域型別                          │
        │  ② findAccessibleRoutes() 協調器             │
        └───────▲─────────────────────────┬───────────┘
                │ import type             │ dynamic import()
                │（向上，違反分層）         │（為了繞開靜態循環）
        ┌───────┴─────────────────────────▼───────────┐
        │  src/service/ 各 planner                     │
        │  tdx-routing / otp-routing / route-a11y …    │
        └─────────────────────────────────────────────┘
```

協調器要呼叫下層 planner，但下層又向上 import 了協調器的型別 → **靜態循環依賴**。
目前的 workaround 是：協調器改用**動態 `import()`** 在 runtime 才載入 planner
（`accessible-route.service.ts:1843, 1866, 1880`），把靜態環打斷。

程式碼裡甚至留了註解承認這件事：

```ts
// Leg/route types live in the accessible-route module. Import as TYPES only so
// this service does not create a runtime circular dependency with the orchestrator.
```

> **這就是「亂」的來源**：領域模型（路由/leg 型別）的「家」放錯地方了——
> 它住在一個 module 層的協調器檔案裡，逼得每個 planner 都得向上依賴，
> 也逼得協調器只能用 lazy import 來避免循環。同時 `facility-slim.ts` 與
> 協調器之間也有一個小的模組內型別環（`SlimA11y` ↔ leg 型別）。

### 9.3 解法（Phase 8）— 把領域型別下沉到 `src/types/`

```
        ┌──────────────────────────────┐
        │  src/types/route.ts ✦新       │
        │  SlimA11y + 8 個領域型別       │
        │  （只 import IOsmA11y，向下）  │
        └───────▲───────────▲──────────┘
                │           │  都是「向下」import，乾淨
   ┌────────────┴──┐   ┌────┴─────────────────────┐
   │ src/service/  │   │ modules/accessible-route/ │
   │ 各 planner    │   │ accessible-route.service  │
   └───────────────┘   │ （可改回靜態 import）      │
                       └───────────────────────────┘
```

**改動清單（純型別搬移，零 runtime 行為改變，`tsc` 全程可驗證）：**

1. 新建 `src/types/route.ts`，放入 `SlimA11y` + 8 個領域型別（只向下 import `IOsmA11y`）
2. `accessible-route.service.ts`：移除型別定義，改 `import` + `export type {…}` re-export（向下相容 controller / transfer-finder / agent-tools）；`waitInfoMinutes()` 函式留在原地
3. `facility-slim.ts`：型別改從 `../../types/route` import（打斷模組內環）
4. 6 個 `src/service/*` planner：import 路徑改指 `../types/route`（**消除向上依賴**）
5. （選用）協調器的動態 `import()` 可改回靜態 import——循環消失後不再需要 lazy load

### 9.4 ✅ Phase 8 已執行（commit `1a5658b`）

已完成，`tsc --noEmit` 全綠、零 runtime 行為改變：

- 8 個領域型別 + `SlimA11y` 移入 `src/types/route.ts`（只向下 import `IOsmA11y`）
- 6 個 planner 全部改為**向下** import `../types/route`——已驗證 `src/service/*` 再也沒有任何檔案向上 import 協調器
- `facility-slim.ts` 也改指 `route.ts`，模組內型別環一併打斷
- `accessible-route.service.ts` 保留 import + `export type` re-export，向下相容 controller / transfer-finder / agent-tools / debug script（皆無需改動）

**關於動態 `import()`**：循環消失後，協調器的動態 import 已非必要、可改回靜態。
但我們**保留**它，因為它同時提供了「延遲載入笨重 planner 模組（含大量 model 依賴）」的效果——
這是效能取捨，與分層無關，故不在此 phase 一併變更。
