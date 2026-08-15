# 無障礙混合式交通導航系統

## Functional Specification v1.2 — ORS Hybrid Architecture

**版本**：v1.6.0  
**狀態**：Active — Phase 6-13 全數已實作（GTFS Import / GTFS Router / Indoor Graph / AI Intent / AI Explain / 多模式 / 兩次轉乘 / 即時設施狀態）  
**日期**：2026-06-10  
**作者**：yuzen9622

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [現有系統狀態（已實作）](#3-現有系統狀態已實作)
4. [系統架構](#4-系統架構)
5. [分層設計](#5-分層設計)
6. [資料模型](#6-資料模型)
7. [Routing Pipeline](#7-routing-pipeline)
8. [ORS Layer 整合設計](#8-ors-layer-整合設計)
9. [GTFS Layer](#9-gtfs-layer)
10. [Indoor Graph Layer](#10-indoor-graph-layer)
11. [無障礙引擎](#11-無障礙引擎)
12. [AI Layer](#12-ai-layer)
13. [Backend API 規格](#13-backend-api-規格)
14. [Frontend 職責邊界](#14-frontend-職責邊界)
15. [實作 Roadmap](#15-實作-roadmap)
16. [測試策略](#16-測試策略)
17. [環境變數總覽](#17-環境變數總覽)

---

## 1. 系統概述

本系統為多模態無障礙導航平台，整合以下技術棧運作：

| 組件                         | 角色                                   | 實作狀態                              |
| ---------------------------- | -------------------------------------- | ------------------------------------- |
| **OpenRouteService (ORS)**   | 步行 / 輪椅路徑引擎（First/Last Mile） | ✅ `src/config/ors.ts`                |
| **GTFS（來源：TDX）**        | 大眾運輸路由圖主要資料層               | 📋 `src/scripts/import-gtfs-*.ts`     |
| **TDX 台灣交通資料平台**     | 即時資料補強（班次位置、設施狀態）     | ✅ `src/config/transit.ts`            |
| **Indoor Graph**             | 車站室內路徑                           | ✅ `src/service/a11y-exit.service.ts` |
| **Accessibility Engine**     | 無障礙評分與路徑成本                   | ✅ `src/config/a11y-scoring.ts`       |
| **Google Gemini / AI Layer** | 語意解析與路徑說明                     | ✅ `src/modules/chatbot/`             |
| **MongoDB + Redis**          | 資料持久化 + walk-time 快取            | ✅ `src/config/redis.ts`              |

**系統定位**：ORS 驅動的混合式無障礙圖論導航系統，針對臺灣大眾運輸環境與輪椅使用者需求特化。

---

## 2. 系統目標

### 2.1 核心能力

- 跨交通系統導航（步行 + 公車 + 捷運 + 高鐵 + 台鐵）
- 無障礙優先路徑（輪椅、行動不便、視障）
- 車站內部導航（電梯、閘門、月台）
- 多候選路徑輸出（依時間 / 無障礙等級 / 轉乘次數排序）
- AI 語意輸入解析（自然語言 → 結構化路徑請求）

### 2.2 非功能目標

| 目標                  | 說明                                        |
| --------------------- | ------------------------------------------- |
| ORS 為核心 routing    | 不自建 global routing，由 ORS 負責          |
| Backend 統一處理      | 所有 routing 邏輯在 backend，前端僅 render  |
| 可替換 ORS            | 透過 `src/config/ors.ts` 抽象層，可切換引擎 |
| 快取優先              | ORS 呼叫結果快取於 Redis（7天 TTL）         |
| 無障礙 as first-class | 所有路段均計算無障礙分數，非事後加工        |

---

## 3. 現有系統狀態（已實作）

本節記錄 `feat/hybrid-transit-routing` 分支截至 commit `ddfdff6` 已完成的功能，供後續 phase 開發時不重複實作。

### 3.1 已完成 Phase

| Phase       | 功能                                       | 核心檔案                      |
| ----------- | ------------------------------------------ | ----------------------------- |
| **Phase 1** | 直達路線查詢（公車 / 捷運 / 高鐵 / 台鐵）  | `accessible-route.service.ts` |
| **Phase 2** | `findReachableStops` — ORS Matrix 步行過濾 | `reachable-stops.service.ts`  |
| **Phase 3** | 一次轉乘路線組合                           | `transfer-finder.ts`          |
| **Phase 4** | 轉乘複合鍵去重 + `transferCount`           | `accessible-route.service.ts` |
| **Phase 5** | TRTC 車站無障礙出口室內導航                | `a11y-exit.service.ts`        |

### 3.2 已建立的核心基礎設施

```
src/
├── config/
│   ├── ors.ts              # ORS 客戶端：orsWalkingRoute() + orsWalkingMatrix()
│   ├── a11y-scoring.ts     # 無障礙評分：Tier 1-4 權重，文獻依據
│   ├── route-matcher.ts    # TDX 路線名稱模糊匹配
│   └── redis.ts            # Walk-time 快取（ioredis）
├── service/
│   ├── reachable-stops.service.ts  # 地理可達站點查詢
│   ├── a11y-exit.service.ts        # TRTC 電梯 / 坡道出口
│   └── walk-cache.service.ts       # Redis 快取管理
├── model/
│   ├── metro-station.model.ts      # 捷運站（TRTC/NTMC/KLRT/TMRT/KRTC）
│   ├── train-station.model.ts      # 台鐵 / 高鐵站
│   ├── bus-stop.model.ts           # 公車站（城市 / 跨城市）
│   ├── a11y.model.ts               # TRTC 無障礙出入口
│   └── osm-a11y.model.ts           # OSM 無障礙節點
└── modules/accessible-route/
    ├── accessible-route.controller.ts
    ├── accessible-route.service.ts
    ├── transfer-finder.ts
    └── accessible-route.schema.ts
```

### 3.3 現有路由系統已知問題

以下問題是引入 GTFS 的主要動機：

| 問題                            | 根因                        | GTFS 解法                   |
| ------------------------------- | --------------------------- | --------------------------- |
| 公車路線 polyline 不準確        | TDX API 無 shapes 資料      | `shapes.txt` 提供真實幾何   |
| 站點順序錯誤或缺失              | TDX stop sequence 有缺      | `stop_times.txt` 有完整序列 |
| 轉乘連結依賴 800m 地理估算      | 無官方轉乘定義              | `transfers.txt` 精確定義    |
| 時刻不準 / 無法計算精確候車時間 | 依賴 TDX realtime（不穩定） | `stop_times.txt` 靜態時刻   |
| 跨城市公車路線覆蓋不完整        | TDX API 分城市查詢有漏      | GTFS feed 涵蓋所有系統      |

### 3.3 現有 API

```
POST /api/v1/a11y/accessible-route   # 主路由查詢端點
POST /api/v1/transit/bus             # 公車路線查詢
GET  /api/v1/transit/bus/realtime    # 公車即時位置
POST /api/v1/a11y/chat              # AI 無障礙問答
GET  /api/v1/a11y/*                 # 無障礙 POI 查詢
```

---

## 4. 系統架構

### 4.1 請求流程

```
Client Request
      ↓
Express (src/app.ts)
      ↓
Zod Validation Middleware (src/middleware/validate-request.middleware.ts)
      ↓
Route Controller (src/modules/accessible-route/accessible-route.controller.ts)
      ↓
┌─────────────────────────────────────────┐
│         Route Orchestrator              │
│  accessible-route.service.ts            │
│                                         │
│  ┌──────────┐  ┌──────────────────────┐ │
│  │ AI Layer │  │ Geocoding (Google)   │ │
│  │(Gemini)  │  │ src/config/map.ts    │ │
│  └──────────┘  └──────────────────────┘ │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │     ORS Layer                    │   │
│  │  src/config/ors.ts               │   │
│  │  orsWalkingRoute()               │   │
│  │  orsWalkingMatrix()              │   │
│  └──────────────────────────────────┘   │
│                                         │
│  ┌──────────┐  ┌──────────────────────┐ │
│  │   TDX   │  │  Indoor Graph        │ │
│  │  Layer  │  │  a11y-exit.service   │ │
│  └──────────┘  └──────────────────────┘ │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │   Accessibility Engine           │   │
│  │   src/config/a11y-scoring.ts     │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
      ↓
Route Aggregation + Ranking
      ↓
ApiResponse<AccessibleRouteData>
```

### 4.2 資料流向

```
data/gtfs/  (單一 flat 目錄，所有交通系統合一)
  ├── stops.txt        161,636 筆 → GtfsStop model
  ├── routes.txt         8,910 筆 → GtfsRoute model
  ├── trips.txt        148,720 筆 → GtfsTrip model
  ├── stop_times.txt 4,966,406 筆 → GtfsStopTime model   ← 路由核心
  ├── shapes.txt     5,409,301 筆 → GtfsShape model      ← 路線幾何
  ├── calendar.txt     135,993 筆 → GtfsCalendar model
  ├── calendar_dates.txt 4,640 筆 → （合併至 GtfsCalendar）
  ├── pathways.txt      10,221 筆 → GtfsPathway model    ← 室內導航核心
  ├── levels.txt         7,232 筆 → GtfsLevel model      ← 樓層資訊
  ├── frequencies.txt    7,365 筆 → GtfsFrequency model  ← 班距制排班
  └── ⚠️ 以下不匯入（與路由無關或資料量過大）
      fare_attributes.txt   3,842,022 筆
      fare_leg_rules.txt   28,196,030 筆
      fare_products.txt    28,196,030 筆
      fare_rules.txt        3,842,022 筆
      fare_media.txt              2 筆
      rider_categories.txt       59 筆
      areas.txt / stop_areas.txt / translations.txt

MongoDB (Atlas)
  ├── GtfsStop        ← stops.txt（含 location_type 0/1/2/3）
  ├── GtfsRoute       ← routes.txt
  ├── GtfsTrip        ← trips.txt
  ├── GtfsStopTime    ← stop_times.txt
  ├── GtfsShape       ← shapes.txt（points 聚合為 LineString）
  ├── GtfsCalendar    ← calendar.txt + calendar_dates.txt 合併
  ├── GtfsPathway     ← pathways.txt（室內圖，含電梯/樓梯/閘門）
  ├── GtfsLevel       ← levels.txt
  ├── GtfsFrequency   ← frequencies.txt
  ├── A11y            ← 台灣內政部 TRTC 無障礙出入口（保留輔助）
  ├── OsmA11y         ← OpenStreetMap（保留輔助）
  └── MetroStation / TrainStation / BusStop ← 保留，供顯示 / 設施查詢

TDX API (即時補強)
  ├── 公車即時位置
  ├── 捷運設施狀態（電梯故障）
  └── OAuth token 管理

ORS API (步行 / 輪椅)
  ├── /directions/foot-walking
  ├── /directions/wheelchair
  └── /matrix/foot-walking

Redis Cache
  └── walk-time pairs (7-day TTL)
```

---

## 5. 分層設計

### 5.1 ORS Layer — 核心路徑引擎

**職責**：城市級步行 / 輪椅 routing、起迄點到站點的步行時間矩陣

**現有實作**：`src/config/ors.ts`

```typescript
// 現有介面
orsWalkingRoute(origin: LatLng, destination: LatLng): Promise<OrsRoute>
orsWalkingMatrix(source: LatLng, destinations: LatLng[]): Promise<number[]>
```

**ORS Profile 對應**

| 場景              | ORS Profile    | 說明               |
| ----------------- | -------------- | ------------------ |
| 一般步行段        | `foot-walking` | 預設步行路段       |
| 輪椅模式          | `wheelchair`   | 坡道限制、門檻過濾 |
| 起點 → 捷運站     | `foot-walking` | 進站步行           |
| 車站出口 → 目的地 | `foot-walking` | 離站步行           |
| Matrix 計算       | `foot-walking` | 可達站點過濾       |

**Fallback 策略**：ORS API Key 不存在或呼叫失敗時，退回 Haversine 直線距離 × 1.4 係數估算。

**快取策略**（`src/service/walk-cache.service.ts`）：

```
Key: walk:{lat1},{lng1}:{lat2},{lng2}
TTL: 7 days
Storage: Redis
Pattern: fire-and-forget write, synchronous read
```

---

### 5.2 TDX Layer — 即時資料補強層

> **v1.3 架構調整**：TDX 的靜態路由職責（時刻、站點序列、路線幾何）移交給 GTFS Layer。TDX 保留即時動態資料的職責。

**現有實作**：`src/config/transit.ts`、`src/config/fetch.ts`、`src/service/TdxTokenManger.ts`

#### v1.3 後 TDX 職責範圍

| 職責         | TDX Endpoint                           | 狀態      |
| ------------ | -------------------------------------- | --------- |
| 公車即時位置 | `/Bus/RealTimeByFrequency`             | ✅ 保留   |
| 捷運設施狀態 | `/Rail/Metro/{system}/StationFacility` | ✅ 保留   |
| 高鐵即時誤點 | `/Rail/THSR/RealTimeStatus`            | 📋 待整合 |
| OAuth token  | `client_credentials` flow              | ✅ 保留   |

#### TDX Token 管理

`TdxTokenManger`（singleton）處理 OAuth2 `client_credentials` 流程：

- 自動取得 token
- 401 時自動 refresh
- 所有 TDX 呼叫經由 `tdxFetch()` 統一注入 Bearer token

---

### 5.3 Indoor Graph Layer — 車站室內導航

**職責**：車站出入口與無障礙設施（電梯、坡道）的室內路徑

**現有實作**：`src/service/a11y-exit.service.ts`

#### 現有能力（TRTC 特化）

```typescript
// 查詢最近的無障礙出口
findNearestA11yExit(stationName: string, userLocation: LatLng): Promise<A11yExit>

// 出口資料結構
type A11yExit = {
  exitNumber: string   // "1號出口"
  type: "elevator" | "ramp"
  location: { lat: number; lng: number }
  name: string
}
```

#### 資料來源

- **A11y collection**：台灣內政部 TRTC 電梯 / 無障礙坡道名稱 + 座標
- 名稱格式解析：`"臺北車站3號出口電梯"` → `{ exitNumber: "3", type: "elevator" }`

#### 室內 Graph 規則

```
stairs     → cost = INF（輪椅模式下不可通行）
elevator   → cost = preferred（優先選取）
ramp       → cost = preferred（次優）
flat walk  → cost = normal
```

#### 擴充計畫（Phase 6+）

未來可擴充至非 TRTC 系統（NTMC / KLRT / TMRT / KRTC）：

- ORS exit point → indoor entry node mapping
- 電梯位置資料來源：OSM `highway=elevator` nodes（已匯入 `OsmA11y`）

---

### 5.4 Accessibility Engine — 核心差異化

**職責**：無障礙路徑成本計算、路段評分、路線排序

**現有實作**：`src/config/a11y-scoring.ts`（605 行）

#### 評分公式

```
Route Score (0-100) =
  facilityScore × 0.65    // 設施品質（電梯有無、坡道、無障礙廁所）
+ travelTimeScore × 0.35  // 行程效率（相對最短路線的時間比）
```

#### Tier 分級（文獻依據：CHI25, Huang25, MDPI Scoping Review 2025）

| Tier   | 特徵             | 評分影響                    |
| ------ | ---------------- | --------------------------- |
| Tier 1 | 電梯、無障礙坡道 | Critical — 缺少直接降分 30+ |
| Tier 2 | 無障礙廁所、停車 | High — 各 +10~15            |
| Tier 3 | 觸覺引導         | Medium — 各 +5~8            |
| Tier 4 | 輔助聽覺         | Low — 各 +2~3               |

#### 評分標籤

| Score  | Label     |
| ------ | --------- |
| 85-100 | excellent |
| 70-84  | good      |
| 50-69  | fair      |
| 30-49  | poor      |
| 0-29   | critical  |

#### 無障礙模式

| Mode              | 特殊行為                                            |
| ----------------- | --------------------------------------------------- |
| `wheelchair`      | Tier 1 缺失 = 路線排除；ORS 使用 wheelchair profile |
| `elderly`         | Tier 1 + Tier 2 權重提升；坡度限制放寬              |
| `visual_impaired` | 觸覺引導（Tier 3）提升為 critical                   |
| `normal`          | 標準評分，無排除規則                                |

---

### 5.5 AI Layer — 語意層

**職責**：自然語言解析、路線說明生成、fallback 建議

**現有實作**：`src/modules/chatbot/`、`src/config/ai/`

#### 目前架構

- 模型：`gemini-2.5-flash`（`src/config/ai.ts`）
- Tool calling 流程（2-step loop）：
  1. 第一次呼叫 → Gemini 可能回傳 function call
  2. Tool 執行（`findGooglePlaces` / `findA11yPlaces` / `planRoute`）
  3. 第二次呼叫 → 生成文字說明

#### Intent Parsing Schema

```typescript
// 路由查詢意圖解析輸出
type RouteIntent = {
  from: string; // 起點（中文地址或地標）
  to: string; // 終點
  mode: AccessibilityMode;
  departureTime?: string; // ISO 8601 或 "now"
  preferences?: {
    minimizeTransfers?: boolean;
    preferElevator?: boolean;
  };
};
```

#### Route Explanation Schema

```typescript
type RouteExplanation = {
  summary: string; // 一句話摘要
  accessibilityHighlights: string[]; // ["全程電梯", "無須跨越平交道"]
  warnings: string[]; // ["3號出口電梯可能有維修"]
  alternatives?: string; // fallback 建議
};
```

---

## 6. 資料模型

### 6.1 核心節點型別（Node）

```typescript
// 現有 MongoDB 集合的統一視圖
type RoutingNode = {
  id: string;
  name: string;
  type: "BUS_STOP" | "METRO_STATION" | "TRAIN_STATION" | "INDOOR_NODE";
  location: {
    lat: number;
    lng: number;
  };
  railSystem?: "TRTC" | "NTMC" | "KLRT" | "TMRT" | "KRTC" | "THSR" | "TRA";
  lineIds?: string[];
  accessibility?: {
    hasElevator: boolean;
    hasRamp: boolean;
    hasAccessibleToilet: boolean;
    accessibilityScore: number;
  };
};
```

### 6.2 路段型別（Leg）

```typescript
// 現有 leg 型別（已實作）
type WalkLeg = {
  type: "WALK";
  from: string;
  to: string;
  distanceM: number;
  minutesEst: number;
  polyline: string; // Google encoded polyline
  a11yFacilities: OsmA11yFeature[];
  exitInfo?: A11yExit; // Indoor graph 出口資訊
};

type BusLeg = {
  type: "BUS";
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  waitInfo: WaitInfo;
  direction: number;
  polyline: string;
  departureStopA11y: A11yFeatures;
  arrivalStopA11y: A11yFeatures;
  nearestBus?: BusRealTimeInfo;
};

type MetroLeg = {
  type: "METRO";
  railSystem: string;
  lineName: string;
  departureStation: string;
  arrivalStation: string;
  rideMinutes: number;
  waitInfo: WaitInfo;
  polyline: string;
  facilityHighlights: string[];
};

type ThsrLeg = {
  type: "THSR";
  trainNo: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  polyline: string;
};

type TraLeg = {
  type: "TRA";
  trainNo: string;
  trainTypeName: string;
  departureTime: string;
  arrivalTime: string;
  polyline: string;
};
```

### 6.3 路線型別（Route）

```typescript
type AccessibleRoute = {
  routeId: string;
  routeName: string; // "捷運直達", "公車一次轉乘" 等
  totalMinutes: number;
  transferCount: 0 | 1; // 目前支援 0 或 1 次轉乘
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[];
  accessibilityHighlights: string[];
  accessibilityScore: number; // 0-100
  accessibilityLabel: "excellent" | "good" | "fair" | "poor" | "critical";
  scoreComponents: RouteAccessibilityScore;
  source: ("ORS" | "TDX" | "INDOOR" | "A11Y_ENGINE")[];
};
```

### 6.4 API Response 包裝

```typescript
// 統一使用 sendResponse() from src/config/lib.ts
ApiResponse<AccessibleRouteData> = {
  ok: boolean
  status: "success" | "error"
  code: number
  message: string
  data?: {
    routes: AccessibleRoute[]          // 最多 3 條
    intent?: RouteIntent               // AI 解析的意圖（若輸入為自然語言）
    explanation?: RouteExplanation     // AI 說明（若啟用）
  }
}
```

---

## 7. Routing Pipeline

### 7.1 主流程

```
使用者輸入（結構化 / 自然語言）
           ↓
[AI Layer] Intent Parsing（若輸入為自然語言）
           ↓
[Geocoding] Google Maps → lat/lng（accessible-route.controller.ts）
           ↓
[ORS Matrix] 起點 / 終點步行可達站點
  → 查詢 GtfsStop（$near + wheelchairBoarding 過濾）
  → orsWalkingMatrix() 計算實際步行時間
  → 篩選 ≤ 20 分鐘可達站點
           ↓
[GTFS Router] 班次查詢
  → 直達：GtfsStopTime 查詢 stopA → stopB 同 trip 班次（board seq < alight seq）
  → 轉乘：同站轉乘 hub 以 stop_name + 鄰近度匹配（非 parent_station）
  → GtfsCalendar 過濾今日有效服務（週期 + calendar_dates 例外）
  → frequencies.txt headway 制：以 trip 錨點計算下班次出發
  → 候選路線組合（最多 10 條）
           ↓
[GTFS Shapes] 路線幾何
  → GtfsTrip → shapeId → GtfsShape → BusLeg.polyline
           ↓
[Phase 5] Indoor Graph
  → 目的地若為捷運車站 → a11y-exit.service.ts
  → 查詢最近電梯 / 坡道出口（GtfsStop.wheelchairBoarding 補強）
           ↓
[A11y Engine] 評分
  → a11y-scoring.ts 計算每條路線分數
  → scoreAndRank() 排序
           ↓
[Route Aggregation]
  → 複合鍵去重
  → 取前 3 條
           ↓
[TDX Realtime] 疊加即時資料
  → 公車即時位置 → BusLeg.nearestBus
  → 捷運設施狀態 → MetroLeg.facilityHighlights 警告
           ↓
[AI Layer] Explanation Generation（選配）
           ↓
ApiResponse<AccessibleRouteData>
```

### 7.2 步行段與 ORS 整合

每個 WalkLeg 的 polyline 來源：

| 場景              | 資料來源                     |
| ----------------- | ---------------------------- |
| 起點 → 第一個站點 | `orsWalkingRoute()`          |
| 末站 → 終點       | `orsWalkingRoute()`          |
| 轉乘間步行        | `orsWalkingRoute()`（預估）  |
| Matrix 時間估算   | `orsWalkingMatrix()`（快取） |

### 7.3 轉乘預算限制

| 參數       | 值       | 說明                 |
| ---------- | -------- | -------------------- |
| 步行預算   | 20 分鐘  | 可達站點最大步行時間 |
| 步行速度   | 60 m/min | 估算距離 → 時間      |
| 轉乘距離   | 800 m    | 轉乘站點預過濾閾值   |
| 最大路線數 | 3        | 最終回傳候選路線數   |

---

## 8. ORS Layer 整合設計

### 8.1 API 呼叫規格

```http
POST https://api.openrouteservice.org/v2/directions/{profile}
Authorization: Bearer {ORS_API_KEY}
Content-Type: application/json
```

#### 步行路線請求

```json
{
  "coordinates": [[lng1, lat1], [lng2, lat2]],
  "instructions": true,
  "geometry": true,
  "units": "m",
  "extra_info": ["surface", "waycategory"],
  "options": {
    "profile_params": {
      "restrictions": {
        "maximum_sloped_kerb": 0.06,
        "maximum_incline": 6,
        "minimum_width": 1.0
      }
    }
  }
}
```

#### Matrix 請求（可達站點過濾）

```json
{
  "locations": [[lng_src, lat_src], [lng_dst1, lat_dst1], ...],
  "sources": [0],
  "destinations": [1, 2, 3, ...],
  "metrics": ["duration"],
  "units": "m"
}
```

### 8.2 輸出處理

| ORS 輸出欄位          | 系統用途            |
| --------------------- | ------------------- |
| `geometry` (polyline) | WalkLeg.polyline    |
| `duration` (seconds)  | WalkLeg.minutesEst  |
| `distance` (meters)   | WalkLeg.distanceM   |
| `segments[].steps`    | 未來逐步指引        |
| `matrix durations`    | 可達站點過濾 + 快取 |

### 8.3 錯誤處理

```
ORS 呼叫失敗
  ↓
檢查 Redis 是否有快取
  ↓（無快取）
Haversine fallback：distance × 1.4 / 60 = minutes
  ↓
標記 leg.polyline = null（前端降級顯示直線）
```

---

## 9. GTFS Layer（主要運輸路由資料層）

GTFS 是 v1.3 起所有公共運輸路由決策的主要資料來源，取代原本在 query 時直接呼叫 TDX API 的方式。GTFS 檔案來自 TDX GTFS Download API，預先匯入 MongoDB，供路由引擎查詢。

### 9.1 檔案來源與放置位置

GTFS 資料為**單一 flat 目錄**，所有交通系統（公車、捷運、台鐵、高鐵、渡輪、航空）合併在同一份 feed。

```
accessible-smart-map-backend/
└── data/
    └── gtfs/                  ← 單一 flat 目錄（加入 .gitignore）
        ├── agency.txt
        ├── stops.txt          ← 含 location_type 0/1/2/3，無 wheelchair_boarding
        ├── routes.txt         ← route_type: 1=捷運, 2=鐵路, 3=公車, 4=渡輪
        ├── trips.txt
        ├── stop_times.txt     ← 4,966,406 筆
        ├── shapes.txt         ← 5,409,301 筆
        ├── calendar.txt
        ├── calendar_dates.txt
        ├── frequencies.txt    ← headway-based 排班（捷運 / 部分公車）
        ├── pathways.txt       ← 10,221 筆室內路徑（電梯/樓梯/閘門）
        ├── levels.txt         ← 7,232 筆樓層定義
        ├── fare_*.txt         ← ⚠️ 不匯入（28M+ 筆，與路由無關）
        └── ...其他輔助檔案
```

#### stops.txt 欄位（實際）

```
stop_id, stop_name, stop_lat, stop_lon, zone_id, location_type, parent_station, level_id
```

> ⚠️ **無 `wheelchair_boarding` 欄位**。無障礙資訊須從 `pathways.txt` 推導（電梯路徑存在 = 該站有無障礙通道）。

#### location_type 分佈

| location_type | 含義                         | 筆數    |
| ------------- | ---------------------------- | ------- |
| 0             | Stop / Platform（搭乘點）    | 154,825 |
| 1             | Station（站體建築，parent）  | 247     |
| 2             | Entrance / Exit（出入口）    | 686     |
| 3             | Generic Node（室內路徑節點） | 5,876   |

#### route_type 分佈

| route_type | 含義                         | 筆數  |
| ---------- | ---------------------------- | ----- |
| 1          | 捷運（Subway / Metro）       | 47    |
| 2          | 鐵路（TRA 台鐵 / THSR 高鐵） | 245   |
| 3          | 公車（Bus）                  | 8,565 |
| 4          | 渡輪（Ferry）                | 49    |

---

### 9.2 MongoDB GTFS 資料模型

#### GtfsStop（`src/model/gtfs-stop.model.ts`）

```typescript
interface IGtfsStop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
  zoneId?: string;
  locationType: 0 | 1 | 2 | 3; // 0=搭乘點, 1=站體, 2=出入口, 3=室內節點
  parentStation?: string; // location_type 1 站體的 stop_id
  levelId?: string; // 關聯 GtfsLevel
  location: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
  // ⚠️ 無 wheelchair_boarding 欄位（TDX GTFS 未提供）
  // 無障礙可達性從 GtfsPathway.pathwayMode = 5 推導
}
// Index: location (2dsphere，僅 locationType 0/2), stopId (unique)
```

#### GtfsRoute（`src/model/gtfs-route.model.ts`）

```typescript
interface IGtfsRoute {
  routeId: string;
  agencyId: string;
  routeShortName: string; // e.g. "307", "板南線"
  routeLongName: string;
  routeType: 1 | 2 | 3 | 4; // 1=捷運, 2=鐵路, 3=公車, 4=渡輪
}
// Index: routeId (unique), routeShortName
```

#### GtfsTrip（`src/model/gtfs-trip.model.ts`）

```typescript
interface IGtfsTrip {
  tripId: string;
  routeId: string;
  serviceId: string; // 關聯 GtfsCalendar
  shapeId?: string; // 關聯 GtfsShape（公車 / 鐵路有值，部分可能為空）
  directionId: 0 | 1;
  bikesAllowed?: 0 | 1 | 2;
  // ⚠️ tripHeadsign 在此 feed 中未出現
}
// Index: tripId (unique), routeId, serviceId
```

#### GtfsStopTime（`src/model/gtfs-stop-time.model.ts`）

> 4,966,406 筆，資料量最大。Index 設計直接影響查詢效能。

```typescript
interface IGtfsStopTime {
  tripId: string;
  stopId: string;
  stopSequence: number; // 站點序號，路線順序依據
  arrivalTime: string; // "HH:MM:SS"，可超過 "24:00:00"（跨日班次）
  departureTime: string;
}
// ⚠️ pickup_type / drop_off_type 欄位在此 feed 未提供，不建模
// Index: { tripId: 1, stopSequence: 1 }, { stopId: 1, departureTime: 1 }
```

#### GtfsShape（`src/model/gtfs-shape.model.ts`）

> 原始 5,409,301 筆 shape points，import 時**聚合為每個 shapeId 一份 LineString**。

```typescript
interface IGtfsShape {
  shapeId: string;
  geometry: {
    type: "LineString";
    coordinates: [number, number][]; // [lng, lat]，依 shape_pt_sequence 排序
  };
}
// Index: shapeId (unique)
```

#### GtfsCalendar（`src/model/gtfs-calendar.model.ts`）

```typescript
interface IGtfsCalendar {
  serviceId: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startDate: string; // "YYYYMMDD"
  endDate: string;
  exceptions: {
    // calendar_dates.txt 合併儲存
    date: string; // "YYYYMMDD"
    exceptionType: 1 | 2; // 1=加班, 2=停駛
  }[];
}
// Index: serviceId (unique)
```

#### GtfsPathway（`src/model/gtfs-pathway.model.ts`）

> **室內導航核心**。10,221 筆，涵蓋電梯、樓梯、閘門等站內路徑。

```typescript
interface IGtfsPathway {
  pathwayId: string;
  fromStopId: string; // 關聯 GtfsStop（locationType 0/2/3）
  toStopId: string;
  pathwayMode:
    | 1 // walkway（步道）
    | 2 // stairs（樓梯）← 輪椅模式禁止
    | 3 // moving sidewalk（水平電扶梯）
    | 4 // escalator（電扶梯）
    | 5 // elevator（電梯）← 輪椅模式優先
    | 6 // fare gate（驗票閘門）
    | 7; // exit gate（出站閘門）
  isBidirectional: 0 | 1;
  traversalTime?: number; // 秒
  stairCount?: number; // 正=向上, 負=向下
}
// Index: fromStopId, toStopId, pathwayMode
```

**pathway_mode 分佈（實際資料）**：

| mode | 含義             | 筆數  | 輪椅模式    |
| ---- | ---------------- | ----- | ----------- |
| 1    | 步道 walkway     | 6,718 | ✅ 可通行   |
| 2    | 樓梯 stairs      | 1,079 | ❌ 不可通行 |
| 3    | 水平電扶梯       | 3     | ✅ 可通行   |
| 4    | 電扶梯 escalator | 955   | ⚠️ 視方向   |
| 5    | 電梯 elevator    | 714   | ✅ 優先     |
| 6    | 驗票閘門         | 405   | ✅ 視寬度   |
| 7    | 出站閘門         | 346   | ✅ 視寬度   |

#### GtfsLevel（`src/model/gtfs-level.model.ts`）

```typescript
interface IGtfsLevel {
  levelId: string;
  levelIndex: number; // 負數 = 地下（如 -1=閘門層, -2=月台層）
  levelName: string; // e.g. "閘門一(外)", "月台"
}
// Index: levelId (unique)
```

#### GtfsFrequency（`src/model/gtfs-frequency.model.ts`）

> 部分路線（捷運 / 高頻公車）使用班距制排班，**需配合 GtfsStopTime 計算出發時間**。

```typescript
interface IGtfsFrequency {
  tripId: string;
  startTime: string; // "HH:MM:SS"，服務起始時間
  endTime: string; // "HH:MM:SS"，服務結束時間
  headwaySecs: number; // 班距（秒）
}
// Index: tripId
```

---

### 9.3 Import Pipeline

> 單一 flat 目錄，一次匯入全部系統。

#### Import Scripts（`src/scripts/`）

```
src/scripts/
├── import-gtfs-stops.ts      # stops.txt → GtfsStop
├── import-gtfs-routes.ts     # routes.txt → GtfsRoute
├── import-gtfs-trips.ts      # trips.txt → GtfsTrip
├── import-gtfs-stop-times.ts # stop_times.txt → GtfsStopTime（最慢，497萬筆）
├── import-gtfs-shapes.ts     # shapes.txt → GtfsShape（聚合 540萬點）
├── import-gtfs-calendar.ts   # calendar.txt + calendar_dates.txt → GtfsCalendar
├── import-gtfs-pathways.ts   # pathways.txt → GtfsPathway
├── import-gtfs-levels.ts     # levels.txt → GtfsLevel
├── import-gtfs-frequencies.ts# frequencies.txt → GtfsFrequency
└── import-gtfs-all.ts        # 依序執行以上全部（建議分批）
```

#### Import 流程

```
1. 讀取 data/gtfs/*.txt
2. 串流解析 CSV（Node.js readline，避免一次性讀入大檔）
3. 批次 bulkWrite（每批 1000 筆），以唯一鍵 upsert
4. shapes.txt → 先 groupBy shapeId，再聚合 points 為 LineString
5. calendar.txt + calendar_dates.txt → 合併為單一 GtfsCalendar document
6. ⚠️ fare_*.txt 跳過不處理
7. 完成後輸出：匯入筆數 / 耗時 / 錯誤數
```

#### 執行指令

```bash
# 建立 Index 後再匯入（先 index 後 insert 較快）
npx ts-node src/scripts/import-gtfs-all.ts
```

#### 預估匯入時間

| 檔案            | 筆數           | 預估時間       |
| --------------- | -------------- | -------------- |
| stops.txt       | 161K           | < 1 min        |
| routes.txt      | 8.9K           | < 30s          |
| trips.txt       | 148K           | < 2 min        |
| stop_times.txt  | 4.97M          | 10-20 min      |
| shapes.txt      | 5.41M → 聚合後 | 10-20 min      |
| pathways.txt    | 10.2K          | < 1 min        |
| calendar.txt    | 136K           | < 2 min        |
| frequencies.txt | 7.4K           | < 30s          |
| **合計**        |                | **~30-45 min** |

---

### 9.4 路由引擎如何使用 GTFS

#### 站點查詢（取代 findReachableStops 的資料來源）

```typescript
// 查詢起點附近可搭乘的 GTFS 站點（僅 locationType=0 的搭乘點）
GtfsStop.find({
  locationType: 0,
  location: { $near: { $geometry: point, $maxDistance: 1200 } },
});
// ⚠️ 無 wheelchairBoarding，輪椅過濾改由 GtfsPathway 推導（見 Section 10）
```

#### 班次查詢（取代 TDX timetable API）

```typescript
// 查詢從 stopA → stopB 的下一班次
// Step 1: 找所有在 stopA 且出發時間 >= 現在的 stop_times
const departures = await GtfsStopTime.find({
  stopId: stopA,
  departureTime: { $gte: currentTimeStr }, // "HH:MM:SS"
}).sort({ departureTime: 1 });

// Step 2: 對每個 tripId，確認 stopB 在 stopA 之後
const arrival = await GtfsStopTime.findOne({
  tripId: trip.tripId,
  stopId: stopB,
  stopSequence: { $gt: departureSequence },
});

// Step 3: 過濾今日有效 serviceId
const calendar = await GtfsCalendar.findOne({ serviceId: trip.serviceId });
if (!isTripActiveToday(calendar, today)) continue;
```

#### 班距制路線查詢（frequencies.txt）

部分路線（捷運、高頻公車）使用 `frequencies.txt` 而非固定時刻：

```typescript
// 查詢 tripId 是否有 frequency-based 服務
const freq = await GtfsFrequency.findOne({
  tripId,
  startTime: { $lte: currentTimeStr },
  endTime: { $gte: currentTimeStr },
});

if (freq) {
  // 下一班 = ceil((now - startTime) / headwaySecs) * headwaySecs + startTime
  const waitSecs =
    freq.headwaySecs - ((nowSecs - startSecs) % freq.headwaySecs);
  // 以 stop_times 中的相對時間 + 下一班出發時間計算到站時刻
}
```

#### 路線幾何（shapes → BusLeg / MetroLeg polyline）

```typescript
const trip = await GtfsTrip.findOne({ tripId });
if (trip.shapeId) {
  const shape = await GtfsShape.findOne({ shapeId: trip.shapeId });
  // shape.geometry (GeoJSON LineString) → 轉為 Google encoded polyline
}
```

#### 轉乘（無 transfers.txt → 地理接近判斷）

> ⚠️ 此 GTFS feed **無 `transfers.txt`**。轉乘連結改用：
>
> 1. `GtfsStop.$near` 查詢同站體（相同 `parent_station`）的不同月台
> 2. ORS Matrix 計算兩站間步行時間（現有邏輯保留）

```typescript
// 同站體轉乘：parent_station 相同的站點
const platformsInSameStation = await GtfsStop.find({
  parentStation: parentStationId,
  locationType: 0,
});
```

---

### 9.5 GTFS 服務日期過濾

```typescript
function isTripActiveToday(calendar: IGtfsCalendar, date: Date): boolean {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ] as const;
  const dayOfWeek = days[date.getDay()];
  const dateStr = formatYYYYMMDD(date); // "YYYYMMDD"

  // calendar_dates 例外優先
  const exception = calendar.exceptions.find((e) => e.date === dateStr);
  if (exception) return exception.exceptionType === 1; // 1=加班, 2=停駛

  // 一般服務日
  return (
    dateStr >= calendar.startDate &&
    dateStr <= calendar.endDate &&
    calendar[dayOfWeek]
  );
}
```

---

### 9.6 GTFS 更新策略

| 頻率 | 動作                                               |
| ---- | -------------------------------------------------- |
| 每週 | 重新從 TDX 下載 GTFS，執行 `import-gtfs-all.ts`    |
| 每日 | 僅更新 `calendar_dates.txt`（補登 / 停駛例外）     |
| 即時 | 班次延誤由 TDX realtime API 疊加於 GTFS 計算結果上 |

---

## 10. Indoor Graph Layer

> **v1.3 架構調整**：室內導航主要資料源從 TRTC 專用的 `A11y` collection，**升級為 GTFS `pathways.txt`**。pathways 涵蓋所有系統的完整站內路徑圖（10,221 筆），包含電梯、樓梯、閘門、出入口連結。

### 10.1 GTFS Pathways 作為室內導航圖

```
GtfsStop (location_type=2, 出入口)
        ↓ pathway mode=1 (walkway)
GtfsStop (location_type=3, Generic Node)
        ↓ pathway mode=6 (fare gate)
GtfsStop (location_type=3, 閘門後節點)
        ↓ pathway mode=5 (elevator) ← 電梯
GtfsStop (location_type=0, Platform)

同一 GtfsLevel (levelIndex=-1) = 閘門層
同一 GtfsLevel (levelIndex=-2) = 月台層
```

### 10.2 室內路徑規則（基於 pathway_mode）

| pathway_mode | 含義               | 一般模式             | 輪椅模式                         |
| ------------ | ------------------ | -------------------- | -------------------------------- |
| 1            | walkway 步道       | cost = traversalTime | cost = traversalTime             |
| 2            | stairs 樓梯        | cost = traversalTime | cost = **∞（不可通行）**         |
| 3            | moving sidewalk    | cost = traversalTime | cost = traversalTime             |
| 4            | escalator 電扶梯   | cost = traversalTime | ⚠️ `is_bidirectional=0` 時視方向 |
| 5            | elevator 電梯      | cost = traversalTime | cost = traversalTime（**優先**） |
| 6            | fare gate 驗票閘門 | cost = traversalTime | cost = traversalTime             |
| 7            | exit gate 出站閘門 | cost = traversalTime | cost = traversalTime             |

> `traversalTime` 欄位單位為**秒**，直接使用。若為 null，使用預設值（步道 15s、電梯 30s）。

### 10.3 進站路徑查詢

```typescript
// 查詢從車站附近 ORS 終點 → 月台的室內路徑（輪椅模式）

// Step 1: 找最近的出入口節點（locationType=2）
const entrance = await GtfsStop.findOne({
  locationType: 2,
  parentStation: stationId,
  location: { $near: { $geometry: userPoint, $maxDistance: 200 } },
});

// Step 2: 以 pathways 圖走到月台（locationType=0）
// wheelchair 模式：排除 pathwayMode=2（樓梯）的邊
const path = await findIndoorPath(entrance.stopId, platformStopId, {
  excludePathwayModes: mode === "wheelchair" ? [2] : [],
  preferPathwayModes: mode === "wheelchair" ? [5] : [],
});

// Step 3: 取第一個電梯節點作為前端指引
const elevatorNode = path.find((p) => p.pathwayMode === 5);
```

### 10.4 無障礙站點推導

> 因 stops.txt 無 `wheelchair_boarding` 欄位，透過 pathways 推導：

```typescript
// 站體有無障礙通道 = 存在至少一條 pathwayMode=5（電梯）連結
async function stationHasElevator(parentStationId: string): Promise<boolean> {
  const elevatorStops = await GtfsStop.find({
    parentStation: parentStationId,
  }).select("stopId");

  const count = await GtfsPathway.countDocuments({
    fromStopId: { $in: elevatorStops.map((s) => s.stopId) },
    pathwayMode: 5,
  });
  return count > 0;
}
```

### 10.5 現有 `a11y-exit.service.ts` 的定位調整

| 功能                 | v1.2                            | v1.3                          |
| -------------------- | ------------------------------- | ----------------------------- |
| TRTC 電梯 / 坡道出口 | `A11y` collection（內政部資料） | GTFS pathways（所有系統統一） |
| 出口號碼文字         | 從名稱字串解析                  | GTFS `levels.txt` level_name  |
| 支援系統             | TRTC 限定                       | 所有有 pathways 資料的系統    |

`a11y-exit.service.ts` 保留作為 **GTFS pathways 資料缺失時的 fallback**（TRTC 內政部資料補充）。

---

## 11. 無障礙引擎

### 11.1 評分架構

```typescript
// src/config/a11y-scoring.ts（現有）

type RouteAccessibilityScore = {
  totalScore: number                  // 0-100
  label: AccessibilityLabel
  components: {
    facilityScore: number             // 0-100，設施品質
    timeScore: number                 // 0-100，行程效率
    criticalFeatureScore: number      // 0-100，關鍵特徵
  }
}

// 複合公式
totalScore = facilityScore × 0.65 + timeScore × 0.35
```

### 11.2 路線成本函數

```typescript
// 路線排序使用的成本（非使用者顯示分數）
type RouteCost = {
  travelTime: number; // 分鐘
  transferPenalty: number; // 每次轉乘 +5 分鐘等效
  accessibilityPenalty: number; // 無障礙缺失懲罰

  // 計算方式
  // cost = travelTime + transferCount × 5 + (100 - accessibilityScore) × 0.3
};
```

### 11.3 路線排除規則

```typescript
// wheelchair 模式下
function isRouteExcluded(
  route: AccessibleRoute,
  mode: AccessibilityMode,
): boolean {
  if (mode !== "wheelchair") return false;

  // Tier 1 特徵缺失 → 排除路線
  const hasElevatorAccess = route.legs.every((leg) => {
    if (leg.type === "METRO") return leg.facilityHighlights.includes("電梯");
    if (leg.type === "WALK")
      return !leg.a11yFacilities.some((f) => f.type === "stairs_only");
    return true;
  });

  return !hasElevatorAccess;
}
```

### 11.4 多模式無障礙參數

| Mode              | ORS Profile    | Tier 1 Required | 轉乘懲罰 |
| ----------------- | -------------- | --------------- | -------- |
| `wheelchair`      | `wheelchair`   | 必須            | ×2       |
| `elderly`         | `foot-walking` | 建議            | ×1.5     |
| `visual_impaired` | `foot-walking` | 否              | ×1       |
| `normal`          | `foot-walking` | 否              | ×1       |

---

## 12. AI Layer

### 12.1 現有架構

```
src/modules/chatbot/
├── chatbot.controller.ts    # POST /api/v1/a11y/chat
├── chatbot-tools.ts         # Gemini function 定義
└── chatbot.schema.ts        # Zod 驗證

src/config/ai/
├── config.ts    # 溫度、schema 設定
├── contents.ts  # Prompt templates
└── tool.ts      # Tool declarations
```

### 12.2 Tool Calling 流程（Gemini 2-step Loop）

```
使用者訊息
    ↓
Gemini 第一次呼叫
    ↓（若 function call）
┌──────────────────────────────┐
│ Tool 執行                    │
│  findGooglePlaces()          │
│  findA11yPlaces()            │
│  planRoute()                 │
└──────────────────────────────┘
    ↓（tool result → role:"tool"）
Gemini 第二次呼叫
    ↓
文字回應
```

### 12.3 Intent Parsing API

**端點**：`POST /api/v1/ai/intent`

**請求**

```json
{
  "query": "我要從台中火車站坐到高鐵新竹站，我坐輪椅"
}
```

**回應**

```json
{
  "ok": true,
  "data": {
    "from": "台中車站",
    "to": "高鐵新竹站",
    "mode": "wheelchair",
    "departureTime": "now",
    "preferences": {
      "minimizeTransfers": false,
      "preferElevator": true
    }
  }
}
```

### 12.4 Route Explanation API

**端點**：`POST /api/v1/ai/explain`

**請求**

```json
{
  "route": {/* AccessibleRoute 物件 */},
  "mode": "wheelchair",
  "language": "zh-TW"
}
```

**回應**

```json
{
  "ok": true,
  "data": {
    "summary": "建議搭乘台鐵轉高鐵，全程均有電梯，約 95 分鐘抵達",
    "accessibilityHighlights": [
      "台中站設有無障礙電梯通往月台",
      "高鐵新竹站 5 號出口有坡道"
    ],
    "warnings": [],
    "alternatives": null
  }
}
```

---

## 13. Backend API 規格

### 13.1 路由端點總覽

| Method | Path                            | 功能            | 狀態                  |
| ------ | ------------------------------- | --------------- | --------------------- |
| `POST` | `/api/v1/a11y/accessible-route` | 主路由查詢      | ✅ 已實作             |
| `POST` | `/api/v1/a11y/chat`             | AI 無障礙問答   | ✅ 已實作             |
| `POST` | `/api/v1/transit/bus`           | 公車路線查詢    | ✅ 已實作             |
| `GET`  | `/api/v1/transit/bus/realtime`  | 公車即時位置    | ✅ 已實作             |
| `GET`  | `/api/v1/a11y/*`                | 無障礙 POI 查詢 | ✅ 已實作             |
| `POST` | `/api/v1/ai/intent`             | 語意意圖解析    | ✅ 已實作             |
| `POST` | `/api/v1/ai/explain`            | 路線說明生成    | ✅ 已實作（Phase 10） |

### 13.2 主路由查詢（詳細規格）

**端點**：`POST /api/v1/a11y/accessible-route`

**請求 Schema**（`accessible-route.schema.ts`）

```typescript
const AccessibleRouteRequest = z.object({
  origin: z.union([
    z.string().min(1), // 地名 / 地址
    z.object({ lat: z.number(), lng: z.number() }),
  ]),
  destination: z.union([
    z.string().min(1),
    z.object({ lat: z.number(), lng: z.number() }),
  ]),
  mode: z
    .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
    .default("normal"),
  departureTime: z.string().optional(), // ISO 8601 或省略（用現在時間）
  maxTransfers: z.number().int().min(0).max(1).default(1),
  language: z.enum(["zh-TW", "en"]).default("zh-TW"),
});
```

**回應範例**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 3 條無障礙路線",
  "data": {
    "routes": [
      {
        "routeId": "route_0",
        "routeName": "捷運直達（推薦）",
        "totalMinutes": 42,
        "transferCount": 0,
        "legs": [
          {
            "type": "WALK",
            "from": "台中火車站",
            "to": "台中捷運站",
            "distanceM": 340,
            "minutesEst": 5,
            "polyline": "...",
            "a11yFacilities": [],
            "exitInfo": null
          },
          {
            "type": "METRO",
            "railSystem": "TMRT",
            "lineName": "綠線",
            "departureStation": "台中",
            "arrivalStation": "高鐵台中",
            "rideMinutes": 32,
            "waitInfo": { "minutes": 4, "source": "schedule" },
            "polyline": "...",
            "facilityHighlights": ["電梯", "無障礙廁所"]
          },
          {
            "type": "WALK",
            "from": "高鐵台中站",
            "to": "目的地",
            "distanceM": 120,
            "minutesEst": 2,
            "polyline": "...",
            "a11yFacilities": [],
            "exitInfo": null
          }
        ],
        "accessibilityHighlights": ["全程電梯", "無障礙廁所"],
        "accessibilityScore": 88,
        "accessibilityLabel": "excellent",
        "scoreComponents": {
          "totalScore": 88,
          "label": "excellent",
          "components": {
            "facilityScore": 92,
            "timeScore": 81,
            "criticalFeatureScore": 90
          }
        },
        "source": ["ORS", "TDX", "A11Y_ENGINE"]
      }
    ]
  }
}
```

### 13.3 錯誤回應格式

```json
{
  "ok": false,
  "status": "error",
  "code": 404,
  "message": "找不到符合條件的無障礙路線",
  "data": {
    "reason": "NO_ACCESSIBLE_ROUTE",
    "suggestions": ["嘗試調整出發時間", "考慮一般模式查詢"]
  }
}
```

**Error Codes**

| Code                  | Reason | 說明                        |
| --------------------- | ------ | --------------------------- |
| `NO_ACCESSIBLE_ROUTE` | 404    | 無符合無障礙條件路線        |
| `GEOCODING_FAILED`    | 400    | 地名無法解析為座標          |
| `ORS_UNAVAILABLE`     | 503    | ORS API 不可用，已 fallback |
| `INVALID_LOCATION`    | 400    | 座標超出服務範圍            |

---

## 14. Frontend 職責邊界

### 14.1 前端負責

| 職責             | 說明                      |
| ---------------- | ------------------------- |
| 地圖顯示         | Render polyline、站點標記 |
| Route Rendering  | 展示 legs 清單、步驟說明  |
| Step UI          | 逐步導航介面              |
| 使用者互動       | 起迄點輸入、模式選擇      |
| 無障礙分數視覺化 | 分數條、標籤顯示          |

### 14.2 前端不負責

| 禁止事項             | 原因                          |
| -------------------- | ----------------------------- |
| Routing 計算         | 由 backend ORS + TDX 統一處理 |
| GTFS / TDX 資料處理  | Backend 統一                  |
| ORS API 直接呼叫     | API Key 安全性，backend 代理  |
| 無障礙 cost function | 評分邏輯在 `a11y-scoring.ts`  |
| 快取管理             | Redis 由 backend 管理         |

---

## 15. 實作 Roadmap

### 已完成

| Phase   | 功能                      | Commit    |
| ------- | ------------------------- | --------- |
| Phase 1 | 直達路線查詢              | `d59f848` |
| Phase 2 | ORS Matrix 可達站點       | `9855f79` |
| Phase 3 | 一次轉乘路線              | `79c1383` |
| Phase 4 | 複合鍵去重、transferCount | `b65c1fc` |
| Phase 5 | TRTC 無障礙出口室內導航   | `ddfdff6` |

### 待實作

| Phase            | 功能                                                                                                                                       | 優先度       | 依賴                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------------------- |
| ~~**Phase 6**~~  | ~~GTFS Import Pipeline~~ ✅ **已實作**（9 models + 10 scripts）                                                                            | **Critical** | `data/gtfs/` 檔案      |
| ~~**Phase 7**~~  | ~~GTFS-based Router~~ 🗑️ **已退役（2026-06）**——全面改用 OTP2 + TDX MaaS（Phase 16），`gtfs-router.service.ts` 與 `USE_GTFS_ROUTER` 已移除 | **Critical** | Phase 6                |
| ~~**Phase 8**~~  | ~~Indoor Graph 擴充（NTMC/KLRT/TMRT/KRTC）~~ ✅ **已實作**（`indoor-graph.service.ts`，GTFS pathways 全系統）                              | High         | GTFS stops + OSM 電梯  |
| ~~**Phase 9**~~  | ~~AI Intent Parsing API（`/ai/intent`）~~ ✅ **已實作**（`src/modules/ai/`，結構化 Gemini 解析 + accessible-route 整合）                   | High         | Gemini tool config     |
| ~~**Phase 10**~~ | ~~AI Route Explanation（`/ai/explain`）~~ ✅ **已實作**（`generateRouteExplanation` + `/ai/explain`）                                      | Medium       | Phase 9                |
| ~~**Phase 11**~~ | ~~多模式強化（elderly / visual_impaired）~~ ✅ **已實作**（`MODE_PROFILES` + `routeCost` + §11.3 排除規則）                                | Medium       | a11y-scoring.ts        |
| ~~**Phase 12**~~ | ~~多次轉乘支援（`maxTransfers: 2`）~~ ✅ **已實作**（`findTwoTransferRoutes`，三段 chain join）                                            | Low          | Phase 7 GTFS Router    |
| ~~**Phase 13**~~ | ~~即時電梯故障整合（TDX 設施狀態）~~ ✅ **已實作**（`facility-status.service.ts` overlay）                                                 | Low          | TDX Metro Facility API |

---

### Phase 6 — GTFS Import Pipeline（詳細）

**目標**：建立 MongoDB models 與 import scripts，將 `data/gtfs/` 全部匯入

**新增檔案**：

```
src/model/
  ├── gtfs-stop.model.ts
  ├── gtfs-route.model.ts
  ├── gtfs-trip.model.ts
  ├── gtfs-stop-time.model.ts
  ├── gtfs-shape.model.ts
  ├── gtfs-calendar.model.ts
  ├── gtfs-pathway.model.ts     ← 室內導航核心
  ├── gtfs-level.model.ts
  └── gtfs-frequency.model.ts
src/scripts/
  ├── import-gtfs-stops.ts
  ├── import-gtfs-routes.ts
  ├── import-gtfs-trips.ts
  ├── import-gtfs-stop-times.ts  ← 最大，需串流 + 批次
  ├── import-gtfs-shapes.ts      ← 需聚合 points → LineString
  ├── import-gtfs-calendar.ts
  ├── import-gtfs-pathways.ts
  ├── import-gtfs-levels.ts
  ├── import-gtfs-frequencies.ts
  └── import-gtfs-all.ts
```

**關鍵 MongoDB Index**：

```typescript
// GtfsStopTime — 路由查詢最頻繁（497萬筆）
GtfsStopTimeSchema.index({ tripId: 1, stopSequence: 1 });
GtfsStopTimeSchema.index({ stopId: 1, departureTime: 1 });

// GtfsStop — 地理查詢（僅 locationType=0/2 建 2dsphere）
GtfsStopSchema.index({ location: "2dsphere" });
GtfsStopSchema.index({ stopId: 1 }, { unique: true });
GtfsStopSchema.index({ parentStation: 1 });

// GtfsShape（聚合後一 shapeId 一份）
GtfsShapeSchema.index({ shapeId: 1 }, { unique: true });

// GtfsPathway — 室內圖遍歷
GtfsPathwaySchema.index({ fromStopId: 1, pathwayMode: 1 });
GtfsPathwaySchema.index({ toStopId: 1 });
```

---

### Phase 7 — GTFS-based Router（🗑️ 已退役，2026-06）

> **已退役**：本地 in-Mongo GTFS planner 已於 2026-06 全面由 **OTP2 sidecar + TDX MaaS**（Phase 16）取代。
> `gtfs-router.service.ts`、`USE_GTFS_ROUTER`、以及排程表 collections
> （`gtfs_routes` / `gtfs_calendar` / `gtfs_stop_times` / `gtfs_shapes` / `gtfs_frequencies` / `station_clusters`）皆已移除。
> 共用的無障礙 / 室內強化 helper 移至 `route-a11y.service.ts`，GTFS 時間字串工具移至 `gtfs-time.ts`。
> OTP 仍直接讀 `data/gtfs` feed 檔；Mongo 端僅保留 `gtfs_stops` / `gtfs_trips` / `gtfs_pathways` / `gtfs_levels`
> （室內導引 + OTP 方向反查）。以下章節保留為歷史設計紀錄。

**目標**：以 GTFS 資料重寫 `accessible-route.service.ts` 的 transit 路由邏輯

**實作檔案**：~~`src/service/gtfs-router.service.ts`~~（已移除）

**⚠️ 實作期資料模型修正**（基於 `data/gtfs/` 實際資料）：

> 本 feed 有 **兩套不相交的 stop 命名空間**：
>
> 1. **路網節點**（`stop_times` 引用）：如 `TRTC_BL12`，`location_type=0`，**無 parent_station**。
>    同一實體車站跨不同路線靠 **相同 `stop_name` + 鄰近度** 辨識。
> 2. **室內節點**（`pathways` 引用）：數字 id，`location_type` 1/2/3，以 parent_station 串接站體。
>    `stop_times` 不引用 → 屬 Indoor Graph 層（Phase 8），非本 router。
>
> 因此**轉乘 hub 偵測使用 stop_name + 距離匹配，不使用 parent_station**（原規劃的 `GtfsTransfer` 不存在，
> 本 feed 無 transfers.txt）。捷運在此 feed 為**班表制**（絕對 stop_times），公車為 **headway 制**（frequencies.txt）。

**已實作 exports**：

| 函式                                  | 說明                                                                           | 對應步驟                         |
| ------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| `gtfsTimeToSeconds` / `secondsToHHmm` | "HH:MM:SS"（可超過 24:00）↔ 秒                                                 | 時間正規化                       |
| `getActiveServiceIds(date)`           | calendar 週期 + calendar_dates 例外 → 今日有效 serviceId 集合                  | 步驟 4                           |
| `findNearestGtfsStops(point)`         | `$near` 取路網節點（location_type 0/2）                                        | 取代 findReachableStops 資料來源 |
| `findSameStationStops(stopId)`        | 同站轉乘 hub（stop_name + 距離）                                               | 步驟 5                           |
| `findDirectConnections(...)`          | 核心：同 trip board→alight（seq 序）、今日服務、headway 展開、(route,dir) 去重 | 步驟 2-4                         |
| `getShapePolyline(shapeId, from, to)` | 由 GtfsShape 取區段 polyline（最近點切片），缺值退化直線                       | 步驟 6                           |
| `connectionToLeg(conn)`               | GtfsConnection → BusLeg / MetroLeg / ThsrLeg / TraLeg                          | leg 組裝                         |
| `planGtfsRoute(origin, dest, opts)`   | 高階：ORS first/last mile + 直達 / 一次轉乘 → `AccessibleRoute[]`              | 步驟 7                           |

**整合方式（步驟 7，混合架構）**：`findAccessibleRoutes()` 開頭判斷 **`USE_GTFS_ROUTER=true`** →
略過舊版 TDX leg-builder，改並行跑兩個來源後合併評分：

| 來源                                         | 旗標              | 角色                                                                                            |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `planGtfsRoute()`（GTFS router）             | `USE_GTFS_ROUTER` | 有 GTFS 班表的系統（北捷/高捷/高鐵/機捷/輕軌/公車），含 polyline、完整無障礙控制                |
| `planTdxRoute()`（`tdx-routing.service.ts`） | `USE_TDX_ROUTING` | 補 GTFS 缺口：**台鐵、城際、多模式接駁**（如高鐵→台鐵→步行）。呼叫 TDX MaaS `/api/maas/routing` |

兩者皆映射為 `AccessibleRoute` → 合併 → `deduplicateRoutes` → `scoreAndRank` → top-3。
兩個 service 都僅以 **type-only import** 引用 leg 型別 → 無 runtime 循環依賴。

**隔日 fallback（避免收班後回 404）**：兩個 router 都先查當日（`now` 之後的班次）；
若當日已無班次，自動 roll 到**次一服務日的最早班次**（GTFS：次日 `afterSec=0`；TDX：`depart=次日 05:00`），
並在路線標記 `departureDate`（`YYYY-MM-DD`）與 `accessibilityHighlights` 開頭加「🕒 今日班次已過，顯示 … 最早班次」。

**TDX routing service 重點**：

- 端點 `GET https://tdx.transportdata.tw/api/maas/routing`（`origin`/`destination`=`{lat},{lng}`、`gc`、`top`、`transit`、`depart`、`first/last_mile_mode`），透過 `tdxFetch()` 帶 OAuth。
- HERE 風格回傳 `data.routes[].sections[]`（`pedestrian` / `transit`）；以 `transport.category` + `agency.agency_id` 判別 THSR / TRA / Metro / Bus。
- **回傳無 geometry** → polyline 以 `departure → intermediateStops → arrival` 座標近似。
- **過濾 `WAITING` 轉乘佔位段**（同站、length=0）。
- 每段 transit 以 `nearbyA11y()` 補站點無障礙設施 + `deriveHighlights()`（與 GTFS router 共用）。

```typescript
// 實際介面
interface PlanGtfsRouteOptions {
  departureTime?: Date;
  maxTransfers?: 0 | 1;
  routeTypes?: Array<1 | 2 | 3 | 4>;
  limit?: number;
}

function planGtfsRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: PlanGtfsRouteOptions,
): Promise<AccessibleRoute[]>;
```

**THSR vs TRA 判別**：`agencyId === "THSR"` 或 `routeId` 前綴 `THSR` → ThsrLeg，否則 TraLeg。
**捷運系統推導**：`routeId` 底線前綴（TRTC / KRTC / TMRT / NTMC / KLRT / TYMC）。

**a11y 補強（已實作）**：`nearbyA11y()` 以站點座標 `$near` 查 `OsmA11y`（200m / 5 筆），
填入 leg 的 `*A11y` 陣列；`deriveHighlights()` 以與 TDX 路徑相同規則產生 `accessibilityHighlights`
（電梯 / 坡道 / 無障礙廁所 / 導盲磚 / 音響號誌）。→ GTFS 路線評分與 TDX 路線對等，可正常進 top-3。
`facilityHighlights`（即時電梯故障）與 TDX 專屬 UID 仍待 Phase 13；UID 暫填 GTFS stopId。

**已知資料模型陷阱（實作期踩到）**：

- `location_type` 0/2 **無法**區分路網 vs 室內節點；路網節點 = **`location_type=0` 且 `parent_station` 為空**。
- 154k 路網節點絕大多數是公車站，單一 `$near` 會淹沒稀疏的捷運/鐵路站 →
  `findNearestGtfsStops` 以 stopId 前綴 regex（`^(TRTC|KRTC|KLRT|TYMC|TMRT|NTMC|THSR|TRA)_`）
  **分軌道 / 公車兩路查詢再合併**，軌道用較大半徑（10km，城際高鐵站常遠離市中心）。
- **班表覆蓋不全**：此 feed 僅 TRTC / KRTC / THSR / TYMC / KLRT 有 `stop_times`；
  **TRA 台鐵 / TMRT 中捷 / NTMC 環狀線只有站點座標、無班表**。
  無班表的站會白佔軌道候選名額 → `findNearestGtfsStops` **多抓候選後以一次 `stop_times`
  查詢過濾掉無班表站**（資料驅動，未來補上 TRA 班表自動生效）。
  → **2026-06-10 已補：`import-tra-timetable.ts`** 從 TDX TRA GeneralTimetable 匯入
  943 班列車 / 21,622 筆 stop_times（routeId/tripId/serviceId = `TRA_<TrainNo>`，
  週期制 calendar，跨夜班次轉 >24:00 表示法），台鐵 245 站路由自動生效、零 router 改動。
- **stop_times 74% 空白時間（timepoint-only）**：feed 只在 timepoint 站填時刻，
  370 萬筆中途站空白 → 該站無法上下車（公車尤其嚴重）。
  → **已補：`src/config/gtfs-interpolation.ts`** 站數線性插值（timepoint 之間內插、
  首末段外推、原 timepoint 不動）；`interpolate-stop-times.ts` 一次性 migration 回填，
  `import-gtfs-stop-times.ts` 匯入時自動插值（之後重匯不退化）。
- **跨運具轉乘 hub 靠站名完全相同 → 公車↔軌道接不上**（「捷運淡水站」≠「淡水」）。
  → **已補：`StationCluster`**（`build-station-clusters.ts` 離線建置）：以軌道站為種子，
  400m 內跨系統軌道同名合併（union-find）+ 500m 內模糊同名公車站附掛
  （normalize 去除 捷運/台鐵/高鐵 前綴與 站/車站 後綴、括號註記），403 個群集。
  Router 的一次/兩次轉乘 hub key 改為 `clusterId ?? stopName`，cluster 內距離上限放寬至
  600m（步行時間仍按實距計算）。另：班距制（frequencies）trip 的錨點時間不參與
  轉乘時間窗預過濾（視為彈性，build 階段以鏈式 afterSec 解析真實班次）；
  兩側 trip cap 一律「時間排序後取 120」。
- **`calendar_dates.txt`-only 服務**：高鐵服務（4,639 筆）**全部**只在 `calendar_dates.txt`
  以 `exception_type=1` 定義，`calendar.txt` 無對應列。`import-gtfs-calendar.ts` 必須
  **為這些服務補建 `GtfsCalendar` doc**（週期全 false，靠 exceptions 啟用），否則
  `getActiveServiceIds` 永遠算不到高鐵 → 高鐵路由全失效。

**已知限制**：純 GTFS router 對城際末端步行可能極長（HSR 烏日 ↔ 台中市區約 9km）。
→ 已由 **TDX routing（混合架構）解決**：台北→台中 會回傳「高鐵→台鐵接駁→步行」多模式路線（約 73 分）。
TDX routing 為查詢時外部呼叫（受 `USE_TDX_ROUTING` 控制，可單獨關閉以省額度）。

---

### Phase 8 — Indoor Graph 擴充（✅ 已實作）

**目標**：將室內導航從 TRTC 專用的 `A11y` collection，升級為涵蓋全系統的 GTFS `pathways` 圖（spec §10）。

**實作檔案**：`src/service/indoor-graph.service.ts`

**⚠️ 實作期資料修正（import bug）**：

> `import-gtfs-stops.ts` 原以 `isNaN(lat||lon) → continue` 過濾，導致 **`location_type=3` 的室內節點（閘門、電梯樓層，無座標）全被丟棄**（DB 內 generic=0），
> 而這些節點正是 pathways 連接出入口↔月台的關鍵（714 條電梯邊都接在 loc_type=3 節點上）。
> 修正：**boarding stop（loc_type=0）仍須座標，其餘節點允許無座標**（以 `[0,0]` 佔位，2dsphere partial index 僅含 loc_type 0/2，不受污染）。重新匯入後 generic=5,876，電梯路徑可達。

**已實作 exports**：

| 函式                                                                | 說明                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findIndoorStation(name, coords)`                                   | 以 stop_name + 鄰近度（≤600m）將**路網節點**（`TRTC_R28`）橋接到**室內站體節點**（`location_type=1`，數字 id）——兩者命名空間不相交，靠名稱+距離匹配     |
| `findIndoorPath(from, to, opts)`                                    | Dijkstra over `GtfsPathway`，`excludePathwayModes`（輪椅排除樓梯=2）、wheelchair 對電扶梯=4 加權，電梯=5 優先                                           |
| `getStationNodeIds` / `getStationEntrances` / `getStationPlatforms` | 站體節點集合 / 出入口（loc_type=2）/ 月台（loc_type=0）                                                                                                 |
| `stationHasElevator(stationId)`                                     | spec §10.4：站體節點間存在 `pathwayMode=5` 即無障礙可達                                                                                                 |
| `getStationAccess(station, userCoords, mode)`                       | 高階：解析室內站 → 選**離使用者最近且 step-free 的出入口** → 取最短電梯路徑 → 回傳 `{entrance, hasElevator, stepFree, usesElevator, elevatorLevelName}` |

**整合（wire into routes）**：

- `gtfs-router.service.ts` 的軌道 leg（METRO/THSR/TRA）以 `enrichLegIndoor()` 補：相鄰 WalkLeg 的 `exitInfo`（**僅在 step-free 出入口才掛**，避免誤導）+ leg 的 `facilityHighlights`（「乘車站可由出口1電梯無障礙進站（電梯2F）」）。
- `a11y-exit.service.ts buildExitWalkLeg` 改為 **GTFS pathways 優先、TRTC A11y collection fallback**（spec §10.5）。
- 受 `USE_INDOOR_GRAPH`（預設開啟）控制。
- **系統無關**：同一套遍歷自動涵蓋 TRTC/NTMC/KLRT/TMRT/KRTC/TYMC/THSR/TRA。實測 淡水（TRTC）、市政府（TRTC，自動避開樓梯-only 的出口1，改走出口4 電梯）、美麗島（KRTC）皆正確；THSR/TRA 站若 feed 無出入口座標則 `stepFree=null`，退回站體中心點。

---

### Phase 9 — AI Intent Parsing（✅ 已實作）

**目標**：新增 `POST /api/v1/ai/intent` 端點

**實作**：

1. 新增 `src/modules/ai/` module（`ai.controller.ts` / `ai.router.ts` / `ai.schema.ts` / `index.ts`）。
2. **結構化輸出**（非 2-step tool loop）：`config/ai/config.ts` 的 `intentConfig` 以 `responseJsonSchema` 強制 Gemini 回傳 `RouteIntent`，`config/ai/contents.ts` 的 `intentContents` 提供解析規則 prompt。
3. 輸出 `RouteIntent`：`{ from, to, mode, departureTime, preferences:{minimizeTransfers, preferElevator} }`；`from` 可為 `"current_location"`。
4. **整合至 `accessible-route.controller.ts`**：body 接受可選 `query`（+ 可選 `userLocation` 解析 `current_location`）；提供 `query` 且未給 origin/destination 時，呼叫 `parseRouteIntent()` 推導端點與模式，並把 `intent` 一併回傳。`parseRouteIntent()` 由 `src/modules/ai` 匯出供重用，解析失敗（無 JSON / 缺 from/to）回 null，API 例外回 500。

---

### Phase 10 — AI Route Explanation（✅ 已實作）

**目標**：新增 `POST /api/v1/ai/explain` 端點（spec §12.4）

**實作**：

1. `config/ai/config.ts` 的 `explainConfig` 以 `responseJsonSchema` 強制 Gemini 回傳 `RouteExplanation`；`config/ai/contents.ts` 的 `explainContents` 規範生成規則（不可捏造設施、warnings 來源、依 mode/language 調整）。
2. `src/modules/ai/ai.controller.ts`：`generateRouteExplanation(route, mode, language)` 可重用；`compactRoute()` 先剝除 polyline / OSM 設施陣列再送模型（省 token）。`alternatives` schema 強制 string，空字串→`null`。
3. `/ai/explain` 接受 `{ route, mode?, language? }`，route 為 `/a11y/accessible-route` 回傳的 AccessibleRoute 物件（passthrough 驗證）。

### Phase 11 — 多模式強化（✅ 已實作）

**實作檔案**：`src/config/a11y-scoring.ts` + `accessible-route.service.ts`

1. `MODE_PROFILES`（spec §11.4）：每模式的 a11y/time 權重、轉乘懲罰倍率（wheelchair ×2 / elderly ×1.5 / 其餘 ×1）、Tier 1 必要與 critical 特徵權重。
   - `elderly`：a11y/time 70/30，無障礙廁所（Tier 2）權重加倍。
   - `visual_impaired`：導盲磚 30、音響號誌 25 → 升為 critical（spec §5.4）。
2. `routeCost()`（spec §11.2）：`time + transfers × 5 × 倍率 + (100 − score) × 0.3`，`scoreAndRank(routes, mode)` 改以 cost 升冪排序（分數仍照常回傳顯示）。
3. §11.3 排除規則：wheelchair 模式下，軌道 leg「有設施資料但無電梯」或「電梯被標記維修/故障」、步行 leg 經過 stairs-only OSM 節點（`highway=steps` 且無輪椅替代）→ 排除。**全數被排除時回退原清單**（低分路線優於 404）。
4. mode 貫穿：schema `mode` → controller（body 優先，否則採 intent.mode）→ `findAccessibleRoutes` → `planGtfsRoute`（ORS profile：僅 wheelchair 用 `wheelchair`，其餘 `foot-walking`；indoor graph 遍歷規則同步切換）。

### Phase 12 — 多次轉乘支援（✅ 已實作）

**實作**：`gtfs-router.service.ts` 的 `findTwoTransferRoutes` + `buildTwoTransferRoute`

- 三段 chain join（tripA 起點→hub X、tripB X→Y、tripC Y→終點），hub 以 **stop_name + 200m 鄰近度** 匹配（與 Phase 7 一致；feed 無 transfers.txt）。
- **只在 direct + 一次轉乘湊不滿 3 條時觸發**（最昂貴的查詢路徑）。
- 邊界控制：兩側 trips **依時間排序後**取 120（任意順序截斷會被城際鐵路擠掉捷運班次）、hub 名稱各取 25、middle join 掃描加 `departureTime >= now` 過濾 + 30k 列上限、chain 以「轉乘站對」去重強制多樣性。
- 品質過濾：同線重搭（同 routeId / 反向命名 "A－B"="B－A"）排除；**冗餘轉乘檢查**——前段 trip 的 stop_times 已涵蓋下一段下車站（同線短班變體、回頭搭）→ 排除。
- 三段班次以**鏈式 afterSec**（前段抵達 + 90s 轉乘步行）依序解析，確保時序正確；同月台轉乘（座標距 <5m）步行段短路為 0 分鐘（避免 ORS 對零距離回 NaN）。
- `maxTransfers` 貫穿：schema 0–2（預設 1）→ `findAccessibleRoutes` → `PlanGtfsRouteOptions`。
- 除錯：`GTFS_DEBUG=1` 輸出 join 各階段統計。

### Phase 13 — 即時設施狀態整合（✅ 已實作）

**實作檔案**：`src/service/facility-status.service.ts`

- `overlayFacilityStatus(routes, mode)` 在**最終 top-3** 上疊加（省 TDX 額度），由 `finalizeRoutes()` 統一呼叫（GTFS 與舊版路徑皆生效）。
- **StationFacility**：METRO leg 的乘車/下車站補 TDX 設施標籤（有電梯/無障礙廁所/導盲磚…）；GTFS UID（`TRTC_O12`）自動映射 TDX UID（`TRTC-O12`）。設施清單存在但無電梯、且 mode 為 wheelchair/elderly → `⚠️` 警告；電梯名稱含維修/故障/暫停 → `⚠️` 警告（同時餵給 §11.3 排除規則）。
- **Metro Alert（營運通阻）**：提及電梯/電扶梯且涵蓋本 leg 車站（或全線）的告警 → `⚠️` 警告。
- 全 fail-soft：每個 TDX 呼叫 5 分鐘快取、錯誤吞掉不影響路由；`USE_REALTIME_FACILITY=false` 可整體關閉。

### Phase 14 — 回應酬載瘦身：OSM 設施欄位投影（✅ 已實作）

**實作檔案**：`src/modules/accessible-route/facility-slim.ts`（+ `accessible-route.service.ts` 的 `finalizeRoutes()`、`a11y.controller.ts` 的 `getA11yPlace`）

**問題**：每個 leg 的設施陣列（`departureStopA11y` / `arrivalStationA11y` / `a11yFacilities`）內嵌完整 OSM 文件——`tags` 可達 50 欄（`addr:*`、`network:*`、`contact:*`、多語系名稱…），單一設施約 2KB；且同一設施會在相鄰的 transit leg 與 walk leg 重複內嵌。3 條路線 × 100+ 設施 → 回應 200KB+，行動端不可接受。

**階段 A — 回應層投影 + tags 白名單（預設啟用，無開關）**

- `slimRoutes()` 在 `finalizeRoutes()` **最後一步**執行（所有路由路徑的單一出口；評分與 Phase 13 即時設施疊加都看得到完整文件，瘦身只影響回應形狀）。
- 每個設施投影為 `SlimA11y`：頂層保留 `osmId`、`category`、`name?`、`location`、`wheelchair?`；丟棄 `_id`、`__v`、`importedAt`。
- **tags 白名單 = 評分引擎實際讀取的 keys ∪ 顯示用 keys**（共 26 個）。關鍵設計：`/route-rank`、`/route-select` 會把前端回傳的路線**重新評分**，白名單若不含評分 keys，瘦身後重排會失真——因此白名單逐一對齊 `a11y-scoring.ts` 的 `ALL_TAG_WEIGHTS`（Tier 1–4：`wheelchair`、`elevator`、`highway`、`ramp:wheelchair`、`ramp`、`kerb`、`smoothness`、`surface`、`toilets:wheelchair`、`tactile_paving`、`traffic_signals:sound/vibration`、`crossing`、`shelter`、`door`、`lit`…）＋數值類 `width`/`incline`＋顯示用 `name`/`opening_hours`/`level`/`amenity`。空 tags 直接省略欄位。
- **實測**（三芝→台北車站，15 個設施）：完整文件 53.5KB → 瘦身後 23.5KB；設施部分 ~31KB → ~1.5KB（**約 95% 縮減**），剩餘體積主要是 polyline。單設施 50 欄 2KB → 白名單 3–5 欄 ~200B。
- 完整 OSM 文件改走按需端點 **`GET /api/v1/a11y/place?osmId=…`**（支援逗號分隔批次查詢；400 缺參數、404 查無、200 回完整文件陣列）。OpenAPI：`SlimOsmA11y` component（路由回應用）與既有 `OsmA11y`（/place 完整文件）分開註冊。

**階段 B — 路線層設施字典去重（opt-in：body `format: "compact"`）**

- `compactRoutes()`：（已瘦身的）設施搬進路線層 `facilities: Record<osmId, SlimA11y>`，各 leg 設施陣列清空、有引用時帶 `a11yRefs: string[]`。
- **非 breaking**：預設 `format: "standard"` 維持 leg 內嵌（瘦身版）；前端準備好後自行帶 `"compact"`。
- **實測注意**：階段 A 之後單一設施已僅 ~200B，字典結構本身有開銷——compact 只在設施跨 leg 重複率高的路線（捷運/台鐵轉乘路線，同站設施出現 2–4 次）才有淨節省；低重複案例可能持平甚至略大。屬「前端想用 normalized 結構」的選項，非體積最佳化的主力。

**驗證**：tsc 通過；live 實測 standard 回應 0 個 `addr:*`、0 個 `importedAt`；compact 的 `facilities` 字典與 `a11yRefs` 正確；瘦身前後 `accessibilityScore` 完全一致（[66,63,52]）。

### Phase 15 — 即時大眾運輸資料疊加（✅ 已實作）

**實作檔案**：`src/service/realtime-transit.service.ts`（模式同 Phase 13：top-3 only、`finalizeRoutes()` 動態 import、全 fail-soft）

**目標**：GTFS/班表建出的路線疊加 TDX 即時資料——「所有大眾運輸資訊都需要是即時的」。

- **公車（第一段 transit leg）**：乘客「現在」就站在站牌——以 TDX EstimatedTimeOfArrival 蓋掉班表等候（後續 leg 上車時間在未來，ETA 無意義，維持班表）。端點由 GTFS stopId 前綴判別：`THB…` → 公路客運 Streaming ETA；城市代碼（`TPE`/`NWT`/`TXG`/`KHH`/…，**前綴後無底線**，如 `TXG2646`）→ `City/{city}/{routeName}`。
  - **方向判別不可信 GTFS direction_id**（live 驗證：860 在三芝，GTFS 標 0、實車是 TDX Direction 1）——改為一次查「上車站 or 下車站」兩站、雙方向，以「同班車先到上車站、後到下車站」（board ETA < alight ETA）解出真實方向；雙方向皆合理（環狀線）才回退 GTFS direction。
  - `EstimateTime` 有值 → `waitInfo: { minutes, source: "realtime" }`；雙方向 board 記錄皆 `StopStatus` 3/4（末班已過/未營運）→ `waitInfo` 轉 `unavailable` + 路線 `⚠️` 警告；`StopStatus 1`（尚未發車）→ 班表維持權威。
  - 前置需求：`BusLeg` 新增選用欄位 `departureStopId`/`arrivalStopId`（GTFS router 才有）。**TDX MaaS leg 無 stopId**——但 MaaS 回應的 `agency.agency_id` 開頭就是系統代碼（`NWT_1104_1102` → `NWT`），`transitSectionToLeg` 抽出存入新選用欄位 `cityCode`，overlay 以 `stopId 前綴 ?? cityCode` 取得系統代碼 → MaaS 公車 leg 同樣即時化。
- **台鐵（所有 TRA leg）**：v3 `TrainLiveBoard`（一次呼叫、30s 快取）建 `TrainNo → DelayTime` 索引，誤點跟車次走：誤點 >0 → `waitInfo.minutes` 加上誤點、`source:"realtime"`、leg + 路線加註「⚠️ 列車誤點 N 分」、`totalMinutes` 吸收**第一個**誤點 leg 的延遲（後續 leg 搭同一條平移後的時刻鏈，不重複累計）；在板上且 DelayTime 0 → 升級 `source:"realtime"`（班表獲即時確認）。
  - 前置需求：GTFS 軌道 tripId 內含真實車次（`TRA_1003`、`THSR_0108_…`），`connectionToLeg` 改抽 tripId 車次（原 `routeShortName` 是「潮州-七堵」線名，對不上 LiveBoard）。
  - **MaaS TRA leg 車次反查**：MaaS 的 `transport.number` 實測為空（trainNo fallback 成線名）——但 leg 有「站名 + 表定發車時刻」，足以在 **TRA OD 每日時刻表**（`/v2/Rail/TRA/DailyTimetable/OD/{from}/to/{to}/{date}`）唯一定位車次：站名→StationID（245 站清單，6h 快取，台/臺正規化）→ OD 表（每 O/D 對 6h 快取）比對 `OriginStopTime.DepartureTime` → TrainNo 回填到 leg（API 回應的 trainNo 也因此變成真車次）→ 走同一條 LiveBoard 誤點邏輯。實測：臺中→豐原 10:45 → 車次 114。
  - **快取防呆**：空結果多半是 TDX 429/故障——失敗結果只快取 60s（成功才 6h），一次 429 不會讓 TRA 即時瞎 6 小時。
- **防呆**：使用者指定 `departureTime` 與 now 差 >15 分 → 整個跳過（即時只對「現在出發」有效）；`departureDate` 已滾到隔日的路線跳過；舊版路徑 `waitInfo.source` 已是 `"realtime"`（`fetchWaitInfo` ETA）的 leg 跳過避免重複；所有 TDX 回應 30s 快取；`USE_REALTIME_TRANSIT=false` 整體關閉。
- **誠實限制**：TDX **沒有**捷運/高鐵的列車即時 ETA/誤點 API——捷運班距 2–6 分已以 headway/2 近似、高鐵準點率高，異常面由 Phase 13 Metro Alert 涵蓋。TDX 免費額度的 429 為已知風險——全 fail-soft + 失敗短快取，最壞情況退回班表。
- **驗證（live, 2026-06-11）**：台中 BUS 30 `waitInfo {minutes:36, source:"realtime"}`（班表 09:46 vs 實車 36 分——即時覆蓋價值所在）、豐原 BUS 900 `{15, realtime}`；TRA 直測：誤點車 1154（+2）→ wait 5→7 + `⚠️ 列車 1154 誤點約 2 分` + totalMinutes 70→72，準點車 1148 → 升級 realtime，線名 trainNo → 不動；skew >15 分 / flag off / 隔日路線三防呆皆跳過。

---

## 16. 測試策略

> 本專案目前無測試框架（`CLAUDE.md` 說明）。以下為建議策略，非強制規格。

### 16.1 手動測試案例

| 測試案例     | 輸入                        | 預期                                    |
| ------------ | --------------------------- | --------------------------------------- |
| 直達捷運     | 台北車站 → 忠孝復興（輪椅） | MetroLeg，全程電梯                      |
| 一次轉乘     | 台中 → 高鐵新竹（輪椅）     | TRA + THSR leg                          |
| ORS Fallback | 禁用 ORS API Key            | Haversine 估算，WalkLeg.polyline = null |
| 無解路線     | 偏遠地點無公共運輸          | 404 NO_ACCESSIBLE_ROUTE                 |
| 自然語言輸入 | `"我坐輪椅要去101"`         | AI 解析 → 正常路由流程                  |

### 16.2 驗證重點

- ORS 快取命中率（Redis `walk-time` keys）
- 無障礙分數計算正確性（Tier 1 缺失 → critical label）
- 轉乘去重（複合鍵：`origin_stop+dest_stop+route`）
- 電梯出口 mapping 正確性（距離 < 100m）

---

## 17. 環境變數總覽

| 變數                    | 用途                                                                                                            | 必要性                  | 使用位置                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------ |
| `PORT`                  | Server 監聽 port                                                                                                | 選配（預設 5000）       | `server.ts`                                      |
| `CORS_ORIGINS`          | CORS 白名單                                                                                                     | 選配                    | `app.ts`                                         |
| `GOOGLE_MAPS_API_KEY`   | 地理編碼 + Places Search                                                                                        | **必要**                | `config/map.ts`                                  |
| `GEMINI_API_KEY`        | Gemini AI                                                                                                       | **必要**                | `@google/genai` 自動讀取                         |
| `JWT_ACCESS_SECRET`     | JWT 簽署                                                                                                        | **必要**                | `config/jwt.ts`                                  |
| `JWT_REFRESH_SECRET`    | JWT Refresh                                                                                                     | **必要**                | `config/jwt.ts`                                  |
| `DATABASE_URL`          | MongoDB 連線                                                                                                    | **必要**                | `server.ts`                                      |
| `TDX_CLIENT_ID`         | TDX OAuth                                                                                                       | **必要**                | `TdxTokenManger.ts`                              |
| `TDX_CLIENT_SECRET`     | TDX OAuth                                                                                                       | **必要**                | `TdxTokenManger.ts`                              |
| `ORS_API_KEY`           | OpenRouteService                                                                                                | **必要**（有 fallback） | `config/ors.ts`                                  |
| `REDIS_URL`             | Walk-time 快取                                                                                                  | 選配（有降級）          | `config/redis.ts`                                |
| `USE_OTP_ROUTER`        | 主路由引擎（OTP2 sidecar）。`false`｜`shadow`（並跑只記 diff）｜`true`（併入結果）                              | 選配（預設 `false`）    | `accessible-route.service.ts`                    |
| `USE_TDX_ROUTING`       | `true` 時並用 TDX MaaS routing 補 OTP 缺口（台鐵/城際）                                                         | 選配（預設關閉）        | `accessible-route.service.ts`                    |
| ~~`USE_GTFS_ROUTER`~~   | 🗑️ **已移除（2026-06）**——本地 GTFS router 退役，改由 `USE_OTP_ROUTER` + `USE_TDX_ROUTING` 取代                 | —                       | —                                                |
| `USE_INDOOR_GRAPH`      | Phase 8 室內圖出口/電梯導引。設為 `false` 可關閉（省去每段軌道 leg 的 pathways 查詢）；其餘值（含未設定）皆啟用 | 選配（**預設開啟**）    | `route-a11y.service.ts` / `a11y-exit.service.ts` |
| `USE_REALTIME_FACILITY` | Phase 13 TDX 即時設施狀態 overlay（top-3 的 METRO leg）。設為 `false` 關閉以省 TDX 額度                         | 選配（**預設開啟**）    | `facility-status.service.ts`                     |
| `USE_REALTIME_TRANSIT`  | Phase 15 即時大眾運輸 overlay（top-3：首段公車 TDX ETA + 全部 TRA leg 誤點）。設為 `false` 關閉以省 TDX 額度    | 選配（**預設開啟**）    | `realtime-transit.service.ts`                    |
| ~~`GTFS_DEBUG`~~        | 🗑️ **已移除**——隨 `gtfs-router.service.ts` 退役（兩次轉乘 chain join 的除錯 log）                               | —                       | —                                                |

---

_文件版本 v1.7.0 — 資料補強三件組（2026-06-10）：① TRA 班表匯入（`import-tra-timetable.ts`，943 班 / 21,622 stop_times，台鐵路由生效）② 車站群集（`StationCluster` + `build-station-clusters.ts`，403 群集，公車↔軌道轉乘 hub）③ stop_times 插值（`gtfs-interpolation.ts`，回填 257 萬筆空白時刻）。_
_v1.7 router 連帶修正：`findNearestGtfsStops` 公車名額改以「不同站名」計（TPE/NWT 雙登錄重複站不再吃光名額）；轉乘搜尋兩側改為「每（路線,方向）一個代表 trip」做 hub 探索，預過濾不再卡時間窗（代表班次時刻僅供探索，真實班次由 build 階段以鏈式 afterSec 重新解析）；上/下車站改以「離端點距離」選擇（不再坐過頭走回頭路）。驗證案例：三芝→台北車站（860→淡水 cluster→紅線，84 分）、三芝→動物園（兩次轉乘 863→紅線→912，108 分）。_

_v1.7.1（2026-06-10）：① 等候時間——TDX MaaS 路徑的 transit leg 不再硬編 `waitInfo: null`，改由 section 時間戳鏈推算（下車時刻 → 下一段發車）；BUS/METRO leg 新增選用欄位 `departureTime`/`arrivalTime`（GTFS 與 TDX 路徑皆填），前端可顯示「下一班」。② 反方向護欄——`ridesToward()` 檢查（首段上車、末段下車）對（起點, 終點）的地理進展，擋掉「走過頭再搭回來」（如台中案例：走到臺中車站搭到新烏日再走回學校）；另加 `accessWalkBudgetM()`：walkIn+walkOut 合計不得超過起終點直線距離（下限 2.5km），擋掉 10km 軌道半徑產生的「走 7km 搭火車再走 11km」病態路線。兩護欄套用於 direct / 一次轉乘 / 兩次轉乘三條組裝路徑。驗證：台中（萬和國中→臺中州廳）只回傳公車 30 直達與三段公車轉乘；三芝案例不受影響。③ Phase 14（OSM tags 瘦身）規劃完成。_

_v1.8.0（2026-06-10）：Phase 14 實作完成——`facility-slim.ts`（`slimRoutes` 預設啟用 + `compactRoutes` opt-in `format:"compact"`）、`GET /api/v1/a11y/place` 完整文件端點、`SlimOsmA11y` OpenAPI component。設施酬載縮減約 95%（實測 53.5KB → 23.5KB，設施部分 31KB → 1.5KB），tags 白名單對齊評分引擎確保 /route-rank 重評分不失真。_

_v1.9.0（2026-06-11）：Phase 15 實作完成——`realtime-transit.service.ts`（首段公車 TDX ETA 蓋班表等候 + TRA TrainLiveBoard 誤點跟車次套用所有 TRA leg），`USE_REALTIME_TRANSIT` 開關（預設開）。實作期發現：GTFS 公車 stopId 前綴無底線（`TXG2646`）；GTFS direction_id 與 TDX Direction 不對應（改以 board/alight ETA 遞增解方向）；GTFS 軌道車次在 tripId（`TRA_1003`）而非 routeShortName（線名），`connectionToLeg` 連帶修正 TRA/THSR `trainNo`。_

_v1.9.1（2026-06-11）：Phase 15 延伸至 TDX MaaS 路徑（原本因無 stopId/車次而跳過）——① 公車：MaaS `agency.agency_id` 前綴（`NWT_1104_1102`→`NWT`）存入 `BusLeg.cityCode`，overlay fallback 使用；② TRA：OD 每日時刻表以「站名+發車時刻」反查車次並回填 `trainNo`（站名→ID 245 站 6h 快取、OD 表 6h 快取、台/臺正規化）；③ 失敗結果（429/故障的空回應）只快取 60s，避免一次 429 癱瘓即時功能 6 小時。MaaS THSR/捷運 leg 維持班表（TDX 無對應即時 API）。_
_文件版本 v1.6.0 — Phase 10（AI Route Explanation `/ai/explain`）、Phase 11（多模式：`MODE_PROFILES` / `routeCost` / §11.3 排除）、Phase 12（兩次轉乘：`findTwoTransferRoutes` chain join）、Phase 13（TDX 即時設施狀態：`facility-status.service.ts`）已實作。Roadmap Phase 6-13 全數完成。_  
_Phase 12 實作期修正：兩側 trip cap 必須依時間排序（任意順序會被城際鐵路擠掉捷運）、middle join 需 `departureTime >= now` 過濾、三段班次需鏈式 afterSec 解析、同點轉乘步行需短路避免 ORS NaN、需冗餘轉乘檢查（前段 trip 已達下段下車站者剔除）。_  
_下次更新應反映實機負載下的兩次轉乘效能調校與 TDX 額度管理策略。_
