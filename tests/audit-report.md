# API 回傳資訊審計：現行測試與舊 E2E 訊號

> **校正日期：2026-08-15**
>
> 舊的 `tests/e2e/api.test.ts` 已移除。它是以 Axios 呼叫外部執行中的
> server 的獨立 script，不在 `vitest.config.ts` 的 `src/**/*.test.ts`
> include 內，也沒有 `package.json` 的執行入口；因此不能把它的輸出解讀成
> `pnpm test` 的全通過覆蓋率證據。

## 裁決

本次採用「刪除死測試」路徑，而不是把舊路徑換成另一組 live calls。舊腳本
同時呼叫已移除的 API、未被 Vitest 納入，並依賴外部資料庫、上游服務與固定
帳號狀態；保留它會繼續產生無入口且不可重現的綠燈訊號。

刪除不會降低目前可執行測試覆蓋：該檔案從未被 `pnpm test` include，也不是
coverage 的來源。現行 route-level 測試透過 Supertest 走真正的 Express app，
並在 service/repository seam 注入可控替身；其餘純函式與 repository 測試仍由
Vitest 執行。

## 舊腳本逐項對照

下表是舊腳本 20 個呼叫的處置。`覆蓋` 只表示有現行可執行測試證據；不再把
已移除或尚未有 route-level 測試的項目標成成功。

| 舊腳本呼叫                           | 現行處置                                                          | 可核對的替代證據                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /health`                        | 現行路由仍存在；無對應 route-level test，未宣稱覆蓋               | `src/app.ts:75`                                                                                                |
| `GET /api/v1/openapi.json`           | 覆蓋                                                              | `src/modules/a11y/a11y.routes.test.ts:289`、`src/modules/accessible-route/accessible-route.routes.test.ts:481` |
| `POST /api/v1/user/login`            | 舊 OAuth body 已移除；現行登入是 `/user/auth/login`               | `src/modules/user/user.auth.routes.test.ts:174`、`:428`                                                        |
| `GET /api/v1/user/info`              | 覆蓋（含有效 token、查無使用者、tokenVersion）                    | `src/middleware/auth-contract.routes.test.ts:286-335`                                                          |
| `POST /api/v1/user/config`           | 覆蓋（JWT identity 與 strict body）                               | `src/modules/user/user.config.routes.test.ts:54-79`                                                            |
| `POST /api/v1/user/config/update`    | 覆蓋（JWT identity 與更新 body）                                  | `src/modules/user/user.config.routes.test.ts:81-111`                                                           |
| `POST /api/v1/user/token`            | endpoint 已移除                                                   | `src/modules/user/user.auth.routes.test.ts:428-434`                                                            |
| `POST /api/v1/user/refresh`          | 現行路由仍存在；無對應 route-level test，未宣稱覆蓋               | `src/modules/user/user.router.ts:95`                                                                           |
| `POST /api/v1/transit/bus`           | endpoint 已移除；現行 bus API 改為多個 GET route                  | `src/modules/transit/transit.router.ts:28-77`                                                                  |
| `GET /api/v1/transit/bus/realtime`   | endpoint 已移除；現行位置查詢為 `/bus/positions`                  | `src/modules/transit/transit.routes.test.ts:267-315`                                                           |
| `GET /api/v1/a11y/all-places`        | endpoint 已移除                                                   | `src/modules/a11y/a11y.routes.test.ts:238-240`                                                                 |
| `GET /api/v1/a11y/all-bathrooms`     | 覆蓋                                                              | `src/modules/a11y/a11y.routes.test.ts:82-126`                                                                  |
| `GET /api/v1/a11y/nearby-a11y`       | endpoint 已移除；現行設施查詢拆為明確路由                         | `src/modules/a11y/a11y.router.ts:25-58`                                                                        |
| `GET /api/v1/a11y/place`             | endpoint 已移除；現行 details API 由 place-search module 提供     | `src/modules/place-search/place-search.routes.test.ts:204-295`                                                 |
| `POST /api/v1/a11y/accessible-route` | 覆蓋（成功、schema、失敗與 optional auth）                        | `src/modules/accessible-route/accessible-route.routes.test.ts:67-579`                                          |
| `GET /api/v1/air/air-quality`        | 現行路由仍存在；只有 service-level tests，未宣稱 route-level 覆蓋 | `src/modules/air/air.router.ts:6-15`、`src/modules/air/air.service.test.ts:33-153`                             |
| `POST /api/v1/ai/intent`             | 現行路由仍存在；未找到對應 route-level test，未宣稱覆蓋           | `src/modules/ai/ai.router.ts:26-33`、`src/modules/ai/ai.controller.ts:63-97`                                   |
| `POST /api/v1/ai/explain`            | 現行路由仍存在；未找到對應 route-level test，未宣稱覆蓋           | `src/modules/ai/ai.router.ts:29-33`、`src/modules/ai/ai.controller.ts:11-60`                                   |
| `POST /api/v1/ai/chat`               | 覆蓋（non-streaming、SSE 與日期注入）                             | `src/modules/ai/ai.chat.controller.test.ts:23-56`、`src/modules/ai/date-injection.test.ts:21-37`               |
| `POST /api/v1/user/logout`           | 現行路由仍存在；無對應 route-level test，未宣稱覆蓋               | `src/modules/user/user.router.ts:110`                                                                          |

這份對照的目的，是把舊 live script 的每一項輸入從「假定通過」改成可追溯
的現行狀態；未覆蓋項目需另立明確的 route-test 工作，不由刪除的死 script
代為背書。

## 現行可執行證據

本分支以 Vitest include 的 `src/**/*.test.ts` 為可執行測試邊界。校正前後均應
以同一組指令重新取得數字；本次校正後實跑結果為：

```text
pnpm test -- --reporter=verbose
Test Files  124 passed (124)
Tests       1363 passed (1363)
```

`pnpm test:coverage` 同樣通過 thresholds，實際摘要為：

```text
Statements   69.42% (7242/10431)
Branches     59.01% (4121/6983)
Functions    72.47% (1340/1849)
Lines        71.32% (6743/9454)
```

目前有 17 個 route-oriented test files（含 `src/app.test.ts` 與 auth contract），
以 `it`/`it.each` 宣告計算為 224 個 route test declarations；完整 Vitest 數字
仍以上方實跑輸出為準。舊 E2E 檔案刪除後，不再提供舊腳本的全通過摘要、
冗餘欄位無異常摘要或任何 live-server 綠燈宣稱。

若未來需要真正的 production smoke test，應另建有明確 package/CI 入口、測試
資料隔離、失敗即非零退出碼與可重現依賴的流程；本報告不把該未建立的流程
視為現況能力。
