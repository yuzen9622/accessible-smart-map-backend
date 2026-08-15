# 營運通阻「使用者運具 × alert scope」匹配規格

> 本文件是 TDX 營運通阻（Alert）資料接入與「精準顯示使用者所搭運具之通阻」的**單一事實來源**。
> 四種運具的 payload schema 均以 TDX 官方 OpenAPI 核實；Bus 另以 MQTT 實測 payload 驗證（2026-08-15）。
> 改動前先讀 `[[tdx-quota-and-data-drift]]`（資料漂移原則對 alert 一樣適用）。

## 0. Ground truth：四種 alert 的實際 payload

MQTT 與 REST 回傳內容**完全一致**（TDX 官方文件明示）；收到的是該資料項的**最小單位**，
例如訂閱 `v2/Bus/Alert/City/{City}` 收到 `Alert[]`、訂閱 `v3/Rail/TRA/Alert` 收到 `{AuthorityCode, Alerts:[...]}`。

### 0.1 Bus（`v2|v3/Bus/Alert/City/{City}`、`v2/Bus/Alert/InterCity`）

> 已於 2026-08-15 用 MQTT 實測證實（新竹城隍祭改道 alert）。

```jsonc
[{
  "AlertID": "34265", "Title": "…", "Description": "…", "Department": "新竹市政府交通處",
  "Status": 2,                 // 0=全停 / 1=正常 / 2=異常
  "Cause": 11, "Effect": 254,  // Cause/Effect 為 TDX enum（事故/施工/改道/班次異動…）
  "Scope": {
    "Operators": [{ "OperatorID": "13", "OperatorName": { "Zh_tw": "新竹客運", "En": "…" } }],
    "Stops":     [{ "StopID": "291265", "StopName": { "Zh_tw": "東門市場", "En": "…" }, "StationID": "130108" }],
    "Routes":    [{ "RouteID": "0100", "RouteName": { "Zh_tw": "總站→成德高中", "En": "…" }, "Direction": 0 }],
    "SubRoutes": [{ "SubRouteID": "…", "SubRouteName": { "Zh_tw": "…" }, "Direction": 0 }],
    "Stations":  [{ "StationID": "…", "StationName": { "Zh_tw": "…" } }],
    "Trips":     [{ "TripID": "…", "RouteID": "…", "SubRouteID": "…", "Direction": 0, "TripDepTime": "07:00" }]
  },
  "PublishTime": "…", "StartTime": "…", "EndTime": "…", "UpdateTime": "…"
}]
```

⚠️ **實測關鍵發現**：`Scope.Routes[].RouteName` 是**終點站名**（`"總站→成德高中"`），**不是路線號碼**。
路線號碼（「20路」）只出現在 `Description` 自由文字裡，**不可作為匹配鍵**。詳見 §2.1。

### 0.2 Metro（`v2/Rail/Metro/Alert/{系統}`）

```jsonc
{
  "AlertID": "…", "Title": "…", "Description": "…", "Status": 2,
  "Scope": {
    "Stations":     [{ "StationID": "R10", "StationName": { "Zh_tw": "中山站" } }],
    "Lines":        [{ "LineID": "R", "LineName": { "Zh_tw": "淡水信義線" } }],
    "LineSections": [{ "LineID": "R", "StartingStationID": "R10", "EndingStationID": "R16", … }],
    "Routes": [], "Trains": []
  },
  "Direction": 0, "StartTime": "…", "EndTime": "…", "UpdateTime": "…"
}
```

⚠️ **未決**：現有 `metro.service.ts` 把 `Scope.Stations`/`Scope.Lines` 當 `string[]` 讀，
但 OpenAPI 說它們是物件陣列 `[{StationID,StationName}]`。兩形狀矛盾，**尚未取得 live Metro Alert 樣本定案**
（2026-08-15 MQTT 監聽窗口內 Metro/TRA/THSR 均無異動）。取得樣本前，`alert.service.ts` 的 metro 匹配
需同時兼容兩種形狀（見 §2.2），定案後收斂。

### 0.3 TRA（`v3/Rail/TRA/Alert`）

```jsonc
{
  "AlertID": "…", "Title": "…", "Description": "…", "Status": 2,
  "Scope": {
    "Stations":     [{ "StationID": "1000", "StationName": "臺北" }],
    "Lines":        [{ "LineID": "…", "LineName": "…" }],
    "Trains":       [{ "TrainNo": "123" }],          // ← 有車次，可精準到「這班車」
    "LineSections": [{ "LineID": "…", "StartingStationID": "1000", "EndingStationID": "1020", … }],
    "Routes": [], "NetworkList": []
  },
  "Direction": 0,   // 0=南下 / 1=北上 / 2=雙向
  "Level": 2, "StartTime": "…", "EndTime": "…", "UpdateTime": "…"
}
```

### 0.4 THSR（`v2/Rail/THSR/AlertInfo`）

```jsonc
{
  "AlertID": "…", "Title": "…", "Description": "…", "Status": "X",  // ''=正常 / '▲'=異常 / 'X'=全停
  "Scope": { "LineSections": [{ "LineID": "…", "StartingStationID": "…", "EndingStationID": "…" }] },
  "Direction": 0,   // 0=南下 / 1=北上 / 2=雙向
  "Level": 2, "StartTime": "…", "EndTime": "…", "UpdateTime": "…"
}
```

⚠️ **THSR alert 沒有 TrainNo 欄位** → 無法精準到「某班高鐵」，只能匹配到「路線區間 + 方向」。

---

## 1. 匹配輸入：`TransitContext`

匹配只吃「前端/既有服務**現在就能提供**」的欄位，不需新增資料來源。

```ts
type TransitContext =
  | { mode: "bus";   city: string; routeName: string;   // routeName = 路線號碼，如 "307"
      direction?: number; stopUid?: string; stopName?: string }
  | { mode: "metro"; railSystem: string; lineCode?: string; stationIds?: string[] }
  | { mode: "tra";   trainNo?: string; lineId?: string; stationIds?: string[]; direction?: number }
  | { mode: "thsr";  lineId?: string; direction?: number; fromStationId?: string; toStationId?: string };
```

欄位來源（既有）：

- bus `routeName/direction` ← `getBusRouteInfo`；`stopUid/stopName` ← `BusStopModel` / `getBusRouteDetail`。
- metro `lineCode` ← `metroLineCode()`；`stationIds` ← 路徑腿。
- tra `trainNo` ← `recoverRailTrainNos()` / liveboard；`stationIds` ← OD timetable。

---

## 2. 匹配規則（`alert.service.ts` 純函式規格）

### 通用前置（每筆 alert 都先過）

```ts
const now = Date.now();
active(a) = (a.StartTime == null || now >= +new Date(a.StartTime))
         && (a.EndTime   == null || now <= +new Date(a.EndTime));
// 過濾「正常」：bus/metro/tra 丟 Status===1；thsr 丟 Status==='' 。
```

方向比對：`dirMatch(alertDir, ctxDir)` — `alertDir` 為 `255 / 2 / null / undefined` 時視為全方向，否則 `alertDir === ctxDir`。
站名/路線名正規化：複用 `src/utils/transit-text.ts` 的 `equalStopName`（臺/台、括號後綴正規化）。

### 2.1 Bus — **先查 BusRouteModel 拿 routeId/subRouteName，再用它們比 Scope**

> 修正動機（2026-08-15 實測）：alert 的 `Scope.Routes[].RouteName` 是終點站名（`"總站→成德高中"`），
> 不是使用者輸入的路線號碼。因此**匹配鍵不得是原始 `routeName`（如 "307"）**，必須先經
> `BusRouteModel` 解析成 alert 用的 `routeId`（內碼）與 `subRouteName`（終點站名）。

```ts
async function resolveBusRouteKeys(ctx): Promise<{
  routeIds: string[];        // ← 對 Scope.Routes[].RouteID
  subRouteNames: string[];   // ← 對 Scope.Routes[].RouteName（終點站名）
  stopIds: string[];         // ← 對 Scope.Stops[].StopID
} | null> {
  // 與 getBusRouteInfo 同源：by city + routeName.Zh_tw 查 BusRouteModel
  const docs = await BusRouteModel.find({
    city: ctx.city,
    "routeName.Zh_tw": formatRouteName(ctx.routeName),
  }).lean();
  if (!docs.length) return null;

  // 若帶 direction，先收斂到該方向；否則全方向都算候選
  const scoped = ctx.direction != null
    ? docs.filter(d => d.direction === ctx.direction)
    : docs;

  return {
    routeIds:      [...new Set(scoped.map(d => d.routeId).filter(Boolean))],
    subRouteNames: [...new Set(scoped.map(d => d.subRouteName?.Zh_tw).filter(Boolean))],
    stopIds:       ctx.stopUid ? [ctx.stopUid] : [],
  };
}

function matchBus(a: BusAlert, keys): Match | null {
  const S = a.Scope;
  const dirOk = (d) => dirMatch(d, ctx.direction);
  // 1. 路線層級（主）：RouteID 精確比對，或 RouteName(終點站名) 正規化比對
  if (S.Routes?.some(r =>
        (keys.routeIds.includes(r.RouteID) || keys.subRouteNames.some(n => equalStopName(r.RouteName?.Zh_tw, n)))
        && dirOk(r.Direction))) return { kind: "route" };
  if (S.SubRoutes?.some(r =>
        keys.subRouteNames.some(n => equalStopName(r.SubRouteName?.Zh_tw, n)) && dirOk(r.Direction)))
    return { kind: "route" };
  // 2. 站牌層級（改道/站點異動只影響部分站）
  if (S.Stops?.some(s => keys.stopIds.includes(s.StopID) || equalStopName(s.StopName?.Zh_tw, ctx.stopName)))
    return { kind: "stop" };
  if (S.Stations?.some(s => keys.stopIds.includes(s.StationID))) return { kind: "station" };
  return null;
}
```

精度排序：`stop/station > route`（站點級異動對使用者最切身，前端用它排「最相關」優先）。

### 2.2 Metro — 任一命中即 match（同時兼容 §0.2 的形狀矛盾）

```ts
function matchMetro(a, ctx): Match | null {
  const S = a.Scope;
  const lineHit   = (l) => typeof l === "string" ? l === ctx.lineCode : l.LineID === ctx.lineCode;
  const stationHit = (s) => typeof s === "string" ? ctx.stationIds?.includes(s)
                                                  : ctx.stationIds?.includes(s.StationID);
  if (S.Lines?.some(lineHit))       return { kind: "line" };
  if (S.Stations?.some(stationHit)) return { kind: "station" };
  return null;   // LineSections OD 覆蓋為進階，v1 不做
}
```

### 2.3 TRA — TrainNo 是金標準

```ts
function matchTra(a, ctx): Match | null {
  if (!dirMatch(a.Direction, ctx.direction)) return null;
  const S = a.Scope;
  if (ctx.trainNo && S.Trains?.some(t => t.TrainNo === ctx.trainNo)) return { kind: "train" }; // 最精準
  if (ctx.lineId && S.Lines?.some(l => l.LineID === ctx.lineId))       return { kind: "line" };
  if (S.Stations?.some(s => ctx.stationIds?.includes(s.StationID)))     return { kind: "station" };
  if (S.LineSections?.some(ls => covers(ls, ctx.stationIds)))           return { kind: "section" };
  return null;
}
```

### 2.4 THSR — 只能到區間 + 方向

```ts
function matchThsr(a, ctx): Match | null {
  if (!dirMatch(a.Direction, ctx.direction)) return null;
  if (a.Scope.LineSections?.some(ls => covers(ls, [ctx.fromStationId, ctx.toStationId])))
    return { kind: "section" };
  return null;   // 無 TrainNo，注定無法更精準
}
```

---

## 3. REST endpoint 規格（對齊 `transit.router.ts` 的 query 風格）

掛在 `createTransitRouter()`，全部 `GET` + `validateRequest` + `sendResponse`，`?mode=` 分流
（同 `/a11y/parking/nearby?type=` 的既有做法）：

```
GET /api/v1/transit/alerts?mode=bus&city=Taipei&routeName=307&direction=0&stopName=…
GET /api/v1/transit/alerts?mode=metro&railSystem=TRTC&line=R&stationIds=R10,R16
GET /api/v1/transit/alerts?mode=tra&trainNo=123&direction=0&stationIds=1000,1020
GET /api/v1/transit/alerts?mode=thsr&direction=0&fromStationId=…&toStationId=…
```

回應統一 envelope（`sendResponse`），`data` 形狀：

```ts
{
  mode: "bus",
  matchedAt: "ISO",            // 快照時間
  alerts: [{
    alertId, title, description, status, cause?, effect?, level?, reason?,
    matchKind: "route"|"stop"|"train"|"station"|"line"|"section",
    startTime, endTime, alertUrl?
  }]
}
```

`alerts` 依 `matchKind` 精度降冪排序。schema 放 `transit.schema.ts`，
`AlertQuerySchema` 用 discriminated union（`mode` → 對應欄位必填），`.strict()`。

## 3.1 WebSocket 即時推播（`alert.gateway.ts`）

Path：`/api/v1/transit/alerts/ws`

client → server：

```jsonc
{ "type": "subscribe", "ctx": { /* TransitContext，同 §1 */ } }
{ "type": "unsubscribe" }
```

一條連線同時只保留一個 `ctx`（再送 `subscribe` 即覆蓋）。無法 parse 或未知 `type` 一律忽略，不回錯誤、不關連線。

server → client：

```jsonc
{ "type": "alerts", "result": { /* TransitAlertResult，同 §3 */ } }
```

推播時機：

1. 收到 `subscribe` 時立即推一次（走 `getTransitAlerts`，store 未命中則 REST 兜底）。
2. `alert.store` 快照更新（MQTT 推播或 REST 兜底回填）且 key 與該連線的 `ctx` 相關時再推。
   相關性：bus → `bus:city:{city}`（`city=InterCity` 對 `bus:intercity`）、metro → `metro:{railSystem}`、tra → `tra`、thsr → `thsr`。

連線關閉即自動退訂。

---

## 4. 前端處理建議

1. **別讓前端自己算匹配**：前端只送 `TransitContext`，匹配與精度排序全在 `alert.service.ts`；
   前端拿到 `matchKind` 直接渲染。
2. **「這班車」的來源是前端已知狀態，不是 alert 給的**：
   - 公車：使用者選了路線（甚至已上車）→ 送 `routeName/direction/stopName`；
   - 臺鐵：送 `trainNo`（唯一能精準到班次的運具）；
   - 高鐵：**誠實告知** alert 只有區間+方向，做不到「你搭的這班」。
3. **渲染階層**（對應 `matchKind`）：
   - `train`/`stop`/`station` 級 → 直接標在「我的班次/該站」卡片，紅色警示；
   - `route`/`line` 級 → 路線頁 banner「本線目前有異常」；
   - `section` 級 → 標在該區間的地圖點位上。
4. **即時性取捨**：Phase 1 前端 30–60s 輪詢（後端讀快照，便宜）；真正即時等 Phase 3 接 WS。
   **不要為了「即時」先上 MQTT + WS** —— matching 的正確性與資料源無關，先把 REST 版跑對。

---

## 5. 已知 blocker / 風險

1. **REST credentials 失效**：`.env` 的 `TDX_CLIENT_ID` 打 OAuth token 端點回 `invalid_client`
   （2026-08-15 實測）。注意 `TDX_CLIENT_ID` 值形如 `s1111131...`（像**帳號**而非 ClientId），
   而 MQTT 用的 `TDX_MQTT_CLIENT_ID` 形如 `70d88dde...`（ClientId 格式）卻能成功連線 ——
   代表 **MQTT 的 username/password 與 REST OAuth 的 client_id/secret 是不同憑證組**。
   Phase 1 的 REST 兜底需先換對 REST ClientId 才能打通。
2. **Metro `Scope.Stations/Lines` 形狀矛盾**（§0.2）：未取得 live 樣本前，§2.2 必須兼容兩種形狀。
3. **Bus `RouteID ≠ RouteUID`、`RouteName` = 終點站名**：匹配鍵一律來自 `BusRouteModel.routeId` /
   `subRouteName`（§2.1），不得用使用者輸入的號碼或 `subRouteUid` 直接比。
4. **THSR 無 TrainNo**：產品面降級為「區間+方向」提示（§2.4）。
5. **MQTT 授權模型**：同一組 ClientId 只能一條連線（第二條踢第一條）；水平擴充需多組金鑰或單 worker ingestion。
6. **MQTT 剛開放（2026/5）**：官方明示初期資料即時性/穩定性未定、暫不納入點數；必須 REST 兜底 + 啟動 bootstrap。
