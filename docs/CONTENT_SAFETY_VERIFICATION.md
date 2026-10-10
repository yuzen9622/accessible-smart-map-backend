# 內容檢舉：部署環境與真實郵件驗證

驗證日期：2026-10-10（Asia/Taipei）。使用者已授權真實 Gmail 寄信測試。

## 執行環境

- 本機 Docker `taipei-backend`，HTTP `127.0.0.1:8000`。
- 容器內 server、content-safety repository／worker／schema 的編譯內容與本機 dist 雜湊相同。
- health 200；OpenAPI 包含檢舉、封鎖、案件處分與安全事實路由。
- 未登入的檢舉、封鎖與管理操作均 403，無效 token 403；安全事實查詢有效參數 200、無效座標 400。安全查詢此次為空集合，不能據此證明實際有資料時的欄位過濾。
- 必要唯一索引與 TTL 已建立。
- 容器已載入正確 CONTENT_REPORT_TEAM_EMAIL，RESEND_API_KEY／RESEND_FROM 皆存在；未輸出秘密值。

## 舊版實際環境阻擋（已在原始碼修正，待重新部署驗收）

MongoDB hello 顯示無 replica set、非 mongos。僅讀取的交易探測回傳 code 20 / IllegalOperation：

```
Transaction numbers are only allowed on a replica set member or mongos
```

先前執行中的版本依賴多文件交易，因此當時完整提交流程不能通過。該次環境驗證沒有更動資料庫拓樸、重啟服務或寫入實際案件；當時隔離 MongoMemoryReplSet 20／20 tests 通過，也不能取代部署資料庫的能力。此段保留為歷史記錄，最新程式結果見下方。

## 真實郵件投遞

從正在執行的容器呼叫已編譯的 `reportMailPayload` 與 `sendEmail`，採真實 Resend API、真實部署寄件設定；兩個角色均寄至使用者指定的 `nutcaiedlab@gmail.com`。測試資料不含使用者原文，未建立假檢舉案件。主旨及內文加上「寄信驗證」標示。

這驗證的是實際郵件模板／adapter／provider／Gmail 伺服器投遞，並未經過 HTTP 檢舉提交、持久化寄信工作或背景 worker。

測試關聯編號：`26d792d46b410a81d170bf08`。寄出時間：`2026-10-10T14:49:46.160Z`。

| 角色 | Resend email ID | 查詢事件 | 查詢時間（UTC） |
| --- | --- | --- | --- |
| team | `01a1264a-9d7b-7808-9fa1-ac1907cfa847` | `delivered` | 2026-10-10T14:49:58.690Z |
| reporter | `01a1264a-a2ef-7dca-ae01-4542e8b1b599` | `delivered` | 2026-10-10T14:50:00.088Z |

兩封 POST 回應均 200，之後 GET /emails/:id 均回報 delivered。
依 [Resend 事件定義](https://resend.com/docs/webhooks/event-types)，delivered 表示收件端郵件伺服器已接受，並不保證位於主要收件匣。

使用者已於本次對話回覆「有」，確認收到兩封真實測試信。未另外確認收件匣分類；我沒有 Gmail 信箱存取權，也未讀取或操作其他信件。後續已依使用者要求調整為 standalone 單文件原子寫入與恢復流程；新程式尚待部署後驗收完整 HTTP 流程。


## Standalone 調整後的驗證（2026-10-10 23:07 Asia/Taipei）

- `pnpm exec vitest run ... --maxWorkers=2`：相關12個測試檔、167項測試全數通過（涵蓋 content-safety、review、hazard HTTP／service／visibility、account deletion、auth、email adapter）。
- content-safety 35項使用 **MongoMemoryServer standalone**，並明確確認 hello 無 setName；不使用 replica set。
- 獨立唯讀審查也實跑35／35通過，發現的撤權競態、延遲配額與背景錯誤記錄問題均已修正。
- `pnpm build` 與架構檢查通過；新增模組 ESLint 零警告。
- 完整 lint 零錯誤、943項既有警告；完整測試型別檢查仍為35项既有錯誤，與乾淨 HEAD 基準的錯誤內容及行號完全一致，沒有新增。
- 新增驗證項目：配額ACK遺失、配額預留後案件寫入失敗、25個不同案件同時提交的20件上限、跨小時恢復、到期bucket、處分ACK遺失、稽核補寫失敗後反向處分、同版本相反指令競爭、receipt清理失敗、過期案件、不公開內部恢復資料。
- 本次改動未寄出額外郵件、未改 `.env`、未遷移資料或重啟現有容器。**原始碼與本機 dist 已更新，執行中的 Docker 仍需重新 build／部署後，再驗收完整 HTTP 檢舉流程。** Gmail兩封實際收件已由使用者於前一階段確認；本次測試隔離外部寄信。


## 使用者再次 rebuild 後的部署查核（2026-10-10 23:13 Asia/Taipei）

- `taipei-backend` 已重新建立／啟動。容器內 server、admission repository、decision repository、worker、schema、content-report model、content-moderation schema 等7個編譯檔 SHA-256 與最新本機 dist 相同。
- 實際資料庫仍是 standalone；連線正常。新增 admission／decision 恢復索引、案件去重索引、封鎖唯一索引與 TTL 均存在。
- HTTP health 200；OpenAPI 已顯示 standalone 處分契約及503。未登入的檢舉／封鎖／管理處分403；安全事實查詢200、錯誤座標400。此次安全查詢回空集合，不據此推論真實內容過濾已做端到端驗證。
- 團隊收件設定與 Resend 設定已載入；未輸出秘密值。近10分鐘容器日誌中 content-safety 錯誤標記與交易錯誤均為0，不等同已執行並驗證所有工作。
- **網頁容器尚未更新此功能**：`taipei-accessible-web` 仍是先前執行中的版本；掃描其200個 `.next/static` 與 `.next/server` JS／JSON編譯檔，找不到新客戶端使用的 `/content-reports` 或 `/user/blocks` 路由字串。需先更新網頁才能驗收其新UI。
- 尚待真實登入流程驗收：由帳號B檢舉帳號A的評論／公開障礙回報、收到案件編號與兩封信；重送相同案件不重寄；App／Web封鎖與設定解除跨端一致；切換帳號不顯示舊帳號資料。前一階段Gmail收件測試僅直接呼叫寄信程式，不能取代完整提交鏈路。
- 此次只做部署查核與唯讀API／索引查詢；未建立實際測試帳號／案件、未寄額外信件、未下架內容、未重啟服務。隔離環境35項standalone恢復／競態測試及167項回歸結果仍見前節，未為相同程式重複執行。
