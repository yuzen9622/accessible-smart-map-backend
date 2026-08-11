# 前端遷移說明：全站 API 登入需求盤點

前端無法從表單本身判斷某個動作需不需要登入（例如「回報障礙物」），只能等送出後被拒絕才知道。這份文件列出**每一支 API 的登入需求**，前端可依此在畫面上提前標示登入 CTA，避免使用者白填表單。

## 圖例

- **PUBLIC**：不需要 `Authorization: Bearer <token>`。
- **PROTECTED**：必須帶有效的 `Authorization: Bearer <token>`，否則 401（過期）或 403（無效/缺少）。
- **PUBLIC_OPTIONAL_AUTH**：不需要登入即可使用；若帶有效 token 則啟用額外功能（見備註）。

## 已支援匿名操作（呼應「B8 允許匿名回報」）

以下動作**不需要登入**即可完成，帶 token 時則以帳號身分記錄，未帶 token 時以 IP hash 匿名身分記錄（皆有防重複機制）：

| 動作 | Endpoint | 備註 |
|---|---|---|
| 提交障礙回報 | `POST /api/v1/a11y/reports` | 有 token → `userId`；無 token → `"ip:" + sha256(ip)`，兩者都會計入去重與投票防重 |
| 確認／否認回報 | `POST /api/v1/a11y/reports/:id/confirm` | 同上識別邏輯 |
| AI 對話 | `POST /api/v1/ai/chat` | 有 token → 對話會參考使用者記憶；無 token → 純匿名對話仍可用；**過期 token 回 401、無效 token 回 403**（不會靜默降級為匿名） |

## 完整清單

### `/api/v1/user`（掛載時全域套用 JWT middleware；下列僅 allowlist 內的路徑例外公開）

| Method | Path | 登入需求 |
|---|---|---|
| POST | `/auth/google` | PUBLIC |
| POST | `/auth/register` | PUBLIC |
| POST | `/auth/login` | PUBLIC |
| POST | `/auth/verify-email` | PUBLIC |
| POST | `/auth/verify-email/resend` | PUBLIC |
| POST | `/auth/password/forgot` | PUBLIC |
| POST | `/auth/password/reset` | PUBLIC |
| POST | `/auth/password`（改密碼） | **PROTECTED** |
| POST | `/refresh` | PUBLIC（走 refresh cookie） |
| POST | `/logout` | PUBLIC |
| GET | `/info` | **PROTECTED** |
| POST | `/line-link-code` | **PROTECTED** |
| POST | `/config`、`/config/update` | **PROTECTED** |
| GET / POST / DELETE | `/emergency-contacts...` | **PROTECTED**（全部三支） |

### `/api/v1/sos`

| Method | Path | 登入需求 |
|---|---|---|
| POST | `/sessions` | **PROTECTED** |
| PATCH | `/sessions/:id/location` | **PROTECTED** |
| PATCH | `/sessions/:id/resolve` | **PROTECTED** |
| GET | `/sessions/:id` | **PROTECTED**（僅本人） |
| GET | `/sessions/:id/stream` | **PROTECTED**（SSE，僅本人） |
| GET | `/sessions/:id/public` | PUBLIC（求救頁面追蹤用，見下方安全性附註） |

> ⚠️ **安全性附註（追蹤中修復）**：`/sessions/:id/public` 目前用**原始 session id** 查詢，而非設計上應使用的高熵 `shareToken`。修復需同步調整前端追蹤連結的參數，暫不在本次變更中處理，另行安排。

### `/api/v1/a11y`（含 accessible-route、hazard-report、review、place-search、campus、welfare、environment、visual-a11y、nav-instructions 等子模組）

| Method | Path | 登入需求 |
|---|---|---|
| GET | `/coverage`、`/all-facilities`、`/all-bathrooms`、`/all-ramps`、`/all-elevators`、`/nearby-a11y`、`/quick-assess`、`/parking/nearby`、`/place` | PUBLIC |
| POST | `/accessible-route` | PUBLIC |
| POST | `/route/instructions` | PUBLIC |
| POST | `/reports` | PUBLIC_OPTIONAL_AUTH |
| GET | `/reports`、`/reports/:id` | PUBLIC |
| GET | `/reports/mine` | **PROTECTED** |
| POST | `/reports/:id/confirm` | PUBLIC_OPTIONAL_AUTH |
| GET | `/environment` | PUBLIC |
| GET | `/welfare`、`/welfare/nearby`、`/welfare/:id` | PUBLIC |
| GET | `/visual-a11y` | PUBLIC |
| POST | `/visual-a11y/sync` | **PROTECTED**（內部資料同步用途，非一般使用者操作） |
| GET | `/reviews`、`/reviews/summary` | PUBLIC |
| POST / PATCH / DELETE | `/reviews...` | **PROTECTED** |
| GET | `/campus...`（5 支） | PUBLIC |
| GET | `/search/autocomplete`、`/search/details/:id` | PUBLIC |

### 其他模組

| Method | Path | 登入需求 |
|---|---|---|
| GET | `/api/v1/transit/bus/...`（8 支） | PUBLIC |
| GET | `/api/v1/air/air-quality` | PUBLIC |
| GET | `/api/v1/line/route-preview` | PUBLIC |
| POST | `/api/v1/line/webhook` | 非 JWT——改用 LINE HMAC 簽章驗證（給 LINE 平台呼叫，前端不會呼叫此路徑） |
| POST | `/api/v1/ai/intent`、`/api/v1/ai/explain` | PUBLIC |
| GET / PATCH / POST / DELETE | `/api/v1/ai/memories...` | **PROTECTED** |
| GET | `/health`、`/api/v1/openapi.json`、`/docs` | PUBLIC |

## 給前端的建議

- 需要登入的表單（回報後台管理、評價、SOS、個人設定、緊急聯絡人）應在頁面載入時就檢查 token，未登入直接導向登入頁或顯示登入 CTA，不要等送出才被 401/403 擋下。
- 障礙回報表單**不需要**強制登入；未登入時仍可正常送出，UI 可選擇性提示「登入後可在『我的回報』查看紀錄」。
- `POST /api/v1/ai/chat`：若曾登入但 token 已過期，會收到 401 而非靜默轉匿名，前端應視同一般 401 處理（提示重新登入或以訪客身分繼續）。
