# OTP2 Transit Engine 整合

## Functional Specification v1.0 — Phase 16（已完成）

> 日期：2026-06-11 ｜ 前置文件：`FUNCTIONAL_SPEC_v1.2.md`
> （原 `ROUTING_PIPELINE_DIAGNOSIS.md` 已退役刪除，其問題清單併入本文 §1 與附錄）
> 狀態：Active — Phase 16 已完成，OTP2 為主路由引擎（2026-06）

---

## 目錄

1. 背景與動機
2. 目標與非目標
3. 系統架構
4. OTP2 服務架設
5. 資料管線（GTFS + OSM → Graph）
6. API 對接層（`planOtpRoute`）
7. 欄位映射規格（OTP Itinerary → AccessibleRoute）
8. 與現有層的協作（a11y / realtime / slim）
9. 部署與維運
10. 漸進式切換（Rollout）
11. 驗收條件與回歸測試
12. 風險與緩解

---

## 1. 背景與動機

前期診斷確認自製 GTFS graph router 的問題屬於**演算法類別性缺陷**：
同線多 candidate、同站同線退化轉乘、時間語義錯亂、轉乘列舉的 build budget 上限。
逐項修補可止血（問題一、二、班表時間已修），但 RAPTOR 級的 journey planning
（Pareto-optimal、多 feed、frequencies、轉乘最佳化、wheelchair flag）不值得自己重造。

OTP2（OpenTripPlanner 2.x）是此需求的業界標準：GTFS 是一級公民、原生
`wheelchair` 規劃（吃 GTFS `wheelchair_boarding` / `wheelchair_accessible` ＋
OSM wheelchair tags）、活躍維護。OSRM / GraphHopper / Valhalla 為街道引擎，
不適合 transit 核心。

**本系統的核心價值不變**：a11y 評分引擎、OSM 設施 enrichment、室內導航、
Phase 15 即時 overlay 都留在 Node orchestrator。OTP2 只取代「transit 班表規劃」
這一層。

## 2. 目標與非目標

### 2.1 目標

- G1：OTP2 以 sidecar 服務形式部署，提供台中市（先行）公車＋台鐵的 transit 規劃。
- G2：新增 `planOtpRoute()` planner，輸出與現有 `AccessibleRoute` 完全相容，
  進入既有 `finalizeRoutes()`（dedup → collapse → 評分 → overlay → slim）。
- G3：以 feature flag 漸進切換，任一階段 OTP 故障都 fail-soft 回現有 planner。
- G4：原本的三類 bug 在 OTP 路徑上**結構性消失**（驗收條件 §11）。

### 2.2 非目標

- 不取代 a11y 評分 / 設施 enrichment / 室內 graph（維持 Node 層）。
- 不取代 Phase 15 即時 overlay（TDX 無公開 GTFS-RT，OTP 端先跑純班表；
  GTFS-RT 轉接為 Phase 17 候選，見 §12）。
- 第一階段不處理 THSR／跨縣市公路客運（暫留 `planTdxRoute` 補位）。
- 不改 API 對外形狀（`POST /api/v1/accessible-route` 的 request/response 不變）。

## 3. 系統架構

```
                       ┌────────────────────────────┐
  TDX GTFS feeds ────► │  Graph Build Pipeline      │  (§5, 週期性)
  OSM Taiwan pbf ────► │  otp --build --save        │
                       └──────────┬─────────────────┘
                                  ▼ graph.obj
                       ┌────────────────────────────┐
                       │  OTP2 Server (Java 21)     │  (§4)
                       │  GTFS GraphQL API :8080    │
                       └──────────┬─────────────────┘
                                  │ HTTP (内網)
┌─────────────────────────────────▼──────────────────────────────────┐
│  Node Orchestrator（現有 findAccessibleRoutes）                     │
│   ├─ planOtpRoute()      ← 新增 (§6)        USE_OTP_ROUTER          │
│   ├─ planGtfsRoute()     ← 現有自製 graph    USE_GTFS_ROUTER         │
│   ├─ planTdxRoute()      ← TDX MaaS 補位     USE_TDX_ROUTING         │
│   └─ finalizeRoutes()    ← dedup / collapse / 評分 / overlay / slim │
└────────────────────────────────────────────────────────────────────┘
```

設計原則：**OTP 是又一個 planner，不是新架構**。所有 planner 輸出同一個
`AccessibleRoute` 型別，下游零改動。

## 4. OTP2 服務架設

### 4.1 版本與環境

| 項目     | 規格                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| OTP 版本 | 2.5+（固定 minor 版本，鎖在 image tag）                                      |
| Java     | 21（OTP 2.5 起要求）                                                         |
| 記憶體   | 台中市 GTFS＋台灣 OSM 裁切：build 6–8 GB、serve 2–4 GB（實測後調整）         |
| 部署     | Docker（官方 `opentripplanner/opentripplanner` image），與 Node 同機或同內網 |
| Port     | 8080（僅內網開放，不對外）                                                   |

### 4.2 目錄與設定檔

```
/var/otp/
├── otp-config.json        # { "otpFeatures": {} } — 先用預設
├── build-config.json      # 建圖參數 (§4.3)
├── router-config.json     # 查詢預設 (§4.4)
├── taichung-gtfs.zip      # TDX 台中市公車 GTFS
├── tra-gtfs.zip           # 台鐵 GTFS（如 TDX 提供；否則 Phase 16.5）
├── taiwan-taichung.osm.pbf# OSM 裁切（台中市 bbox + buffer）
└── graph.obj              # build 產物
```

### 4.3 `build-config.json`（重點參數）

```json
{
  "transitServiceStart": "-P1D",
  "transitServiceEnd": "P90D",
  "osmDefaults": { "osmTagMapping": "default" },
  "subwayAccessTime": 2.0
}
```

- OSM wheelchair tags（`wheelchair=*`、`kerb`、`incline`、`smoothness`、
  `surface`）由 OTP 預設 mapping 處理，與本系統 `osmTagMap` 的評分互不衝突
  （OTP 管可不可走，本系統管走起來多無障礙）。

### 4.4 `router-config.json`（查詢預設）

```json
{
  "routingDefaults": {
    "wheelchairAccessibility": {
      "trip": { "onlyConsiderAccessible": false, "inaccessibleCost": 3600 },
      "stop": { "onlyConsiderAccessible": false, "inaccessibleCost": 600 },
      "elevator": { "onlyConsiderAccessible": false },
      "maxSlope": 0.083
    },
    "searchWindow": "2h",
    "numItineraries": 5
  }
}
```

- `onlyConsiderAccessible: false` ＋ 高 cost：與本系統 Phase 11 哲學一致——
  「有風險的路線勝過 404」，硬排除交給 Node 層的 `applyModeExclusion`。
- 台灣 GTFS 的 `wheelchair_boarding` 覆蓋率低（多為 0 = unknown），
  所以**不能**開 `onlyConsiderAccessible: true`，否則查無結果。

## 5. 資料管線（GTFS + OSM → Graph）

| 步驟         | 內容                                                                   | 頻率       |
| ------------ | ---------------------------------------------------------------------- | ---------- |
| 1. 抓 GTFS   | TDX GTFS 靜態 feed（台中市公車；既有 token 管理沿用 `TdxTokenManger`） | 每週       |
| 2. 抓 OSM    | Geofabrik Taiwan pbf → `osmium extract` 裁台中 bbox                    | 每月       |
| 3. Feed 驗證 | `gtfs-validator`，紅燈（缺 calendar/stop_times）即中止並告警           | 每次 build |
| 4. Build     | `otp --build --save /var/otp`（離線，不影響 serving）                  | 每週       |
| 5. 部署      | graph.obj 原子替換 → 重啟 container → healthcheck 過了才切流量         | 每週       |

- 新增 script：`src/scripts/build-otp-graph.sh`（cron 驅動，失敗保留舊 graph）。
- **既有的 GTFS → Mongo import 管線保留**：站牌 geo 查詢、a11y enrichment、
  Phase 15 overlay 的 stopId 對應都還需要 Mongo 的 `GtfsStop`。

## 6. API 對接層（`planOtpRoute`）

新檔 `src/modules/accessible-route/planners/otp-routing.ts`，介面對齊現有 planner：

```ts
export async function planOtpRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: {
    departureTime?: Date; // controller 已 clamp 過去時間 → now
    maxTransfers?: 0 | 1 | 2;
    mode?: AccessibilityMode; // "wheelchair" → wheelchair: true
    limit?: number;
  },
): Promise<AccessibleRoute[]>;
```

### 6.1 查詢（GTFS GraphQL API，`POST /otp/gtfs/v1`）

```graphql
{
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date # "2026-06-11"（Asia/Taipei，OTP 用 feed 時區）
    time: $time # "10:00"
    wheelchair: $wheelchair
    numItineraries: 5
    transportModes: [{ mode: WALK }, { mode: TRANSIT }]
  ) {
    itineraries {
      duration
      walkDistance
      legs {
        mode # WALK | BUS | RAIL | SUBWAY
        startTime
        endTime # epoch ms
        from {
          name
          stop {
            gtfsId
            code
            lat
            lon
          }
        }
        to {
          name
          stop {
            gtfsId
            code
            lat
            lon
          }
        }
        route {
          gtfsId
          shortName
          longName
          type
          agency {
            gtfsId
          }
        }
        trip {
          gtfsId
          wheelchairAccessible
        }
        legGeometry {
          points
        } # Google encoded polyline
        intermediatePlaces {
          stop {
            gtfsId
          }
        }
      }
    }
  }
}
```

### 6.2 行為規格

- **時間語義**：`opts.departureTime ?? new Date()`，格式化為 feed 時區的
  date/time。OTP 的 searchWindow 向後找，不可能回傳過去班次
  （原問題三在此路徑結構性消失）。
- **轉乘上限**：OTP 不直接限制轉乘次數 → 取回 itineraries 後在 Node 層過濾
  `transitLegs.length - 1 > maxTransfers` 者。
- **逾時與 fail-soft**：HTTP timeout 3s；任何錯誤回 `[]` 並 `console.warn`，
  orchestrator 照常使用其他 planner 的結果（與現有 `.catch(() => [])` 模式一致）。
- **routeId 規約**：`otp-${itinerary index}-${第一段 transit 的 trip gtfsId}`。

## 7. 欄位映射規格（OTP Itinerary → AccessibleRoute）

### 7.1 Leg 分流

| OTP `leg.mode` / route.type                 | AccessibleRoute leg | 備註                        |
| ------------------------------------------- | ------------------- | --------------------------- |
| `WALK`                                      | `WalkLeg`           | §7.3                        |
| `BUS`（type 3）                             | `BusLeg`            |                             |
| `SUBWAY`／route.gtfsId 前綴 ∈ METRO_SYSTEMS | `MetroLeg`          | 沿用 `systemFromId()` 判斷  |
| `RAIL`＋agency TRA                          | `TraLeg`            | trainNo 取 trip gtfsId 尾碼 |
| `RAIL`＋agency THSR                         | `ThsrLeg`           | Phase 16 暫不啟用           |

### 7.2 Transit leg 欄位

| AccessibleRoute 欄位                    | 來源                                                           | 規則                                                              |
| --------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `routeName`                             | `route.shortName \|\| route.longName`                          |                                                                   |
| `departureStop` / `arrivalStop`         | `from.name` / `to.name`                                        |                                                                   |
| `departureStopId` / `arrivalStopId`     | `stop.gtfsId` 去 feedId 前綴（`"1:TXG123" → "TXG123"`）        | Phase 15 overlay 靠前綴選 ETA endpoint，**必須**還原成 TDX stopId |
| `departureTime` / `arrivalTime`         | `startTime` / `endTime` → `"HH:mm"`（Asia/Taipei）             |                                                                   |
| `waitInfo`                              | `{ time: departureTime, source: "schedule" }`                  | **新 WaitInfo 契約**：schedule → "HH:mm"，不得放分鐘數            |
| `estimatedWaitMinutes`                  | `(startTime − 前一 leg endTime) / 60000`，首段以查詢時間為基準 | 數值估計欄位，供 totalMinutes/排序                                |
| `direction`                             | GTFS gtfsId 解析；無法解析時 0                                 | OTP 不直接給 direction，盡力而為                                  |
| `polyline`                              | decode `legGeometry.points` → `[lng, lat][]`                   | 新增 `decodePolyline()` util；座標序與現有一致（lon 在前）        |
| `departureStopA11y` / `arrivalStopA11y` | **不在此層填**                                                 | 由 orchestrator 統一 enrichment（§8.1）                           |

### 7.3 Walk legs

兩個選項，Phase 16 採 **A**：

- **A（預設）**：直接用 OTP 的 WALK legs（OSM wheelchair routing、含轉乘走路）。
  ORS 保留為 OTP 失敗時的 fallback。優點：單一引擎、轉乘走路也有真實 geometry、
  擺脫 ORS 429。
- **B**：丟棄 OTP walk legs、保留 ORS（現狀）。只在 A 的步行品質驗收不過時退回。

### 7.4 Route 層

| 欄位                      | 規則                                                    |
| ------------------------- | ------------------------------------------------------- |
| `totalMinutes`            | `itinerary.duration / 60` 四捨五入                      |
| `transferCount`           | transit legs 數 − 1                                     |
| `accessibilityHighlights` | 空陣列起步，交給下游（評分、overlay）填                 |
| `accessibilityScore` 等   | 不在此層算——`finalizeRoutes` 的 `scoreAndRank` 統一處理 |

## 8. 與現有層的協作

### 8.1 a11y enrichment 上移（連動原問題四）

藉此機會把 `attachA11yToLeg` / `nearbyA11y` 從 planner 內部抽出，移到
`finalizeRoutes` 在 top-3 確定後統一執行：

- `planOtpRoute` 一開始就**不做** enrichment（乾淨實作）。
- `planGtfsRoute` / `planTdxRoute` 的內部 enrichment 在 Phase 16.5 移除。
- 效益：每次請求的 `nearbyA11y` Mongo 查詢從「每 candidate × 每站」降為
  「top-3 × 每站」。

### 8.2 Phase 15 realtime overlay

不變。前提是 §7.2 的 stopId 還原正確（overlay 用 stopId 前綴選 TDX ETA
endpoint）。驗收含一條「OTP 路徑上 overlay 正常把 schedule 換成 realtime」。

### 8.3 室內導航（enrichLegIndoor）

rail legs 的室內 graph enrichment 移到 orchestrator 對 top-3 執行（同 §8.1），
OTP planner 不感知。

## 9. 部署與維運

| 項目        | 規格                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| 啟動        | `docker compose up otp`（`--load /var/otp`）                                             |
| Healthcheck | `GET /otp/actuators/health`，失敗 → Node 端 circuit-break 直接走 fallback                |
| 監控        | planner 層記錄：OTP 命中率、p95 latency、fail-soft 次數（先 console，後接現有 log 方案） |
| Graph 重建  | cron 每週日 04:00（§5），build 失敗保留舊 graph ＋告警                                   |
| 環境變數    | `OTP_BASE_URL`（如 `http://localhost:8080`）、`USE_OTP_ROUTER`                           |

## 10. 漸進式切換（Rollout）

| 階段         | 設定                                         | 行為                                                                                                                                                                                        | 退出條件                           |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| R0 架設      | `USE_OTP_ROUTER=false`                       | OTP 起服務，僅手動測試                                                                                                                                                                      | §11 冒煙全過                       |
| R1 影子      | `USE_OTP_ROUTER=shadow`                      | OTP 平行跑、結果只記 log 不進 response，與現行結果 diff                                                                                                                                     | 兩週 diff 無 OTP 端缺路線/壞資料   |
| R2 合流      | `USE_OTP_ROUTER=true` ＋ GTFS/TDX 照舊       | 三 planner 合流，靠 `collapseLogicalDuplicates` 收斂                                                                                                                                        | 評分排序穩定、無新類型客訴         |
| R3 主引擎 ✅ | 移除 `USE_GTFS_ROUTER`（OTP 為主、TDX 補位） | 自製 graph router 退役                                                                                                                                                                      | ✅ 2026-06 完成                    |
| R4 清理 ✅   | —                                            | 已刪 `gtfs-router.service.ts` 等程式碼；排程表 collections（`gtfs_routes/calendar/stop_times/shapes/frequencies` + `station_clusters`）待手動 drop，`gtfs_stops/trips/pathways/levels` 保留 | ✅ 2026-06（程式）｜DB drop 待執行 |

每一階段都可單獨回退（改 env 重啟即可），無資料遷移。

## 11. 驗收條件與回歸測試

冒煙查詢集（沿用原診斷的案例）：

| #   | 案例                                 | 期望                                                                                                          |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| A1  | 高美 → 台中科大，departureTime=10:00 | 不出現 < 10:00 的班次；500延只有一條 candidate                                                                |
| A2  | 同上，maxTransfers=1                 | 無「同線 → 同線」轉乘；無「可不下車」的冗餘轉乘                                                               |
| A3  | 同上，不帶 departureTime             | 班次時間 ≥ now                                                                                                |
| A4  | wheelchair mode                      | `wheelchair_boarding=2` 的站不被優先；分數由 Node 層算                                                        |
| A5  | waitInfo 契約                        | schedule leg → `time: "HH:mm"` 且 = `departureTime`；realtime overlay 後 → `time: number` 且 dep/arr 同步平移 |
| A6  | OTP 容器停掉                         | 回應照常（fallback planner），latency 增加 ≤ timeout 3s                                                       |
| A7  | 末班後查詢（23:50）                  | OTP searchWindow 跨日結果帶隔日標記（沿用 `departureDate` 慣例）                                              |

回歸方式：`src/scripts/debug-early-departure.ts` 擴充為 `debug-planner-compare.ts`，
同一查詢同時打三個 planner 印對照表（R1 影子期的 diff 工具）。

## 12. 風險與緩解

| 風險                                             | 影響                                                  | 緩解                                                                                |
| ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| TDX GTFS 品質（frequencies 漂移、calendar 過期） | OTP 缺班次/查無結果                                   | build 前 gtfs-validator 紅燈中止；R1 影子期 diff 抓缺漏                             |
| TRA GTFS 取得管道不穩                            | 台鐵段缺漏                                            | Phase 16 先公車；TRA 由 `planTdxRoute` 補位到 16.5                                  |
| 記憶體成本（JVM 2–4 GB serve）                   | 主機規格                                              | 先單一城市裁切；不夠再評估 MOTIS（C++，輕量替代）                                   |
| wheelchair 資料覆蓋率低                          | OTP wheelchair 過濾效果有限                           | cost-based 設定（§4.4）＋本系統評分仍是主要訊號                                     |
| 無 GTFS-RT                                       | OTP 端純班表                                          | Phase 15 overlay 照常補即時；Phase 17 候選：TDX live → GTFS-RT 轉接器餵 OTP updater |
| direction 欄位缺失                               | `collapseLogicalDuplicates` 的 bus key 用到 direction | 從 trip gtfsId 解析；解析不到時 key 退化為 routeName（接受少量過度收斂）            |

---

## 附錄：與原問題的對應

| 診斷問題                                  | 修補（已完成）         | OTP 路徑                                    |
| ----------------------------------------- | ---------------------- | ------------------------------------------- |
| 1 同線多 candidate / departureTime 不對稱 | ✅ collapse + 傳參修正 | 結構性消失（單引擎 Pareto-optimal）         |
| 2 同站同線退化轉乘                        | ✅ sameLine guards     | 結構性消失（RAPTOR 不會產生）               |
| 3 過去班次                                | ✅ controller clamp    | 結構性消失（searchWindow 向後）             |
| 4 polyline 冗餘                           | 未修                   | OTP shapes 品質佳；decode 後可順手 simplify |
| 5 a11y 耦合 routing layer                 | 未修                   | §8.1 隨本 Phase 一併上移                    |
