# 室內場域（校園）無障礙路線

場域＝一個校園／車站等多棟多樓層空間。資料在 JOSM 以 OpenStreetMap Simple Indoor Tagging 加少數 `a11ymap:*` 標籤繪製，匯入後提供建築、樓層、地點、室內幾何與跨樓層無障礙路線。HTTP 欄位定義以 OpenAPI（`/api/v1/openapi.json`，tag `Venue`）為準。

## 端點

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/a11y/venues` | 已匯入場域摘要 |
| GET | `/api/v1/a11y/venues/{venueId}` | 建築外框、樓層（`elevationM`）、地點 `places`、顯示用幾何 `features`、來源牆線 `walls`，一般平走路網 `walkways`，以及樓梯／階梯／坡道／手扶梯／電梯 `connections`（各點 `[lng, lat, z]` 與樓層，坡道附最大坡度） |
| POST | `/api/v1/a11y/venues/{venueId}/route` | `{ fromPlaceId, toPlaceId, mode?, language? }` → 路徑與步驟 |

- **地點 id**：教室等為 `a11ymap:id`；跨多層重複的地點為 `${id}@${levelRef}`（例 `a-room06@3F`）；每棟每層的樓層錨點為 `${buildingId}@${levelRef}`（「到中科大樓 3F」＝ `zk@3F`）。「建築＋樓層」請由前端從 `places` 換成錨點 id。
- **空間到達點與多入口**：室內路線仍由後端 route API 計算。來源可明確對應的空間會提供 `places[].featureId`；沒有原本場所的顯示空間可由編譯器產生穩定的到達場所，請直接使用 detail 回傳的 `places[].id`，不要把 feature ID 當成 place ID。`arrivalNodeIds` 存在時，為同棟、同層的真實候選路網節點（最多 16 個，包含主要 `nodeId`）；後端依本次通行模式選擇可走且成本最低的入口。`place.location` 為主要到達點，實際路線端點以回應 `path` 為準，前端不得強迫吸附回主要點。沒有此欄位的舊場所沿用單一 `nodeId`。
- **設施入口來源**：共享核心、梯間與井道只從既有來源 connection 的同層 landing、唯一幾何包含與已相接的同層普通走道建立目的地。多入口不會新增走道或電梯停靠；井道圖形位於某層不代表電梯在該層服務。其他空間可由來源 `a11ymap:arrival_node` 明確指定既有走廊到達點。來源不明者保留未綁定，不採最近點補接。
- **發布版本**：以 `venueId + version` 識別與快取同一批圖資；`sourceSha256` 是原始 OSM 的 SHA-256（舊文件無來源時為 null），不包含發布建築清單，不能單獨作為發布版本。
- **校園顯示**：`walkways` 每筆是一條一般平走邊，`coordinates` 是兩個 `[lng, lat, z]` 端點，並有逐點的 `buildingIds`／`levelRefs`；兩端同棟／同層時另提供共同的 `buildingId`／`levelRef`，其餘為 null。樓梯、階梯、手扶梯、電梯與坡道另在 `connections`，不要重複繪製。`walkways` 是顯示路網，完整行程仍由 route API 計算。
- **圖形用途與設施**：`features[].tags` 只保留來源 `indoor`、`amenity`、`a11ymap:area_type`、`ref`，`osmRef` 指向來源物件。`kind` 沿用原值；`amenity=toilets` 是廁所，`vertical-core` 是共享核心，不能整塊改作 `elevator-shaft`。保留所有原始 polygon rings、洞與共用頂點，不縮放房間、灌滿建築外框或複製缺資料樓層。
- **設施關聯與入口側**：feature 的 `connectionIds` 與 connection 的 `featureIds` 是反向關聯；唯一可識別時另有 `connectionId`，未知或歧義保留 null／空陣列。關聯採來源節點、同建築的設施幾何包含或唯一來源房號（地點對圖形），不依名稱或最近距離推定。`connections[].name/ref` 保留來源，未知為 null。`connections[].nodeIds` 與 `coordinates/levelRefs` 同長同序，`walkways[].nodeIds` 與兩端座標同序，均為 compiled source node ID。前端可用它們連接平走入口側，但不能推定已量測門寬或替代 route API。井道圖形出現在某層不等於該層有電梯停靠，實際搭乘只看 connection 停靠點；不從導航中心線猜井道尺寸或替共享核心創造分區。
- **來源牆線**：`walls` 為來源 `indoor=wall` 的逐層 `LineString`，保留原始頂點順序、`osmRef` 與可信度註記；`thicknessM` 未知為 null，前端示意厚度不能當成實測。原線應保留，不由缺門標記猜開口或補門。房間外框共牆仍可由前端去重。
- **到達點**：`places[].featureId` 只在來源可唯一對應時提供；`arrivalKind=door/corridor/place` 與 `doorKnown` 描述導航點。`corridor`／`doorKnown=false` 只表示走廊到達點不是已知門位，不代表附近沒有實體門。未知為 null 或省略；不能由 `kind=room` 宣稱抵達房門，不能解析 `note/fixme` 代替結構化欄位。
- **樓層資料**：`buildings[].levels[].coverage` 的 `hasAnchor` 表示該層有可選樓層錨點；`hasRouteData` 表示該層有路網邊；`hasDisplayGeometry` 表示該層有顯示圖形。三者只描述資料存在，均不表示已完整描繪、現場核實或輪椅可達。選擇目的地以實際 `places` 為準，可達性以 route 結果為準。
- **待核實資訊**：建築、features、walls、walkways 與 connections 保留 `heightPending`、`note`、`fixme`。`heightPending=true` 代表高度待確認，不能依估計 z 生成實測樓梯；`note`／`fixme` 可能包含電梯停靠表等通行資訊尚待現場核實的條件，不能只用 `heightStatus` 取代這些條件。
- **`mode`**（預設 `wheelchair`），伺服器依模式決定成本，不接受自訂 profile：
  - `wheelchair`：不走樓梯／階梯／手扶梯，坡度 > 12%、寬度 < 0.9 m、`wheelchair=no` 不可通行。沒標 `width` 的路以可通過計算（與戶外步行路網相同）；坡道沒標寬度時匯入會警告。
  - `elderly`、`visual_impaired`：禁止樓梯／階梯／手扶梯，跨層需有可通行電梯或坡道；找不到時回 `NO_ACCESSIBLE_ROUTE`，不降級走樓梯。兩者保留各自步速與其他通行限制，不換成輪椅模式。舊 `VENUE_STAIRS_AVOIDANCE_MULTIPLIER` 仍接受設定以相容既有環境，但不會解除此禁行規則。
  - `normal`：最短路線。
- **回應**：`path.coordinates` 為 `[lng, lat, z]`，`z` 是該點高度（公尺，相對場域基準）：平面上的點是樓板高度，樓梯／坡道中間點可能是內插值；`path.levelRefs`、`segments[]` 與 `steps[].pathStart/pathEnd` 對應同一索引。`segments` 依建築與樓層切開路線（戶外段的 `buildingId`／`levelRef` 為 null），相鄰兩段共用交界索引，供前端逐層畫線、切換樓層。步驟類型 `depart / walk / enter / exit / elevator / escalator / stairs / steps / ramp / arrive`，`walk` 可帶 `maneuver: left | right | uturn`。索引範圍兩端均包含；零長度 `enter/exit` 可在跨棟邊的前一點觸發，step 的建築是指令目標，與該點實際建築可能不同。顯示歸屬以 `path.buildingIds/levelRefs` 逐點資料為準，不以 step 覆寫。
- **路線設施與未知高度**：設施步驟的 `connectionId` 與 detail ID 相同；只有坡度推導、沒有可識別來源設施的坡道可為 null。`heightPending` 保留來源待確認旗標，即使該坡道兩端暫時都是 z=0，仍不能當作已確認平地；未標旗標也不等於現場核實。
- **距離與時間**：`distanceM` 為步行距離（不含電梯）；`durationS` 依模式步速計算，電梯每趟以 `VENUE_ELEVATOR_WAIT_S` + 每層 `VENUE_ELEVATOR_PER_FLOOR_S` 計（一趟只等一次）。坡道步驟除非資料標 `a11ymap:height_status=measured`，否則文字會註明「未實測」。

| HTTP | 情況 |
| --- | --- |
| 200 | 路線 |
| 400 | 參數格式錯誤、帶了未知欄位（例如 `profile`）或未知 `mode` |
| 404 | 查無場域或地點 |
| 422 | `NO_ACCESSIBLE_ROUTE`：目的地可步行到達，但沒有符合所選模式限制的路線（輪椅遇到樓梯、手扶梯、過窄、過陡或 `wheelchair=no`），`data.venueAccessibility = { venueId, placeId, levelRef, stepFreeReachable: false }`；`NO_ROUTE`：路網未連通 |

## 從校外導到校內

既有 `POST /api/v1/a11y/accessible-route` 可用 `destinationVenuePlace: { venueId, placeId }` 取代 `destination`（需搭配 `origin`，不可同時給 `destination` 或 `query`）。

- 候選校門：`normal` 可用所有校門；其他模式只用標 `wheelchair=yes` 的校門（沒標視為不可用）。系統對每個候選校門算「校門 → 地點」的符合該模式限制的校內加權成本，加上起點到校門的直線距離，選總和最小的校門；戶外路線只規劃到該校門一次。這是啟發式，不是實際戶外最短路。
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
| 房間外框 | 封閉 way 或 multipolygon `indoor=room/corridor/area` `level` | 只供 3D 顯示，所有 rings 原樣保留；牆可由前端依外框處理；沒閉合會匯入失敗 |
| 空間走廊到達點 | 房間／區域的 way 或 relation 加 `a11ymap:arrival_node=<來源 node id>` | 指向已有同層普通走道邊的來源節點；編譯後須為相同建物與樓層，否則拒絕匯入。只描述空間的走廊到達位置，不會新增物理連線、確認門位或將無停靠井道改成電梯停靠點。到達場所由編譯器建立，不能把 `a11ymap:id` 放在面圖上代替路網點 |
| 來源牆線 | way `indoor=wall` `level` | 開放或封閉來源線均保留為 `walls[].geometry`，不補門、井道或牆厚；樓層與發布建築規則同樣適用 |

可選來源標註（建築、房間、門、樓梯、坡道、連通道、電梯都可加）：`a11ymap:source`（照片檔名或掃描 ID，不放照片本身）、`a11ymap:geometry_status=surveyed|traced|schematic`（預設 traced）、`a11ymap:height_status=measured|drawing|estimated`（預設 estimated）。`GET` 回應中，`buildings` 帶 `source`、`geometryStatus`、`heightStatus`；`features` 帶 `source`、`geometryStatus`、`heightStatus`；`connections` 帶 `source`、`geometryStatus`、`heightStatus`（取該段最不確定者）。沒標 `a11ymap:floor_height` 的建築一律視為 `estimated`；數值坡度沒標 `a11ymap:height_status` 也是 `estimated`（指示不寫數字），照平面圖量的請標 `drawing`、現場量的標 `measured`。樓高需 0–20 m，`a11ymap:ground_offset` 與 `a11ymap:ele` 絕對值需 ≤ 1000 m；數值標籤只接受純數字（空白不會被當成 0）。數值坡度溢位（不是有限數字）會匯入失敗；房間外框、門標在建築沒有的樓層也會匯入失敗。坡度為 `estimated`（例如只標 `incline=up`、由兩端高度推算）時，指示只寫「坡度未實測」，不寫數字。

建築總樓層（地上＋地下）最多 200 層；`level` 範圍跨度最多 200（例 `0-200`），同一物件的 `level` 與 `repeat_on` 合計最多 201 個樓層，超過即匯入失敗。房間外框、門的 `level` 寫錯也會匯入失敗，不會被當成 1F。電梯沒標 `wheelchair` 視為可用，標 `limited` 時輪椅成本會加重。

## 匯入

```bash
pnpm import:venue -- --file data/venues/nutc-sanmin.osm --venue nutc-sanmin --name "國立臺中科技大學 三民校區" --buildings info,zk,changming,hanying --dry-run
```

- `nutc-sanmin` 預設只發布 `info`、`zk`、`changming`、`hanying` 四棟；一般場域預設完整來源。`--buildings id-a,id-b` 可明確指定發布範圍；空白、重複、無效或來源不存在的 id 會失敗。`--all-buildings` 明確要求完整來源驗證，不能與 `--buildings` 同用。
- 範圍外建築及其室內地點、路網、顯示圖形不會發布；外框仍留在原始 OSM。排除在樓層數等內部驗證前生效，但無法辨識排除建築的外框時仍拒絕發布，避免將未完成建築誤當戶外捷徑。跨棟連通道、校門與未穿過排除建築的校園步道保留，不刪改來源檔案。
- 先完整編譯與驗證；任何錯誤都不寫入（`--venue` 也必須是小寫英數、`-`、`_`，與 API 路徑規則相同）。警告會列出「從校門走不到」或「輪椅無法抵達」的地點、缺錨點的樓層，以及離其他線不到 0.5 公尺卻沒共用節點的端點（多半是漏接），供補資料。
- 拿掉 `--dry-run` 後以單一文件覆寫該場域並遞增 `version`；API 依版本自動重建路網，不需重啟。
- 新的 tags、關聯、到達點與牆線由來源編譯保存。舊文件缺少這些資料時維持未知／省略，`walls` 回空陣列；需重新匯入才能補齊，API 不讀私有 OSM sidecar 補資料。原始檔 SHA 相同也仍需使用新的數值版本，不能把不同發布內容視為同一版。
- `pnpm data:sync --with-snapshot` 會一併執行（步驟 `venue-nutc-sanmin`，使用相同四棟預設，預設同步不含）。

## 隱私

`.osm` 與原始平面圖照片是校園室內格局，**不提交到公開 repo**（`data/` 已被 gitignore），只在作者本機匯入資料庫。API 只提供顯示與路線需要的幾何。
