# 前端遷移說明：步行路線與逐步指引品質更新

**影響端點**：`POST /api/v1/a11y/accessible-route`、`POST /api/v1/a11y/route/instructions`  
**日期**：2026-08-03  
**性質**：既有欄位相容，新增欄位與指引文字會改變。

## 路線引擎分工

- 所有正常 WALK legs 均由 OTP 產生，包括純步行、walk + waypoints，以及汽／機車的頭尾與中途點步行銜接。
- Valhalla 只負責汽車與機車主體；僅在 OTP 步行規劃不可用時作為 pedestrian 停機備援。
- 發生備援時，該 route 會新增 `warnings[]`：
  `OTP 步行規劃暫時不可用，已降級使用 Valhalla 步行路線，指引品質可能不同`。
- walk + waypoints 會回傳一條 route、數個依序排列的 WALK legs；任一 OTP segment 真正無解時整條回 404，不會混搭 OTP／Valhalla segments。

## `/route/instructions` 請求

請提供 `routeToken` 或 `route` 其中之一。兩者同時提供時，後端優先讀取 `routeToken` 對應的伺服器端路線；原本傳完整 `route` 的流程仍可用。

```json
{
  "routeToken": "由 /accessible-route 回傳的 30 分鐘 capability",
  "userHeading": 45
}
```

token 過期或無效時回 400，`data.reason` 為 `INVALID_ROUTE_TOKEN`。

## 新增指引欄位

每筆 WALK route／step 新增：

| 欄位 | 型別 | 語意 |
|---|---|---|
| `routes[].degraded` | `boolean?` | 僅在 `avoidStairs` 生效且所有 OTP 候選仍含樓梯時為 `true`；此時回傳的是樓梯 feature 最少的候選，必須同步顯示 `warnings[]` |
| `routes[].legs[].steps[].stairs` | `boolean` | OTP `step.feature` 為 `StairsUse` 時為 `true`；Valhalla 備援固定為 `false`。只表示合併 step 內含樓梯，不代表整個 `distanceM` 都是樓梯 |

每筆 `instructions[]` 新增：

| 欄位 | 型別 | 語意 |
|---|---|---|
| `instructions[].stairs` | `boolean` | 該逐步指引對應的步行段含樓梯時為 `true`；非步行指引固定為 `false`。只代表該段含樓梯，不代表整個 `distanceM` 都是樓梯 |
| `legIndex` | `number` | 此指引來源在 `route.legs` 中的索引；`polylineIndex` 必須搭配它才能找到正確 polyline |
| `cumulativeDistanceM` | `number` | 抵達此 maneuver 起點前已累積的可量測行進距離，可作進度顯示 |

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
