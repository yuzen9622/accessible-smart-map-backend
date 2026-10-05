# 步行模式品質修復計畫（含 a11y 硬性條件補漏）

- 狀態：計畫已核准，待實作
- 實測日期：2026-08-03
- 所有數字都是本機 Docker（otp 2.9.0 / valhalla 3.8.2 / backend :8000）真實回應，非推測
- 實測 fixture 保存於 `~/otp-backup/walk-quality-fixtures/`（見 §8）

## 定案前提（實作時不要再重新討論）

1. **所有步行段一律走 OTP；Valhalla 只做汽車與機車。** 這是本計畫的骨架，§1／§2 因此成為阻擋性前置。
2. OTP walk 斷路器跳閘或查詢失敗時，保留 Valhalla walk 作為**明確標記的停機備援**（記 log ＋
   回應 `warnings` 標示引擎降級），不是靜默替換。正常運作下 100% 步行由 OTP 產生。
3. `/route/instructions` 追加 `routeToken` 輸入（§7）與 Valhalla 備援的 a11y costing（§6）都在範圍內。

---

## 0. 前端兩條需求的處理結論

| 需求                                | 結論                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ② `avoidStairs` / `requireElevator` | **已上線**（commit `399de79`＋`2ae27ad`）。schema `accessible-route.schema.ts:57,65`、硬性排除 `accessible-route.service.ts:234-260`、mode 預設 `scoring.ts:385-386`、OTP wheelchair 傳遞 `otp-routing.ts:403`、測試 `accessible-route.routes.test.ts:104-142`、前端文件 `docs/FRONTEND_MIGRATION_A11Y_CONSTRAINTS.md`。→ 回覆前端「已可用」。**但有兩個漏洞見 §6、§6b。** |
| ① 步行指引品質差                    | 不必等前端給 route object，已自行完整重現。**主因不在指引文字層，而在 OTP 步行圖資與 router 設定**（§1、§2 皆為安全／可用性等級問題）。                                                                                                                                                                                                                                    |

---

## 1. P0-A：OTP 把行人規劃上市民大道高架道路

### 實測證據

`POST /api/v1/a11y/accessible-route`（松菸→市民大道北側，直線 535 m）真實回傳的步行指引最後兩步：

```
[6] turn d=254 street='基隆路出口匝道'   :: 在「基隆路出口匝道」，請向右轉
[7] turn d=815 street='市民大道高架道路' :: 請大幅向左轉
```

即現行 production API 會叫使用者（含輪椅使用者）走上**高架快速道路 815 公尺**。直線 535 m 被規劃成 1649–2218 m／23–30 分鐘。

- `wheelchair:false` → `光復南路入口匝道` 216 m ＋ `市民大道高架道路` 709 m
- `wheelchair:true` → `基隆路出口匝道` 261 m ＋ `市民大道高架道路` 815 m（**輪椅模式一樣中招**）
- 同 OD 丟給 Valhalla pedestrian：1626 m／19 min，**完全不走高架**

### 根因（標籤層，非路名）

Overpass 查該路段實際標籤：

```
way 48776359  name=市民大道高架道路 highway=trunk      bridge=yes sidewalk=no foot=(無)
way 48793406  name=永吉路出口匝道   highway=trunk_link bridge=yes sidewalk=no foot=(無)
```

`otp-data/build-config.json` 用 `"osmTagMapping": "default"`，OTP 預設 mapping 只禁 motorway，**允許行人走 `trunk` / `trunk_link`**，且不把 `sidewalk=no` 當成行人禁止。台灣的快速道路普遍標 `trunk` 且沒有 `foot=no` → 全台所有高架／匝道都可能被走上去（不只市民大道）。

### 修法

**新增 PBF 前處理步驟**，比照現有 `inject-osm-dem-slopes.py`（step 2b，已用 pyosmium 改寫 PBF）：

- 新檔 `src/scripts/deny-foot-on-expressways.py`（pyosmium `SimpleHandler`，逐 way 改寫）
- 規則（**只看標籤，不看名稱**）：
  `highway ∈ {motorway, motorway_link, trunk, trunk_link}` **且** 原本沒有明確 `foot=*` **且** (`sidewalk=no` 或 `bridge=yes`) → 補 `foot=no`
  - 保守起見不動一般市區 `trunk`（沒有 `sidewalk=no`／`bridge=yes` 的照舊可走，避免誤殺台1線市區段之類）
  - 同一支腳本一併處理 §6b 的樓梯規則
- 掛在 `build-otp-graph.sh` step 2b 之後（新 2c）。**失敗要 `die` 不要 WARN**——靜默略過等於把行人留在高架上，與 `patch_gtfs.py` 的 die 理由一致
- 需要重建 graph（約 50 min），依 `docs/OPERATIONS.md` 的 OTP rebuild SOP：建圖前先在那台機器 `git pull`、先自己 `docker stop otp`、重建後確認容器拉起
- 重建後驗收：新增探測腳本（與 `audit-gtfs-feed.py` 同層）跑 §8 的 OD 清單，**任何 step 的 streetName 命中 `高架|匝道|快速道路|高速公路` 就 fail**（驗收用名稱比對可以，路由邏輯裡不可以；注意此 regex 會誤中「捷運淡水線高架下線型公園自行車道」這類合法路徑，驗收時需人工確認命中項）

### 引擎分工的連帶影響

OTP 是步行的唯一規劃器，所以本節與 §2 是阻擋性前置：OTP 要承擔 100% 步行流量，高架問題與 2 km 上限都不能留著。附帶的好處是實測 OTP walk 查詢只要 5–33 ms（Valhalla pedestrian 同 OD 明顯較慢），所以 §2b／§2c 把步行查詢搬到 OTP 不會有延遲代價。

---

## 2. P0-B：步行超過 ~2 km 靜默回 0 條

### 實測證據（deterministic，非 timeout）

同起點（圓山）往南掃：

| 終點                  | 結果            | 回應時間 |
| --------------------- | --------------- | -------- |
| 民權西路站 (1.1 km)   | 1110 m / 15 min | 6 ms     |
| 民生西路 (1.7 km)     | 1708 m / 23 min | 7 ms     |
| 南京西路 (~2.2 km)    | **0 條**        | 11 ms    |
| 台北車站 / 中正紀念堂 | **0 條**        | 5 ms     |

`routingErrors` 是空陣列、重跑三次結果相同、11 ms 就回來 → 不是 `streetRoutingTimeout: 2s`，是硬上限。

### 根因

`otp-data/router-config.json`：`"maxDirectStreetDuration": "30m"` —— 純步行（direct street）行程超過 30 分鐘（步行 ≈ 2 km）直接被丟棄，且不產生 routingError。

後果：所有 >2 km 的 walk 請求靜默掉到 Valhalla → 兩套引擎輸出交替出現（OTP steps 有 `absoluteDirection`、Valhalla 一律 `null`），指引風格與 bearing 品質不一致，前端就是感受到「品質差」。

### 修法

1. `router-config.json` 的 `maxDirectStreetDuration` 提高到 `"3h"`（純設定，OTP 重啟即生效，不必重建 graph）
2. `planOtpWalk`（`otp-routing.ts:396-437`）在 `itineraries` 為空時記 log（目前完全無聲），讓「OTP 沒回、改用 Valhalla」這件事在日誌看得見
3. `streetRoutingTimeout` 維持 `2s`，但若提高上限後長程步行開始 timeout，改為 `5s`（不需重建，一併觀察）

---

## 2b. P0-C：walk＋waypoints 目前整段走 Valhalla，要搬到 OTP

`accessible-route.service.ts:710` 的條件是 `travelMode === "walk" && !waypointsOpt` —— 只要帶了中途點，
整條步行路線就落到下方的 `findDrivingRoutes()`（Valhalla pedestrian）。依定案分工要改成 OTP：

- 把 O→W1→W2→D 拆成相鄰配對，逐段呼叫 `planOtpWalk()`，再串接成多 leg 的單一 route
  （每段一次 OTP 查詢；實測單次 5–33 ms，N 段仍遠低於一次 Valhalla 查詢）
- 沿用現有 `createLimiter()` 併發上限的做法，避免中途點多時打爆 OTP
- 任一段無解 → 整條視為無解（回 404），不要部分用 OTP 部分用 Valhalla 混搭幾何
- `avoidStairs` 逐段透傳（OTP `wheelchair:true`）

## 2c. P0-D：汽機車的頭尾步行銜接也要改用 OTP

`valhalla-routing.ts:199-244`（`planWalkConnector`）用 Valhalla pedestrian 產生停車格→目的地、
中途點銜接等步行段。依定案分工改為呼叫 OTP walk：

- 這些 leg 是 `WALK` 型別、會進入 `/route/instructions`，用 OTP 才能與其他步行段同源
  （`absoluteDirection`、step 粒度、`avoidStairs` 行為一致）
- 保留現有的端點吸附容差檢查（`WALK_ANCHOR_TOLERANCE`）與併發限制
- OTP 無解時才退回 Valhalla connector，並記 log（同定案前提 2 的降級標示原則）

---

## 3. P1：bearing 不可信（指引欄位正確性）

### 實測證據

- **OTP 路徑**：bearing 全是 45 的倍數 —— `315, 315, 45, 315, 45, 270, 45, 225`。因為 `stepBearing()`（`nav-instructions.service.ts:141-152`）**優先採用 OTP 的 `absoluteDirection`**，那是八方位字串（45° 粒度）→ 誤差可達 ±22.5°，`relativeDirection` 可跨類別誤判，`initialBearing` 同源。
- **Valhalla 路徑**：`absoluteDirection` 全為 `null` → 退回「本轉彎點→下一轉彎點」直線方位，是整段平均方向而非轉彎後起始朝向。實測出現與文字矛盾的一步：`[13] b=101` → `[14] 向右轉 b=310`（從 101° 右轉應該在 191° 附近，310° 是左轉方向）。

### 修法

`stepBearing()` 改為：以該 step 在 leg polyline 上的位置為起點，沿 polyline **向前累積約 20 m 取樣**計算方位角；`absoluteDirection` 降為取不到幾何時的 fallback。`initialBearing` 自動受益。

---

## 4. P1：`legIndex` 缺失 ＋ `polylineIndex` 對位

- `polylineIndex` 是**單一 leg 內**的索引，但回應沒有 `legIndex`（內部語音版 `generateNavStepsWithLegIndex` 有，只是沒外露）→ 多段步行前端無法把索引對回正確的 polyline。
- `nearestPolylineIndex()`（`nav-instructions.service.ts:155-172`）用未經 cos(lat) 校正的度數平方距離、且每次全域掃描 → 折返／繞圈路線可能吸到錯誤的一趟。

修法：`NavInstruction` 新增 `legIndex`（純新增不破壞），並加 `cumulativeDistanceM`（進度條用）；索引搜尋加 cos(lat) 校正並改為「從上一步索引往前單調搜尋」。

---

## 5. P2：指引文字品質

實測 Valhalla 路徑 16 步裡有 8 步是連續無名轉彎（`向左轉` / `向右轉`，7 m、9 m、8 m、12 m 的碎步都在內），且**沒有任何一步帶距離**：

```
[2] 向左轉        d=9
[4] 向左轉        d=185
[5] 向右轉        d=89
...
[11] 向左轉進入「民族西路」 d=1011
```

修法：

1. **合併碎步**：連續 `CONTINUE/STRAIGHT` 與 < 15 m 的步驟合併，距離累加、保留首個 location／polylineIndex；**絕不合併**方向改變的步驟、`facility`（ELEVATOR / ENTER_STATION / EXIT_STATION）與 `exitInfo`
2. **文字帶距離**：改成單一句可直接 TTS —— `向右轉進入「民族西路」，續行約 1 公里`；距離友善化（< 20 m →「馬上」、< 1 km → 十公尺級、≥ 1 km → 1 位小數公里）
3. **無名路段給目標**：`bogusName` 時用下一個具名 step 的街名當目標 —— `直行約 185 公尺至「民族西路」`
4. **釐清 `distanceM` 語意**：實測確認是「做完此 maneuver 之後要走的長度」（`[11] 民族西路 d=1011`）。寫進 OpenAPI description，避免前端渲染成「1011 公尺後左轉」而錯位一步
5. 設施類文字與 AI prompt 字串一律不動

### 5b. 同一條 OD 的兩引擎文字對照（大安森林→中正紀念堂，1436 m）

OTP（一般路徑）與 Valhalla（帶中途點路徑，中途點取 OTP 路徑中點以維持同走廊）實測輸出：

```
OTP       totalSteps=3   [0] b=270 d=1201 請繼續直行   [1] b=270 d=235 請向左轉   [2] 您已抵達目的地
VALHALLA  totalSteps=11  [0] b=297 d=  7 沿目前道路繼續直行 … [5] b=296 d=395 沿目前道路出發 …
```

由此追加三項修正：

6. **修 OTP 路徑的措辭語意錯誤**：`formatWalkStepInstruction()`（`src/utils/transit-text.ts:165-206`）
   產生「在「基隆路一段」，請向右轉」，但 OTP 的 `streetName` 是**要轉進去的那條路**，不是使用者
   現在所在的路 → 應改為「向右轉進入「基隆路一段」」（Valhalla 路徑的 `localizedInstruction()`
   措辭才是對的）。統一到「動作 + 進入/沿 + 街名 + 距離」。
7. **處理 OTP 的過粗切段**：OTP 只在街名／幾何改變時吐 step，長直人行道會變成單一 1201 m
   的「請繼續直行」（實測）。對 > 300 m 的單一 step，依 polyline 轉折點補插中間提示
   （「繼續直行約 400 公尺」），避免一句指令涵蓋 1.2 km。
8. **修多段串接時 DEPART 洩漏**：第 2 段以後的 `DEPART` 會在路程中間變成「沿目前道路出發」
   （實測第 5 步）。§2b／§2c 之後多 leg 步行會變常態，非首段的 DEPART 要重分類為 turn／continue。

---

## 6. 補 ② 的漏洞一：Valhalla 步行完全沒有無障礙 costing

`valhalla.adapter.ts:135` 只送 `{ exclude_ferries, use_ferry }`。因此 `avoidStairs:true` 在下列路徑**完全無效且無提示**：walk＋waypoints、OTP walk 失敗退回 Valhalla、以及開車／機車的頭尾步行銜接。

> **範圍已因引擎分工定案而縮小**：§2b／§2c 把 walk＋waypoints 與汽機車步行銜接都搬到 OTP 之後，
> 這個漏洞的主要修法變成「改由 OTP 規劃」（`wheelchair:true` 本來就生效）。本節剩下的價值是
> **停機備援路徑也不能靜默忽略旗標** —— 仍要補上，成本很低且已實測支援。

實測本機 Valhalla 3.8.2 支援情況（同 OD 1626 m）：

| costing_options                | 結果                                        |
| ------------------------------ | ------------------------------------------- |
| （無）                         | 1626 m / 19 min                             |
| `type: "wheelchair"`           | 1626 m / **24 min**（被接受，成本模型改變） |
| `step_penalty: 600`            | 1626 m / 19 min（接受，此 OD 無階梯）       |
| `type=wheelchair, max_grade=8` | 1626 m / 24 min（接受）                     |

修法：`avoidStairs`（或 `mode==='wheelchair'`）時 pedestrian costing 帶 `type: "wheelchair"` ＋ `step_penalty`，並把旗標串進 `findDrivingRoutes` 與步行銜接查詢；文件註明 `requireElevator` 在 walk/drive 模式為 no-op。

**附帶發現**：`VALHALLA_LANGUAGE = "zh-TW"`（`src/config/valhalla.ts:6`）是死設定 —— 實測 `zh-TW`／`zh-Hans`／`zh` 全部回英文（`"Turn left onto 基隆路一段147巷."`），此 image 沒有中文 locale。目前無害（我們用 `localizedInstruction()` 自組中文），但應加註或移除以免誤信。

---

## 6b. 補 ② 的漏洞二：`wheelchair:true` 仍會走樓梯，且我們的後處理排除是死碼

### 實測證據

台北 6 km 內 46 條 `highway=steps` 取最長 6 條做端點穿越測試（wheelchair 模式）：

| way       | ramp 標記    | OTP normal → wc | OTP 判讀     | VAL normal → wc | VAL 判讀      |
| --------- | ------------ | --------------- | ------------ | --------------- | ------------- |
| 220919395 | incline=up   | 410 → 2141 m    | 繞路 x5.2    | 414 → 2144 m    | 繞路 x5.2     |
| 399043299 | handrail=no  | 734 → 1713 m    | 繞路 x2.3    | 261 → 2657 m    | 繞路 x10.2    |
| 182486895 | incline=down | 225 → **無解**  | 拒絕但回 404 | 226 → 1744 m    | 繞路 x7.7     |
| 136815854 | handrail=yes | 170 → 714 m     | 繞路 x4.2    | 167 → 206 m     | 部分繞路 x1.2 |
| 272274658 | incline=up   | 174 → **174 m** | **未避開**   | 174 → 1438 m    | 繞路 x8.3     |
| 381447794 | incline=up   | 202 → **202 m** | **未避開**   | 202 → 1870 m    | 繞路 x9.3     |

未避開的兩條，OTP 在 `wheelchair:true` 下回傳的 step 明白寫著 `streetName='steps'`
（圓山市景步道，`highway=steps` + `incline=up`，無任何 ramp 標記），與 normal 模式路徑完全相同。
→ **OTP wheelchair 模式在 6 條裡有 2 條讓輪椅使用者上樓梯、1 條直接無解**；Valhalla `type=wheelchair`
6/6 都避開，但繞路倍率誇張（x8–x10，160 m 的落差繞 1.4–2.6 km）。

### 我們自己的防線是死的

`walkLegHasStairsBarrier()`（`accessible-route.service.ts:224-231`）讀的是 `leg.a11yFacilities`，
但實測 API 回傳的 WALK leg **`a11yFacilities` 恆為 `[]`**（兩條真實路線皆是，與
`docs/specs/` 既有記錄的「walk leg a11yFacilities 全域無寫入者」一致）→
`avoidStairs` 的後處理排除對步行段**從來沒有生效過**，實際只剩引擎層的 `wheelchair:true`。

### 修法（2026-08-03 第二輪實測後修正）

1. PBF 前處理（與 §1 同一支腳本、同一次重建）：`highway=steps` 且無 `ramp:wheelchair=yes`／
   `wheelchair=yes` → 注入 `wheelchair=no`。**已實作並驗證覆蓋全台 16057 條 steps**，但單靠這個
   不足 —— 見下方 (a)。
2. **改用 OTP 的 `step.feature` 一級欄位判斷樓梯**，不要用 `streetName === 'steps'` 字串比對。
   OTP 2.9 的 `step.feature` 是 union（`StairsUse` / `ElevatorUse` / `EscalatorUse` / `Entrance`），
   實測對 OSM `highway=steps` 會回 `StairsUse`，非樓梯段回 `None`：
   ```
   way 420707836 wheelchair=true:
     d=20  street='圓山市景步道' feature=None
     d=133 street='steps'      feature={'__typename':'StairsUse'}
   ```
   在 walk／plan 查詢補 `feature { __typename }`，`WalkStep` 增 `stairs: boolean`，
   `walkLegHasStairsBarrier()` 改讀該旗標（同時保留 `ramp:wheelchair=yes` 例外）。
3. `avoidStairs=true` 時向 OTP 要多條候選、優先選無樓梯者；**全部候選都含樓梯時回傳最少樓梯者，
   並在 walk route 補降級標示欄位**（實測 walk route 目前完全沒有 `warnings`／`scoreComponents`／
   `accessibilitySummary`，這是靜默降級的真正源頭）。
4. 指引文字可用 `StairsUse` 標示「此段含樓梯」，但**不要把整段距離都說成樓梯** —— 見 (b)。

### 兩個實測踩到的坑（別重走）

(a) **OTP 的輪椅 reluctance 是死路，不要調**。`WheelchairConfig` 確實接受
`stairsReluctance` / `inaccessibleStreetReluctance`（啟動摘要會列出、無未知參數警告），但：
`10000` 與 `1000` 會讓成本整數溢位（`Negative value not expected for value: -71446306`，
該 OD 直接規劃失敗）；`100` 不溢位但與預設 `25` 幾乎無差別（8 條樓梯 OD 仍 7 條走樓梯）。
已還原，`router-config.json` 只保留 §2 的 `maxDirectStreetDuration: 3h`。
⚠️ 用端到端 API 測這件事會被誤導：OTP 溢位報錯後 backend 會退回 Valhalla，看起來像「已排除」。
驗證樓梯一定要直接打 OTP GraphQL。

(b) **OTP 會把連續多個 way 合併成一個 step，`streetName` 只反映第一段**。實例：
大安森林→中正紀念堂的 1201 m step 被標成 `steps`，但本地 PBF 掃過該區最長的 `highway=steps`
只有 60 m。所以距離歸屬不可信（也會反向漏判：合併段首是人行道、後段才有樓梯就抓不到）。

---

## 7. `/route/instructions` 接受 `routeToken`

現行只吃前端原樣 echo 的 route object，一旦前端漏帶 `steps` 就退化成一句概略指引，且無法追查。改為 `route` 與 `routeToken` 二擇一（`routeToken` 優先）：`route-token.service.ts` 已有 `getRouteByToken()`，Redis TTL 30 分鐘。`route` 路徑保留不破壞相容。

---

## 8. 測試與驗收

**單元測試**：bearing 沿 polyline 取樣、碎步合併規則（含「不得合併 facility／方向改變」的反例）、文字生成與距離友善化、`nearestPolylineIndex` 單調性與 cos(lat) 校正、Valhalla wheelchair costing 組裝、非首段 DEPART 重分類。

**Route-level 整合測試**：覆蓋 OTP 步行、Valhalla 步行、walk＋waypoints 多 leg、`routeToken` 輸入四條。

⚠️ **測試不要放實抓的 API payload**。本計畫初期把實測回應存成 fixture 進 repo，那些 payload
含 `routeToken`（Redis 隨機鍵、TTL 30 分鐘，等同憑證），而本 repo 是公開的。已改為在測試檔內
以合成資料建構路線（形狀照實測結果，但不含任何 token）。探測腳本本身無敏感資料，留在
`~/otp-backup/walk-quality-fixtures/`（`vs.py`／`stairs2.py`／`textq.py`／`accept.py` 等，可重跑比對）。

**上線前實測 OD 清單**（每條都要無高架／匝道，且有路線）：

| OD                           | 現況                    | 目標                   |
| ---------------------------- | ----------------------- | ---------------------- |
| 松菸→市民大道北側 (535 m)    | 走高架 815 m            | 不走高架，≈ 600–800 m  |
| 圓山→行天宮 (1.6 km)         | OTP 0 條（掉 Valhalla） | OTP 有解               |
| 圓山→台北車站 (3.1 km)       | OTP 0 條                | OTP 有解               |
| 台北101→市政府 (0.6 km)      | 583 m / 6 步            | 不退化                 |
| 台北車站→西門町 (1.7 km)     | 1729 m / 13 步          | 不退化                 |
| 大安森林→中正紀念堂 (1.4 km) | 1436 m 只有 **2 步**    | 依 §5b-7 補插後 ≥ 5 步 |
| 圓山市景步道 steps 兩段      | 輪椅模式仍走樓梯        | 繞路或明確排除         |

`pnpm build` ＋ `pnpm test` 全綠；改動前後的指引輸出做 before/after 比對（步數、文字、bearing）。

---

## 9. 交付順序

1. §2（router-config 一行 ＋ log）→ OTP 重啟即見效，先解除 2 km 上限
2. §1 ＋ §6b-1（PBF 前處理腳本 ＋ graph 重建 50 min ＋ 驗收探測）→ OTP 既然要承擔 100% 步行，
   高架與樓梯問題不能留。做完再往下走，後續改動都在已修好的圖資上驗證
3. §2b、§2c（walk＋waypoints 與汽機車步行銜接搬到 OTP）＋測試
4. §3、§4、§5（純程式，nav-instructions 模組內）＋測試
5. §6（Valhalla 備援 a11y costing）＋ §6b-2/3（後處理防線修活）＋ §7（routeToken）＋測試
6. 文件：`FUNCTIONAL_SPEC_NAV_INSTRUCTIONS.md`（修 §5.3 的 85°→「右前方」錯誤範例，程式門檻給的是
   「右側」；補新欄位與 `distanceM` 語意）、`FRONTEND_MIGRATION_A11Y_CONSTRAINTS.md` 補生效範圍、
   新增步行指引變更的前端遷移說明

---

## 10. 風險

- 指引文字與 `totalSteps` 會變（前端若有 snapshot 會壞 —— 但這正是他們要的品質提升）
- 碎步合併過寬會吃掉該報的轉彎 → 靠「方向改變不合併」守住，並用 fixture 斷言步數區間
- `foot=no` 規則若過寬會誤殺可走的市區 trunk → 用 `sidewalk=no` / `bridge=yes` 雙條件收斂，並在 §8 的 OD 清單驗證沒有變成 0 條
- `wheelchair=no` 規則會讓部分 OD 從「有解（走樓梯）」變成「無解」→ 需確認 §8 清單沒有整條消失，
  必要時搭配後處理排除而非引擎硬禁
- graph 重建 50 min 且要停 OTP；重建後務必確認容器拉起（曾出現 Exited 137）
- **步行全押 OTP 之後，OTP 變成步行的單點故障**：斷路器跳閘時只剩標記降級的 Valhalla 備援。
  §2 的 log 與降級標示要一起做，否則會重演「404 謊報」看不出真因的狀況
- §2b 讓每個中途點多一次 OTP 查詢、§2c 讓每趟汽機車行程多 1–2 次 OTP 查詢 → OTP 負載上升，
  但實測單次 5–33 ms，且都套用併發上限，風險低
