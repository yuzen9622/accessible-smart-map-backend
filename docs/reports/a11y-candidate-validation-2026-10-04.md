# 無障礙資料補足與候選路網驗證

日期：2026-10-04。接續 [第一階段評估](a11y-routing-data-feasibility-2026-10-04.md)。本報告的候選匯入與實測結果取代前報告中「尚未重建」的進度描述；前報告保留當時基線。

## 實作與資料

| 項目 | 本輪完成 | 尚不能推論的事項 |
| --- | --- | --- |
| 人行道 | 202606 臺北市官方面資料與原始 OSM 重建；路段至少 80% 長度位於面內才套政府寬度、淨寬及坡道數。弱配對只留來源，不影響數值與去重 | 80% 為工程篩選，不能證明同側、無牆或實際淨寬 |
| 路緣坡道 | 最新來源接受 28,337 點；候選圖匯入與正反向實體邊配對 | 鄰近點不能單獨證明行穿線兩端都有正確方向坡道 |
| 出入口與電梯 | 375 個圖範圍內捷運入口全部配到 50 m 內戶外節點；進／出站保留有向性；新增官方入口與電梯參考點 | 缺設備 ID、樓層拓樸與精確通道線形，不能按車站級公告硬封特定電梯邊 |
| 坡度 | 使用已確認來源的 20 m DTM，排除短於兩格、高架／地下等不適用估計，保留 OSM 數值坡度方向 | 新版 2026 資源 DTM／DSM 標示待確認；20 m 模型不是輪椅路面坡度實測 |
| 動態障礙 | 已確認社群 blocking 障礙可觸發請求內 A* 排除邊，新增繞路候選；失敗保留原路與警告；後續查詢不殘留排除；刷新失敗保留已知阻擋並標記 degraded | 施工許可不等於行人封路；官方公告尚無可靠設備級對應 |

輪行臺北六類資料已轉成可匯入 GeoJSON 並匯入隔離 PostGIS `wheelroute_reference`，共 **49,557 筆參考設施**：坡道 28,164、電梯 221、入口 932、人行道 15,263、標線人行道 3,529、行穿線 1,448。排除 139 筆範圍外、29 筆未閉合面及 2 筆無效面，共 170 筆。這些數字不代表新增唯一設施或新增可通行路段；與原坡道來源可能重複。保留來源、交通局顯名、快照雜湊、未知狀態及原始數值；寬度單位尚有矛盾，`routing_eligible=false`。未新增前端圖層 API。

官方來源與欄位實查見 [來源報告](a11y-remaining-sources-2026-10-04.md)；輸入雜湊見 [manifest](a11y-candidate-manifest-2026-10-04.json)，逐類拒收統計見 [Wheelroute 驗證](a11y-wheelroute-validation-2026-10-04.json)。

## 隔離方式與資料庫檢查

候選 PostGIS 在獨立容器 `a11y-candidate-20261004`、本輪測試 port 64448（Docker 分配的 host port，重啟後改為 50346；重跑前使用 `docker port` 取得）；候選 API 為 18001。沒有改寫正式 PostGIS 圖或切換正式 API。候選與正式資料庫的 version 1 是不同資料，不應只比 ID。

候選戶外 164,167 節點、452,420 有向邊，加上室內與連接段後合計 **168,231 節點、464,108 有向邊**。入口配對中位數 3.855 m、P95 17.157 m、最大 37.419 m；這是幾何距離，不是通道可走證據。

空白候選庫不符合既有「必須已有一個 ACTIVE」切換前置條件，因此在隔離庫交易內暫設首次 ACTIVE，再呼叫既有完整 promotion integrity validator；通過才提交。未更改正式 promotion 規則。

實際載入曾發現 `ped_edge_pkey` 索引損壞：索引掃描只見 133,591 筆，表掃描 464,108 筆，amcheck 報 `invalid internal page level 0 for block 366`。隔離庫執行 REINDEX 後，13 個公開 B-tree 索引通過包含 heapallindexed 的檢查，邊數一致。根因尚未確定，不將此歸因於圖演算法，也不直接把這個儲存映像投入正式環境。

## 驗證工具與變更檔案

- `src/scripts/build-ped-graph.py`、`inject-osm-dem-slopes.py`：政府面重疊門檻、來源紀錄、坡度品質門檻及 DEM 取樣效能。`build-ped-graph.test.py` 為實際 raster／PBF 與品質規則測試。
- `src/scripts/prepare-wheelroute-data.py`、`.test.py`：六類來源正規化、拒收、顯名、快照替換匯入；不改寫路由邊。
- `src/modules/accessible-route/planners/pedestrian-a11y/graph-loader.ts`、`.test.ts`：坡道反向對應與弱人行道來源隔離；`ramp-query.integration.test.ts` 驗證真實 PostGIS 空間條件。
- 同目錄 `astar.ts`、`.test.ts`、`csr-walk-planner.ts`、`csr-walk.types.ts`、新增 `hazard-edges.repository.ts`：限定當次查詢的障礙邊排除與繞路。
- `src/modules/accessible-route/accessible-route.service.ts`、`.test.ts`、`src/constants/messages.ts`：繞路候選保留、等時間距離但不同幾何去重、已知危險在刷新失敗後的降級訊息。這些檔案原有其他任務修改已保留。
- `src/modules/accessible-route/planners/indoor-graph.ts`、`.test.ts`、`route-a11y.ts`：進出站方向。
- `src/adapters/taipei-construction.adapter.ts`、`taipei-metro-notice.adapter.ts`、`accessibility-feed-freshness.test.ts`：快取時效與失敗測試。
- `src/scripts/validate-a11y-candidate.ts`、`verify-a11y-http.mjs`、`audit-a11y-candidate.sql`、`audit-accessibility-data.sql`：可重跑圖查詢、HTTP 與空間稽核；相關 JSON 為本次實測證據。

Endpoint 維持 `POST /api/v1/a11y/accessible-route`，沒有新增 mount 或變更 request schema。

`pnpm build` 通過（architecture boundary + TypeScript）。本輪 TS 大組合 346 tests 通過，另 5 tests 因環境／舊圖固定筆數條件未跑；不能視為全數通過。候選 PostGIS 獨立 integration 1 test 通過。Python builder 24、Wheelroute 3、indoor 17 tests 通過。實際候選圖與 HTTP 檢查另列，不能用單元測試代替。

## 產物位置

原始快照、正規化 GeoJSON、建置 logs 及候選備份位於 `/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/`。其中 `normalized/wheelroute-reference.geojson` 為可匯入 GIS／地圖工具的 WGS84 FeatureCollection；大型產物未放入 Git。

## 實測結果與決策

**決策：程式與隔離匯入可供審查，正式圖切換 HOLD。** 自動驗證通過不能替代道路側別、入口連通及輪椅實測。尚未正式部署；沒有把 49,557 筆參考設施全部當成可路由道路。

- [新舊圖固定座標基線](a11y-route-baseline-2026-10-04.json)與[候選結果](a11y-route-candidate-2026-10-04.json)：10 組 OD × normal／elderly／wheelchair，共 30 組；新舊均 21 成功、9 無路線，沒有新增失敗。9 個既有失敗均以臺北車站固定座標為起點。此工具只做單一最近節點、strict level 0 A*，不等於完整 API 的多候選吸附結果；此缺口未修復。
- 21 條成功候選路線：缺失幾何 0，最大線段接縫 0 m。這證明幾何接續，不證明路面可走。
- 真實候選圖上的模擬障礙點 `[121.5626643,25.0411388]` 找到 8 條需避開有向邊；找到替代路徑且未使用排除邊；下一次正常查詢路徑保持不變。此為模擬觀測，沒有新增真實民眾通報。
- [部署端 HTTP 基線](a11y-http-baseline-2026-10-04.json)與[本機候選 HTTP](a11y-http-candidate-2026-10-04.json)：3 組 OD × 3 模式，共 9 組，兩者全數 HTTP 200 且有 `pedestrian-a11y` 路線。市政府→國父紀念館輪椅 784→753 m；北投→動物園 23,979→21,664 m；淡水→動物園 31,603→29,870 m。後者候選輪椅 622 分鐘、高齡 542 分鐘，超過 8 小時仍可產生路線。此為步行引擎覆蓋驗證，未重新驗證 OTP 大眾運輸 8 小時矩陣。
- 上述路線變短不能直接視為改善：已知淨寬由舊圖 158,498/441,456（35.903%）降至候選 13,712/452,420（3.031%），因不再套用低重疊的政府面屬性。候選已知坡度 147,108 條（32.516%）。需要實測補足未知值後才能聲稱輪椅安全性提高。
- [空間稽核](a11y-candidate-spatial-audit-2026-10-04.json)：149,456 條弱人行道配對邊中，錯套政府淨寬 0；DEM 來源且短於 40 m 的邊 0。375 個入口中，67 個在獨立入口／電梯點 5 m 內、156 個在 15 m 內；151 個無 50 m 內參考點，不能宣稱全部入口已獨立核實。
- 43,008 條有向 crossing 邊中，10,414 條端點有不同坡道點可供對照，5,058 條兩端只有同一個坡道點。可能包含切分路段，不能一律判錯，也不能當作兩端已核實。需側別／行穿線拓樸對照與現地確認。
- 候選資料庫重新啟動後，13 個 B-tree 索引再次通過 `bt_index_check(..., true)`，邊數仍為 464,108；紀錄見外部產物 `post-restart-amcheck.log`。索引損壞根因仍未查明，正式環境應以原始快照重建或經還原驗證的備份處理，不直接搬移本次磁碟映像。

剩餘外部證據：官方釐清 Wheelroute 寬度單位與新版 DEM 類型；設備 ID／樓層通道對應；道路側別、路口坡道及入口的現地連通驗證。這些未取得前不應以推測數值補齊、硬封站點，或把未知標成安全。正式部署與前端參考圖層展示尚未執行。

候選 API 使用本機獨立 process，未啟動背景工作；Redis 停用，因此沒有驗證 route-token cache 或重規劃 token 儲存。HTTP 時間為當次量測，不是冷／暖快取或正式 SLA。正式基線使用現行部署程式，直接圖比較使用同一份新 loader 搭配新舊資料；兩種比較軸不同。

## 重跑入口

先安裝專案既定 pnpm 依賴、完成 `pnpm build`；Python 需 Shapely／rasterio／pyosmium／psycopg2 與既有 indoor injector 依賴。請將 `PED_GRAPH_DATABASE_URL` 指向隔離驗證庫。下列驗證命令唯讀，坡道／Wheelroute 匯入命令則會寫入指定資料庫。

```sh
node dist/scripts/validate-a11y-candidate.js "$PED_GRAPH_DATABASE_URL" 1 /tmp/a11y-route-validation.json
node src/scripts/verify-a11y-http.mjs http://127.0.0.1:18001 /tmp/a11y-http-validation.json
psql "$PED_GRAPH_DATABASE_URL" -X -qAt -0 -f src/scripts/audit-a11y-candidate.sql
```

SQL 每筆輸出是 JSON，可能包含內嵌換行；`-0` 使用 NUL 分隔，應按 NUL 切分，不能逐行解析。`audit-a11y-candidate.sql` 明確稽核 version 1；驗證其他版本時需同步調整。候選 HTTP process 已關閉；重跑 HTTP 前需以隔離資料庫設定啟動服務。資料匯入 CLI 參數見各腳本 `--help`。

最後以 `candidate.dump` 還原至全新 `a11y_restore` 成功；還原庫 13 個 B-tree 檢查通過，[30 組路線重跑](a11y-route-restored-2026-10-04.json)的結果（排除耗時）與候選逐欄相同，模擬障礙結果也一致。[備份 SHA-256 與還原紀錄](a11y-candidate-backup-validation-2026-10-04.json)已保存。重新匯入坡道得到同樣的 18,438 筆配邊、23,281 個坡道節點。測試容器最後已停止，資料及備份保留；正式服務未切換。

最終 `git diff --check` 通過。沒有建立 commit，亦未改動其他任務的既有內容。

後續深入核實：見 [寬度、入口與坡道證據核實](a11y-reference-verification-2026-10-04.md)。新增官方入口資料將「50 m 內無參考點」由 Wheelroute 對照的151個縮小至TRTC入口對照的27個，但不是現地連通驗收；另找到39筆官方標記與圖內拓樸差異，以及人行道總寬不能當淨寬的量化證據。原始5,058條同坡道點邊也已按整條連續crossing分類，不應一律當成錯誤。
