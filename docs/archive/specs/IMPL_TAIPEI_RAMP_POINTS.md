# IMPL：臺北市無障礙斜坡道點位整合

狀態：待實作。使用者已核准。**控制成本，不得擴大範圍。**

## 1. 為什麼要做

現行圖裡帶坡道標註的邊只有 **90 條**（OSM tag），所以 `a11ySegments` 的 `ramp` /
`curb_ramp_crossing` 幾乎不會出現。本案引入政府點位資料，讓坡道能真正定點呈現。

## 2. 資料來源（**已下載實測，非依規格推導**）

- 端點：`https://data.taipei/api/dataset/8ab0c662-b560-4310-a825-001ae7fdc524/resource/ee522d94-daa7-4118-b52a-4bf144af2744/download`
- 實測：HTTP 200、8,822,247 bytes、`Content-Type: text/plain`（**不是 application/json，不可依 content-type 判斷**）
- GeoJSON `FeatureCollection`，`crs` = `urn:ogc:def:crs:EPSG::3826`
- **34,684** features，全部 `Point`，屬性欄位組合僅一種：`OBJECTID` / `Name` / `Town_N` / `X_3826` / `Y_3826`
- `geometry.coordinates` 是 **TM2 座標**，不是經緯度

**必須處理的三個實測事實：**

1. **`Name` 有兩種值**：`無障礙斜坡道` **28,350** 筆、`汽車斜坡道` **6,334** 筆。
   後者是車輛出入口跨越人行道的斜坡，**不是**無障礙坡道，對輪椅使用者常是障礙。
   **只匯入 `無障礙斜坡道`，`汽車斜坡道` 必須排除**（這是本案最重要的一條）。
2. **19 筆 `geometry.coordinates` 與 `X_3826`/`Y_3826` 欄位不一致，最大偏差 139.7 公尺**
   （其中 13 筆落在無障礙子集）。**偏差 > 0.01 公尺者一律丟棄**，不猜哪邊正確。
3. 過濾後可用筆數 **28,337**（實測數字，實作後應相符）。

投影轉換用既有 `proj4` 依賴（本機**沒有** pyproj，故本案走 TypeScript 而非 Python）。
EPSG:3826 定義：
`+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`
（已實測：轉換後 bbox 為經度 121.462539~121.624092、緯度 24.977059~25.156639）

## 3. 吸附容差（已實測，不得改動）

坡道點到最近的人行道／步道／路口邊（`edge_type IN (1,2,3)`）距離：
p50 **2.4 m**、≤3m 15,356、≤5m 17,459、**≤8m 18,391**、≤15m 19,710。

**容差取 8 公尺**：p50 僅 2.4m，8m 之後曲線轉平（放寬到 15m 只多 5% 卻可能吸到對街）。
常數具名匯出以供測試。吸附不到的約 35% 不匯入映射表 —— 那是圖上該處沒有人行道線，
屬誠實的覆蓋缺口，**不得**放寬容差硬湊。

## 4. 新增腳本 `src/scripts/import-taipei-ramps.ts`

以 dotenvx + ts-node 執行，比照既有 `src/scripts/*` 匯入腳本慣例。參數：
`--file <path>`（優先）或 `--url <endpoint>`（預設為上述端點）。

行為（冪等）：

1. 建表（**與 graph version 無關的參照表，比照 `ped_osm_way_name`，不走 graph lifecycle**）

```sql
CREATE TABLE IF NOT EXISTS ped_ramp_point (
  objectid       BIGINT PRIMARY KEY,
  geom           geometry(Point,4326) NOT NULL,
  town           TEXT,
  source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ped_ramp_point_geom_idx ON ped_ramp_point USING GIST (geom);
```

2. 依 §2 過濾（排除 `汽車斜坡道`、丟棄座標不一致者）、轉 WGS84、`ON CONFLICT (objectid) DO UPDATE`
3. 建立**與 graph version 綁定**的映射表並重建 ACTIVE 版本的內容

```sql
CREATE TABLE IF NOT EXISTS ped_ramp_edge (
  version_id BIGINT NOT NULL,
  edge_id    BIGINT NOT NULL,
  objectid   BIGINT NOT NULL,
  PRIMARY KEY (version_id, edge_id, objectid)
);
```

對每個坡道點取 8 公尺內**最近的**一條 `edge_type IN (1,2,3)` 邊（`ORDER BY geom <-> point LIMIT 1`），
寫入 `(ACTIVE version_id, edge_id, objectid)`。寫入前先 `DELETE FROM ped_ramp_edge WHERE version_id = <active>`。
ACTIVE 版本以既有 lifecycle 查詢取得，**不得寫死 1**。

4. 印出：總 features、排除的汽車斜坡道數、丟棄的座標異常數、寫入點位數、成功吸附數與比率

## 5. Loader

`graph-loader.ts`：若 `to_regclass('ped_ramp_edge') IS NULL` 則**跳過且不得拋錯**（印一行 warning），
比照既有 `ped_osm_way_name` 的 fail-soft 作法。

存進 `PedGraph`（為降低實作風險，**用 Map 而非 CSR 陣列**）：

```ts
  /** Dense edge attribute index -> curb ramp coordinates on that edge, WGS84 [lng, lat]. */
  edgeRampPoints: ReadonlyMap<number, readonly [number, number][]>;
```

查詢時 join `ped_ramp_point` 取 geom 的 `ST_X` / `ST_Y`，並以 `ped_edge.edge_id` 對回 dense index。

## 6. Planner 與對外契約

- `csr-walk.types.ts`：`CsrWalkPlan` 新增 `a11yPoints: WalkA11yPoint[]`（必填）
- 收集方式：走過的每條邊查 `edgeRampPoints`，**依座標去重**（同一坡道可能被正反向邊各掛一次），
  依路徑順序輸出
- `src/types/route.ts`：

```ts
export interface WalkA11yPoint {
  type: "curb_ramp";
  /** WGS84 [longitude, latitude] of the recorded facility itself. */
  location: [number, number];
}
```

`WalkLeg` 新增選用 `a11yPoints?: WalkA11yPoint[]`（CSR-only；其他引擎**不得**補空陣列）

- `accessible-route.service.ts` 的 `buildCsrWalkRoute()`：leg 加 `a11yPoints: plan.a11yPoints`

**設計理由（不得改成塞進 `a11ySegments`）**：坡道是點，邊是線。把整條邊染成坡道色會謊報範圍；
回傳坡道自己的真實座標讓前端畫 marker 才誠實。`a11ySegments` 的分類邏輯**完全不動**。

## 7. Zod / OpenAPI

`WalkLegSchema` 加 `a11yPoints` 選用陣列，元素 `.strict()` 具名 `.openapi("WalkA11yPoint")`。
description 必須寫明：只有 `engine=pedestrian-a11y` 會有；座標是設施本身的位置、不是路徑上的投影點；
來源為臺北市新工處人行道無障礙斜坡道點位（已排除汽車斜坡道），以 8 公尺內最近人行道邊吸附；
欄位為空或不存在**不代表沿途沒有坡道**（約 35% 點位因該處圖上無人行道線而未吸附）。

## 8. 測試

1. 純函式單元測試（新檔）：`Name` 過濾（`汽車斜坡道` 被排除 —— **守門測試**）、
   座標不一致丟棄、TM2→WGS84 轉換對一個已知點、缺欄位不炸
2. `graph-loader.test.ts`：`edgeRampPoints` 正確對映；**缺表時不拋錯且為空 Map**
3. `csr-walk-planner.test.ts`：走過帶坡道的邊 → `a11yPoints` 有值且**同一座標只出現一次**（去重守門）
4. `accessible-route.service.test.ts`：CSR leg 有 `a11yPoints`；OTP fallback leg `not.toHaveProperty`
5. `accessible-route.schema.test.ts`：合法通過、`type` 非 `curb_ramp` 被拒

## 9. 驗收

```bash
npx tsc --noEmit   # 必須 0
pnpm test          # 基線 146 files / 1705 passed / 14 skipped，須淨增且零回歸
```

**不要執行匯入腳本、不要連 DB、不要起服務、不要 commit** —— 規劃者自行匯入與真實煙測。

## 10. 明確不做

- 不動 `a11ySegments`、`classifyEdgeFeature`、`has_ramp`、`sidewalkRampCount`、坡度任何邏輯
- 不改 `build-ped-graph.py`、不重建圖
- 不整合捷運出入口資料集（**該 dataset id 經實測回傳空陣列，未能核實**）
- 不整合國土管理署 58791 與其他固定設施物圖層（未提供端點、完全未驗證）
- 不做坡度離群值過濾
