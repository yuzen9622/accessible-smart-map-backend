# IMPL：CSR 步行 leg 的人行道坡道數（`sidewalkRampCount`）

狀態：待實作（Claude 規劃，實作者依 session ledger）
使用者本輪決策：**A + B**。
A = 維持現有以 OSM 標籤為準的 `ramp` / `curb_ramp_crossing` 分段（**不改**）。
B = 把政府人行道的坡道數以 **leg 層級數字**呈現，**不進 polyline 配色**。
同時決定：**坡度不進配色**（不做 `steep_slope` 分段）。

## 1. 為什麼不能直接打開 `has_ramp`

`build-ped-graph.py:759` 的 `has_ramp` 只採 OSM 的 `ramp` / `ramp:wheelchair` 標籤，全圖僅 **90 條**邊為 true。
政府人行道資料的 `SW_RAMP`（`:665`）雖然存進了 `attr_meta.sidewalk_ramp_count`（`:828`），卻從未餵給 `has_ramp`。

但**不可**用它打開 `has_ramp`：該值掛在人行道**面**（polygon）上，沒有單一坡道的點位，
且會讓 153,818 條邊（全圖 34%）被標成坡道 —— 地圖上三分之一是坡道色等於沒有資訊，
還會讓使用者誤以為隨處都能下人行道。**`EDGE_FLAG.HAS_RAMP` 與 `a11ySegments` 的分類邏輯一律不動。**

## 2. 已核實的資料事實

- 去重鍵：`attr_meta->'gov_sidewalk_source_id'->>'value'`，值形如 `"sidewalk:5563"`
- 坡道數：`attr_meta->'sidewalk_ramp_count'->>'value'`，浮點數，最大 **18**
- 相異人行道段：**15,780**；帶坡道數的邊：158,498（其中 > 0 者 153,818）
- **同一段人行道的坡道數會被複製到它衍生的每一條邊**（例：`sidewalk:3955` → 202 條邊全是 `6.0`）。
  直接加總會得到 1,212 這種假數字 —— **必須依 sidewalk id 去重後才相加**。
- 比對品質：全部 ≤ 10 m（builder 已設上限），5 m 內 120,702、2 m 內 74,138。屬鄰近比對，非重疊比對。

## 3. Graph loader 擴充

`pedestrian-a11y/graph-loader.ts` 的載入查詢加兩個運算式，並在 `PedGraph`（`graph.types.ts`）新增兩個緊湊陣列，
**沿用既有 `nodeStationId: Int32Array` + `stationIds: readonly string[]` 的 interning 慣例**：

```ts
  /** Interned index into `sidewalkIds`, or -1 when this edge matched no government sidewalk. */
  edgeSidewalkId: Int32Array;
  readonly sidewalkIds: readonly string[];
  /** Ramps recorded on the matched sidewalk segment, 0 when absent or unmatched. */
  edgeSidewalkRampCount: Uint16Array;
```

SQL 取值：
`attr_meta->'gov_sidewalk_source_id'->>'value'` 與 `(attr_meta->'sidewalk_ramp_count'->>'value')`。
非有限、負值或缺值一律視為「無比對」（id = -1、count = 0）；坡道數取 `Math.round` 後夾在 `0..65535`。

不得把整個 `attr_meta` JSON 載進記憶體。

## 4. 計數函式

新增於 `pedestrian-a11y/a11y-segments.ts` 旁的既有檔或新檔（實作者擇一，但**必須有獨立單元測試**）：

```ts
/**
 * Total ramps recorded on the distinct government sidewalk segments this path travels along.
 *
 * The source count is a per-sidewalk-polygon attribute copied onto every edge derived from
 * that polygon, so each sidewalk segment contributes its count exactly once no matter how
 * many of its edges the path traverses.
 *
 * @param graph CSR pedestrian graph.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @returns The de-duplicated ramp total; 0 when no traversed edge matched a sidewalk.
 */
export function sumSidewalkRampCount(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
): number
```

行為：以 `Set<number>` 收集已計入的 `edgeSidewalkId`（跳過 `-1`），每個 id 只加一次其 `edgeSidewalkRampCount`。

## 5. 串接

- `csr-walk.types.ts`：`CsrWalkPlan` 新增 `sidewalkRampCount: number`（必填）
- `csr-walk-planner.ts`：plan push 處加 `sidewalkRampCount: sumSidewalkRampCount(graph, route.edgeAttrPath)`
- `src/types/route.ts`：`WalkLeg` 新增**選用**欄位

```ts
  /**
   * Ramps recorded on the government sidewalk segments this CSR leg travels along.
   *
   * This is a sidewalk-segment attribute, not a located feature: it says how many kerb
   * ramps the traversed sidewalks carry, never where they are. Absent on OTP / Valhalla
   * legs, which have no government sidewalk match.
   */
  sidewalkRampCount?: number;
```

- `accessible-route.service.ts:2235 buildCsrWalkRoute()`：leg 加 `sidewalkRampCount: plan.sidewalkRampCount`
  （其他引擎的 WALK leg **不得**補 0 —— 省略才代表未比對）

## 6. Zod / OpenAPI

`accessible-route.schema.ts` 的 `WalkLegSchema`，在 `a11ySegments` 之後加：

```ts
    sidewalkRampCount: z.number().int().nonnegative().optional().openapi({
      example: 12,
      description: "…",
    }),
```

description 必須寫明四件事：
1. 只有 `engine=pedestrian-a11y` 會有此欄位
2. 這是**路線沿線經過的政府人行道段**上登錄的緣石坡道總數，**不是本路徑上的定點坡道**，且不代表坡道位於使用者會走到的位置
3. 同一段人行道只計一次（來源值為人行道面屬性，會複製到該面衍生的每條邊）
4. 來源為政府人行道圖資，以鄰近比對（≤ 10 公尺）掛上；`0` 代表沿線人行道未登錄坡道，而非確定沒有坡道

## 7. 測試（必須有會變紅的斷言）

1. `sumSidewalkRampCount` 單元測試
   - **去重**：同一 sidewalk id 的三條邊 → 只計一次（**這條是本案的守門測試，必須存在**）
   - 兩個不同 id → 相加
   - `-1`（未比對）邊被跳過
   - 空路徑 → 0
   - 同一 id 交錯出現（A、B、A）仍只各計一次
2. `graph-loader.test.ts`：attr_meta 缺鍵 / 值非數字 / 負值 → id = -1 且 count = 0；正常值正確 interning
3. `csr-walk-planner.test.ts`：plan 帶正確的 `sidewalkRampCount`
4. `accessible-route.service.test.ts`：CSR leg 有此欄位；OTP fallback leg `not.toHaveProperty("sidewalkRampCount")`
5. `accessible-route.schema.test.ts`：非整數 / 負值被拒

## 8. 驗收

```bash
npx tsc --noEmit    # 必須 0
pnpm test           # 基線 145 files / 1689 tests passed，須淨增且零回歸
```

不要跑真實 API 或起服務、不要 commit（由規劃者自行煙測驗收）。

## 9. 明確不做

- **不動** `has_ramp`、`EDGE_FLAG.HAS_RAMP`、`classifyEdgeFeature` 與 `a11ySegments` 的任何分類（決策 A 維持現狀）
- **不做** `steep_slope` / `narrow` / `rough_surface` 分段（坡度已被使用者排除；寬度與鋪面未列入本輪）
- 不做坡度離群值過濾（另案，使用者尚未拍板）
- 不改建圖腳本、不重建圖
- 不觸碰 todo #8（轉乘 WALK leg 改走 CSR）
