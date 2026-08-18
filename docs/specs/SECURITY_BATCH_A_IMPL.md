# 實作派工：A 批 — AI／LLM 端點分層限流（P0）

**上游計畫**：`docs/specs/SECURITY_HARDENING_PLAN.md` §3（已經過使用者核准與一輪 BLOCKING 審核）。
本檔是該計畫 **A 批**的實作交辦，範圍只有 §3，其他批次不在本次工作內。

---

## 1. 任務目標

`POST /api/v1/ai/chat`、`/ai/intent`、`/ai/explain` 目前**同時沒有認證也沒有任何限流**
（`src/modules/ai/ai.router.ts:28-38`），任何匿名使用者可無限次消耗 Gemini 與 Google Places 額度。
`GET /api/v1/a11y/reviews/summary`（`src/modules/review/review.router.ts:23-27`）同樣會打 Gemini 且全裸。

目標：**在不改變這些端點「匿名可用」的對外契約前提下**，加上分層限流。

---

## 2. 絕對不可以做的事（禁改範圍）

1. **不得**給 `/ai/chat`、`/ai/intent`、`/ai/explain`、`/a11y/reviews/summary` 加上強制認證。
   這四支的匿名可用是**刻意的產品契約**，寫在 `docs/FRONTEND_MIGRATION_AUTH_BOUNDARIES.md:9,19`
   （`PUBLIC_OPTIONAL_AUTH`，呼應需求 B8）。加認證＝破壞契約＝這次工作失敗。
2. **不得**改動既有 4 份 limiter（`user.middleware.ts`、`place-search.middleware.ts`、
   `hazard-report.middleware.ts`、`line.middleware.ts`）。它們的重構是另一個批次的事。
3. **不得**改 `src/modules/accessible-route/`、`src/modules/user/`、`src/config/jwt.ts`、
   `src/config/auth.ts`、`src/middleware/middleware.ts`。那些屬於 B 批。
4. **不得**改動任何 AI prompt 的文字內容。
5. **不得**改 `src/scripts/`、GTFS／OTP 相關程式、任何 model。
6. **不得**新增環境變數。額度寫成模組常數。

---

## 3. 工作範圍（允許新增／修改的檔案）

| 檔案 | 動作 |
|---|---|
| `src/middleware/optional-auth.middleware.ts` | 新增 |
| `src/middleware/rate-limit.ts` | 新增 |
| `src/modules/ai/ai.middleware.ts` | 新增 |
| `src/modules/ai/ai.router.ts` | 修改（掛載） |
| `src/modules/ai/ai.chat.controller.ts` | 修改（`resolveAuthUser` 改讀 `req.auth`） |
| `src/modules/review/review.router.ts` | 修改（掛載） |
| 對應 `*.test.ts` | 新增／修改 |

---

## 4. 現有背景（實作前必讀，這些都已核實）

- **既有 limiter 模式**：`src/modules/user/user.middleware.ts:9-22` 的 `makeStore()` 是範本——
  `redisClient` 為 null 時 `return undefined`，`rateLimit({store: undefined})` 會退回
  express-rate-limit 內建 in-memory store（**仍有限流**，只是不跨實例）。有 Redis 時用
  `RedisStore` 並以 `redisReady()`（`src/config/redis.ts:59-90`）等待連線就緒。
- **`express-rate-limit@8.6.2` 的兩個硬事實**：
  1. 自訂 `keyGenerator` 若直接用 `req.ip` 而不經套件具名匯出的 **`ipKeyGenerator` helper**，
     IPv6 使用者可逐位址繞過限流。**務必呼叫該 helper。**
     ⚠️ 2026-08-18 實測修正：原本寫「套件會拋 `ValidationError`」是錯的——該 throw 會被
     `wrappedValidations` 攔下、只印 console，請求照樣 200。**套件不構成保護，只能靠測試守。**
  2. `passOnStoreError: false` 時走 `throw error`（`node_modules/express-rate-limit/dist/index.cjs:942`），
     **不進 `handler`** → 回應是 **500 不是 429**。這也是 `user.middleware.ts:30` 註解在講的事。
     所以本次**一律 `passOnStoreError: true`**，靠 backstop 補償。
- **`trust proxy` 已正確設為 hop count**（`src/app.ts:51`），IP-key 限流可用。
- **既有的可選認證邏輯**有兩份複寫：`ai.chat.controller.ts:24-31` 的 `resolveAuthUser`、
  `accessible-route.controller.ts:16-27` 的 `resolveOptionalUserId`。行為必須完全比照。
  本次只收斂前者（同一路徑），**後者不動**。
- **回應信封**：所有回應走 `sendResponse()`（`src/config/lib.ts`），
  code 取自 `ResponseCode`（`src/types/code.ts`，已有 429）。
- **測試 harness**：`tests/helpers/test-helpers.ts` 的 `buildTestApp()` 與 `buildAuthorizationHeader()`；
  route 測試用 supertest 跑真實 Express app。

---

## 5. 要做的四件事

### S1-1 `src/middleware/optional-auth.middleware.ts`（新增）

可選認證中介層，行為**必須與 `ai.chat.controller.ts:24-31` 的 `resolveAuthUser` 完全一致**：

- 無 `Authorization` header → `next()`，不注入 `req.auth`（匿名放行）
- 有 header 但 **token 過期** → 401（`ResponseCode.UNAUTHORIZED`）
- 有 header 但 **token 無效** → 403（`ResponseCode.FORBIDDEN`）
- 有效 → 注入 `req.auth = { userId, user }` 後 `next()`

> 這一層是 S1-3 的前置依賴：limiter 的 keyGenerator 必須先知道 userId 才能分流。

同時把 `ai.chat.controller.ts` 的 `resolveAuthUser` 改成讀 `req.auth`（不要再自己解一次 token）。

### S1-2 `src/middleware/rate-limit.ts`（新增）— 共用 factory

```
createRateLimiter({ prefix, windowMs, limit, keyBy })
```

- `keyBy: "ip" | "userOrIp"`
- `"userOrIp"`：`req.auth?.userId` 存在 → `"u:" + userId`；否則 → `ipKeyGenerator(req.ip)`
- store 沿用 `user.middleware.ts:9-22` 的模式（Redis 有就用、沒有就 undefined）
- `passOnStoreError: true`，且 **store error 時必須 `console.error("[ratelimit] store error", { prefix, err })`**，不得靜默
- **429 必須走 `sendResponse()` 統一信封**（`ResponseCode.TOO_MANY_REQUESTS`），
  不得是 express-rate-limit 的預設純文字 —— 否則破壞既有回應契約
- `standardHeaders: true` / `legacyHeaders: false`（比照既有 limiter）

### S1-3 `src/modules/ai/ai.middleware.ts`（新增）— 三層限流

額度寫成**模組常數**（不吃環境變數）：

| 端點 | 身分 | burst | 每日總量 |
|---|---|---|---|
| `POST /ai/chat` | 匿名（IP） | 10 / 10 min | 60 / 24 h |
| `POST /ai/chat` | 已登入（userId） | 40 / 10 min | 400 / 24 h |
| `POST /ai/intent`、`/ai/explain` | 匿名（IP） | 30 / 10 min | 200 / 24 h |
| `POST /ai/intent`、`/ai/explain` | 已登入（userId） | 60 / 10 min | 600 / 24 h |
| `GET /a11y/reviews/summary` | 不分身分（IP） | 20 / 10 min | 200 / 24 h |

三層（順序即掛載順序）：

1. **in-memory backstop**（不傳 store，額度為上表 burst 的 **3 倍**）——
   Redis 執行期出錯時的補償，確保單機仍有花費天花板。
2. **burst limiter**（Redis，上表 burst 值）
3. **daily limiter**（Redis，`windowMs = 24h`，上表每日值）

匿名與已登入必須是**不同的 limiter 實例、不同 prefix**，否則兩種身分的額度會互相污染。

### S1-4 掛載

- `ai.router.ts` 的 `/intent`、`/explain`、`/chat`：
  `optionalAuth → backstop → burst → daily → validateRequest → controller`
- `review.router.ts` 的 `/reviews/summary`：掛對應的 IP-key limiter（不需要 optionalAuth）

---

## 6. 驗收條件（可機械檢查，逐條都要有測試）

route-level integration test（supertest）：

1. 不帶 token 連打 `POST /ai/chat` 第 11 次 → **429**，且回應是統一信封（`ok:false`、`code:429`、有 `message`）。
2. 帶**有效** token 打第 11 次 → **200**（證明 userId key 與 IP key 是分開的桶，額度沒互相污染）。
3. 帶**過期** token → **401**；帶**無效** token → **403**。
   （證明沒有靜默降級為匿名，守住 `AUTH_BOUNDARIES.md:19` 的契約。）
4. 未設 `REDIS_URL` 時，不帶 token 連打仍會在第 11 次被擋（證明 in-memory fallback 有效）。
5. **注入一個必定拋錯的 store**：未超過 backstop 額度的請求必須回 **200，不是 500**；
   超過 backstop 額度才回 429；且 `console.error` 有被呼叫。
   （這條專門守 `passOnStoreError` 的陷阱，不可省略。）
6. `/ai/intent`、`/ai/explain`、`/a11y/reviews/summary` 各至少一條「超過額度回 429」的測試。

指令全綠：

```bash
pnpm run typecheck    # exit=0
pnpm run lint         # 不得新增 error，warning 數不得增加
pnpm run lint:arch    # exit=0
pnpm test             # 全綠
pnpm run build        # exit=0
```

---

## 7. 風險限制

- **不得**改動任何 model／DB schema。
- **不得**新增第三方依賴（`express-rate-limit`、`rate-limit-redis`、`ioredis` 都已在專案內）。
- **不得**改動既有端點的成功路徑行為：本次只新增「超量時回 429」這一種新結果。
- 額度常數若你認為明顯不合理，**照表實作**，把疑慮寫在回報裡，不要自行改數字。

---

## 8. 回報要求（≤40 行）

1. 改了／新增了哪些檔案（逐檔一行說明）。
2. 六條驗收各自的測試檔案:行號，以及 `pnpm test` 的實際結果數字。
3. **明確回答**：「我跑過的檢查裡，哪一條會在這個修改壞掉時變紅？」逐條對應第 6 節的六個驗收。
4. 未解決問題、你認為計畫有誤的地方、以及任何你**沒做**的部分（如實列出，不要靜默略過）。
