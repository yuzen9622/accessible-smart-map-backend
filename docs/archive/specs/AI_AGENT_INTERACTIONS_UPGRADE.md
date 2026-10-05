# AI Agent 複雜任務失效修復 ＋ Interactions API 遷移規劃

**版本**：v1.5（**M1/M2/M3 已實作**，2026-08-18）
**日期**：2026-08-18

**v1.1 變更（依使用者明示的設計原則）**：**不新增任何工具。** agent 的價值在於用既有工具自己規劃下一步、自己決定調用順序；把每個複雜情境包成專用工具會膨脹到上百個且無法管理。
據此作廢 v1.0 的三處：①新工具 `findBusConnections`②「缺 A→B 班次工具」的根因判斷（B-2，事實錯誤）③工具集按意圖收斂（與 agent 自主規劃衝突）。

**v1.2 變更（依使用者要求「不確定的地方規劃時就查清楚，不要進實作才發現不行」）**：把整條工具鏈**實跑過**（真 mongo + 真 TDX），結果推翻兩項判斷、並發現一項比原題更嚴重的問題：
1. ✅ **月台資料一直都在**（作廢 B-5）：月台寫在 `busstops.stopName`（`臺中車站(A月台)`～`(D月台)`），逐月台的路線集合彼此不同，粒度剛好對上使用者問法。原列的 P1-5 開發項因此**移除**。
2. ❌ **「10:20 有哪些班次」本質上答不出來**（不是回合數、不是工具設計）：TDX 台中市區公車只有「起站發車時刻」或「班距」，**沒有逐站時刻**。原題的可達答案上限因此下修，並改為誠實告知邊界。
3. 🔴 **新發現的幻覺風險**（`getBusTimetable` 把起站時刻放在看起來像時刻表的欄位裡）升為 P1 最高優先——不修會產生比「沒回答」更糟的**自信錯答**。

詳見 §3 的 **P1-0 實測結論**。

**v1.5 修正（2026-08-18，用 `gemini-interactions-api` skill 逐項複查 v1.4 的實作）**：
1. **🔴 v1.4 漏做 streaming（M1-6／P0-8），但被誤報成「全數完成」**。已補實作：`createInteraction` 接受 `onTextDelta`，有回呼時改走 `stream: true` 並用 `collectStream()` 把事件重組回非串流的同一形狀（tool loop 邏輯零改動）；controller 用 `streamedChars` 追蹤已送出的量，避免與兜底文案重複送。實測 9 個 delta／334 字元／重組長度完全吻合，首字比總完成時間早 2.7s 出現。
2. **修正本檔記錯的 delta 欄位名**：官方 function-calling 頁寫 `partial_arguments`，但 SDK 型別（`ArgumentsDelta`）與 streaming 頁一致是 **`arguments_delta` + `delta.arguments`**。以 SDK 型別為準——兩頁文件互相矛盾時，型別定義才是真相。
3. **移除 `AGENT_SEED`**：它是在「失去 temperature → 用 seed 補回決定性」這個**已被推翻**的假設下加的。實測拿掉後 LINE 煙測 6/6（×2）、eval 50/50、V1b PASS 全數不變，證明穩定性來自 prompt 的意圖邊界而非 decoding 設定，因此不留無依據的設定。
4. **補上被忽略的診斷欄位**：`interaction.errors`（platform faults）納入 log；`status` 的 `failed`／`cancelled`／`incomplete`／`budget_exceeded` 改用 `console.error` 大聲記錄——這幾個正是「靜默空答案」的成因。
5. **已驗證非 bug 的疑慮**：實打確認 stateful 下 `interaction.steps` **只含本輪**、不累積整條鏈（否則會重複執行工具）；`thought` signature 依官方只出現在 thought/內建工具步驟、不掛在 function_call 上，所以 `toInteractionInput` 重播歷史時不帶 signature 是正確的。
6. **未採用（有意識的取捨）**：`thought_summaries: "auto"` 能讓 log 看到模型推理摘要，但會增加 token 成本，暫不開啟。

**v1.4 實作結果（2026-08-18，未 commit）**：M1/M2/M3 全數實作完成。驗證：`tsc` 乾淨、eslint 0 error、**1431 測試通過**、工具路由 eval **50/50 (100%)** 含新增 3 題多跳案例、V1b 全鏈 PASS、LINE 煙測 6/6（連跑三次穩定）、原題端到端實跑成功（17 次工具呼叫 / 52.9s / gemini-3.7-flash）。

實作中發現並修掉的兩個**遷移固有陷阱**（都不是打錯字，是換 API 的後果，值得記錄）：
1. **`routeOnce` 的 memoryEnabled 預設被我改壞**：原本 `?? Boolean(opts.userId)` 被寫成 `?? false`，導致 eval 只傳 `userId` 時記憶工具不在目錄裡、`saveMemory` 不可能被呼叫。**工具路由 eval 抓到**（掉到 48/50），已修並補上會變紅的回歸測試（已用突變驗證）。
2. **🔴 Interactions API 沒有 `temperature`**：`GenerationConfig_2` 完全沒有 temperature / top_p / top_k 欄位，所以舊碼的 `temperature: 0`（greedy、決定性）在遷移後**靜默消失**，模型改跑預設溫度。後果＝LINE 家人端「問天氣卻先查 SOS」的舊 bug 復活（S2/S4/S6 失敗）。
   - 歸因方式：把**遷移前 HEAD** 的 `AGENT_TEMPERATURE` 改成 1 → 重現完全相同的失敗集合，確認是失去決定性而非程式錯誤。
   - `seed` 無效（只讓結果可重現，不會讓它正確）；仍保留 `AGENT_SEED = 7` 作為除錯用的可重現性。
   - 真正修法＝把 LINE prompt 的意圖邊界寫明確，讓正確選擇在取樣下也佔優。順帶發現該 prompt 開頭「系統已經幫你決定要用哪些工具」是 dispatcher 時代的**過期敘述**（LINE 早已改回 tool-loop 自己選工具），已一併更正。
   - **教訓**：任何原本靠 `temperature: 0` 撐住的行為，遷移後都必須改由 prompt 或程式結構保證。

**v1.3 變更（使用者 2026-08-18 拍板）**：
1. **Interactions API 遷移改為第一優先**（原排最後）。理由：本題需要 agent 穩定跑完 10-20 步並在中途做算術，那是模型與 API 世代的能力問題，其餘是枝節。
2. **不用旗標**：不做 `USE_INTERACTIONS_API` 三態、不做 shadow 模式，直接換。回滾手段＝git revert。**代價是沒有 shadow 可比對，因此驗收必須新舊 build 並排對打真實題目**（本專案已有「綠燈≠好用」前例）。
3. **啟用 stateful**（`previous_interaction_id`）：使用者已明示可接受 `store: true`（Google 側保留 55 天）。⚠️ 一句話提醒即止：本專案 user memory 含住家座標等 PII，`docs/specs/FUNCTIONAL_SPEC_AI_AGENT_PRODUCTION.md` §5.1 的個資透明告知範圍應一併更新。
4. **推估精度維持模型自估**、回答標明為估算值，不動工具程式碼。使用者觀察到（我亦實測佐證）模型會先 `getBusTimetable` 取起站時刻，再結合 `getBusRoute` 的站序推估到站時刻——`132` 的 `臺中車站(D月台)` 在 seq 32/69、`26` 的 `黎明益豐路口` 在 seq 27/50，皆與使用者觀察到的輸出（約每站 1 分鐘）吻合。**推估可行，不需新工具、不需改資料來源。**

### ⚠️ v1.3 架構釐清：stateful 的作用範圍

`/api/v1/ai/chat` 對外**仍是無狀態**的——前端每次送完整 OpenAI `messages`。因此 stateful 用在**單一請求內的 tool loop**，不是跨使用者輪次：

- **請求開始**：照舊由 `messages` 建出第一個 interaction 的 `input`（沿用既有 `toGeminiHistory` 的等價轉換）。
- **loop 內每一輪**：只送 `previous_interaction_id` + `input: [{type:'function_result', call_id, name, result}]`，**不再重送成長中的完整歷史**。這是本次遷移對本題最直接的效益——每輪 payload 從「全歷史」降為「一個工具結果」，讓 10-20 輪在成本與延遲上變得可行。
- **注意**：`tools` / `system_instruction` / `generation_config` 是 interaction-scoped，**每個新 interaction 都要重送**（官方明載），不能因為有 `previous_interaction_id` 就省略。
- **跨輪次 stateful**（把 interaction id 存起來、下一個使用者問題接續）**不在本次範圍**：那需要 Conversation 持久化，屬 `FUNCTIONAL_SPEC_AI_AGENT_PRODUCTION.md` Phase 2。
**觸發案例**：「我大約 10:20 會到台中車站，我想直接從台中車站的 ABCD 月台搭乘公車到中科大，有哪些班次可以銜接」→ 只發出 tool_call 事件、沒有最終回答。

---

## 1. 現況（已核實，附行號）

| 事實                                                                        | 位置                                     |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| 聊天走 `@google/genai` 原生 `generateContent`（非 OpenAI 相容層）           | `src/modules/agent/agent-manager.service.ts:154, 232, 331` |
| `MAX_ROUNDS = 5`                                                            | `agent-manager.service.ts:135`           |
| 每輪 `buildRoutingConfig`：AUTO（round 0 可 ANY）、`temperature: 0`         | `agent-manager.service.ts:25-43`         |
| 迴圈結束後一定補一次 `mode: NONE` 強制產文字                                | `agent-manager.service.ts:56-68, 232-237` |
| **該強制輪若回空字串 → 直接回傳 `text: ""`，無二次兜底**                    | `agent-manager.service.ts:237`           |
| controller 把空字串當成功送出（SSE `token` + `done`；非串流 200）           | `ai.chat.controller.ts:157, 184`         |
| 最終答案**非逐字串流**，整包一次性送單一 `token` 事件                       | `ai.chat.controller.ts:157`              |
| `generateContent` 無 try/catch、無 429/timeout 分類與退避                   | `agent-manager.service.ts:154`（無包覆） |
| 一般 chat 開放 **25 個** tool declaration（23 常規 + 2 記憶）              | `src/config/ai/tool.ts`                  |
| `getBusTimetable` 只吃 `routeName`；回傳全天資料、無時間窗、無上限。**且內容只有「起站發車時刻」或「班距」，沒有逐站時刻**（實測，見 P1-0） | `agent-tools.ts:578-595`、`bus.service.ts:660-700` |
| system prompt 注入「今天日期」，**未注入現在時間**                          | `src/config/ai/chat-prompt.ts:91-98`     |
| prompt 無「必須輸出最終文字」的收斂指示（全靠程式層 NONE）                   | `chat-prompt.ts:14-61`                   |
| `runAgent()` 只轉傳 `extraTools`，丟棄 `toolAllowList`/`allowedFunctionNames`/`seedParts` | `agent-manager.service.ts:275-289` |
| 預設模型 `gemini-3-flash-preview`；`.env.example` 為 `gemini-3.5-flash`     | `src/config/ai.ts:18`、`.env.example:27` |
| `@google/genai ^2.17.0`（Interactions API 需 ≥ 2.3.0 → **已滿足**）        | `package.json:78`                        |
| 專案零 `interactions` 痕跡                                                  | grep 無命中                              |
| `src/config/ai/config.ts` 的 `agentConfig`（含 `maxOutputTokens: 1000`）與 `contents.ts` 的 `agentContents` 皆為**死碼** | `config.ts:16-35` |

### 1.1 已排除的假設

- `maxOutputTokens: 1000` 不是本案原因（該 config 未被 tool loop 引用）。
- 「完全沒有最終答案兜底」不成立：NONE 強制輪已存在且有測試（`agent-manager.service.test.ts:257-292` T1/T2）。

---

## 2. 根因分析

分三層，**A 是 bug、B 是能力缺口、C 是世代落後**。三層都修才會讓這題變成可答。

### A. 為什麼變成「只有 tool call、沒有 final answer」（純 bug）

1. **終極空回答無防線**：NONE 強制輪自己回空字串時，`runToolLoop` 回 `text: ""`（`:237`），controller 原樣送出（`:157`）。前端就看到 tool 事件 → 空 token → done。
2. **完全沒有 `finishReason` / `promptFeedback` 檢查**：`MAX_TOKENS`（Gemini 3 的 thinking token 計入輸出）、`MALFORMED_FUNCTION_CALL`、安全阻擋，全部靜默降級成空字串，所以現場無法判斷是哪一種。
3. **無 429/timeout 分類與重試**：複雜題會連打 6 次 `generateContent`，中途一次 429 就整條 500，且錯誤訊息不分類。
4. **最終答案非串流**：複雜題在 5 輪期間前端只看到 tool 事件、長時間無文字，主觀上就是「卡在 tool call」——即使最後成功也已經像壞掉。

### B. 為什麼這題本身超出現有能力（結構缺口）

1. **回合預算不足**：用現有工具的正解鏈（`findNearbyBusStops` 兩端 → 逐月台取交集 → `getBusTimetable` → 必要時 `getBusArrival`）約需 5-6 輪，而 `MAX_ROUNDS = 5`。agent 還沒走完自己的規劃就被截斷。⚠️ 但**這不是本案的全部**：即使給足回合，「10:20 的精確班次」仍答不出來（見 P1-0 實測），因為上游 TDX 沒有逐站時刻。回合預算修的是「講得出可行路線」，不是「講得出精確時刻」。
2. ~~缺「A→B 有哪些班次」這個工具~~ — **此條為事實錯誤，已作廢**。`findNearbyBusStops`（`agent-tools.ts:650`）已能從地名/座標取回每站的真實 `routes[]`（`bus.service.ts:936-946`），兩端各查一次再取交集即可發現候選路線，**不需要 `planAccessibleRoute`、也不需要新工具**。詳見 P1 開頭。
3. **時刻表 payload 無時間窗過濾、無上限**：單一路線可達 ~12k 字元（實測 132 是 11,586、12 是 12,220），候選路線一多就吃掉可用的規劃輪數。而且模型在裡面**挑不到**它真正需要的東西（沒有查詢站的時刻），純屬浪費。
4. **無現在時間**：只注入日期（`chat-prompt.ts:97`），「10:20」無法錨定成今天/明天，也無法用來過濾班次。
5. ~~月台/乘車處資料不存在~~ — **此條為事實錯誤，已作廢**（2026-08-18 實測）。月台就在 `busstops.stopName` 內（`臺中車站(A月台)`～`(D月台)`），`findNearbyBusStops` 一直都回傳得到，且**逐月台的路線集合彼此不同**（A月台到中科大是 0 條、B月台 9 條、C月台 3 條、D月台 4 條），資料粒度剛好對得上使用者的問法。
6. ~~25 個 tool declaration 全開會惡化 planning 品質~~ — **此條已依使用者原則作廢**。工具數不是問題，把複雜情境包成專用工具才是問題（會膨脹到上百個且無法管理）。專案已有反例：`findNearbyBusStops` 當初正是「缺對的工具、不是工具太多」的產物。25 個工具維持全開。
7. **`runAgent` 遺漏轉傳**：`toolAllowList` / `allowedFunctionNames` / `seedParts` 在 chat 路徑被丟掉（`:275-289`）。這是單純的參數遺漏 bug（P0-7 修），修好後 `seedParts` 供 P0-5 使用、`toolAllowList` 供 LINE 的**授權邊界**使用；**不拿 `allowedFunctionNames` 去控路由**（那會侵蝕 agent 自主規劃）。

### C. API 世代落後（使用者點名的部分）

| 項目 | 現況 | 官方現狀 |
| --- | --- | --- |
| API surface | `generateContent` | **Interactions API 於 2026-05-19 GA**，官方明示「recommended for access to all the latest features and models」；`generateContent` 文件已改標 **Legacy** |
| 模型 | `gemini-3-flash-preview`（預設）/ `3.5-flash`（env） | **兩者都在官方「Active Legacy Models（建議遷移）」表上**，目標同為 `gemini-3.7-flash`；官方給的理由原文是「stronger agentic/multimodal performance, **reduced token usage/loop spiraling**」——`loop spiraling` 正是本案症狀 |
| 取樣參數 | 全靠 `temperature: 0` 表達決定性 | `temperature` / `top_p` / `top_k` **2026-07-21 標記棄用**；遷移 checklist 明列「Removed `temperature`, `top_p`, `top_k` from config」 |
| Thinking | 未設定任何 thinking 參數 | 改用 `thinking_level`：`minimal` / `low` / `medium` / `high` |
| 可觀測性 | 只有自己 push contents，看不到模型思考/步驟 | Interactions 回傳明確 `steps`：`user_input` / `thought` / `function_call` / `function_result` / `model_output`。`thought` step 帶**必填** `signature`；`function_call` step 為 `id` / `name` / `arguments`（**無** signature 欄位） |
| 多輪成本 | 每輪重送完整 contents | `previous_interaction_id` 由伺服器保存狀態，送更少 context、提高 cache 命中 |
| 長任務 | 無 | `background: true`（需 `store: true`） |
| SDK | `^2.17.0` | 需 ≥ 2.3.0 → **無需升依賴** |

**注意（隱私）**：Interactions API 預設 `store: true`，付費層保留 55 天、免費層 1 天。本專案的 user memory 明確含 PII（住家座標），因此遷移**第一階段一律 `store: false`**（stateless），stateful 另案並需使用者拍板。

---

## 3. 工作項目明細

> **⚠️ 讀法**：本節是**工作項目的細節與依據**（含實測結論與 API 對應表）。
> **執行順序看 §4（v1.3 拍板）**，那裡把這些項目重編為 M1/M2/M3。
> 下方保留的 `P0`／`P1`／`P2` 標號是 v1.0-v1.2 的歷史編號，僅供對照，**不代表優先順序**。

外部契約的**形狀**全程不變：OpenAI 形狀的 `/api/v1/ai/chat` 請求/回應，SSE 仍只用既有的 `tool_call`/`tool_result`/`token`/`done`/`error` 五種事件，不新增、不移除、不改 payload 欄位。

⚠️ 但要對前端誠實說明**一處可觀察到的行為變化**：P0-2 會擴大既有 `error` 事件的觸發條件。同樣的輸入（模型回空字串），現在被包成「成功」（空字串 `token` + `done`），修好後會變成 `error` + `done`。這是刻意的——把靜默失敗變成顯性失敗——但前端若目前假設「有 `done` 就是成功」，需一併確認其錯誤處理路徑。

### 〔明細〕止血與可觀測性 — 對應 **M2**（歷史標號 P0）

> **P0-0 spike ✅ 已於 2026-08-18 實測完成（用本專案 `.env` 的 `GEMINI_API_KEY` 直打 REST）：**
>
> | 探測 | 結果 |
> | --- | --- |
> | `gemini-3.7-flash` 是否在本 key 的可用模型清單 | ✅ 有（`GET /v1beta/models`） |
> | `gemini-3.7-flash` 的 `supportedGenerationMethods` | ✅ 含 `generateContent` |
> | `POST /v1beta/models/gemini-3.7-flash:generateContent` 實際產文字 | ✅ HTTP 200，回 `"OK"`（且帶 `thoughtSignature`） |
> | 已棄用的 `generationConfig.temperature: 0` 是否被拒 | ❌ 未被拒（HTTP 200，無 error）——deprecated 但仍可用，無立即斷線風險 |
> | `generationConfig.thinkingConfig.thinkingLevel: "low"` 在 legacy surface | ✅ 接受（HTTP 200） |
>
> **結論：模型升級是 drop-in，不必等 P2。** 官方點名可改善 `loop spiraling` 的 3.7-flash 在 legacy `generateContent` 上就能用，
> 因此把它放進 P0（見 P0-11），P2 遷移維持在最後。`.env` 現值為 `gemini-3.5-flash`（非程式碼預設的 `gemini-3-flash-preview`），兩者都在建議遷移表上。

| # | 動作 | 檔案 |
| - | ---- | ---- |
| P0-1 | NONE 強制輪回空字串時：先讀 `finishReason`，**重試一次**（丟掉中間 thought、只帶「使用者問題 + 工具結果摘要」的精簡 contents）；仍空則回**固定降級文案**，並把已取得的工具結果整理成一句可讀摘要。`runToolLoop` 永不回傳空 `text`。 | `agent-manager.service.ts:232-237` |
| P0-2 | controller 端第二道防線：`loopResult.text` 為空 → 送 `event: error` + 降級文案，**不再送空 token**。 | `ai.chat.controller.ts:157, 184` |
| P0-3 | 每輪記錄 structured log：round、`finishReason`、`usageMetadata`（含 thoughts token）、tool 名稱與耗時、最終文字長度。這是現在無法診斷的唯一原因。 | `agent-manager.service.ts` |
| P0-4 | `generateContent` 包 429/timeout 分類 + 指數退避重試（上限 2 次）；429 對外回 `ResponseCode.TOO_MANY_REQUESTS`（已存在）而非 500。 | `agent-manager.service.ts` |
| P0-5 | 達回合上限時，把「查詢次數已用完，請用現有資料作答並明說缺什麼」作為 seed part 注入最終輪（把硬截斷變成可解釋的收斂）。**上限本身的調整移到 P1-1**（它是能力問題不是止血問題）。 | `agent-manager.service.ts:135` |
| P0-6 | 注入**現在時間**（`HH:mm`，Asia/Taipei）到 system prompt，並說明「使用者提到的時刻若早於現在則指明天」。 | `chat-prompt.ts:91-98` |
| P0-7 | 修 `runAgent` 遺漏轉傳 `toolAllowList` / `allowedFunctionNames` / `seedParts`。 | `agent-manager.service.ts:275-289` |
| P0-8 | 最終答案改 `generateContentStream` 逐字送 `token`，前端立刻看到字。 | `agent-manager.service.ts` + `ai.chat.controller.ts` |
| P0-9 | prompt 加一條收斂規則：「無論工具結果是否完整，最後一定要輸出給使用者的文字回答；資料不足就說明查到什麼、缺什麼、建議下一步。」（與程式層 NONE 雙保險） | `chat-prompt.ts` |
| P0-10 | 刪死碼 `agentConfig` / `agentContents`（避免誤讀成 chat 的設定，本次調查就先被它誤導）。 | `config/ai/config.ts:16-35`、`contents.ts` |
| P0-11 | **模型升 `gemini-3.7-flash`**（程式碼預設 + `.env` / `.env.example`）。官方對這顆的描述正是「reduced token usage/**loop spiraling**」，直接對應本案的多跳規劃失效。切換前先跑 `eval-tool-routing.ts` 與舊模型對打工具選擇。 | `src/config/ai.ts:18`、`.env.example:27` |
| P0-12 | [TUNE] 視 P0-3 的 log 結果決定是否加 `thinkingConfig.thinkingLevel`（legacy surface 已實測接受）。注意本案是「推理不足」而非「推理過多」，**不要**為省成本調低。 | `agent-manager.service.ts` |

**P0 驗收**：新增測試「NONE 輪也回空字串」→ 斷言回傳非空且為降級文案；controller 測試斷言空 text 不會送空 token。並用本案原句對打新舊 build。

### 〔明細〕讓 agent 用**現有工具**跑完自己的規劃（不新增工具）— 對應 **M1-7 / M3**（歷史標號 P1）

> **設計原則（使用者 2026-08-18 明示，優先於本檔先前版本）**：**不新增工具。**
> 把每個複雜情境包成一個專用工具，最終會變成上百個工具且無法管理。agent 的價值就在於**用既有工具自己規劃下一步、自己決定調用順序**。
> 因此 P1 的工作全部是「**移除阻礙 agent 完成自己規劃的障礙**」，不是「替它把路走完」。

> ### ⚠️ P1-0 實測結論（2026-08-18，實跑真 DB + 真 TDX，非讀碼推論）
>
> 我把這條鏈**實際跑過**（scratchpad 腳本直接 import `agent-tools` 的真函式，連 `DATABASE_URL` 的 mongo 與真 TDX）。結論是**部分可行，關鍵一段不可行**——而且不可行的原因在**上游資料**，不是工具設計、也不是回合數。
>
> **✅ 可行（實測輸出）**
> - `findNearbyBusStops("台中車站")` → ok，9 站，且 **stopName 本身就帶月台**：`臺中車站(A月台)`／`(B月台)`／`(C月台)`／`(D月台)`／`(大智北路)`／`(復興路)`／`(成功路口)`／`(臺灣大道)`。每站附真實 `routes[]`。
> - `findNearbyBusStops("中科大")` → ok，直接命中 `國立臺中科技大學`（40m，58 條路線）。**「中科大」這個簡稱 geocode 得出來**，不需先呼叫 `findGooglePlaces`。
> - **逐月台取交集完全可行，而且結果很小、直接回答了使用者的問題**：
>   `A月台 → 0 條`、`B月台 → 9 條`（12／12延／500／500延／500延區2／500延區3／58／58副／82）、`C月台 → 3 條`（61／73／900）、`D月台 → 4 條`（132／25／35／5）。
>   （註：全站不分月台取交集是 **49 條**，對回合數不可行；**逐月台**才是可行解，而使用者原話正是問 ABCD 月台。）
> - `getBusArrival("132" @ "臺中車站(D月台)")` → ok，回真實 ETA（18 分、20 分）含車牌 `EAL-3703`。
>
> **❌ 不可行：`getBusTimetable` 給不出「台中車站」的發車/到站時刻**
> 台中市區公車在 TDX 有**兩種資料形態**，兩種都無法回答「10:20 之後有哪些班次經過台中車站」：
>
> | 形態 | 實測路線 | 內容 | 為什麼答不了 |
> | --- | --- | --- | --- |
> | `Timetables`（離散班次） | 132（48 班）、12（52 班）、25 | 每個 Timetable 的 `StopTimes` **長度恆為 1**，只有**起站**（132 是「北屯國兒運(崇德八路)」、12 是「明德高中(明德街)」） | 有班次時刻，但那是**起站發車時刻**，不是台中車站的時刻 |
> | `Frequencys`（班距制） | 5、35、500 | 只有 `start`/`end`/`minHeadwayMins`/`maxHeadwayMins`（如 500 是 06:00–07:00 每 15 分） | **根本沒有離散班次可列舉**，只有班距 |
>
> **這不是我們截斷造成的**：`bus.service.ts:673-680` 確實 `map` 了全部 `StopTimes`；我直接打 TDX 原始 API 驗證（`City/Schedule/City/Taichung`，route 132）→ `distinct RAW StopTimes lengths: [1]`、`timetables mentioning 臺中車站: 0`。**TDX 本身就沒發布逐站時刻。**
>
> **因此本案原題的可達答案上限是**：逐月台列出可到中科大的路線 ＋ 首末班車（`first`/`last`）＋ 班距制路線的發車間隔 ＋ 明確告知「無法提供台中車站的精確發車時刻，建議接近時用即時到站查詢」。`getBusArrival` 只有「現在」，無法用於未來的 10:20。
>
> **🔴 因此衍生一個必須修的幻覺風險（P1-2 已改寫）**：`getBusTimetable` 目前把起站時刻放在 `frequencies[].stopTimes[].arrivalTime`，欄位名與結構看起來就是一份時刻表。模型極可能把「06:10」當成台中車站的發車時刻**自信地講出來**。這是現有工具的**語意缺陷**，不修就會產生比「沒回答」更糟的錯答案。

**⚠️ 本檔 v1.0 的 B-2「缺 A→B 有哪些班次的工具」是事實錯誤，已作廢。**
route discovery 早就有現成工具：`findNearbyBusStops`（`agent-tools.ts:650`）吃地名或座標，內部 `busService.getNearbyStops`（`bus.service.ts:916` 起）回傳**每個站牌的真實 `routes[]`**（`:936-946` 把 subRouteIds 映射成路線名並 union）。
所以本案原題的完整解法**用現有工具就走得通**：

```
findNearbyBusStops(台中車站)  → A 端站牌 + 真實 routes[]
findNearbyBusStops(中科大)    → B 端站牌 + 真實 routes[]
（模型自己取交集，得候選路線——這正是該讓 agent 做的推理）
getBusTimetable(候選路線)      → 篩 10:20 之後的班次
getBusArrival(必要時)          → 即時 ETA
```

它現在做不到，**不是因為缺工具，是因為做不完**：這條鏈約 5-6 輪，而 `MAX_ROUNDS = 5`；而且沒有現在時間可錨定「10:20」，時刻表 payload 又大到擠爆 context。

| # | 動作（全部針對「讓既有工具鏈跑得完」） | 檔案 |
| - | ---- | ---- |
| P1-1 | **回合預算是本案的核心瓶頸**：`MAX_ROUNDS` 提到足以容納 6-8 步自主規劃（建議 10，配 token 預算上限與 P0-3 的 log 觀察實際用量）。這取代 P0-5 的 5→8。 | `agent-manager.service.ts:135` |
| P1-2 | **🔴 修 `getBusTimetable` 的語意缺陷（優先於加參數）**：把起站時刻的欄位改成自我描述、不可誤讀（如 `originStopName` + `originDepartureTime`，並加 `note: "僅起站發車時刻，TDX 未提供逐站時刻"`）；班距制路線明確標 `scheduleType: "headway"`。**目的是讓模型不可能把起站時刻當成查詢站的時刻**。順帶加 `afterTime` / `limit`（≤ 12 班）與 `truncated`——都是既有工具**加參數／改欄位語意**，不是新工具。 | `agent-tools.ts:578`、`bus.service.ts:660-700` |
| P1-3 | 統一 payload compaction 層：所有 tool 結果過一次字元上限 + 截斷標記（現在只有部分工具各自 slice）。context 省下來的空間直接變成 agent 可用的規劃輪數。 | `agent-tools.ts` |
| P1-4 | **失敗結果也快取**（短 TTL）：現在 `isSuccessResult` 只快取成功，同樣參數的失敗會重複燒掉寶貴回合。 | `agent-manager.service.ts:78-88` |
| P1-5 | ✅ **月台 spike 已完成、無需開發**：月台就寫在 `busstops` 的 `stopName` 裡（`臺中車站(A月台)`…），`findNearbyBusStops` 已原樣回傳，agent 逐月台推理即可。**本項從待辦移除**，只需在 P1-6 的 eval 加一題斷言它會逐月台作答。 | — |
| P1-7 | prompt 加一條**能力邊界**（非句型規則）：公車時刻只有起站發車時刻與班距，**不得聲稱某路線在某中途站的精確發車時間**；被問未來時段的銜接時，改答「可行路線＋首末班＋班距」並建議接近時查即時到站。 | `chat-prompt.ts` |
| P1-6 | eval 補題：本案原句 + 3 題多跳題加入 `src/scripts/eval-tool-routing.ts`（既有 V1b 已能跑完整 `runToolLoop` 並注入罐頭工具），斷言「序列走得完 + 一定有非空 final text」。 | `src/scripts/` |

**明確不做（依上述原則）**
- ❌ 不新增任何 tool declaration。
- ❌ **不做工具集收斂／按意圖切 `toolAllowList` 子集**（v1.0 的 P1-3 已刪）。理由有兩個：一是它與「讓 agent 自己規劃」直接衝突——意圖分類猜錯就會把 agent 需要的工具擋掉，而多跳題正是最容易被分錯的；二是專案已有反例教訓，`findNearbyBusStops` 當初就是「缺對的工具、不是工具太多」的產物。`toolAllowList` 的機制仍保留給 LINE 那種**授權邊界**用途（那是安全需求，不是路由手段）。
- ❌ 不靠 prompt 寫句型觸發規則（沿用既有「能力宣告」而非「當使用者說 X 時」的寫法）。P0-9 只加「一定要輸出最終文字」這條收斂規則，不碰路由。

### 〔明細〕遷移 Interactions API — 對應 **M1**（歷史標號 P2）

> **v1.3 已取消旗標與 driver 抽象**：使用者明示不要旗標，因此**不做** `USE_INTERACTIONS_API` 三態、**不做** shadow 模式、**不新增** driver 介面層——直接把 `agent-manager` 的呼叫改成 `interactions.create()`。
> 回滾手段＝git revert（遷移收斂在單一 commit）。代價是沒有 shadow 可比對，驗收改為新舊 build 並排對打（見 §5）。
> `src/adapters/gemini-interactions.adapter.ts` 這層仍建議保留，但角色是**單純的 SDK 封裝**（統一 baseUrl / 錯誤分類），不是可切換的 driver。

**對應表**

| 現況 (`generateContent`) | Interactions API |
| --- | --- |
| `contents: Content[]` | `input`（steps 陣列）。**v1.3 走 stateful**：首輪由 `messages` 建完整 `input`，之後每輪只送 `function_result` + `previous_interaction_id` |
| `config.tools[].functionDeclarations` | `tools: [{ type: 'function', name, description, parameters }]` |
| `functionResponse` part | `{ type: 'function_result', name, call_id, result: [{type:'text', text}] }` |
| `toolConfig.functionCallingConfig.mode` | `generation_config.tool_choice`（`'auto'｜'any'｜'none'`，或 `{ allowed_tools: { mode, tools } }`） |
| `response.functionCalls` | `interaction.steps.filter(s => s.type === 'function_call')`（`step.id` / `step.name` / `step.arguments`） |
| `response.text` | `interaction.output_text`（SDK 便利屬性＝尾端 `model_output` steps 最後一段連續文字）；或 `steps[-1].content[0].text` |
| `contents.push(modelContent)`（靠 SDK 隱式 round-trip thought signature） | stateless 下 `history.push(...interaction.steps)` 原樣推回全部 steps → `thought` step 的必填 `signature` 自然保留。**與現有程式碼形狀幾乎一對一**，遷移是機械性的 |
| `generateContentStream` chunk | `stream: true`，事件序列 `interaction.created` →（`step.start` → `step.delta`… → `step.stop`）+ → `interaction.completed`；`delta.type` 含 `text`、`thought_summary`、`thought_signature`，function_call step 則是 **`arguments_delta`**（累加 `delta.arguments`） |
| `temperature: 0` | 移除 temperature，改 `thinking_level`（`minimal`/`low`/`medium`/`high`） |
| 無 | `previous_interaction_id`（P2 之後另案）、`background: true`、`interaction.completed` 事件上的 `usage` |

**遷移直接帶來的收益（對應前面根因）**
- `steps` 內含 `thought` 與明確步驟型別 → P0-3 想要的可觀測性變成 API 原生能力，不必自己推測模型在想什麼。
- `signature` 顯式處理 → 目前「靠 SDK 自動處理 thought signature」的隱性依賴變成可驗證的資料流（此專案曾因 thought signature 踩過坑）。
- streaming 的 `step.delta` 同時涵蓋文字與 function call arguments → P0-8 的逐字串流與工具進度可統一在一條流上。
- 模型可升 `gemini-3.7-flash`（token 效率與 agentic planning 是官方主打的改進點，正好對應本案的多跳規劃失敗）。

**P2 範圍限制（明確界定，避免遷移擴散）**

- **範圍只含** `src/modules/agent/agent-manager.service.ts` 的 3 個 `generateContent` 呼叫點（`:154`、`:232`、`:331`）＋ `src/config/ai.ts` 的 client 設定。
- **明確不含**（各自獨立呼叫 `generateContent`、非 tool loop，另案處理）：`src/modules/ai/ai.service.ts`（intent/explain）、`air.service.ts`、`review.service.ts`、`voice/transcript-corrector.ts`、`agent-tools.ts` 的 `webSearch`。這些用 `responseMimeType` + `responseJsonSchema`，在 Interactions API 要改成**頂層 `response_format`**，屬額外工作量。
- **明確不含** Live API（voice，`live-bridge.ts:522`）——獨立 WebSocket surface。
- 第一階段 `store: false`（stateless），不用 `previous_interaction_id`——避免把含 PII 的對話交給伺服器保存。
- `system_instruction` / `tools` / `generation_config` 是 interaction-scoped，每個新 interaction 都要重送（官方明載）。
- Interactions API 尚不支援：batch API、explicit caching、custom safety settings、video metadata。需確認本專案未依賴（初判未依賴）。
- **待驗證**：`src/config/ai.ts:6-7` 用 `GEMINI_API_URL` 覆寫 `googleGenAi.httpOptions.baseUrl`。需確認該覆寫不會讓 SDK 打不到 `/v1beta/interactions`，也不會漏掉 `Api-Revision: 2026-05-20` header（SDK ≥ 2.0.0 應自動附帶）。
- 依賴無需升級：`@google/genai ^2.17.0` ≥ 2.3.0。

**P2 可行性 spike ✅ 已於 2026-08-18 實測（同一把 `.env` 的 key）**

`POST /v1beta/interactions`（`Api-Revision: 2026-05-20`、`model: gemini-3.7-flash`、`store: false`）→ **HTTP 200**，回傳含 `status: "completed"`、`steps`（首個 step 帶 `signature`）與 `usage`。
本專案的 key 與帳號**已可使用 Interactions API**，P2 沒有帳號層阻擋。

順帶取得一個與本案直接相關的數據：該次 trivial 呼叫的 `usage` 為 `total_output_tokens: 1` 但 `total_thought_tokens: 97`。
**thinking token 佔壓倒性多數**，因此任何輸出上限都必須把 thought token 算進去——這也是 P0-3 要記 `usageMetadata` 的理由，
並解釋為何複雜多跳題特別容易在輸出預算上出事（本案的 `agentConfig.maxOutputTokens: 1000` 雖是死碼，但若未來誤用即為此類故障源）。

---

## 4. 執行順序（v1.3 拍板）

### M1 — Interactions API 遷移（第一優先，含讓本題跑得完的最小條件）

| 項 | 動作 |
| - | ---- |
| M1-1 | `agent-manager.service.ts` 的 3 個 `generateContent` 呼叫點（`:154`／`:232`／`:331`）改 `client.interactions.create()`。**直接換，不留旗標。** |
| M1-2 | 啟用 stateful：loop 內用 `previous_interaction_id` + 只送 `function_result`；每個 interaction 重送 `tools`／`system_instruction`／`generation_config`。 |
| M1-3 | 模型改 `gemini-3.7-flash`；移除已棄用的 `temperature`／`topP`／`topK`；改用 `thinking_level`（本題需要推理，起手設 `high`，**不要為省成本調低**）。 |
| M1-4 | `toolConfig` → `generation_config.tool_choice`；最終強制產文字的那一輪用 `tool_choice: 'none'`（取代現行 `FunctionCallingConfigMode.NONE`）。 |
| M1-5 | `response.functionCalls` → 掃 `steps` 取 `function_call`（`id`／`name`／`arguments`）；`response.text` → `output_text`。 |
| M1-6 | streaming 改吃 `step.delta`（`text` 給最終答案、`arguments`＋`partial_arguments` 給工具參數），對外 SSE 事件名與 payload **不變**。 |
| M1-7 | **`MAX_ROUNDS` 提高到 15-20**。理由：本題實測需 10-20 次工具呼叫（D月台 4 條候選＝10 次、B月台 9 條＝20 次），維持 5 則遷移完仍答不出來。stateful 讓每輪成本大降，這個提高才付得起。 |
| M1-8 | 保留既有 `toGeminiHistory` 的語意，改輸出 Interactions 的 `input` steps 形狀（`user_input` / `function_result`）。 |

**M1 驗收**：`gemini-3.7-flash` + Interactions 實跑本題原句，斷言 ①有非空最終答案 ②逐月台列出候選路線 ③有標明為估算的到站時刻 ④工具呼叫序列跑完沒被截斷。並與舊 build 並排對打（無 shadow 可用，這是唯一的比對手段）。

### M2 — 止血與可觀測性（遷移後立即接上）

原 P0 的 bug 修復，遷移後語意更好做（`steps` 原生提供思考與步驟）：M2-1 最終答案永不為空（含二次重試 + 降級文案）／M2-2 controller 空字串改送 `error`／M2-3 structured log（步驟、`usage` 含 thought token、工具耗時）／M2-4 429/timeout 分類退避／M2-5 注入現在時間 `HH:mm`／M2-6 `runAgent` 補傳遺漏參數／M2-7 prompt 加「一定要輸出最終文字」收斂規則／M2-8 刪死碼 `agentConfig`/`agentContents`。

### M3 — 讓長鏈跑得順（payload 與語意）

M3-1 **`getBusTimetable` 語意修正**（起站時刻改 `originStopName`/`originDepartureTime` + `scheduleType: headway|trip` + note）——不修會讓模型把起站時刻當成查詢站時刻**自信錯答**，這比沒回答更糟／M3-2 `afterTime`/`limit` 參數／M3-3 統一 payload compaction（實測 `getBusRoute(132)` 8,360 字元、`getBusRouteDetail(132)` 25,265 字元，乘上多條候選路線會吃掉規劃空間）／M3-4 失敗結果也快取／M3-5 prompt 加公車時刻的**能力邊界**（只有起站時刻與班距，中途站一律標為估算）／M3-6 eval 補本題與多跳題。

**不做**：新增任何工具、工具集按意圖收斂、旗標/shadow、跨輪次 stateful、voice 的 Live API 遷移。

## 5. 風險（v1.3）

| 風險 | 緩解 |
| --- | --- |
| **無旗標、無 shadow** → 遷移出錯就是直接壞掉 | 回滾＝git revert（單一 commit 內完成遷移）；驗收必須新舊 build 並排對打真實題目，不以 tsc/測試全綠當完成標準 |
| stateful 讓對話存在 Google 側 55 天，而 memory 含 PII | 使用者已明示接受；需同步更新 `FUNCTIONAL_SPEC_AI_AGENT_PRODUCTION.md` §5.1 的個資告知範圍 |
| `MAX_ROUNDS` 提到 15-20 → 單次請求成本/延遲上升 | stateful 讓每輪只送一個工具結果、成本大降；並用 M2-3 的 per-request token log 盯實際用量，必要時設 token 預算上限而非砍輪數 |
| 換 `gemini-3.7-flash` 可能改變工具選擇行為 | 先跑 `eval-tool-routing.ts`（現有 35 題基準 100%）對打，再定案 |
| Interactions API 不支援 explicit caching / batch / custom safety settings | 已初判本專案未依賴；遷移前逐項確認 |
| 模型把起站時刻當成查詢站時刻自信錯答 | M3-1 的欄位語意修正 + M3-5 的能力邊界；**這是本次調查新發現、優先於美化類工作** |
| 遷移期間「空回答」bug 仍在 | M2 緊接 M1；且遷移本身（3.7-flash 的 loop spiraling 改善）預期會降低其發生率 |

## 6. 未決事項

1. ~~stateful 模式~~ → **已拍板啟用**（2026-08-18）。
2. ~~月台資料~~ → **已查證存在**，無需開發。
3. ~~推估精度~~ → **維持模型自估、標明估算**。
4. voice 的 Live API 是否另案遷移（目前明確排除）。
5. `thinking_level` 起手值（規劃建議 `high`，待 M2-3 的 log 數據回頭校準）。

## 7. 參考來源（2026-08-18 查證）

- Interactions API 總覽：https://ai.google.dev/gemini-api/docs/interactions-overview
- Interactions function calling：https://ai.google.dev/gemini-api/docs/interactions/function-calling.md.txt
- Function calling：https://ai.google.dev/gemini-api/docs/function-calling
- Text generation（使用者提供）：https://ai.google.dev/gemini-api/docs/text-generation?hl=zh-tw
- Changelog（GA 日期、模型、取樣參數棄用）：https://ai.google.dev/gemini-api/docs/changelog
