# 即時語音對話 WebSocket 協議規格（前端串接文件）

> 讀者：負責把語音功能接進正式前端的工程師。本文件目標是讓你不需要讀後端原始碼即可完成串接。
> 事實來源：`src/modules/voice/voice.gateway.ts`、`src/modules/voice/live-bridge.ts`、`src/modules/voice/poc-client.html`（可運作參考實作）、`memory/reviews/plans/a73ce70ab30ec0f2.md` §3.10。
> 定案：2026-07-10 使用者實測繁中音質可接受、工具轉接正常，採 **Gemini Live API proxy** 路線（詳見 `docs/specs/VOICE_POC_RESULT.md`）。

## 1. 總覽與架構

前端透過一條 WebSocket 連線把使用者的麥克風音訊即時串流給後端，後端不做語音辨識/合成，而是原樣轉發給 Google Gemini Live API，再把 Gemini 的逐字稿、工具呼叫、回覆音訊轉發回前端。後端同時是「單一真相」的工具執行者：Gemini 要查公車到站、規劃路線等，都是後端本地執行 tool 後把結果回傳給 Gemini。

```
┌──────────┐   wss:// (JSON + binary PCM16/16k)   ┌──────────────────┐   Gemini Live SDK   ┌─────────────────┐
│  前端       │ ───────────────────────────────────▶ │  Voice Gateway    │ ──────────────────▶ │ Gemini Live API │
│ (瀏覽器)    │ ◀─────────────────────────────────── │ (voice.gateway.ts │ ◀────────────────── │ (gemini-3.1-    │
│            │   JSON 事件 + binary PCM16/24k        │  + live-bridge.ts)│   audio/transcript/  │ flash-live-     │
└──────────┘                                        └──────────────────┘   tool_call          │ preview)        │
                                                              │                                └─────────────────┘
                                                              ▼
                                                     本地工具執行（公車到站、
                                                     路線規劃等，見 agent-tools.ts）
```

## 2. 連線與認證流程

### 2.1 WS 端點

```
wss://<host>/api/v1/voice/ws     (正式環境)
ws://localhost:<PORT>/api/v1/voice/ws   (本機開發)
```

其他路徑的 upgrade 請求會被回 `HTTP/1.1 404 Not Found` 並關閉 socket，不會升級成 WS。

### 2.2 首訊息認證（5 秒內）

連線建立（`onopen`）後，**必須在 5 秒內**送出第一個文字（JSON）訊息，型別為 `session.start`：

```json
{
  "type": "session.start",
  "token": "<accessToken>",
  "userLocation": { "latitude": 25.0478, "longitude": 121.517 }
}
```

- `token`：必填，字串。**絕不可放在 URL query string**，只能放在這個首訊息的 body 裡。
- `userLocation`：選填，`{ latitude, longitude }` 皆為 number 才會生效，否則整欄位被忽略（不會報錯，只是後端當作沒帶）。
- 逾時未送、送出的不是合法 JSON、`type` 不是 `session.start`、`token` 不是字串、token 驗證失敗（含過期）→ 連線被關閉，close code `4401`。
- 認證完成前若送出 binary frame 或非 `session.start` 的訊息，同樣直接 `close(4401)`。
- 認證通過後，後端會先嘗試踢掉同一使用者「先前」的連線（見 §6 的 `4409`），再建立與 Gemini Live 的連線；成功後回傳 `{"type":"session.ready"}`，前端這時才能開始送音訊。

### 2.3 取得 token：登入 API

```bash
curl -X POST https://<host>/api/v1/user/login \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Doe",
    "email": "jane@example.com",
    "client_id": "<OAuth 提供者的 sub/uid>",
    "avatar": "https://example.com/avatar.png"
  }'
```

回應（`accessToken` 在最外層，注意不是在 `data` 裡）：

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "OK",
  "data": {
    "user": {
      "_id": "...",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "...": "..."
    },
    "config": { "...": "..." }
  },
  "accessToken": "<JWT，拿這個當 session.start 的 token>"
}
```

- `avatar` 為選填，其餘三欄必填（`name` 非空字串、`email` 需是合法 email、`client_id` 非空字串）。
- refreshToken 不在 JSON body 裡，是以 `httpOnly` cookie（名稱 `refreshToken`）設定，前端不需要也拿不到它。
- **accessToken 效期 60 分鐘**（見 §8），過期後 WS 認證會直接 `4401`，前端需重新登入或用 `/api/v1/user/token`／`/refresh` 換新 token 後再連 WS。

## 3. 訊息協議完整參考

### 3.1 Client → Server

| 型別            | 傳輸        | 欄位                                                                                    | 範例                                                                                                 | 說明                                                                                  |
| --------------- | ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `session.start` | text (JSON) | `type`, `token` (string, 必填), `userLocation?` (`{latitude:number, longitude:number}`) | `{"type":"session.start","token":"eyJ...","userLocation":{"latitude":25.0478,"longitude":121.5170}}` | 必須是連線後第一則訊息，5 秒內送出                                                    |
| （音訊）        | binary      | 原始 PCM16 bytes                                                                        | —                                                                                                    | 僅認證成功後才會被接受並轉發給 Gemini；認證前送 binary 會被視為未授權而 `close(4401)` |
| `session.end`   | text (JSON) | `type`                                                                                  | `{"type":"session.end"}`                                                                             | 相容用結束訊息；主要終止方式應直接呼叫 `WebSocket.close()`                            |
| `nav.setRoute`  | text (JSON) | `type`, `routeToken`                                                                    | `{"type":"nav.setRoute","routeToken":"..."}`                                                         | 選定 HTTP 路線後 arm；只傳 token，不傳完整 route                                      |
| `nav.position`  | text (JSON) | `type`, `latitude`, `longitude`, `heading?`, `accuracy?`                                | `{"type":"nav.position","latitude":25.0478,"longitude":121.517,"accuracy":8}`                        | 導航中節流上報位置；transit 期間仍持續上報                                            |
| `nav.cancel`    | text (JSON) | `type`                                                                                  | `{"type":"nav.cancel"}`                                                                              | UI 主動停止導航，不結束語音會話                                                       |

其他未定義的文字訊息型別會被忽略並在伺服器端 log 一行警告，不會回應任何錯誤給前端。

所有 `nav.*` 必須等收到 `session.ready` 才送。文字 control frame 上限為 8 KiB，後端另有逐連線 frame/byte budget；洪峰會以 `4408` 關閉。位置建議使用 `watchPosition` 並以約 10 公尺 distanceFilter 或路口事件節流。

### 3.2 Server → Client

| 型別            | 傳輸        | 欄位                                                                                                                                                                                                                                           | 範例                                                                                                                                                                                                                                                                      | 觸發時機                                                                                                                                                            |
| --------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.ready` | text (JSON) | `type`                                                                                                                                                                                                                                         | `{"type":"session.ready"}`                                                                                                                                                                                                                                                | 認證成功且 Gemini Live 連線建立完成，前端此時才可開始送音訊                                                                                                         |
| （音訊）        | binary      | 原始 PCM16 bytes                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                                         | Gemini 回覆的語音，見 §3.4                                                                                                                                          |
| `transcript`    | text (JSON) | `type`, `role` (`"user"` \| `"model"`), `text` (string), `final?` (boolean，僅 `role:"user"`)                                                                                                                                                  | `{"type":"transcript","role":"user","text":"竹北車站","final":true}`                                                                                                                                                                                                      | 使用者語音辨識逐字稿（`role:"user"`）或模型回覆逐字稿（`role:"model"`）。見 §3.5 的 interim/final 規則                                                              |
| `tool_call`     | text (JSON) | `type`, `name` (string，工具名)                                                                                                                                                                                                                | `{"type":"tool_call","name":"getBusArrivalEstimate"}`                                                                                                                                                                                                                     | 模型觸發工具呼叫的當下（工具開始執行前）                                                                                                                            |
| `tool_result`   | text (JSON) | `type`, `name`, `ok` (boolean), `durationMs` (number), `result` (optional，工具回傳資料，任意 JSON 值：物件／陣列／`null`；與文字模式 SSE 的 `tool_result` 內容一致；`ok:false` 執行失敗時省略), `args` (optional，物件，模型呼叫工具時的參數) | `{"type":"tool_result","name":"findA11yPlaces","ok":true,"durationMs":812,"result":{"places":[{"id":"a11y_123","name":"台北車站無障礙電梯","latitude":25.0478,"longitude":121.517,"category":"elevator"}]},"args":{"latitude":25.033,"longitude":121.5654,"radius":500}}` | 工具執行完成（成功或失敗都會送）。`result` 為工具回傳的實際內容，前端可據此在地圖上撒點／畫路線；`result`、`args` 皆為 optional 且向後相容（未帶 = 行為與舊版相同） |
| `interrupted`   | text (JSON) | `type`                                                                                                                                                                                                                                         | `{"type":"interrupted"}`                                                                                                                                                                                                                                                  | 使用者開口打斷模型正在說話時（barge-in）                                                                                                                            |
| `turn.complete` | text (JSON) | `type`                                                                                                                                                                                                                                         | `{"type":"turn.complete"}`                                                                                                                                                                                                                                                | 這一輪模型回覆全部結束                                                                                                                                              |
| `error`         | text (JSON) | `type`, `code` (`"LIVE_CONNECT_FAILED"` \| `"LIVE_SESSION_ENDED"`)                                                                                                                                                                             | `{"type":"error","code":"LIVE_SESSION_ENDED"}`                                                                                                                                                                                                                            | 見下方說明                                                                                                                                                          |
| `nav.start`     | text (JSON) | `steps`, `currentStepIndex`, `totalSteps`                                                                                                                                                                                                      | `{"type":"nav.start","steps":[...],"currentStepIndex":0,"totalSteps":5}`                                                                                                                                                                                                  | 語音工具成功開始導航，前端渲染整條步驟                                                                                                                              |
| `nav.step`      | text (JSON) | `currentStepIndex`, `instruction`, `remainingM`                                                                                                                                                                                                | `{"type":"nav.step","currentStepIndex":1,"instruction":"前方右轉","remainingM":30}`                                                                                                                                                                                       | GPS 命中下一 geofence，更新 highlight                                                                                                                               |
| `nav.transit`   | text (JSON) | `leg`                                                                                                                                                                                                                                          | `{"type":"nav.transit","leg":{"mode":"BUS","from":"甲站","to":"乙站","routeName":"307"}}`                                                                                                                                                                                 | 抵達該 transit leg 上車點；只播報搭乘資訊                                                                                                                           |
| `nav.arrived`   | text (JSON) | `type`                                                                                                                                                                                                                                         | `{"type":"nav.arrived"}`                                                                                                                                                                                                                                                  | 抵達最終目的地                                                                                                                                                      |
| `nav.stop`      | text (JSON) | `reason`                                                                                                                                                                                                                                       | `{"type":"nav.stop","reason":"arrived"}`                                                                                                                                                                                                                                  | 導航結束；reason 為 `user_voice`/`user_ui`/`arrived`/`session_end`                                                                                                  |
| `nav.offroute`  | text (JSON) | `distanceM`                                                                                                                                                                                                                                    | `{"type":"nav.offroute","distanceM":72}`                                                                                                                                                                                                                                  | 連續 GPS 樣本判定偏離步行路線；v1 不自動重規劃                                                                                                                      |
| `nav.error`     | text (JSON) | `code`, `message`                                                                                                                                                                                                                              | `{"type":"nav.error","code":"NAV_ROUTE_INVALID","message":"路線已過期，請重新規劃"}`                                                                                                                                                                                      | arm/start 失敗；code 為 `NAV_ROUTE_INVALID` 或 `NO_ROUTE_ARMED`                                                                                                     |

`error` 的兩種 `code`：

- `LIVE_CONNECT_FAILED`：認證成功後，後端連 Gemini Live 失敗；緊接著會 `close(1011)`。
- `LIVE_SESSION_ENDED`：Gemini Live 連線自然結束（如 ~10 分鐘上限，見 §8）；緊接著會 `close(1000, "live-session-ended")`。

### 3.3 逐步導航 routeToken 與 wire schema

先呼叫 `POST /api/v1/a11y/accessible-route`。每一條成功寫入 Redis 的 route 會多一個 optional `routeToken`（30 分鐘 TTL）；Redis 不可用時 route 仍可顯示，但不會有 token，也就不能啟動語音導航。token 是短效 bearer capability，前端不得記錄到 analytics/log 或放進 URL。

`nav.start.steps` 的每個 `NavStepDto` 精確為：

```ts
interface NavStepDto {
  index: number;
  instruction: string;
  legType: "WALK" | "BUS" | "METRO" | "THSR" | "TRA";
  distanceM: number | null;
  isTransit: boolean;
}
```

內部 geofence 座標一律是 GeoJSON tuple `[lng, lat]`。v1 僅 WALK 逐步導航；BUS/METRO/THSR/TRA 只在上車點播報並以 GPS 追蹤下車點；含 DRIVE/MOTORCYCLE 的 route 在 start 時回 `NAV_ROUTE_INVALID`。

```text
HTTP accessible-route ── route + routeToken ──▶ 前端選路
前端 ── nav.setRoute(routeToken) ─────────────▶ 後端 Redis 取可信 route
使用者說「開始導航」 ─────────────────────────▶ Live startNavigation tool
前端 ◀── nav.start ─────────────────────────── 後端狀態機
前端 ── nav.position（節流、transit 仍送） ───▶ geofence 推進
前端 ◀── nav.step / nav.transit / nav.offroute
前端 ◀── nav.arrived + nav.stop(arrived)
```

### 3.4 Binary frame 音訊格式

| 方向                | 編碼                                | 取樣率   | 聲道 | 切幀間隔                                                                  |
| ------------------- | ----------------------------------- | -------- | ---- | ------------------------------------------------------------------------- |
| 上行（前端 → 後端） | PCM16 (16-bit signed little-endian) | 16000 Hz | mono | 每累積 1600 samples（= 100ms）送一個 binary frame                         |
| 下行（後端 → 前端） | PCM16 (16-bit signed little-endian) | 24000 Hz | mono | 依 Gemini 回傳的 chunk 大小，非固定 100ms，前端需能處理任意長度並依序播放 |

後端把上行 PCM16 轉成 base64 塞進 `mimeType: "audio/pcm;rate=16000"` 送給 Gemini；下行則是 Gemini inline audio data 解 base64 後原樣以 binary frame（`{binary:true}`）轉發，前端收到的 `ws.onmessage` 若 `e.data instanceof ArrayBuffer` 就是這個下行音訊。

### 3.5 使用者逐字稿的 interim / final（⚠️ 前端渲染規則，破壞性變更）

`role:"user"` 的 `transcript` 事件分兩種：

- **interim**（`final` 不存在或為 `false`）：使用者說話中即時送出的部分逐字稿片段（fragment），**未經校正**，用來做即時字幕。同一句話會連續來多則。
- **final**（`final:true`）：整句講完後，後端用一次性 LLM 對台灣地名／車站／捷運／路線名做**音近錯字校正**（例如「珠北車站」→「竹北車站」）後送出的**最終整句**。校正約在講完後 0.5–1 秒到；LLM 逾時／失敗時會退回未校正原文，但仍帶 `final:true`。

**前端必須這樣渲染（不可再無腦 append）**：

- `role:"user"`：把 interim 片段累加到「當前這句」的字幕元素；收到 `final:true` 時**用該則 `text` 整句取代**當前字幕，並結束這句（下一則 interim 另起新句）。
- `role:"model"`：不帶 `final`，維持原本逐段 append 行為。
- barge-in（收到 `interrupted`）或斷線時，重置「當前使用者字幕」狀態，避免殘留半句。

參考實作見 `poc-client.html` 的 `handleTranscript()`。校正為顯示層功能，不影響工具呼叫參數與路線規劃；可用後端 env `VOICE_TRANSCRIPT_CORRECTION=false` 關閉（關閉後 final 帶未校正原文）。

## 4. 一次完整對話 turn 的時序

```
前端                         後端 Voice Gateway              Gemini Live API
 │  (連線 wss://.../voice/ws) │                               │
 │ ─session.start(token)────▶ │                               │
 │                            │ ── verify token ──            │
 │                            │ ── live.connect ─────────────▶ │
 │ ◀────session.ready──────── │ ◀──────────────────────────── │
 │  (開始送 16k PCM16 binary,  │                               │
 │   每 100ms 一個 frame)       │                               │
 │ ──binary audio───────────▶ │ ──sendRealtimeInput──────────▶ │
 │        ...（持續說話中）    │                               │
 │ ◀───transcript(role=user)─ │ ◀── inputTranscription ────── │
 │                            │                               │  （使用者停止說話，模型判斷需要查資料）
 │ ◀───tool_call─────────────  │ ◀── toolCall.functionCalls ── │
 │                            │ (本地執行工具，如查公車到站)      │
 │                            │ ──sendToolResponse───────────▶ │
 │ ◀───tool_result───────────  │                               │
 │ ◀───transcript(role=model)─ │ ◀── outputTranscription ───── │
 │ ◀───binary audio (24k)────  │ ◀── inlineData (audio) ────── │  （可能連續多個 chunk）
 │ ◀───turn.complete─────────  │ ◀── turnComplete ──────────── │
```

若使用者在模型說話中途開口，會收到 `interrupted`（見 §5）而非依序播完。

## 5. 打斷（barge-in）處理

收到 `{"type":"interrupted"}` 時，前端**必須立刻清空音訊播放佇列**（停止/丟棄所有已排程但尚未播放的下行音訊 buffer），否則會出現舊回覆音訊與新回覆重疊。參考實作 `poc-client.html` 的 `clearPlayback()`（關閉並捨棄整個 playback `AudioContext`，下一段音訊到達時重建）。

## 6. Close codes 與前端應對

| Code   | 觸發原因（依程式碼）                                                                                                         | 前端建議行為                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `4401` | token 缺失/格式錯誤/驗證失敗/過期；或 5 秒內未送 `session.start`；或認證前送了 binary/其他訊息                               | 視為未授權：清除本地 token，導去重新登入（`/api/v1/user/login` 或 `/refresh`）取得新 accessToken 後重連 |
| `4409` | 同一使用者在別處開了新的語音連線（新連線會踢掉舊連線）                                                                       | 提示使用者「已在其他裝置/分頁開啟語音對話」，不要自動重連此連線                                         |
| `4408` | 認證後文字 frame/byte budget 耗盡                                                                                            | 視為異常流量；停止送資料，退避後完整重連                                                                |
| `4410` | Gemini 導航語音 turn 連續兩次逾時                                                                                            | 完整重連；重新送 `session.start`，收到 ready 後重新 `nav.setRoute(routeToken)`                          |
| `1000` | 正常關閉：前端主動 WS close／相容的 `session.end`（reason `client-end`），或 Gemini Live 結束（reason `live-session-ended`） | 使用者主動結束則正常收尾；Live 結束則重新走完整連線流程                                                 |
| `1011` | 伺服器內部錯誤，目前唯一來源是認證後連 Gemini Live 失敗（`LIVE_CONNECT_FAILED`）                                             | 提示暫時無法使用語音，可加退避後重試                                                                    |

### 6.1 異常斷線（close code `1006`）

上表之外，前端一定會遇到**沒有 close handshake 的異常斷線**：後端每 30 秒 `ws.ping()`、連續兩次未收到 pong 就直接 `ws.terminate()`（`voice.gateway.ts`）；行動網路切換、斷網、電腦休眠也會產生相同結果。這些情況瀏覽器端看到的都是 `CloseEvent.code === 1006`（abnormal closure），不會落在上表任何一列。前端必須把 `1006` 當成一級公民處理，不可只實作表內 close code。

**斷線當下（無論是否重連）立即執行：**

1. 停止並釋放麥克風：對 MediaStream 的每個 track 呼叫 `track.stop()`——不是只停止送資料，要真正釋放裝置（瀏覽器的錄音指示燈要熄滅）。
2. 清空播放佇列並釋放 AudioContext 資源（同打斷處理，見 §5）。
3. UI 顯示「連線中斷」狀態。

**重連狀態機：**

- 僅在使用者意圖仍為「會話啟用」（使用者沒按結束、語音元件仍掛載）時，才排程**指數退避**自動重連：初始 1 秒、每次倍增、**上限 30 秒**。
- 以下任一事件發生時，**必須取消所有待執行的重連計時器**：使用者按下結束、元件卸載（unmount/離開頁面）、登出、token 失效、或收到 `4409`。
- 差異化規則（與 §6 表格一致）：`4401` 必須先重新取得新 token 才可重連（不可拿舊 token 自動重試）；`4409` **不自動重連**；`1000`/`1011` 依表格處理。自動重連只適用於 `1006`。

**麥克風恢復規則（隱私）：**

- 重連成功並收到 `session.ready` 之後，才重新 `getUserMedia` 取得新的 MediaStream 恢復擷取（瀏覽器可能再次跳出權限提示，屬預期行為）。
- **絕不在使用者已結束會話後自動恢復**麥克風擷取——重連與恢復擷取的前提永遠是「使用者的會話啟用意圖還在」。

## 7. 音訊實作指引

**直接參考 `src/modules/voice/poc-client.html`（可運作的完整實作），不需要重新設計音訊管線。** 關鍵函式：

- 上行擷取與降頻（`AudioWorkletProcessor`）：以 `new AudioContext({ sampleRate: 16000 })` 讓瀏覽器內建的**抗混疊高品質重取樣器**把麥克風降到 16kHz，worklet 只負責 float32→Int16 轉換並每 1600 samples/100ms 送一個 binary frame：`captureWorklet` / `startMic()`，`src/modules/voice/poc-client.html`。
- **⚠️ 絕不可用「每 N 個 sample 取 1 個」的裸抽稀（naive decimation）降頻**：沒有抗混疊 low-pass 濾波會產生 aliasing，把 8kHz 以上能量摺疊回語音頻段，嚴重破壞辨識準度（中文近音字尤其致命）；同時 `Math.round(sampleRate/16000)` 在 44.1kHz 裝置上會得到實際 14.7kHz 卻仍宣告 16kHz，造成變速變調。務必交由 `AudioContext` 的目標取樣率做重取樣，並確認 `audioCtx.sampleRate === 16000`。
- 下行 PCM16/24kHz 播放佇列（用 `AudioContext({sampleRate:24000})` 排程 buffer 依序播放，`playHead` 追蹤下一段開始時間）：`playPcm24()`，`poc-client.html:224-246`。
- 打斷時清空播放佇列：`clearPlayback()`，`poc-client.html:248-253`。
- WS 連線、認證、事件分派（`ws.onmessage` 依 `type` switch）：`connect()`，`poc-client.html:255-317`。

建議直接抄 `captureWorklet` / `startMic` / `playPcm24` / `clearPlayback` 這幾段邏輯搬進正式前端的音訊模組，不要重新發明播放排程邏輯。**取樣率轉換一律交給瀏覽器**（建構 `AudioContext` 時指定目標 `sampleRate`），不要自己在 worklet 內抽稀降頻。

## 8. 限制與已知事項

- **每使用者同時只允許一個語音會話**：第二條認證連線會讓第一條收到 `4409` 並被關閉（見 §6）。
- **accessToken 效期 60 分鐘**（`createAccessToken` 的 `expiresIn: "60m"`）；WS 只在握手當下驗證一次 token，會話中不會重驗——最壞情況是 token 在會話尾端過期，但當次會話仍會正常跑完。
- **Gemini Live 連線約 10 分鐘上限**，到時後端會收到 Gemini 端的 `onclose`，回前端 `error:LIVE_SESSION_ENDED` 後 `close(1000)`；**目前未實作 session resumption**（不會自動接續），前端需整個重新走一次連線＋認證流程。
- **Gateway 目前未做 Origin 檢查**（任何來源都能發起 WS upgrade）；正式上線前後端會補上，前端不需為此做任何事，但不要假設目前有這層防護。
- **透過 Cloudflare Tunnel 部署時，`wss://` 的 upgrade 是否放行尚未驗證**（POC 階段未經過 tunnel 測試），正式環境串接時若連線失敗需優先確認 tunnel 設定。

## 9. 本機開發環境

```bash
VOICE_POC_ENABLED=true npm run dev
```

啟動後瀏覽器開 `http://localhost:<PORT>/api/v1/voice/poc`，即可用後端提供的參考測試頁（`poc-client.html`）貼上 accessToken 實際跑一次語音對話，用來對照自己前端實作的行為是否一致。
