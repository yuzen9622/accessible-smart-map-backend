# 前端遷移說明：刪除帳號（Mobile App）

App Store 要求提供註冊的 App 必須能在 App 內刪除帳號（issue #24）。本次新增一支端點，**既有 API 沒有任何變更。**

## 一、新增 API：`DELETE /api/v1/user`

需登入（`Authorization: Bearer <accessToken>`），不需 request body。Mobile 請帶 `X-Client: mobile`。

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
| 500 | 刪到一半失敗 | 此時所有 session 已登出；請使用者重新登入後再試一次即可完成 |

### 重新驗證規則

「剛登入」指的是**這個 session 的登入時間**在 5 分鐘內。用 refresh token 換新 access token **不算**重新登入（refresh 不會重設登入時間），所以收到 `REAUTH_REQUIRED` 時不要用 refresh 重試，必須走完整登入流程。

建議流程：確認對話框 → 呼叫 `DELETE /user` → 若回 `REAUTH_REQUIRED`，彈出登入 → 登入成功後自動再呼叫一次。

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

- **Sign in with Apple token 撤銷**：Apple 要求刪除帳號時呼叫其 REST API 撤銷使用者 token。後端目前只驗證 identity token，沒有保存 Apple 的 refresh token，也沒有設定 Apple client secret（.p8 金鑰），所以這一步**尚未實作**。要補的話，App 需要在刪除前送一次 Sign in with Apple 的 `authorizationCode`，後端換成 token 後再撤銷。
- 危險通報的照片隨匿名化後的通報一起保留。
