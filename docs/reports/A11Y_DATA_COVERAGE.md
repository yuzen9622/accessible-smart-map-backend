# 無障礙資料覆蓋率報表

> 日期：2026-06-16 ｜ 量測對象：`otp-data/feed-1.gtfs.zip`（進 graph 的 feed）、`otp-data/taiwan-gtfs.zip`（原始 TDX feed）、MongoDB `accessible_map`
> 目的：判斷 OTP 引擎層的無障礙旋鈕「有沒有資料可分」，並排定 E5 資料補齊的優先序
> 關聯：`docs/specs/A11Y_SCORING_REWORK.md`（E4/E5）

---

## 0. 一句話結論

**OTP 的 stop/trip 無障礙旗標幾乎是空的**（`wheelchair_boarding` 整欄不存在；`wheelchair_accessible`
僅 164/150,070 = 0.11%）→ **調 `stop/trip.inaccessibleCost` 目前等於沒效**。
真正「有資料可分」的引擎層只有 **車站內 pathways 的 702 部電梯 vs 1,071 段樓梯**，以及 per-request 步速。
Post 層 curated 資料（OsmA11y 11,242 點）對 134,377 個公車站而言**極度稀疏**，這正是 facility 分數恆 0 的資料面成因。

---

## 1. 引擎層（OTP 吃進去的）資料覆蓋率

### 1.1 GTFS `stops.txt` — `wheelchair_boarding`：**整欄不存在**

| feed                        | stops 總數 | `wheelchair_boarding` 欄 |
| --------------------------- | ---------- | ------------------------ |
| feed-1.gtfs.zip（進 graph） | 161,755    | **不存在**               |
| taiwan-gtfs.zip（原始 TDX） | —          | **不存在**               |

- location_type 分布：154,946 月台/站(0)、247 車站(1)、686 出入口(2)、5,876 generic node(3)。
- **原始 TDX feed 本身就沒有這欄** → 不是 clean 腳本砍掉的，是 TDX 國家級 GTFS 不提供。
- 後果：OTP 對**每一個 stop 都視為 unknown** → 一律套 `stop.unknownCost`(600)。`inaccessibleCost`(3600)
  **永遠不會觸發**（沒有任何 stop 被標為不可達）→ stop 層完全無鑑別力。

### 1.2 GTFS `trips.txt` — `wheelchair_accessible`：164 / 150,070（0.11%）

| 值                  | 數量    | 說明                            |
| ------------------- | ------- | ------------------------------- |
| EMPTY（unknown）    | 149,906 | 套 `trip.unknownCost`(600)      |
| `1`（accessible）   | 164     | **全部是 route_type 2（台鐵）** |
| `2`（inaccessible） | 0       | 無                              |

- 來源：`src/scripts/inject-tra-gtfs.py` 依台鐵 `WheelChairFlag=1` 注入；其餘**刻意留空不標 2**
  （腳本註解原文：標 2 或靠 3600s inaccessibleCost 會把輪椅規劃硬擠到那 164 班車）。
- 公車（route_type 3，8,584 條路線）、捷運（route_type 1，47 條）、輕軌（route_type 4，49 條）
  的 trips **wheelchair_accessible 全為 0 筆**。
- route_type 分布：bus 3=8,584｜rail 2=252｜LRT 4=49｜metro 1=47｜air 1102=3。

### 1.3 GTFS `pathways.txt` — 車站內無障礙圖：**有料**

| pathway_mode      | 數量    |                  |
| ----------------- | ------- | ---------------- |
| 1 walkway         | 6,618   |                  |
| 2 stairs          | 1,071   | 輪椅須避開       |
| 4 escalator       | 942     |                  |
| **5 elevator**    | **702** | **輪椅關鍵路徑** |
| 6 fare gate       | 402     |                  |
| 7 exit gate       | 345     |                  |
| 3 moving sidewalk | 3       |                  |

- 共 10,083 條 pathway，涵蓋 ~6,989 個 stop（捷運/台鐵站內的室內圖）。
- **這是目前引擎層唯一真正有鑑別力的無障礙資料**：開 wheelchair 後，OTP 會走電梯(5)、
  重罰樓梯(2，`stairsReluctance`=100) → 站內「街道↔月台」的輪椅路徑是真的在算的。

### 1.4 OSM 街道 tag（`wheelchair`/`incline`/`kerb`/`steps`）：**未直接量測**

- 本機無 osmium/osmconvert/pyosmium，324MB pbf 無法直接掃（量測方法見 §5）。
- **代理證據**：我們從 OSM 萃取的 OsmA11y 層裡 `incline`=0 筆、`ramp:wheelchair`=0 筆（見 §2）
  → 強烈暗示台灣 OSM 街道的坡度/輪椅 tag 覆蓋接近零。
- 推論：`maxSlope` / `slopeExceededReluctance` / `inaccessibleStreetReluctance` 目前**幾乎無料可咬**，
  調了影響有限（待 §5 精確量測確認）。

---

## 2. Post 層（我們 curated）資料覆蓋率

### 2.1 `OsmA11y`：11,242 點（對照 134,377 公車站 → 極稀疏）

| category                                      | 數量  |
| --------------------------------------------- | ----- |
| wheelchair_accessible（泛 wheelchair=yes 點） | 8,812 |
| kerb_cut                                      | 1,390 |
| toilet                                        | 551   |
| elevator                                      | 489   |
| ramp                                          | **0** |

關鍵 tag 出現數：`wheelchair`=9,514、`toilets:wheelchair`=2,671、`kerb`=1,393、`tactile_paving`=94、
`elevator`=22、**`ramp:wheelchair`=0、`incline`=0**。

- 全台僅 489 部電梯點、1,390 個 kerb cut、551 個無障礙廁所 → 對 13 萬個公車站，命中 150m 內幾乎都是空集合。
- `scoring.ts` 找的 `ramp`/`incline`/`ramp:wheelchair` 在資料裡**根本不存在** → 這些評分分支等於死碼。

### 2.2 其他 post 層資產

- `bathrooms`（無障礙廁所）：7,180
- `accessibilities`（捷運無障礙出口）：188
- `gtfspathways`：10,220、`gtfslevels`：7,229（mongo 內室內圖，與 GTFS pathways 對應）
- `metrostations`：252、`trainstations`：257（站點數小、可控，是 E5 注入旗標的理想標的）

---

## 3. 哪些引擎旋鈕現在有效 / 無效

| 旋鈕                                                      | 現在有效？  | 原因                                                   |
| --------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `stop.inaccessibleCost`                                   | ❌ 無效     | 無 stop 被標不可達（整欄缺）                           |
| `stop.unknownCost`                                        | ⚠️ 全域齊一 | 每站都 unknown，只改 walk↔transit 平衡，不分站         |
| `trip.inaccessibleCost`                                   | ⚠️ 極弱     | 只影響「164 台鐵 vs 其餘」，且腳本刻意不標 2           |
| `wheelchairAccessibility.elevator.*` + `stairsReluctance` | ✅ **有效** | 702 電梯 / 1,071 樓梯在 pathways，站內輪椅路徑真的在算 |
| `accessEgress.maxDuration`                                | ✅ 全域有效 | 影響所有人步行段長度                                   |
| `walkSpeed`（per-request）                                | ✅ 有效     | E2，最乾淨                                             |
| `maxSlope` / `inaccessibleStreetReluctance`               | ❓ 疑似無料 | OSM 街道坡度/輪椅 tag 近乎零（代理證據），待 §5 確認   |

---

## 4. 對「是否現在調全域旋鈕」的結論

- **要調的**：站內 elevator/stairs 相關（確認 `stairsReluctance` 夠重、電梯被偏好）、`walkSpeed`(E2)。
  這兩類現在就有資料可咬。
- **先不要調的**：`stop/trip.inaccessibleCost` —— 沒有旗標資料，調了等於沒調，甚至可能誤把
  「unknown」當「inaccessible」傷及全網。維持現值 `onlyConsiderAccessible:false`（官方亦建議）。
- **maxSlope 系列**：等 §5 量到 OSM 街道 tag 覆蓋再決定；目前疑似無料。

---

## 5. E5 資料補齊：高槓桿優先序

1. **（最高槓桿）為捷運+台鐵站注入 `wheelchair_boarding`** —— 只有 252+257≈509 個站，標的小、可控。
   來源：TDX StationFacility（電梯有無）或 OsmA11y elevator 點（489）或 `accessibilities`（188 出口）。
   一旦 stops.txt 有 `wheelchair_boarding`，OTP 的 stop 層 wheelchair 模型立刻活起來。
   注入點：`clean-gtfs-feed.py`（或新增類似 `inject-*` 的步驟）。⚠️ 注意 TRTC 電梯資料為空的已知問題
   （見 memory `tdx-station-facility-schema`），需以 OSM 補位。
2. **量測 OSM 街道 tag 覆蓋**（§6），決定 maxSlope 系列是否值得投入。
3. **公車 trip/stop 旗標**：量大（13 萬站）、來源弱 → 短期不追，靠 post 層 OsmA11y + 中性基準兜底。

---

## 6. 待辦：OSM pbf 街道 tag 精確量測（本次未做）

本機缺工具。建議擇一：

- `osmium tags-filter taiwan-otp.osm.pbf w/wheelchair w/incline w/kerb w/highway=steps -o /tmp/a11y.osm.pbf` 後計數；或
- `pip install pyosmium` 寫 handler 計數 highway way 上 `wheelchair`/`incline` 出現比例；或
- 讀 OTP build 的 `DataImportIssues` 報表（建圖時加 `--save` 並開啟 issue report）。

產出應為：highway way 總數、其中帶 `incline` / `wheelchair` 的比例，據此判斷 `maxSlope` /
`inaccessibleStreetReluctance` 是否有意義。

---

## 7. 公開資料補齊對照表（每個缺口 → 公開來源）

> 結論先講：**最高槓桿的「捷運+台鐵站 `wheelchair_boarding`」可由公開資料補齊**（TDX StationFacility
> ＋ OSM/data.taipei 補 TRTC）；公車低地板與 OSM 街道坡度則「開放但不易直接灌」，ROI 低、短期不追。

| 缺口                                                | 公開來源                                                                                                                                                                                | 取得方式                                                                                                                                 | 覆蓋／品質                                                                            | 已接線？                                | ROI                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| **A. 捷運+台鐵站 `wheelchair_boarding`**（~509 站） | **TDX StationFacility**（Metro/THSR/TRA，`FacilityType`=1 電梯/3 無障礙廁所…）；**OSM** Overpass（`highway=elevator`、`wheelchair`）；**data.taipei / 各市開放平臺** 捷運無障礙電梯位置 | OData API（已有 `TdxMetroStationFacility`/`TdxThsrStationFacility`/`TdxTraStationFacility` 型別）；Overpass（已有 `import-osm-a11y.ts`） | 非 TRTC 的鐵路/捷運 TDX 可用；**TRTC 電梯在 TDX 為空（已知）→ 用 OSM/data.taipei 補** | TDX 型別已備、metro facility 已部分使用 | ★★★ 最高                                     |
| **B. 公車 trip `wheelchair_accessible`（低地板）**  | TDX 公車（per-vehicle 低地板不穩定）；部分縣市/業者低地板班表                                                                                                                           | —                                                                                                                                        | 全國 per-trip 覆蓋弱、業者相依                                                        | ❌ 未接                                 | ★ 低，短期不追                               |
| **C. OSM 街道 `incline`/`kerb`/`wheelchair`**       | OSM 本身；各市人行道/騎樓 GIS（如臺北人行道圖資）                                                                                                                                       | Overpass / 市府 GIS（需轉檔灌入 OTP pbf）                                                                                                | 台灣街道坡度 tag 近乎零；GIS 非 OSM 格式、灌入 OTP 工程大                             | ❌                                      | ★ 低（engine maxSlope 暫無料），改由 post 層 |
| **D. 無障礙廁所**                                   | **環境部 全國公廁** open data（含無障礙旗標+座標）；OSM `toilets:wheelchair`                                                                                                            | data.gov.tw 下載；Overpass                                                                                                               | 已有 bathrooms 7,180 + OSM 2,671，覆蓋尚可                                            | ✅ 部分（bathrooms 集合）               | ★★ 可增補                                    |
| **E. 即時電梯/電扶梯故障**                          | 各捷運公司（TRTC 等）即時電梯狀態；TDX 部分                                                                                                                                             | 業者 API                                                                                                                                 | 用於 post 層即時 overlay（已有 `overlayFacilityStatus` 基礎）                         | ✅ 基礎已有                             | ★★                                           |
| **F. 站內電梯/樓梯**（pathways）                    | 已具備（GTFS pathways 702 電梯）                                                                                                                                                        | —                                                                                                                                        | 已在 graph                                                                            | ✅                                      | —                                            |

**A 的具體作法（E5 #1，已落地）**：`build-otp-graph.sh` 步驟 1d → `inject-station-wheelchair.py`。
⚠️ 實測修正（2026-06-17）：TDX Metro StationFacility 的真實 schema 是 **top-level `Elevators` 陣列 + `StationID` 鍵**
（**非** `Facilities[].FacilityType`，codebase 型別已過時，見 memory `tdx-station-facility-schema`）；
`Elevators` 非空 → feed stop `{SYS}_{StationID}` 補 `wheelchair_boarding=1`。實測對到 **91 站**
（KRTC 37 / TYMC 22 / TMRT 18 / NTMC 14）。**TRTC 0（Elevators 全空 → 待 OSM 電梯點補位）**；
**TRA/THSR `StationFacility` 回 404（無此 API）→ 鐵路站不從此補**。產出寫回 `stops.txt`，**重建 graph 後生效**。

**關鍵限制**：A 能補的是「站」層級（捷運/台鐵/高鐵 ~509 站）。13 萬個公車站的 `wheelchair_boarding`
無公開來源可一次補齊，仍靠 post 層 OsmA11y + 中性基準(P3)。OSM 來源見 memory `tdx-station-facility-schema`
（TRTC 電梯空）與 `import-osm-a11y.ts`（Overpass query 目前只抓 `wheelchair~yes|limited`，可擴充抓
`highway=elevator`/`kerb`/`tactile_paving` 提升 post 層覆蓋）。
