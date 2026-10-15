# 室內場域（校園）無障礙路線

場域＝一個校園／車站等多棟多樓層空間。資料在 JOSM 以 OpenStreetMap Simple Indoor Tagging 加少數 `a11ymap:*` 標籤繪製，匯入後提供建築、樓層、地點、室內幾何與跨樓層無障礙路線。HTTP 欄位定義以 OpenAPI（`/api/v1/openapi.json`，tag `Venue`）為準。

## 端點

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/a11y/venues` | 已匯入場域摘要 |
| GET | `/api/v1/a11y/venues/{venueId}` | 建築外框、樓層（`elevationM`）、地點 `places`、顯示用幾何 `features`，以及樓梯／階梯／坡道／手扶梯／電梯 `connections`（各點 `[lng, lat, z]` 與樓層，坡道附最大坡度） |
| POST | `/api/v1/a11y/venues/{venueId}/route` | `{ fromPlaceId, toPlaceId, mode?, language? }` → 路徑與步驟 |

- **地點 id**：教室等為 `a11ymap:id`；跨多層重複的地點為 `${id}@${levelRef}`（例 `a-room06@3F`）；每棟每層的樓層錨點為 `${buildingId}@${levelRef}`（「到中科大樓 3F」＝ `zk@3F`）。「建築＋樓層」請由前端從 `places` 換成錨點 id。
- **`mode`**（預設 `wheelchair`），伺服器依模式決定成本，不接受自訂 profile：
  - `wheelchair`：不走樓梯／階梯／手扶梯，坡度 > 12%、寬度 < 0.9 m、`wheelchair=no` 不可通行。沒標 `width` 的路以可通過計算（與戶外步行路網相同）；坡道沒標寬度時匯入會警告。
  - `elderly`、`visual_impaired`：偏好電梯，但沒有電梯可達時仍會走樓梯（樓梯成本 × `VENUE_STAIRS_AVOIDANCE_MULTIPLIER`，預設 4）。
  - `normal`：最短路線。
- **回應**：`path.coordinates` 為 `[lng, lat, z]`，`z` 是該點高度（公尺，相對場域基準）：平面上的點是樓板高度，樓梯／坡道中間點可能是內插值；`path.levelRefs`、`segments[]` 與 `steps[].pathStart/pathEnd` 對應同一索引。`segments` 依建築與樓層切開路線（戶外段的 `buildingId`／`levelRef` 為 null），相鄰兩段共用交界索引，供前端逐層畫線、切換樓層。步驟類型 `depart / walk / enter / exit / elevator / escalator / stairs / steps / ramp / arrive`，`walk` 可帶 `maneuver: left | right | uturn`。
- **距離與時間**：`distanceM` 為步行距離（不含電梯）；`durationS` 依模式步速計算，電梯每趟以 `VENUE_ELEVATOR_WAIT_S` + 每層 `VENUE_ELEVATOR_PER_FLOOR_S` 計（一趟只等一次）。坡道步驟除非資料標 `a11ymap:height_status=measured`，否則文字會註明「未實測」。

| HTTP | 情況 |
| --- | --- |
| 200 | 路線 |
| 400 | 參數格式錯誤、帶了未知欄位（例如 `profile`）或未知 `mode` |
| 404 | 查無場域或地點 |
| 422 | `NO_ACCESSIBLE_ROUTE`：目的地可步行到達，但沒有符合所選模式限制的路線（輪椅遇到樓梯、手扶梯、過窄、過陡或 `wheelchair=no`），`data.venueAccessibility = { venueId, placeId, levelRef, stepFreeReachable: false }`；`NO_ROUTE`：路網未連通 |

## 從校外導到校內

既有 `POST /api/v1/a11y/accessible-route` 可用 `destinationVenuePlace: { venueId, placeId }` 取代 `destination`（需搭配 `origin`，不可同時給 `destination` 或 `query`）。

- 候選校門：`normal` 可用所有校門；其他模式只用標 `wheelchair=yes` 的校門（沒標視為不可用）。系統對每個候選校門算「校門 → 地點」的校內加權成本（含該模式的樓梯加權），加上起點到校門的直線距離，選總和最小的校門；戶外路線只規劃到該校門一次。這是啟發式，不是實際戶外最短路。
- 回應 `data.destination` 為校門，`data.venueArrival` 記錄校門與場域版本，`data.venueLeg` 為校內路線（同場域路線格式）。語音與 `nav-instructions` 只涵蓋戶外段。
- 使用者要求無階梯（`avoidStairs`）時，校內段一律採輪椅規則。
- 校內不可達時整個請求回 422（`NO_ACCESSIBLE_ROUTE` 附 `venueAccessibility`，或 `NO_ROUTE`），不會只導到校門；場域或地點不存在回 400 `VENUE_PLACE_NOT_FOUND`（此端點不回 404）。
- 重新規劃（reroute）固定使用原校門：校門仍在原位（≤ 1 m）就以目前場域版本重算 `venueLeg`，並把實際使用的版本寫回 token；校門被移除、移位或不再符合該模式（例如拿掉了 `wheelchair=yes`）、或目的地地點被移除，則回 410 `ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED`（訊息「場域資料已更新」），需重新規劃，不會自動換校門。

## 資料繪製規則（JOSM）

樓層用 OSM 序數：`level=0` 是 1F、`level=1` 是 2F、`level=-1` 是 B1。

| 物件 | 標籤 | 規則 |
| --- | --- | --- |
| 建築 | `building=*` `name` `a11ymap:id` `building:levels`（地上層數）`building:levels:underground`（地下層數，OSM 標準標籤） | 沒標 `a11ymap:id` 的建築不納入導航，匯入時列成警告；在它裡面畫室內走廊、樓梯、房間外框或室內地點（有 `level` 的）會匯入失敗，戶外步道與停車場點不受影響；標了 `a11ymap:id` 就必須有 `name`。外框可用 way 或 multipolygon relation（outer 被切成多段會自動接起來，但只能有一圈 outer）。`a11ymap:id` 只能小寫英數、`-`、`_`，最多 64 字，`@` 為保留字。可加 `a11ymap:floor_height`（預設 3.6）、`a11ymap:ground_offset`（1F 相對校園地面的高差，公尺） |
| 走廊 | `highway=corridor` `level` `width` | 相同格局的樓層用 `repeat_on=1;2;3` 只畫一次 |
| 戶外步道 | `highway=footway`（不標 `level`） | 與 1F 走廊**共用同一個節點**才算相通；不做幾何吸附 |
| 坡道 | `highway=footway` `incline=8%`（或 `up`／`down`／`yes`；沒有單位的數字視為百分比，`0` 或 `no` 是平地，最多 1000%；其他寫法匯入失敗）`width` `ramp:wheelchair=yes` `a11ymap:height_status` | 沒標 `ramp:wheelchair` 會警告；標 `no` 則輪椅不走。兩端節點標了不同的單一 `level` 就是跨樓層坡道；坡頂或中間點可用 `a11ymap:ele` 標高 |
| 樓梯 | `highway=steps` `step_count` | 兩端節點標了不同的單一 `level` 就是跨樓層樓梯（way 的 `level=0;1` 可省略，有標就要和兩端一致）；way 標多層但兩端沒標單一 `level` → 匯入失敗。中間的平台節點標自己的 `level` 才能與該層走廊相通；沒標 `level` 的中間節點不能和其他線共用。跨樓層的線不能用 `repeat_on`。`step_count` 要是正整數，沒標會警告 |
| 電梯 | 節點 `highway=elevator` `level=0;1;2;…` | 每個停靠層都要有該層的走廊（`highway=corridor`、單一 `level` 或 `repeat_on`）**經過這個節點**；只有步道、樓梯或多層 `level` 的線接到不算，某層沒接上就匯入失敗 |
| 出入口 | 節點在建築外框上 `entrance=*` `door=*` `wheelchair` `width` `level=0` | 有台階的門標 `wheelchair=no`，輪椅不會經過；`width`（淨寬，公尺）< 0.9 時輪椅也不會經過，其他模式不受影響 |
| 校門 | 節點 `barrier=gate` `entrance=main\|yes` `a11ymap:id` `name` `wheelchair` | 沒標 `entrance=main` 或 `yes` → 匯入失敗（校外路線可能導到這裡，不能是管制門）；輪椅、長者、視障模式只會從 `wheelchair=yes` 的校門進入 |
| 停車場 | 戶外步道上的節點 `amenity=parking` `a11ymap:id` `name` `capacity:disabled`（無障礙車位數） | 標在無障礙車位旁、接到步道的位置；`kind` 為 `parking`，可當路線起點（停好車 → 館內任一處）。停車場外框（building 或 area）只供顯示 |
| 地點 | 路網上的節點 `a11ymap:id` `name` `ref` `level` | 多門房間只把主要門標成地點；名稱可用 `{L}` 代入樓層號（`ref={L}06` → 3F 為 `306`）。`a11ymap:id` 標在房間外框等 way／relation 上 → 匯入失敗 |
| 樓層錨點 | 路網節點 `a11ymap:anchor=yes`（通常是電梯口） | 每棟每層一個；缺的樓層會警告，且無法用「建築＋樓層」（錨點 id）選為起訖，該層標了 `a11ymap:id` 的地點照常可用 |
| 房間外框 | 封閉 way `indoor=room/corridor/area` `level` | 只供 3D 顯示，牆由前端依外框生成；沒閉合會匯入失敗 |

可選來源標註（建築、房間、門、樓梯、坡道、連通道、電梯都可加）：`a11ymap:source`（照片檔名或掃描 ID，不放照片本身）、`a11ymap:geometry_status=surveyed|traced|schematic`（預設 traced）、`a11ymap:height_status=measured|drawing|estimated`（預設 estimated）。`GET` 回應中，`buildings` 帶 `source`、`geometryStatus`、`heightStatus`；`features` 帶 `source`、`geometryStatus`、`heightStatus`；`connections` 帶 `source`、`geometryStatus`、`heightStatus`（取該段最不確定者）。沒標 `a11ymap:floor_height` 的建築一律視為 `estimated`；數值坡度沒標 `a11ymap:height_status` 也是 `estimated`（指示不寫數字），照平面圖量的請標 `drawing`、現場量的標 `measured`。樓高需 0–20 m，`a11ymap:ground_offset` 與 `a11ymap:ele` 絕對值需 ≤ 1000 m；數值標籤只接受純數字（空白不會被當成 0）。數值坡度溢位（不是有限數字）會匯入失敗；房間外框、門標在建築沒有的樓層也會匯入失敗。坡度為 `estimated`（例如只標 `incline=up`、由兩端高度推算）時，指示只寫「坡度未實測」，不寫數字。

建築總樓層（地上＋地下）最多 200 層；`level` 範圍跨度最多 200（例 `0-200`），同一物件的 `level` 與 `repeat_on` 合計最多 201 個樓層，超過即匯入失敗。房間外框、門的 `level` 寫錯也會匯入失敗，不會被當成 1F。電梯沒標 `wheelchair` 視為可用，標 `limited` 時輪椅成本會加重。

## 匯入

```bash
pnpm import:venue -- --file data/venues/nutc-sanmin.osm --venue nutc-sanmin --name "國立臺中科技大學 三民校區" --dry-run
```

- 先完整編譯與驗證；任何錯誤都不寫入（`--venue` 也必須是小寫英數、`-`、`_`，與 API 路徑規則相同）。警告會列出「從校門走不到」或「輪椅無法抵達」的地點、缺錨點的樓層，以及離其他線不到 0.5 公尺卻沒共用節點的端點（多半是漏接），供補資料。
- 拿掉 `--dry-run` 後以單一文件覆寫該場域並遞增 `version`；API 依版本自動重建路網，不需重啟。
- `pnpm data:sync --with-snapshot` 會一併執行（步驟 `venue-nutc-sanmin`，預設同步不含）。

## 隱私

`.osm` 與原始平面圖照片是校園室內格局，**不提交到公開 repo**（`data/` 已被 gitignore），只在作者本機匯入資料庫。API 只提供顯示與路線需要的幾何。
