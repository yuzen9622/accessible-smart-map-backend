# 前端遷移說明：`avoidStairs` / `requireElevator` 硬性無障礙條件

**影響端點**：`POST /api/v1/a11y/accessible-route`
**日期**：2026-07-31
**性質**：純新增（additive）。兩個欄位都 optional，不送＝行為與今天完全一致，前端可分批上。

---

## 變更摘要

`mode` 這個四值 enum 只調整**評分權重**（誰加分、轉乘懲罰多重），它不是「條件」。
新增的兩個布林值才是**硬性條件（hard constraint）**，會決定一條路線有沒有資格被回傳：

| 欄位 | 型別 | 效果 |
|---|---|---|
| `avoidStairs` | `boolean?` | 向路徑引擎（OTP2）索取 step-free 路線 —— OTP 在 wheelchair 模式下不會把 `highway=steps` 排進路徑，所以這是**引擎層**的效果 |
| `requireElevator` | `boolean?` | 排除「該站有設施資料、但查不到電梯」或「電梯維修／故障／暫停」的捷運／台鐵／高鐵路段（**後處理層**，在設施 enrich 之後執行） |

兩者的作用層不同，這會影響你怎麼解讀結果：

- `avoidStairs` 是**請求引擎不要規劃出樓梯路徑**。生效與否取決於 OSM 的 `highway=steps` 標記是否完整。
  程式裡另有一道 walk leg 的樓梯排除當保險，但目前大眾運輸流程並不會填入步行段的
  `a11yFacilities`（所有 planner 都給空陣列），所以那道保險實際上不會觸發 —— 真正在做事的是引擎層。
- `requireElevator` 在 OTP 沒有對應參數（北捷 GTFS 目前沒有 pathways 資料），完全靠後處理排除，
  因此它只在設施 enrich 查到該站資料時才會生效。

兩者互相獨立：`avoidStairs` 管路面與室外步行段，`requireElevator` 管車站垂直動線。
只開一個是合法且有意義的組合。

## 預設值（不送時的行為）

未填的欄位會回退到 `mode` 的預設，回退規則就是舊的 tier-1 判定：

| `mode` | `avoidStairs` 預設 | `requireElevator` 預設 |
|---|---|---|
| `wheelchair` | `true` | `true` |
| `elderly` / `visual_impaired` / `normal` | `false` | `false` |

所以：

- 完全不送這兩個欄位 → 與改版前的回應完全相同。
- 明確送 `false` **會覆蓋** `mode` 預設。例如 `mode: "wheelchair"` + `avoidStairs: false`
  會關掉 step-free 路徑查詢——這是刻意的，前端的 A11y Profile 才是使用者意圖的真相來源。
- `undefined` 與 `false` 意義不同，請不要用 `?? false` 把沒選過的狀態壓成 `false`，
  那會關掉輪椅模式原本的保護。沒有值就整個欄位別送。

## 請求範例

「使用助行器」的 profile（會走 `mode: "elderly"` 但兩個條件都要開）：

```json
{
  "origin": { "latitude": 25.0418, "longitude": 121.5654 },
  "destination": { "latitude": 25.0330, "longitude": 121.5645 },
  "mode": "elderly",
  "avoidStairs": true,
  "requireElevator": true
}
```

## 邊界行為（請據此設計 UI）

1. **條件不會造成 404**。當**所有**候選路線都被條件排除時，後端仍回傳原始候選，
   而不是回 `NOT_FOUND` —— 有一條有風險的路線比沒有路線可用。
   這種情況下請依 `routes[].accessibilityScore` 的 `totalScore`、`label` 與 `warnings`
   提示風險，不要向使用者宣稱「已完全符合無階梯／有電梯」。
2. **缺資料不等於不可通行**。設施資料為空的車站／步行段一律**保留**（unknown ≠ inaccessible）。
   `requireElevator` 只在 enrich 查到該站設施資料時才排除；查不到就保留並讓
   `accessibilityScore.dataConfidence` 降為 `low`。所以在設施資料稀疏的區域，
   開了條件也可能看不出差異 —— 這是刻意的，不是 bug。
3. **`travelMode` 覆蓋範圍**：
   - `transit`：`avoidStairs` 走引擎層、`requireElevator` 走後處理排除，兩者都生效。
   - `walk`：`avoidStairs` 生效（傳給 OTP2 行人查詢）；`requireElevator` 無適用對象。
   - `drive` / `motorcycle`：兩者都不生效（Valhalla 車行路徑不涉及階梯／電梯），
     頭尾步行銜接段也尚未套用，屬已知限制。

## 自然語言查詢（`query`）的互動

走 `query` 解析的請求，`requireElevator` 的優先序為：

```
body.requireElevator  →  intent.preferences.preferElevator（AI 從語句解析，如「要有電梯」）  →  mode 預設
```

`avoidStairs` 沒有對應的 intent 欄位，僅有 `body` 與 `mode` 預設兩級。

## 前端必要調整

無強制項。要讓 A11y Profile 真正影響演算法，就在既有請求上加這兩個欄位；
其餘欄位、回應結構、`routeToken` 契約皆未改變。
