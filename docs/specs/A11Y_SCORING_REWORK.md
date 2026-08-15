# 無障礙評分與排序重構（Engine-first 混合）

## Design Plan v0.2 — 改進計畫（待 review，尚未實作）

> 日期：2026-06-16 ｜ 相關程式：`planners/otp-routing.ts`、`otp-data/router-config.json`、`scoring.ts`、`accessible-route.service.ts`、`planners/ors.ts`、`planners/walk-cache.ts`
> 前置文件：`FUNCTIONAL_SPEC_OTP2_INTEGRATION.md`
> 狀態：Proposed — 架構方向已定（engine-first 混合），OTP 2.9 控制面已研究定論（§2.5）
> v0.2 變更：依「無障礙權重主力放引擎層」的決策，全文改以 **引擎層 vs post 層** 分工重寫
> v0.3 變更（2026-06-16）：加入 OTP 2.9.0 GraphQL schema 研究定論（§2.5），修正 E2/E3/E4 與 §10 #1。
> 部署確認：`opentripplanner/opentripplanner:2.9.0`（`docker-compose.yml` pin），Java 21，graph.obj 含全台 GTFS+OSM。
>
> **實作進度（2026-06-17）：**
>
> - ✅ **P1 兩段式評分**（`finalizeRoutes`：prerank→enrich top-8→re-score→top-3）+ `prerankCost`/`prerankByProxy`。
> - ✅ **P3 中性基準 40**（`scoreFacilitySet` 空集合回 `FACILITY_NEUTRAL`）+ `dataConfidence`/`scoreWarnings`（thirds 門檻）。
> - ✅ **步行距離懲罰**（`walkPenaltyScore` 進 `scoreRoute`、`routeCost`、`prerankCost`；P2 的 score/cost 面）。
> - ✅ 型別 + OpenAPI schema（`walkPenalty`/`dataConfidence`/`scoreWarnings`/`totalWalkDistanceM`）。
> - ✅ **P5 elderly/visual 驗證**：mode profiles（criticalWeights tactile/audio/toilet、transferMultiplier、
>   per-mode WALK_PENALTY）經測試確認生效；同一路線不同 mode 分數不同。
> - ✅ **E2 步行速度 mode 化**：`walkSpeedMps`（輪椅 0.8/長者 0.9/視障 1.0/一般 1.3 m/s）置於 `scoring.ts`；
>   `orsWalkingRoute` 信任 ORS 距離、用 mode 速度重算 duration（cache 不再跨 mode 洩漏）；OTP `plan` query
>   加 `walkSpeed` 參數 + `snapWalkLeg` mode 化；mode 串進 4 個 build 函式。
> - ✅ **Q4 vitest**：31 案例全過。`scoring.test.ts`（26：純函數 + routeCost 回歸 + P5 mode + E2 walkSpeed）
>   - `ranking.test.ts`（5，正式 `scoreAndRank` 跑政大三條，零 TDX）。`npm test`。`tsc --noEmit` 乾淨。
> - ✅ **排序翻轉實測**（wheelchair，空 a11y 重現 facility=0）：羅斯福(score6/736m) → 66→台鐵(score8/425m)
>   → **251(score0/1444m,penalty 封頂35) 掉到最後**。251 從第 2 名降到第 3 名，直接修掉最初抱怨。
> - ⏳ 未做：P2 硬上限、P4 即時故障入分、P6 TRA 欄位、build 對 429 韌性（快取+退避）。
> - ⚠️ 端對端未跑：finalizeRoutes 兩段式（含 live enrich 查 Mongo）與 E2 的 OTP `walkSpeed`（需 OTP 起來）
>   只在型別+單元層驗證；其終點 `scoreAndRank` 與 `walkSpeedMps` 已實測。

---

## 目錄

1. 問題陳述與根因
2. 架構決策：Engine-first 混合
   - 2.1 現況：OTP 已部分在做引擎層無障礙
   - 2.2 引擎層的三個控制面
   - 2.3 引擎結構上做不到的事 → post 層的必要性
   - 2.4 分工表
3. 設計決策（已拍板）
4. 目標與非目標
5. 改動規格 — Engine track（E1–E5）
6. 改動規格 — Post track（P1–P6）
7. 回應 schema 變動
8. 驗收條件與回歸測試
9. 風險與緩解
10. 待決問題

---

## 1. 問題陳述與根因

使用者回報：1.4 公里步行的路線仍排第二、685m 只算 8 分鐘、無障礙分數幾乎等於時間分數。

**症狀（純時間排序）是真的，但根因不是「沒寫無障礙邏輯」。** 用使用者的數字反推
`scoreRoute()`（`scoring.ts:469-474`）：

```
a11yScore  = facilityScore*(40/65) + criticalFeatureScore*(25/65)
totalScore = round( a11yScore * 0.65 + timeScore * 0.35 )
```

三條路線 component 皆 `facilityScore=0, criticalFeatureScore=0` ⇒ `totalScore = round(0.35×timeScore)`。
排序用的 `routeCost`（`scoring.ts:376`）綁死時間 ⇒ 排序退化成時間排序。

**為什麼 facility/critical 全歸零（兩個獨立根因）：**

- **根因 A — 評分跑在 enrichment 之前。** `finalizeRoutes()`（`:1457` 評分 → `:1468` 才補 a11y
  → `:1477` 才疊即時電梯故障），分數從不重算。OTP/transfer 路線在評分時 a11y 為空陣列
  （見 `otp-routing.ts:535-537,557-559` 全部 `[]`）⇒ facility=0。即時電梯故障也無法降分。
- **根因 B — OSM a11y 稀疏 +「無資料=最差」。** `scoreFacilitySet([])` 回 0（`scoring.ts:234`），
  台灣公車站多數無 OSM 節點 ⇒ facility 恆 0 ⇒ 無鑑別力 ⇒ 65% 無障礙預算作廢。

**其他確認缺陷：** 步行距離不在 score 也不在 cost；步行速度與 mode 脫鉤（685m=8min≈1.43m/s
是步行速度非輪椅速度，`ors.ts:12,78-87`）；長步行無懲罰（`isRouteExcluded` `:1232` 只擋樓梯/軌道無電梯）；
mode 預設 `normal`（`:1660`），不啟動輪椅權重。

---

## 2. 架構決策：Engine-first 混合

> 核心原則：**能進路由引擎（OTP）的權重就進引擎，源頭治理；引擎結構上看不到的才留 post 層。**
> 重型 journey planning 不自己重做（沿用 OTP2 的既定決策）。

### 2.1 現況：OTP 已部分在做引擎層無障礙

當 `mode=wheelchair` 時，無障礙**已經進到 OTP 的 generalized-cost Pareto 搜尋**：

- `planOtpRoute`（`otp-routing.ts:618`）：`wheelchair = opts?.mode === "wheelchair"` → 傳入 `plan(wheelchair:)`。
- `otp-data/router-config.json` 現值：
  ```json
  "wheelchairAccessibility": {
    "trip":     { "onlyConsiderAccessible": false, "inaccessibleCost": 3600 },
    "stop":     { "onlyConsiderAccessible": false, "inaccessibleCost": 600 },
    "elevator": { "onlyConsiderAccessible": false },
    "maxSlope": 0.083
  },
  "accessEgress": { "maxDuration": "20m" }
  ```

也就是說，無障礙 flag 缺失的 trip 已被加 3600s 成本、stop 加 600s、坡度 >8.3% 街道被避開。
這就是使用者想要的「引擎層權重」，**只是很薄**（binary、未調參、餵入資料稀疏）。

### 2.2 引擎層的三個控制面（不改 OTP 原始碼）

| 控制面                      | 旋鈕                                                                                 | 性質                         |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------- |
| **GraphQL `plan` 請求參數** | `wheelchair`、`walkSpeed`、`walkReluctance`                                          | 每次查詢可帶，**可 mode 化** |
| **router-config.json**      | `inaccessibleCost`、`maxSlope`、`accessEgress.maxDuration`、`onlyConsiderAccessible` | server 全域預設，重啟生效    |
| **餵入資料**                | GTFS `wheelchair_boarding`/`wheelchair_accessible`、OSM `wheelchair`/`incline` tags  | 決定引擎層差異化的上限       |

### 2.3 引擎結構上做不到的事 → post 層的必要性

1. **即時電梯故障（TDX）** — OTP graph 靜態，不知道電梯剛壞。
2. **我們自己的 OsmA11y POI 圖層** — OTP 只吃 GTFS flags + OSM 街道 tags，不吃我們 curated
   的「電梯/坡道/廁所獨立點」collection。
3. **elderly / visual_impaired 模式** — OTP 只有 `wheelchair` 一個維度，無導盲磚/語音號誌概念。
4. 分級 0–100 分數 + highlights 是 UI 需求。

→ **混合架構是必然，不是退而求其次。**

### 2.5 OTP 2.9 控制面（GraphQL schema 研究定論）

> 來源：OTP 2.9.0 `schema.graphqls`、docs.opentripplanner.org/en/v2.9.0 RouteRequest/Accessibility/BuildConfiguration。
> 以「改什麼、要不要重啟/重建」分三層：

**第 1 層 — Per-request（每次查詢可變，免重啟，經 GraphQL）**

- 舊 `plan` query（repo 現用）：`wheelchair: Boolean`、`walkSpeed: Float`、`walkReluctance: Float`、
  `walkBoardCost: Int`、`walkSafetyFactor`、`transportModes`、`maxTransfers`、`arriveBy`、`date/time`、`numItineraries`。
- 新 `planConnection` query（2.9 推薦，`plan` 已 deprecated）：`preferences.accessibility.wheelchair.enabled`、
  `preferences.street.walk.{speed, reluctance, boardCost, safetyFactor}`、`preferences.transit.*`。
- **鐵證（schema 原文）**：整個 wheelchair 偏好只有一個欄位：
  ```graphql
  input WheelchairPreferencesInput {
    enabled: Boolean
  }
  input AccessibilityPreferencesInput {
    wheelchair: WheelchairPreferencesInput
  } # 註解：currently the only accessibility mode available
  ```
  ⇒ **per-request 的無障礙維度 = 只有一個布林開關**；可另外 per-request 調步速/reluctance。

**第 2 層 — Server config（`router-config.json` routingDefaults，改完重啟 OTP，不必重建圖）**

- `wheelchairAccessibility`：`maxSlope`(0.083)、`slopeExceededReluctance`(1.0，每超 1% 成本翻倍)、
  `stairsReluctance`(100)、`inaccessibleStreetReluctance`(25)、`trip/stop/elevator` 各
  `onlyConsiderAccessible`/`inaccessibleCost`(3600)/`unknownCost`(600)。
- `accessEgress.maxDuration`（**官方預設 45m，repo 設 20m**）、`maxDurationForMode`、`penalty`、`maxStopCount`。
- `walk.*`(speed 1.33、reluctance 2.0、stairsReluctance、boardCost)、`maxDirectStreetDuration`。
- **全域**：套用每一個 wheelchair 查詢，無法 per-user。

**第 3 層 — Build config（`build-config.json`，改完要重建 graph.obj）**

- `osmDefaults.osmTagMapping`：`default`/`uk`/`germany`/`finland`/`norway`/`houston`...（台灣無專屬 mapper，現用 `default`，
  決定 OSM `wheelchair`/`incline`/`kerb`/`surface`/`steps` 如何讀入街道圖）。
- `transferRequests` 加 `wheelchairAccessibility.enabled:true` → **建圖時預算無障礙轉乘**。
- `subwayAccessTime`(2.0 分)。

**四個硬限制（thesis-critical）**

| #   | 限制                                                  | 後果                                                             |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | OTP 只有 wheelchair 一種無障礙模式（schema 明說）     | elderly/visual 引擎完全做不到 → 100% post 層                     |
| 2   | slope/cost 旋鈕不能 per-request                       | 無法做個人化 profile；全域一套                                   |
| 3   | `accessEgress.maxDuration` 不能 per-request           | 「per-mode 步行上限」做不到 per-request → 全域 config 或 post 層 |
| 4   | OTP 看不到即時電梯故障、看不到我們的 OsmA11y POI 圖層 | 必然 post 層                                                     |

**論點定位**：OTP 提供「全域、僅限輪椅、網路層級」的無障礙成本模型；個人化 profile、非輪椅障別、
即時設施狀態、curated POI 圖層皆在其能力之外 → 混合架構為必然，post 層承載多障別與即時智能。

### 2.4 分工表

| 維度                          | 放哪                               | 對應條目 |
| ----------------------------- | ---------------------------------- | -------- |
| mode→wheelchair 確實傳到 OTP  | 引擎                               | E1       |
| 步行速度 mode 化              | 引擎（`walkSpeed`）                | E2       |
| 長步行上限（源頭剪枝）        | 引擎（`accessEgress.maxDuration`） | E3       |
| 輪椅 stop/trip 成本調校       | 引擎（`inaccessibleCost`）         | E4       |
| GTFS/OSM 無障礙資料補齊       | 引擎（餵入資料，前置）             | E5       |
| 評分時機 bug（enrich 前）     | post                               | P1       |
| 步行距離進分數 + 長步行軟懲罰 | post（補引擎沒剪掉的）             | P2       |
| 未知資料：中性基準 + 信心度   | post                               | P3       |
| 即時電梯故障降分              | post                               | P4       |
| elderly / visual 維度         | post                               | P5       |
| TRA 列車欄位完整性            | post                               | P6       |

---

## 3. 設計決策（已拍板）

1. **無障礙權重主力放引擎層**（engine-first 混合）。
2. **未知資料** → 中性基準（≈40）+ `dataConfidence` 信心度分離 + warning。
3. **輪椅長步行** → 軟懲罰（隨距離遞增），不硬拒絕。引擎層先用 maxDuration 剪極端。
4. **本次範圍** → 全面分析 + 改進計畫（本文件），不改 code。

---

## 4. 目標與非目標

**目標**

- 無障礙在候選生成階段（OTP）就生效，而非僅事後評分。
- 步行距離/速度/轉乘對輪椅/長者/視障有實質且 mode-aware 的權重。
- post 層分數反映 enrichment 後完整資料（含即時電梯故障）。

**非目標**

- 不重做 transit journey planning（OTP2 負責）、不改 OTP 原始碼。
- 不在本階段大規模重建 OSM/GTFS 資料管線（E5 僅定義前置與最小集）。

---

## 5. 改動規格 — Engine track（OTP 層）

### E1 確保 mode 真的傳到 OTP wheelchair flag

**問題**：mode 預設 `normal`（`:1660`），request 未帶且 query 未解析出輪椅意圖時，
OTP 的 wheelchair 完全不啟動。

**方案**

- 前端/呼叫端契約：行動不便使用者的查詢務必帶 `mode:"wheelchair"`（或 elderly/visual）。
- `parseRouteIntent` 對「輪椅/無障礙/電梯/行動不便」等語意要可靠映射到 `mode`。
- 記一行 log：實際送入 OTP 的 `wheelchair` 值，便於驗證引擎層有開。

### E2 步行速度 mode 化（OTP `walkSpeed` 請求參數）— ✅ 已確認可行 per-request

**問題**：步行時間用 ORS 結果或寫死 60 m/min，與 mode 脫鉤。
**可行性**：`walkSpeed: Float` 在舊 `plan` query 即為 per-request 參數（§2.5 第 1 層），
不必 migrate 到 planConnection 即可實作。

**方案**：`PLAN_QUERY`（`otp-routing.ts:169`）增加 `$walkSpeed: Float`，依 mode 帶入：

| mode            | walkSpeed (m/s) |
| --------------- | --------------- |
| wheelchair      | 0.8             |
| elderly         | 0.9             |
| visual_impaired | 1.0             |
| normal          | 1.3             |

- 同步給 OTP 的 access/egress 步行段套用 → 685m 步行對輪椅變 ≥14 分鐘。
- snap walk leg（`otp-routing.ts:420`）與 ORS fallback（`ors.ts`）也用同一張速度表，
  walk-cache key 加上 mode（`planners/walk-cache.ts`），避免跨 mode 汙染。

### E3 長步行上限 — ⚠️ 已查明：`accessEgress.maxDuration` **不能 per-request**

**問題**：OTP 現 `accessEgress.maxDuration: "20m"` 對所有 mode 一致，輪椅可被分到很長的
access 步行段（1.4km）。

**研究結果（§2.5 第 2 層）**：`accessEgress.maxDuration` 是 router-config 全域設定，
GraphQL `plan`/`planConnection` 皆無對應 per-request 欄位 ⇒ **無法做 per-mode 上限**。

**修正方案**

- 引擎層只能做「全域」決策：維持 20m（或微調），影響所有 mode。不為輪椅單獨砍。
- **per-mode 長步行差異化全部交給 post 層 P2 軟懲罰**（隨距離遞增，依 mode 不同門檻）。
- 若未來要真正引擎層 per-mode 上限：唯一途徑是跑多個 OTP router/instance（不同 config），
  成本高，本期不採。

> 結論：E3 從「引擎源頭剪枝」降級為「全域上限維持現狀」，長步行的 mode 差異化責任移到 P2。

### E4 輪椅 stop/trip 成本調校

**現值** `inaccessibleCost` trip 3600 / stop 600、`onlyConsiderAccessible:false`。

**方案**

- 維持 `onlyConsiderAccessible:false`（避免在資料稀疏下把所有選項剪光 → 0 結果）。
- 待 E5 資料補齊後，再評估提高 `inaccessibleCost` 或對特定系統開 `onlyConsiderAccessible`。
- 本階段先**不動數值**，僅記錄為 E5 完成後的後續旋鈕。

### E5 GTFS / OSM 無障礙資料補齊（前置，決定引擎層上限）

**覆蓋率已量測 → 見 `docs/reports/A11Y_DATA_COVERAGE.md`（2026-06-16）。** 重點：

- `stops.txt` **整欄無 `wheelchair_boarding`**（連原始 TDX feed 也沒）→ OTP 每站皆 unknown，
  `stop.inaccessibleCost` 永不觸發。
- `trips.txt` `wheelchair_accessible` 僅 164/150,070（全台鐵，`inject-tra-gtfs.py` 注入）。
- `pathways.txt` 有 **702 電梯 / 1,071 樓梯** → 站內輪椅路徑是引擎層唯一有料的部分。
- OsmA11y（post 層）11,242 點對 13 萬公車站極稀疏；`ramp`/`incline`/`ramp:wheelchair` 近乎 0
  → `scoring.ts` 找這些 tag 的分支等同死碼。

**高槓桿補齊（依序）**

1. ✅ **已實作並驗證(91 站)**：捷運站 `stops.txt.wheelchair_boarding` 注入 —— `build-otp-graph.sh`
   步驟 1d（`inject-station-wheelchair.py`）。真實 schema = top-level `Elevators` 陣列 + `StationID` 鍵
   （非 FacilityType；v1 用錯 schema 注入 0 筆，2026-06-17 修正）。實測對到 **91 站**
   （KRTC 37/TYMC 22/TMRT 18/NTMC 14）。**TRTC 0（Elevators 全空 → 待 OSM 補位）；TRA/THSR StationFacility 404。**
   ⚠️ **目前 serving graph(6/17 build)是修正前跑的、無此欄 → 需重建 graph 才生效。**
2. 量測 OSM pbf 街道 `incline`/`wheelchair` tag 覆蓋（本機缺 osmium，方法見報表 §6）→ 決定 maxSlope 系列是否值得投入。
3. 公車旗標量大來源弱，短期不追，靠 post 層 OsmA11y + 中性基準(P3) 兜底。

> E4 的 stop/trip 調參依賴 E5 #1；E2(walkSpeed) 與 pathways 電梯/樓梯調校不依賴 E5，可先做。

---

## 6. 改動規格 — Post track（OTP 看不到的）

### P1 評分時機：兩段式排序（修根因 A）

```
階段1 預排序：無障礙感知代理 cost（時間 + 轉乘×mult + 步行距離懲罰，不需 OSM 資料）→ top-N
階段2 enrich ：對 top-N 跑 enrichTopRoutes + overlayFacilityStatus
階段3 重評分：用完整 a11y 資料重算 scoreRoute → routeCost 重排 → final top-3
```

- 影響 `accessible-route.service.ts`：`finalizeRoutes`、`scoreAndRank` 拆為
  `prerankByProxy` + `scoreAndRank`。
- N = 8（見 §10 #2）。enrich 仍 fail-soft、有 timing log。Stage 2 只做 Mongo a11y；TDX overlay 留 top-3。

### P2 步行距離進分數 + 輪椅長步行軟懲罰（補 E3 沒剪掉的）

```ts
function walkPenaltyScore(walkDistanceM, mode): number {
  const { freeM, slope, cap } = WALK_PENALTY[mode];
  return Math.min(Math.max(0, walkDistanceM - freeM) * slope, cap); // 正值，呼叫端做減法
}
```

| mode            | freeM | slope(/m) | cap |
| --------------- | ----- | --------- | --- |
| wheelchair      | 150   | 0.03      | 35  |
| elderly         | 200   | 0.025     | 30  |
| visual_impaired | 250   | 0.02      | 25  |
| normal          | 400   | 0.01      | 15  |

- `scoreRoute` totalScore 扣 `walkPenaltyScore`；`routeCost` 加同量（並用於 P1 預排序代理）。
- 預期：251（1444m）≈cap(35)、羅斯福路幹線（736m）≈-18、66→TRA（425m）≈-8 ⇒ 排序翻轉。

### P3 未知資料：中性基準 + 信心度分離（修根因 B）

```ts
const FACILITY_NEUTRAL = 40;
export function scoreFacilitySet(nodes) {
  if (!nodes.length) return FACILITY_NEUTRAL;   // 由 0 改 40
  ...
}
```

新增 `dataConfidence: "high"|"medium"|"low"` 與 `warnings: string[]`，依「有資料 leg 比例」決定。
**安全底線**：中性基準只用於 facility（環境品質）；軌道段「有資料卻無電梯」仍照
`isRouteExcluded` 視為風險，不放寬。

### P4 即時電梯故障降分（確保在最終分數之前）

`overlayFacilityStatus` 目前跑在評分後。P1 兩段式後，它落在「階段2 enrich」內、「階段3 重評分」前
→ 電梯故障能反映到最終分數。需確認 overlay 寫回的欄位被 `scoreRoute` 讀到。

### P5 elderly / visual_impaired 維度

`MODE_PROFILES` 已有 elderly/visual 的 criticalWeights（`scoring.ts:319-348`）。
確認 P1–P3 後這兩個 mode 的權重真的生效（導盲磚/語音號誌權重、Tier 偏好）。

### P6 TRA 列車欄位完整性

- 確認 `recoverRailTrainNos`（`:1487`）補齊 `trainNo`；OTP 路線經 `trainNoFromTripId`
  （`otp-routing.ts:165`）解析，缺漏時記 warning。
- 前端契約：TRA/THSR 段讀 `trainNo` + `trainTypeName`，勿 parse 頂層 `routeName`。

---

## 7. 回應 schema 變動

`AccessibleRoute`（`types/route.ts:126`）新增（皆 optional，向後相容）：

```ts
dataConfidence?: "high"|"medium"|"low";
scoreWarnings?: string[];
totalWalkDistanceM?: number;
```

`scoreComponents` 增列 `walkPenalty: number`。OpenAPI（`src/openapi/document.ts`）同步更新。

---

## 8. 驗收條件與回歸測試

1. **引擎層生效**：log 確認 `mode=wheelchair` 時送入 OTP 的 `wheelchair=true` 且 `walkSpeed=0.8`。
2. **步行時間**：wheelchair 685m 步行 ≥14 分鐘（不再 8 分鐘）。
3. **排序翻轉**：政大→台北車站 wheelchair，步行 425m 的路線排名高於 1444m 的路線。
4. **分數鑑別力**：三條路線 `accessibilityScore` 不再全塌在 0–6，彼此差距 >10。
5. **enrich 後重評分**：含電梯的軌道路線 facility component >0。
6. **即時故障降分**：注入電梯故障 → 該路線分數下降。
7. **信心度**：無 OSM 資料路線 `dataConfidence="low"` + warning，但分數非 0。
8. **不 404**：長步行全被罰仍回傳路線（軟懲罰）。

> 專案目前無測試框架（CLAUDE.md）。建議引入最小 vitest，對 `scoring.ts` 純函數
> （`routeCost`、`scoreRoute`、`walkPenaltyScore`、`scoreFacilitySet`）做單元測試做為 backbone。

---

## 9. 風險與緩解

| 風險                                              | 緩解                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| 引擎層差異化受限於 GTFS/OSM 資料品質              | E5 先量測覆蓋率；資料不足時 post 層 P2/P3 兜底                      |
| 調 `accessEgress.maxDuration` 太緊 → 部分 OD 無解 | per-mode 設定 + 保留 server fallback；P2 軟懲罰兜底                 |
| 中性基準 40 高估「真的很差」的路線                | 僅環境品質用中性；軌道電梯/即時故障仍嚴格 + 低信心 warning          |
| 兩段式 N=8 增加 enrich 成本                       | 只影響 Stage 2 Mongo nearbyA11y（毫秒級）；TDX overlay 仍只跑 top-3 |
| walk-cache 加 mode 後命中率下降                   | 可接受，正確性優先                                                  |
| 改 router-config 需重啟 OTP sidecar               | 納入部署檢查清單；config 變更走版控                                 |

---

## 10. 待決問題（2026-06-16 已拍板）

1. ~~OTP 是否支援 per-request 覆寫 `accessEgress.maxDuration` / `wheelchairAccessibility`？~~
   **已答（§2.5）**：否。wheelchair per-request 僅 `enabled` 布林；maxDuration/cost/slope 皆全域 config。
   ⇒ E3 走「全域維持 + post 層 P2」；個人化 profile 不可能在引擎層做。
   **`plan`→`planConnection` 遷移：延後（中期）** —— 非阻塞，walkSpeed 在舊 `plan` 已有；遷移要換 Relay
   connection 回傳結構，不佔本期。
2. **N = 8。** TDX-heavy overlay 仍只跑最終 top-3，N 只多影響 Stage 2 的 Mongo `nearbyA11y`
   （毫秒級、可忽略）；放寬到 8 給 facility 重排空間以救回 proxy 低估的好設施路線。候選池 < N 時 enrich 全部。
3. **walkSpeed 照初稿（生理常數，不校準）；WALK_PENALTY 照初稿，政大案例當回歸測試而非反推**
   （避免 overfit 單一案例；初稿值估算已能讓 425m 排在 1444m 之前，測試掛掉再調）。
4. **metro/rail 先，且已實作（step 1d，見 E5）；bus 本期不做**（無公開來源、ROI 低，靠 post 層 P2/P3）。
   本期 E5 範圍 = step 1d 注入 + 覆蓋率報表（皆 done）。下一 metro 增量：重建後若 log 顯示 TRTC=0
   → OSM 電梯點補位。
5. **是，本期引入最小 vitest。** 只測 `scoring.ts` 純函數（`routeCost`/`scoreRoute`/`walkPenaltyScore`/
   `scoreFacilitySet`/`slopeContribution`/`widthContribution`）+ 政大排序回歸案例；不碰整條 pipeline。
6. **`dataConfidence`：r = 有 a11y 證據的 leg 數 / 總 leg 數；high ≥ 2/3、medium ≥ 1/3、low < 1/3。**
   門檻設常數可調。現階段稀疏資料下多數公車路線會落 low（誠實訊號），隨 E5 自然上升。
