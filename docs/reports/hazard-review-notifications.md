# 危險通報審核結果 App 推播

本項在既有 Expo 推播入口新增危險通報審核通知，審核結果與待送通知在同一份 HazardReport 的原子更新落地。僅處理此項；未實作 Expo 延遲 receipt、LINE、web push 或低地板資訊。使用者於 2026-10-10 審閱通過並授權提交、合併至 main；另明確要求暫停第二項與第三項，待較高優先工作處理。

## 行為與觸發表

| 寫入入口／狀態 | 通知語意 | 去重與限制 |
| --- | --- | --- |
| `finalizeAiReview`: supported → verified | 照片支持通報，不宣稱現地獨立核實 | 同一 AI lease 只能落地一次 |
| `finalizeAiReview`: needs_evidence → pending | 需要更多佐證 | 這是已完成的照片審核，不當成仍在處理 |
| `finalizeAiReview`: unsupported → rejected | 目前照片未能支持通報 | 不宣稱通報虛假、說謊或事實錯誤；不外傳 safety 原因 |
| `failAiJob`、`convergeStuckAiJobs`: failed，維持 pending | 自動審核未能完成 | 與內容不通過分開；維護重跑不再新增 |
| `setManualReview`: verified／rejected | 已通過／未通過人工審核 | 同一人工 decision 且相同 status 不新建事件；僅改 note／reviewer 不通知 |
| 人工覆寫 AI 結果或變更人工 decision | 通知最新人工結果 | 版本遞增，未送的舊事件及 lease 被取代 |
| `persistLegacyAiResult`: verified／suspicious／rejected | 結果更新／進一步審核／照片未通過 | 只在本次寫入造成 verdict 變化時排程；此入口目前僅供 frozen v1 harness，production 走 v2 |
| legacy skipped | 不建立完成通知 | 若覆寫先前結果，撤銷其待送通知並保留版本，避免舊事件續送 |
| queued／processing、AI 重試、投票／合併、expiry／cancel、私有 intake／cleanup | 不通知 | 不把投票或生命週期清理當作審核 |

通知僅排程於有效期限內、reporterId 為登入帳號 ID 的新寫入。沒有掃描既有 completed／verified 歷史資料補建事件；部署前已存在但部署後才完成的 AI 工作，屬於新結果，會正常排程。匿名、刪帳假名和 retention 假名不建立新通知。

## 落地、重試、併發與隱私

- `reviewNotification` 是 `select:false` 的內嵌最新事件；包含版本、受控結果、狀態、期限、lease、重試時間及已接受裝置的 SHA-256 token digest。不複製 reporter、照片、座標、審核文字或原始 token，whitelist view 不輸出此欄位，retention scrub 會移除整個事件。
- 狀態更新前，在同一 Mongo pipeline 建立事件，沒有「審核成功但排程失敗」的雙寫間隙。人工同結果重複／並行操作保留原事件和已送紀錄；新結果取代舊事件。
- server 在 Mongo 連線成功後啟動 worker，每 5 秒處理最多 10 筆，startup 立即掃描；單程序 single-flight，多程序靠原子 claim 與 60 秒 lease。每個装置發送前續租；SIGTERM／SIGINT 停止新輪詢並等待當前批次。
- 每次 claim 使用新 token，所有續租／成功紀錄／完成／重試都核對事件版本、結果、lease、當前 reporter、未 scrub、通報與通知未過期。舊 worker 無法覆寫新結果。
- 透過既有 `sendPushToUser` 的可選 durable 模式送出；未提供此選項的既有呼叫保留原 `{ sent, removed }` 與 best-effort 行為。durable 模式逐裝置送出，成功 ticket 逐筆確認進 Mongo，重試略過已接受裝置。只確認當下 ticket，沒有 receipt 追蹤。
- 每一裝置送出前重新查 User、DeletedAccount 刪除標記、仍有效且未 revoked 的 AuthSession，以及 token 當前帳號/session 歸屬。刪帳開始即停送，已匿名化 reporter 無法通過事件 fence；帳號不存在但殘留 token/session 也不應送。
- 無 token、無有效 session、刪除中的帳號或全裝置不可用 → `skipped` 結案，不等待未來登入補發；`DeviceNotRegistered` 條件刪 token。資料庫讀取失敗與 Expo 其他失敗 → `pending` 重試，15 秒指數退避，上限 15 分鐘，直到有效期限。
- 通知有效期限為「結果寫入後 24 小時」與 `expiredAt` 較早者。過期、scrub、匿名化或 status=expired 不送；外部 message 的 `ttl` 同步限制剩餘秒數，避免 provider 預設長期保留。新增資料庫操作均設定 server maxTimeMS 與 driver timeoutMS；Expo 延用 10 秒 HTTP timeout。

可靠性界線：這是 Mongo 內原子排程、最新結果收斂和具去重紀錄的有期限重試，**不是端到端 exactly-once**。Expo 已接受但程序在 Mongo checkpoint 前中斷／寫入失敗，或 HTTP 回應遺失，仍可能重送；測試刻意注入此窗口並確認重送沿用相同 `notificationId`。已成功 checkpoint 的裝置不因另一台裝置失敗而重送。Mongo 持久性依部署 write concern；未改全域 DB 設定。

最後一次帳號／狀態檢查與外部 HTTP 之間不是跨系統交易；極短競態內可能已在送出，已被 Expo 接受的通知無法撤回。結果覆寫後不再啟動舊事件的新裝置發送，但已在途通知可能稍後到达；App 必須重新取得最新資料。永久設定錯誤也受期限內退避重試，不保證成功；`sent` 僅指已獲 Expo ticket 接受，不代表手機收到或顯示。[Expo 官方格式與投遞界線](https://docs.expo.dev/push-notifications/sending-notifications/)

## Payload 與前端串接

```json
{
  "type": "hazard_review",
  "reportId": "<report ObjectId>",
  "notificationId": "<report ObjectId>:<revision>"
}
```

鎖定畫面只使用 `constants/hazard-review-notification.ts` 的受控 zh-TW／en 文案；不包含照片 URL、精確位置、描述、姓名、管理員 note 或 AI 內部 reason。語言依既有裝置 token.locale，en-US/en-GB 會對應 en，其餘依既有 pickLocale 回退規則。維持預設 sound、high priority 和預設 Android channel。

App 所需工作：

1. 沿用登入後 `POST /api/v1/user/push-tokens`，每次登入重新註冊，語系改變時更新 locale，登出前 DELETE token。
2. notification handler 辨識 `type=hazard_review`，用 `notificationId` 去除重複處理。冷啟動／背景點擊等待登入狀態完成，再導向「我的通報」。切換帳號不可沿用舊帳號的通報快取。
3. 以已登入的 `GET /api/v1/a11y/reports/mine`（必要時翻頁）核對此 ID 屬於當前使用者並讀取目前審核資料；若已不在名單，回列表並提示重新整理。既有 `GET /api/v1/a11y/reports/:id` 是公開詳情，不能用它代替「我的通報」歸屬檢查。
4. 詳情以 API 最新 aiReview/manualReview/status 為準。照片仍走需要登入且 server-side 授權的 `GET /api/v1/a11y/reports/:id/photo`，不可由通知拼 Storage URL。

本次沒有新增／變更 HTTP endpoint mount 或 response schema；原人工操作仍是 `POST /api/v1/a11y/reports/:id/review`。未新增必要 env。推播 worker 與 AI worker 暫停開關獨立，AI claims 暫停時已落地通知仍可送。

## 驗證紀錄

所有 DB integration 使用 repository 專用 mongodb-memory-server、隨機 test DB；未使用正式 DB、未讀正式 env。新增測試只 mock fetch（Expo HTTP），真實執行結果落地、outbox、claim、user push service、token/session/user/deletion repository、Expo adapter 和 Mongo failCommand。

- `pnpm install --frozen-lockfile`：成功，lockfile 無變動。
- `pnpm build`：通過，含 `lint:arch`。
- `pnpm exec vitest run src/modules/hazard-report src/modules/user/user.push.service.test.ts src/modules/user/user.push-token.repository.integration.test.ts src/modules/user/user.push-tokens.routes.test.ts src/modules/user/user.account.service.integration.test.ts src/modules/retention/retention.integration.test.ts src/adapters/expo-push.adapter.test.ts`：最終 24 files／304 tests 通過。
- 新增 DB fault 與 legacy override 反例後，聚焦 4 files／43 tests 通過。
- 本次修改檔案的 `pnpm exec prettier --check ...` 與 `git diff --check`：通過。
- `pnpm typecheck`：失敗，hazard AI integration 13 項與 retention integration 21 項既有錯誤；主控在原始 HEAD `f9737e4` 隔離副本執行相同指令也重現，未修改這些測試。`pnpm exec tsc -p tsconfig.hazard-review-check.tmp.json --noEmit`：通過，此暫存 config 繼承原 typecheck 設定、納入 production source 與本次新整合測試（連同其 imports），未納入其他舊測試，驗證後已移除。
- 最初 `pnpm test -- ...` 未按預期限制測試範圍，已中止，未當成驗收證據；後续採 `pnpm exec vitest run` 明確指定檔案。

覆蓋：AI 三種結果與最終 technical failure、維護收斂、legacy 結果、人工反轉及重複操作、雙 worker、過期 lease／新 worker 回收、部分成功、HTTP 失敗、Mongo result commit／token lookup／accepted checkpoint 故障、刪帳／匿名／revoked／session 過期／token 轉綁、無 token、過期／scrub、雙語、private projection、最小 payload。重啟測試以資料庫留下中斷 claim 並啟動新 worker 模擬；未宣稱已做部署進程 kill 測試。

尚未驗證：iOS／Android 真機、背景／冷啟動點擊、App 實際 notification handler 與重新登入流程、實際 provider credentials、正式部署多實例及 Mongo failover。Expo 延遲 receipt 屬下一項，必須先經使用者審閱本項並由主控 commit 後才可開始。

## 修改檔案與用途

主控獨立驗收（2026-10-10）：已重新執行 `pnpm build`（含架構檢查）與上述相關測試，24 個檔案、304 項全部通過；閱讀結果寫入、通知 CAS、逐裝置發送、帳號/session 重查與伺服器啟停程式。另在原始 `f9737e4` 的隔離副本重跑完整 `pnpm typecheck`，確認與本分支相同的 34 項既有測試錯誤，本次未新增錯誤。

主控在另一份暫存副本故意移除「已接受裝置略過」、「有效帳號/session 檢查」、「相同人工結果不重排」三項防護，對應三項測試均因預期行為被破壞而失敗；正式工作樹未套用這些突變。驗證符合 backend-testing 技能要求：保留真實 Mongo 狀態轉移，只模擬外部 Expo HTTP。工作目前停在使用者審閱關卡，未 commit，第二／第三項 session 未啟動；手機實機與部署限制仍如上節。

| 檔案 | 用途 |
| --- | --- |
| `src/types/hazard-review-notification.ts`, `src/types/index.d.ts` | 私有通知資料契約 |
| `src/model/hazard-report.model.ts` | 內嵌 outbox schema 與索引 |
| `src/constants/hazard-review-notification.ts`, `src/constants/push.ts` | worker 常數、受控雙語文案、event type |
| `src/modules/hazard-report/hazard-report.notification-stages.ts` | 共用原子 enqueue pipeline |
| `src/modules/hazard-report/hazard-report.ai-job.repository.ts` | AI 結果／最終失敗同筆排程 |
| `src/modules/hazard-report/hazard-report.ai-legacy.repository.ts` | legacy 結果變更及 skipped 撤銷 |
| `src/modules/hazard-report/hazard-report.repository.ts` | 人工變更去重與 retention scrub |
| `src/modules/hazard-report/hazard-report.notification.repository.ts` | claim、lease、逐裝置 checkpoint、到期與重試 CAS |
| `src/modules/hazard-report/hazard-report.notification.service.ts` | 通知協調與 worker 啟停 |
| `src/modules/user/user.push.service.ts` | 相容的 durable 投遞選项 |
| `src/modules/user/user.push-delivery.repository.ts` | 有期限的帳號／session／registration 重查 |
| `src/modules/user/user.push-token.repository.ts` | durable 刪除 token 的可選 DB timeout |
| `src/adapters/expo-push.adapter.ts` | message ttl 型別 |
| `src/server.ts` | worker 啟動／關閉 wiring |
| `src/modules/hazard-report/hazard-report.notification.integration.test.ts` | Mongo 主流程及反例 |
| `docs/FRONTEND_MIGRATION_PUSH_TOKENS.md`, 本報告 | 串接入口與行為、驗證、限制 |
