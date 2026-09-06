# taipei-accessible-backend 產品級工程稽核報告

- 稽核日期：2026-09-06
- 稽核範圍：`/Users/yuen/project/taipei-accessible-backend`（commit `b65329b` on `main`）
- 稽核者：Pi Coding Agent（採用 `product-grade-audit` 規範）
- 本輪性質：唯讀稽核，未修改任何實作程式碼

---

## 0. 一頁摘要

本專案（無障礙智慧地圖後端 API）整體工程水準介於**半產品級與產品級**之間。架構規範（`AGENTS.md`、分層中介層、Zod 邊界嚴格驗證、BCrypt 密碼雜湊與加鹽）具備良好的一致性，並擁有 171 個測試檔、2,121 個自動化測試的強大基底。然而，本輪稽核透過機械化證據與突變鑑識發現三個最致命的問題：

1. **未設定 JWT 密鑰時靜默回退為空字串（P0）**：`src/config/jwt.ts` 在 `JWT_ACCESS_SECRET` 未注入環境時預設為空字串 `""`，伺服器不拋錯且允許以空密鑰簽名之 Token 通過全站認證。
2. **CI 型別檢查關卡失守（P1）**：`pnpm run typecheck` 存在 14 處型別錯誤（exit=1），但 `pnpm run build` 因 `tsconfig.json` 排除測試檔而綠燈，破壞持續整合的型別防護。
3. **刪除授權邏輯因過度 Mock 缺乏有效測試（P1）**：突變抽測證實，緊急聯絡人與評論刪除端點的擁有權檢查條件即使反轉（本人被禁止刪除、他人可任意刪除），測試套件依然 100% 全綠。

**若只做三件事，建議立即執行的處理順序：**

1. 在服務啟動層（`src/config/jwt.ts` / `src/server.ts`）強制檢查 `JWT_ACCESS_SECRET` 與 `JWT_REFRESH_SECRET`，缺漏時直接 `process.exit(1)` 拒絕啟動（P0-1）。
2. 修復 `low-floor-rerank.test.ts` 等 6 個測試檔案中遺漏 `subRouteUid` / `subRouteName` 的 `BusLeg` mock，恢復 `pnpm run typecheck` 綠燈（P1-1）。
3. 替 `emergency-contact.service.ts` 與 `review.service.ts` 補齊真實測試，消除裝飾性 Mock，守住刪除權限邊界（P1-2）。

### 成熟度速覽

| 面向               | 現況                                                                | 目標                                      | 差距                                                     |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| 模組化與分層       | 🟡 良好分層，但核心 service 過於龐大（2,760 行）且存在 3 處循環相依 | 模組低耦合、無跨檔循環相依                | 解耦 3 處 circular dependency；拆分 god service          |
| API 契約           | 🟡 核心路由均有 Zod 嚴格驗證，但 OpenAPI 漏載 2 個模組              | 100% 路由與 OpenAPI 規範同步              | `src/openapi/document.ts` 補入漏匯入的 schema            |
| 型別與工具鏈       | 🔴 存在 728 個 ESLint warnings，且 typecheck 於 main 上失敗         | `typecheck` 0 錯誤、`--max-warnings=0`    | 修補測試 Mock 型別，將 ESLint warning 清零並納入 CI 閘門 |
| **測試真實性**     | 🟡 2,121 測試通過，但部分關鍵刪除端點 Mock 過度致突變存活           | 關鍵授權與計算邏輯突變 100% 殺死          | 補充 service 層真實授權測試，消除假安全感                |
| 錯誤處理與可觀測性 | 🔴 散落 247 處 `console.*`，無 `requestId`，8 處空 catch 吞錯       | 結構化日誌（Pino）+ 端到端 correlation id | 引入結構化 logger 與 request-id middleware               |
| 設定與 secret      | 🔴 JWT Secret 缺漏回退為空字串；缺少全域啟動驗證                    | 啟動時以 Zod 一次驗完所有必要環境變數     | 建立嚴格之 `env.schema.ts` fail-fast 機制                |
| 資安與隱私         | 🟡 密碼雜湊與查詢過濾完善，但路徑規劃無限流，GPS 軌跡無過期清理     | 運算端點限流、敏感軌跡定期銷毀            | 路徑規劃端點掛載 limiter，SOS 軌跡加 TTL 索引            |
| 前端工程           | ⚪ 不適用（本倉庫為純後端 API 服務）                                | —                                         | 前端位於獨立 repo                                        |

---

## 1. 事實基線

本節紀錄所有機械執行產生的指令輸出與 exit code，後續所有發現均能回溯至此。

| 項目                            | 結果                                                                                       | 執行指令                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| 技術棧與套件管理                | Node.js 22, Express, TypeScript 5.8, MongoDB (Mongoose), Redis (ioredis), PostGIS          | `cat package.json`                          |
| 規模與原始檔數                  | TypeScript 原始檔 397 個（不含測試 210 個）、測試檔 187 個；原始碼總行數約 81,840 行       | `find src -name '*.ts'`                     |
| 架構邊界檢查 (`lint:arch`)      | **通過 (exit=0)**，Architecture boundary check passed                                      | `pnpm run lint:arch`                        |
| 型別檢查 (`typecheck`)          | **失敗 (exit=1)**，6 個測試檔共 14 處 TS2739 / TS2322 錯誤                                 | `pnpm run typecheck`                        |
| 建置檢查 (`build`)              | **通過 (exit=0)**（因 `tsconfig.json` 排除 `src/**/*.test.ts`）                            | `pnpm run build`                            |
| 語法檢查 (`lint`)               | **通過但有警告 (exit=0)**，產出 **728 個 warnings**（未設 `--max-warnings=0`）             | `pnpm run lint`                             |
| 程式碼格式 (`format:check`)     | **通過 (exit=0)**，All matched files use Prettier code style                               | `pnpm run format:check`                     |
| 單元與整合測試 (`test`)         | **通過 (exit=0)**，171 檔通過、6 檔因環境跳過（**2,121 passed, 16 skipped**，耗時 16.88s） | `pnpm test`                                 |
| 覆蓋率檢查 (`test:coverage`)    | **通過 (exit=0)**，Statements: 77.07%, Branches: 66.8%, Functions: 78.03%, Lines: 79.09%   | `pnpm run test:coverage`                    |
| Python 腳本測試 (`test:python`) | **通過 (exit=0)**，9 個 Python 測試檔全數通過 (9/9 passed)                                 | `pnpm run test:python`                      |
| 依賴安全性掃描 (`audit`)        | **通過 CI 閥值 (exit=0)**，4 個 moderate 弱點，0 critical / 0 high                         | `pnpm audit --audit-level high`             |
| 循環相依分析 (`madge`)          | **失敗 (exit=1)**，發現 3 處循環相依鏈                                                     | `npx madge --circular --extensions ts src/` |
| Git 工作目錄狀態                | 乾淨（`git status --porcelain` 無輸出）                                                    | `git status --porcelain`                    |

---

## 2. 發現清單（依嚴重度）

所有條目均已通過 `verify_findings.py --strict` 機械檢驗，保證檔案、行號、引文與最低證據 100% 查證屬實。

### P0-1 JWT_ACCESS_SECRET 與 JWT_REFRESH_SECRET 未設定時預設為空字串，允許以空密鑰偽造權杖通過認證

- **驗證**：`presence`／已通過驗證關卡（`findings.verified.json` id=P0-1）
- **證據**：`src/config/jwt.ts:40, 45, 51, 66`
  > `src/config/jwt.ts:40`: `jwt.sign({ user: toPublicUser(user) }, process.env.JWT_ACCESS_SECRET ?? "", {`  
  > `src/config/jwt.ts:45`: `jwt.sign({ user: toPublicUser(user) }, process.env.JWT_REFRESH_SECRET ?? "", {`  
  > `src/config/jwt.ts:51`: `const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET ?? "");`  
  > `src/config/jwt.ts:66`: `const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET ?? "");`
- **可達路徑**：未設定環境變數部署 → 伺服器啟動無報錯 → 攻擊者使用密鑰 `""`（空字串）本地簽發任意 `userId` 的 HS256 JWT → 帶入 `Authorization: Bearer <token>` 存取 `/api/v1/user/*` → 驗證通過
- **影響**：任何人在環境變數未注入或被清空時，均能免密碼登入任意帳號（包括管理員帳號），屬於最高等級認證繞過風險。
- **怎麼修**：在 `src/config/jwt.ts` 載入時強制斷言 `process.env.JWT_ACCESS_SECRET` 與 `process.env.JWT_REFRESH_SECRET` 存在且長度大於等於 32 字元，若缺漏直接拋出不可恢復之錯誤中斷進程。
- **怎麼驗**：未提供 `JWT_ACCESS_SECRET` 啟動服務時程序必須立即 Crash 退出；使用空字串密鑰簽名之 Token 發送至受保護路由必須回應 HTTP 401 Unauthorized。

---

### P1-1 pnpm run typecheck 存在 14 處型別錯誤 exit=1，但 pnpm run build exit=0，CI 型別關卡破口

- **驗證**：`behavior`／已通過驗證關卡（`findings.verified.json` id=P1-1）
- **證據**：`src/modules/accessible-route/low-floor-rerank.test.ts:6`
  > `const leg: BusLeg = {`
- **重現指令**：`pnpm run typecheck`
- **實際輸出片段**：
  > `error TS2739: Type ... is missing the following properties from type 'BusLeg': subRouteUid, subRouteName`
- **影響**：CI workflow 包含 `Typecheck (incl. tests)` 關卡，目前 main 分支處於無法通過 CI 的狀態。而本機 `pnpm run build` 因 `tsconfig.json` 的 `exclude: ["src/**/*.test.ts"]` 隱蔽了此錯誤，使開發者誤以為編譯全綠。
- **怎麼修**：更新 `low-floor-rerank.test.ts`、`hazard-routing.test.ts`、`realtime-transit.test.ts`、`ranking.test.ts`、`route-schedule.test.ts`、`taipei-bus-routing.test.ts`、`navigation-session.test.ts` 中的 `BusLeg` mock 資料，補齊 `subRouteUid` 與 `subRouteName`。
- **怎麼驗**：執行 `pnpm run typecheck`，exit code 必須為 0。

---

### P1-2 緊急聯絡人與評論刪除端點之擁有權檢查因測試層過度 Mock 導致突變抽測全數存活

- **驗證**：`mutation`／已通過驗證關卡（`findings.verified.json` id=P1-2）
- **證據**：
  > `src/modules/emergency-contact/emergency-contact.service.ts:125`: `if (String(contact.userId) !== input.userId) {`  
  > `src/modules/review/review.service.ts:341`: `if (review.userId !== userId) {`
- **突變抽測紀錄**：
  - 目標：`src/modules/emergency-contact/emergency-contact.service.ts:125`
  - 破壞改動：將 `!==` 反轉為 `===`（即本人禁止刪除，非擁有者才能刪除）
  - 測試指令：`pnpm vitest run src/modules/emergency-contact/`
  - 結果：**存活（SURVIVED）**，2 個測試檔共 9 個測試全數通過
  - 工作目錄已復原：`reverted: true`
- **根因分析**：`emergency-contact.routes.test.ts` 將整個 `emergency-contact.service` 完全 Mock（`vi.mock("./emergency-contact.service")`），只驗證「當 Mock 回傳 403 時 Controller 回傳 403」，而該模組根本沒有 `emergency-contact.service.test.ts`。同理，`review.service.test.ts` 漏測了 `deleteReview`。
- **影響**：授權檢查核心防線沒有真實測試守護，任何重構疏失導致的越權刪除（IDOR）回歸均無法被測試偵測。
- **怎麼修**：建立 `src/modules/emergency-contact/emergency-contact.service.test.ts`，並在 `review.service.test.ts` 中補上真實測試，針對「非擁有者呼叫刪除」斷言必須回傳 `FORBIDDEN`。
- **怎麼驗**：將 `if (String(contact.userId) !== input.userId)` 反轉時，測試必須立即失敗（KILLED）。

---

### P1-3 無障礙路徑規劃端點 /api/v1/a11y/accessible-route 未掛載 Rate Limiting 防護

- **驗證**：`absence`／已通過驗證關卡（`findings.verified.json` id=P1-3）
- **搜尋範圍**：`src/modules/accessible-route/accessible-route.router.ts`
- **證據**：`src/modules/accessible-route/accessible-route.router.ts:14`
  > `router.post(`
- **查證指令**：
  - `rg 'Limiter|rateLimit' src/modules/accessible-route/accessible-route.router.ts`
  - `sed -n '12,25p' src/modules/accessible-route/accessible-route.router.ts`
- **可達路徑**：匿名客戶端 → `POST /api/v1/a11y/accessible-route` → `validateRequest` → `accessibleRoute` Controller → 呼叫 OTP / Valhalla / PostGIS A* 圖資規劃與即時交通運算
- **影響**：該端點是全系統運算複雜度最高、耗費記憶體與 CPU 最大的端點。缺乏限流使單一惡意或爬蟲客戶端能輕易耗盡後端資源引發 DoS。
- **怎麼修**：於 `src/modules/accessible-route/accessible-route.router.ts` 中掛載基於 Redis 的 `routePlanningLimiter`（例如每分鐘上限 20 次）。
- **怎麼驗**：使用壓測或指令連續發送 25 次路徑規劃請求，第 21 次起必須回傳 HTTP 429 Too Many Requests。

---

### P2-1 模組與規劃器間存在 3 處循環相依（madge circular dependencies）

- **驗證**：`behavior`／已通過驗證關卡（`findings.verified.json` id=P2-1）
- **證據**：
  > `src/modules/accessible-route/planners/traffic-corridor-match.ts:12`: `import { pointToSegmentMeters } from "./traffic-overlay";`  
  > `src/modules/traffic/traffic-flow.service.ts:27`: `import { scheduleLiveRefresh } from "./traffic-live.worker";`  
  > `src/modules/line/line.types.ts:2`: `import type { PlanRouteResult } from "../accessible-route/accessible-route.service";`
- **重現指令**：`npx madge --circular --extensions ts src/`
- **實際輸出片段**：
  > `Found 3 circular dependencies!`  
  > `1) traffic-overlay.ts > traffic-corridor-match.ts`  
  > `2) traffic-flow.service.ts > traffic-live.worker.ts`  
  > `3) accessible-route.service.ts > user.service.ts > line.adapter.ts > line.types.ts`
- **影響**：造成程式碼在執行期載入順序敏感，增加模組拆分困難度；同時發現現有 `check-architecture.mjs` 因僅檢查檔案角色且未追蹤 adapters 穿透路徑，產生架構檢查盲區。
- **怎麼修**：
  1. 將 `pointToSegmentMeters` 純幾何運算移至 `src/utils/geo.ts`。
  2. 將排程邏輯抽離 `traffic-flow.service.ts`，由 worker 或統一排程器管理。
  3. 將 `PlanRouteResult` 型別定義抽出至 `src/types/route.ts`。
- **怎麼驗**：執行 `npx madge --circular --extensions ts src/` 輸出 0 circular dependencies。

---

### P2-2 OpenAPI 文件產生器遺漏 visual-a11y 與 welfare 模組之 Schema 匯入

- **驗證**：`absence`／已通過驗證關卡（`findings.verified.json` id=P2-2）
- **搜尋範圍**：`src/openapi/document.ts`
- **證據**：`src/openapi/document.ts:4, 19`
  > `src/openapi/document.ts:4`: `import "../modules/a11y/a11y.schema";`  
  > `src/openapi/document.ts:19`: `import "../modules/traffic/traffic.schema";`
- **查證指令**：
  - `rg 'visual-a11y|welfare' src/openapi/document.ts`
  - `cat src/openapi/document.ts`
- **影響**：雖然兩個模組的 Schema 與 Router 皆已實作並呼叫 `registry.registerPath`，但因 `document.ts` 未匯入，導致 `/api/v1/openapi.json` 與 `/docs` 產出的 API 文件完全缺失 `/visual-a11y` 與 `/welfare` 相關端點。
- **怎麼修**：在 `src/openapi/document.ts` 補上 `import "../modules/visual-a11y/visual-a11y.schema";` 與 `import "../modules/welfare/welfare.schema";`。
- **怎麼驗**：抓取 `/api/v1/openapi.json`，確認 `paths` 欄位包含 `/visual-a11y` 與 `/welfare` 端點。

---

### P2-3 realtime-transit.ts 包含 8 處空 catch 區塊吞掉 TDX 錯誤並快取空資料

- **驗證**：`count`／已通過驗證關卡（`findings.verified.json` id=P2-3）
- **出現次數**：8 處
- **證據**：
  > `src/modules/accessible-route/planners/realtime-transit.ts:236`: `} catch {`  
  > `src/modules/accessible-route/planners/realtime-transit.ts:501`: `} catch {`  
  > `src/modules/accessible-route/planners/realtime-transit.ts:665`: `} catch {`  
  > （其餘分佈於同檔第 433、695、753、822、852 行）
- **查證指令**：`rg -n "catch {" src/modules/accessible-route/planners/realtime-transit.ts`
- **影響**：外部 TDX API 若發生 500 錯誤、認證 Token 失效或格式變更，程式皆以靜默空區塊捕捉並快取空陣列，運維與開發者無法從日誌中感知任何外部依賴降級。
- **怎麼修**：在 catch 區塊中補上結構化警告日誌（例如 `logger.warn("[realtime-transit] TDX request failed", { url, error })`）。
- **怎麼驗**：於整合測試或模擬環境中注入 TDX 網路異常，確認日誌有記錄錯誤警告。

---

### P2-4 缺乏結構化日誌與請求追蹤識別碼，執行期程式碼散落 247 處 console 輸出

- **驗證**：`count`／已通過驗證關卡（`findings.verified.json` id=P2-4）
- **出現次數**：247 處（排除測試、fixtures、data 檔與 `src/scripts/` 一次性工具）
- **證據**：
  > `src/server.ts:28`: `console.log(\`Server is running on port \${PORT}\`);`  
`src/server.ts:40`:` console.error("TDX MQTT failed", err);`  
`src/app.ts:86`:` app.use(morgan("common"));`
- **查證指令**：`rg -n "console\.(log|error|warn|info)" src/ -g '!*.test.ts' -g '!*.fixture.ts' -g '!*.data.ts' -g '!src/scripts/**' -g '!*.html'`
- **影響**：採用非結構化文字日誌且缺乏 request-id / correlation-id 貫穿機制，當多並發請求發生異常時，無法關聯單次請求的完整調用鏈。
- **怎麼修**：引入 Pino 結構化日誌工具，封裝全域 `logger`，並在 Express 中介層產生 `x-request-id` 綁定至異步上下文。
- **怎麼驗**：發送請求時，所有產生的日誌均應為 JSON 格式且帶有一致的 `requestId` 屬性。

---

### P2-5 SOS 求救會話之歷史軌跡座標於資料庫永久留存且無 TTL 索引或定期清理機制

- **驗證**：`absence`／已通過驗證關卡（`findings.verified.json` id=P2-5）
- **搜尋範圍**：`src/model/sos-session.model.ts`
- **證據**：
  > `src/model/sos-session.model.ts:91`: `sosSessionSchema.index(`  
  > `src/model/sos-session.model.ts:98`: `sosSessionSchema.index({ status: 1, locationUpdatedAt: 1 });`
- **查證指令**：
  - `rg 'expireAfterSeconds' src/model/sos-session.model.ts`
  - `rg 'start.*Expiry|cleanup' src/modules/sos/`
- **影響**：SOS 求救會話包含高敏感的使用者 GPS 軌跡與時間戳（`breadcrumbs`），結案後無限期儲存於 MongoDB，不符合隱私法規之資料最小化保存期限規範。
- **怎麼修**：於 `SosSession` 的 `resolvedAt` 欄位建立 MongoDB TTL 索引（例如 30 天過期自動清理），或建立如 `hazard-report.expire.ts` 的定期清理排程。
- **怎麼驗**：模擬結案已逾期之會話，確認資料庫會自動將其物理刪除。

---

## 3. 測試真實性專章

**結論**：測試套件共有 2,121 個測試案例且覆蓋率數據亮眼（Statements 77.07%），但在業務關鍵授權路徑上存在「過度 Mock」產生的虛假安全感；6 個突變抽測目標中有 2 個授權檢查完全存活。

### 3.1 突變抽測結果

| 關鍵行為                           | 測試位置                                                         | 型別                 | 突變內容                                     | 結果                | 判定                                    |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------- | -------------------------------------------- | ------------------- | --------------------------------------- |
| 緊急聯絡人刪除端點之擁有者驗證     | `src/modules/emergency-contact/emergency-contact.routes.test.ts` | Integration (Mocked) | 將 `!==` 改為 `===`（反轉擁有權判斷）        | **存活 (SURVIVED)** | **裝飾性測試**（Service 層被完全 Mock） |
| 景點評論刪除端點之擁有者驗證       | `src/modules/review/review.routes.test.ts`                       | Integration (Mocked) | 將 `!==` 改為 `===`（反轉擁有權判斷）        | **存活 (SURVIVED)** | **裝飾性測試**（漏測 deleteReview）     |
| SOS 求救會話讀取端點之擁有者驗證   | `src/modules/sos/sos.service.test.ts:435`                        | Unit                 | 將 `!==` 改為 `===`（反轉擁有權判斷）        | **殺死 (KILLED)**   | **真實有效**                            |
| 密碼重設 Token 過期驗證            | `src/modules/user/user.auth.service.test.ts:270`                 | Unit                 | 將 `$gt: now` 改為 `$lt: now`                | **殺死 (KILLED)**   | **真實有效**                            |
| 危害回報查詢之過期資料過濾         | `src/modules/hazard-report/hazard-report.service.test.ts:226`    | Unit / DB            | 將 `expiredAt: { $gt: now }` 改為 `$lt: now` | **殺死 (KILLED)**   | **真實有效**                            |
| 無障礙路徑無設施時之中立基準分計算 | `src/modules/accessible-route/scoring.test.ts:136`               | Unit                 | 將中立基準分 65 改為 0                       | **殺死 (KILLED)**   | **真實有效**                            |

**工作目錄狀態說明**：所有 6 次突變均依序單獨進行，跑完相關測試後立即執行 `git checkout -- <file>` 復原，抽測結束後經 `git status --porcelain` 驗收確認工作目錄乾淨無污染。

### 3.2 測試品質指標

| 指標                          | 數值                                | 評估說明                                          |
| ----------------------------- | ----------------------------------- | ------------------------------------------------- |
| 測試檔數 / 原始檔數           | 187 / 397 (47.1%)                   | 測試檔案比例相當高                                |
| Test Case 總數                | 2,129 (估計)                        | 測試用例豐富                                      |
| 斷言總數 / 平均每 Case 斷言數 | 5,323 / **2.50**                    | 斷言密度健康（>1.0 為標準）                       |
| 強斷言 vs 弱斷言              | 3,718 vs 164                        | 強斷言佔 95.8%，品質良好                          |
| Mock 呼叫斷言數               | 1,732 處（其中 721 處僅斷言被呼叫） | 部分 route 測試過度依賴 Mock，掩蓋了 Service 缺陷 |
| 含錯誤/異常路徑斷言行數       | 781 行                              | 異常路徑測試覆蓋充分                              |
| 測試跳過（Skip）數量          | 6 個整合測試檔共 16 個 Case         | 均明確因本機缺少 PostGIS DB 而合法條件跳過        |

### 3.3 歷史篡改鑑識

透過 `test_forensics.py` 對近 500 次 Commit 進行「同時修改實作與既有測試」的歷史掃描，共發現 192 次同 commit 異動，其中 3 個 commit 觸發測試改弱特徵評分：

1. `364f3429e` (2026-09-04)：`feat(nav-instructions)!: require routeToken and drop inline route input` —— **判定：正常需求變更**。該 commit 重構廢棄舊 inline 參數並改用 routeToken，期望值同步更新屬合法行為。
2. `d6b833e97` (2026-08-15)：`refactor(arch): introduce a repository layer for every module service` —— **判定：正常架構重構**。引入 Repository 層調整呼叫簽名。
3. `e4ee353e3` (2026-07-03)：`feat(a11y): add campus accessibility functions` —— **判定：正常功能增添**。

### 3.4 測試分層真實性

- **Unit 測試**：工具函式（`geo.ts`、`transit-text.ts`、`wkt.ts`）與演算法（A*、CSR Walk、Scoring）分層極為扎實，無 I/O 且執行迅速。
- **Integration 測試**：全專案擁有 18 個 `*.repository.integration.test.ts`，使用 `mongodb-memory-server` 啟動真實 in-memory MongoDB 實跑查詢，絕非空殼 Mock。
- **Route / Controller 測試**：部分模組（如 `emergency-contact`、`review`）在 route 測試中將 Service 完全 Mock 掉，造成 Controller 僅測試 HTTP 轉換，而 Service 缺少單元測試，形成測試真空。

---

## 4. 前端專章

本專案為純後端 TypeScript/Node.js 服務，無前端視圖目錄或前端建置產物。前端應用位於獨立倉庫（`taipei-accessible-map`），本專章不適用。

---

## 4.9 已排除的疑點（強制）

查過但**確認不是問題**的項目，逐條列出以證明未捕風捉影：

| 疑點                                                                 | 查證結果                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/hazard-report/:id` 無需認證，疑似 IDOR 或舉報者個資洩漏 | **不是漏洞**。`src/modules/hazard-report/hazard-report.repository.ts:7` 之 `PUBLIC_SELECT = "-reporterId -photoStoragePath -confirmedBy -deniedBy"` 在資料庫查詢層已強制投影掉所有個人敏感欄位。 |
| SQL 注入風險（SQL Injection）                                        | **零可達案例**。專案主要使用 Mongoose ORM；涉及 PostGIS 之 SQL 皆使用預編譯或嚴格參數化查詢，無任何字串拼接 SQL。                                                                                |
| 密碼雜湊強度不足                                                     | **不是問題**。全站密碼均採用 `bcryptjs` 雜湊並設定嚴格 Cost Factor（`BCRYPT_COST`），重設 Token 使用安全亂數與 sha256 雜湊儲存。                                                                 |
| 編譯器檢查逃生門濫用                                                 | **零命中**。全倉庫 `src/` 與 `tests/` 下 `@ts-ignore` 與 `@ts-expect-error` 出現次數為 0。                                                                                                       |
| 寫死正式環境 Secret 於 Git 歷史                                      | **無洩漏**。掃描全庫及 git log，`.env` 未曾進過版本控制，無 OpenAI/Gemini 或 AWS 金鑰硬編碼跡象。                                                                                                |

---

## 5. 未驗證／查不到（強制）

本節列出受限於環境或權限而未能實測覆蓋的項目：

1. **PostGIS 圖資路徑規劃之整合測試**：`astar.integration.test.ts`、`graph-loader.integration.test.ts` 等 6 個測試檔案包含 `describe.skipIf(!databaseUrl)`。因測試環境未啟動本機 PostGIS Docker 容器，此 6 檔於本次稽核中跳過。
2. **TDX MQTT 實時訂閱與 CWA 即時警報管線**：需要真實的外部 TDX MQTT 帳號憑證與長時間連線監聽，本次稽核未進行外部連線壓測。
3. **Valhalla 行人圖資即時瓦片打包（`build:traffic-tar`）之線上熱重載**：依賴本地執行中的 Valhalla Docker 容器與特定目錄掛載，本次僅靜態查驗了其原子寫入與 Redis 分散式鎖邏輯。

---

## 6. 建議的處理順序

| 順序  | 項目                                                     | 預估工時 | 理由與依據                                               |
| ----- | -------------------------------------------------------- | -------- | -------------------------------------------------------- |
| **1** | **修復 JWT Secret 空字串漏洞（P0-1）**                   | 0.5 小時 | 最高安全風險，未設環境變數時可偽造任意權杖。             |
| **2** | **修復 BusLeg Mock 錯誤恢復 typecheck 綠燈（P1-1）**     | 1 小時   | 恢復 CI 流程正常運行，修復破口的型別防護網。             |
| **3** | **補齊緊急聯絡人與評論刪除之真實授權測試（P1-2）**       | 3 小時   | 消除突變存活盲區，確保權限檢查邏輯不可被靜默破壞。       |
| **4** | **為無障礙路徑規劃端點掛載 Rate Limiter（P1-3）**        | 2 小時   | 防止高運算端點遭 DoS 攻擊導致服務器資源耗盡。            |
| **5** | **解開 3 處循環相依並更新架構檢查腳本（P2-1）**          | 3 小時   | 消除執行期載入順序隱患，擴大 check-architecture 覆蓋面。 |
| **6** | **OpenAPI 補匯入 visual-a11y 與 welfare Schema（P2-2）** | 0.5 小時 | 修復 API 文件與實際掛載端點的漂移。                      |
| **7** | **為 realtime-transit.ts 補上失敗警告日誌（P2-3）**      | 1.5 小時 | 消除靜默失敗，提升外部 API 可觀測性。                    |
| **8** | **引入結構化日誌（Pino）與 requestId 中介層（P2-4）**    | 4 小時   | 提供生產環境排查與鏈路追蹤能力。                         |
| **9** | **為 SOS 求救軌跡資料增加過期清理機制（P2-5）**          | 2 小時   | 落實個資隱私最小化保存原則。                             |

---

## 6.9 本報告修正過的數字（強制）

本報告的統計數字皆經過二階段核對，以下列出掃描候選與實際查證之差異：

| 初稿 / 候選                     | 實際核實結果                       | 修正原因與說明                                                                                                                                                   |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console.log` 掃描候選為 383 處 | **執行期路徑實質為 247 處**        | `repo_scan.sh` 初步統計誤入了 `src/scripts/` 下之一次性資料匯入腳本與 HTML 檔案。                                                                                |
| `skip/only/xfail` 初判為 163 處 | **實際只有 16 個 Case 被合法跳過** | 掃描腳本之正則誤吃了 `skipLibCheck` 與註解中的「skip」單詞；實際全庫 0 個 `.only`，跳過皆因環境無 PostGIS。                                                      |
| 模組循環相依初判 0 處           | **實際存在 3 處循環相依**          | 專案自帶的 `check-architecture.mjs` 僅檢查特定命名的角色檔案，對 `planners/` 目錄及經由 `adapters/` 穿透的模組循環存在檢測盲區；經 `madge` 完整解析後查出 3 處。 |

---

## 7. 本輪動過什麼

- **執行過之指令**：
  - `repo_scan.sh`、`test_forensics.py`
  - `pnpm run lint:arch`、`pnpm run typecheck`、`pnpm run build`、`pnpm run lint`、`pnpm run format:check`、`pnpm test`、`pnpm run test:coverage`、`pnpm run test:python`、`pnpm audit`
  - `npx madge --circular --extensions ts src/`
  - 6 次突變抽測（分別修改 `emergency-contact.service.ts`、`review.service.ts`、`sos.service.ts`、`user.auth.repository.ts`、`hazard-report.repository.ts`、`scoring.ts`，每測完一次即刻執行 `git checkout --`）
- **中間產物存放與清理**：
  - 中間發現清單皆寫於 `/tmp/audit-work/findings.json` 及 `/tmp/audit-work/findings.verified.json`，未落於專案目錄內。
  - 稽核完成後已執行清理命令刪除 `/tmp/audit-work`。
- **本報告為本輪稽核在專案倉庫中留下的唯一檔案**。

收尾時 `git status --porcelain` 輸出驗收：

```text
?? docs/audit/2026-09-06-product-grade-audit.md
```
