# App 推播 API 與通知處理

本文件說明裝置註冊、SOS 狀態通知與危險通報審核通知的串接方式。HTTP API 的完整 request／response schema 見 `/docs` 或 `/api/v1/openapi.json`。

## 1. 註冊與註銷裝置

兩支 API 都需登入（`Authorization: Bearer <accessToken>`）。Mobile 模式呼叫不需要 CSRF 標頭。

### `POST /api/v1/user/push-tokens`

登入成功、取得推播權限後註冊；token 變動或切換語系時再次呼叫。重複註冊不會產生重複資料。

```json
{
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "platform": "ios",
  "locale": "zh-TW"
}
```

- `token`：`getExpoPushTokenAsync()` 回傳的 `data`。
- `platform`：`ios` 或 `android`。
- `locale`：選填，預設 `zh-TW`；支援 `zh-TW`、`en`，其餘語系回退 `zh-TW`。

Token 綁定的是這次登入的 session。改用另一個帳號登入並重新註冊，token 會轉給新帳號。Session 登出、過期或被撤銷後，後端不再向該 session 推播，因此**每次登入後都要重新註冊**。

### `DELETE /api/v1/user/push-tokens`

登出前呼叫，必須在 `POST /api/v1/user/logout` 之前：

```json
{ "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" }
```

此操作冪等；token 不存在時仍回 HTTP 200，`data.removed` 為 `false`。即使漏掉此呼叫，session 登出後仍不再收到推播。

## 2. SOS 狀態通知

通知由家人的操作觸發；求救者自己的操作不觸發這類推播。

| `data.event` | 時機 |
| --- | --- |
| `acknowledged` | 家人第一次確認收到通知 |
| `claimed` | 家人承接事件 |
| `status_update` | 家人更新處理狀態或留言 |
| `resolved` | 家人解除事件 |

```json
{
  "type": "sos_update",
  "event": "claimed",
  "sessionId": "66b0abc123def4567890abcd",
  "status": "active",
  "handlingStatus": "claimed"
}
```

`status` 為 `active` 或 `resolved`；`handlingStatus` 與 SOS 快照相同。點開通知後，以 `sessionId` 呼叫 `GET /api/v1/sos/sessions/:id` 取得最新快照，再依事件狀態接上 SSE。完整狀態以 API 為準，不以通知內文為準。

## 3. 危險通報審核通知

```json
{
  "type": "hazard_review",
  "reportId": "<report ObjectId>",
  "notificationId": "<report ObjectId>:<revision>"
}
```

- 用 `notificationId` 去除重複處理。
- 冷啟動或背景點擊時，等待登入狀態完成，再導向「我的通報」。切換帳號不可沿用舊帳號的通報快取。
- 以已登入的 `GET /api/v1/a11y/reports/mine`（必要時翻頁）核對通報屬於目前使用者，並讀取最新 `aiReview`、`manualReview`、`status`。若不在名單，回列表並提示重新整理。
- 公開的 `GET /api/v1/a11y/reports/:id` 不能代替「我的通報」歸屬檢查。
- 照片使用需要登入及授權的 `GET /api/v1/a11y/reports/:id/photo`，不可從通知拼接 Storage URL。

通知只使用受控的 zh-TW／en 文案，不包含照片 URL、精確位置、描述、姓名、管理員 note 或 AI 內部 reason。照片審核支持通報不代表已在現地獨立核實；照片未支持通報也不代表使用者說謊。詳情應依 API 最新審核結果呈現。

## 4. 投遞界線

- 通知可能重複或延遲到達；審核結果覆寫後，舊通知仍可能在途。通知只是提醒，App 必須重新取得最新資料。
- 審核通知有效期限為「結果寫入後 24 小時」與通報 `expiredAt` 的較早者；不保證期限內一定成功投遞，也不補發所有歷史審核結果。
- `sent` 僅代表取得 Expo 接受 ticket，不代表手機收到、顯示或使用者已讀；本服務不承諾端到端 exactly-once。
- 登出、session 過期或帳號刪除後，不再啟動新的有效裝置發送；已被外部供應商接受的通知無法撤回。
- Android 使用預設 notification channel，通知使用預設 sound 與 high priority。

## 5. Expo 回執追蹤與失敗處理

後端會為 SOS 與危險通報的 App 推播保存追蹤工作，背景查詢 Expo receipt；App 不需要另外呼叫查詢 API。

- **Ticket 接受**：Expo 已收下通知。若 `status=ok` 但 ticket ID 缺漏或格式不正確，仍記錄接受結果，僅將回執追蹤標為結果未知，不因此重送。
- **Receipt 成功**：代表 Apple APNs／Google FCM 已接受，仍不代表手機顯示或使用者已讀。
- **Receipt 失敗**：保存受控錯誤碼；`DeviceNotRegistered` 只清理發送時的註冊版本。同帳號、同 session 重新註冊也會產生新版本，舊回執不會誤刪它。
- **結果未知**：查詢次數／期限耗盡仍未取得回執，或發送後 ticket 未能保存。不能解讀為確定未送達。

回執 worker **不重送通知**。查詢逾時、HTTP 429／5xx、格式異常或缺少回執只會觸發有期限的查詢重試；`MessageRateExceeded` 也不在此層自動重送。發送當下或 receipt 的失效 token 清理若遇到暫時性資料庫錯誤，會留下 `cleanup_pending` 由 worker 重試，不妨礙其他裝置繼續發送。

### 自架服務維運

設定唯一來源為 `src/constants/push.ts` 的 `PUSH_RECEIPT`，不需新增必要環境變數；receipt HTTP 沿用既有 `EXPO_ACCESS_TOKEN`（有設定才附上）。

| 項目 | 行為 |
| --- | --- |
| 首次查詢 | ticket 接受後約 15 分鐘 |
| 輪詢／批次 | Mongo 連線後啟動，每分鐘輪詢；每 pass 最多 20 筆、每組並行 4 筆、每 tick 最多 5 pass |
| 查詢退避 | 5 分鐘起指數退避，上限 1 小時，最多 8 次失敗／缺失 |
| 追蹤期限 | reservation 建立後最多 23 小時，次數上限可能先結束 |
| 中斷恢復 | 持久化工作與 10 分鐘租約；無 ticket 的 reservation 超過 5 分鐘轉為未知；舊租約不能寫回 |
| 停止服務 | 停止新輪詢、等待當前有 timeout 的操作，歸還未處理的 claim |
| 清理 | 建立後 24 小時到期，由 worker 與 Mongo TTL 清除；TTL 非精確即時刪除 |

可監控 `[push-receipt] pass outcomes` 的分類摘要、`Expo credential error`、`record processing failed` 與 `[user.push] receipt tracking failed`。摘要不含帳號、ticket ID、原始 token 或 provider message；分類計數是處理觀測，不是唯一通知數。外部日誌收集與告警規則仍需在自架環境設定。

`InvalidCredentials`／`MismatchSenderId` 應檢查 Expo、APNs／FCM 憑證或 Firebase 專案配置，不能批次刪除使用者 token。`MessageTooBig` 應調整通知大小；`MessageRateExceeded` 應檢查發送頻率。

追蹤紀錄僅保存帳號／註冊識別、ticket、時間、狀態及受控錯誤碼，不複製原始 token、通知內文、照片或位置；刪帳及刪帳補掃也會清除。詳見 [隱私資料保存期限](../PRIVACY_DATA_RETENTION.md)。外部 HTTP 與 Mongo checkpoint 不是跨系統交易，程序在兩者之間中斷仍可能產生既有的不確定或重複發送窗口。

供應商投遞語意見 [Expo 官方文件](https://docs.expo.dev/push-notifications/sending-notifications/)。
