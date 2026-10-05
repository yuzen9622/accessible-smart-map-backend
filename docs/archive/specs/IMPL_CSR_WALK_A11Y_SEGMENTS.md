# IMPL：CSR 步行 polyline 無障礙設施分段標註（`a11ySegments`）

狀態：待實作（Claude 規劃，Codex 實作）
範圍決策（使用者本輪拍板）：**只做 CSR 台北純步行**、語意為**設施類別**（後端不做價值判斷、不出三級色階）。

## 1. 需求

前端要在地圖上把「經過無障礙設施的路段」（電梯、坡道、斜坡化路口…）用**與一般路段不同的顏色**畫出來。
目前 `WALK` leg 只回一條扁平 `polyline` 與整段聚合統計（`crossingsWithCurbRamp: 3`），前端無法知道**第幾段**是什麼設施。

## 2. 現況（已核實）

CSR 圖每條邊都帶設施身分，但在縫合幾何時被丟棄：

- `src/modules/accessible-route/planners/pedestrian-a11y/graph.types.ts`
  - `EDGE_TYPE`：`OSM_ELEVATOR(19)`、`INDOOR_WALKWAY(20)`、`INDOOR_STAIRS(21)`、`INDOOR_MOVING_WALKWAY(22)`、`INDOOR_ESCALATOR(23)`、`INDOOR_ELEVATOR(24)`、`INDOOR_FARE_GATE(25)`、`INDOOR_EXIT_GATE(26)`、`STEPS(6)`、`CROSSING(3)`
  - `EDGE_FLAG`：`HAS_RAMP: 1`、`INDOOR: 2`
  - `PedGraph` 已有 `edgeType` / `edgeFlags` / `edgeLengthM` / `edgeSlope` / `edgeWidthM`
- `csr-walk-planner.ts:199 assembleGeometry()` 把選中邊縫成單一 `LngLat[]`，**不保留哪些索引來自哪條邊**
- `csr-walk-planner.ts:299 summarizeAccessibility()` 只產生整段聚合值
- 前端契約：`src/types/route.ts:108 WalkLeg`（`extends WalkA11yDetails`，`:73`）

## 3. 契約設計

### 3.1 新增型別（`pedestrian-a11y/csr-walk.types.ts`，接在檔尾）

```ts
/**
 * Accessibility-relevant facility class of one traversed graph run.
 *
 * These are source-backed edge classifications, not quality judgements: the
 * client decides how to colour each class. `crossing` is the no-observed-ramp
 * counterpart of `curb_ramp_crossing` and is reported so a client can style
 * them differently; its presence is not a claim that no ramp exists on the
 * ground, only that the graph carries no ramp observation for that edge.
 */
export type CsrWalkA11yFeature =
  | "elevator"
  | "escalator"
  | "moving_walkway"
  | "ramp"
  | "curb_ramp_crossing"
  | "crossing"
  | "stairs"
  | "fare_gate"
  | "exit_gate";

/**
 * One contiguous run of the returned `polyline` carrying a facility class.
 *
 * `startIndex` / `endIndex` are inclusive indices into that same polyline, so a
 * client slices rather than re-matches coordinates. `startIndex === endIndex`
 * is a point feature, not a drawable line: a vertical facility such as an
 * elevator has both endpoints at one ground coordinate and must be rendered as
 * a marker. Runs never overlap and are ordered by `startIndex`.
 *
 * Unannotated stretches are deliberately absent; the client draws its base
 * walking colour and overlays only these runs.
 */
export interface CsrWalkA11ySegment {
  feature: CsrWalkA11yFeature;
  startIndex: number;
  endIndex: number;
  /** Whether the whole run is inside a station or building. */
  indoor: boolean;
  /** Run ground length, or null when any of its edges carries no usable length. */
  distanceM: number | null;
  /** Steepest absolute slope on the run, or null when unmeasured. */
  maxSlopePercent: number | null;
  /** Narrowest observed width on the run in centimetres, or null when unmeasured. */
  minWidthCm: number | null;
}
```

並在 `CsrWalkPlan` 的 `accessibility` 之後插入（**必填**，空陣列代表沒有任何被分類的設施）：

```ts
  /**
   * Facility-classified runs of `polyline`, ordered and non-overlapping.
   * Empty means no traversed edge carried a classified facility observation.
   */
  a11ySegments: CsrWalkA11ySegment[];
```

### 3.2 對外契約（`src/types/route.ts`）

在 `WalkLeg` 加**選用**欄位（非 CSR 引擎不會有；不可設為必填）：

```ts
  /**
   * CSR-engine facility runs over this leg's `polyline`, ordered and
   * non-overlapping. Absent on OTP / Valhalla walking legs, which carry no
   * per-edge facility provenance; absent therefore means "not observed by this
   * engine", never "no facilities on the ground".
   */
  a11ySegments?: CsrWalkA11ySegment[];
```

型別由 planner 模組 re-export 或在 `route.ts` 就地定義皆可，**但只能有一份定義**（擇一，勿複製兩份 union）。建議：`route.ts` 定義 `WalkA11ySegment` + `WalkA11yFeature` 為單一真相，planner 型別 `import type` 之並以 `CsrWalkA11ySegment = WalkA11ySegment` 別名，避免兩層 enum 漂移。

## 4. 實作

### 4.1 新檔 `pedestrian-a11y/a11y-segments.ts`（純函式，可單測）

匯出：

```ts
/** Inclusive polyline index range contributed by one traversed edge. */
export interface EdgeGeometrySpan { startIndex: number; endIndex: number }

export function classifyEdgeFeature(edgeType: number, edgeFlags: number): CsrWalkA11yFeature | null
export function buildA11ySegments(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
  spans: readonly EdgeGeometrySpan[],
  indexOffset: number,
): CsrWalkA11ySegment[]
```

`classifyEdgeFeature` 規則（**型別優先於 ramp flag**：帶 ramp 標籤的電梯邊是電梯）：

| 條件                                       | feature              |
| ------------------------------------------ | -------------------- |
| `OSM_ELEVATOR` / `INDOOR_ELEVATOR`         | `elevator`           |
| `INDOOR_ESCALATOR`                         | `escalator`          |
| `INDOOR_MOVING_WALKWAY`                    | `moving_walkway`     |
| `STEPS` / `INDOOR_STAIRS`                  | `stairs`             |
| `INDOOR_FARE_GATE`                         | `fare_gate`          |
| `INDOOR_EXIT_GATE`                         | `exit_gate`          |
| `CROSSING` 且 `HAS_RAMP`                   | `curb_ramp_crossing` |
| `CROSSING` 未帶 `HAS_RAMP`                 | `crossing`           |
| 其他型別但帶 `HAS_RAMP`                    | `ramp`               |
| 其他                                       | `null`（不產生 run） |

`buildA11ySegments` 行為：

1. 逐 step 分類；`null` 直接跳過（**不得產生 `normal` run**，缺標註不可讀成路況良好）。
2. 合併條件：`feature` 相同 **且** `indoor` 相同 **且** `open.endIndex === startIndex`（相鄰）。合併時 `endIndex` 延伸、`distanceM` 相加、`maxSlopePercent` 取大、`minWidthCm` 取小。
3. 逐邊量測皆走 fail-honest：長度僅在 `Number.isFinite && >= 0` 時採用，否則該邊為 `null`；**run 內任一邊長度未知 → 整個 run `distanceM: null`**，不得回報部分和。坡度僅 `Number.isFinite` 時採 `Math.abs(ratio) * 100`；寬度僅 `> 0` 時採 `m * 100`。
4. 輸出前四捨五入：`distanceM`、`maxSlopePercent` 保留 1 位小數；`minWidthCm` 取整。
5. 迴圈上界取 `Math.min(spans.length, edgeAttrPath.length)`，防禦長度不一致。

### 4.2 `csr-walk-planner.ts` 索引追蹤（**本案唯一高風險處**）

畫錯位置比不畫更糟，索引必須精準。

- `GeometryAssembly`（`:176`）的 `ok` 分支加 `spans: EdgeGeometrySpan[]`。
- `assembleGeometry()`（`:199`）迴圈內，**在 append 之前**取 `const startIndex = polyline.length === 0 ? 0 : polyline.length - 1;`
  理由：邊的幾何以「上一條邊的終點」為起點且會被 `isSameVertex` 去重，故該共用頂點的索引就是本邊起點；第一條邊時 polyline 為空，其首點會落在索引 0。
  append 完後 `spans.push({ startIndex, endIndex: Math.max(startIndex, polyline.length - 1) })`。
- **零長 span 必須保留**：室內電梯的兩端點是同一地面座標（僅樓層不同），去重後 `startIndex === endIndex`。這正是前端要畫成 marker 的點設施，不可丟棄。
- `addSnapConnectors()`（`:246`）改為回傳 `{ polyline: LngLat[]; indexOffset: number }`，`indexOffset` 為前端 connector 是否 unshift（`1` 或 `0`）。呼叫端（`:679`）改用其 `polyline`，並把 `indexOffset` 傳進 `buildA11ySegments`。
  **不可**在未套用 offset 的情況下輸出 spans。
- plan push（`:677` 附近）加 `a11ySegments: buildA11ySegments(graph, route.edgeAttrPath, geometry.spans, connectors.indexOffset)`。
- `summarizeAccessibility()` **不動**，聚合欄位維持既有語意與既有測試。

### 4.3 service 串接

`src/modules/accessible-route/accessible-route.service.ts:2235 buildCsrWalkRoute()` 的 leg 物件（`:2237`）加：

```ts
    a11ySegments: plan.a11ySegments,
```

其他引擎（OTP fallback、Valhalla、轉乘 WALK leg）**不得補空陣列**——省略欄位才代表「此引擎未觀測」，空陣列會被讀成「已觀測且沒有設施」。

### 4.4 Zod / OpenAPI

`src/modules/accessible-route/accessible-route.schema.ts:170 WalkLegSchema`，在 `restPoints` 之後、`steps` 之前插入 `.optional()` 陣列，元素 `.strict()` 且具名 `.openapi("WalkA11ySegment")`：

- `feature`：`z.enum([...9 類...])`，description 說明各類為來源標註、由前端決定配色
- `startIndex` / `endIndex`：`z.number().int().nonnegative()`，description 必須寫明「inclusive、索引指向同一 leg 的 `polyline`、`startIndex === endIndex` 為點設施（如電梯）應畫 marker 而非線段」
- `indoor`：`z.boolean()`
- `distanceM` / `maxSlopePercent`：`z.number().nonnegative().nullable()`
- `minWidthCm`：`z.number().positive().nullable()`
- 陣列層 description 必須寫明：**只有 `engine=pedestrian-a11y` 會有此欄位；欄位不存在代表該引擎無逐邊設施來源，不代表沿途沒有設施**

注意既有 repo 教訓：改 schema 後要前後比對產出的 `/api/v1/openapi.json`，確認沒有動到既有具名 component 的歸屬。

## 5. 測試（必須有會變紅的斷言）

1. `a11y-segments.test.ts`（新）
   - `classifyEdgeFeature` 九類全覆蓋 + `null` 情況；`OSM_ELEVATOR` 同時帶 `HAS_RAMP` 仍為 `elevator`
   - 合併：兩條相鄰同類同 indoor 邊 → 一個 run；中間插一條不同類 → 三個 run（不得誤併）
   - `indoor` 不同不得合併
   - run 內任一邊缺 `length_m` → `distanceM: null`（**這條是 fail-honest 的守門，必須存在**）
   - `indexOffset` 生效：offset=1 時所有索引 +1
   - 零長 span（`startIndex === endIndex`）被保留
2. `csr-walk-planner.test.ts`（既有，新增案例）
   - 端到端：三邊路徑（人行道→斜坡化路口→室內電梯），斷言 `a11ySegments` 的 `feature` 序列與**索引真的落在 `plan.polyline` 上對應的座標**（用座標回查驗證，不只比數字）
   - 有 snap connector 時索引位移正確
3. `accessible-route.service.test.ts`：CSR route 的 WalkLeg 帶 `a11ySegments`；OTP fallback 的 WalkLeg **不含**該鍵（用 `expect(leg).not.toHaveProperty("a11ySegments")`）
4. `accessible-route.schema.test.ts`：合法 segment 通過、`endIndex` 為負或 `feature` 未知被拒

## 6. 驗收

```bash
npx tsc --noEmit          # 必須 0
pnpm test                 # 基線 143 files / 1641 tests passed，新測試須淨增
```

真實 API 煙測（`PED_GRAPH_CSR_WALK_ENABLED=true`，`POST /api/v1/a11y/accessible-route`，明確帶 `mode=wheelchair`、`avoidStairs=true`）：

- `indoor_route` 案（既有紀錄：356 m、7 edges、含室內邊）→ 應出現含 `elevator` 或 `fare_gate`／`exit_gate` 的 segment，且索引在 polyline 範圍內
- `route_2` 案（1,065 m、44 edges）→ 至少應出現 crossing 類 segment
- 故意無效 PostGIS URL → `engine=otp-fallback` 且回應**沒有** `a11ySegments` 鍵

## 7. 文件

`docs/reports/PED_ROUTER_PURE_WALK_CSR.md` §4 追加一段說明分段契約與其 CSR-only 限制，並附前端遷移說明（新增選用欄位、如何 slice polyline 上色、點設施要畫 marker）。不得宣稱非 CSR 引擎也有此資料。

## 8. 明確不做

- 不替 OTP fallback 或轉乘 WALK leg 合成分段（OTP step 只有 `stairs` 布林，精度不足，會誤導）
- 不做三級品質色階（後端不做價值判斷）
- 不動 `summarizeAccessibility()` 既有聚合語意
- 不觸碰 todo #8（轉乘 WALK leg 改走 CSR）與 graph 重建
