# 語音導航 session 語言串接

日期：2026-10-10。本機修改，未部署。

## 行為

- `session.start.language` 傳入 `NavigationSession` 及真實步驟產生器，支援 `en`／`zh-TW`，省略仍預設繁中。
- 開始、停止、重播、偏航、步行／車行路段抵達、導航錯誤、續接錯誤及警示模板依 session 語言輸出。
- 後端改道請求帶入語言，替換導航實例、失效路線重設後重選、`nav.resume` 重建步驟均沿用該 session 語言。
- Live 重新建立連線後，工具執行器仍取得 session 語言。`getNavInstructions` 未填 `language` 時使用此預設；明確有效值可覆寫，非法值仍拒絕。文字 AI 工具迴圈也傳遞相同上下文。
- WebSocket 掛載仍為 `/api/v1/voice/ws`，HTTP 語音模組仍在 `/api/v1/voice`。沒有新增端點、環境變數或修改快照格式。

## 串接前提與限制

每次 WebSocket 重連，前端須在新的 `session.start` 重新傳送目前語言，再送 `nav.resume`。後端使用新 session 的語言；快照只恢復導航進度。舊客戶端省略語言仍得到繁中。

保留來源路名、站名、警報標題與描述，不推測翻譯。後端產生的「終點」等通用名稱沿用既有英文名稱轉換。

尚未部署，未執行真實 Gemini Live／手機音訊與 TTS 驗收，亦未執行全專案 Vitest。相關測試使用真實導航狀態機及步驟引擎；WebSocket gateway 使用本機連線；Gemini、Redis 快照及改道外部依賴使用測試替身。這些結果不代表正式環境或實機驗收。

## 驗證

- `pnpm build`：通過，包含架構邊界及正式 TypeScript 編譯。
- 下列測試：22 檔、546 個測試通過。

```sh
TZ=UTC pnpm test src/modules/voice src/modules/ai/agent-tools.test.ts src/modules/ai/route-context.service.test.ts src/modules/ai/ai-chat.service.test.ts src/modules/agent/agent-manager.service.test.ts src/modules/nav-instructions src/modules/accessible-route/reroute.service.test.ts
```

- 涵蓋英文／繁中改道、續接索引保留、過期路線重設、Live 重建後工具預設、參數覆寫／拒絕、英文警示、WebSocket 格式錯誤及通用目的地標籤。
- `git diff --check`：通過。
- `pnpm typecheck`：未通過；`hazard-report.ai-job.repository.integration.test.ts` 與 `retention.integration.test.ts` 共 34 個既有錯誤。以 HEAD 的暫存副本及相同依賴重新執行，34 筆錯誤位置與診斷完全一致；本次修改檔案沒有額外型別錯誤。

## 變更檔案

| 檔案 | 原因 |
| --- | --- |
| `src/modules/voice/navigation-messages.ts` | 集中中英文導航、錯誤與警示模板。 |
| `src/modules/voice/navigation-session.ts` | 將語言傳入步驟引擎、合成抵達步驟及警示分類。 |
| `src/modules/voice/nav-advisory.ts` | 依語言生成警示，保留既有嚴重度與改道判斷。 |
| `src/modules/voice/live-bridge.ts` | 傳遞語言至改道、導航實例、工具執行器，語系化工具回覆與錯誤。 |
| `src/modules/voice/voice.gateway.ts` | 使用握手語言回覆導航控制格式錯誤。 |
| `src/types/agent.ts` | 工具執行器上下文新增選用語言。 |
| `src/modules/ai/agent-tools.ts` | 未填導航語言時採用工具上下文的 session 預設。 |
| `src/modules/agent/agent-manager.service.ts` | 將文字 AI session 語言傳入工具上下文。 |
| `src/modules/voice/navigation-session.test.ts` | 驗證真實步驟引擎、合成抵達、偏航及警示文案。 |
| `src/modules/voice/nav-advisory.test.ts` | 驗證英文設施／交通／障礙警示及來源文字保留。 |
| `src/modules/voice/live-bridge.test.ts` | 驗證改道、重連續接、路線重設及 Live 工具語言。 |
| `src/modules/voice/voice.gateway.test.ts` | 驗證本機 WebSocket 控制錯誤依握手語言回覆。 |
| `src/modules/ai/agent-tools.test.ts` | 驗證 session 預設、明確覆寫與無效語言。 |
| `src/modules/agent/agent-manager.service.test.ts` | 驗證模型未填語言時，文字 AI 仍傳遞 session 語言。 |
| `docs/FRONTEND_MIGRATION_WALK_INSTRUCTIONS.md` | 補充語音握手、重連與工具預設契約。 |
| `docs/reports/voice-navigation-language.md` | 記錄變更、驗證證據與實機驗收限制。 |
