# 前端遷移說明：Email/密碼登入註冊

本次後端新增帳密註冊與登入，並修掉舊 Google 登入「後端不驗證身分」的漏洞。**這是破壞性變更**：`POST /api/v1/user/login` 與 `POST /api/v1/user/token` 都已移除，Google 登入改為傳 ID token。

貫穿整套設計的原則是「**誰控制信箱，誰擁有帳號**」。本地帳密帳號可透過驗證信或密碼重設信證明控制權；Google-only 帳號則由後端驗證 Google ID token。Google-only 帳號不能透過公開的忘記密碼流程新增本站密碼。

---

## 一、移除的端點（必須改）

| 舊端點                                                               | 狀態       | 改用                                                         |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `POST /api/v1/user/login`（body `{name, email, avatar, client_id}`） | **已移除** | `POST /api/v1/user/auth/google`，body 改成 `{ idToken }`     |
| `POST /api/v1/user/token`（body `{token}`）                          | **已移除** | `POST /api/v1/user/refresh`（讀 httpOnly cookie，不需 body） |

`POST /user/login` 之所以要移除，是因為它直接相信前端傳來的 `email` 與 `client_id`，任何人都能用別人的 email 換到該帳號的 access token。現在身分只取自後端驗證過的 Google ID token payload。

### Google 登入怎麼改

前端原本應該已經有 Google Sign-In 流程。改動只在於：**不要再自己解 token 取 email/sub 傳給後端，直接把 ID token 原封不動傳過去**。

```ts
// Google Identity Services 的 callback 會給你 response.credential，那就是 ID token
const res = await fetch("/api/v1/user/auth/google", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include", // refresh token 是 httpOnly cookie
  body: JSON.stringify({ idToken: response.credential }),
});
```

回應形狀與舊 `/login` 相同：`{ ok, status, code, message, data: { user, config }, accessToken }`。

> 後端需要 `GOOGLE_CLIENT_ID` 環境變數，且必須與前端使用的 OAuth client ID 一致，否則所有 Google 登入都會 401。

---

## 二、新增的端點

全部在 `/api/v1/user/auth`。除了 `POST /auth/password` 需要 Bearer token，其餘皆為公開端點。

### 1. `POST /auth/register` — 帳密註冊

```jsonc
// request
{ "name": "Jane", "email": "jane@example.com", "password": "taipei2026" }
// response 200
{ "ok": true, "code": 200, "message": "註冊成功，請至信箱點擊驗證連結後即可登入",
  "data": { "emailSent": true } }
```

**注意：註冊不會回傳 `accessToken`，也不會設 refresh cookie。** 必須先完成信箱驗證才能登入。前端註冊成功後應導向「請至信箱收驗證信」的畫面，而不是導向已登入首頁。

`data.emailSent` 為 `false` 時代表帳號已建好但驗證信寄送失敗，`message` 會變成提示重寄的版本 —— 此時應顯示「重新寄送驗證信」按鈕。

密碼規則（後端 Zod 驗證，不符回 400）：

- 至少 8 字元
- **最多 72 個位元組**（不是 72 字元。bcrypt 的硬上限，超過會被靜默截斷，所以在邊界擋掉。中文一個字算 3 bytes，所以純中文密碼上限是 24 字）
- 必須同時包含英文字母與數字

email 已被註冊 → **409**，`data.reason = "EMAIL_TAKEN"`。

### 2. `POST /auth/login` — 帳密登入

```jsonc
// request
{ "email": "jane@example.com", "password": "taipei2026" }
// response 200：與 Google 登入相同形狀
{ "data": { "user": {...}, "config": {...} }, "accessToken": "..." }
```

失敗情形要分開處理，因為使用者該看到的下一步不同：

| 狀態 | `data.reason`         | 前端該做的事                                                                                                                      |
| ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 401  | `INVALID_CREDENTIALS` | 顯示「電子郵件或密碼錯誤」。**不要**試圖區分「帳號不存在」與「密碼錯誤」—— 後端刻意對兩者回完全相同的回應，避免洩漏哪些信箱已註冊 |
| 403  | `EMAIL_NOT_VERIFIED`  | 顯示「請先完成驗證」並提供「重寄驗證信」按鈕                                                                                      |
| 429  | —                     | 登入嘗試過於頻繁（每 IP 10 次 / 15 分）                                                                                           |

### 3. `POST /auth/verify-email` — 完成信箱驗證

驗證信裡的連結會是 `<APP_WEB_BASE_URL>/verify-email?token=xxx`。**前端需要新增這個頁面**，讀取 query 的 `token` 後 POST 給後端：

```jsonc
// request
{ "token": "<query 裡的 token>" }
// response 200：直接回傳登入 session
{ "message": "電子郵件驗證成功", "data": { "user": {...}, "config": {...} }, "accessToken": "..." }
```

驗證成功即自動登入，不需再叫使用者輸入一次密碼。連結無效或過期（24 小時 TTL、一次性）→ 401 `INVALID_TOKEN`。

### 4. `POST /auth/verify-email/resend` — 重寄驗證信

```jsonc
{ "email": "jane@example.com" }
```

**無論該信箱是否存在、是否已驗證，一律回 200 與同一句訊息**，避免被當成信箱列舉工具。前端不能依這個回應判斷帳號是否存在。限流每 IP 3 次 / 60 分。

### 5. `POST /auth/password/forgot` — 申請密碼重設

```jsonc
{ "email": "jane@example.com" }
```

格式正確的請求會先寫入 durable queue，成功時**一律回相同的 202 Accepted**，前端不得依回應判斷信箱是否存在或登入方式。背景 worker 會依帳號狀態處理：

- 含 `"local"` 的帳號：寄出一次性密碼重設連結。
- Google-only（只有 `"google"`）帳號：**不簽發重設 token**，改寄 Google 登入與 Google 帳戶救援說明；信中不含本站重設連結。
- 未註冊信箱：不寄信。

成功訊息為「若該電子郵件已註冊，我們將寄出後續操作說明」。只有 durable queue 無法寫入時回 503；因為 queue insert 對所有 email 都走同一路徑，503 不會洩漏帳號或 provider。Worker 的帳號查詢／寄信失敗會在 queue 中重試，不改變已回傳的 202。限流每 IP 3 次 / 60 分。

### 6. `POST /auth/password/reset` — 重設密碼

重設信連結是 `<APP_WEB_BASE_URL>/reset-password?token=xxx`。**前端需要新增這個頁面**：

```jsonc
// request
{ "token": "<query 裡的 token>", "password": "taipei2027" }
// response 200：直接回傳登入 session
{ "message": "密碼已重設，請使用新密碼登入", "data": { "user": {...} }, "accessToken": "..." }
```

TTL 1 小時、一次性。密碼規則同註冊。無效 → 401 `INVALID_TOKEN`。為避免任意 token 觸發 bcrypt CPU DoS，此端點另有限流（每 IP 10 次 / 60 分），超過回 429。

此端點只接受目前仍含 `"local"` provider 的帳號。即使 Google-only 帳號持有部署新政策前簽發的舊 reset token，也會以 401 `INVALID_TOKEN` 拒絕，不能藉此新增本站密碼。

重設成功會一併把信箱標記為已驗證，並透過 `tokenVersion` 撤銷該帳號所有既有 access／refresh token。每封重設信的 reset token 各自一次性且 1 小時有效；使用其中一封不會提前消耗另一封仍在寄送或已寄達的重設信。

### 7. `POST /auth/password` — 變更密碼（需登入）

```jsonc
// request（需 Authorization: Bearer <accessToken>）
{ "currentPassword": "taipei2026", "newPassword": "taipei2027" }
// response 200
{ "message": "密碼已更新，其他裝置的登入狀態已失效",
  "data": { "user": {...} }, "accessToken": "<新的 token>" }
```

**`currentPassword` 在帳號還沒有密碼時可以省略** —— 這是純 Google 登入的使用者「新增密碼登入方式」的途徑。判斷依據是 `user.authProviders` 不含 `"local"`。若帳號已有密碼卻沒傳 `currentPassword`，回 400 `PASSWORD_REQUIRED`。

**回應會附上新的 `accessToken`（與新的 refresh cookie），前端必須換掉手上的舊 token**，否則下一個請求就會被判為已撤銷而拿到 403。

---

## 三、`user` 物件新增欄位

```jsonc
{
  "_id": "665f...",
  "name": "Jane",
  "email": "jane@example.com",
  "client_id": null, // 改動：純帳密帳號為 null（原本必定有值）
  "authProviders": ["local"], // 新增："google" | "local"，可同時有兩者
  "emailVerified": true, // 新增
  "tokenVersion": 0, // 新增，見下
  "lineUserId": null,
  "createdAt": "...",
  "updatedAt": "...",
}
```

- **`client_id` 現在可能是 `null`。** 前端若有任何地方拿 `client_id` 當使用者識別鍵，要改用 `_id`。
- **`authProviders`** 決定設定頁該顯示什麼：含 `"local"` → 顯示「變更密碼」；不含 → 顯示「設定密碼」（呼叫同一支 `/auth/password`，省略 `currentPassword`）。
- **`passwordHash` 永遠不會出現在任何回應或 token 裡。**

---

## 四、Token 撤銷（會影響既有前端行為）

新增 `tokenVersion` 機制：改密碼或重設密碼時後端會遞增它，所有在那之前簽發的 access／refresh token 立即失效。

對前端的實際影響：

1. **每個需要登入的請求都可能因為「token 已被撤銷」而回 403**（不只是過期回 401）。若你的錯誤處理只在 401 時嘗試 refresh、403 時直接登出，行為是對的 —— 撤銷後 refresh 也會失敗，登出是正確結果。
2. **`/auth/password` 之後一定要用回應裡的新 token 覆蓋舊的**，否則自己就會被自己的變更踢掉。
3. **撤銷現在覆蓋全部 API**，不只 `/user/*`：hazard-report、SOS、AI chat、語音 WebSocket 都會檢查。語音 WS 在 token 被撤銷時以 `4401 unauthorized` 關閉連線。

---

## 五、後端部署前置（不是前端的事，但會影響你能不能測）

1. **必須先跑 `pnpm migrate:auth`，再重建 image。** 除了替換舊的 user indexes，migration 會刪除舊 `AuthToken(password_reset)`（舊連結需重新申請）、移除其餘重複 auth token，並建立 `(userId, type)` 唯一索引。新的 password-reset token entries 直接存在 User document；每個 queue job 的連結彼此獨立，兌換時會在同一個原子操作內更新密碼，並只把實際命中的 entry 標為 consumed。
2. 新環境變數：`GOOGLE_CLIENT_ID`、`RESEND_API_KEY`、`RESEND_FROM`、`APP_WEB_BASE_URL`、`PASSWORD_RESET_TOKEN_SECRET`、`TRUST_PROXY_HOPS`。`PASSWORD_RESET_TOKEN_SECRET` 至少 32 bytes，且跨部署必須保持不變，讓同一 queue job 的重試使用相同 reset token。
3. `RESEND_API_KEY` 未設定時寄信會 fail closed；背景帳號協助 job 會重試，且不會把一次性 token 寫入 log。若要在本機測完整信件流程，必須提供測試用 Resend key。
4. `RESEND_FROM` 的網域（`2026.yuzen.dev`）**必須先在 Resend 完成 DNS 驗證**，否則寄信會被拒。
5. MongoDB 連線成功後，API process 會自動啟動 password-assistance worker；queue job 以 majority+journal write concern 寫入 MongoDB，不依賴無持久化的 Redis cache。Worker 以 lease fencing 防止舊 instance 完成新 lease 的工作，並以 job ID 產生穩定 reset token 與 Resend `Idempotency-Key`；同一小時內不同 job 的連結可並存且各自一次性，避免背景寄送競態讓最新抵達的信件一開始就失效。
