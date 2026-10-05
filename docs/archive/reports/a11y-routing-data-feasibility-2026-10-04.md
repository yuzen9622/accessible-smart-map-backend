# 路線資料 1–5：可行性驗證與第一階段實作

日期：2026-10-04。範圍：人行道、路緣坡道、無障礙入口與站內通道、坡度、動態障礙。

結論：五類皆有可利用資料；目前完成可由資料與重現案例支持的程式修正。尚未重建、匯入或切換 ACTIVE 圖，亦未部署。不能據此宣稱實際路線準確率已提升。

## 可行性與採用決策

| 項目 | 實際證據 | 本輪可採用 | 尚待驗證 |
|---|---|---|---|
| 1. 人行道與淨寬 | 441,456 條戶外有向邊中，158,498 條有淨寬，約 35.9%；其中 108,834 條政府配對的實際重疊長度為 0 | 匯入拒絕明顯非經緯度座標與非面幾何；淨寬大於總寬時保留未知 | 鄰近配對不等於同側人行道；需要道路側別、分隔與實地樣本，不能直接把所有配對視為可靠，也不宜一次刪除 |
| 2. 路緣坡道 | 42,714 條有向穿越邊中，15,252 條兩端觀測到坡道；18,285 筆反向坡道對應缺漏 | 載圖時補足同版本、反向端點、同來源、同類型且幾何相等的反向對應 | 點位鄰近不能證明路口兩側連通；沒有觀測到不等於不存在。新增點位仍需拓撲與抽樣驗證 |
| 3. 無障礙入口／站內通道 | 375 個入口全部在 50 m 內配到戶外圖；距離中位數 3.934 m、最大 41.507 m。站內通道有通行時間，但無實際線形與長度 | 修正下車出站仍使用進站方向尋路；保留有向通道限制 | 距離配對不證明無牆或同側。無法從站點中心推導精確室內導航；需入口連通驗證及設備／通道 ID 對應 |
| 4. 高程／坡度 | 267,716 條短於 40 m 的邊已有 DEM 坡度，其中 14,826 條超過 12%；這是精度風險指標，並非已證實錯誤 | 支援 DEM CRS 轉換、NoData／NaN；以至少兩格解析度篩掉過短估計；橋梁／地下道不套地表坡度；保留數值 OSM incline 與方向 | 兩格門檻是保守工程規則，不是輪椅坡度精度保證。新 DTM 資源的 DTM／DSM 標示需釐清，候選圖需與實測比較 |
| 5. 施工／電梯／社群障礙 | 即時官方 feed 均可下載解析；已重現下載失敗後舊施工與電梯公告可被續期到 365 天 | 過期快取刷新失敗回未知資料集合，不再無限續期；沿用既有重試間隔 | 未對應的施工許可未獨立變成路段封閉；車站級公告不能硬封全站；社群障礙目前主要重排候選，尚未形成完整圖層避障 |

以上計數是有向圖邊或配對紀錄，不代表實體道路條數或全市覆蓋率。既有 ACTIVE 圖版本為 1，建置日期 2026-08-22。

## 實際資料驗證

讀取既有 PostGIS，使用 READ ONLY transaction；未修改圖資料。原始彙總見 [baseline](a11y-data-feasibility-baseline-2026-10-04.json)。可重跑 [audit-accessibility-data.sql](../../../src/scripts/audit-accessibility-data.sql)（從 repo root 的實際路徑為 `src/scripts/audit-accessibility-data.sql`；需要坡道匯入表）。

官方來源以 HTTP 實際取得並使用現有 parser 驗證，記錄見 [feeds](a11y-data-feasibility-feeds-2026-10-04.json)：

- 路緣坡道：HTTP 200，34,684 features；28,337 筆接受、6,334 筆非無障礙坡道、13 筆座標不一致。ACTIVE 資料來源含 28,335 點，尚未自動更新。
- Todaywork：HTTP 200，1,198 features，135 個案號，其中 26 個案號有封路旗標；這不是 26 個已確認影響步行的封路。
- 捷運公告：HTTP 200，152 bytes，1 個解析列、0 個有效異常公告；不代表所有電梯已經實測正常。
- 坡道 runtime 查詢：最初完整資料測試超過 30 秒；改為可內聯 CTE 後，完整查詢與彙總約 5.491 秒，回傳 36,672 筆配對、涵蓋 26,747 個 edge_id。此為單次本機 Docker 量測，非服務延遲 SLA；查詢在載圖時執行。

## 修改檔案與原因

- `src/scripts/build-ped-graph.py`：人行道輸入品質檢查、DEM 短段與高架／地下排除、數值 OSM incline 及反向符號。`source:incline=dem` 的最大坡度不當成該段實測方向。
- `src/scripts/inject-osm-dem-slopes.py`：投影座標 DEM 取樣、無效高程遮罩、解析度門檻、保留原有 incline、排除高架／地下，並標記新增 DEM incline 來源。
- `src/modules/accessible-route/planners/pedestrian-a11y/graph-loader.ts`：載入同一實體路段的反向坡道點位。
- `src/modules/accessible-route/planners/indoor-graph.ts`：加入 ingress／egress 方向選擇。
- `src/modules/accessible-route/planners/route-a11y.ts`：下車站使用 egress 查詢。
- `src/adapters/taipei-construction.adapter.ts`、`taipei-metro-notice.adapter.ts`：停止過期公告在失敗刷新後無限續期。
- `src/scripts/build-ped-graph.test.py`：增加真實 raster／OSM PBF CLI fixture、坡度方向與人行道異常資料測試。
- `src/adapters/accessibility-feed-freshness.test.ts`：TTL、失敗、長期失敗與恢復測試。
- `src/modules/accessible-route/planners/indoor-graph.test.ts`：單向進出站、階梯限制與下車出口整合測試。
- `src/modules/accessible-route/planners/pedestrian-a11y/ramp-query.integration.test.ts`：獨立 PostGIS 驗證反向對應、不同路段／版本隔離與去重。
- `src/scripts/audit-accessibility-data.sql` 及本報告三個 JSON／Markdown artifacts：可重跑稽核與本輪證據。

API 未新增或變更 mount；既有 `POST /api/v1/a11y/accessible-route` 契約維持。

## 驗收與限制

- `pnpm build`：通過，包括 architecture boundary check 與 TypeScript。
- Python：23 tests 通過；包含實際 `.osm` + `.tif` 經 CLI 產出 `.pbf`。
- TypeScript 合計：13 files、100 tests 通過，含獨立 PostGIS integration 與坡道、步行成本、障礙排序回歸。測試使用暫時表與 rollback，不修改 ACTIVE 資料。
- `git diff --check`：通過。
- 方向與快取修改經第二位 agent 限定範圍 review，未發現阻擋問題；獨立重跑新增 6 tests 通過。

刷新失敗回空集合表示來源不可用，不是道路暢通或電梯恢復；目前 API 沒有新增 feed 健康狀態欄位。DEM 變更會增加未知坡度，必須在候選圖上確認輪椅／高齡／一般模式的短長程可達性、路線連續性與延遲後再切換。既有來源若有無 provenance 的歷史 DEM incline，需要重新從原始 OSM 產圖以避免誤認為 OSM 實測。

後續必要驗收：重建隔離候選圖；核對道路側別及路口兩端；確認入口不穿牆／跨分隔；對坡度抽樣實測；執行部署端路線矩陣。此次沒有全量新資料匯入、圖重建／promotion、部署或真實輪椅道路驗收。

## 官方來源

- [臺北市人行道資料與欄位](https://data.gov.tw/dataset/58791)
- [臺北市路緣坡道原始資料](https://data.taipei/api/dataset/8ab0c662-b560-4310-a825-001ae7fdc524/resource/ee522d94-daa7-4118-b52a-4bf144af2744/download)
- [Todaywork 施工許可](https://tpnco.blob.core.windows.net/blobfs/Todaywork.json)
- [臺北捷運無障礙設施異常公告](https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=649c44eb-60b5-4746-a353-cbdc6651fc09)
- [20 公尺 DTM](https://data.gov.tw/dataset/35430)、[新版高程資源](https://data.gov.tw/dataset/178729)
- [OSM incline 定義](https://wiki.openstreetmap.org/wiki/Key:incline)

TGOS 本身的服務／資料使用範圍另見 [前一份研究](./tgos-data-research-2026-10-04.md)。本輪主要使用原資料機關來源，沒有把 TGOS 圖磚誤當成可路由路網。
