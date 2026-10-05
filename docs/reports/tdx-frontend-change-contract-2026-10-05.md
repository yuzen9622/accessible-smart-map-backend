# TDX 資料同步：前端修改契約書

日期：2026-10-05　版本：1.0　狀態：實作規格，前端尚未修改／驗收

## 1. 目的與適用範圍

手機 App 與 Web 必須能保留並使用後端回傳的 TDX 公車方向，不再把合法方向誤判成壞資料；缺少即時 ETA 時，正確顯示未知或班表資訊。

適用專案：

- 手機 App：`/Users/yuen/orca/accessible-smart-map-mobile`。
- Web：`/Users/yuen/orca/taipei-accessible-map`。
- 後端依據：本 repo 的 `src/modules/transit/transit.schema.ts`、`transit.router.ts`、`bus.service.ts`、`bus-next-departure.ts`，及 [本次後端修正報告](tdx-contract-sync-2026-10-05.md)。

本文中的「必須」為驗收條件；實作檔案清單是目前查證的修改入口，不要求在無必要時修改所有檔案。前端 API 型別、解析器、領域邏輯、UI 與測試必須一起對齊。

本次不包含後端部署、正式資料重新匯入、OTP graph 重建、EAS 發布、原生套件升級，或新增停駛通知畫面。

## 2. 公車方向契約

```ts
/** TDX 公車 API 的方向值。 */
type BusDirection = 0 | 1 | 2 | 10 | 255;

/** OTP／GTFS 排程方向，保持既有定義。 */
type ScheduledBusDirection = 0 | 1;
```

| TDX 值 | 官方名稱 | 前端要求 |
| --- | --- | --- |
| `0` | 去程 | 可顯示既有「往終點站」資訊 |
| `1` | 返程 | 可顯示既有「往起點站」資訊 |
| `2` | 迴圈 | 保留原值，顯示「迴圈」；不轉成 0／1 |
| `10` | 循環線 | 保留原值，顯示「循環線」；不轉成 0／1 |
| `255` | 未知 | 保留資料並顯示「方向未知」；不可據此推定搭乘方向 |

官方欄位說明沒有進一步定義 `2` 與 `10` 的區分，不得自行解讀為順／逆時針，也不得合併成相同代碼。去程／返程不代表固定東西南北方向。

### 2.1 型別與邊界解析

1. 公車 API 的到站、路線站序、時刻表及車輛方向欄位，統一使用 `BusDirection`，不使用任意 `number` 代替語意明確的型別。
2. JSON 解析器必須接受五個數字值；`direction: 10` 不得導致整筆到站資料或整組站序被丟棄。
3. JSON 中的 `"10"` 字串、`null`、缺值及其他未定義數字仍屬無效方向；維持既有丟棄／錯誤策略，不強制轉成 0、255 或任意有效值。
4. 畫面導覽參數是字串時，可經明確解析把 `"0"`、`"1"`、`"2"`、`"10"`、`"255"` 轉為合法值；空字串／不合法值表示未選擇，不得利用 `Number('')` 誤變成 0。
5. 既有經緯度、必要欄位、車牌及站序完整性驗證必須保留。
6. 前端 `BusLeg.direction` 若表示 OTP／GTFS 排程方向，維持 `0 | 1`；捷運與雙鐵的方向定義不跟著擴充。

### 2.2 選單、站序與分支識別

1. 方向選單從 API 實際回傳的資料產生，不能只寫死兩個 0／1 選項，也不能固定展示五種不存在的方向。
2. 原本 0／1 的「往 X」顯示保持可用；2／10 顯示對應名稱，有可確認的 headsign／子路線名稱時可加上該文字。255 顯示「方向未知」，不套用去程的終點。
3. 目前選擇仍存在時保留選擇；否則先選已選子路線的方向 0，再選該子路線第一個非 255 的有效方向；只剩 255 時可顯示其資料，但方向依賴的追車功能保持不可用；無資料時為空狀態。
4. 子路線識別必須保留，資料與選擇以 `(subRouteUid, direction)` 區分。不可只用 `direction` 合併同方向的不同支線。缺少子路線 ID 時維持既有精確配對與保守 fallback，不捏造 ID。
5. 地圖線形、站序、ETA、車輛、提醒目標及快取鍵，必須屬於同一子路線與方向。切換選擇時取消舊查詢／追蹤，避免延遲回應覆蓋新選擇。
6. 不因方向是 2／10 就自行讓站序首尾相接、繞圈補站或選擇跨圈乘車區間；只有現有資料能證明的站序可供配對，無法確定時保留排程並顯示未知。

### 2.3 車輛、追車與提醒

1. 車輛解析保留方向 255，但方向依賴的上車／下車追蹤不把它配給 0、1、2 或 10。一般車輛清單可顯示其座標及「方向未知」。
2. 從既有 GTFS leg 尋找 TDX 方向時，必須依子路線及上下車站的有效站序對應；不能把 GTFS 0 當作 TDX 0 的保證，也不能用「不是 1」就視為去程。
3. 方向 2／10 必須進入既有的方向解析、站點配對、車輛 filter 與提醒識別流程；若無法確定正確乘車區間，不可硬選第一個方向。
4. 即時 ETA 與車牌必須來自同一筆可確認的資料，不借用另一輛車、另一支線或附近同名站的數值。
5. `estimateMinutes: null` 不觸發「即將到站／到站」通知；未知無障礙設備資訊仍是未知，不轉為 `false`。

## 3. 端點與請求契約

以下均為既有 `GET` 端點，前綴 `/api/v1/transit`，目前 router 未要求使用者 JWT。沿用既有 HTTP client 與 API envelope；TDX 認證仍由後端處理，前端不直接取得或傳送 TDX 金鑰。

| 完整路徑 | 請求欄位 | 方向處理 |
| --- | --- | --- |
| `/api/v1/transit/bus/arrival` | `routeName`、`stopName` 必填；`city` schema 選填但目前 controller 需要可解析的城市；`direction` 選填 | 有選擇時傳五種合法值之一，省略表示不限定方向 |
| `/api/v1/transit/bus/positions` | `routeName` 必填；`city` 同上；`direction` 選填 | 與 arrival 一致 |
| `/api/v1/transit/bus/route-detail` | `routeName` 必填；`city` 同上；`subRouteUid` 選填 | 沒有 `direction` query；取得站序後在前端精確選擇方向／子路線 |
| `/api/v1/transit/bus/timetable` | `routeName` 必填；`city` 同上 | 沒有 `direction` query；保留各方向的回傳值 |

前端必須以顯式 `undefined`／`null` 判斷是否省略參數，不能以 truthy 判斷遺漏方向 0。省略方向和指定 255 不同：後者只查未知方向。不要傳入 schema 未定義的 query，例如對 route-detail 新增 direction，或對 arrival 新增 subRouteUid；本次不擴充後端參數。

請求範例（示意，路線是否供應方向 10 必須以實際回應確認）：

```http
GET /api/v1/transit/bus/arrival?routeName=307&stopName=台北車站&city=Taipei&direction=10
GET /api/v1/transit/bus/positions?routeName=307&city=Taipei&direction=10
GET /api/v1/transit/bus/route-detail?routeName=99&city=Taichung&subRouteUid=TXG991
```

無效方向／缺少必要參數應進入既有 400 錯誤流程；資料不存在與上游失敗維持後端原本 404／5xx 處理。HTTP 200 仍要檢查 envelope 的成功狀態；請求失敗不製造零分鐘 ETA，也不把上次資料當作本次成功。

### 3.1 獨立整合缺口：stop-arrivals

手機 App 的 `src/features/bus/api/transit.ts` 已呼叫 `/api/v1/transit/bus/stop-arrivals`，且 parser 的 `StopArrival.direction` 只接受 0／1。然而 2026-10-05 檢查本後端 `src/`，沒有找到此路由或實作。

前端仍須同步該型別與 parser 的五值方向支援，避免以後接入時再丟資料；但**不得宣稱該畫面已完成真實整合驗收**。實作前確認 App 指向哪個服務，以及該服務是否另有此端點。若實際服務也沒有，列為獨立後端需求；本契約不授權新增路由，亦不假設已有可用回應。

## 4. ETA 與狀態契約

`estimateMinutes` 是後端已校正來源年齡的分鐘數，型別維持 `number | null`，不是原始 TDX 秒數。前端不再次扣 `SrcTransTime`／`SrcUpdateTime`，也不轉成秒再除一次。

| 回傳情況 | 必須呈現的語意 |
| --- | --- |
| 有效數字 `0` | 保持既有「進站中」顯示 |
| 有效數字 `> 0` | 保持既有即將到站／分鐘顯示規則 |
| `null` + 明確停靠／營運狀態 | 顯示後端狀態，例如「交管不停靠」「末班車已過」 |
| `null` + 下一班時刻文字 | 顯示該班表文字，不標成即時倒數 |
| `null` + 「暫無到站資訊」 | 顯示對應無資料文字，不改成「尚未發車」 |
| `null` + 空白、缺值或只有「正常」 | 顯示「暫無到站資訊」；不能從缺值推定尚未發車 |
| 未取得 ETA，僅有排程 | 沿用「預定 …」，不冒充即時 |

1. 只有後端明確回傳「尚未發車」才可顯示該狀態。移除站牌／路線詳情中把所有缺 ETA 預設成「尚未發車」的分支；同步繁體中文、英文及既有狀態翻譯。
2. `statusLabel` 是顯示用複合文字，可包含下一班時刻；修正「arrival 永遠是原始 StopStatus、不會覆寫時刻」的過時型別註解。不要把它解析成官方狀態碼。
3. 不新增前端必填的來源時間、過期旗標或 receipt 欄位；目前公開回應沒有提供完整來源時效證明。
4. 前端若已有收件後倒數，保留單次本機 elapsed 處理；不得重複扣來源年齡或把過期倒數夾成 0，造成永久「進站中」。更新失敗／背景恢復時依既有快取時效規則重查，不默默刷新舊資料的收件時間。
5. 同一站點失去可用即時資訊時，不沿用上一筆車牌搭配新的未知 ETA。排程 fallback 仍可顯示，但不冠上「即時」。

## 5. 實作入口

| 專案 | 檔案／區域 | 必須處理的責任 |
| --- | --- | --- |
| App | `src/features/bus/types/transit.ts`、`api/transit.ts` | 公車方向型別、parser、arrival／positions query、statusLabel 註解 |
| App | `domain/busDirections.ts`、`domain/stopBoard.ts` | 動態方向、子路線選擇、車輛配對 |
| App | `domain/busLegStops.ts`、`controller/liveBusTracker.ts` | 分開 GTFS 排程與 TDX 方向，維持精確區間配對 |
| App | `hooks/useRouteLiveBuses.ts`、`controller/arrivalReminder.ts` | 請求與提醒目標容納新方向，保留分支識別 |
| App | `screens/BusRouteScreen.tsx` 及站牌相關畫面 | 導覽參數、動態選單、標題、切換後的查詢與追蹤 |
| App | `domain/busStopBadge.ts`、`components/busText.ts`、`components/etaDisplay.ts`、i18n | 缺 ETA／無資訊文案，保留正常數字顯示 |
| Web | `src/lib/api/transit.ts`、`src/types/transit.ts`、`src/types/route.ts` 的 TDX 型別 | 公車 API 型別／參數；GTFS BusLeg 與雙鐵型別不一律擴充 |
| Web | `src/components/BottomSheet/BusPanel.tsx` | 方向狀態與選單、缺值 badge 文案 |
| Web | `src/lib/transit/busLegStops.ts`、`src/hook/useLiveBusPositions.ts` 及相關站序 hook | TDX 方向解析、即時車輛／子路線與排程區間配對 |
| 兩端 | 上述責任相鄰的現有測試與快取邏輯 | 正反例、重查與切換隔離；不只修改型別讓編譯通過 |

不得修改無關 inherited worktree 變更。跨專案實作前讀取各專案現行 AGENTS.md，依其套件管理與架構規則執行。

## 6. 驗收矩陣

以下是待執行條件，不是已通過的前端驗證結果。合成資料須標示為 fixture；真實上游沒有某方向時，以 fixture 驗證該邊界，不宣稱有真實案例。

| 編號 | 情境 | 通過條件 |
| --- | --- | --- |
| D01 | arrival／route-detail／timetable／車輛回傳五種合法方向 | 所有合法資料保留；2／10 不被 parser 丟棄；255 不偽裝為去程 |
| D02 | JSON 方向字串、缺值、null、3、-1 | 不接受為合法方向；其餘有效列不受影響 |
| D03 | 導覽參數 0、10、255、空字串、非法字串 | 正確解析；空值不變成 0；沒有 phantom 選項 |
| D04 | 只有方向 10，或只有方向 2 | 能查看站序／線形／到站資訊，不出現空的去返程選單 |
| D05 | 只有方向 255 | 顯示未知方向資料；不建立方向依賴的到站提醒／搭乘追蹤 |
| D06 | 兩支線方向同為 0／10 | 各自站序、車輛、ETA、線形與快取不互相混用 |
| D07 | GTFS 方向 0，TDX 實際方向 1 或 10 | 依站序與子路線解析；排程 leg 原值保持不變，資料不足不硬配 |
| D08 | 循環路線有重複站名或候選區間不明 | 不自行繞圈補站；無法確定時顯示未知／保留排程 |
| D09 | arrival／positions query 指定 0、2、10、255 或省略 | 實際 URL 符合選擇；0 不遺漏，省略不變成 255 |
| D10 | 切換子路線／方向後舊請求才完成 | 舊回應不覆蓋新選擇；追蹤與提醒目標正確更新 |
| E01 | ETA 為 0、2、8、null | 數字顯示維持既有規則；null 不變成 0 |
| E02 | null 搭配末班／不停靠／尚未發車／班表文字 | 原語意保留；班表不標即時 |
| E03 | null 搭配空白、正常或暫無到站資訊 | 顯示無資訊；不憑空顯示尚未發車 |
| E04 | 先有 ETA／車牌，後無 ETA 或查詢失敗 | 不保留假即時 ETA，不借別車數字，不觸發到站提醒 |
| E05 | 多次使用同筆快取、背景恢復／更新失敗 | 收件時間不被重設；不重複校正來源時間，不永久進站中 |
| R01 | 一般方向 0／1、同方向多支線 | 既有去返程、精確車牌與 SubRouteUID 回歸不退步 |
| R02 | 捷運／臺鐵／高鐵及無障礙資訊未知 | 原方向語意保持；unknown 不變成設備不存在 |

### 6.1 工具鏈與實際操作

- App：執行現有 `typecheck`、受影響的 Jest 測試及 lint；測試 API parser、方向領域邏輯、站序與追車，至少各有正例與反例。
- Web：執行受影響的 Vitest 測試、現有 build 與相應 lint；重新 build／啟動後才做瀏覽器驗收，不能使用修改前 bundle。
- 真實 HTTP：記錄服務 base URL、時間、查詢參數與回應方向，確認實際運行的後端已包含本次契約；本機成功不等於正式環境已部署。
- 真實畫面：App 在實際裝置操作方向切換、站序、追車與提示；Web 在瀏覽器操作相同流程。若只做 simulator／mock／靜態測試，明確標示為部分驗收。
- 方向 2／10／255 至少用可重現 fixture 操作完整 UI；另外用真實可用路線驗證網路整合。不能用 HTTP 200 或型別編譯取代畫面結果。
- stop-arrivals 的服務缺口未解決時，該畫面列為未驗收，不得由其他 endpoint 的成功推定通過。

## 7. 交付與完成定義

實作者交付 App、Web 的實際修改檔案與原因、命令結果、驗收矩陣結果及畫面證據；保留既有修改，列出略過／失敗／未執行項目。只有公車 parser 接受新值，尚不代表方向選單、追車與提醒完成。

本契約範圍完成須同時滿足：五值資料契約可用、動態方向 UI 正確、子路線與車輛配對未退步、缺 ETA 語意正確、相關測試與工具鏈通過，以及具體裝置／瀏覽器驗收完成。外部缺口須明確列出，不用「全部完成」掩蓋。

臺鐵停駛與捷運新增系統目前沒有要求前端新增必填欄位：前端沿用後端結果即可。後端停駛處理只涵蓋班表解析與班次配對，不能據此宣稱所有 OTP 靜態行程已排除停駛。正式捷運資料是否已匯入也須另行查證。

## 8. 參考與文件查證狀態

- [TDX 官方公車 OpenAPI：Direction 定義](https://tdx.transportdata.tw/webapi/File/Swagger/V3/2998e851-81d0-40f5-b26d-77e2f5ac4118)。
- 後端 schema 生成的 `/api/v1/openapi.json` 是請求欄位依據；本契約沒有新增或更改端點。
- App、Web 檔案入口與缺值顯示、方向 parser／選單，已於 2026-10-05 以工作樹原始碼核對。
- 本次交付只有這份 Markdown；未修改前端原始碼，未將上述驗收矩陣當作已執行結果。
