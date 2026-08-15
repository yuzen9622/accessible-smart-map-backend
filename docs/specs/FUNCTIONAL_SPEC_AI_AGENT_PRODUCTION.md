# AI Agent 正式上線工程規劃

## Functional Specification — AI Agent Production Readiness

**版本**：v1.0  
**狀態**：Planning — 尚未實作  
**日期**：2026-06-30  
**作者**：yuzen9622

---

## 目錄

1. [文件目的](#1-文件目的)
2. [現況快照（已完成）](#2-現況快照已完成)
3. [規劃目標](#3-規劃目標)
4. [非目標](#4-非目標)
5. [Phase 0 — 上線門檻](#5-phase-0--上線門檻)
6. [Phase 1 — 可觀測性 / Tracing](#6-phase-1--可觀測性--tracing)
7. [Phase 2 — 情節記憶（Episodic）](#7-phase-2--情節記憶episodic)
8. [Phase 3 — 答案品質 Eval](#8-phase-3--答案品質-eval)
9. [建議實作順序與工作量估算](#9-建議實作順序與工作量估算)
10. [新增環境變數](#10-新增環境變數)
11. [新增 npm 依賴](#11-新增-npm-依賴)
12. [測試策略](#12-測試策略)
13. [風險與緩解](#13-風險與緩解)

---

## 1. 文件目的

本文件規劃如何將現有的 AI Agent（`POST /api/v1/ai/chat`）從「可運作的技術原型」帶到「可對真實使用者開放的正式服務」。規劃重心在於三個面向：**可營運**（rate limit、token 護欄、tracing）、**可除錯**（完整的工具呼叫追蹤紀錄）、**合規**（個資透明告知、使用者記憶的 opt-in 控制）。

本文件為純規格，**不包含任何 `src/` 實作**。各 Phase 的驗收條件為功能規格的可測試邊界，具體實作方式交由開發者自行選擇。

---

## 2. 現況快照（已完成）

下列功能均已 commit 至 `main` 分支，開發者在實作本規格各 Phase 時請勿重複建置：

| 已完成項目                                                                                   | 核心檔案                                                                                                     | 狀態 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| Agentic tool loop（最多 5 輪，`FunctionCallingConfigMode.AUTO`，temperature 0）              | `src/modules/ai/ai-chat.service.ts`                                                                          | ✅   |
| 工具目錄（16 個常規工具 + 2 個記憶工具，登入時掛載）                                         | `src/config/ai/tool.ts`                                                                                      | ✅   |
| `executeLocalTool` 單一 dispatch 點                                                          | `src/modules/ai/agent-tools.ts`                                                                              | ✅   |
| User Memory（`loadMemories` / `saveMemory` / `deleteMemory` + Redis 快取，MAX 50 筆/使用者） | `src/modules/ai/memory.service.ts`                                                                           | ✅   |
| ChromaDB 向量知識庫（`searchAccessibilityGuide`，collection `accessibility_knowledge`）      | `src/modules/ai/knowledge.service.ts`、`src/adapters/chroma.adapter.ts`、`src/adapters/embedding.adapter.ts` | ✅   |
| SSE Streaming（`tool_call` / `tool_result` / `token` / `done` 事件）                         | `src/modules/ai/ai.chat.controller.ts`                                                                       | ✅   |
| 離線「工具路由」eval（`routeOnce`，不執行工具、不觸碰 DB）                                   | `src/scripts/eval-tool-routing.ts`                                                                           | ✅   |
| system prompt 防幻覺規則、記憶注入、位置注入                                                 | `src/config/ai/chat-prompt.ts`                                                                               | ✅   |
| tool 結果快取（`stableCacheKey`，同名同參不重複呼叫）                                        | `ai-chat.service.ts` `stableCacheKey`                                                                        | ✅   |

### 2.1 現況關鍵約束（本規格前提）

1. **無狀態**：`/ai/chat` 完全無狀態。前端每次送整包 OpenAI 格式 `messages`，後端沒有任何 `Conversation`/`Session` Mongoose model（`src/model/` 目前無此 collection）。
2. **記憶功能限登入使用者**：`aiChat` 呼叫 `resolveAuthUser(req)` 解析 Authorization header（不走 JWT middleware，而是自行 `verifyAccessToken`），取得 user 後才注入記憶工具與【使用者記憶】system prompt 區塊。
3. **`saveMemory` 主動儲存 PII**：`saveMemory` 的工具宣告說明（`src/config/ai/tool.ts`，line ~406）明確指示 AI「不需要使用者明確要求就主動儲存」，且 content 範例包含住家座標（`「家住板橋車站附近（25.0143, 121.4623）」`），屬典型 PII。
4. **記憶管理 API 尚未對外**：`memory.service.ts` 已有 `loadMemories` / `saveMemory` / `deleteMemory` 三個函數，但 `ai.router.ts` 目前只掛載 `/intent`、`/explain`、`/chat` 三條路由，**沒有任何 `GET /memories` 或 `DELETE /memories` 端點**。
5. **工具實際數量**：`openAiChatTools` 陣列共 **16 個**工具（含最新加入的 `findNearbyBusStops`）；`memoryTools` 2 個；登入時總計 **18 個**。`AI_AGENT_TOOLS_REFERENCE.md` 記載為 17 個，係文件未同步 `findNearbyBusStops` 新增，**請以本文件為準**。
6. **`ResponseCode` 已含 429**：`TOO_MANY_REQUESTS = 429` 已存在（`src/types/code.ts`），rate limit 實作可直接使用，無需擴充。
7. **Redis 優雅降級**：`REDIS_URL` 未設定時，`redisGet` / `redisSet` / `redisDel` 全數 no-op，rate limit 若依賴 Redis 儲存時需考量此行為（見 §5.2）。

---

## 3. 規劃目標

| 目標               | 說明                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| **可營運**         | 有 per-user + per-IP rate limit 護欄，對話長度有上限，不因單一使用者濫用而引發 LLM 費用失控或 TDX 429  |
| **合規**           | saveMemory 主動存 PII 時透明告知使用者；使用者對自己的記憶有完整的查詢 / 刪除控制權；記憶功能為 opt-in |
| **可除錯**         | 每次 `/ai/chat` 請求都留下完整的工具呼叫 trace，支援事後分析幻覺、工具選錯、latency 問題               |
| **答案品質可量測** | 有端到端 eval 題庫（延伸現有工具路由 eval），可定期斷言防幻覺規則未被破壞                              |

---

## 4. 非目標

下列項目明確不在本規劃範圍，避免過度工程化：

| 非目標                              | 說明                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 多 Agent 拆分                       | 現有單迴圈 Agent 已足夠；多 Agent 協作（Orchestrator + Sub-Agent）留待規模化後另立規格                               |
| HITL 消費性動作確認                 | 系統無訂票、付款、預約等需人工確認的動作，HITL 機制無必要性                                                          |
| Procedural Skills 外部載入          | 工具目錄目前固定編譯於後端；動態載入工具不在本期範圍                                                                 |
| LangGraph / LangChain 重寫          | 維持現有原生 `@google/genai` SDK 架構；不引入外部 orchestration 框架                                                 |
| User Memory 向量召回                | 目前 50 筆內以 `updatedAt` 排序即可接受；量大後再為 UserMemory 加 embedding（adapter 已在），列為 Phase 2 的未來選項 |
| Conversation 持久化（Phase 0 / P1） | 本期上線後再補（Phase 2），上線初期前端仍負責攜帶完整歷史                                                            |

---

## 5. Phase 0 — 上線門檻

**上線前必須完成。P0 任一項未完成，禁止對真實使用者開放。**

### 5.1 個資合規 / 使用者記憶同意機制

#### 5.1.1 問題

`saveMemory` 設計為「不需使用者明確要求就主動儲存」，且會存住家座標等 PII。目前系統在儲存後不通知使用者，使用者也無法透過 API 查詢或刪除自己的記憶。

#### 5.1.2 最小可接受做法（MVP）

**（a）存後透明告知**

當 AI 工具迴圈執行 `saveMemory` 成功後，controller 在最終回答前（或最終回答中）必須注入一段固定告知文字。

實作方式：在 `onToolResult` hook（controller 傳入 `runToolLoop`）中偵測工具名稱為 `saveMemory` 且結果為 `ok: true` 時，於 system prompt 末段加入提醒指令，要求模型在回答中自然告知使用者。具體 prompt 提示文字（繁中）：

```
【系統補充】你剛才呼叫了 saveMemory 儲存了一筆記憶，請在這次回答中自然地告知使用者，例如「我幫您記住了 X，之後您可以直接說就好，隨時可以告訴我忘記」。
```

告知文字需包含：已儲存的事實摘要（從 `content` 取出）、說明使用者可隨時要求刪除。

**（b）記憶管理 API（三支新端點）**

在 `src/modules/ai/ai.router.ts` 新增以下三條路由，全部掛在 `/api/v1/ai` 前綴下，並要求 JWT 認證（使用共用 auth middleware，參照 `hazard-report.router.ts` 的逐路由掛載方式）：

| Method   | Path                      | 功能                   |
| -------- | ------------------------- | ---------------------- |
| `GET`    | `/api/v1/ai/memories`     | 列出目前使用者所有記憶 |
| `DELETE` | `/api/v1/ai/memories/:id` | 刪除指定記憶           |
| `DELETE` | `/api/v1/ai/memories`     | 清空目前使用者全部記憶 |

---

**5.1.2.b.1 GET /api/v1/ai/memories — 列出記憶**

**認證**：JWT 必要（auth middleware 注入 `req.auth`）

**Query Parameters**

| 參數    | 型別   | 必要 | 說明                           |
| ------- | ------ | ---- | ------------------------------ |
| `limit` | number | 選用 | 回傳筆數上限，預設 20，最大 50 |

**後端邏輯**：呼叫既有 `loadMemories(userId, limit)`（`src/modules/ai/memory.service.ts`），不需新增 DB 查詢邏輯。

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 3 筆記憶",
  "data": {
    "memories": [
      {
        "_id": "6670abc123def456",
        "content": "使用者坐輪椅",
        "category": "preference",
        "createdAt": "2026-06-30T08:00:00.000Z",
        "updatedAt": "2026-06-30T08:00:00.000Z"
      },
      {
        "_id": "6670abc123def789",
        "content": "家住板橋車站附近",
        "category": "place",
        "createdAt": "2026-06-30T09:00:00.000Z",
        "updatedAt": "2026-06-30T09:00:00.000Z"
      }
    ],
    "total": 3
  }
}
```

> `userId` 來自 `req.auth.userId`，不從 query 參數傳入，防止越權查詢。

**錯誤回應**

| HTTP（ResponseCode） | 說明             |
| -------------------- | ---------------- |
| 401（UNAUTHORIZED）  | token 過期       |
| 403（FORBIDDEN）     | token 缺少或無效 |

---

**5.1.2.b.2 DELETE /api/v1/ai/memories/:id — 刪除指定記憶**

**認證**：JWT 必要

**路徑參數**

| 參數 | 說明                                           |
| ---- | ---------------------------------------------- |
| `id` | MongoDB ObjectId 字串（對應 `UserMemory._id`） |

**後端邏輯**：呼叫既有 `deleteMemory(userId, id)`（`memory.service.ts`）。該函數已檢查 `userId` 一致性（`deleteOne({ _id: memoryId, userId })`），無越權風險。

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "已刪除記憶",
  "data": {
    "deleted": true,
    "id": "6670abc123def456"
  }
}
```

**錯誤回應**

| HTTP（ResponseCode） | data.reason        | message                  |
| -------------------- | ------------------ | ------------------------ |
| 400（INVALID_INPUT） | `INVALID_ID`       | 無效的記憶 ID 格式       |
| 404（NOT_FOUND）     | `MEMORY_NOT_FOUND` | 找不到該筆記憶或無權刪除 |

---

**5.1.2.b.3 DELETE /api/v1/ai/memories — 清空全部記憶**

**認證**：JWT 必要

**後端邏輯**：以 `UserMemory.deleteMany({ userId })` 清空後，呼叫 `redisDel(cacheKey(userId))` 無效化快取。

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "已清除所有記憶",
  "data": {
    "deletedCount": 5
  }
}
```

**錯誤回應**

| HTTP（ResponseCode） | 說明             |
| -------------------- | ---------------- |
| 401（UNAUTHORIZED）  | token 過期       |
| 403（FORBIDDEN）     | token 缺少或無效 |

---

**（c）記憶功能 Opt-in 開關**

新增 `UserModel.settings.memoryEnabled: boolean`（預設 `false`）。`saveMemory` 工具執行前，`executeLocalTool` 須先查詢此設定，`memoryEnabled === false` 時回傳：

```json
{ "ok": false, "error": "使用者未開啟記憶功能" }
```

AI 工具迴圈收到此錯誤後不重試，自然以無記憶模式繼續對話。

`GET /api/v1/ai/memories` 與 `DELETE /api/v1/ai/memories/:id` 不受此開關影響（允許使用者在關閉前管理已存的記憶）。

> ⚠️ **待確認**：`UserModel` 是否已有 `settings` 欄位需確認 `src/model/user.model.ts`。若無，需新增 `settings: { memoryEnabled: { type: Boolean, default: false } }` 至 UserSchema。

---

#### 5.1.3 驗收條件

| #        | 條件                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| AC-0.1.1 | AI 執行 `saveMemory` 成功後，最終回答中包含已儲存事實摘要與刪除說明的告知文字 |
| AC-0.1.2 | 已登入使用者呼叫 `GET /ai/memories` 回傳 200 + 自己的記憶清單                 |
| AC-0.1.3 | 使用者 A 無法呼叫 `DELETE /ai/memories/:id` 刪除使用者 B 的記憶（404）        |
| AC-0.1.4 | `DELETE /ai/memories` 清空後，`GET /ai/memories` 回傳空陣列                   |
| AC-0.1.5 | `memoryEnabled = false` 時，AI 呼叫 `saveMemory` 不實際儲存，且對話不中斷     |
| AC-0.1.6 | 未登入呼叫三支 API 皆回 401/403                                               |

---

### 5.2 濫用 / 成本護欄

#### 5.2.1 問題

一次 `/ai/chat` 請求最壞情況下觸發：最多 5 輪 LLM 呼叫（tool loop）+ 1 次最終 completion = **最多 6 次 LLM 呼叫**，加上各工具可能觸發的 TDX / Google API 呼叫。TDX 已知 burst 4–6 呼叫就可能 429（見記憶 `[[tdx-quota-and-data-drift]]`）。無護欄時，單一惡意使用者可無限觸發，導致費用失控。

#### 5.2.2 設計

**（a）Per-User Rate Limit（需登入，依 userId 識別）**

| 限制                         | 時間窗 | 說明               |
| ---------------------------- | ------ | ------------------ |
| 每位使用者 20 次 `/ai/chat`  | 1 分鐘 | 防止機械式連續請求 |
| 每位使用者 100 次 `/ai/chat` | 1 小時 | 防止長時間大量消耗 |

**（b）Per-IP Rate Limit（無論是否登入，依 IP 識別）**

| 限制                   | 時間窗 | 說明                                |
| ---------------------- | ------ | ----------------------------------- |
| 每 IP 30 次 `/ai/chat` | 1 分鐘 | 防止未登入或 token 失效時的 IP 濫用 |

**（c）單請求工具呼叫總數上限**

`runToolLoop` 的 `MAX_ROUNDS = 5` 已限制 LLM 迴圈輪數。此外，新增**工具呼叫計數器**：若單次請求的工具呼叫總次數（含同一輪多工具）超過 **10 次**，提前終止迴圈並返回當前結果，不等待最大輪數用盡。

> 此計數器實作於 `runToolLoop` 內，`onToolCall` hook 每次觸發時遞增；達上限後設 `break`。

**（d）超限回應**

Rate limit 觸發時，在進入 controller 前由 middleware 回應：

```json
{
  "ok": false,
  "status": "error",
  "code": 429,
  "message": "請求過於頻繁，請稍後再試"
}
```

**（e）Redis 不可用時的降級**

`REDIS_URL` 未設定時，Redis 操作全數 no-op（現有行為）。Rate limit store 若使用 Redis，需實作 in-memory fallback（`express-rate-limit` 的記憶體 store），確保 Redis 不可用時服務仍正常（只是 rate limit 變為 per-process 而非全域）。

#### 5.2.3 驗收條件

| #        | 條件                                                                 |
| -------- | -------------------------------------------------------------------- |
| AC-0.2.1 | 同一使用者在 1 分鐘內發出第 21 次請求，回傳 429                      |
| AC-0.2.2 | 不同使用者的請求計數各自獨立，互不影響                               |
| AC-0.2.3 | 同一 IP 1 分鐘內第 31 次請求回傳 429（無論是否登入）                 |
| AC-0.2.4 | 工具呼叫計數達 10 次後，`runToolLoop` 提前終止，仍回傳有效的最終回答 |
| AC-0.2.5 | Redis 不可用時，服務仍正常接受請求（降級為記憶體 rate limit）        |

---

### 5.3 對話長度 / Token 上限

#### 5.3.1 問題

`/ai/chat` 為無狀態介面，前端每次攜帶完整 `messages` 陣列。若使用者持續追問，歷史訊息快速增長，可能超過 Gemini 的 context window，或每輪都傳送大量舊訊息造成 token 費用暴增。

#### 5.3.2 設計

後端在 `aiChat` controller 處理 `messages` 時，先截斷至最近 **N 輪**：

| 參數                | 預設值 | 說明                                                      |
| ------------------- | ------ | --------------------------------------------------------- |
| `MAX_HISTORY_TURNS` | 20     | 保留最近 20 輪對話（1 輪 = 1 user + 1 assistant message） |

截斷策略：

1. system message **永遠保留**（插在第一位）。
2. 對話歷史（user / assistant / tool 角色的 messages）僅保留**最新的 N 輪**，較舊的丟棄。
3. 截斷發生時，server 不回傳錯誤，靜默截斷。

> ⚠️ 截斷可能丟失較早的對話上下文。Phase 2 的對話持久化（Conversation Summarizer）可緩解此問題，但上線初期接受此 tradeoff。

此參數未來可由環境變數 `AI_MAX_HISTORY_TURNS` 覆蓋。

#### 5.3.3 驗收條件

| #        | 條件                                                                |
| -------- | ------------------------------------------------------------------- |
| AC-0.3.1 | 傳入超過 40 輪歷史的請求，後端截斷至最近 20 輪，system message 保留 |
| AC-0.3.2 | 截斷後請求正常完成，回應 200，不回傳 error                          |
| AC-0.3.3 | 恰好 20 輪的請求不被截斷                                            |

---

## 6. Phase 1 — 可觀測性 / Tracing

**P0 完成後、開放真實使用者前完成。與 P0 可並行開發。**

### 6.1 目標

每次 `/ai/chat` 請求在 MongoDB 留下完整的工具呼叫追蹤紀錄，供事後分析以下問題：

- 哪些工具被呼叫、耗時多長、是否成功？
- 一次請求共呼叫幾輪、幾次工具？
- 幻覺是否發生（可從 `finishReason` / 錯誤工具呼叫回推）？
- 費用估算（從 token count 推算）。

### 6.2 資料模型（`AiTrace`）

**Collection**：`AiTrace`  
**檔案**：`src/model/ai-trace.model.ts`

```typescript
import { Schema, model, Document } from "mongoose";

export interface IAiToolCallTrace {
  name: string; // 工具名稱
  argsHash: string; // SHA-256 of 遮罩後的參數 JSON（不存原始參數，見 §6.4）
  latencyMs: number; // 工具執行耗時（毫秒）
  ok: boolean; // 是否成功（isSuccessResult 的判斷）
  cached: boolean; // 是否命中 stableCacheKey 快取
}

export interface IAiTrace extends Document {
  traceId: string; // UUID v4，與 SSE done 事件一同回傳給前端（可用於客服查詢）
  userId?: string; // 已登入使用者的 userId；未登入為 undefined
  ipHash: string; // SHA-256(clientIp) — 不存原始 IP
  requestedAt: Date; // 請求進入 controller 的時間戳
  toolCalls: IAiToolCallTrace[];
  rounds: number; // tool loop 實際執行的輪數（0 = 無工具呼叫）
  promptTokens: number; // usage.promptTokenCount（最終 completion）
  completionTokens: number; // usage.candidatesTokenCount
  totalTokens: number; // usage.totalTokenCount
  finishReason: string; // "stop" | "max_rounds" | "tool_limit" | "error"
  errored: boolean; // 是否以 error SSE 事件結束
  totalLatencyMs: number; // 從請求進入 controller 到最後一個 SSE 事件的總耗時
  createdAt: Date;
}

const AiTraceSchema = new Schema<IAiTrace>(
  {
    traceId: { type: String, required: true },
    userId: { type: String, index: true },
    ipHash: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    toolCalls: [
      {
        name: { type: String, required: true },
        argsHash: { type: String, required: true },
        latencyMs: { type: Number, required: true },
        ok: { type: Boolean, required: true },
        cached: { type: Boolean, required: true },
      },
    ],
    rounds: { type: Number, required: true },
    promptTokens: { type: Number, required: true },
    completionTokens: { type: Number, required: true },
    totalTokens: { type: Number, required: true },
    finishReason: { type: String, required: true },
    errored: { type: Boolean, required: true },
    totalLatencyMs: { type: Number, required: true },
  },
  { timestamps: true },
);

// Index 定義
AiTraceSchema.index({ traceId: 1 }, { unique: true }); // 客服查詢
AiTraceSchema.index({ userId: 1, requestedAt: -1 }); // 按使用者查 trace
AiTraceSchema.index({ requestedAt: -1 }); // 時序瀏覽（TTL 掃描）
AiTraceSchema.index({ errored: 1, requestedAt: -1 }); // 錯誤分析
AiTraceSchema.index({ "toolCalls.name": 1, requestedAt: -1 }); // 工具使用頻率分析
// TTL 策略：trace 保留 90 天（可由環境變數 AI_TRACE_TTL_DAYS 調整）
// 注意：不使用 MongoDB TTL index 自動刪除，改以定時清理腳本，避免熱資料遭誤刪

export const AiTrace = model<IAiTrace>("AiTrace", AiTraceSchema);
```

**TTL 策略**：Trace 預設保留 90 天。清理方式與 HazardReport 不同：由於 trace 量大，**改用 MongoDB TTL index**（`expireAfterSeconds: 90 * 86400`，加在 `createdAt` 欄位），讓 MongoDB 背景自動清理，不需額外腳本。

### 6.3 插點設計

Trace 在 `aiChat` controller 中以 **fire-and-forget** 方式寫入，**絕不阻塞主回應路徑**。

#### 6.3.1 Controller 插點（`ai.chat.controller.ts`）

Controller 在進入 `runToolLoop` 前初始化 trace context，並在最終 `done` / `error` 事件後異步寫入：

```
requestedAt = Date.now()
traceId = crypto.randomUUID()
toolCallsBuffer = []

在 onToolCall hook：
  記錄 { name, argsHash, startTime }

在 onToolResult hook：
  補 { latencyMs, ok, cached }（ok 由 isSuccessResult 判定）

最終 completion 後：
  補 promptTokens、completionTokens、totalTokens、finishReason、rounds、totalLatencyMs

fire-and-forget：
  AiTrace.create(traceDoc).catch(err => console.error('[trace] write failed:', err))
```

#### 6.3.2 工具快取資訊取得

`runToolLoop` 內部的 `stableCacheKey` 快取邏輯目前對 controller 不透明。為取得 `cached` 欄位，需在 `onToolCall` / `onToolResult` hook 中加入快取命中旗標。實作方式由開發者自行選擇（例如在 hook 中傳入 `cached` 參數，或在 `runToolLoop` 的 return 值中補充 trace metadata）。

### 6.4 PII Redaction

**`toolCalls.argsHash`** 儲存的是參數的雜湊值，而非原始參數，原因：

- 工具參數可能含有使用者輸入的地名（間接 PII）或 `userLocation` 座標（直接 PII）。
- 雜湊足以做「同一組參數是否重複呼叫」的分析，且不需還原原始值。

雜湊計算與 `stableCacheKey` 一致（以相同的鍵排序後 JSON stringify，再做 SHA-256）：

```
argsHash = SHA-256(stableCacheKey(name, args))
```

> ⚠️ 若未來需要完整參數用於 debug，可選擇性儲存**去識別化後**的版本（例如以 `[REDACTED]` 取代座標數值），但不列為本期必要功能。

### 6.5 可替換 Sink 設計

`AiTrace.create(...)` 的呼叫集中在一個 `writeTrace(doc: IAiTrace)` 函數中，未來替換為 Langfuse / Datadog 等外部 sink 只需修改此單一函數，不動 controller。

### 6.6 驗收條件

| #      | 條件                                                                      |
| ------ | ------------------------------------------------------------------------- |
| AC-1.1 | 每次 `/ai/chat` 請求完成後，MongoDB 有一筆對應的 `AiTrace` document       |
| AC-1.2 | `traceId` 為全域唯一的 UUID v4                                            |
| AC-1.3 | `toolCalls` 陣列正確記錄本次請求觸發的所有工具（含名稱、耗時、成功/失敗） |
| AC-1.4 | `ipHash` 為 SHA-256 雜湊，不可逆回原始 IP                                 |
| AC-1.5 | Trace 寫入失敗（DB 異常）不影響主回應路徑，使用者仍正常收到回答           |
| AC-1.6 | `stream: true` 與 `stream: false` 兩種模式皆寫入 trace                    |
| AC-1.7 | 90 天後的 trace TTL 被 MongoDB 自動清理（可以加速 TTL 的測試環境驗證）    |

---

## 7. Phase 2 — 情節記憶（Episodic）

**開放真實使用者後迭代，不阻擋上線。**

### 7.1 前提：對話持久化（Conversation Model）

目前 `/ai/chat` 完全無狀態，無法事後回顧完整對話歷程，也無法做記憶蒸餾。需先建立 `Conversation` collection。

#### 7.1.1 資料模型（`Conversation`）

**Collection**：`Conversation`  
**檔案**：`src/model/conversation.model.ts`

```typescript
import { Schema, model, Document } from "mongoose";

export type ConversationRole = "user" | "assistant" | "system";

export interface IConversationTurn {
  role: ConversationRole;
  content: string; // 純文字；tool 呼叫與結果不單獨儲存（已在 AiTrace），僅儲存對人類可讀的 turn
  ts: Date;
}

export interface IConversation extends Document {
  userId: string; // 必填；僅登入使用者才持久化對話
  sessionId: string; // 由前端生成的 UUID，用於識別同一「對話視窗」的連續 turns
  turns: IConversationTurn[];
  turnCount: number; // 冗餘欄位，方便查「超過 N 輪」的條件
  summarized: boolean; // 是否已被蒸餾成 UserMemory
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true },
    turns: [
      {
        role: {
          type: String,
          enum: ["user", "assistant", "system"],
          required: true,
        },
        content: { type: String, required: true },
        ts: { type: Date, required: true },
      },
    ],
    turnCount: { type: Number, required: true, default: 0 },
    summarized: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

// Index 定義
ConversationSchema.index({ userId: 1, createdAt: -1 }); // 按使用者查歷史
ConversationSchema.index({ sessionId: 1 }, { unique: true }); // 精確查詢單一對話
ConversationSchema.index({ userId: 1, summarized: 1 }); // 蒸餾任務：找未蒸餾的對話
// TTL：對話保留 180 天（可由環境變數 AI_CONVERSATION_TTL_DAYS 調整）
// 同 AiTrace，以 MongoDB TTL index（createdAt expireAfterSeconds）清理

export const Conversation = model<IConversation>(
  "Conversation",
  ConversationSchema,
);
```

**儲存策略**

- **觸發時機**：`/ai/chat` 中，僅當 `userId` 存在（已登入）且請求包含 `sessionId` 時，才追加 turns。
- **追加方式**：fire-and-forget `Conversation.findOneAndUpdate({ sessionId }, { $push: { turns: ... }, $inc: { turnCount: 2 } }, { upsert: true })`，不阻塞回應。
- **不儲存 tool 訊息**：tool 呼叫與結果已在 `AiTrace` 中，`Conversation` 只儲存 `user` 與 `assistant` 的可讀 turns。

**請求 Schema 新增欄位**（`ai.schema.ts` `AgentChatRequestSchema`）

```
sessionId?: string   // 選填的 UUID，代表同一對話視窗的連續請求
```

### 7.2 記憶蒸餾（Summarizer）

對話達到 N 輪（建議 **20 輪**）後，在背景觸發蒸餾任務：以較便宜的模型（同 `GEMINI_MODEL`）讀取對話歷程，提取重要事實並存為 `UserMemory`。蒸餾完成後將 `Conversation.summarized` 設為 `true`，避免重複蒸餾。

**觸發時機**：

| 事件         | 觸發條件                                                                     |
| ------------ | ---------------------------------------------------------------------------- |
| 對話輪數達 N | `turnCount >= 20` 時，追加 turn 後異步觸發                                   |
| 對話明確結束 | 前端呼叫 `POST /api/v1/ai/sessions/:sessionId/end`（Phase 2 新增的選用端點） |

**蒸餾不阻擋使用者**：完全背景執行（fire-and-forget），不加入主回應路徑。

**Summarizer Prompt（概念）**

```
以下是一段與使用者的對話歷程。請分析對話中使用者透露的重要個人事實，
以「使用者＋事實」的格式輸出，每條一行，最多 5 條。
只提取客觀事實（行動模式、常去地點、習慣、偏好），不要分析情緒或推測。
```

### 7.3 現有記憶系統限制（已知，待後期解決）

| 限制                      | 說明                                       | 計畫                                                                                    |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| 僅按 `updatedAt` 排序召回 | `loadMemories` 無向量相似度，50 筆內可接受 | 超過 50 筆後，為 `UserMemory` 加 embedding（`embedding.adapter.ts` 已在），改以向量召回 |
| 無 PII 遮罩               | `UserMemory.content` 以明文儲存（含座標）  | 長期：加 field-level encryption；短期：靠 opt-in 與透明告知緩解                         |
| 蒸餾品質                  | Summarizer 可能提取偏差事實                | 蒸餾結果存入前先過 rule-based filter（如排除超過 200 字的 content）                     |

### 7.4 驗收條件

| #      | 條件                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| AC-2.1 | 已登入使用者攜帶 `sessionId` 的請求，完成後可在 `Conversation` collection 查到對應 turns |
| AC-2.2 | 未登入使用者的請求不儲存 Conversation                                                    |
| AC-2.3 | 同一 `sessionId` 的多次請求，turns 累積在同一 document                                   |
| AC-2.4 | `turnCount >= 20` 時，後台蒸餾任務背景啟動，對話請求正常完成不等待蒸餾                   |
| AC-2.5 | 蒸餾完成後，`Conversation.summarized = true`，且對應的 `UserMemory` 已建立               |
| AC-2.6 | 蒸餾失敗不影響後續對話，`summarized` 維持 `false`（等待下次重試）                        |

---

## 8. Phase 3 — 答案品質 Eval

**上線後迭代，持續優化，不阻擋上線。**

### 8.1 現有 Eval 範圍

`src/scripts/eval-tool-routing.ts` 以 `routeOnce` 驗證「模型選擇正確工具」的能力，具體評分邏輯：

- `PASS`：N 輪中 100% 選對工具
- `FLAKY`：部分輪次選對
- `FAIL`：N 輪中 0 次選對

此 eval **不執行工具、不驗證回答內容**，是純工具路由測試。

### 8.2 新增端到端題庫

在 `src/scripts/agent-cases.ts` 基礎上，新增「端到端評估案例」，每個案例執行完整工具迴圈（呼叫真實工具、不 mock），並以以下方式驗證回答品質：

#### 8.2.1 驗證類型

| 驗證類型         | 說明                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| **LLM-as-Judge** | 以 Gemini 評估回答是否「根據工具結果」、「不含編造事實」，給出 0–5 分                                                 |
| **斷言式檢查**   | 針對特定欄位（站名、路線號碼、時刻）以 regex / 精確比對，確認與工具回傳一致                                           |
| **防幻覺規則**   | 驗證 `chat-prompt.ts` 中的以下規則是否被遵守：工具回傳 `ok: false` → 回答說「查不到」；工具未回傳的事實不出現在回答中 |

#### 8.2.2 題庫設計原則

| 原則               | 說明                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 固定題目、固定參數 | eval 案例的 query 與 userLocation 固定，結果具可重現性                                                             |
| 覆蓋高風險工具     | 重點覆蓋可能幻覺的工具：`planAccessibleRoute`（站名/時刻）、`getBusArrival`（分鐘數）、`getBusTimetable`（首末班） |
| 反例覆蓋           | 包含「工具查無結果」案例，確認 AI 回「查不到」而非編造                                                             |
| 獨立於 `npm test`  | 端到端 eval 呼叫真實 API，不在 CI vitest 中執行，以 `npm run eval:e2e` 手動觸發                                    |

#### 8.2.3 驗收條件

| #      | 條件                                                              |
| ------ | ----------------------------------------------------------------- |
| AC-3.1 | `npm run eval:e2e` 可執行，輸出每個案例的通過/失敗狀態            |
| AC-3.2 | 「工具回傳 ok: false」案例中，AI 回答不包含編造內容（斷言式檢查） |
| AC-3.3 | LLM-as-Judge 在基準題庫上，80% 以上案例得分 ≥ 4/5                 |
| AC-3.4 | eval 腳本輸出 JSON 報告，可比較不同版本 / prompt 的分數差異       |

---

## 9. 建議實作順序與工作量估算

> ⚠️ 以下為粗估，不含部署、測試與 code review 時間，實際工作量以開發者評估為準。

| Phase            | 項目                                                  | 粗估         | 備註                                                                               |
| ---------------- | ----------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| **P0.1**         | 個資合規：透明告知 + 三支記憶 API + opt-in 開關       | **2 天**     | memory.service 邏輯已有，主要工作在 router/controller/UserModel 擴充與 opt-in 開關 |
| **P0.2**         | 濫用護欄：per-user + per-IP rate limit + 工具計數上限 | **1 天**     | express-rate-limit 已熟悉（hazard-report 有先例），Redis store 可複用              |
| **P0.3**         | 對話長度截斷                                          | **< 0.5 天** | controller 加幾行，邏輯簡單                                                        |
| **P1**           | AiTrace model + 插點 + TTL + PII redaction            | **1–2 天**   | Model 設計本文已給；插點需與 runToolLoop hook 協作                                 |
| **P2**           | Conversation model + 持久化 + Summarizer              | **3–4 天**   | 主要工作在 Summarizer prompt 調校與觸發機制                                        |
| **P3**           | 端到端 eval 題庫 + LLM-as-Judge                       | **1–2 天**   | 需準備測試案例與 Judge prompt                                                      |
|                  |                                                       |              |                                                                                    |
| **P0 + P1 合計** | 上線所需最小工作量                                    | **~5 天**    |                                                                                    |
| **P2 + P3 合計** | 上線後迭代工作量                                      | **~5–6 天**  |                                                                                    |

**建議部署順序**：

```
P0.1 + P0.2 + P0.3（可並行）
          ↓
         P1（可與 P0 並行開發）
          ↓
    [開放真實使用者]
          ↓
      P2（迭代）→ P3（持續優化）
```

---

## 10. 新增環境變數

| 變數                            | 用途                           | 必要性 | 預設值 |
| ------------------------------- | ------------------------------ | ------ | ------ |
| `AI_MAX_HISTORY_TURNS`          | 對話歷史截斷輪數（§5.3）       | 選配   | `20`   |
| `AI_CHAT_RATE_LIMIT_PER_MIN`    | per-user 每分鐘上限（§5.2）    | 選配   | `20`   |
| `AI_CHAT_RATE_LIMIT_PER_HOUR`   | per-user 每小時上限（§5.2）    | 選配   | `100`  |
| `AI_CHAT_IP_RATE_LIMIT_PER_MIN` | per-IP 每分鐘上限（§5.2）      | 選配   | `30`   |
| `AI_TRACE_TTL_DAYS`             | AiTrace 保留天數（§6.2）       | 選配   | `90`   |
| `AI_CONVERSATION_TTL_DAYS`      | Conversation 保留天數（§7.1）  | 選配   | `180`  |
| `AI_SUMMARIZER_TURN_THRESHOLD`  | 觸發蒸餾的輪數門檻（§7.2）     | 選配   | `20`   |
| `AI_MAX_TOOL_CALLS_PER_REQUEST` | 單請求工具呼叫總數上限（§5.2） | 選配   | `10`   |

> `REDIS_URL`、`GEMINI_API_KEY`、`GEMINI_MODEL`、`GEMINI_API_URL` 已存在，無需重複新增。

---

## 11. 新增 npm 依賴

| 套件                 | 用途                              | Phase | 備註                                                  |
| -------------------- | --------------------------------- | ----- | ----------------------------------------------------- |
| `express-rate-limit` | Per-user / per-IP rate limit      | P0.2  | hazard-report 規格中已評估過                          |
| `rate-limit-redis`   | express-rate-limit 的 Redis store | P0.2  | 與現有 ioredis 整合；Redis 不可用時降級為記憶體 store |

> P1–P3 不需新增外部依賴：AiTrace / Conversation 使用既有 Mongoose；Summarizer 使用既有 `@google/genai` SDK。

---

## 12. 測試策略

### 12.1 單元 / 路由整合測試（vitest + supertest）

沿用現有 `buildTestApp()` + `buildAuthorizationHeader()` 測試框架（`tests/helpers/test-helpers.ts`），對新端點撰寫路由整合測試：

| 測試案例                                               | 驗證重點                                |
| ------------------------------------------------------ | --------------------------------------- |
| `GET /ai/memories` 未登入                              | 401/403                                 |
| `GET /ai/memories` 已登入                              | 200 + 資料列表（mock memory.service）   |
| `DELETE /ai/memories/:id` 越權（使用者 A 刪 B 的記憶） | 404 MEMORY_NOT_FOUND                    |
| `DELETE /ai/memories/:id` 正常                         | 200 + deleted: true                     |
| `DELETE /ai/memories` 已登入                           | 200 + deletedCount                      |
| Rate limit（mock redis store 到達上限）                | 429                                     |
| 對話截斷（傳入 25 輪歷史）                             | tool loop 以截斷後的歷史執行，max 20 輪 |

### 12.2 手動 / 煙測

| 場景                | 步驟                                                | 預期結果                                    |
| ------------------- | --------------------------------------------------- | ------------------------------------------- |
| saveMemory 透明告知 | 告訴 AI「我住板橋」（已登入）                       | 回答中包含告知文字，MongoDB 有新 UserMemory |
| 記憶 opt-in 關閉    | 設 `memoryEnabled=false`，告訴 AI「我住板橋」       | 無 UserMemory 建立，對話正常                |
| Rate limit          | 1 分鐘內同一使用者連發 21 次 `/ai/chat`             | 第 21 次 429                                |
| AiTrace 寫入        | 完成一次對話後，查詢 MongoDB `ai_traces` collection | 存在對應 document，toolCalls 正確           |
| Trace 不阻塞回應    | 模擬 MongoDB write timeout（offline 環境）          | SSE 仍正常送完，使用者收到回答              |

---

## 13. 風險與緩解

| 風險                                                | 影響                                        | 緩解策略                                                                                                  |
| --------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **PII 擴散**：saveMemory 繼續主動存住家座標等 PII   | 個資合規風險                                | P0.1 的 opt-in 開關與透明告知為第一道防線；長期評估 field-level encryption                                |
| **TDX 429**：多工具呼叫觸發 TDX burst limit         | 工具回傳 ok:false，AI 給出錯誤答案          | P0.2 的工具呼叫上限（10 次/請求）緩解；tool 結果快取（現有）可複用同參數結果                              |
| **LLM 費用失控**：無限制使用者大量呼叫              | Gemini API 費用暴增                         | P0.2 rate limit + P0.3 歷史截斷雙重保護                                                                   |
| **AiTrace 寫入量大**：高並發時 MongoDB 寫入壓力     | DB 效能下降                                 | fire-and-forget + TTL 清理（90 天）；量大後評估換 Langfuse 等專用 observability sink                      |
| **Conversation 儲存量**：每位登入使用者每對話都儲存 | 儲存空間持續成長                            | 180 天 TTL + `summarized=true` 後可降低召回優先級；Phase 2 上線初期預計使用者數量有限                     |
| **Summarizer 品質**：蒸餾出偏差的 UserMemory        | AI 以錯誤的記憶回答使用者                   | 蒸餾結果加 rule-based filter（例如 content 長度上限 200 字）；使用者可隨時透過 `DELETE /ai/memories` 清除 |
| **Redis 不可用**：rate limit 降級為 per-process     | 多 process / 多 instance 下 rate limit 偏鬆 | 開發環境可接受；正式環境建議確保 REDIS_URL 設定正確                                                       |
