# 逐步導航指引資料（語音播報後端支援）
## Functional Specification — Nav Instructions Backend Support

**版本**：v1.2.0
**狀態**：Implemented — 已實作（2026-08-03）
**日期**：2026-08-03
**作者**：yuzen9622

> v1.2.0 修訂（as-built）：正常情況下所有 WALK legs 均由 OTP 產生；Valhalla pedestrian 僅在 OTP 步行規劃不可用時作為有 `warnings` 的停機備援。`stepBearing()` 改以 maneuver 在 leg polyline 上的位置向前取樣約 20 公尺，取不到幾何才退回 `absoluteDirection`。公開指引新增 `legIndex`、`cumulativeDistanceM`；`distanceM` 明定為「完成本 maneuver 後到下一步前的距離」。文字加入友善距離、無名路段下一個具名目標、長於 300 公尺的中間提示，且後續 WALK leg 的 `DEPART` 不再外洩。端點可傳 `routeToken` 或 `route`，兩者並存時以 `routeToken` 為準。

> v1.1.0 修訂（as-built，已實作）：端點 `POST /api/v1/a11y/route/instructions` 已上線（`src/modules/nav-instructions/`，獨立 `createNavInstructionsRouter()` 直接掛在 `app.ts` 的 `/api/v1/a11y`）。`tsc --noEmit` 乾淨、`nav-instructions.service.test.ts` vitest 23 passed。實作相對本文初稿的調整：
> ① **service 為純函數而非 class**——`generateNavInstructions(route, userHeading?)` 加上 `calcBearing` / `calcRelativeDirection` / `degToCompassWord` 直接 export（無 `NavInstructionsService` 物件）；常數 `WARN_STEPS_UNAVAILABLE = "ORS_STEPS_UNAVAILABLE"`。
> ② **步驟來源只走策略 A（OTP `WalkLeg.steps`）**；ORS 策略 B（接駁步行 `instructions: true` / `orsWalkingRouteWithSteps()`）**尚未實作**，§4.3 整段為未來工作。無 steps 的步行段降級為「以 polyline 前兩點算 bearing 的單句 depart/turn」並推入 `WARN_STEPS_UNAVAILABLE`（即策略 C 的輕量版，講不出街名）。
> ③ **bearing 取點改採 OTP 語意**：先用 `step.absoluteDirection` 羅盤詞（NORTH…→度），否則用相鄰 `step.location` 兩點，最後退回 polyline 前兩點；**ORS `maneuver.bearing_after` 未使用**（因 ORS steps 未取）。§5.1 的 ORS `type` 整數對照表因此**非實際落地路徑**，實際模板鍵為 OTP `relativeDirection` 列舉（另含 `CIRCLE_CLOCKWISE` / `CIRCLE_COUNTERCLOCKWISE`）。
> ④ **大眾運輸模板 as-built**：BusLeg 用 `estimatedWaitMinutes`、**未含 stopCount／headsign**（站數說明省略，呼應 §11 風險緩解）；MetroLeg 以「往『{arrivalStation}』方向」表示（無獨立 `direction` 欄位），依 `facilityHighlights` 是否含「電梯」切換結尾句；THSR／TRA 以 `displayTime()` 正規化發到時間。每段 transit 產 `transit_board` + `transit_alight` 兩步；`arrive` 一律於結尾追加，`legType` = 最後一段實際型別。
> ⑤ **型別位置**：`WalkStep` 與各 Leg 型別位於 `src/types/route.ts`（非模組內），`WalkStep.streetName` 為 `string`（非 nullable，空字串或 `bogusName` 時視為無街名）；模組 DTO（`NavInstruction` / `NavInstructionsResult` / `NavRouteInput`）放 `nav-instructions.types.ts`。
> ⑥ §9.1 範例修正：`heading=130, bearing=215` → diff=85，落在 67.5–112.5 區間 → **「右側」**（初稿誤標「右前方／右後方」，以 §5.3 門檻為準，測試已對齊）。

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [前後端職責切割](#3-前後端職責切割)
4. [系統架構](#4-系統架構)
5. [指引產生邏輯](#5-指引產生邏輯)
6. [資料模型](#6-資料模型)
7. [API 規格](#7-api-規格)
8. [實作 Roadmap](#8-實作-roadmap)
9. [測試策略](#9-測試策略)
10. [前端職責邊界](#10-前端職責邊界)
11. [風險與緩解](#11-風險與緩解)

---

## 1. 系統概述

本規格書描述「逐步導航指引資料（語音播報後端支援）」功能，屬於無障礙混合式交通導航系統的延伸模組。

現行主路由端點 `POST /api/v1/a11y/accessible-route` 已回傳含有 `WalkLeg.polyline`、`BusLeg`、`MetroLeg` 等路段資料，但缺少可供語音播報使用的**逐步指引句**與**方位角資訊**。`FUNCTIONAL_SPEC_v1.2.md`（§8.2）已將 ORS 輸出欄位 `segments[].steps` 標注為「未來逐步指引」保留項目，本規格正是將其落地。

**功能定位**：後端負責產生結構化、可朗讀的逐步導航步驟陣列，以及協助起始轉向判斷的絕對方位角。語音合成（TTS）、陀螺儀讀取、播報時機控制皆屬前端職責。

---

## 2. 系統目標

### 2.1 核心能力

- 從 `AccessibleRoute` 的每個 `WalkLeg` 產生 turn-by-turn 步驟，每步包含可朗讀繁中指引句
- 從 `BusLeg`、`MetroLeg`、`ThsrLeg`、`TraLeg` 產生大眾運輸搭乘指引句
- 計算每個步行轉向步驟的**絕對方位角（bearing，度，0–359）**
- 計算起始路段方位角，供前端換算相對轉向方向（左前 / 正前 / 右前 / 左後 / 正後 / 右後 / 左側 / 右側）
- 使用無障礙友善用語（避免「左轉」等視覺依賴字詞，改用「沿坡道前行」、「進入電梯」等具體動作）

### 2.2 非功能目標

| 目標 | 說明 |
|------|------|
| 零外部呼叫增量 | 步驟資料隨現有 OTP `plan` / ORS directions 回應一併取得（需擴充查詢欄位，非額外往返）；見 §4.4 |
| Bearing 純函數 | 方位角計算為純函數，可單元測試，不依賴外部服務 |
| 向後相容 | 以**選用欄位**或**獨立端點**提供，不破壞現有 `/accessible-route` 回應結構 |
| 無障礙語境一致 | 指引措辭遵循 WCAG 2.2 感知獨立性原則，不假設使用者能辨別顏色或視野方向 |

---

## 3. 前後端職責切割

本功能橫跨前後端，職責切割如下。**本規格僅定義後端職責**；前端職責僅在本章與第 10 章列出作為邊界說明。

### 3.1 後端職責（本規格範圍）

| 職責 | 說明 | 實作位置 |
|------|------|---------|
| 逐步指引句產生 | 將 ORS `maneuver.type` + `street_name` 轉換為繁中自然語句 | `nav-instructions.service.ts` |
| 絕對方位角計算 | 以兩點經緯度（Haversine bearing 公式）計算每步驟的行進方位角（度） | `nav-instructions.service.ts` |
| 相對方向計算（條件式） | 若前端傳入 `userHeading`，後端直接計算八方位相對方向字串 | `nav-instructions.service.ts` |
| 大眾運輸段指引 | BusLeg / MetroLeg / ThsrLeg / TraLeg 轉成自然語言搭乘指引 | `nav-instructions.service.ts` |
| 步驟陣列組裝 | 將 legs 陣列攤平為有序的 `NavInstruction[]` | `nav-instructions.service.ts` |
| API 端點 | `POST /api/v1/a11y/route/instructions` | `nav-instructions.controller.ts` |

### 3.2 前端職責（邊界）

| 職責 | 原因 |
|------|------|
| TTS 語音合成 | 需存取裝置 Web Speech API，且語速/聲音偏好屬使用者設定 |
| 陀螺儀讀取（DeviceOrientationEvent） | 需存取裝置感測器 |
| 播報時機判斷（到達步驟前 X 公尺時播報） | 需結合即時 GPS 位置，屬前端狀態管理 |
| 路線進度追蹤（已完成幾步） | 前端 UI 狀態 |
| 相對方向換算（若未傳 `userHeading`） | 後端僅提供 `bearing`，前端以陀螺儀 `heading` 計算差值 |

### 3.3 起始轉向設計取捨

語音播報最重要的功能之一是「出發時告知往哪個方向轉」，以減少使用者一開始就走錯方向。此需求的設計有兩個選項：

**方案 A（建議採用）：後端僅回傳絕對方位角，前端自行換算**

```
後端回傳：initialBearing = 215（西南方）
前端讀取：deviceHeading = 130（目前面向東南）
前端計算：relative = (215 - 130 + 360) % 360 = 85 → "右側"（§5.3 門檻 67.5–112.5）
前端播報：「請往右側出發」
```

優點：後端純函數、無狀態、不依賴前端感測器即時性；前端可在 GPS 定位穩定後的任意時刻換算。

**方案 B：前端將 `userHeading` 傳入後端，後端直接回傳相對方向字串**

```json
{ "userHeading": 130 }
→ 後端回傳 "relativeDirection": "右前方"
```

優點：前端邏輯更簡單，直接朗讀字串即可。  
缺點：使用者 heading 在請求發出與實際出發間可能已改變；增加 API 對感測器時序的隱性依賴。

**結論**：採用**方案 A 為預設**。`NavInstruction` 的 `bearing` 欄位永遠填入，`relativeDirection` 為選用——僅在請求中提供 `userHeading` 時才計算並填入，不強制。

---

## 4. 系統架構

### 4.1 請求流程

```
Client
  ↓ POST /api/v1/a11y/route/instructions
Express (src/app.ts)
  ↓
Zod Validation Middleware
  ↓
navInstructions controller
  ↓
generateNavInstructions(route, userHeading?)   ← as-built：純函數，無 class、無路線快取（route.legs 全程 passthrough）
        ↓
  ┌─────────────────────────────────────────────────┐
  │ nav-instructions.service.ts（純函數集合）        │
  │                                                 │
  │  walkLegToInstructions()                        │
  │    └── OTP WalkLeg.steps → NavInstruction[]     │
  │        └── stepBearing() + walkStepText()       │
  │        └── 無 steps → 降級 + WARN_STEPS_UNAVAILABLE │
  │                                                 │
  │  busInstructions / metroInstructions /          │
  │  thsrInstructions / traInstructions             │
  │    └── BusLeg / MetroLeg / ... → NavInstruction │
  │                                                 │
  │  calcRelativeDirection()（若有 userHeading）    │
  └─────────────────────────────────────────────────┘
        ↓
sendResponse() → NavInstructionsResponse
```

### 4.2 與現有架構的整合位置

本功能新增獨立 module，**不修改** `accessible-route.service.ts` 的核心路由邏輯：

```
src/
└── modules/
    └── nav-instructions/          ← 新增
        ├── nav-instructions.controller.ts
        ├── nav-instructions.router.ts
        ├── nav-instructions.schema.ts
        ├── nav-instructions.service.ts
        └── index.ts
```

路由掛載於 `src/modules/accessible-route/accessible-route.router.ts`（或新增獨立 router），端點前綴沿用 `/api/v1/a11y/`。

### 4.3 ORS 步驟欄位啟用

現行 `src/modules/accessible-route/planners/ors.ts` 的 `orsWalkingRoute()` 使用 GeoJSON endpoint（`/directions/{profile}/geojson`），**請求 body 未含 `instructions: true`**，因此 ORS 回傳的 `features[0].properties` 中沒有 `segments` 欄位。

要取得步驟資料，需在 `orsWalkingRoute()` 的請求 body 加入：

```json
{
  "coordinates": [[lng1, lat1], [lng2, lat2]],
  "instructions": true,
  "instructions_format": "text"
}
```

ORS 的 `segments[].steps` 結構如下（依 ORS 公開文件）：

```typescript
interface OrsStep {
  distance: number       // 此步驟距離（公尺）
  duration: number       // 此步驟時間（秒）
  type: number           // maneuver type（見 §5.1）
  instruction: string    // ORS 英文指引句（需翻譯為繁中）
  name: string           // 街道名稱（空字串若無名稱）
  way_points: [number, number]  // [startIdx, endIdx]，指向 geometry.coordinates 的索引
  maneuver?: {
    bearing_before: number   // 進入此步驟前的行進方向（度）
    bearing_after: number    // 此步驟後的行進方向（度）
    location: [number, number]  // [lng, lat]，步驟發生點
  }
}
```

> ⚠️ **待確認**：修改 `orsWalkingRoute()` 加入 `instructions: true` 後，回傳型別 `WalkingRoute` 需擴充 `steps` 欄位，或新增 `orsWalkingRouteWithSteps()` 專用函式（後者較安全，不破壞現有呼叫點）。

### 4.4 指引文字的真實來源：步行段同時來自 OTP 與 ORS（重要修正）

> 本節修正 §4.3「ORS 為唯一步驟來源」的隱含假設。實際 journey planning 是 **OTP-first**（`src/modules/accessible-route/planners/otp-routing.ts`），ORS 僅負責 first/last-mile 接駁步行。故步行逐步指引有**兩個來源**，須分別處理。

| 步行段類型 | 路徑來源 | 逐步指引來源 | 現況（已查證程式碼） |
|------|---------|------------|----------|
| 行程內步行（轉乘、進出站、OTP 規劃段） | OTP street router | OTP `leg.steps` | ✅ **已實作（2026-06-18）**：`PLAN_QUERY` 已加 `steps { … }`，`walkLegFrom()` 映射為 `WalkLeg.steps` |
| 接駁步行（起點→首站、末站→終點，由 orchestrator 縫合） | `orsWalkingRoute()`（`planners/ors.ts:84`） | ORS `segments[].steps` | 請求只帶 `{ coordinates }`，**未帶 `instructions: true`**（見 §4.3）|

**現況更新（2026-06-18）**：`WalkLeg` 已新增選用欄位 `steps?: WalkStep[]`（`src/types/route.ts`），OTP 行程內步行段的 `streetName`／`relativeDirection`／`absoluteDirection`／`bogusName` 等已隨 `/accessible-route` 回應一併輸出（策略 A 的資料管線完成）。接駁步行（ORS）尚未取 steps（策略 B 待做）。

**OTP `leg.steps` 可取得的欄位（OTP 2.9 GraphQL，建議優先採用）**：

```graphql
steps {
  relativeDirection   # DEPART / LEFT / RIGHT / SLIGHTLY_LEFT / CONTINUE /
                      # UTURN_LEFT / ELEVATOR / ENTER_STATION / EXIT_STATION ...
  absoluteDirection   # NORTH / NORTHEAST / EAST ...（已是羅盤方位，免自算 bearing）
  streetName          # 街道／路徑名稱（OSM name tag）
  distance            # 公尺
  lon  lat            # 步驟發生點座標
  exit                # 圓環出口編號
  bogusName           # true = 該路徑在 OSM 無真實名稱（OTP 自動命名）
  area                # 是否為廣場／開放空間
}
```

> ⚠️ 待確認：上列欄位依 OTP 2.9 GraphQL `step` 型別，實作時以實際 sidecar 的 schema introspection 為準。
>
> OTP 來源比 ORS 更適合本功能：①`relativeDirection`／`absoluteDirection` 已算好，免自行計算 bearing；②內建 `ELEVATOR`／`ENTER_STATION`／`EXIT_STATION` 等無障礙語意方向；③`PLAN_QUERY` 已設 `locale: "zh-TW"`；④`bogusName` 可直接判斷「有沒有街名可講」。

**三種落地策略（擇一或混用）**：

| 策略 | 作法 | 取得街名？ | 狀態（v1.1.0） |
|------|------|-----------|---------|
| **A**（建議，行程內步行）| 擴充 `PLAN_QUERY` 加 `steps { … }` | ✅ OTP `streetName` | ✅ **已實作**：query + `WalkStep` 型別 + `walkLegFrom` 映射 + §5 繁中模板層（`walkLegToInstructions`）全數完成 |
| **B**（接駁步行）| `orsWalkingRoute` 加 `instructions: true`，新增 `orsWalkingRouteWithSteps()` | ✅ ORS `name` | ⛔ **尚未實作**：ORS 接駁步行仍只取 polyline，無 steps（§4.3 為此項的工作說明）|
| **C**（不改引擎）| 純由 `WalkLeg.polyline` 連續點算 bearing 變化合成轉向 | ❌ 無街名 | ◐ **輕量版已落地為降級路徑**：無 steps 時以 polyline 前兩點算單一 bearing 產 depart/turn，並回 `WARN_STEPS_UNAVAILABLE`（尚未做「逐點偵測轉向」的完整 C） |

> 策略 C 因 `polyline` 已存在，可在**不動任何引擎查詢**下立即提供「方位角 + 距離」，但**講不出街道名稱**。要講街名必須走 A／B。現況：行程內步行走 A（已上線）；接駁步行的 B 待做，兩者皆無步驟時落入 C 的降級（呼應 §7.4 `ORS_STEPS_UNAVAILABLE`）。

### 4.5 呼叫時序與播報時機（後端何時被呼叫）

語音導航採「**後端一次性產生整段、前端依即時位置決定何時朗讀**」的分工。本端點**不是**逐步即時推送，後端**無導航 session**。

```
[路線選定]
使用者於 /accessible-route 取得候選路線 → 選定一條
        │  （僅一次）
        ▼
前端帶該 route 呼叫 POST /api/v1/a11y/route/instructions
        │
        ▼
後端一次回傳整段 NavInstruction[]（無狀態、不分段推送）
        │
        ▼
[行進間 — 前端主導]
前端 watchPosition 即時 GPS  ↔  比對 polyline / polylineIndex
  ├─ 出發瞬間：用 initialBearing + 裝置 heading 播報起始轉向（§3.3）
  └─ 接近某步驟觸發點前約 30m：朗讀該步 text（TTS）
```

| 角色 | 時刻 | 動作 |
|------|------|------|
| 後端端點 | 使用者「選定路線後」**一次** | 產生並回傳整段步驟陣列 |
| 前端 | 行進過程中**持續** | 依即時 GPS 決定「何時」朗讀「哪一步」 |
| 前端 | 出發瞬間 | 起始轉向提示 |

> 偏離路線需重新導航時：由前端重新呼叫 `/accessible-route` 取得新路線後，再呼叫一次本端點。後端不維護任何進度狀態。

---

## 5. 指引產生邏輯

### 5.0 指引文字如何產生（非 AI、非預存，決定論模板）

逐步指引句**不是 AI 生成、也不存放於資料庫**；每次呼叫時，由路由引擎回傳的**結構化轉向列舉 + 街道名稱**，套入固定繁中模板（§5.1）即時組出：

```
引擎 step → 取 maneuver/direction 列舉 + streetName → 套繁中模板 → text
```

**為何不直接朗讀引擎原生的 `instruction` 字串？**

1. ORS 原生 `instruction` 為英文；繁體中文（尤其台灣在地用語）支援不保證。
2. 需無障礙友善措辭（避免純視覺字詞）與全系統一致用語。
3. OTP 的方向本就是列舉（`relativeDirection`），需自行在地化映射。

因此 ORS（`type`）與 OTP（`relativeDirection`）兩種來源，都收斂到**同一張繁中模板**：

| OTP `relativeDirection` | 對應 ORS `type` | 繁中模板 |
|------------------------|----------------|---------|
| `DEPART` | 11 | 請沿「{street}」出發，方位約 {bearing} 度 |
| `CONTINUE` | 6 | 請繼續直行，沿「{street}」前進 |
| `LEFT` / `RIGHT` | 0 / 1 | 在「{street}」，請向左／右轉 |
| `SLIGHTLY_LEFT` / `SLIGHTLY_RIGHT` | 4 / 5 | 請稍向左／右偏 |
| `HARD_LEFT` / `HARD_RIGHT` | 2 / 3 | 請大幅向左／右轉 |
| `UTURN_LEFT` / `UTURN_RIGHT` | 9 | 請迴轉 |
| `ELEVATOR` | （ORS 無）| 請進入電梯 |
| `ENTER_STATION` / `EXIT_STATION` | （ORS 無）| 請進入車站 ／ 請離開車站 |

> OTP 的 `ELEVATOR`／`ENTER_STATION`／`EXIT_STATION` 正好對應 §5.1 的無障礙語境補充規則，比從 `exitInfo` 推斷更精準。

### 5.1 ORS Maneuver Type 對應

> ⚠️ **as-built（v1.1.0）**：因步驟只走策略 A（OTP），本表的 ORS `type` 整數映射**未落地**。實際 `walkStepText()` 以 OTP `relativeDirection` 字串列舉為鍵（見 §5.0 對照表，另含 `CIRCLE_CLOCKWISE` / `CIRCLE_COUNTERCLOCKWISE` → 「請進入圓環，依指示繞行」）。本表保留作 ORS 策略 B 落地時的對照參考。

ORS `step.type` 為整數，對應如下轉向動作。後端依此產生繁中指引句：

| type | ORS 含義 | 繁中指引句範例（無障礙友善） |
|------|---------|---------------------------|
| 0 | Left | 在「{street_name}」，請向左轉 |
| 1 | Right | 在「{street_name}」，請向右轉 |
| 2 | Sharp left | 在「{street_name}」，請大幅向左轉（約 135 度） |
| 3 | Sharp right | 在「{street_name}」，請大幅向右轉（約 135 度） |
| 4 | Slight left | 在「{street_name}」，請稍向左偏 |
| 5 | Slight right | 在「{street_name}」，請稍向右偏 |
| 6 | Straight | 請繼續直行，沿「{street_name}」前進 |
| 7 | Enter roundabout | 進入圓環 |
| 8 | Exit roundabout | 離開圓環 |
| 9 | U-turn | 請迴轉 |
| 10 | Goal（Destination） | 您已抵達目的地 |
| 11 | Depart（Start） | 請沿「{street_name}」出發，方位角約 {bearing} 度 |
| 12 | Keep left | 請靠左前進 |
| 13 | Keep right | 請靠右前進 |

**無障礙語境補充規則**：

- 若 WalkLeg 的 `exitInfo.type === "elevator"`，在接近車站的最後一步前插入：`「請進入電梯」`
- 若 WalkLeg 的 `exitInfo.type === "ramp"`，插入：`「請沿坡道前進」`
- 若步驟距離 < 20 公尺，省略距離報告，直接說轉向動作（避免「再走 5 公尺右轉」這種在輪椅速度下來不及反應的指引）
- 街道名稱為空字串、或 OTP `step.bogusName === true`（OSM 無真實街名）時，省略「在 X 路」，改用「沿目前道路{動作}」，**不捏造街名**（見 §5.5）

### 5.2 方位角計算（Bearing）

兩點之間的**初始方位角**（forward azimuth，以正北為 0，順時針增加）：

```typescript
/**
 * 計算從點 A 到點 B 的方位角（度，0–359，正北 = 0）。
 * 使用球面三角 forward azimuth 公式（等同 Vincenty 在短距離的近似）。
 */
function calcBearing(
  from: [number, number],  // [lng, lat]
  to: [number, number],    // [lng, lat]
): number {
  const [lng1, lat1] = from.map((v) => (v * Math.PI) / 180);
  const [lng2, lat2] = to.map((v) => (v * Math.PI) / 180);
  const dLng = lng2 - lng1;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}
```

**各步驟 bearing 的取點邏輯（as-built `stepBearing()`）**：

1. 先把 maneuver 的 `location` 以緯度 cos 校正距離吸附到該 leg polyline，且搜尋索引只能向前。
2. 從該索引沿 polyline 向前累積約 20 公尺，以實際幾何計算 `calcBearing()`。
3. 只有幾何不足時，才把 OTP `absoluteDirection`（`NORTH` / `NORTHEAST` / …）當 fallback。

> `facility` 類型步驟（`ELEVATOR` / `ENTER_STATION` / `EXIT_STATION`）的 `bearing` 一律填 `null`。
> 註：初稿假設的 ORS `maneuver.bearing_after` / `way_points` 取點在策略 A 不適用（OTP step 無此欄位）；待策略 B 落地時再依 ORS 結構補上。

### 5.3 相對方向換算（八方位）

```typescript
type RelativeDirection =
  | "正前方"
  | "左前方"
  | "右前方"
  | "左側"
  | "右側"
  | "左後方"
  | "右後方"
  | "正後方";

/**
 * 以使用者當前朝向（heading）與目標方位角（bearing）計算相對方向。
 * @param heading 使用者當前朝向（度，正北 = 0，順時針）
 * @param bearing 目標方位角（度，正北 = 0，順時針）
 * @returns 八方位中文字串
 */
function calcRelativeDirection(
  heading: number,
  bearing: number,
): RelativeDirection {
  const diff = ((bearing - heading + 360) % 360);
  if (diff < 22.5 || diff >= 337.5) return "正前方";
  if (diff < 67.5) return "右前方";
  if (diff < 112.5) return "右側";
  if (diff < 157.5) return "右後方";
  if (diff < 202.5) return "正後方";
  if (diff < 247.5) return "左後方";
  if (diff < 292.5) return "左側";
  return "左前方";
}
```

### 5.4 大眾運輸段指引生成

大眾運輸段不使用步行 steps，而是依 leg 型別直接組裝指引句。每段 transit 產出兩步：`transit_board`（上車）與 `transit_alight`（下車）。

**BusLeg**（as-built）

```
transit_board：「請在「{departureStop}」站牌等候，搭乘公車「{routeName}」
                〔，預估等候約 {estimatedWaitMinutes} 分鐘〕。」
transit_alight：「抵達「{arrivalStop}」站後請下車。」
```

> as-built：等候時間取 `estimatedWaitMinutes`（>0 才附加）。**未含 `stopCount`（中間站數）與 `headsign`（方向）**——`BusLeg` 無此欄位，依 §11 風險緩解直接省略站數說明，未來如需可由 GTFS `stop_times` sequence 差值補。

**MetroLeg**（as-built）

```
transit_board：「請搭乘{railSystem 中文名}「{lineName}」，在「{departureStation}」站上車，
                往「{arrivalStation}」方向〔，行駛約 {rideMinutes} 分鐘〕。{facility 句}」
transit_alight：「請在「{arrivalStation}」站下車。」
```

> as-built：以「往『{arrivalStation}』方向」表示行向（無獨立 `direction` 欄位）。`railSystem` 代碼經 `RAIL_SYSTEM_NAMES` 轉中文（`TRTC`→台北捷運、`KRTC`→高雄捷運、`TMRT`→台中捷運、`NTMC`→新北捷運、`KLRT`→高雄輕軌、`TYMC`→桃園捷運）。`facility 句`：`facilityHighlights` 含「電梯」→「請優先使用電梯進站。」，否則→「請留意進站無障礙設施狀況。」

**ThsrLeg**

```
「請搭乘高鐵【{trainNo}】次列車，
  預計【{departureTime}】由【{departureStation}】出發，
  【{arrivalTime}】抵達【{arrivalStation}】。」
```

**TraLeg**

```
「請搭乘台鐵【{trainTypeName}】【{trainNo}】次，
  預計【{departureTime}】由【{departureStation}】出發，
  【{arrivalTime}】抵達【{arrivalStation}】。」
```

---

### 5.5 街道名稱與門牌號（「什麼街道、幾號」）可行性

直接回答需求「語音是否能說明要轉什麼路、什麼街道、幾號」：

| 指引要素 | 可行？ | 來源 | 限制 |
|---------|-------|------|------|
| 轉向（左／右／直行／迴轉／進電梯）| ✅ | ORS `type` ／ OTP `relativeDirection` | 無 |
| **街道名稱（什麼路／街）** | ✅（視 OSM 覆蓋率）| ORS `step.name` ／ OTP `step.streetName`（皆來自 OSM `name` tag）| 台灣巷弄、人行道、廣場、室內通道常無 OSM 名稱 → OTP 標 `bogusName: true`、ORS 回空字串 |
| **門牌號（幾號）— 中途轉彎處** | ❌ | 無 | 路由引擎 step **不含門牌**；OSM `addr:housenumber` 掛在建物／節點上，不會出現在 step 輸出 |
| **門牌號（幾號）— 起點 / 終點** | ✅ | Google 地理編碼 `formatted_address`（例 `臺北市中正區忠孝西路一段49號`，見 `src/adapters/google.adapter.ts`）| 僅起訖點，且該點需由地址／Places 解析而來（純座標起點無門牌）|

**結論**：

- **可以**說「在忠孝西路右轉」「沿羅斯福路直行」「您已抵達：忠孝西路一段49號」。
- **無法**說「在忠孝西路123號右轉」——中途任一轉彎點都沒有門牌資料。
- 街名缺失時（`bogusName` ／空字串）降級為「沿目前道路前行」，**不捏造街名**。

**中途門牌若硬要做**：須對每個轉彎座標反向地理編碼（每轉一次一次 Google 呼叫），費用與額度高、且僅近似（回傳最近建物號），**不建議**，僅列為未來昂貴選項。

> 對標業界：Google／Apple 語音導航同樣只報「街名」+「終點門牌」（如 "turn right onto Zhongxiao W Rd … your destination, No. 49"），中途不報門牌。本系統行為與其一致，非功能缺口。

---

## 6. 資料模型

### 6.1 NavInstruction（指引步驟型別）

```typescript
/**
 * 單一導航步驟，可直接交由前端 TTS 朗讀 `text` 欄位。
 */
interface NavInstruction {
  /** 可朗讀繁中指引句。前端直接傳入 TTS。 */
  text: string;

  /**
   * 步驟類型。
   * - "turn"：步行轉向步驟（來自 ORS step）
   * - "transit_board"：大眾運輸上車
   * - "transit_alight"：大眾運輸下車
   * - "facility"：無障礙設施提示（電梯 / 坡道）
   * - "depart"：出發步驟（含起始方位角）
   * - "arrive"：抵達目的地
   */
  type: "turn" | "transit_board" | "transit_alight" | "facility" | "depart" | "arrive";

  /**
   * 行進方位角（度，0–359，正北 = 0，順時針）。
   * - "turn" 與 "depart" 步驟必填。
   * - "transit_*" 與 "arrive" 步驟不填（null）。
   */
  bearing: number | null;

  /**
   * 相對方向（八方位中文）。
   * 僅在請求中提供 `userHeading` 時填入；否則為 null。
   * 前端可直接朗讀，例如「請往左前方出發」。
   */
  relativeDirection: RelativeDirection | null;

  /**
   * 完成本 maneuver 後、到下一步之前要行進的距離（公尺）。
   * "transit_*" 步驟不適用，填 null。
   */
  distanceM: number | null;

  /**
   * 街道名稱（若 ORS step 有回傳）。空字串或 null 時不對使用者說街道名稱。
   */
  streetName: string | null;

  /**
   * 此步驟所屬的 leg 類型，供前端顯示圖示使用。
   */
  legType: "WALK" | "BUS" | "METRO" | "THSR" | "TRA";

  /** 此指引來源在 route.legs 中的索引。 */
  legIndex: number;

  /**
   * 步驟在 WalkLeg.polyline 中的起點索引（僅 "turn" / "depart" 步驟）。
   * 前端可用於在地圖上標注步驟位置。
   */
  polylineIndex: number | null;

  /** 抵達此 maneuver 起點前已累積的可量測行進距離（公尺）。 */
  cumulativeDistanceM: number;
}
```

### 6.2 NavInstructionsResponse

```typescript
interface NavInstructionsResponse {
  /** 所有 legs 攤平後的有序步驟陣列。 */
  instructions: NavInstruction[];

  /**
   * 起始路段的絕對方位角（度），即第一個 WalkLeg 或 transit_board 的方向。
   * 供前端在出發前換算相對方向（若未提供 userHeading）。
   */
  initialBearing: number;

  /** 指引總步數。 */
  totalSteps: number;

  /**
   * 警告訊息（若有）。
   * 例如：「部分步行段無 ORS 逐步資料，已改用簡化指引。」
   */
  warnings: string[];
}
```

---

## 7. API 規格

### 7.1 端點總覽

| Method | Path | 功能 | 狀態 |
|--------|------|------|------|
| `POST` | `/api/v1/a11y/route/instructions` | 路線逐步指引產生 | ✅ Implemented（v1.1.0）|

> **替代方案說明**：另一選項是直接在 `POST /api/v1/a11y/accessible-route` 的每個 `WalkLeg` 內嵌 `instructions[]`。  
> **不採用的原因**：① 指引資料體積大，不所有前端場景都需要（地圖顯示不需要）；② 內嵌會增大現有端點回應，影響 Phase 14 的瘦身成果；③ 獨立端點可在使用者確認路線後再按需請求，符合「懶載入」原則。  
> **建議**：採用獨立端點。

### 7.2 請求規格

**端點**：`POST /api/v1/a11y/route/instructions`

**驗證**：無 JWT（公開端點，與 `/accessible-route` 一致）

**Request Schema**（Zod）

```typescript
const NavInstructionsRequest = z.object({
  /**
   * 完整的 AccessibleRoute 物件（由 /accessible-route 回傳）。
   * 前端收到路線後直接 passthrough。
   */
  route: z.object({
    routeId: z.string().optional(),  // as-built：選用；服務只讀 legs
    legs: z.array(z.any()),          // 詳細型別由 AccessibleRoute 定義
  }).optional(),

  /** /accessible-route 回傳、30 分鐘內有效的 capability；有值時優先。 */
  routeToken: z.string().trim().min(1).max(256).optional(),

  /**
   * 使用者當前朝向（度，正北 = 0，順時針），由陀螺儀取得。
   * 若提供，後端計算並填入 NavInstruction.relativeDirection。
   * 若省略，relativeDirection 欄位回傳 null。
   */
  userHeading: z.number().min(0).max(359).optional(),

  /**
   * 輸出語言（預留，目前僅支援 zh-TW）。
   */
  language: z.enum(["zh-TW"]).default("zh-TW"),
}).refine((body) => body.route || body.routeToken)
```

**請求範例**

```json
{
  "route": {
    "routeId": "route_0",
    "legs": [
      {
        "type": "WALK",
        "from": "台北車站",
        "to": "捷運台北車站",
        "distanceM": 340,
        "minutesEst": 5,
        "polyline": "...encoded...",
        "a11yFacilities": [],
        "exitInfo": { "type": "elevator", "exitNumber": "M6" }
      },
      {
        "type": "METRO",
        "railSystem": "TRTC",
        "lineName": "板南線",
        "departureStation": "台北車站",
        "arrivalStation": "忠孝復興",
        "rideMinutes": 8,
        "waitInfo": { "minutes": 3, "source": "schedule" },
        "facilityHighlights": ["電梯", "無障礙廁所"]
      }
    ]
  },
  "userHeading": 45
}
```

### 7.3 回應規格

**成功回應**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "逐步指引產生完成，共 8 步",
  "data": {
    "instructions": [
      {
        "type": "depart",
        "text": "請沿中山南路出發，方位角約 315 度（西北方）",
        "bearing": 315,
        "relativeDirection": "左前方",
        "distanceM": 120,
        "streetName": "中山南路",
        "legType": "WALK",
        "legIndex": 0,
        "polylineIndex": 0,
        "cumulativeDistanceM": 0
      },
      {
        "type": "turn",
        "text": "請向右轉，進入忠孝西路",
        "bearing": 50,
        "relativeDirection": null,
        "distanceM": 85,
        "streetName": "忠孝西路",
        "legType": "WALK",
        "legIndex": 0,
        "polylineIndex": 5,
        "cumulativeDistanceM": 120
      },
      {
        "type": "facility",
        "text": "前方為 M6 出口電梯，請進入電梯",
        "bearing": null,
        "relativeDirection": null,
        "distanceM": null,
        "streetName": null,
        "legType": "WALK",
        "polylineIndex": null
      },
      {
        "type": "transit_board",
        "text": "請搭乘台北捷運板南線，在台北車站上車，往南港展覽館方向，行駛約 8 分鐘，在忠孝復興站下車。請優先使用電梯進站。",
        "bearing": null,
        "relativeDirection": null,
        "distanceM": null,
        "streetName": null,
        "legType": "METRO",
        "polylineIndex": null
      },
      {
        "type": "transit_alight",
        "text": "請在忠孝復興站下車",
        "bearing": null,
        "relativeDirection": null,
        "distanceM": null,
        "streetName": null,
        "legType": "METRO",
        "polylineIndex": null
      },
      {
        "type": "arrive",
        "text": "您已抵達目的地",
        "bearing": null,
        "relativeDirection": null,
        "distanceM": null,
        "streetName": null,
        "legType": "WALK",
        "polylineIndex": null
      }
    ],
    "initialBearing": 315,
    "totalSteps": 6,
    "warnings": []
  }
}
```

**錯誤回應**

```json
{
  "ok": false,
  "status": "error",
  "code": 400,
  "message": "route 欄位格式錯誤或 legs 為空",
  "data": {
    "reason": "INVALID_ROUTE_INPUT"
  }
}
```

### 7.4 Error Codes

| Code | HTTP | 說明 |
|------|------|------|
| `INVALID_ROUTE_INPUT` | 400 | `route.legs` 為空或格式不符 |
| `UNSUPPORTED_LEG_TYPE` | 400 | legs 中含本規格未支援的 leg 型別 |
| `ORS_STEPS_UNAVAILABLE` | 200（含 warning） | WalkLeg 無 ORS steps 資料，改用簡化指引（僅起點/終點） |

> `ORS_STEPS_UNAVAILABLE` 不觸發 4xx，而是在 `warnings[]` 加入說明並回傳簡化指引，確保降級體驗。

---

## 8. 實作 Roadmap

| 步驟 | 工作內容 | 依賴 | 狀態（v1.1.0） |
|------|---------|------|-----------|
| **Step 1** | 新增 `nav-instructions` module（目錄、schema、controller、router） | 無 | ✅ 完成 |
| **Step 2** | 實作 `calcBearing()` 純函數 + 單元測試 | 無 | ✅ 完成 |
| **Step 3** | 實作 `calcRelativeDirection()` 純函數 + 單元測試 | Step 2 | ✅ 完成（另加 `degToCompassWord()`）|
| **Step 4** | 修改 `orsWalkingRoute()` 或新增 `orsWalkingRouteWithSteps()`，啟用 `instructions: true` | ⚠️ 確認不破壞現有快取邏輯 | ⛔ **未做**（策略 B；步驟來源改走 OTP 策略 A，ORS 接駁步行 steps 留待後續）|
| **Step 5** | 實作 `walkLegToInstructions()`（步行 steps → `NavInstruction[]`） | Step 2 | ✅ 完成（吃 OTP `WalkLeg.steps`；無 steps 降級 + `WARN_STEPS_UNAVAILABLE`）|
| **Step 6** | 實作各 transit leg 指引（BusLeg / MetroLeg / ThsrLeg / TraLeg） | 無 | ✅ 完成（`busInstructions` / `metroInstructions` / `thsrInstructions` / `traInstructions`）|
| **Step 7** | 組裝 `generateNavInstructions(route, userHeading?)`，整合 Step 5 與 Step 6 | Step 5、Step 6 | ✅ 完成（純函數，非 class）|
| **Step 8** | 掛載路由、整合測試 | Step 7 | ✅ 完成（`app.ts` 掛 `/api/v1/a11y`；`nav-instructions.service.test.ts` vitest 23 passed）|

> **剩餘工作（v1.2 候選）**：Step 4（ORS 策略 B，接駁步行 steps 取街名）；完整策略 C（逐點偵測轉向）；BusLeg `stopCount` 補站數。

**ORS 請求修改注意事項**：

`orsWalkingRoute()` 目前使用 `/directions/{profile}/geojson` endpoint，該 endpoint 的 GeoJSON 回應不含 `segments`。若加入 `instructions: true`，ORS 仍以 GeoJSON 格式回傳，但 `features[0].properties.segments` 將出現在 `properties` 內（非 geometry）。建議**新增** `orsWalkingRouteWithSteps()` 函式，保留現有函式供路由規劃使用（只需 polyline + distance），避免為所有路由計算增加不必要的 steps 欄位傳輸量。

---

## 9. 測試策略

### 9.1 純函數單元測試（建議以 Vitest 實作）

> 本專案已設置 Vitest（`build: add vitest test runner and config`），參考現有 `scoring.test.ts` 與 `ranking.test.ts` 的格式。

**bearing 計算測試**

```typescript
describe("calcBearing", () => {
  it("正北方向應回傳 0", () => {
    // 從 (0,0) 到 (0,1)，緯度增加 → 正北
    expect(calcBearing([0, 0], [0, 1])).toBeCloseTo(0, 1);
  });

  it("正東方向應回傳 90", () => {
    // 從 (0,0) 到 (1,0)，經度增加 → 正東
    expect(calcBearing([0, 0], [1, 0])).toBeCloseTo(90, 1);
  });

  it("正南方向應回傳 180", () => {
    expect(calcBearing([0, 1], [0, 0])).toBeCloseTo(180, 1);
  });

  it("正西方向應回傳 270", () => {
    expect(calcBearing([1, 0], [0, 0])).toBeCloseTo(270, 1);
  });

  it("台北真實座標：台北車站 → 忠孝復興（大致往東）", () => {
    // 台北車站 [121.5173, 25.0478]，忠孝復興 [121.5444, 25.0416]
    const b = calcBearing([121.5173, 25.0478], [121.5444, 25.0416]);
    expect(b).toBeGreaterThan(80);
    expect(b).toBeLessThan(120);
  });
});
```

**相對方向換算測試**

```typescript
describe("calcRelativeDirection", () => {
  it("heading=0, bearing=0 → 正前方", () => {
    expect(calcRelativeDirection(0, 0)).toBe("正前方");
  });

  it("heading=0, bearing=90 → 右側", () => {
    expect(calcRelativeDirection(0, 90)).toBe("右側");
  });

  it("heading=0, bearing=180 → 正後方", () => {
    expect(calcRelativeDirection(0, 180)).toBe("正後方");
  });

  it("heading=0, bearing=270 → 左側", () => {
    expect(calcRelativeDirection(0, 270)).toBe("左側");
  });

  it("heading=130, bearing=215 → 右側", () => {
    // diff = (215 - 130 + 360) % 360 = 85，落在 67.5–112.5 → 右側
    expect(calcRelativeDirection(130, 215)).toBe("右側");
  });

  it("邊界：diff=337.5 應屬正前方", () => {
    expect(calcRelativeDirection(45, 22.5)).toBe("正前方");
  });
});
```

### 9.2 整合測試案例

| 測試案例 | 輸入 | 預期 |
|---------|------|------|
| 純步行路線 | 單一 WalkLeg，含 ORS steps | 回傳 `depart` + N 個 `turn` + `arrive` |
| 步行 + 捷運 | WalkLeg + MetroLeg + WalkLeg | 含 `transit_board`、`transit_alight`、`facility` |
| 含電梯出口 | WalkLeg.exitInfo.type = "elevator" | 指引陣列中含 `facility` 步驟 |
| 無 ORS steps | WalkLeg 無 steps 欄位 | 回傳簡化指引（僅 depart/arrive），warnings 中有說明 |
| 提供 userHeading | route + userHeading=90 | 所有 `depart`/`turn` 步驟的 `relativeDirection` 不為 null |
| 未提供 userHeading | route，無 userHeading | 所有步驟的 `relativeDirection` 為 null |
| 高鐵路線 | ThsrLeg | `transit_board.text` 含車次號碼與發車時間 |

### 9.3 降級驗證

| 情境 | 預期行為 |
|------|---------|
| ORS API Key 不存在（Haversine fallback） | WalkLeg 無 steps → `warnings: ["ORS_STEPS_UNAVAILABLE"]`，回傳簡化指引 |
| legs 為空陣列 | HTTP 400，`INVALID_ROUTE_INPUT` |

---

## 10. 前端職責邊界

本章完整列出前端需自行實作的功能，確保不將後端不負責的項目誤列入本規格範圍。

| 前端職責 | 技術實作 | 說明 |
|---------|---------|------|
| TTS 語音合成 | Web Speech API（`speechSynthesis.speak`） | 直接朗讀 `NavInstruction.text` |
| 陀螺儀讀取 | `DeviceOrientationEvent.webkitCompassHeading` 或 `alpha` 換算 | 取得使用者朝向，用於換算相對方向（若未依賴後端計算） |
| GPS 位置追蹤 | Geolocation API（`watchPosition`） | 判斷是否到達下一步的播報觸發距離 |
| 播報時機控制 | 自訂距離閾值（建議步行 30 公尺前播報） | 結合 GPS 位置與 `NavInstruction.polylineIndex` |
| 路線進度追蹤 | 前端狀態（currentStepIndex） | 已完成幾步、剩餘幾步 |
| 相對方向換算（Fallback） | `calcRelativeDirection()` 邏輯移植至前端 | 僅在未傳 `userHeading` 至後端時需要 |
| 圖示顯示 | 依 `NavInstruction.type` 與 `legType` 選擇圖示 | 地圖上的步驟標記 |
| 離線快取 | Service Worker 快取指引資料 | 隧道內斷線時維持語音播報 |

---

## 11. 風險與緩解

| 風險 | 影響 | 緩解策略 |
|------|------|---------|
| ORS steps 未回傳（無 API Key 或 Haversine fallback） | 步行段僅有起終點，無轉向指引 | 降級為「請沿路前往 X」的簡化指引；`warnings[]` 告知前端；不回傳 4xx |
| ORS `instructions: true` 增加請求/回應體積 | `/accessible-route` 主流程效能影響 | 使用獨立函式 `orsWalkingRouteWithSteps()`，主路由不受影響 |
| `maneuver.bearing_after` 欄位在部分 ORS 版本缺失 | 方位角計算退化 | Fallback 到 `way_points` 座標計算；以 `polyline` 前兩點作為最後備援 |
| BusLeg 缺少 `stopCount`（中間站數） | 公車指引句不完整 | 標注 ⚠️ 待確認；暫時省略站數說明，或從 GTFS stop_times sequence 差值計算 |
| TDX 額度（本功能不直接呼叫 TDX） | 無 | 本端點不呼叫 TDX，無額度風險 |
| 前端傳入的 `userHeading` 時序不準確 | relativeDirection 計算不精確 | 設計上已採方案 A（前端可自行換算），後端計算僅為便利功能，不強制依賴 |
| 語音朗讀繁中效果因裝置 TTS 引擎而異 | 語音品質 | 後端只負責文字品質；TTS 調校屬前端職責（語速、音調、暫停標記）|

---

*文件版本 v1.2.0 — as-built（2026-08-03）：全 WALK legs OTP-first、標記式 Valhalla 停機備援、幾何 bearing、公開 leg/進度索引與 routeToken 輸入。初稿 v1.0.0（2026-06-17）。*
