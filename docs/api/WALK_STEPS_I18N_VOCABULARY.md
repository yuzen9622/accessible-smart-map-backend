# 步行 `leg.steps` 對外契約與英文詞彙表（供前端 i18n）

適用於 `POST /api/v1/a11y/accessible-route` 所有 `type: "WALK"` leg 的
`steps`。`POST /api/v1/a11y/route/instructions` 是另一個導航端點，可透過 `language: "en"` 回傳
英文的 `instructions[].text`，省略時維持繁體中文，不會改變其回應形狀或文案責任。

---

## 一、設計原則

`leg.steps` 是純機器資料，不承載任何可直接顯示或朗讀的文案。前端必須以封閉 enum
和本文件的詞彙表自行完成 i18n；後端不提供相容欄位或 fallback 文案。

三個步行引擎（OTP、CSR `pedestrian-a11y`、Valhalla 步行備援）都經過同一個
merge 正規化流程，因此輸出的 key 集合與值域一致。正規化在
`planAccessibleRouteFromRequest()` 成功回傳前執行一次；HTTP wrapper 只附加
`routeToken`，不會再次 merge。AI agent 路徑與 HTTP 路徑取得的 `steps` 必須逐字相同。

---

## 二、文案與導航端點的邊界

畫面上的 `CONTINUE 文心南七路 · 260 m` 曾是前端讀取缺失欄位後，自行 fallback
印出的 `${relativeDirection} ${streetName}`；它不是 OTP 的英文文案。

現在 WALK step 不再有文案欄位。若前端需要完整的繁中或英文逐步導航文字，應呼叫
`POST /api/v1/a11y/route/instructions`；該端點在內部根據下列機器欄位產生
`instructions[].text`。設施類方向的中文文字由 `NAV_MSG` 提供，並保留既有措辭。

道路 `DriveStep.instruction`／`DriveStep.maneuver`、交通 leg，以及語音模組的內部
instruction 型別均不屬於本契約。

---

## 三、統一後的 WALK step 契約

每一筆 WALK step 恆定且只含下列九個必填欄位：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `relativeDirection` | 封閉 enum，見 §4.1 | 前端 i18n 的主要 key；未知上游值正規化為 `CONTINUE`。 |
| `absoluteDirection` | 英文八方位 enum 或 `null`，見 §4.2 | 無法觀測 bearing 時為 `null`。 |
| `streetName` | `string` | 可為空字串。 |
| `bogusName` | `boolean` | `true` 時路名不可信，前端不應顯示 `streetName`。 |
| `area` | `boolean` | 是否為廣場／開放區域穿越。 |
| `stairs` | `boolean` | 此步含樓梯；不代表整段 `distanceM` 都是樓梯。 |
| `steepSlope` | `boolean` | 三個引擎都必填；`false` 表示未觀測到符合警示門檻的陡坡，不能解讀為已確認平坦。 |
| `distanceM` | `number` | 此步距離（公尺）。 |
| `location` | `[number, number]` | 此步起點的 WGS84 `[lng, lat]`。 |

WALK step 明確移除 `instruction`、`maneuver`、`text`、`type`。這四個字若出現在
序列化後的 WALK step，即屬契約違反；其中道路 leg 的同名欄位不受影響。

這條禁令只針對 `route.legs[].steps[]`。逐步導航輸出
（`POST /a11y/route/instructions` 的 `instructions[].maneuver`、reroute 的
`instructions[].maneuver`、語音 WS 的 `steps[].maneuver`）另有 `maneuver` 欄位：
步行步驟填入本表 4.1 的 `relativeDirection` token，其他指引為 `null`。後端不會把長直線
切成多個進度點，同一條路的直行只有一步；行進中「再直行 N 公尺」的定期提示由前端依剩餘
距離自行產生。它與指引上同名的 `relativeDirection`（依使用者朝向
計算的「正前方／右側…」）意義不同，前端判斷直行或轉向應以 `maneuver` 為準。

---

## 四、前端 i18n 詞彙表

### 4.1 `relativeDirection`

後端只會輸出下列 token：

| Token | 語意 |
| --- | --- |
| `DEPART` | 起步 |
| `CONTINUE` | 沿目前路線繼續前進 |
| `STRAIGHT` | 直行 |
| `LEFT` / `RIGHT` | 左轉／右轉 |
| `SLIGHTLY_LEFT` / `SLIGHTLY_RIGHT` | 稍向左／右轉 |
| `HARD_LEFT` / `HARD_RIGHT` | 大幅向左／右轉 |
| `UTURN_LEFT` / `UTURN_RIGHT` | 左／右迴轉 |
| `CIRCLE_CLOCKWISE` / `CIRCLE_COUNTERCLOCKWISE` | 順／逆時針圓環行進 |
| `ELEVATOR` | 電梯 |
| `ESCALATOR` | 手扶梯 |
| `MOVING_WALKWAY` | 電動步道 |
| `FARE_GATE` | 閘門 |
| `ENTER_STATION` / `EXIT_STATION` | 進入／離開車站或建築 |

CSR 的角度門檻為：`|Δ| < 20°` → `CONTINUE`；`< 45°` → `SLIGHTLY_*`；
`< 135°` → `LEFT`／`RIGHT`；其餘 → `HARD_*`。

### 4.2 `absoluteDirection`

`NORTH` | `NORTHEAST` | `EAST` | `SOUTHEAST` | `SOUTH` | `SOUTHWEST` |
`WEST` | `NORTHWEST` | `null`

這些都是英文機器 token；CSR 不會輸出「北」「東北」等中文字。前端可自行映射成任何語言。

### 4.3 組字責任

前端可依 `relativeDirection`、可信的 `streetName`、`distanceM`、`stairs` 與
`steepSlope` 組成符合產品語言的提示。不得假設後端另有 `text` 或 `type` 可用。
需要後端繁中或英文導航文案時，使用 `/route/instructions` 的 `instructions[]`，其中的
`type` 是 `NavInstructionType`，並非 WALK step 欄位。

---

## 五、驗收

1. OTP fixture 與 CSR fixture 產出的 `Object.keys(steps[0]).sort()` 必須逐字相同，且正好是 §3 的九欄。
2. WALK step 序列化後不得出現 `"instruction"`、`"maneuver"`、`"text"` 或 `"type"`。
3. `absoluteDirection` 僅可為 §4.2 的英文 token 或 `null`；CSR 案例必須明確證明不是中文字。
4. `relativeDirection` 僅可為 §4.1 token；例如 OTP `FOLLOW_SIGNS` 必須正規化成 `CONTINUE`。
5. 所有 step 必有布林 `steepSlope`，且 merge 後仍符合九欄契約。
6. 同一成功路線的 AI agent 路徑與 HTTP 路徑之 WALK `steps` 必須逐字相同。
7. `/route/instructions` 必須接受新的無文案 WALK steps，省略 language 時維持既有中文 `instructions[].text`，指定 `en` 時產生英文。語言切換不得改變 WALK steps 的機器欄位。

---

## 六、步行 step 之外，同一份回應裡其他需要 i18n 的英文 token

以下都逐一回查過程式碼定義（含欄位名稱本身），前端若要顯示這些值同樣需要字典。

| 位置 | 欄位 | 值域 | 定義處 |
| --- | --- | --- | --- |
| 請求 | `accessibilityMode` | `wheelchair` \| `elderly` \| `visual_impaired` \| `normal` | `src/types/route.ts:13` |
| 請求 | `travelMode` | `transit` \| `drive` \| `motorcycle` \| `walk` | `src/types/route.ts:20` |
| 純步行路線 | **`engine`**（不是 `walkEngine`） | `pedestrian-a11y` \| `otp-fallback` | `src/types/route.ts:27,353` |
| 每個 leg | `type` | `WALK` \| `DRIVE` \| `MOTORCYCLE` \| `BUS` \| `METRO` \| `THSR` \| `TRA` | `nav-instructions.types.ts:26-27` |
| WALK leg | `a11yFacilities[].`**`category`**（不是 `type`） | `wheelchair_accessible` \| `kerb_cut` \| `ramp` \| `elevator` \| `toilet` | `src/types/index.d.ts:267-274` |
| WALK leg | `a11yPoints[].type` | `curb_ramp` | `src/types/route.ts:141` |
| WALK leg | `exitInfo.type` | `elevator` \| `ramp` | `src/types/route.ts:187` |
| `/route/instructions` | `instructions[].type` | `depart` \| `turn` \| `facility` \| `transit_board` \| `transit_alight` \| `arrive`（步行只會出現前三個） | `nav-instructions.types.ts:18-24` |
| `/route/instructions` | `warnings[]` | `WALK_STEPS_UNAVAILABLE` \| `ORS_STEPS_UNAVAILABLE` \| `ROAD_STEPS_UNAVAILABLE` | `nav-instructions.types.ts:29-30` |

⚠️ 兩個容易寫錯的欄位名稱已在表中標注：純步行引擎欄位是 `engine`、無障礙設施分類欄位是
`category`——本文件早期版本兩者都寫錯過。

---

## 七、整份路線回應的語言與警示

### 請求語言

| 入口 | 欄位 | 說明 |
| --- | --- | --- |
| `POST /api/v1/a11y/accessible-route` | body `language` | 選填 `en` / `zh-TW`；省略維持既有文案。 |
| `POST /api/v1/a11y/accessible-route/reroute` | body `language` | 使用本次重規劃的語言；相同 `clientRequestId` 的重播仍回首次結果。 |
| `POST /api/v1/a11y/route/instructions` | body `language` | 預設 `zh-TW`；token 可沿用，語言只影響導航文字。 |
| `POST /api/v1/ai/chat` | body `language` | 沿用既有欄位，同時傳給地點搜尋、路線與指引工具；省略不改既有 AI 語言推論。 |
| 語音 WS `session.start` | frame `language` | 沿用既有欄位；`nav.setRoute` 不新增語言欄位。 |
| `GET /api/v1/a11y/search/autocomplete`、`/search/details/:id` | query `lang` | 沿用既有語言正規化；前端建議固定送 `en` / `zh-TW`。 |

不新增全域 `Accept-Language` 規則。語言不能改變路線 geometry、score、候選排序、
無障礙條件、station/route ID 或 WALK step 的九個機器欄位。英文指引仍可能包含中文路名：
來源沒有英文時保留原文，而不是猜譯。外部公告、使用者文字也不保證翻譯。路線的 `factors[].text`、`accessibilitySummary` 與
頂層 `slopeConstraint.note` 同樣依請求語言呈現；其分數、factor impact、requestedMaxPercent 與 enforced 不隨語言改變。

### 保留字串陣列，附加可選 details

路線保留原本的三個字串陣列，並可附加對應描述：

| 原欄位（仍應逐筆顯示） | 可選欄位 |
| --- | --- |
| `warnings` | `warningDetails` |
| `scoreWarnings` | `scoreWarningDetails` |
| `accessibilityHighlights` | `accessibilityHighlightDetails` |

reroute 另有 `data.warningDetails`，只對應合併後的 `data.warnings`；
`data.route.warningDetails` 仍只對應 `data.route.warnings`，兩者不可混用索引。

```ts
interface RouteMessageDetail {
  index: number; // 最終對應字串陣列的索引，不是 message ID
  code: string;
  params?: Record<string, string | number | boolean>;
  message: string; // 與 array[index] 相同的本次語言備援文字
}
```

例如同一個系統警示：

```json
{
  "scoreWarnings": ["Accessibility data along this route is limited; the score is conservative."],
  "scoreWarningDetails": [{
    "index": 0,
    "code": "ROUTE_DATA_SPARSE",
    "message": "Accessibility data along this route is limited; the score is conservative."
  }]
}
```

`zh-TW` 對應的字串與 `message` 為「沿途無障礙資料不足，分數為保守估計」，code 不變。
來源文字或舊 token 可能只有字串、沒有 details；**不可只渲染 details，否則會漏掉警示**。

前端建議：

```ts
const labels = warnings.map((raw, index) => {
  const matches = warningDetails?.filter(item => item.index === index);
  const detail = matches?.length === 1 && matches[0].message === raw
    ? matches[0]
    : undefined;
  // translateKnownCode：僅接受前端已支援的 code；未知回 undefined。
  return (detail && translateKnownCode(detail.code, detail.params)) ?? raw;
});
```

details 不是新的安全判斷來源；不要依文字或 code 自行改寫 accessibility 結論。
前端若只需要顯示後端已選語言的文案，直接顯示原陣列即可，不必維護完整同義字典。

警示樣式也不能再靠 `text.includes("請留意")` / `includes("無法")` 判斷，否則英文警示會被誤畫成綠色成功提示。
需要區分樣式時，使用已知 code 的呈現分類；未知或舊字串採中性顯示，不推定為已確認無障礙。
**發布前應先完成這項前端調整**：既有英文 Chat／Voice 已會帶語言，工具規劃傳遞語言後也會取得英文路線文案。
若 UI 會排序或截取亮點，**先用原始 index 組合字串與 detail，再排序整組**；排序後的陣列索引不能回頭匹配後端 detail。

### 系統訊息 code 與插值參數

以下列出目前路線文案的 code。params 為呈現用途，**不得拿來回送／覆寫路線條件或識別值**；
表中列的是組字所需參數，其他附加 scalar 可忽略。名稱參數仍可能是來源中文。

| code | params / 語意 |
| --- | --- |
| `ROUTE_DATA_SPARSE`, `ROUTE_LONG_WALK`, `ROUTE_MANY_TRANSFERS`, `ROUTE_ADVERSE_ENVIRONMENT` | 無；資料稀疏、長步行、多轉乘、環境不佳提示 |
| `ROUTE_TOILET_AVAILABLE` | `count` |
| `ROUTE_NO_ACCESSIBLE_TOILET`, `ROUTE_STAIRS_HANDRAIL_UNKNOWN` | 無；不可解讀為確定沒有廁所／扶手 |
| `ROUTE_SLOPE_CSR`, `ROUTE_SLOPE_NO_ELEVATION`, `ROUTE_SLOPE_SERVER_DEFAULT`, `ROUTE_SLOPE_WHEELCHAIR_DISABLED` | 無；坡度約束的執行限制 |
| `ROUTE_SLOPE_SERVER_LIMIT` | `serverMaxPercent` |
| `ROUTE_STAIRS_CONSTRAINT_UNSATISFIED` | 無；避開樓梯條件未完全滿足 |
| `ROUTE_HAZARD_DATA_UNAVAILABLE`, `ROUTE_HAZARD_ON_ROUTE`, `ROUTE_CLOSURE_BYPASS_FAILED`, `ROUTE_HAZARD_ALL_ROUTES_BLOCKED` | 無；障礙資料／路況安全提示 |
| `ROUTE_CSR_APPROXIMATE_INDOOR` | 無；室內路線圖形僅為近似 |
| `ROUTE_PARK_ENTRANCE_SELECTED` | `parkName`, `entranceName`, 可選 `widthM`, `slopePercent` |
| `ROUTE_PARK_NO_QUALIFYING_ENTRANCE` | 無；登記入口不符合條件 |
| `ROUTE_PARKING_ARRIVAL` | `name`, `distanceM` |
| `ROUTE_NEARBY_PARKING`, `ROUTE_NEARBY_ACCESS_FEATURES`, `ROUTE_WALK_NEARBY_FEATURES` | `count` |
| `ROUTE_BOARD_ELEVATOR_NEARBY`, `ROUTE_ALIGHT_ELEVATOR_NEARBY`, `ROUTE_BOARD_RAMP_NEARBY`, `ROUTE_ALIGHT_RAMP_NEARBY` | 無；乘／下車站周遭設施，不等於整段已驗證無障礙 |
| `ROUTE_ACCESSIBLE_TOILET_NEARBY`, `ROUTE_TACTILE_PAVING_NEARBY`, `ROUTE_AUDIO_SIGNAL_NEARBY`, `ROUTE_BOARD_FACILITIES`, `ROUTE_ALIGHT_FACILITIES` | 無；周遭設施提示 |
| `ROUTE_LOW_FLOOR_DIRECT`, `ROUTE_LOW_FLOOR_ALL`, `ROUTE_LOW_FLOOR_EVIDENCE` | 無；依後端既有證據表述，不另推定未確認車輛 |
| `ROUTE_HIGH_FLOOR_ALTERNATIVE` | `routeName`, `plateNumb`，可選 `etaMinutes`, `stopsAway`；首班高底盤、後續有低地板車 |
| `ROUTE_HIGH_FLOOR_NO_ALTERNATIVE` | `routeName`；未查到後續低地板班次 |
| `ROUTE_WALK_FROM_ORIGIN`, `ROUTE_WALK_TO_DESTINATION` | `distanceM` |
| `ROUTE_WALK_CONNECTOR_UNAVAILABLE` | `placeLabel`, `gapM`, `placeRole`；waypoint 另有 `waypointIndex` |
| `ROUTE_WALK_WAYPOINT_PARKING` | `placeLabel`, `distanceM`, `placeRole: "waypoint"`, `waypointIndex` |

`placeRole` 是 `origin` / `destination` / `waypoint`，`waypointIndex` 從 1 起算。
`placeLabel` 是後端依本次語言產生的「起點／Origin」等系統標籤；前端若重新翻譯快取文案，應以 role/index 產生標籤，不用中文字串比對。

### 快取、切換語言與重播

- 搜尋、導航文字與未啟用導航的路線預覽快取，須將有效語言納入 key。
- 切換語言後，取消／忽略舊語言的延遲回應，避免覆蓋新畫面；不要修改 canonical 名稱或 ID。
- 語音新連線於 `session.start` 傳送目前語言；沿用既有 token/恢復流程，不改寫 capability。
- 已啟用的導航不要只為翻譯而偷偷重規劃。可用同一 token 重新取得 `/route/instructions`；
  舊來源文字維持原文備援，路線本體與定位進度保留。
- 相同 `clientRequestId` 即使改送語言，也必須接受首次重規劃結果；不要把語言切換變成新的 reroute。
- Mobile「跟隨系統」先解析成有效的 `en` / `zh-TW` 再送請求；不要用帳號設定覆蓋本機的「跟隨系統」偏好。

---

## 八、可翻譯的錯誤資訊

HTTP envelope 的 `code` 仍是數字狀態碼；業務原因放在 `data.reason`。
前端優先用已知 reason 對應介面字典；未知 reason 或舊伺服器沒有 reason 時，保留 `message` 備援。
不要以比對中文句子來判斷失敗類型。常見 reason：

| 範圍 | reason |
| --- | --- |
| 路線引擎 | `OUT_OF_RANGE`, `OUT_OF_COVERAGE`, `NO_ACCESSIBLE_ROUTE`, `NO_ROUTE`, `UPSTREAM_TIMEOUT`（原狀態碼不變） |
| 路線輸入／解析 | `INTENT_PARSE_FAILED`, `CURRENT_LOCATION_REQUIRED`, `ROUTE_PARAMETERS_REQUIRED`, `COORDINATE_LOOKUP_FAILED`, `WAYPOINT_LOOKUP_FAILED`, `ROUTE_INTENT_UNAVAILABLE` |
| 路線非預期失敗 | `ROUTE_REQUEST_FAILED`, `ROUTE_PLANNING_FAILED` |
| reroute | `REROUTE_CONFLICT`, `NAVIGATION_STATE_UNAVAILABLE`, `ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED`, `REROUTE_PLANNING_FAILED`, `NAV_INSTRUCTIONS_UNAVAILABLE`, `REROUTE_FAILED`；亦可能保留路線引擎 reason |
| 導航 | `INVALID_ROUTE_TOKEN`, `NAV_INSTRUCTIONS_FAILED` |
| 地點搜尋 | `PLACE_NOT_FOUND`, `PLACE_SEARCH_FAILED` |

驗證失敗仍回 HTTP 400 與原本的 `path` / `message`，另附穩定 `code` / `params`：

```json
{
  "ok": false,
  "status": "error",
  "code": 400,
  "message": "Invalid request.",
  "data": {
    "reason": "VALIDATION_FAILED",
    "errors": [{
      "path": "language",
      "code": "VALIDATION_INVALID_VALUE",
      "message": "Invalid option: expected one of \"zh-TW\"|\"en\""
    }]
  }
}
```

`message` 只是備援，上例的驗證套件措辭不屬於固定字典 key。支援的分類如下：

| code | 安全的 params（有需要才提供） |
| --- | --- |
| `VALIDATION_INVALID_TYPE` | `expected` |
| `VALIDATION_TOO_SMALL` | `minimum`, `inclusive`, `type` |
| `VALIDATION_TOO_BIG` | `maximum`, `inclusive`, `type` |
| `VALIDATION_INVALID_FORMAT` | `format` |
| `VALIDATION_NOT_MULTIPLE_OF` | `divisor` |
| `VALIDATION_INVALID_VALUE`, `VALIDATION_UNRECOGNIZED_KEYS`, `VALIDATION_INVALID_UNION`, `VALIDATION_CUSTOM`, `VALIDATION_INVALID` | 無 |

params 不包含被拒絕的輸入、token、任意 custom params 或巢狀 issue。
若新的欄位不存在，前端必須仍能處理舊 `{ path, message }` 錯誤。
AI 的 HTTP／SSE 與工具錯誤位置不同，見 [AI 工具參考](AI_AGENT_TOOLS_REFERENCE.md#語言與錯誤處理)。
完整 HTTP schema 以 `/api/v1/openapi.json` 為準。

## 九、來源名稱與顯示欄位

名稱不是訊息字典 key。後端只採用來源已有的英文（TDX `En`、OSM `name:en`、視障設施 `nameEn`），沒有英文就保留原文，不自行音譯或翻譯官方名稱。英文介面仍可能合理地出現中文地名、地址或業者名稱。

### 語言與相容性

- 地點、設施與交通名稱讀取端點使用 optional query `lang=en` / `lang=zh-TW`，也接受既有 en-/zh- 語言別名（如 `en-US`、`zh-Hant`）。不支援的值回驗證錯誤；不新增全域 `Accept-Language` 優先規則。
- 新增的設施／交通 display 契約：省略 `lang` 時不新增 display 欄位，維持既有 DTO。原本 Places 搜尋的 `name`／地址已隨 `lang` 在 provider 層選語言，其既有行為不變。
- 路線規劃與導航仍使用 body `language`。原始 `name`、`routeName`、站名、ID、方向、幾何與評分不會被 display 名稱取代。
- UI 選用「非空 display 值 → 原始名稱 → 原有類別備援」，不可用顯示文字做去重、查詢、站點匹配或儲存識別。後續請求使用原 ID／canonical 欄位。
- 來源為 English-only、沒有中文 canonical 名稱時，en 可提供英文 display；無可用文字則可能省略 display，前端仍需類別備援。

### 設施與交通欄位

以下是顯示欄位導覽，完整巢狀位置以 OpenAPI 為準。全部路徑前綴為 `/api/v1`。

| 端點／結果 | 可選顯示欄位 |
| --- | --- |
| `/a11y/all-facilities`、`all-bathrooms`、`all-ramps`、`all-elevators`、`nearby-a11y`、`place`、`parking/nearby`、`visual-a11y` | `displayName`；適用的地址另有 `displayAddress`，學校有 `displaySchoolName` |
| `/a11y/campus`、`campus/nearby`、`campus/schools`、`campus/:campusId` | `displaySchoolName`、`displayBranchName`、`displayAddress`；設施 `displayName`。沒有英文來源的校名／地址維持原文 |
| `/a11y/welfare`、`welfare/nearby`、`welfare/:id` | `displayName`、`displayAddress`；來源無英文則維持原文 |
| Places details 的 `nearbyFacilities` | 依同次 `lang` 提供設施 display，既有 Place 主名稱／地址契約不變 |
| `/transit/bus/route`、`route-detail` | `routeDisplayName`；directions 的 `subRouteDisplayName`、`fromDisplayName`、`toDisplayName`；stops 的 `displayName` |
| `/transit/bus/arrival` | `routeDisplayName`、`stopDisplayName`；arrivals 的 `subRouteDisplayName`、`stopDisplayName` |
| `/transit/bus/timetable` | `routeDisplayName`；有原始支線名的 schedules 有 `subRouteDisplayName`；trip 的 `originStopDisplayName`、stopTimes 的 `stopDisplayName` |
| `/transit/bus/positions` | `routeDisplayName`；buses 的 `subRouteDisplayName` |
| `/transit/bus/search-routes`（含 `search-route` alias） | routes 的 `routeDisplayName`、`departureDisplayName`、`destinationDisplayName` |
| `/transit/bus/search-stops`（含 `search-stop` alias）、`nearby-stops` | stops 的 `stopDisplayName`、`routeDisplayNames`；後者逐項對應原 `routes` 的順序 |
| `/transit/bus/stop-arrivals` | `stopDisplayName`；arrivals 的 `routeDisplayName`、`subRouteDisplayName`、`headsignDisplayName`（原無 headsign 時為 null） |
| `/transit/train/timetable`、`station-timetable`、`stations` | 起訖／車站的 `displayName`；班次的 `trainTypeDisplayName`，station-timetable 另有 `destinationDisplayName` |

公車路線／站點搜尋可使用已保存的英文名稱，鐵路車站建議／時刻查詢可使用來源英文解析原 ID；顯示語言不會把 ID 或後續 matching 改成英文文字。這不代表每個接受名稱的 API 都能任意翻譯輸入。

### 路線與 WALK 路名側車

在明確指定 `language` 的路線回應中，WALK／BUS／METRO／TRA／THSR leg 可增加 `fromDisplayName`、`toDisplayName`，有路線／線名／車種名稱時可有 `routeDisplayName`。有真實來源時保留 `fromNameEn`、`toNameEn`、`routeNameEn`；中途站可有 `nameEn`／`displayName`。此階段不承諾 DRIVE／MOTORCYCLE 或所有線名都有英文來源。

WALK **仍只有既有九個 step 機器欄位**。CSR 來源英文路名放在 leg 的可選 `stepStreetNames`，不放進 step：

```json
{
  "stepStreetNames": [{
    "index": 0,
    "streetName": "羅斯福路",
    "nameEn": "Roosevelt Road",
    "displayName": "Roosevelt Road"
  }]
}
```

- `index` 指向**同一 leg 的原始 `steps`**，不是導航 instructions 的索引。
- 顯示前同時核對 index 與 canonical `streetName`；重複 index、越界、名稱不符、空英文都回退原 `steps[index].streetName`。不可僅以中文路名做 map key，因為不同道路可能同名。
- sidecar 是可選來源 metadata；無論有無提供規劃語言，前端都不能假設它一定存在。沒有 sidecar 的舊 token 仍可導航。
- `/a11y/route/instructions` 與新的 Voice session/resume 會使用本次語言，依 token 保存的來源資料產生路名，不靠舊 `displayName` 猜測。相同 token 可要求 en／zh-TW 指引，不必重新規劃。
- OTP／Valhalla 的 locale 設定不等於會翻譯 street name；本契約沒有為此切換 provider locale。

### 快取、資料更新與前端切換

前端的名稱查詢 cache key、request dependencies 與 stale-response 判斷須包含 effective language。Mobile 的 `system` 應先解析成 en／zh-TW，但不得改寫使用者的「跟隨系統」設定。

切語言不可自動 reroute。可用既有來源欄位重新呈現名稱，或取得同 token 的新語言導航；沒有來源就保留原文。舊 route 的 display 欄位屬原請求語言，不能直接當成新語言結果。相同 reroute `clientRequestId` 仍重播首次結果，即使重試時換語言也不會重新規劃。

CSR 英文可用率取決於 `ped_osm_way_name.name_en` 是否已有資料。程式可讀舊版沒有 `name_en` 的表，但不會憑空產生英文。名稱回填屬獨立資料維運操作；更新 lookup 後需重新載入記憶體 graph（例如重啟使用該 graph 的 backend process），只等 ACTIVE version 檢查不會重載同版本名稱。單純更新來源名稱不需重建 graph 拓樸或成本。

## 十、純步行路線的 DTM 高程剖面

`POST /api/v1/a11y/accessible-route` 的 resolved `travelMode: "walk"` 會在每個
`data.routes[]` 加上 `elevationProfile`；standard／compact 相同。沿用既有起終點名稱或座標輸入：

```json
{
  "origin": { "latitude": 25.1368, "longitude": 121.5065 },
  "destination": { "latitude": 25.1377, "longitude": 121.5145 },
  "travelMode": "walk"
}
```

剖面採 **最終選出的戶外 WALK 線形**（CSR／OTP／Valhalla），不為高程重新規劃。
`transit`（即使 fallback 結果全為 WALK）、開車、機車及其步行接駁段都省略此欄位。
`venueLeg` 的室內段不納入；步行重新規劃會依新線形重算。高程不改變排名、步行時間或
`data.slopeConstraint.enforced`。

### 前端繪圖

- `status: "complete" | "partial"`：`samples` 依行進方向排列，含起終點及每 20 公尺的樣點。
  橫軸用 `samples[].distanceM`，縱軸用 `elevationM`；`coordinates` 是 `[lng, lat]`，可連動地圖游標。
  `distanceM` 由線形各段測地距離加總，可能與引擎提供的路段距離略有差異。
- `summary` 提供 `minElevationM`、`maxElevationM`、`ascentM`、`descentM`、`netElevationM`、
  `validSamples`、`sampleCount`。距離和高程皆以公尺為單位。累積升降分別加總所有正／負高差，
  不是只用終點減起點；`netElevationM` 才是起終點淨高差。
- `partial` 的缺值是 `null`，曲線應斷線，**不可補成 0 或跨缺口連線**；全程累積升降與淨高差皆為
  `null`，最高／最低僅代表已知樣點。有效的 0 或負高程不可當成缺值。
- `source` 固定標示 `dataset: "MOI_DTM_20M"`、`kind: "terrain"`、`resolutionM: 20`、
  `samplingIntervalM: 20`、`interpolation: "bilinear"`、`smoothing: "none"`。
  高程沿用圖資儲存的垂直基準，不宣稱為 WGS84 橢球高。

資料不可用時，路線仍回傳正常 200／原有 envelope，只有剖面變成：

```json
{ "status": "unavailable", "reason": "data_unavailable" }
```

`reason` 為封閉機器碼，前端自行 i18n：`not_configured`（明確停用）、`data_unavailable`
（缺檔、檔案讀取／worker 失敗）、`unsupported_dtm`（圖資格式／投影不符）、`no_coverage`
（沒有任何有效高程）、`invalid_geometry`（缺／無效／不連續線形）、`route_too_long`
（超過 50 公里）、`resource_limit`（超過候選／取樣／讀取範圍上限）、`busy`（讀取槽已滿）、
`timeout`（超過本次高程讀取預算）。此狀態沒有假造的全零曲線或統計數字。

### 圖資準備與效能邊界

本機預設檔案為 `otp-data/dem/taiwan-dtm-20m.tif`；可用
`ROUTE_ELEVATION_DTM_PATH` 改路徑，明確空字串停用。既有下載器可準備資料：

```bash
python3 src/scripts/fetch-otp-dem.py ./otp-data/dem
```

下載器會下載官方全臺 DTM 並轉為 EPSG:4326 GeoTIFF。執行下載器的環境需有 `rasterio`，
但 API runtime 不需要 Python。自備檔案須為單波段、PixelIsArea、north-up、EPSG:4326、
無旋轉且 tile 不超過 256×256 的 tiled GeoTIFF。缺檔不阻擋 API 啟動，不會逐請求下載。
Compose 的唯讀掛載與容器路徑以根目錄 `docker-compose.yml` 為準；來源目錄沿用
`OTP_DEM_DIR` 或 `OTP_DATA_DIR/dem`，不將圖資打包進映像。

單次僅處理前 3 條候選、每條最多 50 公里／2501 樣點；一個 request 的候選共用一次
DTM worker，總預算 1500ms，逾時終止。每個 API process 最多 2 個同時讀取的 worker，
額外請求回 `busy` 而非無限排隊。採局部視窗讀取，不整張載入全臺 raster。

**這是地形估計，不是路面量測或無障礙通行保證。** 20 公尺圖資內插不會增加真實解析度；
累積升降未去噪，可能受高程誤差影響。不能用它判定橋面、地下道、短坡道、緣石或平整度，
也不能由曲線看似平坦就推論輪椅安全或任意坡度限制已生效。
