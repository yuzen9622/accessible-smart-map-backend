# IMPL：節點層級緣石坡道 + 修正 `crossingsWithCurbRamp`

狀態：待實作。使用者核准「1、2 一起修」。**控制成本，不得擴大範圍。**

---

## 0. 為什麼改成節點層級（實測，決定性）

坡道在物理上位於**路口轉角**（人行道與車道交界），而 OSM 的 crossing way 端點就是兩側路緣。
所以坡道的正確歸屬是節點，不是邊。實測對比（容差 8 m）：

| 路口（42,714 條 CROSSING 邊） | 邊層級（現況） | **節點層級** |
| --- | --- | --- |
| 至少一端有坡道 | 5,694（13.3%） | **26,980（63.2%）** |
| **兩端都有坡道** | 無此概念 | **15,252（35.7%）** |

坡道點到最近節點：p50 **5.8 m**、≤8 m 17,495（62%）、≤12 m 22,502（79%）。帶坡道節點 **22,754** 個。

「**兩端都有**」才是輪椅能過馬路的真實條件（一側下得去、另一側上得來），且 35.7% 已是可用訊號。

---

## Part 1：`crossingsWithCurbRamp` 目前在對前端說謊

`csr-walk-planner.ts:352` 的 `summarizeAccessibility()` 只讀 `EDGE_FLAG.HAS_RAMP`（全圖僅 90 條），
所以即使選路引擎已知該路口有政府坡道資料，回給前端的統計仍是 `0`。實測已確認此不一致。

修正：

- `summarizeAccessibility()` 需要端點資訊，故簽名加 `nodePath: Int32Array`（呼叫端 `route.nodePath` 已有）
- 一條 CROSSING 邊計為「有坡道」的條件：
  `EDGE_FLAG.HAS_RAMP` **或** 兩端節點皆帶 `NODE_FLAG.HAS_KERB_RAMP`
- 採「兩端」而非「任一端」：單側有坡道的路口輪椅仍可能過不去，計入會高報可用性
- schema description 必須說明兩個來源（OSM ramp 標籤／臺北市新工處坡道點位）與「兩端皆有」的判準，
  且 `0` 代表**未觀測**而非現場沒有坡道

---

## Part 2：節點層級坡道歸屬

### 2.1 空間索引（前置條件）

`ped_node` 只有 `proxy_geom` 的 GIST 索引、**`geom` 沒有** —— 節點層級查詢會掃全表（實測超時）。
匯入腳本執行前須確保（規劃者已在 dev 手動建立，建表 0.845 秒）：

```sql
CREATE INDEX IF NOT EXISTS ped_node_geom_gix ON ped_node USING GIST (geom);
```

### 2.2 新映射表

```sql
CREATE TABLE IF NOT EXISTS ped_ramp_node (
  version_id BIGINT NOT NULL,
  node_id    BIGINT NOT NULL,
  objectid   BIGINT NOT NULL,
  PRIMARY KEY (version_id, node_id, objectid)
);
```

由 `import-taipei-ramps.ts` 於重建 `ped_ramp_edge` 之後一併重建（同樣先 `DELETE ... WHERE version_id = <active>`）。
**必須沿用 Part A 已驗證的效能寫法**：`ST_DWithin(n.geom, r.geom, <degrees>)` 做可用索引的預篩，
再以 `ST_Distance(n.geom::geography, r.geom::geography) <= 8` 判定精確距離。
**不得**對索引欄位做 `::geography` 轉型（會使索引失效，實測 10 分鐘以上 vs 秒級）。
預篩度數用 `0.00014`（緯度 ≈ 15.5 m、北緯 25° 經度 ≈ 14.1 m，皆 > 8 m 故不漏抓），具名匯出並註明推導。

與邊層級不同：這是多對多映射，不取最近 1 個——一個坡道點要對應「8m 容差內的每一個節點」，一個節點也可對應多個坡道點。
坡道實際就在那個轉角，8m 容差內的圖節點都算同一側路緣；只取最近一個會把大量本該算數的另一端節點漏掉。

實測（nearest-only vs all-within-8m，同一批 28,337 點）：

| 映射方式 | 帶坡道節點數 | 兩端都有坡道的路口 |
| --- | --- | --- |
| 只取最近 1 個節點 | 14,317 | 1,856（4.3%） |
| 8m 容差內全取 | **22,754** | **15,252（35.7%）** |

只取最近一個會讓「兩端都有坡道」（無障礙成本 tier 與 `crossingsWithCurbRamp` 都要求兩端）掉到 4.3%，形同失效；容差內全取才是正確語意，也是本節第 14–17 行 63.2%／35.7% 數字的真實來源。
印出帶坡道節點數（實測應為 **22,754**），不再用「佔坡道點數的百分比」——映射已是多對多，那個框架不再適用。

### 2.3 新節點旗標

`graph.types.ts` 的 `NODE_FLAG` 現有 `INDOOR: 1`、`ENTRANCE: 2`、`HAS_REAL_GEOM: 4`，
新增 `HAS_KERB_RAMP: 8`。Loader 由 `ped_ramp_node` 導出；表不存在時全為 0 且**不得拋錯**（沿用既有 fail-soft）。

### 2.4 成本函式改為分級

`edgeCost(graph, attrIdx, profile)` 目前拿不到端點，但呼叫端（`astar.ts:313`、dijkstra 對應處）
在迴圈中已知起點與 `adjTarget`。**擴充簽名以傳入兩端節點**，同步更新所有呼叫端與測試。

`kerbRampPenalty` 僅對 `EDGE_TYPE.CROSSING`、僅 wheelchair profile 生效，改為三級（皆為**有限**倍率）：

| 端點坡道狀態 | 倍率 |
| --- | --- |
| 兩端都有 | 無懲罰（`MINIMUM_PENALTY_MULTIPLIER`） |
| 僅一端有 | 中等（具名常數，介於下列兩者之間） |
| 兩端都沒有 | 現行 `WHEELCHAIR_UNRAMPED_CROSSING_PENALTY_MULTIPLIER` |

**絕不可** `INFEASIBLE`：36.8% 的路口兩端皆無觀測，硬禁會使規劃崩潰；缺資料代表未觀測。
邊層級的 `EDGE_FLAG.HAS_KERB_RAMP` 若已無用可移除，但**不得**改動 `EDGE_FLAG.HAS_RAMP` 與 `stepsPenalty`。

A* 啟發式仍須可採納（penalty 只增加成本，`h` 不得使用這些 penalty）；既有 admissibility invariant 測試需納入新倍率。

---

## 測試（三個守門測試）

1. **守門一**：兩端皆無坡道的 crossing **永不** `INFEASIBLE`（所有 relaxationLevel）
2. **守門二**：`NODE_FLAG.HAS_KERB_RAMP` **不得**讓 `STEPS` 邊變可通行（只帶節點坡道、不帶 `EDGE_FLAG.HAS_RAMP` 時仍 `INFEASIBLE`）
3. **守門三**：`crossingsWithCurbRamp` 對「僅一端有坡道」的路口**不得**計入（防高報可用性）
4. 成本排序：兩端 < 一端 < 無端（嚴格遞增）
5. normal profile 完全不受節點坡道影響
6. `graph-loader.test.ts`：旗標由 `ped_ramp_node` 正確導出；缺表時為 0 且不拋錯
7. `summarizeAccessibility`：`HAS_RAMP` 來源仍計入（兩來源並存）

## 驗收

```bash
npx tsc --noEmit   # 必須 0
pnpm test          # 基線 149 files / 1736 passed / 16 skipped，須淨增且零回歸
```

**不要執行匯入、不要起服務、不要 commit。** 規劃者自行重跑匯入與真實煙測
（將比對 `crossingsWithCurbRamp` 是否從 0 變為正值、以及 wheelchair 路線是否改走兩端有坡道的路口）。

## 明確不做

- 不動 `a11ySegments` / `classifyEdgeFeature` / `sidewalkRampCount` / 坡度任何邏輯
- 不動 `a11yPoints` 的邊層級來源（標註維持現狀）
- 不改 `build-ped-graph.py`、不重建圖
- 不做坡度離群值過濾
