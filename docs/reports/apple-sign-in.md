# Sign in with Apple ADR & Implementation Report

## 1. 背景與目標

為滿足 iOS 客戶端審核與第三方登入需求，新增 `POST /api/v1/user/auth/apple` 端點，支援透過 Apple 發出的 identityToken（JWT）進行身分驗證與帳號登入/建立。

## 2. 驗證函式庫選型與 CJS 相容性

- **選型**：採用 `jose@^6.2.12`。零外部相依、原生支援 Apple JWKS (`createRemoteJWKSet`) 內建快取與冷卻機制、標準 RS256/`iss`/`aud`/`exp` 聲明驗證，並提供結構化錯誤類別。
- **CommonJS 相容性**：Node ≥ 20.19 / ≥ 22.12 原生支援 `require(esm)`。本專案正式 Docker 基底映像為 `node:22-bookworm-slim`，本機環境為 Node 26，經編譯產物實測 `require('./dist/adapters/apple-auth.adapter')` 能正常載入。

## 3. 資料模型與識別碼隱私保護

- **欄位設計**：`User` 模型新增 `appleUserId: { type: String, default: null }`，並建立 partial unique index（`{ appleUserId: 1 }, { unique: true, partialFilterExpression: { appleUserId: { $type: "string" } } }`）。這與既有的 `lineUserId` 和 `client_id` 採用相同策略，避免第二個 null 值衝突，亦無需全表資料遷移。
- **不對外暴露**：`appleUserId` 為 Apple 針對個別 App Bundle 簽發的穩定使用者識別碼，**不納入** `toPublicUser`（`src/config/jwt.ts`）輸出欄位，也不存入 access/refresh JWT payload 中。前端僅透過 `authProviders` 是否包含 `"apple"` 得知授權狀態。

## 4. 驗證與 Nonce 防重放機制

- **Claims 驗證**：RS256 簽章、`iss === "https://appleid.apple.com"`、`aud ∈ allowlist`（預設 App Bundle ID `com.accessiblemap.app`，可透過 `APPLE_CLIENT_IDS` 設定）、`exp > now`。
- **Nonce 規則**：客戶端發起 Apple 授權時可產生原始 rawNonce，後端在收到選填 `nonce` 時計算 `SHA-256(rawNonce)`（hex）並以 `crypto.timingSafeEqual` 比對 token 內的 `nonce` claim；若長度或內容不符則判定 token 無效。

## 5. 錯誤分類

- **Token 無效 (401)**：包含簽章錯誤、claim 驗證失敗、過期、nonce 不符，統一對映為 `AuthError("INVALID_TOKEN")` → HTTP 401。
- **身分衝突 (409)**：若同 email 帳號已綁定其他 Apple sub，拋出 `AuthError("EMAIL_TAKEN")` → HTTP 409。
- **基礎設施與設定失敗 (500)**：若 Apple JWKS 網路連線逾時、無法解析，或 `APPLE_CLIENT_IDS` 設定無效，直接向上拋出錯誤由外層回傳 HTTP 500，避免誤報為 401。

## 6. 共用 OAuth CAS 帳號解析流程

在 `user.auth.service.ts` 中將 Google 與 Apple 的共同登入流程抽成 `completeOAuthSignIn`，統一處理：
1. 以 provider sub 查找既有帳號；
2. 同 email 已驗證帳號進行原子連結（link）；
3. 未驗證 local 帳號進行 CAS 接管（takeover），移除密碼並撤銷舊 session；
4. 全新帳號原子新增。
此設計保證 Google 登入行為完全零回歸，且 Google 與 Apple 身分可共存於同一 User 帳號。

## 7. 範圍外項目（未決與後續改善）

- **Apple Server-to-Server 撤銷通知**：Apple 帳號刪除或轉址關閉的 Webhook 不在本次範圍，建議於獨立 issue 處理。
- **Apple-only 帳號忘記密碼**：目前密碼協助功能對非 local 帳號略過，產品層面後續可評估是否寄發導引信。

## 8. 2026-10-10 登入 audience 修正

- 原預設 audience `dev.yuzen.accessiblesmartmap` 與目前 iOS App 的 `com.accessiblemap.app` 不一致，造成 token 在帳號查找之前遭拒，無法進入既有的同信箱綁定流程。預設值與 `.env.example` 已對齊目前 App。
- `APPLE_CLIENT_IDS` 仍是明確設定的唯一 allowlist。若部署環境已設定此變數，必須確認包含 `com.accessiblemap.app`；更新程式的預設值不會覆蓋環境設定。若仍支援其他 App／Services ID，應明確列入 allowlist。
- 新增整合測試，以本地 RSA 金鑰簽署 token 並使用隔離 MongoDB，執行真實 JWT 驗證、帳號綁定與 session 寫入。覆蓋 Google／已驗證密碼帳號同信箱登入、保留原 user ID／設定／憑證、重複登入，以及錯誤 audience／未驗證信箱／Apple 身分衝突的拒絕路徑。
- 測試不代表正式 Apple 授權、部署設定或實機登入已驗收。Apple 隱藏電子郵件提供的 relay 地址若與 Google 信箱不同，不會依信箱自動綁定。

### 本次變更與驗證

- `src/config/apple.ts`：更正預設 audience。
- `.env.example`：更新部署設定範例。
- `src/config/apple.test.ts`、`src/modules/user/user.auth.apple.service.test.ts`：對齊預設 audience 斷言。
- `src/modules/user/user.auth.apple.integration.test.ts`：補上簽章 token 與真實隔離 MongoDB 的整合回歸測試。
- `docs/reports/apple-sign-in.md`：記錄原因、部署注意事項與驗證範圍。
- 端點維持 `POST /api/v1/user/auth/apple`；無 API body、回應契約或資料遷移變更。
- 修正前：新增整合測試為 3 failed / 2 passed，Google／密碼帳號同信箱登入均遭 `INVALID_TOKEN` 拒絕。修正後：該檔 5 項全部通過。
- `pnpm test src/modules/user src/config/apple.test.ts src/adapters/apple-auth.adapter.test.ts src/adapters/apple-auth.adapter.revoke.test.ts`：25 個檔案、351 項全部通過。
- `pnpm build`：通過，含架構邊界檢查與 TypeScript 編譯。已自行檢視 diff；未進行獨立審查、正式環境設定檢查、部署或實機驗收。
