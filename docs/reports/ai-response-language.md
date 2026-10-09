# AI 與語音回覆語言：實作與驗證

日期：2026-10-09。範圍限目前後端；保留工作區原有 AI 路線一致性修改，未修改前端、部署或提交 commit。

## 結果

`POST /api/v1/ai/chat` 與 `/api/v1/voice/ws` 的 `session.start` 接受選填 `language: "zh-TW" | "en"`。HTTP 欄位經 router 的 `validateRequest` 驗證，WS 欄位經首訊息 schema 驗證，再傳到服務與模型提示；沒有新增掛載點或環境變數。

回覆語言以當次介面偏好為準，允許本輪明確要求翻譯或另一語言。偏好附加於歷史／記憶之後。文字 AI 重試不再硬性要求繁中，最終空回答依偏好選擇中英文降級文案；英文語音導航要求模型翻譯播報並保留導航事實。Live 上游因路線選擇重建時保留語言。省略欄位的呼叫者不加入新偏好區塊。

前端串接方式與範例見 [FRONTEND_MIGRATION_AI_LANGUAGE.md](../FRONTEND_MIGRATION_AI_LANGUAGE.md)。

## 本次修改檔案

| 檔案 | 用途 |
| --- | --- |
| `src/schemas/agent-language.schema.ts` | 共用允許的語言代碼 |
| `src/utils/agent-language.ts` | 文字／語音共用回覆語言規則 |
| `src/types/agent.ts` | 語言型別與 agent 輸入欄位 |
| `src/modules/ai/ai.schema.ts` | HTTP 欄位驗證及 OpenAPI |
| `src/modules/ai/ai.chat.controller.ts` | JSON／SSE 皆傳遞語言 |
| `src/modules/ai/ai-chat.service.ts` | 在模型系統提示加入語言偏好 |
| `src/modules/agent/agent-manager.service.ts` | 重試提示與空回答降級語言 |
| `src/modules/voice/voice.ws.schema.ts` | 握手語言欄位驗證 |
| `src/modules/voice/voice.gateway.ts` | 傳遞至 Live bridge |
| `src/modules/voice/voice-prompt.ts` | 語音對話與導航播報語言規則 |
| `src/modules/voice/live-bridge.ts` | 模型連線、重建與播報套用語言，顯式偏好不送 speechConfig.languageCode |
| `src/modules/ai/ai.chat.controller.test.ts` | JSON／SSE 傳遞及非法值 HTTP 400 |
| `src/modules/ai/ai-chat.service.test.ts` | 當次偏好優先與請求間隔離 |
| `src/modules/agent/agent-manager.service.test.ts` | 所有重試保留偏好與英文降級文案 |
| `src/modules/voice/voice.ws.schema.test.ts` | 握手語言允許值、省略及非法值 |
| `src/modules/voice/voice.gateway.test.ts` | 真實 WS 握手傳遞及拒絕非法值 |
| `src/modules/voice/voice-prompt.test.ts` | 歷史／記憶優先順序及導航播報規則 |
| `src/modules/voice/live-bridge.test.ts` | SDK config、路線切換重建與導航播報佇列 |
| `docs/specs/VOICE_WS_PROTOCOL.md` | 更新首訊息契約 |
| `docs/FRONTEND_MIGRATION_AI_LANGUAGE.md` | 前端請求範例、切換／重連與驗收方式 |
| `docs/reports/ai-response-language.md` | 本次交付與驗證紀錄 |

## 驗證

- `pnpm build`：通過，包含 `lint:arch` 與 production TypeScript 編譯。
- 9 個相關 Vitest 檔案、241 項測試通過：上述 7 個修改的測試檔，另含 `live-bridge.voice-degraded.test.ts` 與 `line-agent.service.test.ts`。
- 以編譯後 `generateOpenAPIDocument()` 產生文件，確認 `AgentChatRequest.language` enum 為 `zh-TW`／`en`、非 required，且 `/ai/chat` 路徑存在。
- 本次 18 個 TypeScript 檔案 ESLint：0 errors、90 warnings。
- `git diff --check`：通過。
- `pnpm typecheck`（含所有測試）：未通過，共 34 個錯誤，僅位於 `hazard-report.ai-job.repository.integration.test.ts` 與 `retention.integration.test.ts`。使用修改前 source 副本、同一份依賴與設定重新檢查；正規化副本路徑後，完整診斷與修改後完全相同，沒有新增型別錯誤。

## 限制與待驗收

- 本次為實作者自行核對增量 diff，沒有獨立審查。
- 模型端為 mock seam，已驗證實際傳入的提示與 config；未呼叫正式 Gemini 驗證回覆或聆聽音訊，模型遵循語言與導航翻譯的品質仍待驗收。
- 前端未修改、未執行 Web／手機實機整合驗收，也未部署。需先在前端每次 chat 請求／語音握手帶入當前語言。
- 原始工具 DTO、結構化導航文字及協議錯誤訊息未全面翻譯。語音偏好固定於 client session；切換語言需重連。導航中只能關閉 WS 並以 `nav.resume` 續接，不可送出會刪除快照的 `session.end`／`nav.cancel`。
