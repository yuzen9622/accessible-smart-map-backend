# 步行 `leg.steps` 對外契約與英文詞彙表（供前端 i18n）

適用於 `POST /api/v1/a11y/accessible-route` 所有 `type: "WALK"` leg 的
`steps`。`POST /api/v1/a11y/route/instructions` 是另一個導航端點，仍回傳
繁體中文的 `instructions[].text`，不會改變其回應形狀或文案責任。

---

## 一、設計原則

`leg.steps` 是純機器資料，不承載任何可直接顯示或朗讀的文案。前端必須以封閉 enum
和本文件的詞彙表自行完成 i18n；後端不提供相容欄位或 fallback 文案。

三個步行引擎（OTP、CSR `pedestrian-a11y`、Valhalla 步行備援）都經過同一個
merge/split 正規化流程，因此輸出的 key 集合與值域一致。正規化在
`planAccessibleRouteFromRequest()` 成功回傳前執行一次；HTTP wrapper 只附加
`routeToken`，不會再次 merge/split。AI agent 路徑與 HTTP 路徑取得的 `steps` 必須逐字相同。

---

## 二、文案與導航端點的邊界

畫面上的 `CONTINUE 文心南七路 · 260 m` 曾是前端讀取缺失欄位後，自行 fallback
印出的 `${relativeDirection} ${streetName}`；它不是 OTP 的英文文案。

現在 WALK step 不再有文案欄位。若前端需要完整的繁中逐步導航文字，應呼叫
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
需要後端既有繁中導航文案時，使用 `/route/instructions` 的 `instructions[]`，其中的
`type` 是 `NavInstructionType`，並非 WALK step 欄位。

---

## 五、驗收

1. OTP fixture 與 CSR fixture 產出的 `Object.keys(steps[0]).sort()` 必須逐字相同，且正好是 §3 的九欄。
2. WALK step 序列化後不得出現 `"instruction"`、`"maneuver"`、`"text"` 或 `"type"`。
3. `absoluteDirection` 僅可為 §4.2 的英文 token 或 `null`；CSR 案例必須明確證明不是中文字。
4. `relativeDirection` 僅可為 §4.1 token；例如 OTP `FOLLOW_SIGNS` 必須正規化成 `CONTINUE`。
5. 所有 step 必有布林 `steepSlope`，且 merge/split 後仍符合九欄契約。
6. 同一成功路線的 AI agent 路徑與 HTTP 路徑之 WALK `steps` 必須逐字相同。
7. `/route/instructions` 必須接受新的無文案 WALK steps，並維持既有中文 `instructions[].text`；道路、交通與語音行為不變。

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
