# taipei-accessible-backend 產品級工程稽核報告

- 稽核日期：2026-08-17
- 稽核範圍：整個 repo（後端；本專案無前端程式碼，前端章節不適用）
- 稽核 commit：`7c11886`（main，working tree 乾淨）
- 稽核者：Claude Opus 5，`product-grade-audit` skill
- 本輪性質：**唯讀稽核，未修改任何實作程式碼**。突變抽測全部在拋棄式 git worktree 進行（見 §7）

> 與 `docs/reports/architecture-audit.md`（2026-06-15）的關係：那份的七片遷移已全部落地，本報告
> 不重複它已解掉的問題，只記錄**它沒涵蓋的面向**與**它建立的護欄實際守住多少**。

---

## 0. 一頁摘要

這個 repo 的**工具鏈與流程紀律已經在產品級**——CI 完整（arch check → build → lint → format → typecheck →
coverage-gated test → python test → audit）、無 `continue-on-error`、typecheck 全綠、依賴零漏洞、
分層骨架（router → controller → service → repository）在有後綴的檔案上守得住。這不是原型。

但它有一個**共通的失效模式**：**護欄看起來全綠，因為護欄沒有覆蓋到真正該守的地方。**同一個模式出現三次——

1. `pnpm run lint` 沒有 `--max-warnings=0`，所以 585 個 `any`／`!` 永遠不會擋 CI。
2. `check-architecture.mjs` 只認 6 種檔名後綴，`src/` 下 325 個非測試檔中 **219 個（67%）不在檢查範圍**，
   包含 `config/auth.ts`、所有 adapter、planner、agent-tools。它「passed」不代表分層乾淨。
3. 測試 1409 個全綠、覆蓋率過門檻，但**突變抽測 7 個關鍵行為有 4 個存活**——密碼比對、
   評論作者檢查（更新／刪除）、危害回報過期條件，改壞了測試不會紅。

**要先講清楚一件事，因為它決定修法**：這個 repo 的測試問題**不是造假**。
逐一看過 5 個最可疑的 commit diff（§6.8）後，沒有任何「為了讓測試過而改測試」的證據，
其中 `f2bc34ba4` 反而是修 bug 時把測試**加嚴**。它的問題是**測試寫在錯的層**——
route 測試把 service `vi.mock` 掉、只驗狀態碼透傳；repository 測試用真實 Mongo 驗 query 建構；
**中間那層（商業規則所在）兩邊都沒覆蓋到**。這兩件事修法完全不同：造假要修文化，錯層只要補測試。

如果只做三件事：**(1) 補上 §7.3 那四個存活行為的真測試（寫在 service 層，不是 route 層）；
(2) 把 `/api/v1/ai/chat|intent|explain` 掛上認證與 rate limit；(3) 裝上 request id 與結構化 logger。**

**成熟度速覽**

| 面向                 | 現況                                                                                      | 差距                                  |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| 模組化與分層         | 🟡 骨架正確，但 67% 檔案不受 arch check 保護；45 處跨模組 reach-in；1 個循環              | 護欄覆蓋率，不是骨架                  |
| API 契約             | 🟢🟡 spec 從程式碼產生、回應信封統一、WebSocket 有 schema；但無一致性驗證、7 條路由未驗型 | 差一個「路由 vs spec 差集為空」的測試 |
| 型別與工具鏈         | 🟡 typecheck 全綠、strict 開啟，但 585 warnings 不擋 CI                                   | `--max-warnings` 未設                 |
| **測試真實性**       | 🔴 **7 個突變 4 個存活**；route 測試 mock 掉 service，service 測試沒有對應 case           | service 層商業規則零覆蓋              |
| 測試分層             | 🟡 repository 有真 DB 測試（21 個）、route 有真 HTTP 測試；**中間與 E2E 完全空白**        | 缺一條端到端旅程                      |
| 錯誤處理             | 🟡 有集中 handler 與統一信封，但無 error 型別階層、79 處 `new Error` 落回 500             | 見 §4.4                               |
| **可觀測性**         | 🔴 **無結構化 logger、無 request id（`src/` 0 命中）**                                    | 線上無法追查                          |
| 設定與 secret        | 🟢 dotenvx、`.env` 從未進版控、git 歷史零真實金鑰                                         | —                                     |
| 資安                 | 🔴 AI 端點無認證無限流；logout 不撤銷 token                                               | 見 §5                                 |
| 隱私（GPS／AI 對話） | 🔴 無帳號／資料刪除端點、無 audit log、位置無保存期限                                     | 見 §5                                 |
| 前端工程             | ⚪ 不適用（本 repo 無前端程式碼）                                                         | —                                     |

---

## 1. 事實基線

這一節只放**實際跑出來的數字**。後面每一條發現都能追回這裡。

| 項目            | 結果                                                             | 指令                                       |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| 技術棧          | TypeScript / Express / Mongoose / pnpm / vitest；455 個 `.ts`    | `repo_scan.sh`                             |
| 規模            | `src/` 非測試 `.ts` 325 個；最大 2298 行                         | 同上                                       |
| **typecheck**   | **exit=0**，零錯誤                                               | `pnpm run typecheck`                       |
| **lint**        | **exit=0**，0 errors / **585 warnings**                          | `pnpm run lint`                            |
| lint 分布       | `no-explicit-any` 445、`no-non-null-assertion` 140               | 見 §3.2                                    |
| **lint:arch**   | **exit=0**，`Architecture boundary check passed.`                | `pnpm run lint:arch`                       |
| **測試**        | **exit=0**，125 檔 / **1409 passed** / 0 skipped / **12.8 秒**   | `pnpm test`                                |
| 覆蓋率          | statements **70.38%** / branches **59.7%** / functions **73.5%** | `pnpm run test:coverage`                   |
| 覆蓋率門檻      | 68 / 58 / 70 / 70（branches 只高門檻 1.7 個百分點）              | `vitest.config.ts:45-50`                   |
| 測試檔 : 原始檔 | 135 : 325（但 vitest 只跑 125 個，見 §7.4）                      | —                                          |
| 斷言總數        | 3434（平均每 case 2.37）                                         | `test_forensics.py`                        |
| 依賴掃描        | **No known vulnerabilities found**                               | `pnpm audit --prod`                        |
| 循環相依        | 1 個                                                             | `npx madge --circular --extensions ts src` |
| git             | 490 commits / 18 merge / 2 位作者（同一人）/ 30 branches         | `repo_scan.sh`                             |

**測試分層的實況（這一段很重要，因為它決定 §7 的洞在哪一層）**：

- **repository 層有真的 integration test**——21 個 `*.repository.integration.test.ts`
  用 `mongodb-memory-server` 起真實 Mongo（`tests/helpers/mongo-test-harness.ts`，
  無靜默降級，連不上會 throw），跑真實 Mongoose model 與 2dsphere 查詢。已實跑確認。
- **route 層有真的 HTTP integration test**——`*.routes.test.ts` 用 supertest 跑真實
  Express app（router → middleware → validation → controller → envelope），但**把 service `vi.mock` 掉**。
- **中間那層沒有**：沒有任何測試讓「真實 service 邏輯」跑在「真實 DB」上。
  也沒有任何 E2E 把三層疊起來走完一條使用者旅程。

所以缺口不是「沒有測試」，是**商業規則所在的 service 層，兩邊都沒有覆蓋到**——
上面被 mock 掉、下面只測 query 建構。§7 的四個存活突變全部落在這一層，不是巧合。

---

## 2. 模組化與分層

### 2.1 P2 — 架構護欄只覆蓋 33% 的檔案，「passed」是假的安心

`src/scripts/check-architecture.mjs`（305 行）以**檔名後綴**判定角色，只認
`.router` / `.controller` / `.service` / `.repository` / `.orchestration` / `.schema` 六種。

- **證據**：`src/` 下非測試 `.ts` 共 325 個，其中只有 **106 個**有這六種後綴；**219 個（67%）
  完全不被檢查**——包含所有 `adapters/`、`middleware/`、`config/`、`utils/`、
  `modules/accessible-route/planners/`、`modules/ai/agent-tools.ts`。
- 另外沒有涵蓋的：repository 裡有沒有商業規則、Mongoose document 有沒有被直接序列化、
  service→service 的跨模組 reach-in、module-level 可變狀態、god file。
  這些不是 import 層級的問題，regex 掃描抓不到。
- **可重跑**：`pnpm run lint:arch`；`cat src/scripts/check-architecture.mjs`
- **怎麼修**：把角色判定從「檔名後綴」改成「目錄位置」（`modules/*/` 底下未標角色的檔案至少要
  適用 service 的規則），或明確把不受檢的目錄列成 allowlist 並在輸出裡印出「本次檢查涵蓋 106/325 檔」——
  讓覆蓋率可見，比擴大規則更重要。
- **怎麼驗**：在 `src/modules/ai/agent-tools.ts` 加一行 `import "express"`，`pnpm run lint:arch` 必須變紅。

### 2.2 P2 — 9 個檔案繞過 repository 直接查 DB，其中一個是認證核心

因為檔名沒有 `.service.ts` / `.repository.ts` 後綴，這些檔案全部逃過 §2.1 的檢查。

- **證據**：
  - `src/config/auth.ts:1,33` — `User.findById(userId)`，這是 auth middleware 每個請求都會走的驗證函式，
    完全繞過 `user.repository.ts`
  - `src/modules/ai/agent-tools.ts:25-28` — 直接 import `EmergencyContact` / `LineLinkCode` / `SosSession` / `User`
  - `src/modules/accessible-route/planners/otp-routing.ts:19-22` — 直接 import 4 個 GTFS/站點 model
  - 另有 `route-a11y.ts:18`、`indoor-graph.ts:26-28`、`user.password-assistance.queue.ts:3`、
    `hazard-report.ai-verify.ts:1`、`hazard-report.expire.ts:1`（合計 9 檔）
- **可重跑**：`rg -n "from [\"'].*model/[a-zA-Z0-9_.-]+\.model[\"']" src -g "*.ts" -g "!*.test.ts"`
- **影響**：改 schema 時要同時追九個不在 repository 的查詢點；`config/auth.ts` 那一處讓認證路徑
  無法在不碰 Mongoose 的情況下被測試（這也是 §7 M3 存活的結構原因之一）。
- **怎麼驗**：這 9 個檔案的 model import 清空後 `pnpm run build` 仍能過。

### 2.3 P2 — 45 處跨模組 reach-in，因為模組根本沒有公開出口

`src/modules/*/index.ts` **只 export router factory**（例如 `campus/index.ts` 只有
`export { createCampusRouter } from "./campus.router"`），沒有任何模組公開自己的 service。
所以任何 service-to-service 依賴**必然**是 reach-in 到內部檔——這是結構性的，不是個別失誤。

- **證據**：實測 45 處跨模組 import 非 `index.ts` 的檔案。集中點：
  - `src/modules/ai/agent-tools.ts` 直接 import 12 個模組的 service
  - `src/modules/accessible-route/accessible-route.service.ts` → `../user/user.service`、
    `../environment/environment.service`、`../transit/metro.service`、`../transit/alert.service`
  - `src/modules/voice/live-bridge.ts` → `../agent/tool-catalog`、`../ai/agent-tools`、
    `../accessible-route/route-token.service`、`../transit/alert.store`、`../transit/alert.gateway`
  - 其中 3 處（`a11y.orchestration.ts`）是 arch check 刻意放行的 orchestration 組合，**其餘 42 處無任何規則保護**
- **怎麼修**：讓每個 `modules/*/index.ts` 也 export 該模組對外的 service 介面，並在 arch check 加一條
  「跨模組只能 import 對方的 `index.ts`」。這是一次性的機械改動，之後護欄才有東西可守。
- **怎麼驗**：新增規則後，上面 42 處會全部亮紅；逐一改成走 index 出口後回到綠。

### 2.4 P2 — 兩個 god file 集中在同一個模組

| 檔案                                                       | 行數 | export 數 | 被幾個檔 import |
| ---------------------------------------------------------- | ---- | --------- | --------------- |
| `src/modules/accessible-route/accessible-route.service.ts` | 2298 | 11        | 13              |
| `src/modules/ai/agent-tools.ts`                            | 2166 | **38**    | 7               |
| `src/modules/accessible-route/planners/otp-routing.ts`     | 1459 | 12        | 8               |
| `src/config/ai/tool.ts`                                    | 1002 | 4         | 4               |

深層相對 import（`../../`）共 404 處（不含測試檔），其中 `src/modules/accessible-route` 一個模組
就佔 114 處（約 1/5），與 god file 的集中點吻合。

- **可重跑**：`find src -name "*.ts" ! -name "*.test.ts" -exec wc -l {} \; | sort -rn | head -8`
- **注意**：`agent-tools.ts` 的 38 個 export 中多數是 LLM tool 定義，本質上是一張註冊表而非一個模組，
  拆檔的收益主要在**測試隔離**（現在改任何一個 tool 都要載入全部 12 個模組的 service）。

### 2.5 P2 — 循環相依 1 處

```
modules/accessible-route/accessible-route.service.ts
  → modules/user/user.service.ts
  → adapters/line.adapter.ts
  → modules/line/line.types.ts
  → （回到 accessible-route.service.ts）
```

- **可重跑**：`npx madge --circular --extensions ts src`
- 環的成因是 `line.types.ts` 反向依賴 `accessible-route.service.ts` 的型別。把該型別下沉到
  `src/types/` 即可斷環（與 `ARCHITECTURE.md` Phase 8 已經對路由型別做過的處置同一招）。

### 2.6 P2 — 兩處把原始 Mongoose document 直接當 API 回應

- **證據**：
  - `src/modules/user/user.controller.ts:29,40-46`（`info` handler）
  - `src/modules/user/user.controller.ts:194-196,206`（`refresh` handler）
  - 兩處拿到的都是 `User.findById()` 的原始文件（`user.repository.ts:12`，無 `.lean()`、無 `.select()`）
- **不會洩漏密碼**（`user.model.ts:9,29` 已把 `passwordHash`、`passwordResetTokens` 標 `select: false`），
  但會把 `tokenVersion`、`__v` 等內部欄位原樣吐給客戶端。
- **關鍵點**：這個 repo **已經有正確做法**——`src/config/jwt.ts:19` 的 `toPublicUser()` 是 allowlist 式白名單，
  只是這兩個端點沒套用。對照組：`emergency-contact.repository.ts:38-42`、`campus.repository.ts:13-14`
  都用明確 `.select()` + `.lean<T>()`。
- **怎麼驗**：`GET /api/v1/user/info` 的回應不得含 `tokenVersion` 與 `__v`；加一個 API test 斷言這件事。

### 2.7 已排除的疑點（列出來是為了證明本報告沒有灌水）

| 疑點                                | 實測結果                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| controller / router 直接查 Mongoose | **零違規**。controller 唯一叫到的是 `service.findById(...)`                                                                                                          |
| service 層拿到 Express `req`/`res`  | **零違規**。`planAccessibleRouteFromRequest` 是命名巧合，接的是已驗證 DTO                                                                                            |
| repository 有商業規則               | 查了 5 個最大的 repository，只有一個邊界案例（`review.repository.ts:150` 的四捨五入與 service 重複），非分層錯置                                                     |
| `GET /a11y/reports/:id` 疑似 IDOR   | **不是漏洞**。`hazard-report.repository.ts:7` 的 `PUBLIC_SELECT = "-reporterId -photoStoragePath -confirmedBy -deniedBy"` 已投影掉回報者身分，屬設計上公開的地圖資料 |
| NoSQL injection                     | **零可達案例**。`validate-request.middleware.ts` 在 Zod 驗證後覆寫 `req.body/query/params` 為白名單值                                                                |
| 指令注入 / 路徑穿越                 | `exec`/`spawn` 只出現在 `src/scripts/*` 離線 CLI；`path.join` 接 request 的唯一命中是寫死常數                                                                        |
| secret 進 git 歷史                  | **零真實金鑰**。`.env` / `.env.keys` 從未被追蹤；`sk-`／`AIzaSy`／`AKIA` 命中全部是註解或範本                                                                        |

### 2.8 P3 — 全域可變狀態 30+ 處

18 個 module-level `let` 單例（`config/redis.ts:11-12,40`、`adapters/line.adapter.ts:11`、
`accessible-route/route-intent.port.ts:14`）＋ 至少 15 個被實際改寫的 `Map`/`Set` 快取
（`config/resilience.ts:61`、`voice/voice.gateway.ts:47`、`transit/alert.store.ts:12-13`）。

多數是合理的連線／連線池／即時狀態單例，**不建議一律消除**；但它們是測試互相污染與並發行為不可預測的
主要來源，值得在測試 setup 明確 reset。列 P3 是因為現在還沒造成已知故障。

---

## 3. 程式碼工程

### 3.1 🟢 做得好的部分（先講，因為這決定後面的修法）

CI（`.github/workflows/ci.yml`）**沒有任何 `continue-on-error` 或 `|| true`**，而且順序正確：
arch check → build → lint → format:check → typecheck（含測試）→ **coverage gated test** → python test → audit。
Actions 全部 pin 到 commit SHA（供應鏈衛生）。husky pre-commit 掛了 `lint-staged`。
tsconfig `strict: true`。這一層不需要動。

### 3.2 P2 — 585 個 lint warning 永遠不會擋 CI

- **證據**：`pnpm run lint` 是 `eslint .`，**沒有 `--max-warnings=0`**（`package.json`），
  所以 exit=0，CI 綠。實測 585 個 warning：`@typescript-eslint/no-explicit-any` **445 個**、
  `@typescript-eslint/no-non-null-assertion` **140 個**。
- 分布最集中：`src/modules/accessible-route`（14 檔）、`src/modules/user`（8 檔）、`src/modules/transit`（7 檔）。
- **影響**：`strict: true` 的價值被 445 個 `any` 抵銷掉一部分，而且沒有任何機制阻止它繼續增加。
- **怎麼修**：不要一次改 585 個。用**棘輪**——把目前數字寫成上限（`--max-warnings=585`），
  每次 PR 只能降不能升，跟你們已經在 `vitest.config.ts:42` 對覆蓋率做的「baseline lock, ratchet up never down」
  完全同一招。
- **怎麼驗**：新增一個 `any` 後 CI 必須變紅。

---

## 4. API 契約、錯誤處理、可觀測性

### 4.1 🟢 API 契約做得比預期好

OpenAPI spec **是從程式碼產生的**，不是手寫 YAML——`@asteasolutions/zod-to-openapi` 從各模組
`.schema.ts` 的 `registry.registerPath()` 組成（`src/openapi/document.ts:19-31`、`src/openapi/registry.ts:1-3`）。
錯誤回應形狀**完全統一**：全 repo 167 處 `sendResponse()` 是唯一產生回應的路徑，
`rg -n "res\.status\(" src -g '!*.test.ts'` 除 `config/lib.ts` 本身外零命中，信封固定為
`{ ok, status, code, message, data?, accessToken? }`。
WebSocket **有 schema**（`src/modules/voice/voice.ws.schema.ts:1-45` 用 zod 定義
`session.start`／`session.end`／`nav.setRoute`／`nav.position`／`nav.cancel`，
`voice.gateway.ts:180,282,296,314,326` 在入口 `safeParse`），不是散落字串。

### 4.2 P2 — spec 與實作沒有一致性驗證，而且 registry 的完整性靠巧合

- **沒有全面一致性檢查**：只有 2 個端點的單點斷言（`a11y.routes.test.ts:289-306`、
  `accessible-route.routes.test.ts:480-497`）檢查特定 path 是否存在於 `/api/v1/openapi.json`，
  不是「所有路由 vs 所有 spec path」的比對。CI 沒有任何 openapi 步驟。
- **實測差距**：實際註冊 82 個 `router.method()`，`generateOpenAPIDocument()` 產出 71 path / 78 method。
  少的 4 個：`DELETE /ai/memories`（`ai.router.ts:73`）、`DELETE /ai/memories/{id}`（`ai.router.ts:67`）
  ——這兩個 `ai.schema.ts` **真的沒寫 `registerPath`**；另兩個是 `POST /line/webhook`、
  `GET /voice/poc`（POC 路由，排除可能是刻意）。
- **registry 完整性靠載入順序**：`src/openapi/document.ts:4-17` 只顯式 import 14 個模組的 schema，
  漏了 `welfare`、`visual-a11y`、`nav-instructions`。目前之所以完整，是因為 `app.ts` 會先載入
  這些模組的 router 而間接載入 schema。**任何不先載入 `app.ts` 就呼叫 `generateOpenAPIDocument()`
  的腳本（例如未來的「靜態產生 spec」CI 步驟）會悄悄少 3 個模組共 6 條路徑。**
- **怎麼修**：補齊 3 個 import、補上兩個 DELETE 的 `registerPath`，
  然後加一個測試：列出所有 `router.method()` 與所有 spec path，差集必須為空（或在白名單裡）。
  這一個測試就能永久取代上面兩個單點斷言。

### 4.3 P2 — 7 條路由沒有 zod 驗證

- `src/modules/a11y/a11y.router.ts:35-37` — `/all-bathrooms`、`/all-ramps`、`/all-elevators`
  三個 GET **完全沒有** `validateRequest`（同檔另外 6 條都有 query schema）
- `src/modules/user/user.router.ts:95-104` — `/refresh`、`/info`、`/line-link-code`、`/a11y-profile` 四條
- **可重跑**：
  `for f in $(find src/modules -name '*.router.ts'); do echo "$f $(grep -cE 'router\.(get|post|put|patch|delete)\(' $f) $(grep -c validateRequest $f)"; done`

### 4.4 P2 — 錯誤沒有型別階層，status 映射散落各 controller

- **有集中的 catch-all**：`src/app.ts:204-220` + `classifyError()`（`app.ts:156-187`）。
- **但它只是兜底**：`classifyError` 只認 `err.status` / `err.expose`，而全 repo **79 處 `new Error(...)`
  幾乎都不帶這兩個欄位**，等於絕大多數錯誤落回 500。
- **沒有共同基底的 error class**：5 個各自獨立——`AuthError`（`user.auth.service.ts:52`）、
  `ResilienceError` / `UpstreamHttpError` / `UpstreamBadPayloadError`（`config/resilience.ts:21,35,49`）、
  `ValhallaRoutingError`（`planners/valhalla-routing.types.ts:1`）。
- **映射散落**：每個 controller 各自 `try/catch` 決定 status，只有 `user.auth.controller.ts:38`
  抽出共用 helper（`sendAuthError`），其餘 inline 判斷（例 `accessible-route.controller.ts:77-84`）。
- **吞掉錯誤 3 處代表案例**：`sos.service.ts:56-63`（LINE 通知失敗只 `console.error`，呼叫端不知道沒送出）、
  `review.service.ts:396-398`（AI 摘要失敗只記 log）、`user.auth.service.ts:180-183`（驗證信寄送失敗）。
  後兩者有把結果往上傳，第一個沒有——**SOS 通知送不出去而呼叫端無感，這是安全功能上的靜默失敗**。
- 🟢 **stack trace 沒有外洩**，而且有測試主動守（`classifyError` 只在 `err.expose === true` 才回原始 message；
  `a11y.routes.test.ts:293` 斷言敏感字串不出現在 body）。

### 4.5 P1 — 沒有結構化 logging，也沒有任何 request/correlation id

- **沒有 logger**：`package.json` 無 `pino`／`winston`。有 `morgan("common")`（`app.ts:65`）
  但那只是一行文字的 HTTP access log，不是應用層結構化 log，而且測試環境還關掉了（`app.ts:64`）。
  應用層**全靠裸 `console.*`**。
- **request/correlation id 完全不存在**：`rg -ni "correlationId|requestId|x-request-id" src` **0 命中**。
  （更正：本報告初稿引用的掃描腳本曾報 5 處，那是掃到 `src/` 以外的檔案，實際 `src/` 是 0。）
- **影響**：一個請求跨 controller → service → adapter → 外部 API 的所有 log 串不起來。
  線上出問題只能用時間戳猜，這在有 LLM 呼叫與多個外部 API（TDX／OTP／Valhalla／Gemini）
  的系統上等於沒有除錯能力。**這是 §0 說的「可監控」缺口，也是本報告 P1 裡最便宜的一條。**
- **console.log 分布**（實測）：`src/scripts/` **214 處**（一次性 CLI，可接受）；
  執行期路徑（`src/modules/` + `src/server.ts`）**17 處**（`server.ts` 7、modules 10，
  例 `voice/live-bridge.ts:186`、`planners/otp-routing.ts:1062`）。`console.error`／`warn` 另計且更多。
- **怎麼修**：裝 pino + 一個產生 request id 的 middleware，把 id 放進 async context，
  logger 自動帶上。17 處執行期 `console.log` 一起換掉。這是半天的工作，收益是線上可查。
- **怎麼驗**：同一個請求的所有 log 行帶同一個 id；`rg "console\.log" src/modules src/server.ts` 為 0。

### 4.6 P2 — 設定散落 67 個檔案，且沒有啟動時驗證

- **證據**：`process.env.` 直接讀取共 **118 處、散落 67 個檔案**（`src/config/` 底下 `jwt.ts`、
  `redis.ts`、`valhalla.ts`、`mqtt.ts` 各讀各的，沒有單一 `env.ts` 匯出全部設定）。
- **沒有啟動時 env schema 驗證**（無 zod／envalid）。而且風格是「缺變數就跑退化路徑」而非「拒絕啟動」：
  `config/redis.ts:1-7` 明文設計成 `REDIS_URL` 沒設就靜默不連線——**這與 §5.5 的 limiter fail-open 疊加，
  等於忘記設一個環境變數就會靜默失去全部登入節流。**
  同型風險：`config/jwt.ts:40,45,51` 是 `process.env.JWT_ACCESS_SECRET ?? ""`，
  secret 沒設時會用空字串簽章（實際上 `jwt.sign` 對空 secret 會 throw，所以會炸不會靜默，但這是運氣不是設計）。
- **寫死的模型名**：`src/adapters/embedding.adapter.ts:3` 的 `EMBEDDING_MODEL = "gemini-embedding-001"`
  **沒有 env 覆蓋**，是唯一真正寫死的；`voice/transcript-corrector.ts:27` 的
  `"gemini-3-flash-preview"` 也是常數。另兩處（`config/ai.ts:18`、`voice/live-bridge.ts:523`）
  有 env 覆蓋，屬合理 fallback。
  （更正：本報告初稿引用的掃描腳本報 9 處，逐一核對後只有 2 處是真的寫死。）
- **寫死的外部 base URL**：三個外部服務待遇不一致——
  **TDX 完全寫死且散落至少 7 個檔案**（`src/config/transit.ts` 12 處、`adapters/tdx.adapter.ts:11`
  的 OAuth token URL，加上 `scripts/build-otp-graph.sh`、`patch_gtfs.py`、`test_serviceday_values.py`、
  `import-tdx-parking.ts`、`import-tdx-bus-vehicles.ts`）；CWA 集中在 `constants/environment.ts:8`（1 處）；
  MOENV 集中在 `air.service.ts:9`（1 處）；🟢 Valhalla 與 OTP **做對了**，是 env 變數
  （`config/valhalla.ts:1-2`、`planners/otp-routing.ts:297`）。
- **怎麼修**：先做一個 `src/config/env.ts` 用 zod 在啟動時驗完所有變數並具名匯出，
  其餘檔案改讀它；TDX base URL 至少收斂成一個常數。不需要一次改 118 處。

---

## 5. 資安與隱私

> 全部為靜態程式碼路徑分析（未發 HTTP request 黑箱驗證），每條均附可達路徑。

### 5.1 P0 — `/api/v1/ai/chat`、`/intent`、`/explain` 同時沒有認證與 rate limit

- **證據**：`src/modules/ai/ai.router.ts:28-38` 只掛了 `validateRequest`，**沒有掛 `middleware`（認證），
  也沒有掛任何 limiter**。對照 `ai.router.ts:39-73` 的 `/ai/memories*` 有掛 `middleware`。
- **可達路徑**：`POST /api/v1/ai/chat` → `ai.router.ts:34-38` → `aiChat`（`ai.chat.controller.ts`）
  → 無任何身分檢查 → Gemini 呼叫 + agent tool loop（最多 5 輪，可觸發 `findGooglePlaces`、
  `planAccessibleRoute` 等會再打外部付費 API 的工具）。
- **影響**：任何匿名使用者可無限次消耗你的 Gemini 與 Google Places 額度；同時請求體的
  `userLocation` 會被原文送進 Gemini 的 systemInstruction（`voice-prompt.ts:72`、`live-bridge.ts:519-524`），
  等於未經認證的第三方可以把任意座標推進你的 LLM 供應商。
- **怎麼修**：掛 `middleware` + 一個以 userId 為 key 的 limiter；若確實需要匿名試用，
  至少要有以 IP 為 key 的嚴格限流與每日總量上限。
- **怎麼驗**：無 Authorization header 的 `POST /api/v1/ai/chat` 必須回 403；
  超過限額的第 N+1 次必須回 429。加成 API test。

### 5.2 P1 — logout 不撤銷已發出的 access token

- **證據**：`src/modules/user/user.controller.ts:228-234` 的 `logout` **只清 cookie**
  （`res.cookie("refreshToken","",{maxAge:0})`），沒有遞增 `tokenVersion`。
  而 `src/config/auth.ts:39` 每個請求都比對 `tokenVersion` 才判定 access token 是否有效，
  `tokenVersion` 只在改密碼與密碼重設時遞增（`user.auth.service.ts:412`）。
- **可達路徑**：token 外洩 → 使用者按登出 → `POST /api/v1/user/logout` 沒有觸及 DB
  → 外洩的 access token 仍可用到自然過期（最長 60 分鐘，`config/jwt.ts:8`）。
- **怎麼修**：logout 時遞增 `tokenVersion`（一行）。
- **怎麼驗**：登出後拿舊 access token 呼叫任一受保護端點必須得到 401/403；加成 API test。

### 5.3 P1 — 無帳號／資料刪除機制，也沒有 audit log

涉及使用者帳號、GPS 定位與 AI 對話紀錄的系統，這兩件事不是加分項。

- **刪除機制**：找不到刪除帳號的端點。硬刪只涵蓋 emergency contact
  （`emergency-contact.repository.ts:95`）、密碼協助 job、refresh token 紀錄；
  AI memory 是軟刪（`memory.repository.ts:8-15` 的 `deletedAt`）且**沒有對應的硬清除排程**。
  使用者無法自助刪除帳號本體、hazard report、review 或整體 AI 對話資料。
  - **可重跑**：`rg -n "deleteOne|findByIdAndDelete|findOneAndDelete|deleteMany" src/modules src/model`
- **Audit log**：`rg -ni "audit" src/` 只命中兩個 GTFS/OTP 資料品質腳本，**沒有任何「誰看了誰的資料」的存取紀錄**。
  發生資安事件時無法回答「哪些使用者的位置或對話被誰讀取過」。
- **保存期限**：`rg -n "expireAfterSeconds" src/model` 只命中 `auth-token.model.ts:19` 與
  `password-assistance-job.model.ts:25`，**位置資料沒有 TTL 或清理排程**。
  hazard report 明確設計為不物理刪除（`hazard-report.expire.ts:9-15` 註解）。
- **怎麼修**：先做最小可行的三件——帳號刪除端點（含連帶資料）、位置資料 TTL index、
  對「讀取他人位置／對話」的端點寫 audit event。

### 5.4 P1 — 位置與對話原文直送 Gemini，未去識別化

- **證據**：`src/config/ai.ts:6-15`（Gemini client）；`voice-prompt.ts:72`、
  `live-bridge.ts:519-524` 把 `userLocation` 原文寫進 systemInstruction 送出。
- **做得對的對照**：語音模組的 `[voice-trace]` log **有**經 `redactValue()` 遮蔽
  （座標砍到小數兩位、token/user_id/phone/email 遮罩，`live-bridge.ts:125-165,186-189`）；
  AI memory 以 AES 加密存放（`enc:v1:` prefix，`memory.service.ts:1-6,36`）且需使用者開啟 `memoryEnabled`。
  也就是說**log 與 DB 兩條路徑已經處理過了，只有第三方供應商這條沒有**。
- **怎麼修**：送給模型的座標降精度（到街廓級即可完成導航語意），或改送相對描述而非絕對座標；
  並在隱私政策明列會送往 Google。

### 5.5 P2 — rate limiter 在 Redis 異常時 fail-open

- **證據**：`src/modules/user/user.middleware.ts` — 除 `resetLimiter` 外，
  login / register / resend / forgot 的 limiter 都是 `passOnStoreError = true`。
- **影響**：Redis 掛掉時登入節流整組失效，暴力破解防線同時消失，而且從外部看不出來。
- **怎麼修**：登入類端點改 fail-closed（Redis 掛掉時回 503 或退到 in-memory limiter），
  並對 store error 出告警。這是取捨題，取捨結果要寫成註解，現在的註解只說明「為什麼要 fail-open」，
  沒說明「fail-open 期間的風險由什麼補償」。

### 5.6 P3 — 兩個設定不一致

- refresh cookie `maxAge` 寫死 7 天（`src/config/lib.ts:75-80`），但 refresh JWT TTL 只有 1 天
  （`config/jwt.ts:9`）。第 2–7 天 cookie 還在但 token 已失效，使用者體感是「莫名其妙被登出」。
- `POST /auth/verify-email`（非 resend）、`/refresh`、`/logout` 三個端點沒掛 limiter
  （`user.router.ts:65-69,95,110`）。前者可否被暴力破解取決於 token 熵值，未驗證，標「待確認」。

### 5.7 🟢 資安上做得好的

CORS 單一設定非萬用字元（`app.ts:59-62`，`CORS_ORIGINS` 無 `*` fallback）；
未發現任何關閉 TLS 驗證（唯一命中 `tdx-mqtt.adapter.ts:40` 是 `rejectUnauthorized: true`）；
密碼 bcrypt cost=12；JWT 一律 `verify` 從無 `decode` 信任；
密碼重設 token 是原子式一次性消費 + TTL（`user.auth.repository.ts:121-140`）；
refresh token 走 httpOnly cookie；SOS 分享連結用 128-bit `crypto.randomBytes(16)` 而非可猜測 id；
`.env` 系列從未進版控。

---

## 6. 測試工程（分層是否名副其實）

### 6.1 🟢 repository 層的 integration test 是真的

21 個 `*.repository.integration.test.ts` 透過 `tests/helpers/mongo-test-harness.ts` 起
`mongodb-memory-server`，`mongoose.connect` 接真實記憶體 Mongo，跑真實 model 與 2dsphere 查詢。
harness **沒有靜默降級**——連不上會 `throw`（`mongo-test-harness.ts:30-41`），
所以「綠燈」代表 DB 真的跑過。已實跑 `hazard-report.repository.integration.test.ts` 確認。

這一層不需要動，而且它是 §7.3 補測試時可以直接複用的基礎設施。

### 6.2 P2 — `.integration.test.ts` 這個命名同時指兩種強度不同的東西

- 20 個是「真的碰 DB」的 repository integration test（§6.1）。
- 但 `accessible-route.stairs.integration.test.ts` **把該模組的核心規劃邏輯也 mock 掉了**：
  `:20-29` `vi.mock("./planners/otp-routing", ...)`，`:85-133` 的 `beforeEach` 把回傳值寫死成
  `degraded: true, warnings: [...], stairs: true`，`:136-158` 只驗證 controller 把這個寫死的值原封吐回。
  **「什麼情況該標記 degraded、warnings 怎麼產生」這個演算法完全沒有被執行到。**
  它確實跨了 HTTP 傳輸層（supertest + `buildTestApp()`），但強度跟另外 20 個完全不同，
  卻共用同一個命名慣例。
- **怎麼修**：命名分開（`*.repository.integration.test.ts` vs `*.routes.test.ts`），
  或把這個檔案改名為 `.routes.test.ts` 以符合它的實際強度。這是零風險的改名，收益是別人不會誤讀。

### 6.3 P1 — 沒有任何 E2E

全 repo 找不到任何測試把「真實 service 邏輯 + 真實 DB + 真實 HTTP」三者疊加走完一條使用者旅程
（例如：註冊 → 登入 → 建立資源 → 用另一支 API 讀回驗證）。
repository integration 只測 DB 層，`*.routes.test.ts` 只測 HTTP 層加 mock 掉的 service，
兩者從未在同一個測試裡疊起來。

**這正是 §7 四個突變存活的結構原因**——service 層的商業規則在兩層之間的縫隙裡。

- **怎麼修**：不需要大量 E2E。**一條**就有價值：註冊 → 登入（用真密碼）→ 建立 review →
  換另一個使用者嘗試刪除（必須 403）→ 本人刪除（必須成功）。這一條同時殺掉 M3、M4、M5 三個突變。

### 6.4 P2 — 101 個路由測試案例只驗 status 不看 body

以「有 status 斷言、完全不查 `res.body` 內容」為標準，`src/modules/**/*.routes.test.ts` 共 101 個案例；
其中約 21 個是成功路徑（200）也不看 body。代表例：

- `src/modules/campus/campus.routes.test.ts:104`（"passes the type code through to the service"）
- `src/modules/a11y/a11y.routes.test.ts:129`（"passes the parsed whitelist to the service"）
- `src/modules/welfare/welfare.routes.test.ts:83`（"returns 200 with no filters"）

判讀上要分開看：**驗參數透傳**對一個薄 controller 是合理的測法，不算裝飾；
**成功路徑只斷言 200 而不看回傳內容**才是問題——回傳空物件也會過。
建議只針對後面那 21 個補 body 斷言。

### 6.5 P2 — OpenAPI「契約測試」只是存在性檢查

6 個測試檔提到 openapi，做法都是打 `GET /api/v1/openapi.json` 再手動斷言某個欄位的 `type` 是什麼
（例 `accessible-route.stairs.integration.test.ts:160-170`）。這只驗證「schema 定義裡有宣告這個欄位」，
**不是用 schema 去驗證真實 response body 合法**（沒有用 ajv 或 `schema.parse(res.body)`）。
真正的 API test 應該拿 spec 當斷言來源，反過來驗實作。

### 6.6 P2 — RAG 向量檢索的核心路徑沒有測試

`src/modules/ai/memory.service.test.ts:114-138`：`searchMemoriesForPrompt` 唯一的案例把
`mockQueryDocuments.mockResolvedValue([])` 寫死成空陣列，測的是「向量無命中時 fallback 到最近記憶」。
**向量真的命中時該回什麼、排序邏輯、相似度篩選，全部沒有案例。**
mock 對象本身是對的（chroma／embedding 是外部依賴），問題是這個服務存在的主要理由是語意檢索，
而測試只覆蓋了它的退路。

### 6.7 P2 — 1115 行的「模擬測試」根本不是測試

`tests/simulations/accessible-route-simulation.ts` **沒有 `describe`／`it`**，是一支用 axios
打 `TEST_API_URL` 的獨立壓測腳本，靠 `NUM_TESTS`／`CONCURRENCY` 跑批次請求收集延遲與成功率。
`package.json` 的 scripts 與 `.github/workflows/ci.yml` 全文都沒有引用它——**CI 完全不會跑**。
另外它的預設 `TEST_API_URL` 寫死成一個 Tailscale 內網 IP（`http://100.121.9.105:8000/...`），
這同時是一條 hard-code 發現。

- **怎麼修**：改名為 `scripts/loadtest-*.ts`、把 IP 改成必填 env、在 README 註明用法與最後驗證日期。
  現在是「看起來有壓測、實際上沒有」的中間狀態。

### 6.8 🟢 測試篡改鑑識：沒有發現造假

掃描最近 300 個 commit（排除格式化與整檔刪除），140 個同時改了實作與既有測試，
腳本標出 2 個「測試被改鬆」嫌疑、33 個「修 bug 同時改測試」。**逐一看 diff 後，5 個抽查對象全部判定為正當**：

| commit                                             | 判定                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `d6b833e97` refactor(arch) 導入 repository 層      | **非放寬**。斷言從「檢查本地 mock 被 mutate」改成「檢查送給 DB 的 `$set` payload」，資訊量沒下降甚至更貼近真實持久化；「強斷言淨減少 2」是把 3 條分散斷言合併成 1 條 `toHaveBeenCalledWith(完整物件)`  |
| `e4ee353e3` feat(a11y) 校園無障礙                  | **非放寬**。舊端點下線、測試同步刪除；新端點測試新增                                                                                                                                                   |
| `f2bc34ba4` fix(arch) 修獨立稽核找到的四個缺口     | **測試被加嚴**。`findOneAndUpdate` 的 filter 從 `{_id}` 加上 `confirmedBy: {$ne}`／`deniedBy: {$ne}`，修的是自己重構引入的併發重複投票 bug。**這是本 repo 最正面的回歸防護範例**                       |
| `1c464561d` fix(test): suppress morgan access logs | **非造假，但 commit message 誤導**。標題像純測試改動，實際上 `src/app.ts` 也改了 4 行（測試環境不掛 morgan），新測試 spy `process.stdout.write` 驗證這個新行為。動了 source 卻沒在訊息裡揭露，值得注意 |
| `6eb79aae2` fix(transit) 公告比對強化              | **非放寬**。新增案例用真實 TDX 公告文字（含「莒光新城」等站名）斷言 `matchKind`，非同義反覆                                                                                                            |

**結論：這個 repo 沒有「為了讓測試過而改測試」的證據。**
它的測試問題不是造假，是**寫在錯的層**——這兩件事的修法完全不同，前者要修文化，後者只要補測試。

---

## 7. 測試真實性專章

> 這一章與「測試有沒有寫」的結論相反，所以獨立成章。

**結論：1409 個測試全綠、覆蓋率過門檻，但 7 個關鍵行為的突變抽測有 4 個存活。
存活的原因不是「忘了寫測試」，而是「測試寫在錯誤的層，而且把要測的東西 mock 掉了」。**

### 7.1 突變抽測結果

方法：以 `git worktree add --detach HEAD` 建立拋棄式副本（symlink `node_modules`），
每次只破壞一處實作、跑該範圍的測試、記錄、立刻 `git checkout --` 復原。
**使用者的工作目錄自始至終未被修改**（稽核前後 `git status --porcelain` 皆為空）。

| #   | 關鍵行為               | 突變內容                                                  | 測試結果               | 判定        |
| --- | ---------------------- | --------------------------------------------------------- | ---------------------- | ----------- |
| M1  | 認證中介層擋不擋人     | `middleware.ts` `if (!result.ok)` → `if (false)`          | **49 失敗 / 90 通過**  | 🟢 真實     |
| M2  | JWT 有沒有驗簽名       | `config/jwt.ts` `jwt.verify` → `jwt.decode`               | **21 失敗 / 131 通過** | 🟢 真實     |
| M3  | **登入密碼比對**       | `user.auth.service.ts:201` `bcrypt.compare(...)` → `true` | **71 全綠**            | 🔴 **存活** |
| M4  | **更新評論的作者檢查** | `review.service.ts:284` → `if (false)`                    | **37 全綠**            | 🔴 **存活** |
| M5  | **刪除評論的作者檢查** | `review.service.ts:341` → `if (false)`                    | **37 全綠**            | 🔴 **存活** |
| M6  | 無障礙寬度評分         | `scoring.ts` `widthMetres < 0.9 return -30` → `+30`       | **1 失敗 / 281 通過**  | 🟢 真實     |
| M7  | **危害回報過期條件**   | `hazard-report.expire.ts:18` `$lte` → `$gte`              | **22 全綠**            | 🔴 **存活** |

**殺死 3 / 存活 4。** 認證的「門」有守住（M1、M2），但門後面的**授權與身分核對沒有任何測試守著**。

### 7.2 存活的共同結構（這是本報告最重要的一段）

四個存活案例是**同一個反模式**：**route 層測試把 service mock 掉、只驗狀態碼透傳；
service 層測試又沒有對應的 case。兩層各自看起來都有測，合起來是零覆蓋。**

**案例 A — 評論作者檢查（M4、M5）**

```
src/modules/review/review.routes.test.ts:344
  it("returns 403 when reviewer is not the owner", ...)
    vi.mocked(service.updateReview).mockResolvedValue({ httpCode: FORBIDDEN })   ← 403 是 mock 出來的
    expect(res.status).toBe(ResponseCode.FORBIDDEN)                              ← 只驗路由把它透傳出去
```

測試名稱寫著 "not the owner"，但它從頭到尾沒有執行過 `review.service.ts:284` 那行作者比對。
而 `review.service.test.ts` 的 `describe("updateReview")` 只有兩個 case
（`:105` legacy rating 語意、`:149` 不覆寫 legacy rating），**都與 ownership 無關**；
`deleteReview` 連 `describe` 都沒有。

**案例 B — 登入密碼比對（M3）**

```
src/modules/user/user.auth.routes.test.ts:201
  it("returns the same 401 for a wrong password as for an unknown email", ...)
    vi.mocked(service.loginLocalUser).mockRejectedValue(new AuthError("INVALID_CREDENTIALS"))
    expect(res.status).toBe(ResponseCode.UNAUTHORIZED)
```

同樣是驗錯誤映射，不是驗密碼。而 `user.auth.service.test.ts` 的 describe 只有
`requestPasswordReset`（:75）、`processPasswordAssistance`（:96）、`resetPassword`（:255）
——**沒有 `loginLocalUser`**。所以「密碼錯誤要拒絕」這條規則在整個 repo 裡沒有任何測試。

**覆蓋率數字互相印證**：`user.auth.service.ts` statements **28.66%** / branches **18%**；
整個 `src/modules/user` branches 只有 **33.84%**。

**重要的是：這個 mock 慣例是專案自己寫進 `CLAUDE.md` 的**
（「Mock the service layer with `vi.mock` in test files so that the request exercises
router + middleware + validation + controller + envelope」）。也就是說 route 測試這樣寫**是照規矩來的、
而且對它自己的目的（測傳輸層）是正確的**——問題不在這條規矩，在於**沒有另一條規矩要求
service 層的商業規則要有對應測試**。所以修法是補規矩與補測試，不是責備寫測試的人。

### 7.3 P1 — 要補的測試（寫在哪一層是重點）

補測試時**不要再加 route 層的 mock 測試**，那正是造成這個洞的東西。要加在 service 層，
每一條的驗收標準是「把對應的實作行改壞，這個測試必須紅」：

| 行為                             | 要測的位置                                                 | 驗收（突變必須被殺死）                 |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| 密碼錯誤必須拒絕登入             | `user.auth.service.test.ts` 新增 `loginLocalUser` describe | `bcrypt.compare(...)` → `true`         |
| 非作者不能更新評論               | `review.service.test.ts` `updateReview`                    | `review.service.ts:284` → `if (false)` |
| 非作者不能刪除評論               | `review.service.test.ts` 新增 `deleteReview` describe      | `review.service.ts:341` → `if (false)` |
| 只有已過期的回報會被標記 expired | `hazard-report` 的 expire 測試                             | `$lte` → `$gte`                        |

補完後把這四個突變重跑一次當回歸驗收——這比覆蓋率數字有意義得多。

### 7.4 覆蓋率門檻擋不住新的未測程式碼

`vitest.config.ts:45-50` 的門檻是 68/58/70/70，實測 70.38 / **59.7** / 73.5 / 70.x。
branches 只比門檻高 **1.7 個百分點**。門檻是照現況訂的「baseline lock」（設定裡的註解說得很清楚，
而且棘輪只升不降的紀律是對的），但它的作用是**防止退步**，不是**保證覆蓋**——
新寫的未測程式碼只要不把全域數字壓下 1.7 個百分點就進得來。

真正該盯的不是這個百分比，是 §7.1 那張突變表。建議把「四個關鍵突變必須被殺死」寫進
`docs/` 當作驗收清單，比再調高門檻有用。

### 7.5 測試篡改歷史：沒有發現造假（判讀見 §6.8）

掃描最近 300 個 commit，140 個同時改了實作與既有測試，腳本標出 2 個嫌疑 + 33 個修 bug 的 commit；
逐一看 diff 後**全部判定為正當**，其中 `f2bc34ba4` 反而是把測試加嚴。詳見 §6.8。

可重跑：
`python3 ~/.claude/skills/product-grade-audit/scripts/test_forensics.py ~/project/taipei-accessible-backend`

---

## 8. 未驗證／查不到

**稽核最大的失信方式是把「沒查」寫成「沒問題」，所以這一節必須完整。**

1. **未做黑箱 HTTP 驗證**。全部資安結論都是靜態程式碼路徑分析，沒有實際發送 request
   （無 DB / Redis / 外部服務連線環境）。
2. **生產環境設定值未取得**：`CORS_ORIGINS`、`SECURE_COOKIE` 由外部注入，repo 內看不到實際值。
3. **dotenvx 是否真的啟用加密**：`.env.example` 未見 `DOTENV_PUBLIC_KEY` 之類專屬變數，
   只能確認明文 `.env` 未被提交，無法確認生產環境的加密機制。
4. **`/auth/verify-email` 的 token 熵值未查**，因此無法斷定「沒掛 limiter」是否構成可利用的暴力破解。
5. **`line.router.ts` 的 webhook 簽章驗證與 bind code 綁定他人 LINE 帳號的授權邏輯未檢查**（建議另案）。
6. **Voice WebSocket 層是否有伺服器端逐字稿快取或落地檔案未逐行確認**；
   Chroma 向量庫的 embedding 是否可逆推回原文未分析。
7. **repository 商業規則只查了 18 個中最大的 5 個**，其餘 13 個未逐行讀完。
8. **raw document 序列化只追了 User model**（唯一有 `select:false` 欄位者），
   其餘 26 個 model 未窮舉，可能仍有 `__v`／內部時間戳外洩但風險較低。
9. **突變抽測只做了 7 個目標**。存活率 4/7 是抽樣結果，不是全域數字；
   要得到全域數字需要跑 Stryker（未執行，成本高）。
10. **madge 只跑了 `--circular`**，未驗證它是否追蹤 dynamic import。
11. **§6.4 的 101 個案例清單**由 subagent 機械統計產生，只抽查了約 7 個檔案的行號交叉確認，
    其餘未逐行複核；「僅 200 且不看 body」的 21 這個數字是二次分類的結果，可能有個位數誤差。
12. **21 個 repository integration test 只抽查了 2 個**（`hazard-report`、`accessible-route`）
    確認它們真的用 `mongo-test-harness`，不能排除個別檔案其實把 model mock 掉只是跟著命名慣例。
13. **log 內容是否曾在生產環境印出座標或對話**只做了靜態抽查，未實跑 server 觀察真實輸出，
    也未窮舉全部 17 處執行期 `console.log` 與更多的 `console.error`／`warn`。
14. **`src/conn.ts` 未深入讀取**，MongoDB 啟動時是否有 fail-fast 未確認。

### 本報告修正過的三個數字（初稿引用掃描腳本，逐一核對後修正）

| 初稿                         | 實際                                                 | 原因                                          |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `console.log`/`print` 322 處 | `src/` 下 `console.log` 232 處，其中執行期路徑 17 處 | 掃描腳本把 Python `print(` 與測試檔一起算了   |
| request/correlation id 5 處  | **`src/` 下 0 處**                                   | 那 5 處在 `src/` 以外的檔案                   |
| 寫死模型名 9 處              | 真正寫死 2 處（另 2 處有 env 覆蓋）                  | 掃描 pattern 過寬，含註解與有 fallback 的情況 |

列出來是因為**稽核報告自己的數字也必須可稽核**。掃描腳本的輸出是「候選」，不是「發現」。

---

## 9. 建議的處理順序

排序邏輯：**先止血 → 再修護欄本身 → 才補測試與結構。**
護欄要先修，因為在護欄漏的情況下補測試與重構，改壞了一樣不會有人知道。

| 順序 | 項目                                                                         | 章節           | 預估     | 理由                                                     |
| ---- | ---------------------------------------------------------------------------- | -------------- | -------- | -------------------------------------------------------- |
| 1    | AI 端點掛認證 + rate limit                                                   | §5.1           | 0.5 天   | 正在燒錢，而且未認證的位置資料外送給 Gemini              |
| 2    | logout 遞增 `tokenVersion`                                                   | §5.2           | 0.5 小時 | 一行，關掉 60 分鐘的風險視窗                             |
| 3    | lint 加 `--max-warnings=585` 棘輪                                            | §3.2           | 0.5 小時 | 止血：先讓 585 不再長大，跟覆蓋率門檻同一招              |
| 4    | request id + 結構化 logger（pino）                                           | §4.5           | 0.5 天   | **沒有它，後面每一步出問題都查不出來**；本清單 CP 值最高 |
| 5    | 補 §7.3 那四條 service 層測試                                                | §7.3           | 2 天     | **後續所有重構的前提**；驗收＝四個突變全部被殺死         |
| 6    | 一條 E2E（註冊→登入→建 review→他人刪除 403→本人刪除）                        | §6.3           | 1 天     | 一條就同時殺掉 M3／M4／M5，可與 5 合併做                 |
| 7    | arch check 印出涵蓋率並改用目錄判定                                          | §2.1           | 1 天     | 護欄要先誠實，否則不知道 §2.2／§2.3 有沒有修完           |
| 8    | env 集中 + 啟動時 zod 驗證                                                   | §4.6           | 1 天     | 消掉「忘了設變數 → 靜默失去節流」這條複合風險            |
| 9    | 資料刪除端點 + 位置 TTL + audit log                                          | §5.3           | 3 天     | 個資合規，可與 5 併行                                    |
| 10   | 「路由 vs spec 差集為空」的測試 + 補 3 個 import                             | §4.2           | 0.5 天   | 一個測試取代兩個單點斷言                                 |
| 11   | 模組 `index.ts` 補 service 出口 + arch 規則                                  | §2.3           | 2 天     | 42 處 reach-in 一次性收斂                                |
| 12   | 斷循環相依、`user.controller` 套 `toPublicUser`、改名誤導的 integration test | §2.5 §2.6 §6.2 | 0.5 天   | 機械改動，零風險                                         |
| 13   | 拆 `accessible-route.service.ts` / `agent-tools.ts`                          | §2.4           | 長期     | **5、6 沒做完之前不要動**                                |

---

## 10. 本輪動過什麼

**使用者的工作目錄（`~/project/taipei-accessible-backend`）自始至終未被修改。**
稽核前後 `git status --porcelain` 皆為空，HEAD 維持 `7c11886`。

- 唯讀執行：`pnpm run typecheck` / `lint` / `lint:arch` / `test` / `test:coverage` / `pnpm audit --prod`、
  `npx madge --circular`、大量 `rg` / `git log` / `git show`。
- **突變抽測**在 `git worktree add --detach HEAD` 建立的拋棄式副本中進行
  （`<scratchpad>/audit/mut`，`node_modules` 為 symlink）。7 個突變逐一套用、跑測試、
  `git checkout --` 復原。**該 worktree 已於稽核結束時以 `git worktree remove --force` 清除**，
  `git worktree list` 已確認不再存在。
- 稽核結束時 `git status --porcelain` 只有 `?? docs/audit/`（本檔案），HEAD 仍是 `7c11886`。
- 本檔案是本次稽核唯一新增的檔案，**未修改任何既有檔案**。
- 稽核方法與腳本：`~/.claude/skills/product-grade-audit/`
  （`scripts/repo_scan.sh`、`scripts/test_forensics.py`、`references/testing-forensics.md`）。
