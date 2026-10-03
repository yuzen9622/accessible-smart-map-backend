# 前端遷移說明：刪除帳號（Mobile App）

App Store 要求提供註冊的 App 必須能在 App 內刪除帳號（issue #24）。本次新增一支端點，**既有 API 沒有任何變更。**

## 一、新增 API：`DELETE /api/v1/user`

需登入（`Authorization: Bearer <accessToken>`）。Mobile 請帶 `X-Client: mobile`。

Request body 只有 **Sign in with Apple 帳號**需要，其他帳號可以不送：

```jsonc
{ "appleAuthorizationCode": "c1a2b3..." } // 重新以 Apple 登入時拿到的 authorizationCode
```

```jsonc
// response 200
{ "ok": true, "code": 200, "message": "帳號已刪除" }

// response 403：目前的登入不是剛登入的
{ "ok": false, "code": 403, "message": "為保護帳號安全，請重新登入後再刪除帳號",
  "data": { "reason": "REAUTH_REQUIRED" } }
```

| 狀態 | 意義 | App 該做什麼 |
| --- | --- | --- |
| 200 | 已刪除 | 清掉本機的 access／refresh token 與快取，回到登入畫面。不必再呼叫 `/user/logout` 或 `DELETE /user/push-tokens`，後端都已處理 |
| 403 + `data.reason: "REAUTH_REQUIRED"` | 目前的 session 超過 5 分鐘前登入 | 請使用者重新登入（Google／Apple／密碼皆可），拿到新 token 後**立刻**再呼叫一次 |
| 403（沒有 `data.reason`） | token 無效 | 照一般未登入處理 |
| 404 | 帳號已不存在 | 當作已刪除 |
| 403 + `APPLE_AUTHORIZATION_REQUIRED` | Apple 帳號但沒帶 `appleAuthorizationCode` | 請使用者以 Apple 重新登入，把 `authorizationCode` 帶上再呼叫 |
| 403 + `APPLE_AUTHORIZATION_INVALID` | 授權碼無效、過期、已用過，或屬於另一個 Apple ID | 請使用者以**這個帳號綁定的** Apple ID 重新登入後再試 |
| 503 + `APPLE_REVOKE_UNAVAILABLE` | Apple 暫時連不上 | 稍後再試（需要重新拿一次 `authorizationCode`） |
| 500 | 刪到一半失敗 | 此時所有 session 已登出；請使用者重新登入後再試一次即可完成 |

所有 4xx／503 都**沒有刪除任何資料**。

### 重新驗證規則

「剛登入」指的是**這個 session 的登入時間**在 5 分鐘內。用 refresh token 換新 access token **不算**重新登入（refresh 不會重設登入時間），所以收到 `REAUTH_REQUIRED` 時不要用 refresh 重試，必須走完整登入流程。

建議流程：確認對話框 → 呼叫 `DELETE /user` → 若回 `REAUTH_REQUIRED`，彈出登入 → 登入成功後自動再呼叫一次。

### Sign in with Apple 帳號

App Store 規定刪除帳號時必須撤銷 Sign in with Apple 授權。後端會拿 `authorizationCode` 向 Apple 換 token，確認它屬於這個帳號綁定的 Apple ID 後撤銷授權，**成功後才開始刪資料**。

`authorizationCode` 單次有效、5 分鐘內過期，所以要在刪除前**當場**重新以 Apple 登入取得。這次登入同時滿足上面的「5 分鐘內登入」規則：

1. 使用者按「刪除帳號」並確認。
2. 呼叫 `AppleAuthentication.signInAsync()`，取得 `identityToken` 和 `authorizationCode`。
3. 用 `identityToken` 呼叫 `POST /user/auth/apple`，換到新的 access token（新 session）。
4. 用新 access token 呼叫 `DELETE /user`，body 帶 `{ "appleAuthorizationCode": authorizationCode }`。

`/user/auth/apple` 不會用掉 `authorizationCode`，所以同一次登入的授權碼可以留到第 4 步使用。帳號同時綁了 Google 和 Apple 時，仍然要走 Apple 這條流程。

## 二、刪除範圍

| 資料 | 處理方式 |
| --- | --- |
| 帳號本身、個人設定、無障礙檔案 | 刪除 |
| 所有登入 session（refresh token） | 刪除，所有裝置的 access／refresh token 立即失效 |
| 緊急聯絡人（含 LINE 綁定） | 刪除 |
| SOS 求救紀錄（含位置、時間軸、分享連結） | 刪除，分享頁連結隨即失效 |
| AI 記憶（含向量索引與快取） | 刪除 |
| 推播 token | 刪除 |
| 評論 | **刪除**（評論會公開顯示 `userId`，無法真正匿名；地點的平均分數與 AI 摘要會自動以剩餘評論重算） |
| 危險通報 | **保留並匿名化**：回報者 id、此人在其他通報上的確認／否認紀錄，以及（管理員）人工審核者 id，都改成同一個隨機代號 `deleted:<uuid>`。通報是給其他使用者的安全資訊，刪掉會讓現場危險消失；確認／否認次數維持不變 |
| LINE 綁定碼、驗證信／重設密碼權杖、排隊中的重設密碼信 | 刪除 |

同一個 Google／Apple 帳號或 email 之後再登入或註冊，會建立一個**全新的**空帳號。

## 三、已知限制

- 後端必須設定 `APPLE_TEAM_ID`、`APPLE_KEY_ID`、`APPLE_PRIVATE_KEY`（Sign in with Apple 的 .p8 金鑰）才會撤銷 Apple 授權；沒設定時刪除照常完成，只是略過撤銷並記錄錯誤 log。
- 危險通報的照片隨匿名化後的通報一起保留。
