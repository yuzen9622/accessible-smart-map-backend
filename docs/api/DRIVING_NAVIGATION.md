# 車行導航資料與 App 相容性

無障礙智慧地圖的車行資料適用 `DRIVE` 與 `MOTORCYCLE`。正式欄位與型別以 `/api/v1/openapi.json` 為準；所有新增路線／導航欄位皆為 optional，加值資料缺失不影響基本導航。

## 路線與導航指引

- `route.roadNetwork` 綁定規劃時的 serving release；`sourcePbfSha256: null`／`provenance: unverified` 表示不能證明建置來源，不得解讀為資料已驗證。
- `leg.maneuvers` 保留 `beginStreetNames`、`bearingBefore/bearingAfter`、`signs`、`lanes` 與可信的 `laneApproachRange`。未知方位省略，不用 0 表示未知。
- `leg.steps[].maneuverIndex` 指向同 leg **原始** maneuvers 陣列，不能因過濾抵達步驟而重新編號。
- `POST /api/v1/a11y/route/instructions` 的指令新增 `roadGuidance`，透過外層 `legIndex/polylineIndex` 與內層 `endPolylineIndex` 對位。外層 `maneuver` 保持既有 WALK 契約，車行轉向 code 從 `roadGuidance.maneuver` 取得。
- 語音 `nav.start`／`nav.resume_ok`／`nav.route_replaced` 的步驟也保留 `polylineIndex` 與 `roadGuidance`，見 [語音協定](VOICE_WS_PROTOCOL.md)。

路牌的 `exitNumbers` 是文字（例如 `8A`），不要轉為整數；`branches` 不一定是國道編號。`destinations` 保留原始路牌全部內容，**不是已選定分支**，不要全部標成「本次前往」，也不要猜第一個就是目的地。

車道指引是下一個規劃轉向／出口的建議選道，不是定位車輛實際在第幾車道，也不依周邊車況指示即時切線。陣列由左至右；`preferred` 來自上游 active、`usable` 來自 valid，兩者都需可辨識，`not_recommended` 不等於法律禁止。

四車道右轉的合成示例（不是現役道路證據）：

| 由左至右 | directions | recommendation | 本次選道 |
|---|---|---|---|
| 1 | `["straight"]` | `not_recommended` | 不推薦 |
| 2 | `["straight"]` | `not_recommended` | 不推薦 |
| 3 | `["right"]` | `usable` | 可用 |
| 4 | `["right"]` | `preferred` | 優先 |

以有效 leg-local 路線進度及下一 maneuver 的 `laneApproachRange` 選用；範圍是轉向前同一 leg polyline 上的進場段：從轉向起點往回取到累計距離首次達到 300 公尺的頂點（頂點稀疏的長直線段可能更長），但不早於上一個 maneuver，`toIndex` 對應轉向起點。上游車道資料只掛在路口前最後一條路段，台北實測中位數僅約 15 公尺，所以後端把範圍往前延伸，讓駕駛有時間換車道；範圍前段的實際車道數可能和示意圖不同，示意的是「該靠哪一側」。通過路口或離開範圍即清除。

`roadGuidance.laneHint` 是同一組 lanes 推導的建議文字（例如「靠右側兩個車道」、「走左邊數來第二車道」），語言依請求；同一句也已接在該步驟 `text`（以及路線 `steps[].instruction`）後面，例如「向右轉進入「民生東路」，請靠右側兩個車道」。取用 `preferred` 車道，沒有 preferred 才用 `usable`；全部車道都可用或沒有建議車道時省略。App 播報轉彎前提醒時沿用含車道建議的步驟文字，不另外推測車道。缺 lanes／range 不畫假圖，保留一般轉向；不得僅憑右轉或車道數生成箭頭。圖示需文字／讀屏標籤，不能只靠顏色。

## 速限分段，不是每個步驟一個數字

`leg.speedLimits` 以原始 `leg.polyline` 的頂點索引分段。座標為 `[經度, 緯度]`，N 個頂點有 N−1 個線段。`[fromIndex,toIndex)` 包含起點線段、不含終點線段；例如 `0→7` 包含線段 0 至 6，恰在頂點 7 時使用下一段。

| 狀態 | App 處理 |
|---|---|
| 欄位省略 | 舊資料或舊伺服器；維持基本導航，不補速限 |
| `status: unavailable` | 本次屬性擷取無法信任；不保留上一個數字 |
| `available`＋`kind: unknown` | 已對齊，但這段沒有可用法定速限；顯示未知或隱藏 |
| `available`＋`kind: known` | `limitKph` 為有限正數；以有效路線進度選用為該路線目前段速限 |
| `available`＋`kind: unlimited` | 不是 0 或 255；有效路線進度落在該段時顯示「資料標示不限速」，不做超速判斷 |

分段完整覆蓋原始 polyline，未知區間不能用上一段填補。相同 maneuver 也可能是 40→未知→50→未知。`source: osm_directional` 代表同來源方向規則，不是由 routing speed、平均速度或距離／時間估計。

## 語音助理

App 導航引擎在車行 leg 上把目前路段速限放進 `nav.state.speedLimit`（`{ kind: "known", limitKph }` 或 `{ kind: "unlimited" | "unknown", limitKph: null }`；非車行或無有效進度時省略），速限改變時重送 `nav.state`。轉彎前的 `nav.cue` 沿用含車道建議的步驟文字。助理回答「這段限速多少」「要走哪個車道」只依這兩者，見 [語音協定](VOICE_WS_PROTOCOL.md)。

## 選定路線的進度與版本

後端提供選定導航路線的分段速限與建議選道，**不需要也不提供 `/api/v1/a11y/route/match`**。不以實際道路 `matched`、私有 RoadMatchingData 或候選搜尋完整性作為公開指引的顯示前提；本功能不宣稱辨識實際道路或車道。

App 消費既有 route metadata：確認選定 `routeToken/navigationId/routeVersion`，以有效 `legIndex/segmentIndex` 查 speedLimits 半開區間，再用下一 maneuver 及 incoming range 選用 lanes。GPS 可協助沿選定路線估計進度，偏到鄰路不替換為鄰路資料。方向依規劃路線，不用指南針或停車時 GPS course 決定；停止或旋轉手機本身不清除仍有效的路線選道。voice step index 不是速限分段索引。

無有效、足夠新鮮且未越界的路線進度時，不宣稱目前段。新導航、重規劃、候選／routeVersion 變更先清舊進度與指引，丟棄過時版本的回應；恢復時驗證路線身分及進度有效性。到達終點或進入 WALK／室內 leg 清除車行指引，unknown 不沿用上一段。

`roadNetwork` 與 source 是規劃時的 route 快照；candidate／圖資切換形成新 route 時清舊進度／指引，不能將新 source 拼進舊 route，也不要求每次 GPS 與現役引擎同版才可讀不可變 metadata。`provenance=verified` 只證明來源鏈。OSM 方向覆寫仍須同來源版本與可靠 way 方向，不能由手機朝向猜測；native 公開資料不要求全路線私有方向覆蓋。

以上是 App 整合契約，不是新 HTTP API；後端提供 metadata 不代表客戶端已具備分段顯示與進度對位能力。整合時仍需驗證實際圖資來源、路線進度與裝置顯示，不能以合成四車道案例代替實際道路與裝置驗證。

## 新舊版本相容

1. **舊 App＋新後端**：忽略未知 optional 欄位，沿用原文字導航；若 App 使用 strict JSON decoder，需先允許新增欄位。
2. **新 App＋舊後端／舊快取**：缺 metadata 就降級，不解析 instruction 猜出口，不生成車道或填入速限。沒有 `maneuverIndex` 時保留既有基本導航流程。
3. **新 App＋新後端**：保留原始 leg polyline、陣列索引與整份 route；繪圖可另做簡化，但不要用簡化／跨 leg 合併後索引查 metadata。語音 DTO 與 REST route 不可只挑舊欄位而丟資料。
4. **部署順序**：先部署 additive 後端並驗證，之後再更新 App。來源未驗證的舊 release 不會套方向覆寫；圖資與 App 改版不能代替真 candidate／serving 與裝置端驗收。

`routeToken` 的既有 30 分鐘 TTL、JWT 流程、WALK maneuver、選路車種策略不變。此功能不承諾某機車種類可合法通行所有上游規劃路段，也不提供超速警報。
