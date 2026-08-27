# IMPL：CSR 純步行逐步導航指引（`WalkLeg.steps`）

狀態：待實作（Claude 規劃，實作者依 session ledger）
使用者本輪決策：**先做導航 steps**；分段維度擴充（`steep_slope` / `narrow` / `rough_surface`）之後另案，門檻由**後端依 mode** 決定。

## 1. 問題

台北 CSR 成為純步行 primary 後，CSR 路線的 WalkLeg **沒有 `steps`**，導致：

- 前端導航畫面沒有逐步指引可渲染
- `/api/v1/a11y/route/instructions` 只能回 200 概略指引 + `WALK_STEPS_UNAVAILABLE`

現況註解把這件事寫成刻意設計（`accessible-route.service.ts:2228`「`steps` is deliberately absent」），但實際上 CSR 有完整的節點/邊路徑與幾何，**足以自行產生 steps**，只是還沒做。本案補上。

## 2. 既有可複用零件（已核實）

`src/modules/nav-instructions/nav-instructions.service.ts` 已具備下游全部處理：

- `:95 calcBearing(from, to)` — 座標為 `[lng, lat]`
- `:115 calcRelativeDirection(heading, bearing)` — 八方位中文
- `:193 isFacilityDirection()` — 目前只認 `ELEVATOR` / `ENTER_STATION` / `EXIT_STATION`
- `:202 mergeWalkSteps()` — 合併連續 `CONTINUE` / `STRAIGHT`
- `:246 splitLongWalkSteps()` — 用 polyline 切過長步
- `:336 walkStepText()` — facility 方向直接採用 `step.instruction` 原文；其餘走 `formatWalkStepInstruction()`，並在 `stairs` 為 true 時附加 `STAIRS_NOTICE`

`src/utils/transit-text.ts:234 formatWalkStepInstruction()` 接受的 `relativeDirection` 詞彙：
`DEPART` / `CONTINUE` / `STRAIGHT` / `LEFT` / `RIGHT` / `SLIGHTLY_LEFT` / `SLIGHTLY_RIGHT` / `HARD_LEFT` / `HARD_RIGHT`。
**無路名時的降級已內建**：`bogusName: true` 且 `streetName: ""` 會產生「請繼續直行，續行 80 公尺」「向右轉」等文字。

`ped_edge.attr_meta` **沒有路名鍵**（只有 edge_type / slope / width / surface / sidewalk_* / pathway_*），
所以 CSR steps 一律 `streetName: ""` + `bogusName: true`。要有路名必須在建圖時從 OSM 帶入，屬另案（且重建圖目前受阻）。

## 3. 新檔 `pedestrian-a11y/csr-steps.ts`

```ts
export function buildCsrWalkSteps(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
  spans: readonly EdgeGeometrySpan[],
  polyline: readonly LngLat[],
  indexOffset: number,
  mode: AccessibilityMode,
): WalkStep[]
```

輸入刻意與 `buildA11ySegments` 相同，**重用已建立的索引對應**（`spans` + `indexOffset`），
方位角一律由**實際幾何**（polyline 上的點）計算，不可用節點座標近似。

### 3.1 每條邊產生一個原始 step

| 欄位 | 值 |
| --- | --- |
| `location` | `polyline[startIndex + indexOffset]`，即 `[lng, lat]`（與 `calcBearing` 一致） |
| `distanceM` | `graph.edgeLengthM[attrIdx]`，非有限或負值時以該 span 的 haversine 累計替代 |
| `stairs` | `edgeType` 為 `STEPS` 或 `INDOOR_STAIRS` |
| `streetName` | `""` |
| `bogusName` | `true` |
| `area` | `false` |
| `absoluteDirection` | 該邊起始方位角轉八方位詞（用既有 `degToCompassWord`；由 nav-instructions 匯出或搬到 utils，**不得複製一份**） |
| `relativeDirection` | 見 3.2 |
| `instruction` | 只有 facility step 才給（下游會原文採用）；其餘不設 |

### 3.2 `relativeDirection` 決定順序

1. **第一條邊** → `DEPART`
2. **設施型邊**（依 `edgeType`）：
   - `OSM_ELEVATOR` / `INDOOR_ELEVATOR` → `ELEVATOR`
   - `INDOOR_ESCALATOR` → `ESCALATOR`
   - `INDOOR_MOVING_WALKWAY` → `MOVING_WALKWAY`
   - `INDOOR_FARE_GATE` / `INDOOR_EXIT_GATE` → `FARE_GATE`
   - GTFS connector 邊（`source_ref` 前綴 `gtfs_pathways:connector-edge:`）：依兩端 `NODE_FLAG.INDOOR` 判向 —— 由室外進室內為 `ENTER_STATION`，反之 `EXIT_STATION`
3. **其餘**依轉向角 `Δ`（前一條邊末段方位 → 本條邊首段方位，正規化到 ±180）：

| \|Δ\| | 值 |
| --- | --- |
| < 20° | `CONTINUE` |
| 20°–45° | `SLIGHTLY_LEFT` / `SLIGHTLY_RIGHT` |
| 45°–135° | `LEFT` / `RIGHT` |
| ≥ 135° | `HARD_LEFT` / `HARD_RIGHT` |

Δ > 0 為右轉。邊界值以「下界包含、上界排除」處理，並在測試中固定住 20 / 45 / 135 三個邊界。

### 3.3 陡坡提示（本案唯一的無障礙加值）

沿用既有 `STAIRS_NOTICE` 的模式，不新開文字管線：

- `WalkStep` 新增選用欄位 `steepSlope?: boolean`
- 門檻**由後端依 mode 定**：`wheelchair` 為 8.3%，其餘為 12%（常數放 `csr-steps.ts`，具名匯出以供測試）
- 判定用 `graph.edgeSlope[attrIdx]` 的絕對值；無量測時為 `false`（**不得**當成陡坡，也不得當成平坦而隱藏未知）
- `nav-instructions.service.ts` 的 `walkStepText()` 在 `step.steepSlope` 為 true 時附加 `SLOPE_NOTICE`，與 `STAIRS_NOTICE` 同樣做「已存在則不重複附加」的正規化

文字常數一律進 `src/constants/messages.ts`，不得散落字面值。

## 4. 串接

### 4.1 planner

- `csr-walk.types.ts`：`CsrWalkPlan` 新增 `steps: WalkStep[]`（必填；型別自 `src/types/route.ts` 匯入）
- `csr-walk-planner.ts` 的 plan push 處加
  `steps: buildCsrWalkSteps(graph, route.edgeAttrPath, geometry.spans, connectors.polyline, connectors.indexOffset, options.mode)`

### 4.2 service

`accessible-route.service.ts:2235 buildCsrWalkRoute()`：leg 物件加 `steps: plan.steps`，
並**改寫 `:2228` 的 JSDoc** —— 現有「`steps` is deliberately absent … never produces turn-by-turn instruction text」已不成立，
改為說明 steps 由選定邊的幾何與設施型別推導、且不含路名。

### 4.3 nav-instructions

- `isFacilityDirection()` 擴充為同時認 `ESCALATOR` / `MOVING_WALKWAY` / `FARE_GATE`（維持既有三個）
- `walkStepText()` 加入 3.3 的 `SLOPE_NOTICE` 處理
- `nav-instructions.schema.ts` 的端點描述刪掉「台北 CSR-primary 的純步行路線不提供 turn-by-turn steps，故會走 200 的概略指引」，改為 CSR 提供由圖推導的 steps 但不含路名

### 4.4 對外 schema

`accessible-route.schema.ts`：
- `steps` 陣列的描述刪掉「CSR 選出的純步行路線不產生 turn-by-turn steps，故該路線會省略 steps」
- `WalkStep` 物件加 `steepSlope: z.boolean().optional()`，描述寫明門檻依 mode（輪椅 8.3%、其餘 12%）且「無坡度量測時為 false，代表未觀測而非平坦」
- `relativeDirection` 若有列舉描述，補上新增的三個 facility 詞彙

## 5. 測試（必須有會變紅的斷言）

1. `csr-steps.test.ts`（新）
   - 第一步固定 `DEPART`
   - 轉向角三個邊界（20 / 45 / 135）左右各一，共 6 例以上
   - 五類設施 token 各一例；connector 邊的 `ENTER_STATION` / `EXIT_STATION` 判向兩例（依 `NODE_FLAG.INDOOR`）
   - `stairs` 對 `STEPS` 與 `INDOOR_STAIRS` 皆為 true
   - `steepSlope`：wheelchair 在 8.3% 上下各一例、normal 在 12% 上下各一例、**無坡度量測時為 false**
   - `indexOffset` 生效：offset=1 時 `location` 取到位移後的正確座標
   - 邊長非有限時以 haversine 替代（不可回 NaN 或 0）
2. `csr-walk-planner.test.ts`：端到端斷言 steps 數與 `location` 座標**確實落在 plan.polyline 上**（座標回查，不只比長度）
3. `accessible-route.service.test.ts`：CSR leg **有** steps（推翻現有「刻意省略」的敘述）；OTP fallback leg 的 steps 仍來自 OTP
4. `nav-instructions.service.test.ts`：以 CSR 形狀的 route 呼叫，**不再**出現 `WARN_WALK_STEPS_UNAVAILABLE`；陡坡步產生的 text 含 `SLOPE_NOTICE`；facility 步的 text 採用 `instruction` 原文
5. `accessible-route.schema.test.ts`：`steepSlope` 合法值通過、非布林被拒

## 6. 驗收

```bash
npx tsc --noEmit                 # 必須 0
pnpm test                        # 基線 144 files / 1661 tests passed，須淨增且零回歸
```

不要跑真實 API 或起服務（由規劃者自行煙測）。

## 7. 明確不做

- **不做路名**：圖裡沒有 name，硬湊等於編造（要做得等建圖帶入 OSM name）
- **不做 `steep_slope` / `narrow` / `rough_surface` 分段**：那是 `a11ySegments` 的另案
- 不動 OTP / Valhalla 的 steps 來源
- 不動 `summarizeAccessibility()` 與既有聚合欄位
- 不觸碰 todo #8（轉乘 WALK leg 改走 CSR）
