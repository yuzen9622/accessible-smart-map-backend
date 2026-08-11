# 前端遷移說明：SOS 緊急事件完整生命週期 + LINE agent 化

本次後端變更把 LINE 家人機器人從「意圖狀態機」改為 tool-loop agent，並補齊緊急事件的完整閉環（家人確認 → 承接 → 協作 → 網頁即時回饋 → 解除結案 → 完整歷程）。**對前端（求救者網頁端）而言，新增了即時串流與事件詳情兩支 API；既有四支 SOS API 的路徑與請求不變**，僅回應多了生命週期欄位。LINE 家人端的互動由後端負責，前端無需處理。

## 一、新增 API

所有新端點都在 `/api/v1/sos`，皆需登入（`Authorization: Bearer <accessToken>`），且**只有事件的擁有者（求救者本人）可存取**（非本人 → 403）。

### 1. `GET /api/v1/sos/sessions/:id` — 事件詳情（初載 / polling fallback）

回傳完整事件快照（含 timeline、確認名單、承接者、處理狀態）。用於頁面初次載入，或 SSE 斷線時的輪詢備援。

回應 `data` 形狀（`SosSnapshot`）：

```jsonc
{
  "sessionId": "66b0abc123def4567890abcd",
  "status": "active",              // "active" | "resolved"（主開關）
  "handlingStatus": "claimed",     // "notified"|"acknowledged"|"claimed"|"en_route"|"arrived"|"resolved"
  "claimedBy": "Uxxxx",            // 承接家人的 LINE userId（可為 null）
  "claimedByName": "小明",          // 承接家人姓名（可為 null）
  "claimedAt": "2026-07-21T08:30:10.000Z",
  "acknowledgements": [            // 已「確認收到」的家人
    { "lineUserId": "Uxxxx", "name": "小明", "at": "2026-07-21T08:30:00.000Z" }
  ],
  "timeline": [                    // 完整事件歷程（append-only，依 at 排序）
    { "type": "created",       "actorType": "victim",  "actorName": null,  "note": null, "at": "..." },
    { "type": "notified",      "actorType": "system",  "actorName": null,  "note": null, "at": "..." },
    { "type": "acknowledged",  "actorType": "contact", "actorName": "小明", "note": null, "at": "..." },
    { "type": "claimed",       "actorType": "contact", "actorName": "小明", "note": null, "at": "..." },
    { "type": "status_update", "actorType": "contact", "actorName": "小明", "note": "前往中", "at": "..." },
    { "type": "resolved",      "actorType": "victim",  "actorName": null,  "note": null, "at": "..." }
  ],
  "location": { "lat": 25.033, "lng": 121.5654, "address": "…", "updatedAt": "..." },
  "resolvedAt": null,
  "updatedAt": "..."
}
```

包在既有 envelope 內：`{ ok, status, code, message, data }`。

### 2. `GET /api/v1/sos/sessions/:id/stream` — SSE 即時串流

`Content-Type: text/event-stream`。連線後：

- 先收到一則初始快照事件，之後每當家人有動作（確認 / 承接 / 更新狀態 / 解除）或位置更新，就推送一則新的快照。
- 事件格式：`event: update\ndata: <SosSnapshot JSON>\n\n`。
- 心跳：每 ~25 秒一則註解行 `: ping`（用於保活，忽略即可）。

前端範例：

```js
const es = new EventSource(`/api/v1/sos/sessions/${id}/stream`, { withCredentials: true });
es.addEventListener("update", (e) => {
  const snapshot = JSON.parse(e.data);
  render(snapshot); // 更新「由誰處理 / 處理狀態 / 歷程」
});
es.onerror = () => {
  es.close();
  // 重連前先打 GET /sessions/:id 取最新快照，再重新建立 EventSource
};
```

> 注意：`EventSource` 無法自訂 Header，若你的登入 token 走 Authorization Header 而非 cookie，請改用支援 header 的 SSE polyfill（如 `@microsoft/fetch-event-source`）帶上 `Authorization`；或在斷線時以 `GET /sessions/:id` 輪詢替代。後端 SSE 路由與其他 SOS 路由一樣走 JWT middleware。

## 二、既有 API 的變化（其中一項破壞，見下方安全性修復）

- `POST /sessions`、`PATCH /sessions/:id/location`、`PATCH /sessions/:id/resolve`：**路徑、請求 body、既有回應欄位皆不變**。
- `GET /sessions/:id/public` → **`GET /sessions/:token/public`（破壞性變更，見下方「公開追蹤連結安全性修復」）**。

## 二之一、公開追蹤連結安全性修復（破壞性變更，前端必須配合）

**問題**：之前實作的 `GET /api/v1/sos/sessions/:id/public` 實際上是用原始 session id（MongoDB ObjectId）查詢，並非設計上應該使用的高熵 `shareToken`。ObjectId 不是加密安全隨機值（同一時段建立的 session id 彼此相鄰、可被列舉），意味著陌生人有機會猜到別人正在求救的即時 GPS 位置。已修復。

**後端變更**：
- Endpoint 路徑改為 `GET /api/v1/sos/sessions/:token/public`，`:token` 是建立 SOS session 時回傳的 `shareToken`（32 字元十六進位字串，128-bit 熵），**不是** `sessionId`。
- `POST /sessions` 回應的 `shareToken` 欄位未變，一直都有回傳，只是之前沒被用到。
- LINE 推送給家人的追蹤連結（`{PUBLIC_TRACKING_BASE_URL}/zh-TW?sos=...`）同步改用 `shareToken`。

**前端需要改的地方**：
1. 若前端曾自行用 `POST /sessions` 回傳的 `sessionId` 拼追蹤連結（例如 `/zh-TW?sos=${sessionId}`），**改成用同一筆回應裡的 `shareToken`**。
2. 若前端是直接解析 LINE 推送連結中的 `sos=` 參數來呼叫 `GET /sessions/:id/public`，不需要改程式碼（連結本身已改為 shareToken，直接拿來拼 URL 即可），但若有別的地方用 `sessionId` 拼這支 API 就需要修改。
3. 既有已發出、尚未過期的舊連結（用 sessionId 拼成）在上線後會**立即失效**（404），因為後端不再接受 sessionId 查詢。若需要不中斷過渡，請告訴我，可討論短暫雙軌支援（但不建議，因為 sessionId 查詢本身就是漏洞）。
4. **建議上線順序**：後端先上線（舊連結立即失效）→ 前端將組連結邏輯改用 shareToken 並部署 → 確認新求救的追蹤連結可正常開啟。若介意短暫窗口期內舊連結失效，可協調同步部署時間。
- 新的生命週期欄位（`handlingStatus`、`acknowledgements`、`claimedByName`、`timeline` 等）只在新的 `GET /sessions/:id` 與 SSE 快照中提供；舊端點回應維持精簡。
- `resolveSession` 現在是原子冪等：重複呼叫（或家人已先解除）回 200 且不再重複推播。

## 三、UI 建議（對應需求閉環）

1. 事件頁顯示 **「目前由誰處理」**：`claimedByName` + `handlingStatus`（未承接時顯示已確認家人數 `acknowledgements.length`）。
2. **歷程時間軸**：直接渲染 `timeline`（type → 中文標籤、actorName、note、at）。
3. 家人動作即時反映：靠 SSE `update` 事件重繪，不需輪詢。
4. `status === "resolved"` 後停止顯示「進行中」樣式，改顯示結案摘要（`resolvedAt` + 最終 timeline）。

## 四、LINE 家人端（前端無需實作，僅說明）

- 求救通知的 Flex 訊息新增 postback 按鈕「我收到了」「我來處理」；家人按下後，事件狀態即時透過上述 SSE 反映到網頁端。
- 承接後家人會收到「前往中 / 已抵達 / 解除警報」快速回覆按鈕。
- 對已結案事件按舊按鈕 → 家人收到「此事件已結案」，不會有任何副作用。
- LINE 一般對話已改為 agent（與 `/ai/chat` 同核心），家人可用自然語言查詢求救狀態、位置、路線、天氣、公車等。

## 五、授權

- 事件詳情 / SSE：僅擁有者（求救者本人）。
- 家人（LINE）動作：後端以 LINE userId 對照「已綁定的緊急聯絡人」授權；非授權者無法查看事件或位置。
