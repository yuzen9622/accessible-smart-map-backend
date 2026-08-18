# 資安強化計畫（回應 2026-08-17 產品級稽核 §5）

- 撰寫日期：2026-08-18
- 依據：`docs/audit/2026-08-17-product-grade-audit.md` §5「資安與隱私」
- 基準 commit：`7c11886`（main）
- 本計畫的每一條事實都經過**直接探測核實**（4 個唯讀 subagent），與稽核報告不一致處已標註

---

## 0. 與稽核報告的差異（先講，因為它改變修法）

稽核報告是靜態程式碼分析產出的，稽核者沒讀 `docs/FRONTEND_MIGRATION_*` 系列契約文件，
也沒展開 logout 的呼叫鏈。核實後有三處必須偏離報告的「怎麼修」：

| # | 稽核報告的建議 | 核實後的實況 | 本計畫採用的修法 |
|---|---|---|---|
| §5.1 | 給 `/ai/chat` 掛 `middleware`（強制認證） | **匿名可用是刻意的對外契約**：`docs/FRONTEND_MIGRATION_AUTH_BOUNDARIES.md:9,19` 明文定義 `PUBLIC_OPTIONAL_AUTH`，呼應需求 B8「允許匿名回報」 | 維持匿名，改掛**分層限流**（匿名 IP-key／登入 userId-key ＋每日總量上限）＝報告自己給的次選方案 |
| §5.2 | 「logout 遞增 `tokenVersion`（一行）」 | `logout` 是**公開路由**（`middleware.ts:15` 白名單），`logout(_req, res)` 連 `req` 都沒收（`user.controller.ts:227`），**無從得知是誰**；且系統**沒有 refresh token 落地表**（純 JWT、無 jti、無 rotation、無重用偵測） 使用者拍板改做 **refresh token 落地表 ＋ per-device 撤銷**（`sid` 貫穿 access／refresh），見 §4。範圍從 0.5 小時擴大到 2–3 天 |
| §5.5 | 登入類 limiter 改 fail-closed 回 503 | `REDIS_URL` 未設時 store 是 `undefined` → 退回 **in-memory store，仍有限流**（非報告暗示的完全失效）；真正的洞只在「Redis 有設但執行期出錯」 | 採**雙層**：in-memory backstop（放寬 3 倍）＋ Redis limiter `passOnStoreError: false`。Redis 掛掉時仍有單機天花板，不會整組登入失效 |

另外核實到**兩個稽核報告沒抓到的問題**（S7、S8），列在本計畫末尾。

---

## 1. 範圍

**In scope**：稽核報告 §5.1–§5.6 全部六條，加上核實過程中發現的 S7、S8。

**Out of scope（明確不做，避免範圍蔓延）**：
- §4.5 結構化 logging／request id — 是可觀測性，不是資安，另案。
- §4.6 env 集中 + 啟動驗證 — 另案（但 S8 會用到其中一小塊）。
- 重構既有 4 份重複的 limiter `makeStore`（`user` / `place-search` / `hazard-report` / `line`）
  —— 本計畫**只新增**共用 factory 給新 limiter 用，不回頭改既有四份。
- 任何測試分層／覆蓋率／arch check 的改動（§2、§6、§7）。
- `/a11y/accessible-route`、`/line/route-preview` 的限流 —— 同樣無限流且會打外部 API，
  但不在稽核 §5 點名範圍內，列為後續案（見 §10）。

**禁改範圍**：
- 不得把 `docs/FRONTEND_MIGRATION_AUTH_BOUNDARIES.md` 標為 PUBLIC / PUBLIC_OPTIONAL_AUTH 的端點改成需要認證。
- 不得修改任何 AI prompt 的語意內容（只允許改座標精度，見 S4）。
- 不得動 `src/scripts/`、`src/modules/accessible-route/planners/`、GTFS/OTP 相關程式。

---

## 2. 工作切分與並行安排

依「會修改同檔案的任務不得並行」拆成 4 批。**前三批並行，第四批等第二批完成**（兩者都改 `user.router.ts`）。

| 批 | 內容 | 主要檔案 | 並行 |
|---|---|---|---|
| **A** | S1 AI／LLM 端點限流 | `middleware/optional-auth.middleware.ts`(新)、`middleware/rate-limit.ts`(新)、`modules/ai/ai.middleware.ts`(新)、`ai.router.ts`、`ai.chat.controller.ts`、`review.router.ts` | ✅ |
| **B** | S2 登入工作階段落地表 ＋ per-device 撤銷 ＋ S5 limiter 失效 ＋ S6 設定不一致 ＋ S7 重設 token 改隨機值 | `model/auth-session.model.ts`(新)、`modules/user/*`、`config/jwt.ts`、`config/auth.ts`、`config/lib.ts` | ✅ |
| **C** | S4 送 Gemini 的座標降精度 | `utils/geo-privacy.ts`(新)、`config/ai/chat-prompt.ts`、`modules/voice/voice-prompt.ts`、`modules/voice/live-bridge.ts` | ✅ |
| **D** | S3 帳號／資料刪除 ＋ 位置保存期限 ＋ audit log | `model/access-audit.model.ts`(新)、`modules/user/user.account-deletion.*`(新)、`modules/privacy/retention.job.ts`(新)、多個 model 加 TTL、`sos`/`line` 掛 audit | ⛔ 等 B（同改 `user.router.ts`，且刪帳號要連帶撤銷 S2 的 session） |

---

## 3. S1（P0）— AI／LLM 端點限流

### 現況（已核實）

`ai.router.ts` 全部 10 支路由**沒有任何一支掛 limiter**（`ai.router.ts:27-73`）；
`/intent`、`/explain`、`/chat` 三支連認證都沒有。`app.ts` **無全域限流**（`app.ts:45-75`）。
`/a11y/reviews/summary` 同樣會打 Gemini 且全裸（`review.router.ts:23-27`）。
`trust proxy` 已正確設成 hop count（`app.ts:51`），IP-key 限流可用。

### 改動

**S1-1 新增 `src/middleware/optional-auth.middleware.ts`**

統一的「可選認證」中介層，行為必須與既有兩份複寫完全一致（`ai.chat.controller.ts:24-31` 的
`resolveAuthUser`、`accessible-route.controller.ts:16-27` 的 `resolveOptionalUserId`）：

- 無 `Authorization` header → `next()`，不注入 `req.auth`（匿名）
- 有 header 但**過期** → 401（`ResponseCode.UNAUTHORIZED`）
- 有 header 但**無效** → 403（`ResponseCode.FORBIDDEN`）
- 有效 → 注入 `req.auth = { userId, user }`，然後 `next()`

> 這一層是 S1-3 的**前置依賴**：limiter 的 keyGenerator 必須先知道 userId 才能分流。
> 不是順手重構。

`ai.chat.controller.ts` 的 `resolveAuthUser` 改讀 `req.auth`（同一路徑，in scope）。
`accessible-route.controller.ts` 的那份**本輪不動**（不同路徑，out of scope）。

**S1-2 新增 `src/middleware/rate-limit.ts`** — 共用 factory

```
createRateLimiter({ prefix, windowMs, limit, keyBy, passOnStoreError })
```

- `keyBy: "ip" | "user" | "userOrIp"`
- `"userOrIp"`：`req.auth?.userId` 存在 → `"u:" + userId`；否則 → `ipKeyGenerator(req.ip)`
- ⚠️ **必須呼叫 `express-rate-limit` 具名匯出的 `ipKeyGenerator` helper**。已核實安裝版本
  `express-rate-limit@8.6.2`，自訂 keyGenerator 若直接用 `req.ip` 而不經該 helper，
  IPv6 使用者可逐位址繞過限流。
  > **2026-08-18 實測修正**：原本這裡寫「套件會噴警告／拋 ValidationError」——**那不構成保護**。
  > 實測 `ERR_ERL_KEY_GEN_IPV6` 的 throw 會被 `wrappedValidations` 攔下並只印到 console，
  > 請求照樣回 200（`dist/index.cjs:672-678`）。也就是說**寫錯了不會有任何東西擋你**，
  > 只能靠測試守（同一 /56 子網內兩個不同 IPv6 位址必須共用同一個桶）。
- store 沿用既有模式：`redisClient` 為 null → 不傳 store（退回 in-memory，仍有限流）；
  有 Redis → `RedisStore` ＋ `redisReady()` 等待就緒。
- 429 回應必須走 `sendResponse()` 統一信封（`ResponseCode.TOO_MANY_REQUESTS`），
  不得是 express-rate-limit 的預設純文字 —— 否則破壞 §4.1 的回應契約。

**S1-3 新增 `src/modules/ai/ai.middleware.ts`** — 兩層限流（burst ＋ 每日總量）

額度（寫成模組常數，**不吃環境變數**，避免加深 §4.6 的設定散落問題）：

| 端點 | 身分 | burst | 每日總量 |
|---|---|---|---|
| `POST /ai/chat` | 匿名（IP） | 10 / 10 min | 60 / 24 h |
| `POST /ai/chat` | 已登入（userId） | 40 / 10 min | 400 / 24 h |
| `POST /ai/intent`、`/ai/explain` | 匿名（IP） | 30 / 10 min | 200 / 24 h |
| `POST /ai/intent`、`/ai/explain` | 已登入（userId） | 60 / 10 min | 600 / 24 h |
| `GET /a11y/reviews/summary` | 不分身分（IP） | 20 / 10 min | 200 / 24 h |

- **失效行為（審核 B4 後修正）**：`passOnStoreError` 維持 `true`，**另外前置一層 in-memory backstop
  limiter**（額度為上表的 3 倍，不傳 store）。
  > 原本寫的是 `passOnStoreError: false`（fail-closed）。已核實那是錯的：
  > `express-rate-limit@8.6.2` 在該值為 false 時是 `throw error`（`dist/index.cjs:942`），
  > 不進 `handler` —— 結果是 **500，不是 429**，直接破壞 S1-2 硬性要求的統一信封契約。
  > repo 既有註解早已寫明這點（`user.middleware.ts:30`）。
  > 改用 backstop 之後，Redis 執行期出錯時仍有單機額度天花板護住 Gemini／Places 花費。
- store error 時必須 `console.error("[ratelimit] store error", { prefix, err })`，不得靜默。
  （`REDIS_URL` 未設不會觸發此路徑，那是 in-memory store 正常運作。）
- 匿名與登入用**不同 limiter 實例**（不同 prefix），否則額度會互相污染。

**S1-4 掛載**：`ai.router.ts` 的 `/intent`、`/explain`、`/chat` 依序掛
`optionalAuth → burstLimiter → dailyLimiter → validateRequest → controller`；
`review.router.ts` 的 `/reviews/summary` 掛對應 limiter。

### 驗收（每條都要有「會變紅的那一條」）

route-level integration test（supertest，`tests/helpers/test-helpers.ts` 既有 harness）：

1. 不帶 token 連打 `POST /ai/chat` 第 11 次 → **429**，且回應是統一信封（有 `ok:false`、`code:429`）。
2. 帶有效 token 打第 11 次 → **200**（證明 userId key 與 IP key 是分開的桶）。
3. 帶**過期** token → 401；帶**無效** token → 403（證明沒有靜默降級為匿名，守住 AUTH_BOUNDARIES 契約）。
4. 完全不帶 token 且未設 `REDIS_URL` → 仍會在第 11 次被擋（證明 in-memory fallback 有效）。
5. `pnpm run typecheck`、`pnpm test`、`pnpm run lint:arch` 全綠。

---

## 4. S2（P1）— 登入工作階段落地表 ＋ per-device 撤銷

> **使用者已拍板（2026-08-18）**：不採「帳號級 tokenVersion++」的輕方案，
> 改做 refresh token 落地表與 per-device 撤銷。本節依此重寫，範圍從 0.5 小時擴大到 2–3 天。

### 現況（已核實）

| 事實 | 證據 |
|---|---|
| `logout` 只清 cookie，不碰 DB，連 `req` 都沒收 | `user.controller.ts:227-245` |
| `/logout` 是公開路由，不需要有效 token | `middleware.ts:15`、`user.router.ts:110` |
| **沒有 refresh token 落地表**，無 jti、無 rotation、無重用偵測 | `user.controller.ts:181-226` |
| `auth-token.model.ts` 只存 email 驗證／密碼重設一次性 token，與登入態無關 | `auth-token.model.ts:4-24` |
| `tokenVersion` 只在改密碼／重設密碼／Google 接管時 +1 | `user.auth.service.ts:412,481`、`user.auth.repository.ts:142` |
| 每個受保護請求都已經打一次 DB（`User.findById`）並比對 `tokenVersion` | `config/auth.ts:33,39` |
| access TTL 60m、refresh JWT TTL 1d | `config/jwt.ts:8,9` |

### 關鍵設計問題：光有 refresh token 落地表**關不掉 access token**

per-device 撤銷 refresh token 只擋得住「換新 access token」，**擋不住已經發出去的 access token**
在剩餘 60 分鐘內繼續用 —— 而那正是稽核 §5.2 要解決的問題。所以落地表必須配一個
**session id（`sid`）貫穿 access 與 refresh 兩種 token**，由 `authenticateToken` 每請求檢查。

`config/auth.ts:33` 本來就每請求打一次 DB，多一次以 `sid` 為鍵的 indexed 查詢是可接受的成本。

### 改動

**S2-1 新增 `src/model/auth-session.model.ts`** — 一個 session = 一次裝置登入

| 欄位 | 用途 |
|---|---|
| `_id` | 即 `sid`，寫進 access／refresh token payload |
| `userId` | 擁有者，index |
| `currentRefreshJti` | 目前有效的 refresh token jti（rotation 用） |
| `previousRefreshJti` / `rotatedAt` | 上一代 jti 與輪替時間，供並發寬限窗判定（審核 B2） |
| `revokedAt` | 撤銷時間；非 null 即失效 |
| `revokedReason` | `"logout"` \| `"reuse-detected"` \| `"account-deleted"` \| `"password-changed"` |
| `expiresAt` | TTL index（`expireAfterSeconds: 0`），等於 refresh TTL。**每次 rotation 必須往後推**（審核 B3） |
| `createdAt` / `lastUsedAt` | 稽核與「最近活動」用 |
| `userAgentHash` / `ipHash` | 裝置辨識（**存雜湊不存原文**，與 S3 的隱私原則一致） |

**S2-2 token payload 擴充**（`config/jwt.ts`）

- access token 加 `sid`
- refresh token 加 `sid` ＋ `jti`
- **破壞性變更**：沒有 `sid` 的舊 token 一律視為無效（401）。部署當下所有人被登出一次，
  需重新登入。依 `docs/` 既有慣例，這要寫進前端遷移文件。
  （不做寬限期的理由：寬限期等於「舊 token 在寬限窗內仍不可撤銷」，那正是本條要修掉的洞。）

**S2-3 `config/auth.ts` 每請求檢查**

驗簽 → 比對 `tokenVersion`（保留，作為帳號級的全撤銷手段）→ **以 `sid` 查 `AuthSession`**：
不存在／`revokedAt` 非 null／已過期 → 401。

**S2-4 `/refresh` 加 rotation ＋ 重用偵測**（`user.controller.ts:181-226`）

1. 驗簽 → 取 `sid`、`jti`。
2. 查 session。不存在或已撤銷 → 401。
3. **三分類**（審核 B2 修正）：
   - `jti === currentRefreshJti` → 正常，進第 4 步。
   - `jti === previousRefreshJti` **且** `now - rotatedAt <= REFRESH_GRACE_MS`（30 秒）
     → **良性並發重試**，不是攻擊。回 401 讓呼叫端重試，**但絕對不撤銷任何 session**。
     （亦可回目前這一代的 token；擇一實作，但不得判為 reuse。）
   - 其他（更早世代的 jti、或超過寬限窗的前一代）→ **判定重用**
     → 撤銷該使用者的**全部** session（`revokedReason: "reuse-detected"`）→ 401。
   > 原本只寫「`jti !== currentRefreshJti` 即判定重用」，並打算用條件更新解決並發。
   > 審核指出那是錯的：**條件更新只保證寫入不互相覆蓋，不改變分類**——
   > 並發時落後的那個請求讀到的正是已被輪替的 jti，必然被判重用並踢掉全部裝置。
   > 前端多分頁／App 多請求在 access token 過期後同時 refresh 是常態，
   > 照原設計上線的症狀是「使用者隨機被登出所有裝置」。
4. 正常 → 產生新 `jti`，以**條件更新**（`findOneAndUpdate({ _id: sid, currentRefreshJti: jti })`）
   原子寫入：`previousRefreshJti = 舊 jti`、`currentRefreshJti = 新 jti`、`rotatedAt = now`、
   `lastUsedAt = now`、**`expiresAt = now + refresh TTL`**，再簽發新的 access ＋ refresh。
   > `expiresAt` 必須延展（審核 B3）。現況是**滑動的**：`/refresh` 每次重簽 refresh JWT，
   > 且 `config/lib.ts:74-80` 每次把 cookie maxAge 重設為 7 天，持續使用的人永遠不會被登出。
   > 若只在建立 session 時設一次 `expiresAt`，TTL index 會在「登入後第 7 天」刪掉文件，
   > 即使使用者五分鐘前還在用 —— 那是計畫原本沒察覺的對外行為破壞。

**S2-5 `/logout` 改為 per-device 撤銷**

- 先從 refresh cookie（優先）或 Authorization header 認人與認 session。
- 驗簽通過 → 只把該 `sid` 的 session 標記 `revokedAt`（**不動 `tokenVersion`，其他裝置不受影響**）。
- **認不出來（無 cookie／驗簽失敗）→ 只清 cookie，一樣回 200。**
  不得回錯誤、不得從 body 取 `sid` 或 userId —— 否則匿名攻擊者可強制登出任意帳號／裝置。

**S2-6 建立 session：必須收斂到唯一的簽發點**（審核 B1 修正）

實際會發出 access＋refresh 的入口**有六個**，不是三個：`sendSession()`（`user.auth.controller.ts:17-35`）
被 `register`(:102)、`login`(:127)、`googleAuth`(:140)、**`verifyEmail`(:153-164)**、
**`resetPassword`(:207-220)** 共用，另外 **`changePassword` 自己直接呼叫**（`user.auth.controller.ts:257-258`）。

> 原本只列三條。照原計畫做，使用者**點完驗證信／重設完密碼／改完密碼**時回應裡那組新 token
> 沒有 `sid`，會被 S2-3 當場判 401 —— 症狀是「改完密碼立刻被登出，而且拿不到可用的 token」。

- 建立 `AuthSession` 的邏輯**只寫在 `sendSession()` 一處**，六條路徑全部經過它。
- **`changePassword` 的順序是硬性的：先撤銷該 userId 全部既有 session（S2-7），再建立新 session。**
  順序寫反（先建後撤）會把剛發出去的 session 一起撤掉，使用者永遠拿不到有效 token。

**S2-7 改密碼／重設密碼時撤銷全部 session**

現有的 `tokenVersion` +1（`user.auth.service.ts:412`、`user.auth.repository.ts:142`）保留，
**另外**把該 userId 的所有 session 標記 `revokedAt`（`revokedReason: "password-changed"`）。
**撤銷必須排在 S2-6 建立新 session 之前**（見 S2-6 末段）。
兩層並存：`tokenVersion` 擋住舊 token，session 撤銷讓稽核查得到「何時被撤銷、為什麼」。

**S2-8 `/logout`、`/refresh` 補掛 limiter**（併 §5.6）

### 明確不做（避免範圍蔓延）

- `GET /user/sessions`（列出我的登入裝置）與 `DELETE /user/sessions/:id`（遠端登出某裝置）
  —— 資料結構上已經支援，但那是**新功能**不是資安修補，列為後續案（§10）。
- session 狀態快取到 Redis —— 先用 Mongo indexed 查詢，有效能數據再優化。

### 驗收（每條都要有「會變紅的那一條」）

1. 登入取得 access token → `POST /logout` → 用**同一個舊 access token** 打 `GET /user/info` → **401**。
   （目前這條測試會回 200，改完必須先紅後綠。）
2. **per-device 隔離**：同一帳號建立兩個 session（A、B）→ 登出 A → A 的 access token 401，
   **B 的 access token 仍回 200**。這條是本次選型的核心價值，沒有它就等於做了輕方案。
3. **重用偵測**：用 refresh token R1 換到 R2 → 再拿 R1 打 `/refresh` → 401，
   且**該使用者所有 session 都被撤銷**（R2 之後也不能用）。
4. **並發 refresh 不誤判**：同一個 R1 同時發兩個 `/refresh`，只允許一個成功，
   另一個回 401 但**不得**把整個使用者的 session 全撤掉。
5. 不帶任何 cookie／header 直接 `POST /logout` → 200，且**任何 session 的 `revokedAt` 都沒被改動**。
6. 改密碼後，該帳號**所有**裝置的 access token 皆 401。
7. `collection.indexes()` 斷言 `AuthSession.expiresAt` 有 `expireAfterSeconds`。
8. 沒有 `sid` 的舊格式 token → 401（證明破壞性變更確實生效，不是靜默放行）。
9. **六條簽發路徑逐條驗**（審核 B1）：`register`／`login`／`googleAuth`／**`verifyEmail`**／
   **`resetPassword`**／**`changePassword`** 回傳的 access token，拿去打 `GET /user/info` 都必須 **200**。
   > 驗收第 6 條（改密碼後所有裝置 401）在 B1 那個壞掉的實作下**仍然會通過**，抓不到這個缺陷。
   > 必須另外斷言「改完密碼後，**這次回應給的新 token** 是可用的」，否則等於沒測。
10. **`expiresAt` 會滑動**（審核 B3）：建立 session → 把 `expiresAt` 手動調到剩 1 分鐘 →
    呼叫一次 `/refresh` → 斷言 `expiresAt` 被推回 7 天後。

---

## 5. S3（P1）— 帳號／資料刪除、位置保存期限、audit log

### 現況（已核實）

- **無帳號刪除端點**（`user.router.ts` 無任何 DELETE 路由）。
- 有 TTL index 的只有 2 個 model：`auth-token.model.ts:19`、`password-assistance-job.model.ts:25`。
- 存個資／位置但**無 TTL**：`User`、`UserMemory`、`SosSession`（lat/lng/address）、
  `EmergencyContact`（`lastLineLat/lastLineLng` = 家人即時位置）、
  `HazardReport`（GeoPoint ＋ `rawExifLat/rawExifLng` 原始 EXIF GPS）、`Review`、`LineLinkCode`。
- `UserMemory` 軟刪（`deletedAt`，`memory.repository.ts:211-234`）**無任何硬清除排程**。
- **無 audit log**（全 repo 只命中 GTFS 資料稽核腳本）。
- 既有可掛排程的入口：`hazard-report.expire.ts:39`、`user.password-assistance.worker.ts:19,127`
  兩處都是應用內 `setInterval`（無 cron／bullmq／agenda）。

### 改動

**S3a 帳號刪除端點** — `DELETE /api/v1/user/account`（PROTECTED）

- 有 `passwordHash` 的帳號：body 必須帶正確 `password`；Google-only 帳號：body 帶 `confirm: true`。
- 執行順序：先 `bumpTokenVersion`（立即失效所有 token）→ 再刪資料 → 最後刪 `User`。
- **硬刪**：`User`、`UserMemory`(該 userId 全部，含軟刪的)、`EmergencyContact`、
  `LineLinkCode`、`AuthToken`、`AuthSession`(S2 新增，全部撤銷後刪除)、`SosSession`(本人發起的)、`Review`(個人言論)。
- **匿名化而非硬刪**：`HazardReport` → `reporterId = null` 且清空 `rawExifLat/rawExifLng`。
  > **取捨（使用者已拍板 2026-08-18：選匿名化）**：障礙回報是公共安全資料，會餵進路線規劃與危害提示。
  > 硬刪會讓其他使用者的路線品質退化，所以選擇匿名化保留。若法遵要求硬刪，這條要改。

**S3b 位置與個資保存期限** — 新增 `src/modules/privacy/retention.job.ts`
（沿用 `hazard-report.expire.ts` 的 `setInterval` 模式，不引入新的排程套件）

| 資料 | 期限 | 做法 |
|---|---|---|
| `SosSession`（已 resolved） | 90 天 | TTL index on 新增的 `purgeAt` 欄位 |
| `EmergencyContact.lastLineLat/lastLineLng` | 30 天 | retention job 清成 `null`（不能用 TTL，它不是獨立文件） |
| `HazardReport.rawExifLat/rawExifLng` | 30 天 | retention job 清空（公開座標保留，原始 EXIF GPS 精度過高） |
| `UserMemory`（已軟刪） | 30 天 | retention job 硬刪 |
| `LineLinkCode` | 依既有 `expiresAt` | 改成真正的 TTL index（`expireAfterSeconds`） |

**S3c audit log** — 新增 `src/model/access-audit.model.ts`

- 只記「**A 讀取 B 的位置或對話**」，不記一般讀寫（否則量爆炸且沒人看）。
- 覆蓋端點：`GET /sos/sessions/:token/public`（`sos.router.ts:46-50`）、
  `GET /sos/sessions/:id`、`GET /sos/sessions/:id/stream`（`sos.router.ts:52-57`）、
  LINE 家人代理查詢（`line-agent.service.ts:36-59`）。
- 欄位：`actor`（`userId` / `lineUserId` / `ip:sha256(ip)`）、`subjectUserId`、`resource`、
  `action`、`createdAt`。TTL 180 天。
- 寫入必須是 **fire-and-forget，不得阻塞或讓主流程失敗**（SOS 是救命路徑）。

### 驗收

1. 建帳號 → 建 review／emergency contact／memory → `DELETE /user/account` → 各 collection 用該 userId 查詢皆為空；`HazardReport` 仍在但 `reporterId` 為 null。
2. 舊 access token 在刪除後打任何受保護端點 → 401/403。
3. 密碼錯誤時 `DELETE /user/account` → 403，且**資料一筆都沒少**。
4. `collection.indexes()` 斷言 `SosSession.purgeAt` 與 `AccessAudit.createdAt` 的 `expireAfterSeconds` 存在。
5. retention job 用假時間戳跑一輪 → 過期的清掉、未過期的留著。
6. 讀他人 SOS 公開頁 → `AccessAudit` 多一筆且 `subjectUserId` 正確。

---

## 6. S4（P1）— 送往 Gemini 的座標降精度

### 現況（已核實）

| 位置 | 送出內容 | 精度 |
|---|---|---|
| `config/ai/chat-prompt.ts:76` `withUserLocation()` | 使用者原始經緯度 | **完整精度** |
| `modules/voice/voice-prompt.ts:71-73` | 使用者原始經緯度 | **完整精度** |
| `modules/ai/ai.chat.controller.ts:121,130-133` | 完整對話原文 ＋ 使用者記憶 `promptText`/`content` ＋ memory `_id` | 原文 |

既有的 `redactValue()`（`live-bridge.ts:146-168`，座標降到小數 2 位）**只用於本地 trace log**，
`redactPreciseCoordinates()`（`memory.service.ts:100-107`）**只用於存 DB 前**。
兩者都沒有套用在對外送出的路徑上。

### 改動

1. 新增 `src/utils/geo-privacy.ts`，匯出純函式 `coarsenCoordinate(value, decimals)`。
2. `chat-prompt.ts:76` 與 `voice-prompt.ts:71-73` 寫進 prompt 的座標一律降到**小數 4 位**（≈11 公尺）。
3. **工具呼叫（`planAccessibleRoute` 等）仍用原始精度** —— 那些是打自家後端，不經過 Gemini。
   模型看到的是 11 公尺級，實際路線規劃仍然精確，導航品質不受影響。
4. 語音路徑（`live-bridge.ts:519-524`）若有獨立的座標注入點，同樣處理。

> 為什麼是 4 位不是 3 位：3 位 ≈ 110 公尺（街廓級）對「附近有無障礙廁所嗎」夠用，
> 但對逐步導航（判斷使用者在路口的哪一側）不夠。4 位是能保住導航語意的最低精度。

### 接受風險（明列，不假裝解決）

**完整對話原文送往 Gemini 是 LLM 產品的本質，無法去識別化。**
本計畫不嘗試遮蔽對話內容，改為要求：
- 補一份隱私政策文件，明列「對話內容與約 11 公尺精度的位置會送往 Google Gemini」。
- 見 S8：`MEMORY_ENCRYPTION_KEY` 未設時記憶明文入庫，必須修掉。

### 驗收

單元測試直接斷言產出的 prompt 字串：正則抓出座標，小數位數必須 ≤ 4；
且同一次請求傳給 `planAccessibleRoute` 的參數仍是原始精度。

---

## 7. S5（P2）— rate limiter 的失效行為

### 現況（已核實，與稽核報告有出入）

12 個 limiter 中，只有 `resetLimiter` 是 `passOnStoreError: false`（`user.middleware.ts:71-76`），
其餘全部 `true`。全部使用預設 IP keyGenerator，**無任何以 userId 為 key 的限流**。

⚠️ 稽核報告暗示「Redis 掛掉時登入節流整組失效」需要修正：
`REDIS_URL` **未設定**時 `makeStore()` 回 `undefined` → express-rate-limit 退回 in-memory store，
**仍然限流**（只是不跨實例、重啟歸零）。真正的洞只在「Redis 有設定但執行期出錯」這條路徑。

### 改動

對 `loginLimiter`、`registerLimiter`、`resendLimiter`、`forgotLimiter`、`passwordLimiter` 五個採**雙層**：

1. 前置一層 **in-memory backstop limiter**（不傳 store，額度放寬為 Redis 層的 3 倍）。
2. 後面的 Redis limiter **維持 `passOnStoreError: true`**。

> **審核 B4 修正**：原本第 2 點寫的是改成 `passOnStoreError: false`（fail-closed）。
> 已核實那會壞事：`express-rate-limit@8.6.2` 在該值為 false 時走 `throw error`
> （`node_modules/express-rate-limit/dist/index.cjs:942`），**不進 `handler`** ——
> 結果是全部登入請求回 **500**，正是本節開頭說要避免的「Redis 一抖就全站無法登入」，
> 只是把 503 換成 500。repo 既有註解早就寫明這件事（`user.middleware.ts:30`），是我沒讀到底。
> backstop 本身就是失效補償，第二層不需要也不應該 fail-closed。

這樣：Redis 正常 → 嚴格額度生效；Redis 執行期出錯 → 第二層放行但記錄，
而 backstop 已經先擋過一輪，單機仍有天花板，不會出現「暴力破解防線靜默消失」，
也不會出現「Redis 抖一下就沒人能登入」。

3. store error 時改用可辨識標記 `console.error("[ratelimit] store error", ...)`（現在是靜默）。
4. 註解必須寫清楚**取捨結果**：不只寫「為什麼 fail-open」，要寫「fail-open 期間的風險由 backstop 補償」。
   稽核報告點名現有註解缺的就是後半句。

> 這比稽核報告建議的「fail-closed 回 503」更好，理由是後者會讓 Redis 一抖就全站無法登入。
> 這是刻意偏離，列在此供審核。

### 驗收

注入一個必定拋錯的 store，打 `POST /auth/login`：
1. 超過 backstop 額度時回 **429**（改動前會被放行 → 測試先紅後綠）。
2. **未**超過 backstop 額度時回 **200，不是 500**（審核 B4 專門守這條；
   原設計在這條路徑上會回 500，而原驗收只測第 1 條，永遠測不到）。
3. store error 有被 `console.error` 記錄。

---

## 8. S6（P3）— 兩個設定不一致

### 8.1 refresh cookie 存活期 vs refresh JWT 有效期

現況：cookie `maxAge` = **7 天**（`config/lib.ts:75-80`），refresh JWT TTL = **1 天**（`config/jwt.ts:9`）。
第 2–7 天 cookie 還在但 token 已被 `verifyRefreshToken` 拒絕，使用者體感是「莫名其妙被登出」。

**使用者已拍板（2026-08-18）：選 (a)，refresh JWT 拉長到 7 天對齊 cookie。**

| 選項 | 做法 | 代價 |
|---|---|---|
| **(a) 拉長 JWT 到 7 天對齊 cookie** ✅**採用** | `config/jwt.ts:9` 改 `7d`，`AuthSession.expiresAt` TTL 同步為 7 天 | 外洩的 refresh token 風險窗口從 1 天變 7 天；但它走 httpOnly cookie，且 S2 完成後可用 `tokenVersion` 撤銷 |
| (b) 縮短 cookie 到 1 天對齊 JWT | `config/lib.ts` 用 `jwt.ts` 匯出的同一常數推導 | 使用者從「7 天免登入」退化成「1 天免登入」，是明顯的 UX 退化 |

無論選哪個，**cookie maxAge 與 JWT TTL 必須由同一個匯出常數推導**，不得各寫各的。

### 8.2 三個端點沒掛 limiter

`/auth/verify-email`、`/refresh`、`/logout`（`user.router.ts:65-69,95,110`）補掛 limiter。

補充核實：email 驗證 token 是 `crypto.randomBytes(32).toString("base64url")`（256-bit，
`user.auth.service.ts:79`），**暴力破解不可行**，稽核報告標的「待確認」可以結案為「不是漏洞」。
但仍該掛 limiter 防單純濫用。

---

## 9. 新發現（不在稽核報告內）

### S7 — 密碼重設 token 不是隨機值，而是 HMAC(secret, jobId)

- **證據**：`user.auth.service.ts:322-325`，實際寄出的 token =
  `HMAC-SHA256(PASSWORD_RESET_TOKEN_SECRET, "password-assistance:" + jobId)`。
  有 secret ≥32 bytes 的檢查（`:316-321`），TTL 1 小時，一次性消費（`user.auth.repository.ts:121-165`）。
- **設計動機**：讓 queue 重試時能重算出同一個 token（冪等）。
- **風險**：安全性完全依賴 secret 不外洩。若 secret 外洩且 jobId 可推測，攻擊者可離線重算任意重設連結；
  隨機 token 則必須同時攻破 DB。
- **建議修法**：改用 `randomBytes(32)`，DB 只存 hash；冪等性改用 `jobId → tokenHash` 的映射保存，
  重試時讀回同一筆而非重算。
- **狀態**：✅ **使用者已拍板 2026-08-18：納入本輪**，併入 B 批（同模組）。
- **驗收**：同一個 jobId 重試兩次必須拿到**同一個** token（冪等未被破壞）；
  且兩個不同 jobId 產生的 token 不得能從彼此推導（改動前後各跑一次，證明不再是 HMAC 可重算的）。

### S8 — `MEMORY_ENCRYPTION_KEY` 未設定時，AI 記憶明文入庫且靜默

- **證據**：`memory.service.ts:114-131`。`memoryEncryptionKey()` 在環境變數未設時回 `null`，
  加密函式的 `!key` 分支**直接 return 原文**，沒有警告、沒有失敗。
- **影響**：稽核報告 §5.4 把「AI memory 以 AES 加密存放」列為做得好的地方，
  但那是**條件式**的 —— 部署時漏設一個環境變數，加密就靜默消失。
- **建議修法**：啟動時若記憶功能可用而金鑰未設 → fail-fast（或至少 `console.error` 明確警示並停用記憶功能）。
  不要讓「以為有加密」和「其實沒加密」在外部看起來一樣。

---

## 10. 後續案（本輪明確不做）

- `/a11y/accessible-route`、`/line/route-preview` 補限流（會打 OTP／Google／Gemini，目前全裸）。
- 既有 4 份重複的 limiter `makeStore` 收斂到 S1-2 的共用 factory。
- `accessible-route.controller.ts` 的 `resolveOptionalUserId` 收斂到 S1-1 的 `optionalAuth`。
- `GET /user/sessions`（列出我的登入裝置）＋ `DELETE /user/sessions/:id`（遠端登出某裝置）——
  S2 的資料結構已支援，但那是新功能不是資安修補。
- `AuthSession` 狀態快取到 Redis（先用 Mongo indexed 查詢，有效能數據再優化）。
- 稽核 §4.5 結構化 logging ＋ request id（沒有它，本計畫加的 audit log 與限流告警都難追）。

---

## 11. 失敗行為與回滾

- 每一批獨立成一個 commit，可單獨 revert。
- S1 的 limiter 若額度訂太緊造成誤擋：額度是模組常數，改一個數字重新部署即可，不涉及資料。
- **S2 是破壞性變更**：舊格式（無 `sid`）的 token 一律 401，部署當下全體使用者被登出一次。
  回滾程式碼可以讓舊 token 重新被接受（因為它們只是驗簽失敗，不是被銷毀），
  但 `AuthSession` collection 會留下孤兒資料，且回滾期間撤銷能力歸零。
  必須寫進前端遷移文件（新增 `docs/FRONTEND_MIGRATION_AUTH_SESSIONS.md`）。
- S2 的並發 refresh 條件更新若寫錯，症狀是**使用者隨機被登出**（兩個並發 refresh 互判重用）。
  這是最容易在測試環境看不出來、上線才爆的一條，驗收第 4 條專門守它。
- S3 的刪除是**不可逆**的。實作時必須先在測試環境跑過完整刪除流程，
  且 `DELETE /user/account` 的路由註冊要放在最後一步。
- S3b 的 TTL index 上線後會**立即開始刪除超過期限的既有資料**。
  上線前必須先確認正式環境有多少筆會被立刻清掉（先跑 count 查詢，不要直接建 index）。

---

## 12. 驗證指令

```bash
pnpm run typecheck     # 必須 exit=0
pnpm run lint          # 不得新增 error（warning 數量不得增加）
pnpm run lint:arch     # 必須 exit=0
pnpm test              # 全綠，且新增的測試在「改動前」必須是紅的
pnpm run build         # 必須 exit=0
```

**每一批交付時必須回答**：「我跑過的檢查裡，哪一條會在這個修改壞掉時變紅？」
逐條答不出來就是零覆蓋。

---

## 13. 使用者已拍板的四個取捨（2026-08-18）

| # | 問題 | 決定 | 影響 |
|---|---|---|---|
| S2 | 登出撤銷粒度 | **新增 refresh token 落地表，做 per-device 撤銷** | B 批從 0.5 小時擴大到 2–3 天；順帶解掉 rotation 與重用偵測（原列在 §10 後續案）；部署當下全體使用者被登出一次 |
| S3a | 刪帳號時的障礙回報 | **匿名化保留**（`reporterId = null`、清空原始 EXIF GPS） | 其他使用者的路線品質不受影響 |
| S6.1 | refresh 有效期 | **JWT 拉長到 7 天對齊 cookie** | 維持 7 天免登入；風險窗口由 S2 的 per-device 撤銷與重用偵測補償 |
| S7 | 密碼重設 token | **納入本輪，改成隨機值** | 併入 B 批 |

> S2 選了重方案之後，§10 後續案的「refresh token rotation ＋ 重用偵測」已被納入本輪，故從該清單移除。

---

## 14. 審核紀錄

- **2026-08-18 Claude（Opus）fresh-context 計畫審核：`BLOCKING x 4`，四條全部採納並已改入本計畫。**

  | # | 問題 | 落點 | 已修正處 |
  |---|---|---|---|
  | B1 | 簽發 token 的入口有 6 個不是 3 個（`verifyEmail`／`resetPassword`／`changePassword` 漏列），照原計畫做會「改完密碼立刻被登出且拿不到可用 token」 | S2-6 | 收斂到 `sendSession()` 一處＋硬性順序＋驗收第 9 條 |
  | B2 | 「`jti !== currentRefreshJti` 即判定重用」在並發 refresh 下**必然**誤觸發全域登出；條件更新只防寫入覆蓋，不改變分類 | S2-4 步驟 3 | 改三分類＋`previousRefreshJti` 30 秒寬限窗 |
  | B3 | `expiresAt` 只在建立時設定，會把活躍使用者每 7 天硬踢一次（現況 cookie 是滑動的） | S2-4 步驟 4 | rotation 時延展 `expiresAt`＋驗收第 10 條 |
  | B4 | `passOnStoreError: false` 是 `throw` 不是回 429（`dist/index.cjs:942`），S5 與 S1-3 都會變成 **500** 並破壞信封契約 | §3 S1-3、§7 | 兩處都改回 `true`＋前置 in-memory backstop＋錯誤記錄 |

  事實抽驗 18 條全部相符，僅 4 處行號字面偏差（不影響修法）。
  審核者另代查確認：全 repo 的 token 驗證入口只有 `authenticateToken` 一個，
  LINE bot 與 SOS `shareToken` 公開頁不走 JWT，故 `sid` 破壞性變更沒有波及計畫未列的入口。

- **2026-08-18 Codex（Sol）計畫審核：失敗，額度耗盡。**
  `task-msxz9vk8-gcrsle` 5 秒內回 `You've hit your usage limit ... try again at Aug 20th, 2026 3:35 PM`。
  依 `CORE.md` §跨模型協作第 4 條 fail-open 降級：已於實作歸屬帳本記 `FALLBACK`（reason=quota），
  改派 Claude fresh-context subagent 依同一受限 rubric（只准提 BLOCKING）審核。
