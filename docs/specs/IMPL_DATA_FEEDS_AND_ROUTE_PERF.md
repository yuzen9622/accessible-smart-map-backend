# 資料源補強與路徑規劃效能 — 實作計畫

**狀態**：P1–P5（含 P2b）已實作，未 commit；P6 待 VM 配置。實作與原計畫的差異見文末「實作紀錄」
**日期**：2026-10-01
**範圍**：P1 北捷電梯異常、P2 施工資訊（擴充既有 TDX）、P3 有聲號誌、P4 polyline 瘦身、P5 OTP 結果快取、P6 OTP 並行（待 VM 配置）

所有外部資料源都在 2026-10-01 以實際請求驗證過，下面的格式與筆數都是實測值。

---

## 0. 實作順序與交付切分

| 順序 | 項目 | 理由 |
| --- | --- | --- |
| 1 | P1 電梯異常 | 使用者指定必做，改動集中在 `facility-status.ts` |
| 2 | P4 polyline 瘦身 | 收益最大、改動最小，與其他項無依賴 |
| 3 | P5 OTP 快取 | 獨立於資料層 |
| 4 | P2 施工資訊 | 擴充既有 TDX 事件到步行／大眾運輸與 AI agent，需擴充 hazard 匹配器 |
| 5 | P3 有聲號誌 | 需動 `visual_a11ys` schema（含既有資料遷移） |
| 6 | P6 OTP 並行 | 等 VM 配置，見 §6 |

每項一個獨立 commit。每項都要過 `pnpm build`（含 `lint:arch`）＋ `pnpm test`，並在 Docker 用新 image 跑備用埠與舊版並排實測（`docker compose up -d --build backend`）。

---

## P1. 北捷電梯異常公告（必做）

### 資料源（實測）

- 資料集：臺北捷運車站無障礙設施異常公告（data.taipei `d884a9c6-f86c-4854-8da7-e6516ddbe612`），免會員
- 下載：`https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=649c44eb-60b5-4746-a353-cbdc6651fc09`
- 編碼 **Big5**（回應標頭 `charset=BIG-5`），CSV，欄位：`項次,日期時間,路線,車站,說明`
- 實測內容：`1,20261001T163300,板南線,頂埔站,捷運板南線【頂埔站】月台電梯電纜更新作業已完成、開放使用，…`
- **「說明」是自由文字，沒有狀態欄位**；同一份資料同時包含「異常」與「已恢復」公告

### 設計

- `src/adapters/taipei-metro-notice.adapter.ts`：抓 CSV，用 Node 內建 `TextDecoder("big5")` 解碼（不新增依賴），逾時 10s
- 解析進 `planners/facility-status.ts`，與既有 TDX alert 共用快取機制（in-process `CacheEntry`、TTL 5 分鐘、fail-soft）
- 狀態判定（純函式，可單測）：
  1. 依 `車站` 分組，取 `日期時間` 最新的一筆
  2. 命中 `RESOLVED_RE = /已完成|恢復|開放使用|已修復/` → 已恢復，不產生異常
  3. 否則命中既有 `OUTAGE_RE = /維修|故障|暫停|停用/`（另加 `檢修`）→ 有效異常
  4. 都沒命中 → 只當成提示文字，不視為異常
  5. 超過 30 天的公告直接忽略（**假設**：實測只看到一筆，無法確認舊公告會不會從檔案中移除）
- 站名對應：`車站` 去掉「站」字後，比對 facility-status 既有的北捷站名索引。對不到的站記 warn log、不丟錯
- 輸出整合（不新增平行欄位）：
  - `overlayFacilityStatus`：METRO leg 的出發站或到達站有有效異常時，寫入既有的 `facilityHighlights` / `route.accessibilityHighlights`（沿用 `pushUnique` 去重）
  - `probeMetroElevatorOutages`：一併回傳這些異常，讓語音／導航端吃到同一份資料
  - **排序影響**：`mode=wheelchair` 或 `requireElevator=true` 時，經過有效異常站的路線加懲罰排到後面，**不直接排除**。原因是公告只到「站」這一層，不知道是哪一部電梯，一站通常有多部
- 地圖顯示：`all-facilities` / `nearby-a11y` 裡 `source: "metro"` 的項目，該站有有效異常時，在既有項目上補 `outageNotice?: { description, postedAt }`

### 驗收

- 單測：Big5 解碼、「已完成」判為恢復、「暫停使用」判為異常、同站新公告蓋過舊公告、超過 30 天的忽略、對不到站名不丟錯
- 突變驗證：把 `RESOLVED_RE` 拿掉，「已完成」案例的測試必須變紅
- Live：實際抓一次，log 印出解析後的異常清單，並和 data.taipei 頁面人工對照

---

## P4. Polyline 瘦身

### 現況（實測／程式碼）

- leg `polyline` 是 `[lng, lat][]` 原始陣列（`types/route.ts:197` 等）
- 先前量測：長程路線的 JSON 約 420KB，其中 96% 是一條 13,652 點、沒有簡化的高鐵 polyline
- 目前只有公車線形有 Douglas-Peucker 簡化（`modules/transit/bus-shape.ts:56`）

### 限制：哪些 polyline 不能動

以下結構會用索引指進 polyline，刪掉點就會錯位：`WalkA11ySegment.startIndex/endIndex`（WALK）、`DriveTrafficSegment.fromIndex/toIndex`、`DriveManeuver.begin/endShapeIndex`（DRIVE）、語音導航的 `step.polylineIndex`（WALK）、nav-instructions 的 `nearestPolylineIndex`。

### 設計

- **只簡化 BUS / METRO / TRA / THSR leg**，這些 leg 型別沒有任何索引欄位。WALK / DRIVE / MOTORCYCLE leg 的點數完全不變
- 所有 leg 的座標四捨五入到小數 6 位（約 0.11m），點數不變、索引安全
- 位置：`finalizeRoutes` 的 `slimRoutes(top)` 之後（`accessible-route.service.ts:1065`）。這時 hazard 匹配、設施 enrich、即時疊加都已經用完整幾何跑完
- DP 實作：把 `bus-shape.ts` 的 Douglas-Peucker 實作 `simplifyPath`（`:56`）移到 `src/utils/geo.ts` 共用，`bus-shape.ts` 改成 import 它（避免 accessible-route 跨模組 import transit）
- 容差：軌道 5m、公車 5m（沿用 bus-shape 的值），寫成常數
- 不改成 encoded polyline 字串：那是破壞性變更，前端要一起改；列為後續選項

### 驗收

- 單測：簡化後首尾點不變、所有原始點到簡化線的距離 ≤ 容差、WALK/DRIVE leg 點數不變
- 突變驗證：把 leg 型別判斷改成全部簡化，「WALK 點數不變」的測試必須變紅
- Live：同一條台北→左營（含高鐵）的請求，量測改前改後的回應大小（raw 與 gzip），目標 raw 減少 ≥70%。地圖上目視比對線形

---

## P5. OTP 規劃結果快取

### 現況

- 沒有任何規劃結果快取（accessible-route 裡的 Redis 只存導航 token 與導航狀態）
- 每次請求打 OTP 1 次（最好）到 5 次以上（最壞），全部串行 `await`（`planners/otp-routing.ts:1022` 起）
- 軌道幾何查詢已經有快取＋dedup（`realtime-transit.ts:885`），不用再做

### 設計：快取放在 `queryOtpPlan`（`otp-routing.ts:308`）這一層

這樣主查詢、寬窗重查、吸附重查、續查全部共用快取。即時疊加（ETA、電梯異常、施工）、hazard、評分都在下游，**每次請求照樣重算**，所以使用者偏好不需要放進快取鍵。

- 快取鍵：`otp:plan:v1:<sha1(variables)>`，variables 是 GraphQL 的全部變數，其中：
  - 起訖座標四捨五入到小數 4 位（約 11m），**實際查詢也改用四捨五入後的座標**，讓快取內容與查詢一致。代價是步行起點最多偏移約 8m
  - 出發時間往下取整到 2 分鐘，實際查詢也用取整後的時間；回傳後濾掉 `startTime` 早於真實出發時間的行程
- TTL：120 秒。環境變數 `OTP_PLAN_CACHE_TTL_S`，0 代表關閉
- 只快取成功回應（含「無路線」的 routingErrors，因為結果是確定的）；逾時與錯誤不快取
- 命中快取時不呼叫 breaker 的 `recordSuccess`
- 同一個 process 內加 single-flight：同時進來的相同查詢共用一個 promise
- Redis 不可用時直接略過快取（沿用 `redisGet`/`redisSet` 的 fail-open）
- `[route-timing]` log 加上 `otpCacheHit` 次數

### 驗收

- 單測（mock Redis 與 otpClient）：相同查詢第二次不打 OTP；座標差 3m 的查詢命中同一個鍵；早於真實出發時間的行程被濾掉；逾時不寫入快取；TTL=0 時完全不碰 Redis
- 突變驗證：把時間取整拿掉，「2 分鐘內命中」的測試必須變紅
- Live：同一請求連打兩次，第二次的 `[route-timing]` 主查詢時間接近 0

---

## P2. 施工資訊：以既有 TDX 路況事件為主，補齊沒接到的功能

### 和既有 TDX 資料的關係（2026-10-01 實測比對）

- 既有 `road-incident.service.ts` 抓的是 TDX `Traffic/RoadEvent/LiveEvent/City/{City}`。台北這份目前 670 列，其中 668 列是「道路施工」，`Source` 為「道管中心」
- 台北今日施工 `Todaywork.json` 也是道管中心的資料。用案號比對：**Todaywork 的 148 個案件全部都在 TDX 裡**（TDX 有 149 個案件）
- 所以**不另開一條施工資料源**。Todaywork 比 TDX 多的只有三個欄位：是否封閉（`IsBlock`，148 案中 25 案為是）、完工日（TDX 的 `ExpireTime` 全部是空的）、施工範圍的面或線幾何（TDX 只有點）
- 實測另外發現：TDX 同一個 `EventID` 會重複出現多列（最多 29 列）。⚠️ 實作時複查：這些是**完全相同的重複列**（同點、同文字），不是沿施工範圍取的點。目前程式每列各產生一筆 incident，所以 `/traffic/incidents` 會回傳重複的事件

### 目前 TDX 施工有接到哪些功能

| 功能 | 現況 |
| --- | --- |
| 開車／機車路線規劃 | 有。封路類事件放進 Valhalla 的 `exclude_locations`，其他事件只做提示（`accessible-route.service.ts:2095` 起） |
| 地圖 `GET /api/v1/traffic/incidents` | 有 |
| 步行／大眾運輸路線規劃 | **沒有**（`:2084` 的條件只對開車與機車生效） |
| AI agent `getNearbyHazards` | **沒有**，只查使用者回報（`agent-tools.ts:804`） |
| AI agent 規劃路線 | 只有開車模式有，因為它是委派給同一個規劃函式 |

### 設計

1. **TDX 事件依 `EventID` 合併**：同一事件的多個點合成一筆 incident，原本的 `location` 保留第一個點，另外加 `points: {lat, lng}[]` 放全部的點。開車排除用全部的點，所以封路效果不會變差。這同時修好 `/traffic/incidents` 的重複問題
2. **步行／大眾運輸路線**：`finalizeRoutes` 載入使用者回報 hazard 的同一個時間點，也載入請求範圍內的 TDX 有效事件（沿用既有的 Redis 快取與 single-flight，不多打 TDX），轉成 hazard 輸入：
   - `hazardType`：標題含「施工」→ `construction`，其他 → `obstacle`
   - 嚴重度：既有 `classifyIncident` 判為 `closure` → `difficult`，`advisory` → `minor`。**不用 `blocking`**：道路封閉不代表人行道不能走
   - `ConfirmedHazardInput` 加選填 `points?: [number, number][]`，匹配器取所有點裡離路線最近的距離（沿用既有的 `pointToSegmentDistanceM`）
   - `RouteHazard` 加 `source: "community" | "government"`
   - 政府事件有自己的上限，不佔用使用者回報的 100 筆上限
   - 涵蓋範圍跟著既有的 `TRAFFIC_TARGET_CITIES`（目前 10 個縣市），不只台北
3. **AI agent**：`getNearbyHazards` 同一個工具同時回傳附近的 TDX 事件，每筆標 `source`，**不新增工具**。工具與 prompt 的描述本來就寫了「施工」，文字不動。路線規劃工具因為委派同一個規劃函式，第 2 點做完就自動帶上
4. **地圖**：沿用既有的 `GET /api/v1/traffic/incidents`，不另開端點（原規劃的 `/a11y/construction/nearby` 取消）

### 選做：P2b 用 Todaywork 補台北的欄位

用案號把 Todaywork 對到 TDX 事件，補上三個欄位：
- `IsBlock=是` 的案件強制判為 `closure`。目前 TDX 的描述多半只寫「道路維護」，關鍵字分類幾乎都會落在 `advisory`，所以這會讓開車的封路排除真正生效
- 完工日 → 填進 incident 既有的 `endTime`
- 施工範圍的面或線幾何

Todaywork 的承包商聯絡人與手機（`Tc_Ma`、`Tc_Tl`、`Tc_Ma3`、`Tc_Tl3`）一律不存、不回傳。只有台北有這份資料。

### 驗收

- 單測：同 `EventID` 的多列合併成一筆並保留全部點；合併後開車排除點數不變；points 匹配（距路線 20m 命中、40m 不命中）；`closure`／`advisory` 對應到正確的嚴重度；政府事件不佔使用者回報的上限
- 突變驗證：把合併拿掉，「重複事件」的測試必須變紅
- `getNearbyHazards`：mock 兩種來源，回傳要兩種都有並且有 `source`
- Live：找一個實際施工點規劃步行路線，`hazards` 要出現 `source: "government"`；AI chat 問「這附近有沒有施工」要回出 TDX 事件

---

## P3. 有聲號誌

### 資料源（實測）

- 舊規格書 `FUNCTIONAL_SPEC_AUDIBLE_SIGNAL_ROUTING.md` 寫的 TDX `Accessible/City/{City}/APS`：**v1、v2 用真實 token 打都回 `Resource Not Found`，這個端點不存在**。該規格書的資料源與整合方式（寫於 6 月、還提到已移除的 ORS）一併作廢，以本節為準
- 改用：臺北市交工處有聲號誌設置位置（data.gov.tw `121423`）
  - 下載：`https://data.taipei/api/dataset/baf32b58-b194-448d-96a0-ba04013d164f/resource/1c18341c-9f6f-4b6b-b17f-8c66b94e39a0/download`
  - **Big5** CSV（原記為 UTF-8，有誤），**191 筆**，欄位：`項次,路口,行政區,號誌編號,WGS84經度座標,WGS84緯度座標`
  - `號誌編號` 實測沒有重複
  - 只涵蓋台北市

### 設計

- 不新增 model：專案已有 `visual_a11ys` collection（`model/visual-a11y.model.ts`，目前是 OSM 的有聲號誌與導盲磚），政府資料併進去：
  - 加 `source: "osm" | "taipei_tce"` 與 `sourceId: string`，`osmNodeId` 改成選填
  - 唯一索引從 `{osmNodeId, type}` 改成 `{source, sourceId, type}`
  - 遷移腳本 `src/scripts/migrate-visual-a11y-source.ts`：既有資料補 `source: "osm"`、`sourceId = String(osmNodeId)`，再換索引。**要先停 backend 或在低峰時跑，並先備份該 collection**
  - `properties.name` 放路口名稱，`roadName` 放行政區
- 匯入腳本 `src/scripts/import-taipei-aps.ts` ＋ `package.json` 的 `import:taipei-aps`，格式照既有的 `import:*`
- 既有 `GET /visual-a11y` 自然會帶出政府資料（地圖顯示不用另開端點）。回應補 `source` 欄位
- 路線整合：
  - enrich 階段對 WALK leg 查詢 `visual_a11ys`（`type: "audio_signal"`，OSM 與政府兩種來源都算），條件是路線 polyline 20m 內
  - 每條路線先用 bbox 撈一次，再在記憶體裡算點到線距離，避免每個點都查一次 DB
  - OSM 與政府資料在 15m 內視為同一個路口
  - 結果寫進 WalkLeg 新增的 `apsSignals?: { id, name, lat, lng, source }[]`。這是新資料，不是既有能力的重複
  - 評分：`collectRouteFacilities` 把 `apsSignals` 轉成帶 `traffic_signals:sound=yes` tag 的節點，讓 `scoring.ts:685` 現有的 `hasAudioSignal` 直接生效，`scoring.ts` 本身不用改
  - 只在 `mode=visual_impaired` 時查，其他模式零成本

### 驗收

- 單測：CSV 解析、遷移的冪等性（跑兩次結果一樣）、15m 去重、20m 內命中與 40m 不命中、非 visual_impaired 模式不查 DB
- 突變驗證：把 `collectRouteFacilities` 的轉換拿掉，「視障模式分數提高」的測試必須變紅
- Live：跑遷移與匯入，確認 `visual_a11ys` 多了 191 筆政府資料、OSM 筆數不變；visual_impaired 模式規劃一條經過已知號誌路口（例：八德路三段／光復北路）的路線，確認 `apsSignals` 有值

---

## P6. OTP 並行（待 VM 配置，本輪不實作）

### 可選方案

| 方案 | 做法 | 對 OTP 的額外負載 |
| --- | --- | --- |
| A | 起訖直線距離 ≤3.5km 時，吸附站查詢（Mongo）和主查詢同時跑 | 無（只多 Mongo 查詢） |
| B | 長程請求（直線距離超過門檻）主查詢與寬窗查詢同時發 | 這類請求的 OTP 負載約 2 倍 |
| C | 吸附重查也提早並行發出 | 同上 |
| D | 視核心數設定 OTP `searchThreadPoolSize`（目前沒設，預設 0 = 單執行緒） | 單一查詢用更多核心 |

A 沒有額外負載，可以先做。B、C、D 取決於 VM 撐不撐得住。

### 需要你提供的 VM 資訊

1. vCPU 數、RAM
2. OTP 容器的 JVM `-Xmx` 設定，以及實際 heap 使用量
3. 同一台 VM 還跑哪些容器（Mongo、Valhalla、Chroma、Redis、backend 等）
4. 預期的尖峰同時使用人數

拿到之後，我會先從 `[route-timing]` log 統計寬窗重查與吸附重查的實際觸發比例，再決定開 B/C/D 的哪幾項與門檻。

---

## 不在本輪範圍

- 改成 encoded polyline 字串（破壞性，要前端配合）
- 新北以及其他縣市的施工、有聲號誌（沒有找到可用的開放資料）
- 電梯維修預排時程表（每月更新、只到站層級，價值低）

## 待確認假設

1. 電梯異常：超過 30 天的公告忽略；異常只加懲罰，不直接排除路線
2. OTP 快取：座標取 4 位小數（步行起點最多偏移約 8m）、時間取整到 2 分鐘、TTL 120 秒
3. 施工：步行／大眾運輸上，封路事件對應 `difficult`，不是 `blocking`；P2b（Todaywork 補欄位）要不要做
4. P3 的 `visual_a11ys` 遷移要短暫停機或在低峰執行

---

## 實作紀錄（2026-10-01）

與上文計畫不同、以此為準的地方：

1. **P2：TDX 的重複列不是範圍點**。所以「依 EventID 合併」只用來去重，範圍點改由 P2b 的 Todaywork 施工範圍每 20 公尺取樣（每案最多 200 點）提供，只有台北有。
2. **P2：步行／大眾運輸的政府危險點**改成「道路封閉，**或**標題／描述／位置文字提到人行道、騎樓、行人」，兩者都對應 `difficult`。原因：實測台北 142 個事件中有 22 個是人行道施工（例：人行道鋪面更新），幾乎都不是道路封閉，只收封閉會漏掉輪椅族最在意的那一類。
3. **P2：`RoadIncident` 新增 `locationDescription`**（TDX `Location.Other`），原本被丟掉。另外新增 `points`、`roadClosed`。危險點描述優先用位置文字。
4. **P2：hazard 警告文字**從「社群已確認的路況障礙」改成「已確認的路況障礙或道路施工封閉」，因為現在也包含政府資料。
5. **P2b：已做，含施工範圍幾何**（見第 1 點）。
6. **P3：不新增 `WalkLeg.apsSignals`**，改放進既有的 `WalkLeg.a11yPoints`（`type` 由 `curb_ramp` 擴充為 `curb_ramp | audio_signal`，加選填 `name`），依「整合進既有欄位，不加平行欄位」原則。
7. **P3：CSV 是 Big5**。adapter 先試 UTF-8，失敗再用 Big5。
8. **P3：遷移必須在匯入前執行**。真實 Mongo 測試證實：舊唯一索引 `{osmNodeId, type}` 沒刪的話，第二筆政府號誌就會撞 `E11000 dup key { osmNodeId: null }`。
9. **P5：快取只在有 Redis 時啟用**。沒有 Redis 時，座標與時間都不取整，行為與改版前完全相同。
10. **P1：同時接到地圖**：`all-facilities`、`all-elevators`、`nearby-a11y` 的北捷電梯項目加上 `outageNotice`。
