# 前端遷移說明：推播 token 註冊與 SOS 狀態推播（Mobile App）

App 進入背景後 SOS 的 SSE 串流會斷。本次後端新增 Expo 推播：家人在 LINE 端對求救事件的每個動作都會推播給求救者本人的裝置。**既有 API 沒有任何變更，只新增兩支端點。**

## 一、新增 API

兩支都需登入（`Authorization: Bearer <accessToken>`）。Mobile 模式呼叫不需要 CSRF 標頭。

### 1. `POST /api/v1/user/push-tokens`：註冊裝置

登入成功、並取得推播權限後呼叫。token 變動時（`addPushTokenListener`）或切換語系時再呼叫一次即可，重複註冊不會產生重複資料。

```jsonc
// request
{
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", // getExpoPushTokenAsync() 的 data
  "platform": "ios", // "ios" | "android"
  "locale": "zh-TW" // 選填，預設 zh-TW；目前支援 zh-TW、en，其餘語系回退 zh-TW
}
// response 200
{ "ok": true, "code": 200, "message": "已註冊推播裝置",
  "data": { "token": "ExponentPushToken[...]", "platform": "ios", "locale": "zh-TW" } }
```

token 綁定的是**這次登入的 session**，不是帳號本身：

- 同一台裝置改用另一個帳號登入後重新註冊，token 會轉給新帳號，舊帳號就收不到了。
- 這個 session 登出、過期或被撤銷（例如改密碼）之後，後端不會再推播，並會清掉該 token。所以**每次登入後都要重新註冊一次**。

### 2. `DELETE /api/v1/user/push-tokens`：註銷裝置

登出時呼叫，而且必須在 `POST /user/logout` **之前**（登出後 access token 就失效了）。

```jsonc
// request
{ "token": "ExponentPushToken[...]" }
// response 200（冪等：token 不存在時同樣回 200，removed 為 false）
{ "ok": true, "code": 200, "message": "已註銷推播裝置", "data": { "removed": true } }
```

就算這個呼叫失敗或被漏掉，登出後該 session 的 token 也不會再收到推播。

## 二、推播內容

觸發推播的事件（全部由家人觸發，求救者自己的操作不會推播）：

| `data.event`    | 時機                              | zh-TW 內文範例               |
| --------------- | --------------------------------- | ---------------------------- |
| `acknowledged`  | 家人第一次確認收到通知            | 媽媽已收到你的求救通知       |
| `claimed`       | 家人承接事件                      | 媽媽已承接你的求救，正在處理 |
| `status_update` | 家人更新處理狀態或留言            | 媽媽正在前往你的位置／媽媽已抵達你的位置／媽媽：五分鐘到 |
| `resolved`      | 家人解除事件                      | 媽媽已解除這次求救           |

標題固定為「SOS 求救狀態更新」（en：`SOS status update`），並設定 `sound: "default"`、`priority: "high"`。

通知的 `data` payload：

```jsonc
{
  "type": "sos_update",
  "event": "claimed", // 上表之一
  "sessionId": "66b0abc123def4567890abcd",
  "status": "active", // "active" | "resolved"
  "handlingStatus": "claimed" // 與 SosSnapshot.handlingStatus 相同
}
```

建議做法：點開通知後用 `sessionId` 打 `GET /api/v1/sos/sessions/:id` 取得完整快照，再重新接上 SSE。推播只是提醒，完整狀態一律以快照為準。

## 三、已知限制

- 目前只處理 Expo 送出時當下回傳的 `DeviceNotRegistered` 錯誤，還沒有做 push receipt 的延遲查詢，所以有少數失效 token 會晚一次才被清掉。
- 通報審核結果現在由 durable worker 推送，使用 `data.type=hazard_review`、`reportId` 與 `notificationId`；請依[審核通知串接與可靠性說明](reports/hazard-review-notifications.md)接上通知點擊及「我的通報」最新狀態查詢。
- Android 使用預設 notification channel；如果 App 要用自訂 channel，後端再補 `channelId`。
