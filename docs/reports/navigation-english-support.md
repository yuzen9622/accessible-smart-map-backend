# 導航指引英文支援交付記錄

日期：2026-10-09。變更位於本機工作目錄，未提交或部署。

## 行為與端點

`POST /api/v1/a11y/route/instructions` 接受 `language: "en"`，省略時維持 `zh-TW`。
步行、車行、搭車、設施、樓梯／陡坡提醒與抵達指引使用英文模板，且保留原有幾何、步驟及距離語意。
`POST /api/v1/a11y/accessible-route/reroute` 也接受此參數，供兩組導航指引使用。
沒有新增端點掛載或環境變數。

前端必須在以上請求傳送目前語言；[串接契約](../FRONTEND_MIGRATION_WALK_INSTRUCTIONS.md) 包含範例及完整相對方向值域。

## 驗證

- `pnpm build`：通過，包含 `lint:arch` 與正式程式 TypeScript 編譯。
- `TZ=UTC pnpm test src/modules/nav-instructions src/modules/accessible-route/reroute.service.test.ts src/modules/accessible-route/accessible-route.routes.test.ts src/modules/accessible-route/accessible-route.schema.test.ts src/modules/voice/navigation-session.test.ts`：9 個測試檔、276 個測試通過。
- HTTP 測試使用正式 Express app、schema、controller 與真實指引引擎；routeToken 查詢使用 fixture，未存取正式路線服務。
- `git diff --check`：通過。
- `pnpm typecheck`：未通過。錯誤位於未修改的 `hazard-report.ai-job.repository.integration.test.ts` 及 `retention.integration.test.ts`。另以 HEAD 的獨立暫存副本執行相同 TypeScript 設定，重現同兩檔共 34 個錯誤；沒有修改這些無關測試。

## 限制與後續串接

路名、站名、路線名、車種名稱保留來源文字，沒有使用翻譯服務；來源只有中文時仍會顯示中文專有名稱。
`accessible-route` 原始路線摘要與評分文字、WebSocket 語音會話的語言選擇不包含在本次 HTTP 導航指引變更中。
英文車行資料缺少可辨識的 maneuver 時，回傳概略英文指引及既有 `ROAD_STEPS_UNAVAILABLE` 警告代碼。
相同重新規劃 `clientRequestId` 維持回放首次結果；語言切換可對目前 token 再呼叫 `/route/instructions`。

尚未部署，未進行前端瀏覽器／實機 TTS 驗收，也未執行全專案 Vitest 套件。

## 變更檔案

| 檔案 | 原因 |
| --- | --- |
| `src/utils/nav-instructions-engine.ts` | 將語言傳遞至所有導航模式、相對方向、設施及錯誤提示，預設仍為繁中。 |
| `src/utils/nav-instructions-english.ts` | 新增英文步行、車行、方位與通用地點標籤模板。 |
| `src/constants/messages.ts` | 集中英文與繁中導航 API 訊息，以及英文重新規劃訊息。 |
| `src/modules/nav-instructions/nav-instructions.schema.ts` | 接受 language: en，更新自動生成的 OpenAPI 說明。 |
| `src/modules/nav-instructions/nav-instructions.controller.ts` | 傳遞經驗證的語言，回傳對應語言的成功／錯誤訊息。 |
| `src/modules/nav-instructions/nav-instructions.service.ts` | 將語言傳入純指引引擎並翻譯 token 過期訊息。 |
| `src/modules/nav-instructions/nav-instructions.types.ts` | 加入語言輸入型別及英文相對方向值域。 |
| `src/schemas/nav-instructions-data.schema.ts` | 擴充並共用英文相對方向的回應 schema。 |
| `src/modules/accessible-route/accessible-route.schema.ts` | 重新規劃請求支援 language，回應引用共用方向 schema。 |
| `src/modules/accessible-route/accessible-route.types.ts` | 重新規劃輸入加入選用語言欄位。 |
| `src/modules/accessible-route/accessible-route.controller.ts` | 依語言回傳重新規劃完成與內部錯誤訊息。 |
| `src/modules/accessible-route/reroute.service.ts` | 兩組重新規劃指引使用指定語言，保持原有版本與重送契約。 |
| `src/modules/nav-instructions/nav-instructions.english.test.ts` | 驗證各模式英文、機器欄位不變、來源名稱保留、時區及降級行為。 |
| `src/modules/nav-instructions/nav-instructions.routes.test.ts` | 以真實指引引擎驗證 HTTP 英文、繁中預設、錯誤與 OpenAPI。 |
| `src/modules/nav-instructions/nav-instructions.integration.test.ts` | 驗證 controller 傳遞 schema 預設語言。 |
| `src/modules/accessible-route/accessible-route.routes.test.ts` | 驗證重新規劃 API 接受並傳遞 en、拒絕不支援的語言。 |
| `src/modules/accessible-route/reroute.service.test.ts` | 改用真實指引引擎，驗證兩組英文指引與原有重新規劃控制流程。 |
| `docs/FRONTEND_MIGRATION_WALK_INSTRUCTIONS.md` | 提供英文請求、相對方向值域、重新規劃及資料來源限制。 |
| `docs/specs/FUNCTIONAL_SPEC_NAV_INSTRUCTIONS.md` | 更新目前支援語言與前端串接文件連結。 |
| `docs/specs/WALK_STEPS_I18N_VOCABULARY.md` | 釐清英文導航文案與 WALK 機器欄位的邊界。 |
| `docs/reports/navigation-english-support.md` | 記錄本次變更清單、驗證結果與尚未驗證的範圍。 |
