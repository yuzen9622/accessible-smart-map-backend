# AI 助理工具與 Tool Result 格式參考（現況 / as-built）

**端點**：`POST /api/v1/ai/chat`
**狀態**：Active — 反映 repo 現行實作
**日期**：2026-06-30（2026-10-09 更新 AI 路線一致性契約）
**SDK**：原生 `@google/genai` Interactions API（stateful）；工具仍以 OpenAI function schema 定義，由 `tool-catalog.ts` 轉成 Gemini 宣告

> 本文件描述「目前程式碼實際掛載的工具與回傳形狀」。

**來源檔**：

- `src/config/ai/tool.ts` — `openAiChatTools`(23) + `memoryTools`(2) + `lineFamilyTools`(12) 宣告
- `src/modules/agent/tool-catalog.ts` — `buildInteractionTools`（文字）／`buildGeminiTools`（語音 Live）組裝工具目錄
- `src/modules/ai/agent-tools.ts` — 各工具實作與回傳 JSON、`executeLocalTool`
- `src/modules/agent/agent-manager.service.ts` — `runToolLoop` / `isSuccessResult` / `stableCacheKey` / 結果包裝
- `src/modules/ai/ai.chat.controller.ts` — SSE 事件 `sendSse`、`CHAT_SYSTEM_PROMPT`、非串流回應
- `src/modules/ai/ai.schema.ts` — `AgentChatRequestSchema`
- 底層 service 回傳形狀：各模組 `*.types.ts` 與 `src/types/index.d.ts`

---

## 0. 概覽

- **工具目錄**：`/ai/chat` 與語音 = `openAiChatTools`（23 個）＋（**僅登入且允許記憶時**）`memoryTools`（2 個），最多 **25 個**。LINE 家人 agent 另加 `lineFamilyTools`（12 個，見 §8），共 35 個。
- **回傳**：底層 `executeLocalTool` 回傳 JSON 字串；AI／語音／LINE 的路線 executor 轉成 `{ clientResult, modelResult }`。前端收到完整路線，Interactions function_result／Live function response 收到相同資料的模型投影，不含 polyline、routeToken 或設施大陣列。

### 回傳信封慣例

| 類型         | 形狀                                                            | 適用工具                     |
| ------------ | --------------------------------------------------------------- | ---------------------------- |
| 成功（主流） | `{ ok: true, … }`                                               | 除 `findGooglePlaces` 外全部 |
| 成功（特例） | `{ status: "OK" \| "ZERO_RESULTS", places }`                    | **僅** `findGooglePlaces`    |
| 失敗         | `{ ok: false, error }` / `{ ok: false, message }` / `{ error }` | 全部                         |
| 公車失敗     | `{ ok: false, error, status: 400\|404\|500 }`（透傳 service）   | 5 個公車工具                 |

- **成功/失敗判定**（`isSuccessResult`）：解析後只要 `parsed.error` 為真 **或** `parsed.ok === false` 視為失敗。
- **快取**（`stableCacheKey`）：成功結果按同名同參快取；失敗允許一次重試後也快取，以免耗盡回合。新路線成功時清除舊規劃與指引快取。注意 `findGooglePlaces` 的 `ZERO_RESULTS`（無 `error`、無 `ok:false`）會被當成功而快取。

---

## 1. 傳輸格式（Wire Format）

### Request Body（`AgentChatRequestSchema`）

```jsonc
{
  "messages": [
    {
      "role": "system|user|assistant|tool",
      "content": "string|null",
      "name": "string", // role=tool 時對應工具名
      "tool_calls": "ToolCall[]",
      "tool_call_id": "string",
    },
  ], // 至少 1 筆
  "stream": "boolean", // 預設 false
  "temperature": "number", // 0~2，預設 0.2（工具迴圈內固定 0）
  "userLocation": { "latitude": "number", "longitude": "number" }, // 選填
  "routeContractVersion": 1, // 選填；新前端應送
  "routeContext": { "routeToken": "伺服器發出的短效 token" }, // 或 null 清除
  "routingPreferences": { "mode": "wheelchair", "transitPreference": "bus" }, // 選填預設
}
```

### stream: true — SSE（`text/event-stream`）

| event         | data                     | 時機                                  |
| ------------- | ------------------------ | ------------------------------------- |
| `tool_call`   | `{ name, args, callId }`         | 某工具開始執行                        |
| `tool_result` | `{ name, result, summary, callId }`       | 該工具解析後結果（＝本文件各 result） |
| `token`       | `{ text }`               | 最終回答逐塊串流                      |
| `done`        | `done`                   | 結束                                  |
| `error`       | `{ code: 500, message }` | 例外（其後仍補 `done`）               |

> 工具事件（`tool_call` / `tool_result`）會在「最終回答串流」**之前**全部送完：含工具的回合若混有文字會先捨棄，無工具的回答回合完成後依原 chunks 輸出。最終強制回答仍支援逐塊串流。

### stream: false — 標準 ApiResponse 包 OpenAI chat.completion

```jsonc
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "OK",
  "data": {
    "id": "chatcmpl-…",
    "object": "chat.completion",
    "created": "<unix>",
    "model": "…",
    "choices": [
      {
        "index": 0,
        "message": { "role": "assistant", "content": "…" },
        "finish_reason": "stop",
      },
    ],
    "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  },
}
```

---

## 2. Tool Loop 機制（`runToolLoop`）

| 面向     | 行為                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| 最大輪數 | `MAX_ROUNDS = 18`；某輪無 function call 且有文字即直接回傳                                                  |
| 呼叫模式 | `tool_choice: "auto"`（首輪可用 `allowedFunctionNames` 強制 `any`）；Interactions API **沒有 temperature**  |
| 歷程保留 | stateful：每輪以 `previous_interaction_id` 串接，只送新的 function result，不重送整段歷程                  |
| 結果包裝 | 工具回傳 JSON 字串 → `JSON.parse` → `functionResponse: { name, response }`；非物件則包成 `{ result: <值> }` |
| 收尾     | 用完輪數或某輪回空時，再以 `tool_choice: "none"` 做一次 final round 產生最終文字                            |

---

## 3. 型別字典

多個工具共用的巢狀型別。`location.coordinates` 一律為 GeoJSON `[lng, lat]` 順序。

```ts
GooglePlace = { name; place_id; formatted_address; rating?: number;
                location: { latitude; longitude } }

SlimA11y   = { osmId; category; location;            // slimFacility 瘦身後
               name?; wheelchair?; tags?: Record<string,string> }   // tags 只留白名單鍵

IA11y      = { _id; 項次; "出入口電梯/無障礙坡道名稱"; 經度; 緯度; location }
IBathroom  = { _id; county; village; name; address; administration;
               latitude; longitude; location; grade; type; type2; exec; diaper }
IDisabledParking = { _id; city; district; quantity; placeName;
               chargeType; spaceLabel; isMarked; latitude; longitude; location }

// 常用 leg 事實欄位示意。前端 planAccessibleRoute 回傳完整 AccessibleRoute，
// 另含 routeId、polyline、steps、設施與 warnings；以 src/types/route.ts / OpenAPI 為準。
WALK  = { type:"WALK",  from; to; distanceM; minutesEst }
BUS   = { type:"BUS",   routeName; departureStop; arrivalStop; direction;
          waitMinutes; departureTime|null; arrivalTime|null }
METRO = { type:"METRO", railSystem; lineId; lineName; departureStation;
          arrivalStation; rideMinutes; waitMinutes; departureTime|null; arrivalTime|null }
THSR  = { type:"THSR", trainNo; departureStation; arrivalStation;
          departureTime; arrivalTime; rideMinutes }
TRA   = { type:"TRA",  trainNo; trainTypeName; departureStation;
          arrivalStation; departureTime; arrivalTime; rideMinutes }
```

---

## 4. 地點 / 路線工具

所有工具均額外由後端注入 `userLocation`（不在 LLM schema 內）。「目前位置」起點以 `current_location` 表示。參數欄 `*` 表必填。

### 4.1 `findGooglePlaces` — 一般地點/商家/景點（fallback）

| 參數                     | 型別   | 說明                       |
| ------------------------ | ------ | -------------------------- |
| `query` *                | string | 關鍵字，如「附近的咖啡廳」 |
| `latitude` / `longitude` | number | 選填，優化結果             |

**成功**（注意用 `status` 非 `ok`）：

```jsonc
{ "status": "OK", "places": "GooglePlace[]" }
// 無結果：
{ "status": "ZERO_RESULTS", "places": [] }
```

**失敗**：`{ "error": "Google Places API 查詢失敗" }`

### 4.2 `findA11yPlaces` — 無障礙設施 DB（電梯/廁所/坡道/輪椅，**不含停車位**）

| 參數                     | 型別   | 說明                                  |
| ------------------------ | ------ | ------------------------------------- |
| `query` *                | string | 地點名稱（缺 lat/lng 時用它 geocode） |
| `latitude` / `longitude` | number | 選填，搜尋中心                        |
| `range`                  | number | 半徑公尺，預設 **300**                |

**成功**：

```jsonc
{
  "ok": true,
  "searchLocation": { "lat": 0, "lng": 0, "query": "…" },
  "places": {
    "nearbyMetroA11y": "IA11y[]", // 捷運電梯/坡道出口
    "nearbyBathroom": "IBathroom[]", // 無障礙廁所
    "nearbyOsm": "SlimA11y[]", // OSM 設施（已瘦身）
    "nearbyParking": "IDisabledParking[]",
  },
}
```

**失敗**：

```jsonc
{ "ok": false, "message": "找不到地點「…」的座標" }
{ "ok": false, "error": "缺少位置資訊（query 或 lat/lng 必填）" }
{ "error": "資料庫查詢失敗" }
```

### 4.3 `planAccessibleRoute` — 一次規劃的完整候選路線

內部呼叫 `planAccessibleRouteFromRequest` 一次，沿用 `maxTransfers: 2` 與既有共用規劃器，再呼叫 `attachRouteTokens` 保存結果。保留完整候選與原排序，前端直接顯示，不得自動再呼叫 HTTP 路線規劃。

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `origin` * | string | 完整地名；目前位置填 `current_location` |
| `destination` * | string | 完整地名 |
| `mode` | enum | wheelchair／elderly／visual_impaired／normal；未明示時省略，沿用行程或使用者設定 |
| `transitPreference` | enum | bus／rail／metro；none 明確取消偏好，省略沿用目前行程；均為軟性偏好 |
| `departureTime` | string | 工具仍相容 ISO8601 或 HH:mm；HTTP／WS routingPreferences 只接受帶時區 ISO 日期 |
| `avoidStairs`、`requireElevator` | boolean | 明示條件；省略沿用目前行程與共用規劃器預設 |

成功 `result` 的正式結構為 OpenAPI `AiRoutePlanToolResult`：

```ts
{
  ok: true;
  routeContractVersion: 1;
  planId: string;
  selectedRouteId: string; // routes[0].routeId
  origin: { name: string; lat: number; lng: number };
  destination: { name: string; lat: number; lng: number };
  city: string | null;
  mode: string;
  transitPreference: "none" | "bus" | "rail" | "metro";
  effectivePreferences: { mode; travelMode; transitPreference; maxTransfers;
    avoidStairs; requireElevator; departureTime?; needsAccessibleToilet;
    needsHandrail; maxSlopePercent? };
  routes: AccessibleRoute[]; // 完整 legs、polyline、steps、warnings 與設施
  // 其餘共用規劃結果欄位（alerts、arrivalEntrance 等）照原語意保留。
}
```

每條 route 的 routeToken／navigationId／routeVersion 沿用既有 optional 欄位。Redis 保存失敗仍保留可顯示的完整路線，不偽造 token、不偷偷重算。空 routes 或缺少 canonical 條件視為失敗。帳號 userId 與 `_canonicalRequest` 不會輸出。

模型投影保留相同 planId／selectedRouteId／routeId 與每段運具、站名、時刻、警告，移除 token、幾何、steps 與設施大陣列。歷史 summary 上限 1200 字元，優先保留選中路線，裁切時標記 truncated；不能當作可信選擇同步。

### 4.4 `getNavInstructions` — 已選路線的逐步指引

只接受模型提供的 `userHeading`（0–359，可省略）與 `language`（zh-TW／en，可省略）。可信 routeToken 由後端對話脈絡注入；模型提供的 token、origin、destination、routeIndex 不會用來選路或重新規劃。

內部沿用 `generateNavInstructionsFromInput`，成功回 `{ ok: true, instructions, totalSteps, initialBearing, warnings }`；指引詳細欄位沿用 [導航指引規格](./FUNCTIONAL_SPEC_NAV_INSTRUCTIONS.md)。

無選擇回 `ROUTE_CONTEXT_REQUIRED`；無效／過期 token 回 `INVALID_ROUTE_TOKEN`；讀取失敗回 `ROUTE_CONTEXT_UNAVAILABLE`，均附 `ok: false` 與 error。指引 service 的其他原因碼原樣保留。使用者首次要逐步帶路但無路線時，先執行一次 planAccessibleRoute，再查指引。

文字的 routeContext、語音 route.context.set／ack、條件優先序與前端遷移見 [AI 路線一致性遷移文件](../FRONTEND_MIGRATION_AI_ROUTE_CONSISTENCY.md)。

### 4.5 `getA11yFacilityDetails` — 依 OSM id 取設施詳情

| 參數      | 型別   | 說明                                 |
| --------- | ------ | ------------------------------------ |
| `osmId` * | string | 單個或逗號分隔多個，如 `node/123456` |

**成功**：`{ "ok": true, "count": 0, "facilities": "SlimA11y[]" }`
**失敗**：

```jsonc
{ "ok": false, "error": "缺少 osmId 參數" }
{ "ok": false, "error": "找不到 osmId: … 的設施" }
{ "ok": false, "error": "設施詳情查詢失敗" }
```

### 4.6 `findNearbyParking` — 身障停車格

| 參數                     | 型別   | 說明                      |
| ------------------------ | ------ | ------------------------- |
| `query`                  | string | 地名（與 lat/lng 二擇一） |
| `latitude` / `longitude` | number | 搜尋中心                  |
| `radiusM`                | number | 預設 500                  |

**成功**：

```jsonc
{
  "ok": true,
  "query": "string|null",
  "searchLocation": { "lat": 0, "lng": 0 },
  "total": 0,
  "parkingSpots": "IDisabledParking[]",
}
```

**失敗**：`{ "ok": false, "error": "找不到地點…的座標" | "缺少位置資訊…" | "身障停車位查詢失敗" }`

---

## 5. 公車即時工具

全部支援 `city`（未填用 GPS 推斷）。縣市無法判斷時回 `{ ok:false, error:"無法判斷縣市…" }`；其餘失敗透傳 service 的 `{ ok:false, error, status: 400|404|500 }`。

### 5.1 `getBusRoute` — 路線方向與完整站序

| 參數          | 型別   | 說明             |
| ------------- | ------ | ---------------- |
| `routeName` * | string | 如「307」「紅2」 |
| `city`        | string | 未填用 GPS 推斷  |

**成功**（`BusRouteInfoResult`）：

```jsonc
{
  "ok": true,
  "routeName": "…",
  "city": "TaiwanCityEn",
  "source": "db|tdx",
  "operators": "string[]",
  "directions": [
    {
      "direction": 0,
      "directionLabel": "…",
      "from": "…",
      "to": "…",
      "stopCount": 0,
      "stops": [{ "seq": 0, "name": "…", "lat": 0, "lng": 0 }],
    },
  ],
}
```

### 5.2 `getBusRouteDetail` — 站點 + ETA + 班表（像公車 App）

參數同 `getBusRoute`。
**成功**（`BusRouteDetailResult`）：

```jsonc
{
  "ok": true,
  "routeName": "…",
  "city": "…",
  "operators": "string[]",
  "schedules": "BusScheduleByDirection[]", // 選填
  "directions": [
    {
      "direction": 0,
      "directionLabel": "…",
      "from": "…",
      "to": "…",
      "stopCount": 0,
      "stops": [
        {
          "seq": 0,
          "name": "…",
          "lat": 0,
          "lng": 0,
          "estimateMinutes": "number|null",
          "statusLabel": "…",
        },
      ],
    },
  ],
}
```

### 5.3 `getBusArrival` — 某站即時到站

| 參數                         | 型別   | 說明                  |
| ---------------------------- | ------ | --------------------- |
| `routeName` * / `stopName` * | string | 路線名 / 站牌名       |
| `city`                       | string | 未填用 GPS            |
| `direction`                  | number | 0=去程 1=返程，可省略 |

**成功**（`BusArrivalResult`）：

```jsonc
{
  "ok": true,
  "routeName": "…",
  "city": "…",
  "stopName": "…",
  "arrivals": [
    {
      "stopName": "…",
      "direction": 0,
      "directionLabel": "…",
      "estimateMinutes": "number|null",
      "statusLabel": "…",
    },
  ],
}
```

### 5.4 `getBusTimetable` — 首末班與發車時刻

參數同 `getBusRoute`。
**成功**（`BusTimetableResult`）：

```jsonc
{
  "ok": true,
  "routeName": "…",
  "city": "…",
  "schedules": [
    {
      "direction": 0,
      "directionLabel": "…",
      "first": "…",
      "last": "…",
      "frequencies": [
        {
          "start": "…",
          "end": "…",
          "minHeadwayMins": 0,
          "maxHeadwayMins": 0,
          "serviceDays": "…",
        },
      ],
    },
  ],
}
```

### 5.5 `trackBuses` — 在線車輛即時 GPS + 低底盤判定（不需車牌）

| 參數          | 型別   | 說明        |
| ------------- | ------ | ----------- |
| `routeName` * | string | 如「307」   |
| `city`        | string | 未填用 GPS  |
| `direction`   | number | 0/1，可省略 |

**成功**（`BusRealtimeOnRouteResult`）：

```jsonc
{
  "ok": true,
  "routeName": "…",
  "city": "…",
  "count": 0,
  "lowFloorCount": 0,
  "buses": [
    {
      "plateNumb": "…",
      "direction": 0,
      "directionLabel": "…",
      "lat": 0,
      "lng": 0,
      "speed": 0,
      "statusLabel": "…",
      "gpsTime": "…",
      "isLowFloor": "是|否|未知",
      "hasLiftOrRamp": "是|否|未知",
      "vehicleClass": "…",
    },
  ],
}
```

---

## 6. 環境 / 路況工具

支援地名或經緯度查詢（二擇一）。

### 6.1 `getEnvironmentInfo` — 天氣 + 空品 + CCTV 三合一

各區塊獨立降級：任一外部 API 失敗時該 block 為 `status:"unavailable"` + `reason`，整體仍 `ok:true`。

| 參數                     | 型別   | 說明                      |
| ------------------------ | ------ | ------------------------- |
| `query`                  | string | 地名（與 lat/lng 二擇一） |
| `latitude` / `longitude` | number | 查詢中心                  |
| `radius`                 | number | CCTV 範圍公尺，預設 1000  |

**成功**：

```jsonc
{
  "ok": true,
  "query": "string|null",
  "location": { "lat": 0, "lng": 0 },
  "weather": {
    "status": "ok|unavailable",
    "temperature": 0,
    "precipitationProbability": 0,
    "windSpeed": 0,
    "windDirection": "…",
    "condition": "…",
    "forecastTime": "…",
    "reason": "…",
  },
  "airQuality": {
    "status": "ok|unavailable",
    "pm25": 0,
    "quality": "…",
    "advice": "…",
    "area": "string|null",
    "stationCoordinates": "[lng,lat]|null",
    "reason": "…",
  },
  "nearbyCctv": {
    "status": "ok|unavailable",
    "cameras": [
      {
        "id": "…",
        "name": "…",
        "location": { "lat": 0, "lng": 0 },
        "distanceM": 0,
        "snapshotUrl": "string|null",
        "streamUrl": "string|null",
      },
    ],
    "reason": "…",
  },
}
```

**失敗**：`{ "ok": false, "error": "找不到地點「…」的座標" | "缺少位置資訊…" | "環境資訊查詢失敗" }`

### 6.2 `getAirQuality` — 僅 PM2.5

要天氣 / CCTV 用 `getEnvironmentInfo`。

| 參數                         | 型別   | 說明           |
| ---------------------------- | ------ | -------------- |
| `latitude` * / `longitude` * | number | 目標地區經緯度 |

**成功**：

```jsonc
{
  "ok": true,
  "city": "…",
  "area": "string|null",
  "pm25": 0,
  "quality": "良好|普通|對敏感族群不健康|不健康|非常不健康",
  "advice": "…",
  "coordinates": "[lng,lat]|undefined",
}
```

**失敗**：

```jsonc
{ "ok": false, "message": "此區域無空氣品質監測數據" }
{ "ok": false, "error": "空氣品質查詢失敗" }
```

### 6.3 `getNearbyHazards` — 附近即時路況危險回報

| 參數                     | 型別   | 說明                                       |
| ------------------------ | ------ | ------------------------------------------ |
| `query`                  | string | 地名（與 lat/lng 二擇一）                  |
| `latitude` / `longitude` | number | 查詢中心                                   |
| `radiusM`                | number | 預設 500，最大 5000                        |
| `hazardType`             | enum   | `obstacle\|construction\|data_error`，選填 |

**成功**：

```jsonc
{
  "ok": true,
  "data": {
    "reports": [
      {
        "_id": "…",
        "reporterId": "…",
        "reportedLocation": { "type": "Point", "coordinates": "[lng,lat]" },
        "hazardType": "obstacle|construction|data_error",
        "description": "…",
        "photoUrl": "…",
        "status": "…",
        "exifValidation": {
          "timestampFresh": false,
          "gpsPresent": false,
          "gpsMatchesClaimed": false,
        },
        "aiVerification": {
          "verdict": "…",
          "confidence": 0,
          "reason": "…",
          "prefilter": {},
          "attemptedAt": "…",
        },
        "confirmCount": 0,
        "denyCount": 0,
        "createdAt": "…",
        "updatedAt": "…",
        "expiredAt": "…",
      },
    ],
    "total": 0,
    "queryCenter": { "lat": 0, "lng": 0 },
    "radiusM": 0,
  },
}
```

**失敗**：`{ "ok": false, "error": "找不到地點…的座標" | "缺少位置資訊…" | "附近路況查詢失敗" }`

---

## 7. 知識 / 記憶工具

`saveMemory` 與 `deleteMemory` **僅在使用者登入時**才掛載到工具目錄。

### 7.1 `searchAccessibilityGuide` — 無障礙知識庫（RAG）

車站指南、輪椅 SOP、身障福利法規、營運商政策。一般知識性問題用此，比模型內建更準。

| 參數      | 型別   | 說明             |
| --------- | ------ | ---------------- |
| `query` * | string | 搜尋關鍵字或問題 |

**成功**：

```jsonc
{ "ok": true,
  "results": [ { "title": "…", "content": "…", "source": "…", "category": "…" } ] }
// 無結果：
{ "ok": true, "results": [], "message": "未找到相關指南" }
```

**失敗**：`{ "ok": false, "error": "搜尋關鍵字不能為空" | "知識庫查詢失敗" }`

### 7.2 `saveMemory` 🔒（限登入）

主動記住使用者資訊（行動模式 / 常去地點 / 偏好 / 近期計畫），不需使用者明說「記住」。

| 參數         | 型別   | 說明                                |
| ------------ | ------ | ----------------------------------- |
| `content` *  | string | 自然語言事實                        |
| `category` * | enum   | `preference\|place\|habit\|context` |

**成功**：`{ "ok": true, "memory": { "id": "…", "content": "…", "category": "…" } }`
**失敗**：`{ "ok": false, "error": "需要登入才能儲存記憶" | "記憶內容不能為空" | "無效的記憶類別：…" | "記憶儲存失敗" }`

### 7.3 `deleteMemory` 🔒（限登入）

刪除指定記憶。`memoryId` 從 system prompt 的【使用者記憶】區塊取得。

| 參數         | 型別   | 說明            |
| ------------ | ------ | --------------- |
| `memoryId` * | string | 要刪除的記憶 ID |

**成功**：`{ "ok": true, "deleted": true }`
**失敗**：`{ "ok": false, "error": "需要登入才能刪除記憶" | "缺少 memoryId" | "找不到該筆記憶或無權刪除" | "記憶刪除失敗" }`

---

## 8. 其他工具（摘要）

以下工具只列用途與必填參數；回傳形狀以 `src/modules/ai/agent-tools.ts`、`src/modules/line/` 的實作為準。

### 8.1 `openAiChatTools` 中未於上文詳述者

| 工具                            | 必填參數                             | 用途                                                    |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `findCampusAccessibility`       | —（校名、城市、設施類型或座標擇一）  | 教育部校園無障礙資料庫，回校區摘要與 `campusId`         |
| `getCampusAccessibilityDetails` | `campusId`                           | 單一校區完整無障礙設施清單                              |
| `getTrainTimetable`             | `originStation, destinationStation`  | 台鐵／高鐵兩站間直達班次（`departAfter` / `arriveBy`）  |
| `getStationTimetable`           | `station`                            | 單站接下來的發車看板                                    |
| `findNearbyBusStops`            | —（座標或目前位置）                  | 附近站牌與經過的真實路線，再接 `getBusArrival`          |
| `getMetroAlerts`                | —                                    | 捷運營運異常與電梯故障公告                              |
| `getTransitAlerts`              | `mode`                               | 公車／捷運／台鐵／高鐵通阻、改道、停駛警報              |
| `webSearch`                     | `query`                              | 公開網路搜尋，回 `answer` 與 `sources`                  |

### 8.2 `lineFamilyTools`（僅 LINE 家人 agent，`LINE_TOOL_ALLOWLIST`）

| 工具                       | 必填參數            | 用途                                          |
| -------------------------- | ------------------- | --------------------------------------------- |
| `bindEmergencyContactCode` | `code`              | 以 6 碼綁定碼完成緊急聯絡人綁定               |
| `bindLineAccountCode`      | `code`              | 以 6 碼綁定碼完成 app 帳號與 LINE 對應        |
| `getActiveSosContext`      | —                   | 所有綁定對象的進行中 SOS 與最近摘要           |
| `getSosLiveLocation`       | `sessionId`         | SOS 即時位置、地址、追蹤頁連結                |
| `planRouteToSosVictim`     | `sessionId`         | 從家人最近分享的位置規劃前往受困者的路線      |
| `findSosNearbyPlaces`      | `sessionId, query`  | 受困者附近一般地點                            |
| `findSosNearbyA11yPlaces`  | `sessionId, query`  | 受困者附近無障礙設施                          |
| `getSosEnvironmentInfo`    | `sessionId`         | 受困者位置的天氣、空品、周邊環境              |
| `confirmSosReceived`       | —                   | 確認已收到 SOS 通知                           |
| `claimSosEvent`            | —                   | 承接 SOS 事件                                 |
| `updateSosHandlingStatus`  | —（`status`）       | 更新處理進度（前往中／已抵達）                |
| `resolveSosEvent`          | —                   | 標記 SOS 已解除                               |

---

## 9. 速查表

🔒 = 僅登入掛載。`*` = required 參數。

| #   | 工具                       | required 參數         | 成功根欄位                                  |
| --- | -------------------------- | --------------------- | ------------------------------------------- |
| 1   | `findGooglePlaces`         | `query`               | `status`, `places`                          |
| 2   | `findA11yPlaces`           | `query`               | `ok`, `searchLocation`, `places{4類}`       |
| 3   | `planAccessibleRoute`      | `origin, destination` | `ok`, `routeContractVersion`, `planId`, `selectedRouteId`, `routes`                          |
| 4   | `getNavInstructions`       | 無；後端注入已選 token | `ok`, `instructions`, `totalSteps`          |
| 5   | `getA11yFacilityDetails`   | `osmId`               | `ok`, `count`, `facilities`                 |
| 6   | `findNearbyParking`        | query 或 lat/lng      | `ok`, `total`, `parkingSpots`               |
| 7   | `getBusRoute`              | `routeName`           | `ok`, `directions[].stops`                  |
| 8   | `getBusRouteDetail`        | `routeName`           | `ok`, `directions[].stops(含ETA)`           |
| 9   | `getBusArrival`            | `routeName, stopName` | `ok`, `arrivals`                            |
| 10  | `getBusTimetable`          | `routeName`           | `ok`, `schedules`                           |
| 11  | `trackBuses`               | `routeName`           | `ok`, `count`, `lowFloorCount`, `buses`     |
| 12  | `getEnvironmentInfo`       | query 或 lat/lng      | `ok`, `weather`, `airQuality`, `nearbyCctv` |
| 13  | `getAirQuality`            | `latitude, longitude` | `ok`, `pm25`, `quality`, `advice`           |
| 14  | `getNearbyHazards`         | query 或 lat/lng      | `ok`, `data.reports`                        |
| 15  | `searchAccessibilityGuide` | `query`               | `ok`, `results`                             |
| 16  | `saveMemory` 🔒            | `content, category`   | `ok`, `memory`                              |
| 17  | `deleteMemory` 🔒          | `memoryId`            | `ok`, `deleted`                             |

其餘 8 個 `openAiChatTools` 與 12 個 `lineFamilyTools` 見 §8。

---

## 維護指引

新增 / 刪改工具時，需同步更新三處：

1. `src/config/ai/tool.ts` — `openAiChatTools` / `memoryTools` / `lineFamilyTools` 宣告
2. `src/modules/ai/agent-tools.ts` — 實作與 `executeLocalTool` 的 `switch`
3. 本文件（`docs/specs/AI_AGENT_TOOLS_REFERENCE.md`）
