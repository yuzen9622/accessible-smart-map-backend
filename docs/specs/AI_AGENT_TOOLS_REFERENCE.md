# AI 助理工具與 Tool Result 格式參考（現況 / as-built）

**端點**：`POST /api/v1/ai/chat`
**狀態**：Active — 反映 repo 現行實作
**日期**：2026-06-30
**SDK**：原生 `@google/genai`（非 OpenAI SDK；工具仍以 OpenAI function schema 定義並原樣轉給 Gemini）

> 本文件描述「目前程式碼實際掛載的工具與回傳形狀」。歷史設計文件見
> [`AI_AGENT_STREAMING_SPEC.md`](./AI_AGENT_STREAMING_SPEC.md)（v1.1，6-tool 舊設計，已過時）。

**來源檔**：

- `src/config/ai/tool.ts` — `openAiChatTools`(15) + `memoryTools`(2) 宣告
- `src/modules/ai/agent-tools.ts` — 各工具實作與回傳 JSON、`executeLocalTool`
- `src/modules/ai/ai-chat.service.ts` — `runToolLoop` / `isSuccessResult` / `toGeminiHistory` / 結果包裝
- `src/modules/ai/ai.chat.controller.ts` — SSE 事件 `sendSse`、`SYSTEM_PROMPT`、非串流回應
- `src/modules/ai/ai.schema.ts` — `AgentChatRequestSchema`
- 底層 service 回傳形狀：各模組 `*.types.ts` 與 `src/types/index.d.ts`

---

## 0. 概覽

- **工具目錄**：`buildGeminiTools()` = `openAiChatTools`（15 個）＋（**僅登入時**）`memoryTools`（2 個）。共 **17 個**。
- **回傳**：每個工具一律回傳 **JSON 字串**（`executeLocalTool` → `JSON.stringify(...)`）。tool loop 會 `JSON.parse` 後包成 Gemini 的 `functionResponse: { name, response }`；若解析非物件則包成 `{ result: <值> }`。
- ⚠️ **死碼提醒**：`tool.ts` 的 `findGooglePlacesDeclaration / findA11yPlacesDeclaration / planRouteDeclaration`（舊版 `planRoute`、range 預設 200、travelMode）只被 `config.ts` 的 `agentConfig` 引用，而 `agentConfig` 全專案無人 import → 已是死碼。`contents.ts` 內提到 `planRoute` 的 prompt 同屬此舊路徑，**不在本文件範圍**。

### 回傳信封慣例

| 類型         | 形狀                                                            | 適用工具                     |
| ------------ | --------------------------------------------------------------- | ---------------------------- |
| 成功（主流） | `{ ok: true, … }`                                               | 除 `findGooglePlaces` 外全部 |
| 成功（特例） | `{ status: "OK" \| "ZERO_RESULTS", places }`                    | **僅** `findGooglePlaces`    |
| 失敗         | `{ ok: false, error }` / `{ ok: false, message }` / `{ error }` | 全部                         |
| 公車失敗     | `{ ok: false, error, status: 400\|404\|500 }`（透傳 service）   | 5 個公車工具                 |

- **成功/失敗判定**（`isSuccessResult`）：解析後只要 `parsed.error` 為真 **或** `parsed.ok === false` 視為失敗。
- **快取**（`stableCacheKey`）：同名同參只快取「成功」結果。注意 `findGooglePlaces` 的 `ZERO_RESULTS`（無 `error`、無 `ok:false`）會被當成功而快取。

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
}
```

### stream: true — SSE（`text/event-stream`）

| event         | data                     | 時機                                  |
| ------------- | ------------------------ | ------------------------------------- |
| `tool_call`   | `{ name, args }`         | 某工具開始執行                        |
| `tool_result` | `{ name, result }`       | 該工具解析後結果（＝本文件各 result） |
| `token`       | `{ text }`               | 最終回答逐塊串流                      |
| `done`        | `done`                   | 結束                                  |
| `error`       | `{ code: 500, message }` | 例外（其後仍補 `done`）               |

> 工具事件（`tool_call` / `tool_result`）會在「最終回答串流」**之前**全部送完：tool-loop 跑完才開始 stream 文字。

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
| 最大輪數 | `MAX_ROUNDS = 5`；某輪無 functionCall 即跳出                                                                |
| 呼叫模式 | `FunctionCallingConfigMode.AUTO`，`temperature: 0`                                                          |
| 歷程保留 | 每輪把模型的 `functionCall` 與我方 `functionResponse` 原樣 push 回 `contents`（保留 thought signature）     |
| 結果包裝 | 工具回傳 JSON 字串 → `JSON.parse` → `functionResponse: { name, response }`；非物件則包成 `{ result: <值> }` |
| 收尾     | 迴圈結束後再做一次「無工具」completion 產生最終文字                                                         |

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

// planAccessibleRoute 的 leg union（summarizeLeg 精簡後）
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

### 4.3 `planAccessibleRoute` — 無障礙混合交通「路線摘要」

要逐步指引改用 `getNavInstructions`。內部走 `planAccessibleRouteFromRequest`（與 HTTP 端點同源），`maxTransfers: 2`，結果經 `summarizeRoute` 精簡並只取前 3 條。

| 參數            | 型別   | 說明                                                          |
| --------------- | ------ | ------------------------------------------------------------- |
| `origin` *      | string | 完整照抄地名；目前位置填 `current_location`                   |
| `destination` * | string | 完整照抄地名                                                  |
| `mode`          | enum   | `wheelchair\|elderly\|visual_impaired\|normal`，預設 `normal` |
| `departureTime` | string | ISO8601 或 HH:mm，省略=現在                                   |

**成功**：

```jsonc
{
  "ok": true,
  "origin": { "name": "…", "lat": 0, "lng": 0 },
  "destination": { "name": "…", "lat": 0, "lng": 0 },
  "city": "…",
  "mode": "…",
  "routes": [
    {
      // 最多 3 條
      "routeName": "…",
      "totalMinutes": 0,
      "transferCount": 0,
      "accessibilityScore": "number|null",
      "accessibilityLabel": "string|null",
      "departureDate": "string|null",
      "accessibilityHighlights": "string[]",
      "legs": "Leg[]", // WALK | BUS | METRO | THSR | TRA（見型別字典）
    },
  ],
}
```

**失敗**：`{ "ok": false, "error": "…" }`（需要位置 / 規劃失敗）

### 4.4 `getNavInstructions` — 逐步導航指引

| 參數                         | 型別   | 說明                                          |
| ---------------------------- | ------ | --------------------------------------------- |
| `origin` * / `destination` * | string | 完整照抄；目前位置填 `current_location`       |
| `mode`                       | enum   | 同上，預設 `normal`                           |
| `departureTime`              | string | ISO8601 或 HH:mm                              |
| `routeIndex`                 | number | 第幾條路線（0-based），預設 0                 |
| `userHeading`                | number | 朝向（度，正北=0 順時針），有值才產生相對方向 |

**成功**：

```jsonc
{
  "ok": true,
  "routeName": "…",
  "totalMinutes": 0,
  "instructions": [
    {
      "text": "…",
      "type": "turn|transit_board|transit_alight|facility|depart|arrive",
      "bearing": "number|null",
      "relativeDirection": "正前方|左前方|右前方|左側|右側|左後方|右後方|正後方|null",
      "distanceM": "number|null",
      "streetName": "string|null",
      "legType": "WALK|BUS|METRO|THSR|TRA",
      "polylineIndex": "number|null",
    },
  ],
  "totalSteps": 0,
  "initialBearing": 0,
  "warnings": "string[]",
}
```

**失敗**：`{ "ok": false, "error": "…" }`（含規劃失敗、`ORS_STEPS_UNAVAILABLE` / `INVALID_ROUTE_INPUT` / `UNSUPPORTED_LEG_TYPE`）

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

## 8. 速查表

🔒 = 僅登入掛載。`*` = required 參數。

| #   | 工具                       | required 參數         | 成功根欄位                                  |
| --- | -------------------------- | --------------------- | ------------------------------------------- |
| 1   | `findGooglePlaces`         | `query`               | `status`, `places`                          |
| 2   | `findA11yPlaces`           | `query`               | `ok`, `searchLocation`, `places{4類}`       |
| 3   | `planAccessibleRoute`      | `origin, destination` | `ok`, `routes[≤3]`                          |
| 4   | `getNavInstructions`       | `origin, destination` | `ok`, `instructions`, `totalSteps`          |
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

---

## 維護指引

新增 / 刪改工具時，需同步更新三處：

1. `src/config/ai/tool.ts` — `openAiChatTools` / `memoryTools` 宣告
2. `src/modules/ai/agent-tools.ts` — 實作與 `executeLocalTool` 的 `switch`
3. 本文件（`docs/specs/AI_AGENT_TOOLS_REFERENCE.md`）
