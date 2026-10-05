# 實作計劃：即時路況城市覆蓋修正（台中無顏色 / NewTaipei 400）

- 狀態：**待使用者核准**（第 4 版）。Codex 審核兩輪、共 4 條 BLOCKING 全部採納並修正
  （依制度往返上限兩輪，不送第三輪）；另經 fresh-context 驗收者逐條回查 12 組事實主張，
  11 條 PASS、1 條 FAIL（漏掉 `smoke-tdx-traffic.ts` 這個 Live 呼叫點），已補進第 3.6 節。
- 日期：2026-09-05
- 類型：Bug fix（設定預設值 + 目標清單過濾 + 刷新批次化）

---

## 1. 問題與根因（已在執行中的容器上實測）

**回報症狀**：使用者規劃台中市的開車路線時，`leg.trafficSegments` 全部是 `unknown`，前端畫不出交通顏色。

**根因（已證實）**：`src/config/traffic.ts:106` 的 `TRAFFIC_TARGET_CITIES` 預設值是 `"Taipei,NewTaipei"`，
且 `.env` / 容器環境都沒有覆寫（`docker compose exec backend printenv` 無 `TRAFFIC_*`；`.env` 無此行）。
即時路況的三個消費端都只讀「這份清單 + Freeway + Highway」：

- `src/modules/traffic/traffic-flow.service.ts:146`（`getLiveSectionsForBbox`，請求路徑）
- `src/modules/traffic/traffic-live.worker.ts:7`（`refreshTargets`，每分鐘背景刷新）
- `src/modules/traffic/valhalla-traffic.worker.ts:162`（`collectSectionSpeeds`）

因此台中的 244 個路段從來沒有被抓過即時資料，`congestionLevel` 恆為 `-99`。

**證據**

| 檢查 | 結果 |
| --- | --- |
| `GET /api/v1/traffic/flow?city=Taichung` | `count: 244`、`levelCounts: {"-99": 244}`、`liveUpdatedAt: null` |
| TDX `GET /v2/Road/Traffic/Live/City/Taichung` | HTTP 200，244 筆，`SectionID: m10303`、`TravelTime: 189` |
| Mongo 幾何的台中 sectionId | `m10303`、`m10304`…**與 TDX Live 的 SectionID 同格式**，接上即可對應 |
| 台中同起訖點連打兩次 `/a11y/accessible-route` | 兩次結果完全相同（`unknown:-99` + `light:1`），**「請求兩次才有顏色」無法重現**；零星彩色段來自 `Highway` 目標（台74 等），與請求次數無關 |
| 冷啟動空窗 | `Server is running 14:50:53.968` → `geometry index ready 14:50:54.529`，僅 560ms，非本 bug 成因 |

**同時證實的第二個缺陷**：預設清單裡的 `NewTaipei` 對 Live 端點是無效值。

```
GET /v2/Road/Traffic/Live/City/NewTaipei → HTTP 400
{"Message":"City: 'NewTaipei' is not accepted but YilanCounty, ChanghuaCounty,
 YunlinCounty, PingtungCounty, Keelung, Taipei, Taichung, Tainan, Taoyuan"}
```

後果：背景 worker 每分鐘固定浪費一次必敗呼叫（12 小時日誌每分鐘一筆），
且 `getLiveSectionsForBbox` 每次讀到 `failed` 就 `scheduleLiveRefresh("NewTaipei")`，
**每個路線請求都再多打一次必敗的 TDX**，純燒配額。

程式裡既有的 `TDX_SUPPORTED_CITIES`（12 個）是 **Section / CongestionLevel** 的支援清單，
被誤當成 Live 也支援；Live 只接受上列 **9 個**（無 NewTaipei、Kaohsiung、HsinchuCounty）。

**實測各目標 Live 資料量（2026-09-05）**

| 目標 | rows | bytes | ms |
| --- | ---: | ---: | ---: |
| Taipei | 1056 | 353 KB | 94 |
| Taoyuan | 732 | 248 KB | 71 |
| Taichung | 244 | 87 KB | 62 |
| PingtungCounty | 88 | 47 KB | 77 |
| YilanCounty | 46 | 20 KB | 60 |
| YunlinCounty | 41 | 15 KB | 85 |
| Tainan | 32 | 11 KB | 31 |
| Keelung | 3 | 1 KB | 25 |
| ChanghuaCounty | 0 | 0.2 KB | 25 |
| Freeway | 680 | 358 KB | 146 |
| Highway | 6652 | 2.6 MB | 417 |

啟用全部 9 個城市後，每請求合併的 `liveSectionsMap` 從 8388 筆增為 9574 筆（+14%），
記憶體與合併成本增幅可忽略（現況 `plan.traffic.loadLive` 為 2–16ms）。

---

## 2. 範圍

### 做

1. 新增 Live 端點專用的支援城市常數，與 `TDX_SUPPORTED_CITIES`（Section 用）分離。
2. `TRAFFIC_TARGET_CITIES` 預設值擴大到涵蓋台中等 Live 支援城市。
3. 三個即時路況消費端改用「過濾掉 Live 不支援城市」後的清單，徹底消除 `NewTaipei` 的 400。
4. `refreshAllLiveTraffics` 由全並發改為小批次，避免目標數 4 → 11 後撞 TDX 429。
5. 更新受影響的既有測試 + 新增針對過濾與批次的單元測試。
6. 更新 `.env.example` 的 `TRAFFIC_TARGET_CITIES` 範例值。
7. `src/scripts/smoke-tdx-traffic.ts` 的 **Live** 探測改跳過 Live 不支援的城市（fresh-context 驗收補抓）。

### 不做（明確排除，禁止順手做）

- 不改 `getLiveSectionsForBbox` 忽略 `_bbox`、全城市合併的既有設計（可改進但非本 bug）。
- 不改 road-incident 的城市選擇邏輯，**不修** 日誌中 `Freeway` / `Highway` / `HsinchuCounty`
  road events 回 400 的既有問題（那是 `findCitiesIntersecting` 會回傳偽城市，另案處理）。
- 不改 `TDX_SUPPORTED_CITIES` 的內容與 `traffic.schema.ts` 的 `TrafficCityEnum`（對外 query 參數契約不變）。
- 不改任何評分、路線規劃、overlay 比對演算法。
- 不新增資料匯入、不動 Mongo 幾何資料。
- 不重構 `SingleFlight`、快取封裝或 SWR 語意。

---

## 3. 檔案清單與變更內容

### 3.1 `src/config/traffic.ts`（主要變更）

1. 在 `TDX_SUPPORTED_CITIES` 之後新增：

```ts
/**
 * Cities accepted by the TDX Road/Traffic **Live** endpoint. Verified 2026-09-05 by
 * calling /v2/Road/Traffic/Live/City/{city}; NewTaipei, Kaohsiung and HsinchuCounty are
 * rejected with HTTP 400 even though Section/CongestionLevel accept them.
 */
export const TDX_LIVE_TRAFFIC_CITIES = [
  "Taipei",
  "Taoyuan",
  "Taichung",
  "Tainan",
  "Keelung",
  "YilanCounty",
  "ChanghuaCounty",
  "YunlinCounty",
  "PingtungCounty",
] as const;
```

2. `TRAFFIC_TARGET_CITIES` 預設值改為：

```
"Taipei,NewTaipei,Taoyuan,Taichung,Tainan,Keelung,YilanCounty,ChanghuaCounty,YunlinCounty,PingtungCounty"
```

保留 `NewTaipei`：它對 **LiveEvent（事件）** 端點有效（實測 HTTP 200），
road-incident 的 fallback 仍需要它；只有 Live 目標需要排除它。

3. 新增衍生匯出（即時路況專用目標）：

```ts
/**
 * Subset of TRAFFIC_TARGET_CITIES the live-traffic endpoint actually serves.
 * Cities outside TDX_LIVE_TRAFFIC_CITIES are dropped here instead of burning a
 * guaranteed-400 TDX call on every refresh tick and every route request.
 */
export const TRAFFIC_LIVE_TARGET_CITIES: readonly string[] =
  TRAFFIC_TARGET_CITIES.filter((city) =>
    (TDX_LIVE_TRAFFIC_CITIES as readonly string[]).includes(city),
  );
```

4. 模組載入時，若有城市被濾掉，以 `console.warn` 記錄一次（列出被丟掉的城市），避免設定錯誤靜默。

5. 新增批次設定到 `TRAFFIC_REFRESH`：

```ts
liveRefreshBatchSize: envPositive("TRAFFIC_LIVE_REFRESH_BATCH_SIZE", 3),
liveRefreshBatchGapMs: envPositive("TRAFFIC_LIVE_REFRESH_BATCH_GAP_MS", 400),
/**
 * Per-target wall-clock ceiling for one refresh attempt inside the worker.
 * Literal default (TRAFFIC_FETCH_TIMEOUT_MS 8s + 2s margin) on purpose: this object is
 * declared at line 125 and TRAFFIC_FETCH_TIMEOUT_MS at line 210, so referencing the
 * latter here throws a TDZ ReferenceError at module load.
 */
liveRefreshTargetTimeoutMs: envPositive(
  "TRAFFIC_LIVE_REFRESH_TARGET_TIMEOUT_MS",
  10_000,
),
```

> **實作鐵律（第 2 輪審核抓到）**：`liveRefreshTargetTimeoutMs` 的預設值**不得**寫成
> `TRAFFIC_FETCH_TIMEOUT_MS + 2_000`。`TRAFFIC_REFRESH` 宣告在 `src/config/traffic.ts:125`，
> 而 `TRAFFIC_FETCH_TIMEOUT_MS` 宣告在第 210 行，先用後宣告會在模組載入時直接丟
> TDZ `ReferenceError`，整個 app 起不來。要嘛用字面值 `10_000`（本計劃採用），
> 要嘛把 `TRAFFIC_FETCH_TIMEOUT_MS` 移到 `TRAFFIC_REFRESH` 之前——不要兩者都不做。

### 3.2 `src/modules/traffic/traffic-live.worker.ts`

- `refreshTargets()` 改用 `TRAFFIC_LIVE_TARGET_CITIES`（＋ `Freeway`、`Highway`）。
- `refreshAllLiveTraffics()`：把 `Promise.allSettled(targets.map(...))` 改為
  **依 `liveRefreshBatchSize` 分批**，批次之間 `await` `liveRefreshBatchGapMs` 毫秒。
  批內仍並發，結果彙總方式與計數語意（`refreshed` = fulfilled 數）維持不變。

**時間上界（審查意見修正，2026-09-05）**

初版計劃寫「最壞 4 × 8s ≈ 33.2s」是**錯的**：`src/adapters/tdx.adapter.ts:45` 的 token 取得
`fetch()` **沒有帶 `signal`**，`TRAFFIC_FETCH_TIMEOUT_MS` 只約束資料請求、不約束 token 請求，
所以單一目標的刷新時間本來就無上界；批次化又把原本並發的等待串起來，一個卡住的 token 請求
會拖垮整輪。若一輪超過鎖 TTL 50s，下一個 60s tick 會拿到已過期的鎖並與前一輪重疊。
因此必須在 worker 內建立**真正的**上界，用兩道機制：

1. **每目標硬上界**：worker 內把每個 `refreshCityLiveTraffics(target)` 包進
   `Promise.race([call, timer(liveRefreshTargetTimeoutMs)])`。逾時者本輪計為失敗；
   底層 promise 繼續跑並可照常寫快取，`liveTrafficFlight`（`SingleFlight`）保證不會重複打 TDX。
   實作上限先做 clamp：`effectiveTargetTimeout = Math.min(liveRefreshTargetTimeoutMs, roundDeadlineMs)`。
2. **整輪截止線**：`roundDeadlineMs = lockTtlSec * 1000 * 0.9`（預設 45s）。
   每個批次**開始前**檢查 `elapsed + effectiveTargetTimeout > roundDeadlineMs`，成立就不再啟動新批次，
   把剩餘目標記為 skipped 並寫進既有的 `live refresh completed` 日誌（新增 `skipped` 欄位）。
   第一個批次一律會啟動（避免設定錯誤造成整輪什麼都不做）。
3. **批次間隔也必須受截止線約束**（第 2 輪審核抓到）：批次之間不可無條件
   `await sleep(liveRefreshBatchGapMs)`——`TRAFFIC_LIVE_REFRESH_BATCH_GAP_MS` 被設成大於 60s 時，
   光是等待就會讓整輪超過鎖 TTL。實作為
   `const remaining = roundDeadlineMs - elapsed;`
   `if (remaining <= effectiveTargetTimeout) break;`
   `await sleep(Math.min(liveRefreshBatchGapMs, remaining - effectiveTargetTimeout));`
   亦即睡眠時間永遠不會把整輪推過截止線。

保證：一輪的 wall-clock ≤ `roundDeadlineMs`（45s）< 鎖 TTL 50s < 刷新間隔 60s，
**與 `TRAFFIC_FETCH_TIMEOUT_MS`、批次大小、批次間隔被環境變數放大到多少無關**。

**併發防護的正確歸屬**（第 2 輪審核修正）：`SingleFlight` 只是 **process-local** 的，
它保證的是同一個 Node 程序內同一目標不會重複打 TDX；**跨實例**的重複刷新一律由
`redisSetNx(TRAFFIC_REFRESH.lockKey)` 這個分散式鎖負責，這也正是本計劃要求整輪 wall-clock
必須小於鎖 TTL 的原因——鎖若在一輪還沒跑完就過期，跨實例保護就沒了，`SingleFlight` 補不了。
目前部署為單一 backend 實例，但這個設計不依賴那個前提。

實測正常情況：11 目標序列總計約 1.1s，加上 3 次批次間隔 ≈ 2.3s。

**明確不做**：不替 `src/adapters/tdx.adapter.ts` 的 token `fetch()` 補 timeout。
那是全域 TDX 呼叫路徑（公車、軌道、路況都吃它）的行為變更，超出本 bug 範圍；
上面的 worker 層上界已足以保護本功能。此缺口在此記錄，另案處理。

### 3.3 `src/modules/traffic/traffic-flow.service.ts`

- `getLiveSectionsForBbox()`（第 141 行起）的 `targets` 改用 `TRAFFIC_LIVE_TARGET_CITIES`。
  其餘 SWR / `scheduleLiveRefresh` 行為完全不變。

### 3.4 `src/modules/traffic/valhalla-traffic.worker.ts`

- `collectSectionSpeeds()`（第 162 行）的 `targets` 改用 `TRAFFIC_LIVE_TARGET_CITIES`。
  其餘打包邏輯不變。

### 3.5 `.env.example`

- 第 98 行 `TRAFFIC_TARGET_CITIES=Taipei,NewTaipei` 改為新的預設 10 城字串，
  並補一行註解說明「Live 只服務其中 9 個，NewTaipei 只用於事件查詢」。

### 3.6 `src/scripts/smoke-tdx-traffic.ts`（fresh-context 驗收補抓的遺漏）

`parseCities()`（第 51 行）在沒有 `--cities=` 參數時直接回傳未過濾的 `TRAFFIC_TARGET_CITIES`，
而 `PROBES` 第一項（第 34 行）就是 Live 端點。預設值從 2 城擴為 10 城之後，這支診斷腳本會
對 `NewTaipei` 打 Live 並報一個**預期內**的 400，把真實故障淹沒在假紅字裡。

- 改法：`Live` 這一項探測前先過濾，城市不在 `TDX_LIVE_TRAFFIC_CITIES` 內就輸出
  `SKIP (Live 不支援)` 並跳過，不發請求、不計為失敗。其他四個 probe（Section、SectionShape、
  CongestionLevel、LiveEvent）維持原樣，它們接受的城市範圍不同。
- 不改該腳本的其他行為。注意預設城市變多後這支腳本的總探測數從 5×2 變 5×10，
  需要縮小範圍時用既有的 `--cities=` 參數，**不要**在本次順手加節流。

### 3.7 測試

- `src/modules/traffic/traffic-live.worker.test.ts`
  - 既有斷言 `expect(mockedRefreshCity).toHaveBeenCalledWith("NewTaipei")`（第 45 行）
    與 `refreshed >= 3` 的註解編碼了目前的錯誤行為，**必須更新**為：
    有呼叫 `Taichung`、`Freeway`、`Highway`；**沒有**呼叫 `NewTaipei`。
  - 新增：目標數大於批次大小時，仍會呼叫到全部目標且 `refreshed` 等於目標數（可用 fake timer 或
    把 gap 設 0 以避免測試變慢）。
  - 新增（上界保證，必測）：某個目標的 `refreshCityLiveTraffics` 回一個**永不 resolve** 的 promise 時，
    `refreshAllLiveTraffics()` 仍會在 `roundDeadlineMs` 內結束、把該目標計為失敗，
    且不會卡住後續批次。用 vitest fake timers 推進時間，不要真的等。
  - 新增：整輪截止線觸發時，回傳與日誌含 `skipped` 數，且第一個批次一定被啟動。
  - 新增（第 2 輪審核要求）：把 `TRAFFIC_LIVE_REFRESH_BATCH_GAP_MS` 設成大於 `roundDeadlineMs`
    的值時，整輪仍在 `roundDeadlineMs` 內結束（證明批次間隔有被截止線夾住）。
- `src/config/traffic.ts` 的模組載入本身即是 TDZ 迴歸測試：任何既有測試 import 該檔就會炸，
  故不需另寫；但實作者必須實跑 `pnpm test` 確認，不得只看型別。
- 新增 `src/config/traffic.test.ts`（若已存在則附加）：
  - `TRAFFIC_LIVE_TARGET_CITIES` 不含 `NewTaipei`、含 `Taichung`。
  - `TRAFFIC_LIVE_TARGET_CITIES` 為 `TRAFFIC_TARGET_CITIES` 的子集合。
- `src/modules/traffic/traffic-flow.service.test.ts`：若有斷言目標城市數量或名稱，一併更新。

---

## 4. 行為 / 資料契約

- **對外 API 形狀完全不變**：`/a11y/accessible-route` 的 `leg.trafficSegments`、
  `leg.trafficLevel`、`leg.durationInTrafficMin` 欄位與型別不變；
  `/traffic/flow`、`/traffic/incidents` 的回應形狀不變。
- **唯一的對外行為變化**：先前恆為 `unknown` 的 8 個縣市（台中、桃園、台南、基隆、宜蘭、
  彰化、雲林、屏東）路段，現在會回真實 `congestionLevel`（1–6 / -1），
  `trafficSegments` 會出現彩色分段，`trafficLevel` 與 `durationInTrafficMin` 也會隨之改變。
  這正是本次要修的目標行為。
- **New Taipei 不變**：Live 不支援，仍為 `unknown`；差別只在不再每分鐘與每次請求打必敗的 400。
- **`TrafficCityEnum`（`/traffic/flow?city=` 的允許值）不變**，仍是 12 個城市。

---

## 5. 失敗行為

- 任一城市 TDX 呼叫失敗：維持既有 `setLiveTrafficsFailure` + `CACHE_FAILED`（15s）語意，
  其他城市不受影響（批次內用 `Promise.allSettled`）。
- 全部城市失敗：`liveSectionsMap` 為空 → 全部 `unknown` → 前端無顏色，與今日的降級行為一致，
  不得丟例外、不得讓路線規劃失敗。
- `TRAFFIC_LIVE_TARGET_CITIES` 為空（例如 operator 只設了 Live 不支援的城市）：
  仍會刷新 `Freeway` / `Highway`，不得因空陣列而丟錯。
- 單一目標逾時（含 TDX token 請求卡住）：該目標本輪計為失敗，其餘目標照跑，
  `refreshAllLiveTraffics()` 仍在 `roundDeadlineMs` 內回傳；快取沿用舊值直到 hard TTL（300s）到期。
- 整輪撞到截止線：剩餘目標本輪不刷新，只記 `skipped`，等下一個 60s tick；
  不得為了補完而延長本輪，否則會與下一輪重疊。

---

## 6. 驗證

### 自動化

```bash
pnpm test                # vitest 全綠（現況基準：需先記錄修改前的通過數）
pnpm build               # 含 lint:arch，模組循環與型別一起把關
```

### 真實環境（必做，green gates 不等於功能好了）

```bash
docker compose up -d --build backend      # 程式碼編進 image，只重啟不會生效
docker compose logs backend -f | grep '\[traffic\]'
```

驗收條件：

1. 日誌不再出現 `Upstream TDX error for NewTaipei live traffic: HTTP 400`。
2. 出現 `live refresh completed {"refreshed":11,"total":11,"skipped":0}`（或等於實際目標數）。
3. `curl 'http://127.0.0.1:8000/api/v1/traffic/flow?city=Taichung'` →
   `liveUpdatedAt` 不為 null，`levelCounts` 的 `-99` 明顯少於 244。
4. 台中路線（台中車站 24.1369,120.6850 → 逢甲大學 24.1794,120.6465，`travelMode: "drive"`）
   的 `leg.trafficSegments` 出現 `-99` 以外的 `congestionLevel`。
5. 台北路線行為不退步（同起訖點修改前後 `matchedSections` 與彩色分段數量相當）。
6. `plan.traffic.loadLive` 沒有明顯劣化（現況 2–16ms，可接受到 50ms 以內）。

---

## 7. 假設

- TDX 帳號對這 11 個目標每分鐘各一次呼叫不會觸發配額上限。
  依據：實測 11 次連續呼叫（間隔 2.5s）全部 200；且既有 4 目標並發長期穩定。
  批次化就是為了保守處理這個假設。
- 台中等縣市的 Mongo 幾何 `sectionId` 與 Live 的 `SectionID` 對得上。
  依據：兩邊都出現 `m10303`（已比對）。其餘縣市未逐一比對，若某縣市對不上，
  結果只是維持 `unknown`，不會比現在更差。
- `.env` 目前沒有 `TRAFFIC_TARGET_CITIES`，改預設值即會生效（已用 `printenv` 確認）。

---

## 8. 回滾

單一 commit，回滾方式：`git revert <sha>` 後 `docker compose up -d --build backend`。
不需要資料遷移、不動任何持久化資料。
若只想暫時退回舊行為而不改程式：在 `.env` 設
`TRAFFIC_TARGET_CITIES=Taipei,NewTaipei` 並重啟容器即可。
