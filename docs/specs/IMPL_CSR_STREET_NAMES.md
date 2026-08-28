# IMPL：CSR 步行指引補回路名

狀態：待實作。使用者已核准，並要求控制成本 —— **不得擴大範圍**。

## 1. 根因（已核實）

`build-ped-graph.py` 從未讀 OSM 的 `name` tag（全檔 0 次），所以 `ped_edge` 沒有路名，
CSR 產生的 `WalkStep` 只能 `streetName: ""` + `bogusName: true`。

資料拿得回來，**不需重建圖**：

- `ped_edge.source_ref` 為 `osm:way/<id>`，覆蓋 441,456 條邊、99,865 條相異 way
- 本機有 `./otp-data/taiwan-latest.osm.pbf`；用圖裡的 way id 去掃，**100% 命中**
- 回填後以邊數加權有 **47.1%** 的邊所屬 way 有名字
  （primary 99%／secondary 97%／tertiary 96%／residential 79%／service 51%／**footway 僅 6%**）

## 2. 新增：路名參照表 + 回填腳本

新檔 `src/scripts/backfill-osm-way-names.py`（pyosmium；本機 pyosmium 無 `__version__`，
屬新世代 API，**必須做能力偵測以相容 3.x／4.x**，比照 `build-ped-graph.py` 既有作法）。

行為：

1. 冪等建表（**刻意不走 graph lifecycle**：路名是 OSM 屬性、與 graph version 無關，
   放進以 way id 為鍵的參照表才不會動到 ACTIVE 圖的不可變性）

```sql
CREATE TABLE IF NOT EXISTS ped_osm_way_name (
  osm_way_id     BIGINT PRIMARY KEY,
  name           TEXT NOT NULL,
  source_version TEXT NOT NULL
);
```

2. 從 DB 讀出需要的 id 集合：
   `SELECT DISTINCT split_part(source_ref,'/',2)::bigint FROM ped_edge WHERE source_ref LIKE 'osm:way/%'`
3. 掃 PBF，只處理集合內的 way；名稱取用序 `name` → `name:zh` → `name:zh-Hant`；
   **無名的 way 不寫入**（不得寫空字串或佔位字串）
4. `INSERT ... ON CONFLICT (osm_way_id) DO UPDATE`，`source_version` 用 PBF 檔案 mtime 日期
5. 結束印出：id 集合大小、PBF 命中數、寫入數、覆蓋率

`package.json` 加 `"backfill:way-names"` 腳本（比照既有 python 腳本的呼叫方式）。
Python 單元測試 `backfill-osm-way-names.test.py` 只測**純函式**：名稱取用序、無名回傳 None、
標籤缺失。不測 DB。

## 3. Loader

`graph-loader.ts` 的邊查詢加 LEFT JOIN，並在 `PedGraph` 新增（沿用 `sidewalkIds` interning 慣例）：

```ts
  /** Interned index into `streetNames`, or -1 when this edge's way has no recorded name. */
  edgeStreetName: Int32Array;
  readonly streetNames: readonly string[];
```

SQL：僅當 `source_ref LIKE 'osm:way/%'` 時以 `split_part(source_ref,'/',2)::bigint`
join `ped_osm_way_name`，取 `name`。非 osm 來源（GTFS 室內邊）一律 -1。
**表不存在時不得讓 graph load 失敗** —— 用 `to_regclass('ped_osm_way_name') IS NULL` 之類的
前置檢查決定是否 join，缺表時全部視為 -1 並印一行 warning。

## 4. `csr-steps.ts`

有名字時 `streetName: <name>`、`bogusName: false`；無名時維持現行 `""` + `true`。
**不得合成佔位名稱**（不學 OTP 填 `road` / `sidewalk`）。其餘欄位與邏輯不動。

## 5. 測試

1. `graph-loader.test.ts`：有名 way 正確 intern；無名 way → -1；GTFS 來源 → -1；**缺表時不拋錯且全為 -1**
2. `csr-steps.test.ts`：有名 → `streetName` 正確且 `bogusName: false`；無名 → `""` 且 `true`
3. `backfill-osm-way-names.test.py`：名稱取用序三例 + 無名一例

## 6. 驗收

```bash
npx tsc --noEmit   # 必須 0
pnpm test          # 基線 146 files / 1702 tests passed，須淨增且零回歸
```

**不要跑回填腳本、不要連 DB、不要起服務、不要 commit** —— 規劃者自行執行回填與真實煙測。

## 7. 明確不做

- 不改 `build-ped-graph.py`、不重建圖（根治留待下次重建）
- 不合成佔位路名
- 不動 `a11ySegments`、`has_ramp`、`sidewalkRampCount`、坡度相關任何邏輯
- 不做坡度離群值過濾
