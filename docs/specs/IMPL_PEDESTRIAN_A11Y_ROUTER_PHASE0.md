# 行人無障礙引擎 — Phase 0 實作規格

## Implementation Spec — Pedestrian Accessibility Routing Engine, Phase 0

**版本**：v1.4.0
**狀態**：**Phase 0 完成（WP-1～WP-7 全部實作並實測）**。驗收報告 `docs/reports/PED_ROUTER_PHASE0.md`
**日期**：2026-08-25
**上位文件**：`docs/specs/FUNCTIONAL_SPEC_PEDESTRIAN_A11Y_ROUTER.md` v0.5.0
**範圍**：**僅 Phase 0（高風險前置驗證）。台北市。**

> **為何只寫 Phase 0**：上位規格 §12 明定 Phase 0 是 go／no-go 閘門，未通過即收手。在取得 0-1～0-5 的實測數字之前撰寫後續 Phase 的實作細節，等於預設閘門會過——與規格自身的風險立場矛盾。Phase 1 以後的實作規格待 Phase 0 報告產出後另立。

---

## 0. 本文件的使用方式

每個工作包（WP）都是**可獨立派工**的單位，載明：產出檔案、對外契約、驗收條件、不得碰觸的範圍。派工者依 §1 的相依順序執行。

**跨 WP 的硬性約束（所有 WP 共同遵守）**：

1. 套件管理器是 **pnpm**。不得產生 `package-lock.json`。
2. 註解慣例：**只在函式上寫 JSDoc**（`@param` / `@returns`）。不寫行內註解、型別註解、區段註解，不提 Phase／Step。
3. 測試與程式碼同目錄，命名 `*.test.ts`，以 vitest 執行。
4. `pnpm run lint:arch`（`src/scripts/check-architecture.mjs`）與 `pnpm typecheck` 必須乾淨。
5. **不得修改** `src/modules/accessible-route/accessible-route.service.ts`、`scoring.ts`、`otp-routing.ts` 或任何現有路由行為。Phase 0 是離線驗證，**不接線到 API**。
6. 新增相依必須寫進 `package.json` 並更新 `pnpm-lock.yaml`。
7. Python 腳本須相容 pyosmium 3.x 與 4.x（建圖機與本機世代不同），以能力偵測處理差異。

### 0.1 前置條件（派工前須確認）

| 輸入                      | 本機狀態（2026-08-19 實查）                                   | 影響                     |
| ------------------------- | ------------------------------------------------------------- | ------------------------ |
| Taiwan OSM PBF            | ✅ `otp-data/taiwan-latest.osm.pbf`（310 MB，2026-07-20）     | 無                       |
| pyosmium / rasterio       | ✅ 已安裝                                                     | 版本世代須以能力偵測處理 |
| MongoDB（`gtfspathways`） | ✅ `mongo` 容器可用                                           | WP-5 所需                |
| **DEM 高程瓦片**          | ✅ **WP-7 已產出**已驗證的 EPSG:4326 GeoTIFF                  | 能力邊界見上位規格 §3.6b |
| **政府人行道資料**        | ✅ **WP-7 已驗證可用**（18,304 筆 MultiPolygon、填答率 100%） | 見 §3.4b                 |

**DEM 缺席的後果必須正視**：`slope_longitudinal` 是本引擎補償 OSM `incline` 僅 1.5% 覆蓋率（上位規格 §3.1）的唯一手段。本機無 DEM 時：

- WP-2 的 §3.5 依既有 fail-soft 慣例不會失敗，但**全部邊的 `slope_longitudinal` 皆為 `NULL`**。
- Phase 0 報告的坡度覆蓋率會是 **0%**，驗收項 0-1 的屬性覆蓋率因而無法反映真實設計。
- 上位規格 §11.5 的「坡度 OD 子集」在此狀態下**無法建立**。

**處置**：DEM 取得列為 Phase 0 的獨立前置任務（台灣 20 m DEM 或 SRTM），或在具備 DEM 的建圖機上執行 WP-2。在 DEM 到位前，WP-2 仍可完成並驗收其餘項目，但**報告必須明確標示坡度覆蓋率為 0% 且該項未驗證**，不得以「fail-soft 通過」帶過。

---

## 1. 工作包與相依順序

```
WP-1 (PostGIS + DDL)
   │
   ├──▶ WP-2 (建圖 pipeline, Python)  ──▶ WP-5 (室內圖與出入口對位)
   │                                            │
   └──▶ WP-3 (CSR loader + 空間索引) ──▶ WP-4 (A* 與 cost) ──▶ WP-6 (量測與驗收)
```

| WP       | 主題                                        | 語言       | 可與誰並行                                                                               |
| -------- | ------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| ~~WP-1~~ | ~~PostGIS 服務與 schema~~                   | SQL / YAML | ✅ **已完成 2026-08-19**                                                                 |
| ~~WP-2~~ | ~~PBF → PostGIS 建圖~~                      | Python     | ✅ **已完成 2026-08-22**（161,368／441,456，連通性 96/100）                              |
| ~~WP-3~~ | ~~PostGIS → CSR 記憶體圖 + 空間索引~~       | TypeScript | ✅ **已完成 2026-08-24**（18.13 MB，吸附 0/100 失敗）                                    |
| ~~WP-4~~ | ~~cost function + A\* + Dijkstra 參考實作~~ | TypeScript | ✅ **已完成 2026-08-24**（A\* vs Dijkstra 50/50 相符，相對誤差 ≤ 1e-9）                  |
| ~~WP-5~~ | ~~GTFS 室內子圖與 654 出入口對位~~          | Python     | ✅ **已完成 2026-08-25**（台北 375/375 對位，`R_station` p95 138.8 m，§9 成立）          |
| ~~WP-6~~ | ~~Phase 0 量測與驗收報告~~                  | TypeScript | ✅ **已完成 2026-08-25**，報告 `docs/reports/PED_ROUTER_PHASE0.md`（Phase 0 判定：通過） |
| ~~WP-7~~ | ~~政府開放圖資與 DEM 評估（驗收項 0-6）~~   | —          | ✅ **已完成 2026-08-19**，報告 `docs/reports/PED_ROUTER_DATA_SOURCES.md`                 |

---

## 2. WP-1 — PostGIS 服務與 schema

### 2.1 產出

| 檔案                               | 內容                          |
| ---------------------------------- | ----------------------------- |
| `docker-compose.yml`（修改）       | 新增 `postgis` service        |
| `src/scripts/ped-graph-schema.sql` | 完整 DDL                      |
| `.env.example`（修改）             | 新增 `PED_GRAPH_DATABASE_URL` |

### 2.2 compose service

```yaml
postgis:
  image: postgis/postgis:16-3.4
  container_name: postgis
  environment:
    POSTGRES_USER: ${PED_PG_USER}
    POSTGRES_PASSWORD: ${PED_PG_PASSWORD}
    POSTGRES_DB: ped_graph
  volumes:
    - postgis-data:/var/lib/postgresql/data
  ports:
    - "127.0.0.1:5433:5432"
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${PED_PG_USER} -d ped_graph"]
    interval: 10s
    timeout: 5s
    retries: 5
  restart: unless-stopped
```

發布埠比照既有慣例前綴 `127.0.0.1:`（僅主機可達）。用 `5433` 避免與主機既有 Postgres 衝突。

### 2.3 DDL

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE ped_graph_version (
  id                  BIGSERIAL PRIMARY KEY,
  source_hash         TEXT        NOT NULL,
  built_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  bbox                GEOMETRY(Polygon, 4326),
  node_count          INTEGER     NOT NULL,
  directed_edge_count INTEGER     NOT NULL,
  notes               TEXT
);

CREATE TABLE ped_node (
  node_id        BIGINT  PRIMARY KEY,
  version_id     BIGINT  NOT NULL REFERENCES ped_graph_version(id) ON DELETE CASCADE,
  geom           GEOMETRY(Point, 4326),
  proxy_geom     GEOMETRY(Point, 4326) NOT NULL,
  station_id     TEXT,
  station_radius_m REAL,
  node_type      SMALLINT NOT NULL,
  kerb           SMALLINT,
  tactile_paving BOOLEAN,
  traffic_signal BOOLEAN,
  audible_signal BOOLEAN,
  source_ref     TEXT,
  attr_meta      JSONB
);

CREATE TABLE ped_edge (
  edge_id            BIGINT  PRIMARY KEY,
  version_id         BIGINT  NOT NULL REFERENCES ped_graph_version(id) ON DELETE CASCADE,
  from_node          BIGINT  NOT NULL,
  to_node            BIGINT  NOT NULL,
  geom               GEOMETRY(LineString, 4326),
  length_m           REAL,
  edge_type          SMALLINT NOT NULL,
  slope_longitudinal REAL,
  slope_cross        REAL,
  surface            SMALLINT,
  smoothness         SMALLINT,
  width_m            REAL,
  effective_width_m  REAL,
  wheelchair         SMALLINT,
  stair_count        SMALLINT,
  traversal_time_s   REAL,
  has_ramp           BOOLEAN NOT NULL DEFAULT FALSE,
  is_bidirectional   BOOLEAN NOT NULL DEFAULT TRUE,
  source_ref         TEXT,
  attr_meta          JSONB
);

CREATE INDEX ped_edge_geom_gix   ON ped_edge USING GIST (geom);
CREATE INDEX ped_edge_from_idx   ON ped_edge (version_id, from_node);
CREATE INDEX ped_edge_to_idx     ON ped_edge (version_id, to_node);
CREATE INDEX ped_node_proxy_gix  ON ped_node USING GIST (proxy_geom);
CREATE INDEX ped_node_station_idx ON ped_node (version_id, station_id);
```

**欄位語意（實作者必讀）**

| 欄位                  | 語意                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `geom`                | 真實幾何。**室內通用節點與室內邊為 `NULL`**（上位規格 §3.4：上游 GTFS 不提供座標）                  |
| `proxy_geom`          | **恆非 NULL**。戶外節點等於 `geom`；室內節點為所屬車站出入口質心（上位規格 §9.1b）                  |
| `station_radius_m`    | 該站出入口相對質心的最大距離，供 `h = max(0, dist(proxy, goal) − R)` 使用。非室內節點為 `NULL`      |
| `length_m`            | 室內邊為 `NULL`（改用 `traversal_time_s` 計價）                                                     |
| `attr_meta`           | 每個屬性的 `{value, source, confidence, updated_at}`（上位規格 §6.1）。**不得把來源資訊塞進主欄位** |
| `width_m` / `slope_*` | 未知一律 `NULL`，**不得以 0 表示未知**（上位規格 §7.4：未知不等於最差）                             |

**列舉字典**（`edge_type` / `node_type` / `surface` / `smoothness` / `wheelchair` / `kerb`）以整數存放，字典表定義於 WP-3 的 `graph.types.ts`，**兩邊必須是同一份定義的兩種語言表述**。SQL 側以 `COMMENT ON COLUMN` 記錄對照，避免漂移。

### 2.4 驗收

- `docker compose up -d postgis` 起得來、healthcheck 綠。
- 套用 DDL 後所有索引存在。
- `.env.example` 有新變數且註明用途。
- **不得**動到既有 service 的任何設定。

---

## 3. WP-2 — 建圖 pipeline（Python / pyosmium）

### 3.1 產出

| 檔案                                  | 內容                                      |
| ------------------------------------- | ----------------------------------------- |
| `src/scripts/build-ped-graph.py`      | PBF → PostGIS                             |
| `src/scripts/build-ped-graph.test.py` | 純函數單元測試（納入 `pnpm test:python`） |
| `package.json`（修改）                | 新增 `build:ped-graph` script             |

### 3.2 納入哪些 way（**最關鍵的規則，寫錯整張圖就廢了**）

台北僅 **7.2%** 的主要道路帶 `sidewalk` tag（上位規格 §3.1）。若只取 `highway=footway`，圖會嚴重斷裂、無法路由。**行人圖必須包含可徒步的一般道路。**

```
納入：highway ∈ {
  footway, path, pedestrian, steps, living_street, track, road,
  residential, service, unclassified,
  tertiary, tertiary_link, secondary, secondary_link, primary, primary_link
}

排除（依序判定）：
  1. highway ∈ {motorway, motorway_link}                       → 一律排除
  2. foot ∈ {no, private} 或 access ∈ {no, private}            → 排除
  3. highway ∈ {trunk, trunk_link} 且 無明確 foot tag
     且 (sidewalk=no 或 bridge=yes)                            → 排除
```

**規則 3 必須與 `src/scripts/deny-foot-on-expressways.py` 完全一致**——兩者若分歧，本引擎與 OTP 的比較就不是同一個可行集，評估失去意義。實作時直接引用該檔的判定函式，不要複製貼上。

**只看標籤，不看路名。** 依既有教訓，路由邏輯內禁止以名稱比對判定道路性質。

### 3.3 切段與有向邊

1. 統計每個 OSM node 被幾條「納入的 way」引用。
2. 一條 way 在**引用數 ≥ 2 的 node**（路口）與**自身端點**處切開，每一段成為一條無向邊。
3. 每條無向邊產生**兩條有向邊**。行人不受 `oneway` 限制；僅當 `oneway:foot=yes` 時才單向，此時 `is_bidirectional=false`。
4. `length_m` 以 haversine 沿該段的完整幾何逐點累加，**不是端點直線距離**。
5. `highway=steps` 保持雙向（輪椅的限制是 INF 成本，不是方向）。

### 3.4 屬性萃取

| 目標欄位                 | 來源                                                                                                   | 未知時                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `edge_type`              | `highway` 與 `footway` 子類                                                                            | 必填，無法判定則歸 `path`     |
| `surface` / `smoothness` | 同名 tag，字典化                                                                                       | `NULL`                        |
| `width_m`                | **政府人行道 `SW_WTH`（主要，填答率 100%）**；OSM `width` 為次要                                       | `NULL`                        |
| `effective_width_m`      | **政府人行道 `SWW_WTH` 直接取用**（v1.2.0 起，不再是「Phase 0 不推導」）                               | `NULL`                        |
| `wheelchair`             | 同名 tag                                                                                               | `NULL`（**不得推論為 `no`**） |
| `has_ramp`               | `ramp` 或 `ramp:wheelchair` ∈ {yes, designated}                                                        | `false`                       |
| `slope_longitudinal`     | 見 §3.5                                                                                                | `NULL`                        |
| `attr_meta`              | 每項填 `{value, source, confidence, updated_at}`；`source` 需區分 `"osm"` / `"gov_sidewalk"` / `"dem"` | 來源缺漏則不建立該鍵          |

### 3.4b 政府人行道資料的貼附（v1.2.0 新增）

來源：`docs/reports/PED_ROUTER_DATA_SOURCES.md` 已驗證可用。台北市 18,304 筆 **MultiPolygon**（WGS84 / CRS84），`SW_WTH`／`SWW_WTH`／`SW_RAMP` 填答率皆 100%。

**貼附方式必須是 polygon-to-edge overlay，不得用文字對位。**

| 實測事實                                          | 對實作的約束                     |
| ------------------------------------------------- | -------------------------------- |
| 10 m 內有可納入 OSM way：**100%**（中位 1.324 m） | 幾何貼附可行，容差 10 m 起       |
| 同名 way 恰 1 條：**僅 41%**                      | **不得假設一筆資料對一條 way**   |
| 同名 way 2–6 條：**46%**                          | 屬性必須依幾何切分到多條邊       |
| 35 m 內無同名 way：13%                            | 名稱比對不可作為主路徑，僅作輔助 |

**規則**：

1. 以政府 `MultiPolygon` 與 OSM way 的**幾何重疊**決定歸屬，路名僅用於交叉驗證，不得作為主鍵。
2. 一個 polygon 覆蓋多條 edge 時，**每條 edge 各自取得該屬性**，並在 `attr_meta` 記錄來源 polygon 識別碼。
3. `SW_DIRECT`（1／2／3）保留，供 §8.2b 的側別判定使用。
4. `source` 一律標 `"gov_sidewalk"`，`updated_at` 取資料版本（202606），**不得與 OSM 來源混淆**。

**不做**：`SW_RAMP` 在 Phase 0 **不進成本模型**。96.4% 的路段皆有斜坡道（上位規格 §3.8），二元特徵無鑑別力；是否有可用的衍生量待 Phase 2 驗證。仍應寫入 `ped_edge` 供後續分析。

### 3.5 DEM 坡度

沿用 `src/scripts/inject-osm-dem-slopes.py` 的高程取樣邏輯（**引用，不重寫**）：對每條切段後的邊取兩端高程，`slope = Δh / length_m`，寫入 `slope_longitudinal`，`attr_meta.slope_longitudinal.source = "dem"`。

DEM 檔缺漏時該邊 `slope_longitudinal = NULL`，**腳本不得因此失敗**（比照既有 fail-soft），但須在結尾統計並印出坡度覆蓋率——該數字是 Phase 0 報告的輸入之一。

### 3.6 執行契約

```
pnpm build:ped-graph -- --pbf <path> --dem-dir <path> --bbox taipei
```

- 每次執行建立一筆 `ped_graph_version`，所有節點／邊掛在該 `version_id` 下。**不覆寫舊版本**（供比對與回滾）。
- `source_hash` 為輸入 PBF 的內容雜湊。
- 結尾印出並寫入 `notes`：節點數、有向邊數、各 `edge_type` 分布、坡度／surface／width 覆蓋率。

### 3.7 驗收

- 台北市範圍建圖成功，`ped_graph_version` 有一筆完整紀錄。
- 節點數與有向邊數印出且**可解釋**（有向邊數應約為無向邊數的 2 倍）。
- **連通性抽驗**：隨機取 100 組相距 300 m–3 km 的節點對，可達比例須報告；比例過低即代表 §3.2 納入規則有誤。
- 純函數（tag 判定、切段、haversine）有單元測試。

---

## 4. WP-3 — CSR 記憶體圖與空間索引

### 4.1 產出

```
src/modules/accessible-route/planners/pedestrian-a11y/
  graph.types.ts        列舉字典 + CSR 型別
  graph-loader.ts       PostGIS → CSR
  graph-loader.test.ts
  spatial-index.ts      邊的空間索引與吸附
  spatial-index.test.ts
```

新增相依：`pg`、`flatbush`。

### 4.2 CSR 結構（**強制。不得使用物件圖**）

上位規格 §5.8：物件圖在六都規模是數百 MB，CSR + TypedArray 是十餘 MB。

```ts
export interface PedGraph {
  versionId: number;
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;

  nodeLon: Float64Array; // proxy_geom，長度 nodeCount
  nodeLat: Float64Array;
  nodeFlags: Uint8Array; // bit0 indoor, bit1 entrance, bit2 hasRealGeom
  nodeStationId: Int32Array; // -1 表非室內
  stationRadiusM: Float32Array; // 依 nodeStationId 索引

  adjOffset: Int32Array; // 長度 nodeCount + 1
  adjTarget: Int32Array; // 長度 directedEdgeCount
  adjAttr: Int32Array; // 長度 directedEdgeCount，指向下列平行陣列

  edgeLengthM: Float32Array; // NaN = 室內邊
  edgeType: Uint8Array;
  edgeSlope: Float32Array; // NaN = 未知
  edgeSurface: Uint8Array; // 0 = 未知
  edgeSmoothness: Uint8Array;
  edgeWidthM: Float32Array; // NaN = 未知
  edgeWheelchair: Uint8Array; // 0 = 未知
  edgeStairCount: Uint16Array;
  edgeTraversalTimeS: Float32Array; // NaN = 非室內邊
  edgeFlags: Uint8Array; // bit0 hasRamp, bit1 indoor
}
```

**未知的表示法是契約的一部分**：數值欄位用 `NaN`、字典欄位用 `0`。**不得以 0 表示「坡度 0」或「寬度 0」**——那會把未知誤判為已知良好或已知最差，直接違反上位規格 §7.4。

### 4.3 loader

```ts
export async function loadPedGraph(
  pool: Pool,
  versionId?: number,
): Promise<PedGraph>;
```

- 未給 `versionId` 時取最新一筆。
- 以 cursor／分批讀取，避免一次把整張表拉進 JS 陣列再轉 TypedArray（那會在轉換期間出現峰值）。
- 節點 id 重新編號為 `0..nodeCount-1` 的稠密索引，並保留 `originalNodeId` 對照供除錯。
- 載入完成後回報實測 heap（`process.memoryUsage().heapUsed` 前後差），供 Phase 0-2 驗收。

### 4.4 空間索引與吸附

```ts
export interface SnapResult {
  nodeId: number;
  distanceM: number;
  edgeAttrIdx: number;
}
export function buildEdgeIndex(graph: PedGraph): EdgeIndex;
export function snapToGraph(
  index: EdgeIndex,
  lat: number,
  lon: number,
  toleranceM: number,
): SnapResult | null;
```

- 以 `flatbush` 建**邊的外接矩形**索引（只索引有真實幾何的邊；室內邊 `geom` 為 `NULL`，不進索引）。
- 查詢流程：先取候選外接矩形，再對候選做**點到線段的精確距離**，取最小者。只比外接矩形會在道路密集處選錯邊。
- 超出 `toleranceM` 回 `null`（呼叫端負責落回 OTP）。
- Phase 0 的 OD 吸附容差預設 **50 m**；此值列於上位規格 §15 待決項，Phase 0 需回報「多少 OD 在此容差下吸附失敗」。

### 4.5 驗收（✅ 已完成 2026-08-24）

- 由 WP-2 產出的台北圖可完整載入，回報 `nodeCount` / `directedEdgeCount` / 實測 footprint。
- 吸附正確性測試：對已知位於某條路上的座標，吸附結果必須是該條路。
- 記憶體：**實測 footprint 須列入 Phase 0 報告**，並依 4.1 倍外推六都、留 100% margin 後與預算比對。
  **不得以 `heapUsed` 作為該數字**（上位規格 §5.8）：TypedArray backing store 是 off-heap，強制 GC 後 `heapUsed` 差值僅 0.83 MB、而真實 footprint 是 18.13 MB。量法是加總所有 TypedArray 的 `byteLength`。

**實測結果**：

| 驗收項                      | 結果                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| 真圖載入                    | 161,368 節點／441,456 有向邊／220,728 無向段，三數與 `ped_graph_version` 一致 |
| TypedArray footprint        | **18.13 MB**（43.1 B／有向邊）                                                |
| 六都外推                    | 74.33 MB 常駐／148.66 MB 峰值——通過                                           |
| 50 m 容差吸附失敗           | **0 / 100**                                                                   |
| flatbush v4 ESM on CommonJS | vitest／ts-node／編譯後 CJS 三者實跑通過，未降級 v3                           |

**已知限制**：165 個 self-loop 閉環段不進空間索引（端點近似對閉環本來無意義，其節點仍可由其他相接邊到達）；WP-5 室內資料尚不存在，station／proxy／radius 路徑目前只有 fake fixture 走過。

---

## 5. WP-4 — cost function、A\*、Dijkstra 參考實作

### 5.1 產出

```
src/modules/accessible-route/planners/pedestrian-a11y/
  cost.ts          純函數，profile → edge cost
  cost.test.ts
  astar.ts         A* + binary heap，允許節點重開
  astar.test.ts
  dijkstra.ts      參考實作，供最佳性交叉驗證
  dijkstra.test.ts
```

### 5.2 cost function

```ts
export const INFEASIBLE = Number.POSITIVE_INFINITY;

export interface CostProfile {
  name: "wheelchair" | "elderly" | "visual_impaired" | "normal";
  walkSpeedMps: number;
  relaxationLevel: number;
}

export function edgeCost(
  graph: PedGraph,
  attrIdx: number,
  profile: CostProfile,
): number;
```

- Phase 0 **只實作 wheelchair**，其餘 profile 丟 `not implemented`。（上位規格 §12 Phase 5 才做多 profile。）
- 硬限制依上位規格 §7.3；放寬階梯依 §7.3b，以 `relaxationLevel`（0 = 全硬）選取。
- 室內邊以 `edgeTraversalTimeS` 為基底，戶外邊以 `edgeLengthM` 為基底。
- **未知屬性走中性基準，不得當成最差**（§7.4）。

### 5.3 A\*

```ts
export interface RouteResult {
  nodePath: Int32Array;
  totalCost: number;
  expandedNodes: number;
  reopenedNodes: number;
}
export function aStar(
  graph: PedGraph,
  from: number,
  to: number,
  profile: CostProfile,
): RouteResult | null;
```

- 啟發函數：`h(n) = max(0, haversineM(nodeLon[n], nodeLat[n], goalLon, goalLat) − stationRadiusOf(n)) / maxSpeedFactor`，其中 `stationRadiusOf` 對非室內節點回 0（上位規格 §9.1b）。
- 啟發值必須與 cost 同單位。若 cost 以距離為基底，`h` 直接用公尺；室內邊以時間計價時，須以 profile 步速換算成可比單位，且換算須**保守**（寧可低估，維持可採納性）。
- **允許節點重開**：取出 closed 節點時若發現更低的 g 值，重新推入。回報 `reopenedNodes`，該數字是 §9.1b 設計是否有效的證據。
- 優先佇列以二元堆實作，鍵值存 `Float64Array`、節點存 `Int32Array`。

### 5.4 Dijkstra 參考實作

同介面、`h ≡ 0`。存在的唯一目的是**交叉驗證 A\* 的最佳性**（上位規格 §13）。

### 5.5 驗收

- **最佳性測試（不可省略）**：至少 50 組隨機 OD，`aStar` 與 `dijkstra` 的 `totalCost` 必須逐一相等（浮點以相對誤差 1e-9 比對）。任一組不等即代表啟發函數設計有誤，**必須回報而非調整測試門檻**。
- 門檻邊界純函數測試：坡度 8% / 12%、有效寬度 0.9 m、有無 ramp 的 steps。
- 放寬階梯測試：`relaxationLevel` 遞增時，可行集必須單調變大。上位規格 v0.5.0 重寫後的 wheelchair 階梯是 **3 級（坡度 > 12% → 有效寬度 < 0.9 m → 無 ramp 樓梯）**，三級皆為真正的可行性放寬（不再含坡度 8–12% 帶這個非-INF 的空層級），因此測試 fixture 若每種阻擋各含一條邊，可行集應**嚴格遞增**，測試須断言到這個強度。
- 回報 `expandedNodes` 與 `reopenedNodes` 的分布。

---

## 6. WP-5 — 室內子圖與 654 出入口對位

### 6.1 產出

| 檔案                                          | 內容                                    |
| --------------------------------------------- | --------------------------------------- |
| `src/scripts/inject-ped-indoor-graph.py`      | GTFS pathways → `ped_edge` / `ped_node` |
| `src/scripts/inject-ped-indoor-graph.test.py` | 純函數測試                              |

### 6.2 內容

1. 自 MongoDB 讀 `gtfspathways`（10,220 條）與 `gtfsstops`，建立室內節點與邊，寫入同一 `version_id`。
2. 室內邊：`geom = NULL`、`length_m = NULL`、`traversal_time_s` 取自 `traversalTime`、`stair_count` 取自 `stairCount`、`edge_type` 由 `pathwayMode` 對映。
3. **代理座標**：以每站 `locationType=2` 出入口的**質心**作為該站所有室內節點的 `proxy_geom`；`station_radius_m` = 該站出入口到質心的最大距離。
4. **縫合**：654 個出入口各自吸附到最近的戶外邊，插入一個節點並產生連接邊。**吸附容差與成功率必須逐站記錄**。

### 6.3 驗收（**這是 Phase 0-3，決定 §9 是否成立**）

- 報告 654 個出入口的對位成功數與距離分布。
- 報告各站 `station_radius_m` 分布——上位規格 §9.1b 假設車站尺度 100–300 m，須實測驗證；若普遍遠大於此，啟發函數會失去引導力（上位規格 §15 待決項 8）。
- 對位率過低時**如實回報並建議 §9 退回不整合**，不得為了讓數字好看而放寬容差。

---

## 7. WP-6 — Phase 0 量測與驗收報告

### 7.1 產出

| 檔案                                     | 內容                                     |
| ---------------------------------------- | ---------------------------------------- |
| `src/scripts/ped-router-phase0-bench.ts` | 量測腳本                                 |
| `docs/reports/PED_ROUTER_PHASE0.md`      | 驗收報告（由腳本產生數據、人工撰寫結論） |
| `package.json`（修改）                   | 新增 `bench:ped-router`                  |

### 7.2 必須產出的數字（對應上位規格 §12 的 0-1～0-5）

| 驗收項             | 指標                                                                |
| ------------------ | ------------------------------------------------------------------- |
| 0-1 建圖 pipeline  | 節點數、有向邊數、`edge_type` 分布、屬性覆蓋率、連通性抽驗可達率    |
| 0-2 CSR 與記憶體   | 實測常駐 heap、六都外推值、與 §5.8 預算的比對                       |
| 0-3 出入口對位     | 654 個的成功數、距離分布、`station_radius_m` 分布                   |
| 0-4 吸附與延遲     | 吸附失敗率；**A\* 核心平面** p50 / p95（N ≥ 100，捨棄前 10 次暖機） |
| 0-5 判定可量測性   | §11.3 四項條件是否皆可自動量測                                      |
| 0-6 政府圖資與 DEM | 見 §7b（WP-7）                                                      |

### 7.3 延遲量測的紀律

- 上位規格 §11.2 協定一：**量測平面必須對齊**。Phase 0 只量「A\* 核心平面」，**不得**拿來與 §3.6 的 OTP GraphQL 端到端數字直接下結論——那要等 Phase 6 的成對量測。
- 協定二：N ≥ 100、捨棄前 10 次暖機。**兩次 warm 值不是 p95。**
- 報告須同時記錄 `graph_version_id`。

### 7.4 報告的誠實要求

- 任何未達標的項目必須明列，**不得只報告好看的數字**。
- 若連通性可達率低、對位率低或 heap 外推超出預算，報告須明確寫出「Phase 0 未通過」與對應的收手／縮範圍建議。
- 依既有教訓：綠燈測試不等於功能正確。報告須包含至少 3 條**人工目視檢查過的實際路線**（起訖點、經過路段、是否合理）。

---

## 7b. WP-7 — 政府開放圖資與 DEM 評估（驗收項 0-6）

**這是一份評估報告，不是實作。** 產出結論與數字，不寫任何進入正式路徑的程式。

### 7b.1 產出

| 檔案                                      | 內容                                                       |
| ----------------------------------------- | ---------------------------------------------------------- |
| `docs/reports/PED_ROUTER_DATA_SOURCES.md` | 評估報告                                                   |
| `src/scripts/eval-gov-sidewalk-data.py`   | 一次性評估腳本（分析用，可留在 scripts 但不接入 pipeline） |

### 7b.2 要評估的三個來源

| 來源                                                     | 位置                                                |
| -------------------------------------------------------- | --------------------------------------------------- |
| 人行道（含 `SW_WTH`／`SWW_WTH`／`SW_RAMP`／`SW_DIRECT`） | `data.gov.tw/dataset/58791`，有 WGS84 與 TWD97 版本 |
| 臺北市人行道固定設施物_無障礙斜坡道                      | `data.gov.tw/dataset/134909`，GeoJSON、TWD97        |
| 內政部 20 m 網格 DTM                                     | `data.gov.tw/dataset/35430`，(N,E,H) 點檔、TWD97    |

### 7b.3 必須回答的問題

**人行道資料集**

1. 台北市有多少筆記錄？涵蓋哪些行政區？相對於 §3.1 的 25,378 條 footway 與 12,756 條可徒步道路，覆蓋率大約多少？
2. `SW_WTH` / `SWW_WTH` / `SW_RAMP` 的實際填答率（非空值比例）各是多少？
3. **對位可行性**：資料的定位是「路名 + 起點 + 迄點 + 方向」的線性參考。抽樣 100 筆，人工判定能否對到 OSM way。**回報成功率與失敗樣態**（路名不一致？起訖點寫法無法解析？一段對到多條 way？）。這題的答案決定整份資料有沒有用。
4. WGS84 版本是否真的帶幾何，還是仍只有文字起訖點？

**無障礙斜坡道資料集** 5. 台北市點位數量？與 `osma11ies` 現有的 1,488 筆 `kerb_cut` 重疊多少？

**20 m DTM** 6. 實際下載並轉檔（TWD97 → WGS84 → GeoTIFF）的工序與耗時。7. 抽樣驗證：在**已知有坡的地點**（如北投、文山山區道路）與**已知平坦的地點**（如信義計畫區）各取 20 條 OSM way，比較 DTM 算出的坡度是否符合現實。**這題要驗的是上位規格 §3.6b 的判斷對不對**——若平地區普遍算出非零坡度，代表雜訊大於訊號。

### 7b.4 硬性要求

- **不得使用 Copernicus GLO-30 或 SRTM**（上位規格 §3.6b：DSM 含建物，市區會產生假坡度）。
- 轉檔後的 raster 必須是 **EPSG:4326**；`inject-osm-dem-slopes.py:45` 用 `dataset.index(lon, lat)`，餵 TWD97 會靜默取到錯誤像素而不報錯。
- 報告須明確給出「這份資料**可用／不可用／有條件可用**」的結論與理由，不要只列數字讓讀者自己判斷。
- 覆蓋率或對位率不理想時如實回報，**不得為了讓數字好看而放寬比對條件**。

### 7b.5 這個 WP 不做的事

- 不寫任何進入 `build-ped-graph.py` 的萃取邏輯（那是評估通過之後的事）。
- 不修改上位規格或本文件——結論交回來由人決定怎麼改。

---

## 8. Phase 0 明確不做的事

| 不做                                            | 理由                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| 接線到 `/accessible-route` API                  | Phase 0 是離線驗證；接線在 Phase 1                                     |
| 動 `scoring.ts`                                 | 上位規格 §12 已獨立為 Phase 4                                          |
| 實作 elderly / visual_impaired / normal profile | 上位規格 §12 Phase 5                                                   |
| 動態覆蓋（hazard / 電梯故障）                   | 上位規格 §12 Phase 3                                                   |
| 兩趟制的 API 回應契約                           | Phase 1；Phase 0 只需 `relaxationLevel` 參數存在                       |
| 六都圖資                                        | 上位規格 §12 Phase 6                                                   |
| pgRouting 對照實作                              | 上位規格 §5.1 已移除該臂                                               |
| `effective_width_m` 從 barrier 幾何推導         | Phase 2。（但若 WP-7 證實 `SWW_WTH` 可用，來源會改成政府資料而非推導） |

---

## 9. 派工檢查清單

每個 WP 完成時須自我檢查：

- [ ] `pnpm run lint:arch` 乾淨
- [ ] `pnpm typecheck` 乾淨
- [ ] `pnpm test` 全綠（新增測試已納入）
- [ ] Python 部分 `pnpm test:python` 全綠
- [ ] 未修改 §0 第 5 點列出的禁止檔案
- [ ] 新增相依已進 `package.json` 與 `pnpm-lock.yaml`（pnpm，非 npm）
- [ ] 註解只有函式 JSDoc
- [ ] 回報實測數字，**不以推估代替量測**
