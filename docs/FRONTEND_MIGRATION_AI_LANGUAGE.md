# AI 助理與語音：前端語言偏好串接

日期：2026-10-09。此次只修改後端；Web／手機 App 尚未串接，也尚未部署。

文字 AI 與語音共用選填欄位 `language`，只接受目前介面支援的 `zh-TW`（臺灣繁體中文）與 `en`（英文）。前端應傳入**目前生效的介面語言**，不要以訊息內容、瀏覽器語言或舊對話推測。若 i18n 使用 `en-US` 等地區代碼，先依前端現有語言選擇邏輯轉成 `en`；不要直接傳入未支援的代碼。

## 文字 AI

`POST /api/v1/ai/chat`，JSON 與 SSE 都使用相同 body：

```json
{
  "language": "en",
  "stream": true,
  "messages": [{ "role": "user", "content": "台北車站附近有電梯嗎？" }]
}
```

- 每次送出問題時重新讀取介面語言；切換語言後的下一次請求立即採用新值。
- 不要只把語言放進 `messages[].role = "system"`：後端會移除客戶端 system 訊息，以伺服器提示為準。
- `language` 是頂層欄位，不放進 `routingPreferences` 或對話歷史。原有位置、路線契約與訊息欄位照常傳送。
- 不合法的值（例如 `null`、`""`、`en-US`、`ja`、數字）回 HTTP 400，不會呼叫模型。
- OpenAPI 的 `AgentChatRequest` 已同步，可從 `/api/v1/openapi.json` 或 `/docs` 查看。

## 即時語音

`wss://<host>/api/v1/voice/ws`，在既有認證首訊息加入欄位：

```json
{
  "type": "session.start",
  "token": "<accessToken>",
  "language": "en",
  "history": [{ "role": "user", "text": "台北車站附近有電梯嗎？" }]
}
```

- 初次開啟、網路重連、文字切換到新的語音 session 時，均重新讀取目前語言；不要固定捕捉 controller 建立時的舊值。
- 語言在這條 client session 內固定。使用者切換介面語言後，關閉舊 WebSocket 並重新連線，新的 `session.start` 傳入新語言；目前沒有 `language.set` 等控制訊息。
- 若導航中需要重連，保留 `navigationId`、`routeVersion`、`routeToken` 與進度，再沿用既有 `nav.resume` 流程。只關閉 WebSocket，**不要送 `session.end` 或 `nav.cancel`**：這兩者會刪除導航快照，導致無法續接。
- 後端因路線切換而重建 Gemini Live 上游連線時，會保留此 session 的語言偏好。
- 不合法的 `language` 使握手驗證失敗，close code 為既有的 `4401`；前端先確保代碼正確，不要無限重試。

## 回覆行為與範圍

1. 指定語言優先於舊對話、記憶、工具結果與範例的語言。英文介面即使問題包含中文地名，仍要求模型用英文回覆；本輪明確要求另一語言或翻譯時可遵照該要求。
2. 文字 AI 的正常回答、空回答重試與最終降級文案都遵循此偏好。語音對話也以系統提示指定語言。
3. 英文語音導航要求模型忠實翻譯導航內容後播報，保留方向、站名、路線號碼、距離與時間；繁中與省略語言時保留逐字播報。
4. 原始工具結果、結構化 `nav.*` 指示文字、錯誤碼與 HTTP／WS 錯誤訊息不屬於此次翻譯範圍。前端既有 UI 翻譯仍需保留。
5. 省略欄位時保留舊客戶端的語言推斷，不強制套用新預設值；最終空回答降級文案仍為原本的繁中。

Gemini Live 原生音訊依系統提示控制語言，[官方文件](https://ai.google.dev/gemini-api/docs/live-api/capabilities#change-voice-and-language) 指出不支援以 `speechConfig.languageCode` 明確指定語言。因此有前端 `language` 時不送這個 SDK 欄位，伺服器 `GEMINI_LIVE_LANGUAGE_CODE` 也不會覆蓋前端偏好；未傳 `language` 的舊行為保留。

## 前端驗收

- 分別在繁中／英文介面測試 JSON 與 SSE 回覆；英文介面用中文地名提問，確認回覆仍是英文。
- 帶著舊中文對話切換英文，再開啟語音；確認回覆與實際音訊語言。
- 切換語言後重連，確認首訊息使用新值；導航重連確認能續接原本路線與進度。
- 英文語音中測試導航播報，核對方向、站名、距離與時間沒有被改寫。
- 後端自動測試驗證傳遞、提示、驗證失敗、重試與降級路徑；實際模型生成品質、音訊與前端裝置行為仍需整合驗收。
