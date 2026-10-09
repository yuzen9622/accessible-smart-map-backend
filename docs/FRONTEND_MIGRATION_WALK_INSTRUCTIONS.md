# 前端遷移說明：步行路線與逐步指引品質更新

**影響端點**：`POST /api/v1/a11y/accessible-route`、`POST /api/v1/a11y/route/instructions`  
**日期**：2026-08-03  
**性質**：既有欄位相容，新增欄位與指引文字會改變。

## 路線引擎分工

> 2026-10-05 校正：本節原寫「所有正常 WALK legs 均由 OTP 產生」，已不符現況。

- 純步行（`travelMode: "walk"`）：起訖點在台北 CSR bbox 內且功能啟用時，由自建 CSR 無障礙行人圖選路（`routingSource: "pedestrian-a11y"`）；CSR 無法選路、bbox 外或停用時改走 OTP2。
- 大眾運輸 itinerary 內的 WALK legs，以及汽／機車的頭尾與中途點步行銜接，仍由 OTP2 產生。
- Valhalla 負責汽車與機車主體；只在 OTP2 步行規劃不可用時作為 pedestrian 停機備援。備援不再附固定的 `warnings[]` 文字，前端不要依賴特定字串判斷。
- walk + waypoints 會回傳一條 route、數個依序排列的 WALK legs；任一 OTP segment 真正無解時整條回 404，不會混搭 OTP／Valhalla segments。

## `/route/instructions` 請求

**只接受 `routeToken`**（必填）。後端已不再接受前端回傳完整 `route`；request body 為 strict schema，多帶 `route` 欄位會回 400。

```json
{
  "routeToken": "由 /accessible-route 回傳的 30 分鐘 capability",
  "userHeading": 45,
  "language": "en"
}
```

token 過期或無效時回 400，`data.reason` 為 `INVALID_ROUTE_TOKEN`。

### 2026-10-09：英文導航

`language` 接受 `"zh-TW"` 或 `"en"`；省略時維持繁體中文，其他值回 400。
英文請求會產生英文 `message`、`instructions[].text` 與 `relativeDirection`，涵蓋步行、
汽機車、大眾運輸、設施、樓梯／陡坡提醒及抵達提示。前端 TTS 應選擇相同語言。

提供 `userHeading` 時，英文相對方向值為 `ahead`、`ahead-right`、`right`、
`behind-right`、`behind`、`behind-left`、`left`、`ahead-left`；未提供 heading
或該步驟無 bearing 時仍為 `null`。不要將這些值與 WALK `leg.steps[].relativeDirection`
的 `DEPART`／`LEFT` 等機器 token 混用。語言切換不改變步數、距離、索引與 bearing；警告代碼維持原有值域。
英文車行若缺少可辨識的 maneuver，會提供概略指引並附上 `ROAD_STEPS_UNAVAILABLE`。

`POST /api/v1/a11y/accessible-route/reroute` 也接受 `language: "en"`，會產生英文
`instructions[].text`、`steps[].instruction` 與回應訊息。每次重新規劃請傳入目前語言；
同一個 `clientRequestId` 重送仍回放第一次完成的結果，不會因變更語言而重新產生文案。
需要切換既有路線語言時，以目前 `routeToken` 再呼叫 `/route/instructions`。

路名、站名、路線名及列車車種名稱保留路線資料原文，不呼叫翻譯服務，也不保證這些專有名稱
都有英文。後端產生的「起點／終點／中途點」通用標籤會改為英文。
`accessible-route` 的路線摘要、評分與原始 leg 資料不屬於此文案契約；WebSocket 語音會話
仍沿用原有語言設定。本次更新未新增 `lang` 別名或 `Accept-Language` 自動選擇。

## 新增指引欄位

每筆 WALK route／step 新增：

| 欄位                             | 型別       | 語意                                                                                                                                  |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `routes[].degraded`              | `boolean?` | 僅在 `avoidStairs` 生效且所有 OTP 候選仍含樓梯時為 `true`；此時回傳的是樓梯 feature 最少的候選，必須同步顯示 `warnings[]`             |
| `routes[].legs[].steps[].stairs` | `boolean`  | OTP `step.feature` 為 `StairsUse` 時為 `true`；Valhalla 備援固定為 `false`。只表示合併 step 內含樓梯，不代表整個 `distanceM` 都是樓梯 |

每筆 `instructions[]` 新增：

| 欄位                    | 型別      | 語意                                                                                                                 |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `instructions[].stairs` | `boolean` | 該逐步指引對應的步行段含樓梯時為 `true`；非步行指引固定為 `false`。只代表該段含樓梯，不代表整個 `distanceM` 都是樓梯 |
| `legIndex`              | `number`  | 此指引來源在 `route.legs` 中的索引；`polylineIndex` 必須搭配它才能找到正確 polyline                                  |
| `cumulativeDistanceM`   | `number`  | 抵達此 maneuver 起點前已累積的可量測行進距離，可作進度顯示                                                           |

`distanceM` 的語意固定為：**完成本步 maneuver 後，到下一步之前要行進的距離**。不要顯示成「走 `distanceM` 公尺後再做本步轉彎」。

## 文字與步數變更

- `text` 已包含友善距離，可直接送 TTS，例如：`向右轉進入「民族西路」，續行約 1.0 公里`。
- 無名路段會提示下一個具名目標，例如：`直行約 190 公尺至「民族西路」`。
- 大於 300 公尺的單一步行 step 會依 polyline 插入中間提示，因此 `totalSteps` 可能增加。
- 後續 WALK leg 的 `DEPART` 會改為一般轉向／續行，不再於 waypoint 中途播報「出發」。
- bearing 改由 maneuver 後約 20 公尺的 polyline 幾何計算，不再只有 45 度倍數。
- 樓梯 step 的文字只會提示「此路段含樓梯」，不會把合併 step 的整段 `distanceM` 描述成樓梯距離。

## 前端必要調整

1. 地圖定位指引點時使用 `route.legs[instruction.legIndex].polyline[instruction.polylineIndex]`。
2. 進度條改讀 `cumulativeDistanceM`，不要自行把跨 leg 的 `polylineIndex` 當全域索引。
3. TTS 直接朗讀 `text`，不要再於前端重複加距離。
4. UI 若收到 route `warnings[]`，須顯示引擎降級或樓梯條件未完全滿足的風險。
5. 若有 snapshot，更新對 `text`、bearing 與 `totalSteps` 的預期。
