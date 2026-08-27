# 行人圖連通性診斷報告：11 組無法路由 OD 的成因分類

**日期**：2026-08-27 · **圖版本**：`ped_graph_version.id = 1` · **狀態**：唯讀診斷；**未變更任何圖資，version 1 仍不可變，未重建或啟用新版本**

本報告回答 `PED_ROUTER_OTP_COMPARISON.md` 留下的第一個缺陷：200 組 OD 中有 **11 組本引擎完全
無法路由，且無約束最短路也不連通**，而 OTP 全部規劃得出。當時的結論是「建圖層連通性缺陷」，
但沒有機制性證據。這份報告補上證據，並**刻意不修圖**——先分類，再決定哪些可以動。

> **本版（2026-08-27 修訂）的判定較初版保守。** 初版把「被排除的 way」直接當成規則缺陷、
> 把「原始標記缺失」當成立體分隔證據、把「屏障穿越一條直線代理」當成不可通行證明。這三項
> 都不成立，已全部下修，詳見 §3.1。**確認的規則缺陷從 3 組降為 1 組。**
>
> **本次建圖政策更新（未重建圖資）**：建圖器只納入帶 `foot=yes|designated|permissive`、且無拒絕
> 存取標記的 `highway=cycleway`；未標記 cycleway 仍排除。診斷不再把「目前政策不納入」稱為
> 舊圖的「排除」：它以 selected `ped_edge.source_ref` 確認 way 是否真的缺於 version 1，然後才以
> 當前 `should_include_way` 判定是否為缺陷。

---

## 1. 執行方式（可重現）

```bash
# 唯讀診斷（SELECT-only）
npx dotenvx run -f .env.development -- python3 src/scripts/diagnose-ped-graph-connectivity.py \
  --version-id 1 \
  --comparison /tmp/ped-otp-comparison.json \
  --pbf otp-data/taiwan-latest.osm.pbf \
  --output /tmp/ped-graph-connectivity-diagnosis.json
```

執行時間約 4 分鐘（其中絕大部分是 PBF 掃描）。輸出 `unclassifiedCount = 0`。

**輸入一致性（先驗，失敗即中止）**：診斷同時讀兩個來源——節點/邊/元件來自資料庫，
OSM way ID 與原始標記來自 PBF。兩者若不是同一份輸入，就會把某一版 extract 的標記
安到另一版的拓樸上。因此在掃描 PBF 之前，先以 `build-ped-graph.py` 的
`sha256_file()`（同演算法、同語意）計算 PBF 內容雜湊，與 `ped_graph_version.source_hash`
逐字比對，不符或缺值一律中止，**不提供繞過選項**。

```text
[diagnose-ped-connectivity] pbf sha256 matches version 1
source_hash=5bf0b42af708d06de3aba8180c13643bb02c9af7ece55e2289f89bccad68367b
```

本次 **比對通過**：`otp-data/taiwan-latest.osm.pbf` 即 version 1 的建圖輸入，
故以下 OSM ID 與標記證據皆可採信（`pbfSourceHashVerified: true`）。

**唯讀保證**：連線以 `set_session(readonly=True)` 開啟；所有 SQL 為模組層常數，
經 `run_select` 的名稱白名單與 `assert_select_only()` 雙重把關（拒絕非 SELECT、多語句、
含 DDL/DML 關鍵字者）；診斷路徑不匯入任何建圖寫入 helper。

**端點解析**：比較檔記的 `node` 是 CSR 稠密索引（= `ORDER BY node_id` 的序位，與
`graph-loader.ts` 一致）。解析**一律掃描全部節點做唯一性檢查**（容差 1e-7 度）：
容差內零命中或兩個以上命中都失敗中止，**不做就近吸附**；稠密索引吻合只影響
`resolvedBy` 標示，不作為跳過唯一性檢查的捷徑。本次 11 組 22 個端點全部唯一命中，
且命中者恰為稠密索引所指節點（`resolvedBy = dense_index`）。

重播驗證（同一組 OD 原樣重跑，確認缺陷仍在、非一次性）：

```bash
npx dotenvx run -f .env.development -- ts-node src/scripts/ped-router-otp-comparison.ts \
  --version-id 1 --otp-url http://localhost:18080 \
  --pairs-input /tmp/ped-otp-disconnected-pairs.json --output /tmp/ped-otp-disconnect-repro.json
# → coverage sampled=11 both=0 only_ours=0 only_otp=11 neither=0
```

---

## 2. 全圖弱連通結構

| 指標                    | 值                    |
| ----------------------- | --------------------- |
| 節點數 / 有向邊數       | 165,432 / 453,144     |
| 弱連通元件數            | **1,557**             |
| 最大元件節點數（佔比）  | 160,819（**97.21%**） |
| 最大元件以外的節點      | 4,613                 |
| 孤島數（元件大小 1–72） | 1,556                 |

**2.79% 的節點不在主元件內。** 11 組失敗 OD 全部是「主元件 ↔ 2–22 節點小島」的跨越，
與先前推測一致。孤島最大 72 節點。

---

## 3. 逐案分類

分類採**保守優先序**：`ELIGIBILITY_RULE_DEFECT` → `SAME_GRADE_INTERSECTION_PROVEN` →
`GRADE_SEPARATED` → `BBOX_ARTIFACT` → `OSM_GAP_UNPROVEN`。
**距離近本身不構成任何結論**，只能落到 `OSM_GAP_UNPROVEN`。

### 3.1 什麼算「正面證據」（本版收緊處）

| 證據種類                                                                           | 採計條件                                                                                                                                              | 不採計的情形                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺於 selected stored graph 的 current-policy connector → `ELIGIBILITY_RULE_DEFECT` | PBF way 的 `osm:way/<id>` **不在該版本 `ped_edge.source_ref`**，當前 `should_include_way` 會納入，且同時共用島側與主元件側 OSM 節點                   | 僅「當前政策不納入」不說明舊圖歷史。**無 `foot` 的 `highway=cycleway` 不採計**；`motorway`/`motorway_link` 一律不採計（即使帶 `foot=yes`）；任何拒絕存取標記一票否決 |
| 幾何相交 → `GRADE_SEPARATED`                                                       | 島側與主元件側**兩邊的原始 OSM 標記都讀得到**，且有**正面衝突的立體語意**：`layer`/`level` 值衝突，或 `bridge`/`tunnel`/`location`/`covered` 語意衝突 | **任一側標記缺失、相同的 `bridge`/`tunnel` 標記，或其他無法正面證明分隔的組合**都記為 `unknownGradeIntersections`；未知不得當成立體分隔                              |
| 屏障                                                                               | **不再作為分類依據**                                                                                                                                  | 見下                                                                                                                                                                 |

診斷 JSON 將舊的 `connectorExcludedWays` 更名為 `missingEligibleConnectorWays`：每筆都明示
`eligibleUnderCurrentPolicy: true` 與 `missingFromSelectedStoredGraph: true`。舊名稱只描述當時的
策略判定，無法描述 immutable version 1 與新 builder policy 的差異，故不再輸出。

**屏障已從分類集合移除。** 原本的 `BARRIER_BLOCKED` 依據是「一條從島側最近點到最近主元件
邊頂點的直線代理被 `barrier` way 穿越」。這只證明牆位於兩點之間，**不證明牆分隔兩個元件**——
牆可能很短、可能繞得過、也可能根本不在真實連接路線上。要證明分隔需要拓樸切割證明，本診斷
不做。因此屏障改記為 `barrierObservations`（每筆帶 `provesSeparation: false`），只呈現、
不判定。**這是「證據不足」，不是「沒有牆」**：159/169 的兩道 `barrier=wall` 確實存在於
PBF 中，只是不足以支撐「不可通行」的結論。

`CLASSIFICATIONS` 因此為 5 類（不含 `BARRIER_BLOCKED`）。

### 3.2 分類結果

| 案例 | 島節點數 | 缺口 (m) | 最近主元件邊                                            | 分類                        | 關鍵證據                                                                                                                   |
| ---- | -------- | -------- | ------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 7    | 12       | 15.54    | `osm:way/1288887510`                                    | **OSM_GAP_UNPROVEN**        | —                                                                                                                          |
| 22   | 4        | 5.03     | `osm:way/238526531`（`primary` 忠孝東路二段）           | **GRADE_SEPARATED**         | 島 `steps` tunnel/`layer=-2` 相交主元件 **12** 次（兩側標記皆可讀）                                                        |
| 24   | 4        | 5.09     | `osm:way/51903947`（`secondary_link` bridge/`layer=3`） | **GRADE_SEPARATED**         | 島地面 `footway` 相交 `layer=3` `bridge=yes` 結構 **8** 次（兩側標記皆可讀）                                               |
| 29   | 10       | 34.74    | `osm:way/890181932`                                     | **OSM_GAP_UNPROVEN**        | —                                                                                                                          |
| 89   | 2        | 19.02    | `osm:way/1519344087`                                    | **ELIGIBILITY_RULE_DEFECT** | way/229778286 `highway=cycleway` + **`foot=designated`**（`bicycle=designated`, `segregated=yes`），共用島側與主元件側節點 |
| 127  | 5        | 9.99     | `osm:way/326955636`                                     | **OSM_GAP_UNPROVEN**        | —                                                                                                                          |
| 140  | 3        | 4.34     | `osm:way/1493587279`                                    | **OSM_GAP_UNPROVEN**        | 觀察（不採計）：way/431622978 `highway=cycleway`，**無任何 `foot` 標記**                                                   |
| 159  | 2        | 18.20    | `osm:way/1482634486`                                    | **OSM_GAP_UNPROVEN**        | 觀察（不採計）：way/1021950762 `barrier=wall` 穿越直線代理                                                                 |
| 169  | 12       | 4.33     | `osm:way/378671108`                                     | **OSM_GAP_UNPROVEN**        | 觀察（不採計）：way/1021950825 `barrier=wall` 穿越直線代理                                                                 |
| 170  | 22       | 12.04    | `osm:way/384900208`                                     | **OSM_GAP_UNPROVEN**        | 觀察（不採計）：way/263599056 淡水河河濱自行車道 `highway=cycleway`，**無任何 `foot` 標記**                                |
| 174  | 7        | 49.94    | `osm:way/853612450`                                     | **OSM_GAP_UNPROVEN**        | —                                                                                                                          |

彙總：`ELIGIBILITY_RULE_DEFECT` **1**、`GRADE_SEPARATED` **2**、`OSM_GAP_UNPROVEN` **8**、
`SAME_GRADE_INTERSECTION_PROVEN` 0、`BBOX_ARTIFACT` 0、未分類 **0**。

本次 11 組**沒有任何** `unknownGradeIntersections`（22/24 的 20 次相交都有正面衝突的立體語意），
因此「標記缺失、相同的 `bridge`/`tunnel` 與其他不確定組合皆不採計」這條規則本次未改變任何案例的結果——但它防的是下一次。

---

## 4. 三個必須分開看的結論

### 4.1 只有 1 組是已證實的引擎規則缺陷

**案例 89**。version 1 缺少 way/229778286；它是 `highway=cycleway`，帶
**`foot=designated`**（明示行人可通行、`segregated=yes`），而且**同時共用島側與主元件側的
OSM 節點**。當前 builder policy 會納入它，故「selected stored graph 缺少當前應納入的連接」
構成缺陷；下次 immutable rebuild 會修復它。**本次沒有寫入、重建或啟用任何 graph version，
因此 version 1 本身仍保持原狀。**

**案例 140 / 170 不算。** 它們的候選連接 way 同樣是 `highway=cycleway`，但**完全沒有
`foot` 標記**（170 是淡水河河濱自行車道），當前政策仍不納入。專案**沒有**「未標記的
`cycleway` 視為行人可通行」這條政策，這兩組維持 `OSM_GAP_UNPROVEN`；**不得因為它們
看起來像 89 就一併宣稱是規則缺陷。**

（窄政策定義於 `build-ped-graph.py` 的 `has_explicit_pedestrian_permission()`；診斷以
`should_include_way()` 加上 selected stored graph 的 source reference 判定，見 §3.1。）

### 4.2 有 2 組（22/24）**已證實不應該被連起來**——連了就是製造假路線

- **22**：島是**捷運地下轉乘通道**（`轉乘通道`, `tunnel=yes`, `layer=-2`,
  `level=-2;-3`, `location=underground`），在平面投影上與新生南路、忠孝東路等地面道路
  「相交」12 次。這正是主模型先前觀察到的「案例 22 幾何相交但無共用 OSM 節點」——
  **相交是平面投影假象，實體差了兩層樓**。
- **24**：島是地面 `footway`，與 `layer=3` 的 `bridge=yes` 高架匝道及其橋上人行道相交（共 8 次）；
  最近的主元件邊本身就是那條 `layer=3` 匝道，缺口 5.09 m 全是垂直落差造成的假鄰近。

這兩組足以支撐同一個結論：**若當初直接對 4.3–50 m 的缺口做就近縫合，會產生現實中不存在的
路線**。159/169 雖然證據不足以判定，但兩道 `barrier=wall` 的存在同樣是「距離近不等於可通行」
的提醒——169 的缺口只有 **4.33 m**。

### 4.3 剩下 8 組維持不判定

`OSM_GAP_UNPROVEN` 共 8 組：7、29、127、140、159、169、170、174。缺口 4.33–49.94 m。
其中 4 組帶有**不足以定案的觀察**（140/170 的無標記 cycleway、159/169 的牆），
另 4 組（7/29/127/174）連觀察都沒有——沒有缺於 selected graph 且當前應納入的連接、沒有可判定的相交、
不貼 bbox 邊界。

**本報告不宣稱這 8 組的成因。** 沒有正面證據就是沒有。要推進只能靠人工目視、明定
profile 政策，或上游補圖，不得由引擎自行推斷。

---

## 5. 已知限制（不得當成已證實）

1. **屏障不構成結論。** `barrierObservations` 只是「這道牆與直線代理相交」，
   不是「此處不可通行」。反過來也不成立：沒有觀察到牆**不代表沒有牆**（PBF 未標、
   或落在 150 m 搜尋半徑外都會漏）。
2. **`BLOCKING_BARRIER_VALUES` 是本腳本新增的判斷表**，刻意排除 `kerb` / `bollard` /
   `gate` / `cycle_barrier`（通常可通行），避免把一般缺圖誤判成屏障。
3. **交叉分級極度保守**：兩條標記完全相同的橋樑或隧道，既不證明同一平面、也不證明
   `GRADE_SEPARATED`，一律記為未知；只有明示衝突的 `layer`/`level`/`bridge`/`tunnel`/
   `location`/`covered` 語意才可判立體分隔。因此本次 `SAME_GRADE_INTERSECTION_PROVEN` = 0 是
   「沒有證到」，不是「證明沒有」。
4. **行人通行政策是本切片明定的窄政策**（§3.1），不是 OSM 語意的完整解讀。
   `foot=permissive` 採計、無標記不採計，都是可辯論的選擇；改動須走 profile 決策。
5. **搜尋半徑 150 m**：更遠的連接可能性未納入。
6. 本報告只診斷這 11 組。全圖另有 1,545 個孤島**未逐一分類**。

---

## 6. 待決（本階段刻意不做）

| #   | 事項                                                                       | 為何不在本階段做                                                                             |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | 以已實作的窄 cycleway 規則另行建立 immutable graph version，並重跑對比實驗 | 本次明確不重建、不寫 DB、不啟用版本；version 1 必須保留供本報告與新版本比較                  |
| 2   | 8 組 `OSM_GAP_UNPROVEN` 的人工目視（含 140/170 的自行車道與 159/169 的牆） | 需人工，且結論應回饋上游 OSM 而非本地補邊                                                    |
| 3   | 是否投入實作**拓樸切割證明**，讓屏障能成為可判定證據                       | 需設計「島與主元件之間所有可能連接路徑皆被屏障截斷」的形式化判準與強測試；成本高，本切片不做 |
| 4   | 全圖 1,556 個孤島的普查與驗收門檻                                          | 需先決定「主元件覆蓋率」要不要成為建圖驗收條件（見 §5.6b 註記）                              |
| 5   | p99 延遲劣於 OTP（186.9 ms vs 146.4 ms）                                   | 與連通性無關，屬另一條缺陷線                                                                 |

**任何縫合動作都必須逐案引用本報告的分類：唯一有機制性證據支持的是案例 89，
且 §4.2 的兩組絕對不得縫合。`OSM_GAP_UNPROVEN` 的 8 組在取得新證據前一律不動。**
