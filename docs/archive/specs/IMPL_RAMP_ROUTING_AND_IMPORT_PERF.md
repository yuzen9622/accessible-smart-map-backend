# IMPL：坡道進入選路成本 + 匯入腳本效能修復

狀態：待實作。使用者已核准兩項。**控制成本，不得擴大範圍。**

使用者的架構指正（正確，本案據此改）：坡道不該是「規劃完再從附近抓」的事後標註，
路徑本身就該把坡道納入判斷。所以坡道要進成本模型，`a11yPoints` 標註成為選路結果的副產品。

---

# Part A：`import-taipei-ramps.ts` 吸附階段效能

## A1. 現況缺陷（實測）

現行實作逐點查詢，跑 28,337 點超過 600 秒未完成；被中止後 **DB 端查詢仍存活 1 小時 32 分**，
持有寫鎖擋住後續所有操作（`pg_stat_activity` 實證）。production 執行會掛住資料庫。

## A2. 正確做法（已實測 **1.784 秒**跑完 28,337 點）

單一集合式敘述，且**距離預篩必須在幾何空間、不得對索引欄位做 `::geography` 轉型**：

```sql
INSERT INTO ped_ramp_edge (version_id, edge_id, objectid)
SELECT $active_id, m.edge_id, r.objectid
FROM ped_ramp_point r
CROSS JOIN LATERAL (
  SELECT e.edge_id FROM ped_edge e
  WHERE e.version_id = $active_id
    AND e.edge_type IN (1,2,3)
    AND e.geom IS NOT NULL
    AND ST_DWithin(e.geom, r.geom, 0.00012)
    AND ST_Distance(e.geom::geography, r.geom::geography) <= 8
  ORDER BY e.geom <-> r.geom
  LIMIT 1
) m
ON CONFLICT DO NOTHING;
```

**關鍵**：`ST_DWithin(e.geom::geography, ...)` 會讓 `ped_edge_geom_gix` 失效（實測 10 分鐘以上 vs 1.784 秒）。
預篩用度數常數 `0.00012`，需具名匯出並在 JSDoc 說明推導：緯度 0.00012° ≈ 13.3 m、
北緯 25° 經度 0.00012° ≈ 12.1 m，兩者皆 > 8 m 容差，故不會漏抓；精確距離仍由 geography 判定。

其他要求：

- 執行前 `SET statement_timeout`（例如 `'300s'`）——本案已被無上限的查詢咬過一次
- 維持既有 `DELETE FROM ped_ramp_edge WHERE version_id = <active>` 再重建的語意
- ACTIVE 版本仍由 lifecycle 查詢取得，不得寫死
- 印出：吸附成功點數與比率（現況實測應為 **18,391 / 28,337**）

## A3. 測試

DB-gated 整合測試（比照 `graph-loader.integration.test.ts` 的 skip 慣例）：
以少量合成點驗證映射筆數正確、且**同一點只映射到一條邊**。
不要求效能斷言，但查詢必須是單一敘述而非逐點迴圈（以程式碼結構為準）。

---

# Part B：緣石坡道進入 wheelchair 成本

## B1. 現況（已核實）

`cost.ts:271` 的 `EDGE_FLAG.HAS_RAMP` **只**用於 `stepsPenalty`，語意是「樓梯旁有 OSM ramp 標籤所以可通行」。
成本模型中**完全沒有**路口緣石坡道的邏輯 —— 輪椅路線過馬路時不判斷下不下得去。

## B2. 必須用新旗標，不得複用 `HAS_RAMP`

新增 `EDGE_FLAG.HAS_KERB_RAMP = 4`。

**理由（安全性，不可妥協）**：若把政府坡道點寫進 `HAS_RAMP`，`stepsPenalty` 會把
「8 公尺內剛好有一個緣石坡道」誤判成「這段樓梯輪椅可通行」。緣石坡道不會讓樓梯變成無障礙。
這是會害到真實使用者的靜默錯誤。

Loader 由既有 `ped_ramp_edge` 資料同時導出此旗標（與 `edgeRampPoints` 同一來源，不另外查詢）。
`ped_ramp_edge` 不存在時旗標全為 0，且**不得拋錯**（沿用既有 fail-soft）。

## B3. 成本語意（校準自實測覆蓋率）

實測有坡道觀測的比例：SIDEWALK 7,490/33,986（22.0%）、FOOTWAY 1,389/69,196（2.0%）、
**CROSSING 5,694/42,714（13.3%）**。

因此：

- 僅在 wheelchair profile 生效
- `EDGE_TYPE.CROSSING` 且**沒有** `HAS_KERB_RAMP` → 施加**有限**懲罰倍率（具名常數）
- 有 `HAS_KERB_RAMP` → 不加懲罰（即優先走有坡道的路口）
- **絕不可**回傳 `INFEASIBLE`：只有 13.3% 的路口有觀測，硬禁會砍掉 87% 路口導致規劃崩潰。
  缺資料代表「未觀測」，不代表現場沒有坡道
- 非 wheelchair profile 完全不受影響
- 不動 `stepsPenalty`、`escalatorPenalty` 既有語意

## B4. 測試（含兩個守門測試）

1. wheelchair：無坡道 crossing 有懲罰、有坡道 crossing 無懲罰
2. **守門一**：無坡道 crossing **永不** `INFEASIBLE`（任何 relaxationLevel）
3. **守門二**：`HAS_KERB_RAMP` **不得**讓 `STEPS` 邊變可通行 —— 只帶 `HAS_KERB_RAMP`（不帶 `HAS_RAMP`）的
   STEPS 邊在 wheelchair 未放寬時仍須 `INFEASIBLE`
4. normal profile 不受 `HAS_KERB_RAMP` 影響
5. `graph-loader.test.ts`：旗標由 `ped_ramp_edge` 正確導出；缺表時為 0 且不拋錯

---

## 驗收

```bash
npx tsc --noEmit   # 必須 0
pnpm test          # 基線 148 files / 1726 passed / 14 skipped，須淨增且零回歸
```

**不要執行匯入、不要起服務、不要 commit。** 規劃者自行重跑匯入與真實煙測
（將比對懲罰生效後路線的 `a11yPoints` 數量是否上升）。

## 明確不做

- 不動 `a11ySegments` / `classifyEdgeFeature` / `sidewalkRampCount` / 坡度任何邏輯
- 不做節點層級坡道歸屬（`ped_node.geom` **沒有**空間索引，需先補索引，屬另案）
- 不改 `build-ped-graph.py`、不重建圖
- 不整合未核實的其他資料集
