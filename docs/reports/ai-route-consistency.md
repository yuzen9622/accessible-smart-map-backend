# AI 路線一致性：後端實作與驗證

日期：2026-10-09。基準：`c62568f`；本機工作樹已完成，尚未部署。

## 問題與修正

原先 AI 路線工具刪除了幾何與 route identity，前端收到摘要後會再規劃一次；重新規劃的條件可能缺少交通偏好、出發時間或無障礙需求。AI 解釋第一份結果，畫面顯示第二份結果，兩者可能不同。原先 getNavInstructions 也會重新規劃；歷史摘要則會把 legs 縮成沒有事實內容的字串。

本次路線工具只進入共用規劃 service 一次，保留完整候選、原排序與 canonical 條件，沿用現有 token 保存服務。前端取得完整結果；模型取得相同 planId／selectedRouteId／routeId 與路段事實的投影，移除幾何、token、steps 與大量設施資料。詳細指引只讀後端注入的已選 token，不接受模型用起終點、順位或自造 token 改選。

文字請求與語音初始化支援 routeContext／routingPreferences；語音連線中以 route.context.set／ack 同步查看中的路線，與 active navigation 分開。新選擇會關閉舊 Gemini Live 上游，淘汰舊工具結果、音訊及回呼，再以新脈絡連線。相同 token 的預設選擇回傳可直接確認；切換不會重設導航進度或觸發重新規劃。

## 介面與相容性

既有掛載位置維持：

- `POST /api/v1/ai/chat`：optional Bearer auth；新增 optional routeContractVersion／routeContext／routingPreferences。SSE tool_call／tool_result 新增 callId，result 保留完整路線。非串流仍只回文字，不提供完整工具結果。
- `WS /api/v1/voice/ws`：session.start 登入認證；新增初始化欄位、route.context.set／ack、session.ready capabilities、工具 callId／turnId。
- `POST /api/v1/a11y/accessible-route`、`POST /api/v1/a11y/route/instructions`：沿用既有手動規劃與 token 指引 API，本次沒有新 HTTP endpoint。

沒有新增環境變數、資料庫結構或外部依賴。路線 token 仍沿用既有 30 分鐘 TTL 與 Redis 保存規則；Redis 保存失敗仍提供完整幾何，但不得宣稱可依 token 查詢或啟動導航。token lookup 最多等待 5 秒；Gemini bootstrap（包含記憶查詢）最多等待 15 秒，換選或關閉會取消舊 bootstrap 等待，晚到的 provider session 會關閉。

SSE 含工具的回合若混有暫時文字會先捨棄，回答回合完成後再按原 chunks 輸出，因此首字可能較晚。語音切換上游期間不緩存麥克風音訊，前端須依 ack 管理等待與播放狀態。

## 變更檔案

下列路徑以 repository root 為基準。

| 檔案 | 用途 |
| --- | --- |
| `src/types/agent-route.ts` | 路線脈絡、條件、同步結果及 client/model 投影型別 |
| `src/types/agent.ts` | executor 雙結果、callId、HTTP 取消與執行有效性契約 |
| `src/constants/agent-route.ts` | 契約版本及路線錯誤訊息 |
| `src/schemas/agent-route.schema.ts` | 共用請求及模型工具新參數驗證 |
| `src/utils/agent-route-projection.ts` | 保留路段事實的模型投影與有界歷史摘要 |
| `src/modules/ai/route-context.service.ts` | 驗證 token、維持查看中的路線與行程條件、淘汰過期結果 |
| `src/modules/ai/agent-tools.ts` | 一次規劃、完整結果與 token、canonical 條件、token 指引 |
| `src/modules/ai/ai-chat.service.ts` | 將共用路線脈絡與 executor 注入文字 agent |
| `src/modules/ai/ai.chat.controller.ts` | 傳遞新請求欄位、SSE callId 與斷線取消 |
| `src/modules/ai/ai.schema.ts` | 請求與成功路線 OpenAPI schema，校正 SSE 文件 |
| `src/modules/agent/agent-manager.service.ts` | 分流 UI／模型結果、路線相關快取失效、取消與文字輸出時機 |
| `src/modules/agent/conversation-context.ts` | 路線結果使用專用摘要 |
| `src/modules/line/line-agent.service.ts` | 共用工具改版後，同一次 LINE 對話仍能從 plan 接續 token 指引 |
| `src/modules/voice/live-bridge.ts` | 投影分流、工具 IDs、路線切換、上游世代隔離、逾時與導航狀態保留 |
| `src/modules/voice/voice.gateway.ts` | 初始化欄位、能力宣告、selectionVersion 與 ack 關聯 |
| `src/modules/voice/voice.ws.schema.ts` | 新控制訊息嚴格驗證與 outbound 型別 |
| `src/config/ai/agent-prompt-shared.ts` | 路線一致性及偏好省略／明確取消規則 |
| `src/config/ai/chat-prompt.ts`、`src/modules/voice/voice-prompt.ts` | 文字與語音採用相同路線事實規則 |
| `src/config/ai/tool.ts` | 規劃條件與 token 指引的模型工具宣告 |
| `docs/FRONTEND_MIGRATION_AI_ROUTE_CONSISTENCY.md` | 回填已實作契約、前端處理方式及待驗收項目 |
| `docs/specs/AI_AGENT_TOOLS_REFERENCE.md` | 更新完整 route result、參數與 SSE |
| `docs/specs/VOICE_WS_PROTOCOL.md` | 更新初始化、同步、工具事件與語音降級行為 |
| `docs/reports/ai-route-consistency.md` | 本次設計取捨、變更範圍與驗證紀錄 |

測試新增／調整：

| 檔案 | 驗證重點 |
| --- | --- |
| `src/modules/ai/agent-tools.test.ts` | 一次規劃、完整幾何、canonical 條件、token 指引與失敗 |
| `src/modules/ai/route-context.service.test.ts` | 投影、條件延續、清除、過期結果與 token lookup 逾時 |
| `src/modules/ai/ai-chat.service.test.ts` | executor 注入與文字脈絡 |
| `src/modules/ai/ai.chat.controller.test.ts` | HTTP 驗證、完整 SSE 結果、callId 與生成的 OpenAPI |
| `src/modules/agent/agent-manager.service.test.ts` | 模型投影、最終重試不洩漏 token、取消與暫時文字淘汰 |
| `src/modules/line/line-agent.service.test.ts` | LINE 使用者身分與同次對話 token 延續 |
| `src/modules/voice/live-bridge.test.ts` | BUS 事實、舊音訊／工具淘汰、換選／清除、導航保留、晚到 bootstrap 與記憶權限 |
| `src/modules/voice/voice.gateway.test.ts` | 本機 WS 初始化、能力宣告、ack、舊版本拒絕及晚到 ack |
| `src/modules/voice/voice.ws.schema.test.ts` | 新事件的長度、版本、未知欄位與 null 清除 |

## 驗證結果

- `pnpm build`：通過，包含 `lint:arch` 與 TypeScript 編譯。
- 下列範圍：**23 個測試檔、496 項測試全部通過**。
- 包含透過本機 HTTP 驗證 `/api/v1/openapi.json` 產出新的 AgentChatRequest 與 AiRoutePlanToolResult；未做 Scalar UI 視覺驗收。
- `git diff --check` 與修改文件／程式格式檢查：通過。

```sh
pnpm exec vitest run \
  src/modules/ai/agent-tools.test.ts \
  src/modules/ai/ai-chat.service.test.ts \
  src/modules/ai/ai.chat.controller.test.ts \
  src/modules/ai/route-context.service.test.ts \
  src/modules/ai/date-injection.test.ts \
  src/modules/agent src/modules/voice \
  src/modules/line/line-agent.service.test.ts \
  src/modules/line/line.service.test.ts \
  src/modules/accessible-route/route-token.service.test.ts \
  src/modules/nav-instructions/nav-instructions.service.test.ts
```

HTTP／WS transport 測試使用本機服務；Gemini、規劃器與 token 儲存使用測試替身。這驗證了同一份路線的資料流及競態處理，不是線上供應商、Redis 故障注入或實機音訊驗收。未執行全 repository 測試集。

## 待完成與限制

1. Web 與手機依 [front migration](../FRONTEND_MIGRATION_AI_ROUTE_CONSISTENCY.md) 直接套用完整結果，停止自動二次規劃，並同步選中 token、等待 ack、清除舊播放與捨棄過期事件。舊前端沒有這些行為時，不能宣稱完整問題已解決。
2. 尚未部署；需在部署後以同一起點、目的地台中火車站及 BUS 固定案例核對地圖、tool result、實際逐字稿與音訊，並測試快速換選、模式切換與重連。
3. 模型取得的資料已與畫面結果同源，但自由生成語音仍可能講錯；本次沒有另做逐句運具校驗或改用固定模板 TTS。
4. 路線歷史摘要上限 1200 字元，截短會標記 truncated。查完整路線依 token，不能用摘要代替選擇同步。LINE 只處理同次工具迴圈的 token，未新增跨訊息選擇協定。
