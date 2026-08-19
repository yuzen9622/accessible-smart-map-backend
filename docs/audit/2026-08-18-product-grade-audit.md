# taipei-accessible-backend 產品級工程稽核報告

- 稽核日期：2026-08-18
- 稽核範圍：整個 repo（後端；本專案無前端程式碼，前端章節不適用）
- 稽核 commit：`24ee412`（main，working tree 乾淨）
- 稽核者：Antigravity，`product-grade-audit` skill
- 本輪性質：**唯讀稽核，未修改任何實作程式碼**。突變抽測皆於本機立即復原（見 §7）

> 與前次稽核（2026-08-17，`7c11886`）的演進對照：
>
> 1. AI 聊天、意圖解析與解釋端點已於 commit `b72285f` 與 `ca2158c` 補上分層 Rate Limiting（記憶體 backstop + Redis burst + daily 限流），經突變抽測證實已被測試嚴格守住（Killed）。
> 2. 本次稽核進一步深挖 Service 商業邏輯層測試盲區、OpenAPI 規格產出漂移、循環依賴與隱私/資料保存政策。

---

## 0. 一頁摘要

這個 repo 具備**非常扎實的後端工程骨架與自動化工具鏈**——CI 關卡完備（架構檢查 → build → lint → format → typecheck → vitest coverage 門檻 → python 測試 → pnpm audit）、TypeScript strict 嚴格模式開啟、所有端點統一經由 Zod edge validation 與 `sendResponse` 信封封裝、生產依賴零安全漏洞。AI 公開端點的 rate limiting 防護也已落實到位。

然而，以**產品級可維護性、可觀測性與測試真實性**的高標準檢視，仍存在以下三個核心缺口：

1. **Service 層商業規則測試真空（突變存活率 71.4%）**：測試架構呈現「上層 route 測試大量使用 `vi.mock` 隔離 service、底層 repository 測試只測 Mongoose query」的兩端分佈，導致中間核心商業規則（密碼驗證、評論所有權檢查、緊急聯絡人刪除權限、過期資料清理排程）在 7 個突變抽測中存活了 5 個。
2. **缺乏 Request ID 與結構化日誌**：`src/` 原始碼中完全沒有 request ID / correlation ID 貫穿機制，全 repo 散落 230 處 `console.log` 與 189 處 `console.error`，在分散式或生產環境發生錯誤時無法串聯同一 HTTP 請求的呼叫鏈。
3. **OpenAPI 規格漂移與循環相依**：`src/openapi/document.ts` 漏匯入 welfare、visual-a11y、nav-instructions 3 個模組的 schema 檔，導致產生的 OpenAPI 規格遺漏 6 個端點；`line.types.ts` 逆向匯入 `accessible-route.service.ts` 產生 1 處循環依賴。

如果只做三件事：
**(1) 補上 §3.1 中存活行為的 Service 層單元測試（密碼驗證、評論與聯絡人權限檢查、過期清理）；
(2) 引入 Request ID 中介層與 Pino/Winston 結構化日誌；
(3) 修復 OpenAPI document 匯入與 line.types 循環依賴。**

### 成熟度速覽

| 面向           | 現況                                                                                         | 目標                                      | 差距                                       |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| 模組化與分層   | 🟡 核心骨架分明，但 67.4% 檔案未受 arch check 保護；存在 1 處循環相依與 27 處跨模組 reach-in | 零循環相依、arch check 覆蓋率 >95%        | 修復 line.types 匯入並擴充 arch check 規則 |
| API 契約       | 🟡 Edge validation 完備，但 OpenAPI document 漏匯入 3 個模組 schema（遺漏 6 個端點）         | OpenAPI spec 與所有實作路由 100% 同步     | 在 document.ts 補齊 schema 匯入            |
| 型別與工具鏈   | 🟢 TypeScript strict 全綠、零 type error，但 610 處 ESLint warnings 未設上限                 | 零 warnings、CI 開啟 `--max-warnings=0`   | 逐步清除 `any` / `!` 並釘住警告數          |
| **測試真實性** | 🔴 1450 個測試全綠，但**關鍵業務突變抽測 5/7 存活**（71.4% 存活率）                          | 核心業務規則突變 100% 殺死                | 於 Service 層補足真實邏輯與例外測試        |
| 測試分層       | 🟡 Repository 有真實 Mongo 整合測試、Route 有 HTTP 測試，但中間 Service 層與 E2E 缺漏        | 單元、整合、E2E 三層覆蓋完整              | 補足 Service 單元測試與使用者旅程 E2E      |
| 錯誤處理       | 🟡 有統一信封與集中處理，但無自訂 AppError 階層，80 處 `throw new Error` 易退回 500          | 具備業務、驗證、上游分層之自訂 Error 類別 | 建立 Error 階層並映射 HTTP status          |
| **可觀測性**   | 🔴 **無 Request ID / Correlation ID（`src/` 0 命中），日誌全為非結構化 console**             | 具備 requestId 注入與 JSON 結構化日誌     | 引入 requestId 中介層與結構化 logger       |
| 設定與 secret  | 🟢 dotenvx 加密管理、`.env` 從未進版控、git 歷史零真實金鑰                                   | 維持現狀                                  | —                                          |
| 資安與防護     | 🟢 AI 端點已完成三層 Rate Limiting；認證防護健全                                             | 登出時伺服器端憑證撤銷                    | Logout 時更新 tokenVersion                 |
| 個資與隱私     | 🟡 缺乏使用者帳號自主刪除端點；SOS 求助經緯度軌跡缺乏 TTL 清除機制                           | 支援帳號刪除、SOS 座標依 TTL 自動過期     | 補齊 DELETE /user 端點與 Mongo TTL 索引    |
| 前端工程       | ⚪ 不適用（本專案無前端程式碼）                                                              | —                                         | —                                          |

---

## 1. 事實基線

這一節只記錄**實際執行的客觀指令與輸出結果**，不含任何主觀推論。

| 項目             | 結果                                                                                                                         | 驗證指令                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 技術棧           | TypeScript 5.8 / Node.js 22 / Express 4 / Mongoose 8 / Vitest 4.1 / pnpm 10.30                                               | `repo_scan.sh`                                                     |
| 程式碼規模       | `src/` 非測試 `.ts` 檔 325 個；最大原始檔 2,298 行（`accessible-route.service.ts`）                                          | `find src -name '*.ts' ! -name '*.test.ts'`                        |
| **typecheck**    | **exit=0**，0 errors（型別檢查全數通過）                                                                                     | `pnpm run typecheck` (`tsc -p tsconfig.typecheck.json --noEmit`)   |
| **lint**         | **exit=0**，0 errors / **610 warnings**（`no-explicit-any`: 458, `no-non-null-assertion`: 152）                              | `pnpm run lint` (`eslint .`)                                       |
| **format:check** | **exit=1**，1 個檔案未排版（`docs/specs/AI_AGENT_INTERACTIONS_UPGRADE.md`）                                                  | `pnpm run format:check` (`prettier --check .`)                     |
| **lint:arch**    | **exit=0**，`Architecture boundary check passed.`                                                                            | `pnpm run lint:arch` (`node src/scripts/check-architecture.mjs`)   |
| **Node.js 測試** | **exit=0**，128 個測試檔 / **1,450 passed** / 0 failed / 0 skipped（耗時 12.68s）                                            | `pnpm test` (`vitest run`)                                         |
| **Python 測試**  | **exit=0**，5 個測試檔 / **123 passed** / 0 failed（耗時 0.35s）                                                             | `pnpm run test:python` (`python3 src/scripts/run-python-tests.py`) |
| **測試覆蓋率**   | Statements **71.05%** / Branches **60.37%** / Functions **73.74%** / Lines **73.04%**                                        | `pnpm run test:coverage` (`vitest run --coverage`)                 |
| 覆蓋率門檻要求   | Statements 68% / Branches 58% / Functions 70% / Lines 70%（Branches 僅高於門檻 2.37%）                                       | `vitest.config.ts:45-50`                                           |
| 依賴漏洞掃描     | **No known vulnerabilities found**（0 vulnerabilities）                                                                      | `pnpm audit --prod`                                                |
| 循環相依分析     | **1 個循環依賴**（`accessible-route.service` → `user.service` → `line.adapter` → `line.types` → `accessible-route.service`） | `npx madge --circular --extensions ts src`                         |
| Git 狀態與歷史   | HEAD `24ee412` on `main`，共 503 commits / 20 merge commits / 32 branches，working tree 乾淨                                 | `git rev-parse --short HEAD`                                       |

---

## 2. 發現清單（依嚴重度排序）

所有發現均已通過機械化驗證關卡（`findings.verified.json`，14/14 PASS）。

### P1-1 user.auth.service.ts 的 loginLocalUser 密碼驗證邏輯無任何測試覆蓋，突變比對為 true 時 1450 個測試全數通過

- **驗證**：`mutation`／已通過驗證關卡（`findings.verified.json` id=P1-1）
- **證據**：`src/modules/user/user.auth.service.ts:201`
  > `const matches = await bcrypt.compare(input.password, hash);`
- **突變紀錄**：將 `matches` 強制替換為 `true`，執行 `pnpm test`，1450 個測試**全數通過（survived）**；已立即復原。
- **可達路徑**：`POST /api/v1/user/login` → `user.auth.controller.ts:133` (`loginLocalUser`) → `user.auth.service.ts:201` (`bcrypt.compare`)
- **影響**：由於 `user.auth.routes.test.ts` 將 `authService.loginLocalUser` 徹底 `vi.mock` 掉，而 `user.auth.service.test.ts` 僅測試密碼重設與 worker，未針對 `loginLocalUser` 撰寫單元測試。若密碼檢查邏輯出現回歸缺陷，CI 完全無法攔截。
- **怎麼修**：在 `src/modules/user/user.auth.service.test.ts` 補齊 `loginLocalUser` 的單元測試（包含正確密碼成功、錯誤密碼拋出 `INVALID_CREDENTIALS`、未驗證信箱拋出 `EMAIL_NOT_VERIFIED`、不存在帳號防計時攻擊測試）。
- **怎麼驗**：新增測試後，若再次將 `matches` 改為 `true`，測試必須失敗紅燈。

---

### P1-2 review.service.ts 的 updateReview 與 deleteReview 權限檢查（作者不符回傳 403）突變繞過時全套測試全綠

- **驗證**：`mutation`／已通過驗證關卡（`findings.verified.json` id=P1-2）
- **證據**：
  `src/modules/review/review.service.ts:284`
  > `if (stored.userId !== userId) {`
  > `src/modules/review/review.service.ts:341`
  > `if (review.userId !== userId) {`
- **突變紀錄**：在 `deleteReview` 中將 `userId` 比對條件短路繞過，執行 `pnpm test`，1450 個測試**全數通過（survived）**；已立即復原。
- **可達路徑**：`PATCH/DELETE /api/v1/a11y/review/:id` → `review.controller.ts:39/45` → `review.service.ts:284/341`
- **影響**：`review.routes.test.ts` 將 `service.updateReview` 與 `service.deleteReview` 完整 mock；而 `review.service.test.ts` 僅測試了 `updateReview` 的成功路徑，完全未呼叫 `deleteReview`，亦未測試非作者嘗試更新/刪除的 FORBIDDEN 情況。若權限邏輯被破壞，任意登入使用者可篡改或刪除他人評論。
- **怎麼修**：在 `src/modules/review/review.service.test.ts` 補上非本人呼叫 `updateReview` 與 `deleteReview` 時回傳 `FORBIDDEN` 的單元測試。
- **怎麼驗**：破壞 `stored.userId !== userId` 判斷條件時，`review.service.test.ts` 必須失敗紅燈。

---

### P1-3 hazard-report.expire.ts 的過期回報標記排程 expireStaleReports 缺乏任何測試覆蓋，過期條件突變反轉時全套測試全綠

- **驗證**：`mutation`／已通過驗證關卡（`findings.verified.json` id=P1-3）
- **證據**：`src/modules/hazard-report/hazard-report.expire.ts:18`
  > `expiredAt: { $lte: new Date() },`
- **突變紀錄**：將 `expiredAt: { $lte: new Date() }` 反轉為 `$gt`，執行 `pnpm test`，1450 個測試**全數通過（survived）**；已立即復原。
- **影響**：整個測試套件中完全沒有針對 `expireStaleReports` 撰寫任何測試。若過期判斷錯誤，可能導致未過期回報被提前標記為 expired，或已過期回報永遠無法清理。
- **怎麼修**：新增 `src/modules/hazard-report/hazard-report.expire.test.ts`，利用 in-memory MongoDB 測試過期時間前後的回報狀態移轉。
- **怎麼驗**：反轉 `$lte` 為 `$gt` 時該測試必須失敗紅燈。

---

### P1-4 emergency-contact.service.ts 的聯絡人刪除權限檢查突變繞過時全套測試全綠

- **驗證**：`mutation`／已通過驗證關卡（`findings.verified.json` id=P1-4）
- **證據**：`src/modules/emergency-contact/emergency-contact.service.ts:125`
  > `if (String(contact.userId) !== input.userId) {`
- **突變紀錄**：將 `String(contact.userId) !== input.userId` 檢查條件短路，執行 `pnpm test`，1450 個測試**全數通過（survived）**；已立即復原。
- **可達路徑**：`DELETE /api/v1/user/emergency-contacts/:id` → `emergency-contact.controller.ts:34` → `emergency-contact.service.ts:125`
- **影響**：本模組僅有 `emergency-contact.routes.test.ts`（mock 了 service）與 `emergency-contact.repository.integration.test.ts`（直接呼叫 repository），完全沒有 `emergency-contact.service.test.ts`。所有權檢查邏輯處於零測試狀態。
- **怎麼修**：新增 `src/modules/emergency-contact/emergency-contact.service.test.ts`，測試非本人嘗試刪除聯絡人時回傳 FORBIDDEN。
- **怎麼驗**：破壞 `userId` 判斷條件時測試必須失敗紅燈。

---

### P1-5 整個 src/ 程式碼完全沒有 request ID / correlation ID 追蹤機制，跨模組與錯誤日誌無法關聯單一 HTTP 請求

- **驗證**：`absence`／已通過驗證關卡（`findings.verified.json` id=P1-5）
- **搜尋範圍**：`src/`（全部 325 個非測試 TypeScript 原始檔）
- **查證指令**：
  1. `rg -i "requestId|request_id|correlationId|traceId|x-request-id" src/`（0 處命中）
  2. `rg -i "x-correlation-id" src/`（0 處命中）
- **證據**：`src/app.ts:65`
  > `app.use(morgan("common"));`
- **影響**：線上環境中，一個複合請求（例如路線規劃觸發的公車、捷運、氣象、設施等多個非同步查詢）若拋出錯誤，因日誌均無 request ID，維運人員無法將散落的錯誤訊息關聯回具體的使用者請求或請求參數。
- **怎麼修**：引入 request ID 中介層，於 request 進來時生成唯一 UUID 注入 `req.id`，透過 response header `X-Request-Id` 回傳，並於所有日誌輸出時自動附帶該 ID。
- **怎麼驗**：發送 HTTP 請求時驗證 response header 包含 `x-request-id`，且伺服器日誌印出該 ID。

---

### P2-1 src/openapi/document.ts 未匯入 welfare.schema、visual-a11y.schema、nav-instructions.schema，導致產生的 OpenAPI 規格遺漏 6 個端點

- **驗證**：`presence`／已通過驗證關卡（`findings.verified.json` id=P2-1）
- **證據**：
  `src/openapi/document.ts:17`
  > `import "../modules/place-search/place-search.schema";`
  > `src/modules/welfare/welfare.schema.ts:90`
  > `registry.registerPath({`
  > `src/modules/visual-a11y/visual-a11y.schema.ts:75`
  > `registry.registerPath({`
  > `src/modules/nav-instructions/nav-instructions.schema.ts:169`
  > `registry.registerPath({`
- **實測查證**：執行 `generateOpenAPIDocument()` 檢視輸出的 `paths`，總共 65 個路徑，其中 `welfare`、`visual-a11y`、`nav-instructions` 各端點布林值全為 `false`。
- **影響**：對外公開的 `/api/v1/openapi.json` 與 Scalar 文件頁面遺漏了 6 個合法路由的 API 規格定義，造成 API 文件與實作程式碼漂移。
- **怎麼修**：在 `src/openapi/document.ts` 中補上對應三份 schema 的匯入：
  `import "../modules/welfare/welfare.schema";`
  `import "../modules/visual-a11y/visual-a11y.schema";`
  `import "../modules/nav-instructions/nav-instructions.schema";`
- **怎麼驗**：重新產生 OpenAPI 文件，驗證 `paths` 中包含 `/a11y/welfare`、`/a11y/visual-a11y`、`/a11y/nav-instructions` 等端點。

---

### P2-2 modules/accessible-route/accessible-route.service.ts 存在循環依賴，npx madge --circular 報告 exit=1

- **驗證**：`behavior`／已通過驗證關卡（`findings.verified.json` id=P2-2）
- **證據**：
  `src/modules/line/line.types.ts:2`
  > `import type { PlanRouteResult } from "../accessible-route/accessible-route.service";`
  > `src/modules/accessible-route/accessible-route.types.ts:142`
  > `export type PlanRouteResult =`
- **實測輸出**：
  `Found 1 circular dependency!`
  `1) modules/accessible-route/accessible-route.service.ts > modules/user/user.service.ts > adapters/line.adapter.ts > modules/line/line.types.ts`
- **影響**：形成跨 4 個模組的循環相依鏈，破壞單向相依原則，增加模組拆分與打包分析難度。
- **怎麼修**：`PlanRouteResult` 的源頭定義在 `accessible-route.types.ts:142`，將 `src/modules/line/line.types.ts:2` 的匯入來源改為 `../accessible-route/accessible-route.types`。
- **怎麼驗**：修改後執行 `npx madge --circular --extensions ts src`，輸出必須為 0 circular dependencies 且 exit=0。

---

### P2-3 src/ 下 325 個非測試 TypeScript 原始檔中共有 230 處 console.log、68 處 console.warn、189 處 console.error，缺乏結構化日誌記錄器

- **驗證**：`count`／已通過驗證關卡（`findings.verified.json` id=P2-3）
- **計數**：`console.log` 230 處、`console.warn` 68 處、`console.error` 189 處（非測試 `.ts` 檔）
- **抽樣證據**：
  `src/modules/accessible-route/accessible-route.service.ts:630`
  > `"[accessible-route] every candidate contains stairs; returning the least-stairs route",`
  > `src/modules/transit/bus.service.ts:430`
  > `const matchedStop = nextTrip.stopTimes.find((st: any) =>`
  > `src/modules/ai/agent-tools.ts:70`
  > `console.error("[agent-tool:findGooglePlaces]", error.message);`
- **影響**：文字式 log 無法被日誌收集平台結構化解析與告警，且缺乏統一日誌等級過濾機制。
- **怎麼修**：引入 Pino 或 Winston 結構化 logger，抽換裸 `console.*` 呼叫。
- **怎麼驗**：執行期路徑無直接 `console.*`，日誌輸出為標準 JSON 格式。

---

### P2-4 src/scripts/check-architecture.mjs 僅透過 6 種檔名後綴判定架構分層，src/ 325 個檔案中 219 個（67.4%）未納入分層規則檢查

- **驗證**：`presence`／已通過驗證關卡（`findings.verified.json` id=P2-4）
- **證據**：
  `src/scripts/check-architecture.mjs:29`
  > `if (file.endsWith(".router.ts")) return "router";`
  > `src/scripts/check-architecture.mjs:34`
  > `if (file.endsWith(".schema.ts")) return "schema";`
  > `src/modules/ai/agent-tools.ts:2`
  > `import * as a11yOrchestration from "../a11y/a11y.orchestration";`
- **影響**：`check-architecture.mjs` 僅辨識 `.router`、`.controller`、`.service`、`.repository`、`.orchestration`、`.schema` 六種後綴。其餘 219 個檔案（如 `agent-tools.ts`、所有 `adapters/`、`planners/`）完全不受檢查，例如 `agent-tools.ts` 直接跨模組 reach-in 引入 `a11y.orchestration` 與各 transit services 卻能通過檢查，造成虛假安全感。
- **怎麼修**：擴充 `check-architecture.mjs` 的檔案角色解析邏輯，涵蓋 `adapters/`、`middleware/`、`planners/`、`config/` 等目錄。
- **怎麼驗**：擴充後執行 `pnpm run lint:arch`，並確認受檢檔案比例提升至 95% 以上。

---

### P2-5 POST /api/v1/user/logout 僅清除 client 端 cookie，未使伺服器端 tokenVersion 遞增或撤銷 refresh token

- **驗證**：`presence`／已通過驗證關卡（`findings.verified.json` id=P2-5）
- **證據**：
  `src/modules/user/user.controller.ts:228`
  > `async function logout(_req: Request, res: Response) {`
  > `src/modules/user/user.controller.ts:230`
  > `res.cookie("refreshToken", "", { maxAge: 0 });`
- **影響**：登出操作僅由客戶端丟棄 cookie，若使用者的 refresh token 曾遭截獲，在 TTL 到期前依然可以成功換發 access token。
- **怎麼修**：在 logout 端點掛上 auth middleware，並於登出時遞增資料庫中該使用者的 `tokenVersion`。
- **怎麼驗**：呼叫 logout 後，使用舊的 refreshToken 呼叫 `/refresh` 必須回傳 401 Unauthorized。

---

### P2-6 緊急求助定位工作階段 ISosSession 與經緯度座標記錄在 MongoDB 中無 TTL 索引設定，資料無限期留存

- **驗證**：`presence`／已通過驗證關卡（`findings.verified.json` id=P2-6）
- **證據**：
  `src/model/sos-session.model.ts:45`
  > `const sosSessionSchema = new Schema<ISosSession>(`
  > `src/model/sos-session.model.ts:70`
  > `lat: { type: Number, required: true, min: -90, max: 90 },`
- **影響**：包含求助者精確經緯度、時間軸與 LINE 身分關聯的 SOS 工作階段資料永久留存於 MongoDB，不符合隱私規範中位置資訊最小化留存原則。
- **怎麼修**：於 `sosSessionSchema` 在 `resolvedAt` 欄位建立 TTL 索引（如 30 天後自動刪除已結案之定位紀錄），或實作定期資料去識別化與封存排程。
- **怎麼驗**：確認 MongoDB 集合具備 TTL index 或排程測試正常清除過期資料。

---

### P2-7 src/ 中共有 80 處丟擲未分類的純字串 throw new Error(...)，錯誤型別未分層

- **驗證**：`count`／已通過驗證關卡（`findings.verified.json` id=P2-7）
- **計數**：80 處 `throw new Error(...)`（`src/` 下非測試檔）
- **抽樣證據**：
  `src/adapters/email.adapter.ts:67`
  > `throw new Error("RESEND_API_KEY is not configured");`
  > `src/adapters/google.adapter.ts:78`
  > `throw new Error(`
  > `src/adapters/tdx-mqtt.adapter.ts:30`
  > `throw new Error("TDX MQTT credentials are missing");`
- **影響**：缺乏結構化錯誤類別階層，導致各層捕捉錯誤時無法精確判定錯誤性質，多數落回 500 INTERNAL_ERROR。
- **怎麼修**：定義清晰的錯誤類別階層（如 `AppError`、`NotFoundError`、`UpstreamError`、`ValidationError`），並由統一錯誤處理器對應至適當 HTTP 狀態碼。
- **怎麼驗**：上游或業務拋出自訂錯誤時，API 回應對應的 4xx/502 狀態碼而非一律 500。

---

### P3 級別發現（彙整表）

| ID       | 發現項目                                                                           | 證據位置                                                                 | 實測指令與結果                               | 修復建議                                               |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------ |
| **P3-1** | `docs/specs/AI_AGENT_INTERACTIONS_UPGRADE.md` 格式不符 Prettier 規範               | `docs/specs/AI_AGENT_INTERACTIONS_UPGRADE.md:1`                          | `pnpm run format:check` 報告 exit=1          | 執行 `pnpm run format` 重新排版該檔案                  |
| **P3-2** | ESLint 存在 610 處 warnings（458 處 `any`，152 處 `!`），未設定 `--max-warnings=0` | `src/modules/accessible-route/accessible-route.service.ts:530` 等 610 處 | `pnpm run lint` 輸出 610 warnings / 0 errors | 逐一重構型別，並於 CI 加入 `--max-warnings=0` 避免惡化 |

---

## 3. 測試真實性專章

**結論**：全套測試 128 個測試檔、1,450 個測試案例全部綠燈，覆蓋率 71.05%；但在針對關鍵業務邏輯（認證、所有權檢查、過期清理）實施的 7 個突變抽測中，**有 5 個存活（71.4% 存活率）**。
這證實了本 repo 的測試缺口在於**測試分層錯置（Route 測試過度 Mock Service，Service 層本身缺乏直接單元測試）**，而非惡意造假。

### 3.1 突變抽測結果

| #   | 關鍵行為                        | 測試位置                                                         | 測試型別 | 突變內容                            | 結果                                                         | 判定                                                                    |
| --- | ------------------------------- | ---------------------------------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | 使用者登入密碼驗證              | `src/modules/user/user.auth.service.ts:201`                      | Service  | `matches = true`（強制比對成功）    | **存活**（1450 passed）                                      | **裝飾/錯層**（Route 測試 mock 掉 service，service 自身無測試）         |
| 2   | 評論刪除作者權限檢查            | `src/modules/review/review.service.ts:341`                       | Service  | 短路作者 `userId` 比對              | **存活**（1450 passed）                                      | **裝飾/錯層**（Route 測試 mock 掉 service，service 測試未覆蓋 delete）  |
| 3   | 評論更新作者權限檢查            | `src/modules/review/review.service.ts:284`                       | Service  | 短路作者 `userId` 比對              | **存活**（1450 passed）                                      | **裝飾/錯層**（Route 測試 mock 掉 service，service 測試未測非作者更新） |
| 4   | 危害回報過期標記排程            | `src/modules/hazard-report/hazard-report.expire.ts:18`           | Task     | `$lte` 反轉為 `$gt`（過期條件倒轉） | **存活**（1450 passed）                                      | **缺失**（完全無對應測試檔）                                            |
| 5   | AI Chat 端點 Rate Limiting 防護 | `src/modules/ai/ai.router.ts:48`                                 | Route    | 移除 `aiChatRateLimit` 中介層       | **殺死**（4 tests failed in `ai.rate-limit.routes.test.ts`） | **真實**（Rate limit 測試有效防守）                                     |
| 6   | 公車警報路線名稱正規化比對      | `src/utils/transit-text.ts:55`                                   | Unit     | `equalRouteName` 強制回傳 `true`    | **殺死**（1 test failed in `transit-text.test.ts:192`）      | **真實**（字串處理單元測試有效防守）                                    |
| 7   | 緊急聯絡人刪除所有權檢查        | `src/modules/emergency-contact/emergency-contact.service.ts:125` | Service  | 短路聯絡人 `userId` 比對            | **存活**（1450 passed）                                      | **裝飾/錯層**（Route 測試 mock 掉 service，無 service test）            |

> **工作目錄狀態確認**：上述 7 次突變抽測均於每次測試執行完畢後立即以 `git checkout -- <file>` 復原。最終執行 `git status --porcelain` 確認 working tree 保持 100% 乾淨。

### 3.2 測試品質指標

| 指標                          | 數值                                      | 評估說明                                                     |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| 測試檔案數                    | 128 個（Node.js Vitest） + 5 個（Python） | 測試檔與原始檔比例約 1 : 2.5                                 |
| 測試案例總數                  | 1,450 個（Vitest） + 123 個（Python）     | 測試案例規模充足                                             |
| 斷言總數 / 平均每 Case 斷言數 | 3,540 個 / **2.37**                       | 平均每 case > 2 個斷言，斷言密度健康                         |
| 強斷言 vs 弱斷言              | 2,404 vs 103（弱斷言率 4.1%）             | 絕大多數使用精確斷言                                         |
| Mock 呼叫次數                 | 1,501 處（其中僅驗證 called 613 處）      | **Route 測試過度依賴 Mock**，導致 Service 邏輯漏失           |
| 僅斷言 HTTP 200 比例          | 82 處                                     | 少數 smoke test 僅檢查 200，但多數 API test 有驗證 body 結構 |
| Skip / Only / XFail 數量      | **0 處**                                  | 無任何被跳過或靜默略過的測試                                 |

### 3.3 篡改嫌疑分析

透過 `test_forensics.py` 掃描 483 個 commit 歷史，分析同時修改原始檔與測試檔的 commit：

- `d6b833e97`（`refactor(arch): introduce a repository layer for every module service`）：引入 Repository 分層重構，測試調整係將原本直接 mock model 改為 mock repository，經查證屬於**正規架構重構**，無惡意放寬斷言。
- `f2bc34ba4`（`fix(arch): close four gaps found by an independent audit of this refactor`）：修復稽核缺失，測試反而**增加了邊界條件與嚴格斷言**。
- `ca2158c30` / `b72285f`（`feat(ai): add layered rate limiting to public AI endpoints`）：新增 Rate Limiting 機制並補齊嚴格的 429 測試。

**判定**：歷史上無任何「為了讓測試變綠而刻意削弱斷言」的惡意篡改證據。目前測試問題純粹為**測試寫在錯誤層次（Route 側重 HTTP 路由與信封、Repository 側重 Query，中間 Service 商業規則被 Mock 架空）**。

### 3.4 測試分層是否名副其實

- **Repository 層**：具備 21 個真實的 `*.repository.integration.test.ts`，使用 `mongodb-memory-server` 啟動真實 MongoDB 實例測試 2dsphere 空間索引、聚合查詢與 CRUD，**名副其實**。
- **Route 層**：具備完整 `*.routes.test.ts`，使用 supertest 測試 Express router、Zod validation、middleware chain 與 response envelope，**名副其實**。
- **Service 層**：**嚴重缺失**。多數模組沒有獨立的 `*.service.test.ts`，或其 service test 僅測 happy path，未覆蓋權限驗證與例外分支。
- **E2E 旅程層**：缺乏端到端的使用者情境測試（如：註冊 → 登入 → 新增緊急聯絡人 → 觸發 SOS → 聯絡人接案結案）。

---

## 4. 前端專章（不適用）

本 repo 為純後端 API 服務（`taipei-accessible-backend`），無任何前端 UI / Web 元件程式碼，故前端專用指標不適用。

---

## 4.9 已排除的疑點（正面驗證）

| 疑點                                    | 查證方法與實測結果                                                                                                                                                                       | 判定                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **AI 公開端點是否缺乏 Rate Limiting？** | 查閱 `ai.router.ts`，`/intent`、`/explain`、`/chat` 皆掛載 `optionalAuth` 與專屬三層 rate limiters（backstop 記憶體 + burst Redis + daily Redis）。突變抽測移除 limiter 時測試立即紅燈。 | **已加固，非問題**   |
| **SQL / NoSQL Injection 注入風險？**    | 查閱所有 controller 與 repository，全數使用 Mongoose ODM 結構化查詢與 Zod 邊界白名單，無任何字串拼接查詢。                                                                               | **零可達案例，安全** |
| **金鑰與密鑰是否曾進版控？**            | 查閱 `.gitignore` 與 git log 歷史，專案全面使用 `@dotenvx/dotenvx` 管理環境變數，`.env` 從未提交。                                                                                       | **安全**             |
| **生產環境依賴安全性？**                | 執行 `pnpm audit --prod`，掃描結果為 `No known vulnerabilities found`。                                                                                                                  | **零已知漏洞，安全** |

---

## 5. 未驗證／查不到

- **真實 TDX / CWA / Google Maps 上游網路延遲與配額限制**：測試環境皆使用 mock 或 fixture 隔離第三方外部 API，無法在靜態與本機測試中評估上游 API 斷線或限流時的真實降級表現。
- **ChromaDB / Vector RAG 在大資料量下的檢索效能**：本地測試無向量資料庫連線，RAG 模組的向量檢索精準度與記憶體耗用未於本次稽核中進行壓測。

---

## 6. 建議的處理順序

| 順序  | 項目                                                               | 預估工時 | 理由與效益                                                         |
| ----- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| **1** | **補齊 Service 層關鍵商業規則單元測試**（§3.1 之 4 個存活項目）    | 1.5 天   | 建立真實的安全護欄，確保密碼驗證、權限檢查、過期清理不發生隱性回歸 |
| **2** | **修復 OpenAPI document 匯入與 line.types 循環依賴**（P2-1, P2-2） | 0.5 天   | 消除 API 規格漂移與模組循環相依，低成本高價值                      |
| **3** | **引入 Request ID 與結構化日誌（Pino）**（P1-5, P2-3）             | 1.5 天   | 建立生產級可觀測性，使跨模組除錯與告警具備追蹤能力                 |
| **4** | **擴充 check-architecture.mjs 覆蓋率**（P2-4）                     | 0.5 天   | 將 adapters/planners/middleware 納入檢查，防止跨模組 reach-in 惡化 |
| **5** | **完善資料生命週期與帳號刪除**（P2-5, P2-6）                       | 1 天     | 登出時撤銷 token、SOS 經緯度加上 TTL、提供使用者刪除帳號端點       |
| **6** | **修正 Prettier 格式與收緊 ESLint warning 門檻**（P3-1, P3-2）     | 0.5 天   | 確保 CI `format:check` 綠燈，並鎖定 warning 數量防止程式碼品質下滑 |

---

## 6.9 本報告修正過的數字

| 初稿候選數字                        | 實測核對後實際數字                                                | 修正原因說明                                                                             |
| ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 原始掃描 `console.log` 322 處       | `src/` 非測試 `.ts` 檔中實際為 **230 處**（warn: 68, error: 189） | `repo_scan.sh` 初步正則包含了 Python `print(`、測試檔與外部檔案，經 AST 級精確篩選後排除 |
| 初步疑慮「AI 端點無 Rate Limiting」 | 實際已於 commit `b72285f` / `ca2158c` **完整實作三層限流**        | 經查閱程式碼並以突變抽測驗證，證實 AI 限流已被完整測試保護，故移入「已排除的疑點」       |
| 突變抽測存活數                      | 7 個抽測目標中 **5 個存活 / 2 個殺死**                            | 每一項抽測均留存具體修改行號、測試輸出與立即復原紀錄                                     |

---

## 7. 本輪動過什麼

### 執行過的驗證與稽核指令

1. `bash /Users/yuen/.claude/skills/product-grade-audit/scripts/repo_scan.sh .`
2. `python3 /Users/yuen/.claude/skills/product-grade-audit/scripts/test_forensics.py .`
3. `pnpm run lint:arch`
4. `pnpm run build`
5. `pnpm run typecheck`
6. `pnpm run lint`
7. `pnpm run format:check`
8. `pnpm test`
9. `pnpm run test:python`
10. `pnpm run test:coverage`
11. `pnpm audit --prod`
12. `npx madge --circular --extensions ts src`
13. `python3 /Users/yuen/.claude/skills/product-grade-audit/scripts/verify_findings.py findings.json --strict --out findings.verified.json`

### 突變抽測動過的檔案（全部已立即復原）

- `src/modules/user/user.auth.service.ts`（L201 密碼比對邏輯突變 → 測試通過 → `git checkout` 復原）
- `src/modules/review/review.service.ts`（L341, L284 評論作者比對邏輯突變 → 測試通過 → `git checkout` 復原）
- `src/modules/hazard-report/hazard-report.expire.ts`（L18 過期條件突變 → 測試通過 → `git checkout` 復原）
- `src/modules/ai/ai.router.ts`（L48 移除 Rate Limiter → 測試失敗 KILLED → `git checkout` 復原）
- `src/utils/transit-text.ts`（L55 路線名稱比對突變 → 測試失敗 KILLED → `git checkout` 復原）
- `src/modules/emergency-contact/emergency-contact.service.ts`（L125 聯絡人作者比對突變 → 測試通過 → `git checkout` 復原）
- **最終狀態**：`git status --porcelain` 輸出為空，working tree 保持 100% 乾淨。

### 產生的檔案

- `findings.json`（候選發現定義檔）
- `findings.verified.json`（通過 verify_findings.py 驗證之發現清單，14/14 PASS）
- `docs/audit/2026-08-18-product-grade-audit.md`（本稽核報告）
