# SOS 通知與 CSV 快照匯入修復

日期：2026-10-10。對應 [產品稽核](../audit/2026-10-10-product-grade-audit.md) 的 P1-01、P1-04；原稽核證據保留為修復前紀錄。

## SOS 行為與 API 契約

- 掛載路徑維持 `/api/v1/sos`。`POST /api/v1/sos/sessions` 建立仍為 201，沿用 active session 仍為 200；成功代表求助紀錄建立或存在。訊息改為「已建立求救」，不再保證通知已送出。
- 回應新增 `notificationStatus`：`queued`（待送或傳送中）、`accepted`（LINE 接受）、`failed`（本次失敗）、`skipped`（沒有已綁定聯絡人）。`notifiedCount` 只讀取持久化的接受人數，失敗為 0，不以聯絡人數推算。
- `GET /api/v1/sos/sessions/:id` 與 `/stream` 快照同樣包含通知狀態、人數；尚未建立通知狀態的舊紀錄回報 `unknown`。不公開收件人快照、retry key 或 claim 資訊。
- 新求助的 `handlingStatus` 為 `pending`；LINE 接受後才變成 `notified` 並新增 timeline 的 `notified` 事件。通知完成不會覆蓋家人已更新的 acknowledged／claimed／en_route 等狀態。
- 通知狀態與 session 一起寫入 Mongo。HTTP 重試與背景 worker 透過原子 claim 共用 lease 與 fencing，固定收件人、內容及 UUID retry key；同一通知已接受後不再發送。無須新增環境變數。
- worker 在 Mongo 連線後啟動，每 5 秒取工作，單批最多 25 筆；每次 LINE 呼叫最多等候 10 秒，lease 30 秒。失敗採 30 秒起的指數退避；HTTP 再次建立可立即重試已釋放的失敗工作。最多 10 次，23 小時後停止使用原 key，已 resolved 的 session 不再取得新的發送 claim。
- LINE 409 視為該 key 已接受；接受不等於使用者收到或已讀。依據 [LINE 重試契約](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)，相同 key 的收件人及內容不得改變，key 有效期為 24 小時。
- 舊 active session 沒有可證明的通知結果或 retry key，只有再次呼叫建立時才初始化新通知並嘗試送出；可能重複舊版已成功送出的通知，無法追溯保證舊版 exactly-once。背景 worker 不自動回填歷史紀錄。

前端應呈現 `notificationStatus`，並支援 `handlingStatus=pending`；本次僅修改後端，不含前端／裝置驗收。

## 快照匯入

`pnpm import:bathrooms` 與 `pnpm import:a11y-metro` 先檢查 CSV 標頭、解析結果非空；既有 row parser 的無效資料略過規則仍保留。浴廁改用共用 CSV parser，並拒絕非有限或超出地理範圍的座標。

所有有效資料先以每批 500 筆寫入唯一 staging collection，經 Mongoose 驗證、總筆數確認、schema 索引及現有額外索引建立成功後，才以同資料庫 `renameCollection`／`dropTarget` 切換。空輸入、全數無效、schema 驗證失敗、批次寫入失敗或索引建立失敗，都不會先刪除正式資料。失敗回傳非零結束碼並清理暫存集合，所有路徑關閉資料庫連線。

執行帳號需要建立集合、建立索引及 rename/dropTarget 權限；此次沒有修改正式環境權限，也未執行正式匯入。程序被強制終止時可能留下具唯一名稱的 staging collection，但不會先清空正式集合。此流程用於兩個完整快照來源，不支援與其他寫入者同時更新同一正式集合。

## 修改檔案

| 檔案 | 用途 |
| --- | --- |
| `src/adapters/line.adapter.ts` | 回報真正接受結果、timeout 與穩定 retry key／409 處理 |
| `src/constants/messages.ts`、`src/constants/sos.ts` | 修正成功文字，集中 worker／retry 參數 |
| `src/types/index.d.ts`、`src/model/sos-session.model.ts` | 持久化初始通知、pending handling 狀態與索引 |
| `src/modules/sos/sos.repository.ts` | 原子 claim、fencing、接受及失敗狀態、legacy 初始化 |
| `src/modules/sos/sos-notification.service.ts` | 固定收件人與內容、通知嘗試、工作消費 |
| `src/modules/sos/sos-notification.worker.ts`、`src/server.ts` | worker 啟動、輪詢與關機停止排程 |
| `src/modules/sos/sos.service.ts` | 建立／重試沿用通知狀態與真實人數 |
| `src/modules/sos/sos-events.ts`、`src/modules/sos/sos.schema.ts` | GET／SSE／OpenAPI 通知狀態契約 |
| `src/modules/sos/sos-notification.integration.test.ts`、`src/modules/sos/sos.routes.test.ts` | 通知故障、競態、程序重啟與 HTTP 回應回歸測試 |
| `src/scripts/import-bathrooms.ts`、`src/scripts/import-a11y-metro.ts` | 標頭與非空檢查、使用安全替換、非零失敗與斷線 |
| `src/scripts/replace-snapshot.ts` | staging 寫入、驗證、索引及切換 |
| `src/scripts/snapshot-import.integration.test.ts` | 實際 CLI＋隔離 Mongo 的故障與成功測試 |
| 本文件、原稽核報告 | 修復與驗證紀錄 |

## 驗證

- `pnpm build`：通過，含 architecture boundary check。
- `pnpm test`：255 files passed、7 skipped；3,569 tests passed、17 skipped。
- 最後相關回歸測試：8 files／115 tests 通過（SOS、LINE adapter、retention、metro parser、snapshot CLI）。
- 新增案例使用 harness 建立的隔離 Mongo；只替換 LINE SDK multicast，不替換 service／repository。涵蓋首次失敗後補送、重複與併發建立、舊 session、去重人數、後續 handling 狀態不倒退、timeout、409、lease 接管、次數／期限／resolved 阻擋。
- 程序中斷測試以獨立 Node 程序在 multicast 後、資料庫接受寫入前退出，再由新 Node 程序接手；兩次 request 與 retry key 完全相同。另測 LINE 409 確認既有接受結果及 stale worker 不得覆寫。
- 兩支匯入 CLI 在隔離 Mongo 驗證空檔、只有標頭、全數無效、錯誤標頭、第二批 insert 故障（Mongo failCommand）均非零退出且舊文件原樣保留；有效 501 筆多批快照完整切換並保留 geo／額外索引。
- 使用 repo 的原始 CSV 實跑 CLI：浴廁 4,564 筆、捷運 190 筆，均成功匯入隔離資料庫。
- `pnpm typecheck`：仍有原稽核 P1-09 的 34 個錯誤，集中於未修改的 `hazard-report.ai-job.repository.integration.test.ts`、`retention.integration.test.ts`；本次變更無新增型別診斷。
- 未連線正式資料庫或真實 LINE 發送；未部署、未做裝置收訊或正式 Mongo 權限驗證。此次為主代理實作與自我檢查，沒有獨立代理審查。
