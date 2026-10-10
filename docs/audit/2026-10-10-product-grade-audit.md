# Accessible Smart Map Backend 產品級工程稽核

- 日期：2026-10-10（Asia/Taipei）
- Repo：`/Volumes/KINGSTON/yuzen/local/project/taipei-accessible-backend`
- 基線：`main` / `74fa324d08a10f2152741b03ad7e3135152d5220`
- 稽核者：Codex 主流程與三個分面向唯讀審查者；主流程重跑探針、複讀原碼並完成引用驗證。
- 性質：只審不修。原始工作目錄乾淨；沒有修改應用程式、既有測試、設定或 lockfile。
- 範圍：全 repo 盤點，重點追查 HTTP/WebSocket 入口、帳號與綁定、SOS、評論、AI/memory、hazard/retention、交通與導航、外部 adapters、資料匯入及 CI。不是逐行閱讀每一份來源、資料集和歷史文件的保證。

## 0. 一頁摘要

**已有產品工程基礎，但目前仍有應先修正的可靠性與資料一致性問題。** 模組分層、strict TypeScript、Zod、真實 Mongo 整合測試、coverage gate 都有實作；三個關鍵授權／狀態突變均被既有測試攔截。然而正常測試全綠仍漏掉 SOS 通知失敗、不可搭乘公車、綁定競態、資料匯入清空，以及外部服務恢復後仍持續失效等情境。

本輪確認 **15 項：P1 9 項、P2 6 項；沒有已確認的 P0**。這不是「沒有其他漏洞」的保證。P1 指需要優先修正的核心行為或發布 gate 問題，並不表示已在正式環境發生事故。先修 SOS 通知、路線可搭性與 LINE 綁定的一致性；接著處理匯入保護、壓縮套件與上游恢復。型別 gate 可平行修復。

| 面向 | 現況 | 判讀與下一步 |
| --- | --- | --- |
| 架構 | router/controller/service/repository 分層與自動檢查存在且 build 通過 | 保留現有結構；將 AI tools 的跨領域 model 寫入收回領域服務，見 P2-06 |
| API 契約 | Zod 與 OpenAPI、共同 response helper 已接線；二進位/SSE 是必要例外 | memory null、cursor 與通知狀態仍有語意不一致，見對應發現 |
| 資料完整性 | 有 lease/fence、投票原子條件、session rotation CAS | 評論衍生值、一次性碼與 snapshot 替換仍未完整原子化 |
| 效能與恢復 | 有 bounded cache、部分 timeout/circuit breaker | Voice 串行 DB 驗證、TDX rejected promise、Google 負快取形成具體問題 |
| 測試可信度 | Mongo 整合測試確有真實資料庫；三個突變被殺死 | 有效但不完備，應增加故障與併發情境，不能以 coverage 代替行為驗證 |
| 風格與型別 | Prettier 通過、ESLint 0 errors / 931 warnings；strict=true | 警告包括測試與工具，不等於 931 個 BUG；優先修 34 個實際 typecheck errors |
| 資安與隱私 | 照片 ownership、session 撤銷與 intake 隔離可驗證 | LINE 綁定競態與 compression 資源問題仍需處理；正式環境未測 |
| 錯誤處理 | HTTP 終端 error handler 存在；access log 使用路由模板避開 query/share token | SOS 的錯誤被吞成成功語意、Google 故障被當輸入錯誤，是優先修正的契約問題 |

## 1. 事實基線

所有正式發現先落成 repo 外 `findings.json`，再執行 `verify_findings.py --strict`：**15 通過、0 行號漂移、0 不合格，exit=0**。報告第 2 節僅由該次 `findings.verified.json` 產生；引用檢查之外，主流程還逐條核對邏輯與重跑探針。

| ID | 命令／方法 | 結果 |
| --- | --- | --- |
| B01 | `git status --porcelain`、`git rev-parse HEAD` | 開工乾淨；HEAD 如上 |
| B02 | `pnpm build` | **exit=0**；包含 `lint:arch` 與 production tsc |
| B03 | `pnpm typecheck` | **exit=1**；34 個 `error TS`，集中 hazard AI job 與 retention integration tests |
| B04 | `pnpm lint` | **exit=0**；0 errors、931 warnings |
| B05 | `pnpm format:check` | **exit=0**；All matched files use Prettier code style |
| B06 | `TZ=UTC pnpm test --maxWorkers=4` | **exit=0**；251 files passed、7 skipped；3,473 tests passed、17 skipped；50.47 秒 |
| B07 | `TZ=UTC pnpm test:coverage --maxWorkers=4 --coverage.reportsDirectory=<repo外>/coverage` | **exit=0**；相同測試數；statements 82.76%、branches 73.99%、functions 83.48%、lines 84.81%；52.44 秒 |
| B08 | `PYTHONDONTWRITEBYTECODE=1 pnpm test:python` | **exit=1**；13/14 test entrypoints 通過；build-ped-graph.test.py 有 3 個缺 `shapely` 的 import error |
| B09 | `pnpm audit --audit-level high --json` | **exit=1**；metadata 回報 critical=1、high=3、moderate=12。這是工具統計，不是已驗證可利用漏洞數 |
| B10 | `repo_scan.sh .`、`test_forensics.py .` | 皆 exit=0；只作候選索引，正則估計未直接當結論 |
| B11 | 附錄各 probe：routing / review / voice / SOS / data / import / compression | 主流程全部重跑 exit=0；輸出見各發現；exit=0 表示探針成功執行並重現問題 |
| B12 | repo 外 HEAD 副本單項突變 | photo 1 failed/19 passed；intake 1 failed/8 passed；session 3 failed/7 passed；三次皆 exit=1，均已還原 |
| B13 | 還原副本後三份相關測試 | 3 files / 39 tests passed，exit=0；逐檔 bytes 與原始副本一致 |
| B14 | `verify_findings.py findings.json --strict --out findings.verified.json` | exit=0，15/15 |

測試執行時移除程序的 `PED_GRAPH_DATABASE_URL`、`PED_GRAPH_TEST_DATABASE_URL`、`REDIS_URL`、`DATABASE_URL`，避免依賴既有外部環境；完整測試另外移除 `MONGO_URL`、`MONGODB_URI`。未載入 `.env`，未啟動正式 server，Mongo 測試使用 harness 啟動的新程序與隨機資料庫。

本機 Node 是 `v26.6.0`，CI 指定 Node 22；Python 是 3.14。未把本機工具結果冒充遠端 CI 結果。`shapely` 已列在 `requirements-test.txt`，CI 也有安裝步驟，故 B08 是本機驗證缺口，沒有列成程式缺陷。

風格警告人工抽讀包含 `src/adapters/embedding.adapter.ts`、`src/adapters/google.adapter.ts`、`src/adapters/google.adapter.test.ts` 與 browser fixture：屬 `any` 與 non-null assertion。未把測試替身用 `any` 全部當成業務程式缺陷。Prettier 與 ESLint 已接在 CI，`.husky/pre-commit` 執行 `pnpm exec lint-staged`，沒有必要為統一縮排重寫架構。

## 2. 已驗證發現

同級先考量核心使用流程、影響面與修復依賴；未以主觀風格偏好當發布阻擋。每條含來源當下的實際引文，可直接查閱。

### P1-01 — SOS 初始通知的 LINE 呼叫失敗後仍回報 notifiedCount，重試建立不會補送通知

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/app.ts:149` | `app.use("/api/v1/sos", createSosRouter());` |
| `src/modules/sos/sos.router.ts:23` | `"/sessions",` |
| `src/modules/sos/sos.service.ts:235` | `{ type: "notified", actorType: "system", at: now },` |
| `src/modules/sos/sos.service.ts:246` | `const notifiedCount = await sendSosNotification(lineUserIds, {` |
| `src/adapters/line.adapter.ts:665` | `console.error("[line.adapter] sendSosNotification failed", err);` |
| `src/adapters/line.adapter.ts:667` | `return lineUserIds.length;` |
| `src/modules/sos/sos.service.ts:265` | `const existing = await findActiveSessionByUser(input.userId);` |
| `src/modules/sos/sos.service.ts:267` | `const notifiedCount = (await boundLineUserIds(input.userId)).length;` |

**驗證方式**：真實 isolated Mongo、SOS service/repository、LINE adapter；只將 LINE SDK multicast 替換成拋出故障，push service 替換成 no-op。建立一名已綁定聯絡人後連續 createSession 兩次。

**結果**：

```text
exit=0
[line.adapter] sendSosNotification failed Error: injected provider unavailable
{"first":{"http":201,"notifiedCount":1},"retry":{"http":200,"notifiedCount":1},"providerAttempts":1}
```

**影響**：求助者得到已通知人數且 timeline 已標 notified，但 LINE 未接受通知；客戶端重試同一 active session 也沒有補送。此缺陷作用於求助通知的核心可靠性。

**修復方向**：將初始 SOS 通知寫入可重試的 durable delivery state/outbox，成功接受後才標記已通知；回應區分 queued/accepted/failed，重試 create 應回報既有 delivery state。可沿用現有 auto-resolve notice 的 lease/retryKey 模式。

**驗收方式**：注入首次 multicast 失敗、程序重啟與重試；狀態不得誤報 sent，worker 能補送且使用穩定 retry key 避免重複；既有 active session 的回應與持久狀態一致。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/auth-audit.djPi3r/sos-probe.cjs
```

### P1-02 — 即時公車 overlay 忽略上車前步行時間，把可行班次替換為乘客抵站前已開走的班次

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/app.ts:152` | `app.use("/api/v1/a11y", createAccessibleRouteRouter());` |
| `src/modules/accessible-route/accessible-route.router.ts:15` | `"/accessible-route",` |
| `src/modules/accessible-route/accessible-route.controller.ts:60` | `const result = await planAccessibleRouteForHttp({` |
| `src/modules/accessible-route/accessible-route.service.ts:2531` | `const result = await planAccessibleRouteFromRequest(body);` |
| `src/modules/accessible-route/accessible-route.service.ts:2256` | `const transit = await findAccessibleRoutesDetailed(` |
| `src/modules/accessible-route/accessible-route.service.ts:3327` | `const routes = await finalizeRoutes(` |
| `src/modules/accessible-route/accessible-route.service.ts:1354` | `await overlayRealtimeTransit(top);` |
| `src/modules/accessible-route/planners/realtime-transit.ts:1093` | `route._scheduledDepartureTime <= now + MAX_DEPARTURE_SKEW_MS,` |
| `src/modules/accessible-route/planners/realtime-transit.ts:270` | `return route.legs.find((l) => l.type !== "WALK");` |
| `src/modules/accessible-route/planners/realtime-transit.ts:332` | `leg.departureTime = secondsToHHmm(nowSec + etaSec);` |
| `src/modules/accessible-route/planners/realtime-transit.ts:388` | `shiftLegToLiveEta(leg, pick.est);` |
| `src/modules/accessible-route/accessible-route.service.ts:1380` | `return top;` |

**驗證方式**：實際 overlayRealtimeTransit 與 taipei-time、tdx-bus-eta、gtfs-time 原碼於隔離 VM 執行；只 mock 上游和持久層。合法 WALK leg minutesEst=10，10:00 出發、排定 10:12 公車，TDX ETA=60 秒；輸出改為 10:01 上車而步行抵站為 10:10。HTTP → planAccessibleRouteForHttp → FromRequest → findAccessibleRoutesDetailed → finalizeRoutes → overlay 的呼叫鏈已確認。OTP 的 _scheduledDepartureTime 取 it.legs[0].startTime（otp-routing.ts:1993-1996），故正在開始步行的路線滿足 <= now+15分鐘 條件。overlay 後僅 rerank/slim，未重新做班次可搭性檢查。

**結果**：

```text
BUS {"now":"10:00","walkArrivalAtStop":"10:10","busDeparture":"10:01","busArrival":"10:19","wait":{"time":1,"source":"realtime"},"totalMinutes":29}
exit=0
```

**影響**：回傳無法實際搭上的公車時刻與低估總時間，並把該車低地板證據套到路線；會直接影響依賴無障礙路線的乘客。

**修復方向**：計算首公車前 WALK 累積抵站時間，只採用抵站後可搭乘的同路線班次；ETA 無法提供可搭班次時保留排程或重規劃。從抵站時間計算等待並同步檢查後續轉乘與總時間。

**驗收方式**：10:00 出發、10分鐘步行、ETA 1分鐘時不得選該車；ETA 12分鐘時等待應為2分鐘、總時間與各段相符；增加含轉乘、未來出發與零步行案例。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/product-audit-routing-20261010/probe.cjs
```

### P1-03 — 同一 LINE 帳號綁定碼併發兌換時，兩個不同 LINE 使用者都收到成功，後寫入者覆蓋先前綁定

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/ai/agent-tools.ts:1308` | `const linkCode = await LineLinkCode.findOne({` |
| `src/modules/ai/agent-tools.ts:1333` | `const alreadyLinkedUser = await User.findById(linkCode.userId)` |
| `src/modules/ai/agent-tools.ts:1349` | `await User.updateOne({ _id: linkCode.userId }, { $set: { lineUserId } });` |
| `src/modules/ai/agent-tools.ts:1350` | `await LineLinkCode.deleteOne({ _id: linkCode._id });` |
| `src/modules/line/line-agent.service.ts:58` | `lineUserId: params.lineUserId,` |

**驗證方式**：使用 repo 的 startMongoTest 建立全新 Mongo，直接呼叫真實 bindLineAccountCode。僅於 User.findById().lean() 真實讀取完成後加 barrier，使兩請求都先讀到 lineUserId=null，未 mock 資料或更新。兩個不同 LINE userId 同碼併發都回 ok:true。

**結果**：

```text
exit=0; BIND_RACE results=[{ok:true,bound:true},{ok:true,bound:true}], persistedLineUserId=line-user-B, remainingCodes=0（最後贏家受排程影響）。
```

**入口路徑**：src/modules/line/line.router.ts:21 POST /webhook 經 LINE signature → src/modules/line/line.service.ts:221 runLineAgent → src/modules/line/line-agent.service.ts:56 executeLocalTool 綁定真實 lineUserId → src/modules/ai/agent-tools.ts:2221 bindLineAccountCode dispatch → src/modules/ai/agent-tools.ts:1349 無條件 user 綁定寫入。

**影響**：綁定碼未原子消耗，帳號對 LINE 身分的單次綁定承諾失效；持有同碼的競爭請求可覆寫已向另一人回覆成功的綁定。此結果須兩個不同 LINE 身分持有同一有效碼；不是無碼的任意帳號接管。

**修復方向**：將 code 的消耗與 user 綁定置於同一 Mongo transaction，並在寫入 predicate 加入尚未綁定或已綁定相同 LINE id 條件；只有原子 claim 的贏家可回成功。

**驗收方式**：使用真實隔離 Mongo，同一碼、不同 LINE id 並發兩個 bindLineAccountCode；只能一個成功，失敗者不可改變勝出者身分；另加帳號更新失敗後 code 可重試的交易回滾驗證。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node -r ts-node/register/transpile-only /tmp/backend-audit-VOKIiX/data-probe.cjs
```

### P1-04 — 快照匯入在零筆合法資料時仍刪除現有集合並成功結束

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/scripts/import-bathrooms.ts:94` | `const del = await BathroomModel.deleteMany({});` |
| `src/scripts/import-bathrooms.ts:99` | `for (let i = 0; i < docs.length; i += CHUNK) {` |
| `src/scripts/import-a11y-metro.ts:48` | `const del = await A11y.deleteMany({});` |
| `src/scripts/import-a11y-metro.ts:61` | `await mongoose.disconnect();` |
| `src/scripts/sync-all-data-plan.ts:198` | `// --- snapshot: deleteMany({}) then insert` |

**驗證方式**：無正式 DB I/O，執行原 script 的控制流程；模型替身只記錄 delete/insert 順序。

**結果**：

```text
兩支實際 script 在 VM 執行、fs/Mongo 使用替身：input=header-only CSV; beforeRows=1; afterRows=0; insertCalls=0; exit=0。
```

**影響**：執行 pnpm import:bathrooms 或 pnpm import:a11y-metro 時，可讀但只有標頭，或解析後零筆合法資料的來源會先清空現有資料。有效資料的分批 insert 失敗也沒有回滾。data:sync 的 snapshot 明確為 opt-in，且事後非空檢查可偵測失敗，但不能還原已刪除資料；不是預設 base 同步就會清空。

**修復方向**：刪除前驗證資料非空與完整性；以 staging collection 驗證後切換，或基於穩定來源 key 的 upsert/版本切換。保留原資料直到新快照完整成功。

**驗收方式**：header-only、全部 row invalid、第二批寫入故障都須非零結束且舊集合不變；有效快照可完整切換。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/backend-audit-VOKIiX/import-probe.cjs
```

### P1-05 — HTTP 全域使用受公告影響的 compression 1.8.1，客戶端提前斷線後壓縮串流未關閉

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `pnpm-lock.yaml:1479` | `compression@1.8.1:` |
| `src/app.ts:71` | `  compression({` |
| `src/app.ts:80` | `return compression.filter(req, res);` |

**驗證方式**：核對實際安裝版本、lockfile、全域 middleware 與維護者公告；真實 express/http/compression，僅攔截 createGzip 觀察並於最後主動清理。 Probe 使用 threshold:0 與未結束的 streaming JSON；未直接量測正式 app 的完整端點。

**結果**：

```text
pnpm audit exit=1；安裝版本 compression=1.8.1；localhost 提前斷線 probe exit=0: afterClientDisconnect=[{destroyed:false,closed:false,writableEnded:false}]。
```

**影響**：符合 compression filter、大小與 Accept-Encoding 條件的非 SSE 回應會通過全域 compression。已發布公告說明提前斷線會留下原生 zlib 資源並耗盡記憶體；此輪以一個本機連線確認串流未回收，沒有對正式服務做負載攻擊。

**修復方向**：將 compression 升至公告修補版本 1.8.2 或更新的相容版本，更新 pnpm-lock.yaml；同時處理 audit 所列其餘依賴並逐條核對可達性。

**驗收方式**：同一 disconnect probe 應看到 stream destroyed/closed；一般 JSON 壓縮仍生效，SSE 仍即時送出，pnpm audit high gate 通過。

外部依據：[維護者安全公告](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95)。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
pnpm audit --audit-level high --json
node /tmp/backend-audit-VOKIiX/compression-probe.cjs
```

### P1-06 — TDX token 的暫時網路或 JSON 解析錯誤會固定 rejected refreshing Promise，後續 getToken 持續失敗而不重試上游

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/adapters/tdx.adapter.ts:30` | `if (this.refreshing && !force) return this.refreshing;` |
| `src/adapters/tdx.adapter.ts:38` | `this.refreshing = (async () => {` |
| `src/adapters/tdx.adapter.ts:45` | `const res = await fetch(this.tokenEndpoint, {` |
| `src/adapters/tdx.adapter.ts:57` | `const json = (await res.json()) as {` |
| `src/adapters/tdx.adapter.ts:69` | `this.refreshing = null;` |
| `src/config/fetch.ts:17` | `const token = await tdxTokenManager.getToken();` |

**驗證方式**：讀取原始 TypeScript 於隔離 VM transpile 執行，僅替換 fetch 和 process.env 為 fixture；第一次 fetch reject，第二次起若有呼叫即會成功；連呼叫 getToken 3 次只有 1 次 fetch，均回傳同一錯誤。未使用真實憑證/DB/網路。

**結果**：

```text
TDX attempt 1 temporary network failure
TDX attempt 2 temporary network failure
TDX attempt 3 temporary network failure
TDX upstream fetch calls: 1
exit=0
```

**影響**：共用 tdxFetch 在取得 token 前失敗，所有依賴同一程序 token manager 的公車、鐵路、交通等查詢及 worker 在 token 需刷新時持續失效。現有 401 強制刷新在此情境到不了，需程序重啟或其他成功的強制刷新才能恢復。

**修復方向**：將 refreshing 清理放入 try/finally，並以當次 promise 身分避免舊請求清掉新的刷新；為 token fetch 設定 deadline、驗證 payload。

**驗收方式**：首次 fetch 拋 network error 及首次 res.json 拋解析錯誤後，第二次 getToken 應重新 fetch 並成功；並行 getToken 仍只發出一個刷新。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/product-audit-routing-20261010/probe.cjs
```

### P1-07 — Google 座標解析把暫時上游錯誤快取為 null 24 小時，服務恢復後相同地點仍無法解析

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/adapters/google.adapter.ts:46` | `const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;` |
| `src/adapters/google.adapter.ts:179` | `const hit = coordsCache.get(cacheKey);` |
| `src/adapters/google.adapter.ts:181` | `return hit;` |
| `src/adapters/google.adapter.ts:213` | `coordsCache.set(cacheKey, null);` |
| `src/modules/accessible-route/accessible-route.service.ts:2129` | `? getCoordinates(origin)` |
| `src/modules/accessible-route/accessible-route.service.ts:2146` | `status: ResponseCode.INVALID_INPUT,` |
| `src/modules/accessible-route/accessible-route.service.ts:2147` | `error: "無法解析出發地或目的地座標",` |

**驗證方式**：以實際 google.adapter.ts 的 VM 載入與 mock axios；首請求失敗，後續 mock 已可成功。同一地點連查兩次都是 null，axios 只被呼叫一次。TTL 和 null 命中邏輯已逐行確認。

**結果**：

```text
geocode first: null
geocode second after upstream recovered: null
geocode upstream calls: 1
exit=0
```

**影響**：一次 HTTP 429/503 或網路錯誤將正常地點標成無座標，同程序相同 key 在 TTL 內（或 LRU 淘汰前）持續失敗；路線 service 將上游故障回報為 INVALID_INPUT，AI 工具也共用此 adapter。

**修復方向**：只快取成功解析；確定零結果如需負快取使用獨立短 TTL。區分暫時上游失敗與使用者輸入無法解析。

**驗收方式**：503 後上游恢復，以相同 query 重試應得到座標並再次呼叫 provider；真正零結果與 transient error 各有獨立測試。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/product-audit-routing-20261010/probe.cjs
```

### P1-08 — Voice 音訊 frame 在串行資料庫驗證佇列累積，session.end 必須等待前方音訊驗證

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/voice/voice.gateway.ts:626` | `ws.on("message", (data: RawData, isBinary: boolean) => {` |
| `src/modules/voice/voice.gateway.ts:643` | `messageChain = messageChain` |
| `src/modules/voice/voice.gateway.ts:647` | `? await verifyActiveSession(authToken, userId ?? undefined).catch(` |
| `src/modules/voice/voice.gateway.ts:656` | `if (isBinary) {` |
| `src/modules/voice/voice.gateway.ts:660` | `handleControlMessage(data);` |
| `src/config/auth.ts:45` | `User.findById(userId),` |
| `src/config/auth.ts:46` | `AuthSession.findById(sid),` |

**驗證方式**：真實 gateway + ws 迴路，不連資料庫或供應商；authenticateToken 替身接受測試身分，verifyActiveSession 每次延遲 20ms 模擬 DB，bridge 只計數。握手後 burst 100 個 16KiB binary frame 再送 session.end。此數值是故障模型結果，非正式環境延遲。

**結果**：

```text
exit=0
{"afterMs":154,"checks":8,"audio":7,"connectionStillOpen":true}
{"closedAfterMs":2120,"code":1000,"checks":101,"audio":100}
```

**影響**：每個音訊 frame 都觸發兩筆 DB 讀取，驗證未完成前持有 frame 的 Promise chain 繼續增長。DB 延遲時音訊和取消操作共同被延後，已登入客戶端可持續入列耗用記憶體。

**修復方向**：入列前限制 binary frame 數與總 bytes，採 bounded queue/backpressure；讓 session.end 及 cancel 能優先撤銷 pending 工作；保留 session 撤銷語意但避免每段音訊串行重複讀兩份 document。

**驗收方式**：在 auth lookup 20–100ms 故障注入下持續傳 audio，queue bytes 有硬上限、停止訊息不等待全部 audio；另驗證撤銷 session 仍在約定期限內關閉。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/auth-audit.djPi3r/voice-probe.cjs
```

### P1-09 — pnpm typecheck 在 hazard AI 與 retention 整合測試報 34 個 TypeScript 錯誤

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/hazard-report/hazard-report.ai-job.repository.integration.test.ts:63` | `expect(doc?.aiReview.state).toBe("processing");` |
| `src/modules/retention/retention.integration.test.ts:173` | `const stale = await SosSession.create(sosDoc());` |
| `.github/workflows/ci.yml:57` | `run: pnpm run typecheck` |

**驗證方式**：目前 HEAD 工作目錄實跑；34 個診斷來自兩個 integration test 檔。未查遠端 CI 狀態，不能宣稱線上 CI 當下為綠或紅。

**結果**：

```text
exit=1; error TS 診斷 34；hazard-report.ai-job.repository.integration.test.ts(63,12) TS18048；retention.integration.test.ts(173,43) TS2769；另有 TS2339/TS2554。
```

**影響**：production build 排除測試所以通過；全型別檢查仍阻擋 repo 宣告的 CI gate。Vitest 會轉譯而不取代 TypeScript 型別檢查，因此 runtime 全綠不能證明此 gate 正常。

**修復方向**：修正 fixture 的 literal 型別、nullable narrowing 及過時函式簽名；保留 strict 與測試納入範圍，不以排除測試或 ts-ignore 消音。

**驗收方式**：pnpm typecheck、pnpm build、相關 Mongo integration tests 皆通過；CI 在指定 Node 22 環境重跑。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
pnpm typecheck
rg -c 'error TS' /tmp/backend-audit-VOKIiX/typecheck.log
```

### P2-01 — 並行 PATCH 不同評論維度會把過期快照計算的 rating 與 aggregateAccessibilityScore 寫回資料庫

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/review/review.service.ts:280` | `const stored = await findActiveReviewById(id);` |
| `src/modules/review/review.service.ts:291` | `const review = { ...stored } as ReviewRecord & Record<string, unknown>;` |
| `src/modules/review/review.service.ts:317` | `review.rating = calculateLegacyRating(review);` |
| `src/modules/review/review.service.ts:325` | `changes.aggregateAccessibilityScore = aggregateAccessibilityScore;` |
| `src/modules/review/review.service.ts:328` | `const saved = (await updateActiveReview(id, changes)) ?? review;` |
| `src/modules/review/review.repository.ts:205` | `{ _id: id, status: "active" },` |
| `src/modules/review/review.repository.ts:206` | `{ $set: fields },` |

**驗證方式**：真實 Mongo/service/repository，將 findActiveReviewById 包裝 read barrier，使兩個請求皆先讀到 [1,1,1,1]，再各 PATCH passageWidthRating=5 與 toiletRating=5；原始 query/update 未替換。

**結果**：

```text
exit=0
{"dimensions":[5,5,1,1],"persistedRating":2,"persistedAggregate":2,"expectedRating":3}
```

**影響**：原始評分維度保存為 [5,5,1,1]，衍生分數卻持續為 2；列表平均分與 minAggregateScore 篩選使用錯誤的持久欄位。

**修復方向**：以原子 update pipeline 基於資料庫當前值套用 patch 及重算，或使用版本 CAS 並在衝突後重讀重算；避免讀取快照與寫入間無版本條件。

**驗收方式**：保留兩請求 read barrier 實測，最後 rating/aggregate 必須等於四維平均 3，並驗證分數篩選與平均查詢一致。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/auth-audit.djPi3r/review-probe.cjs
```

### P2-02 — 評論刪除後再次新增同一地點，active 預檢通過但全域唯一索引拒絕新增

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/model/review.model.ts:69` | `reviewSchema.index({ placeId: 1, placeType: 1, userId: 1 }, { unique: true });` |
| `src/modules/review/review.repository.ts:94` | `status: "active",` |
| `src/modules/review/review.repository.ts:108` | `const created = await Review.create(doc);` |
| `src/modules/review/review.repository.ts:219` | `{ $set: { status: "deleted" } },` |
| `src/modules/review/review.service.ts:210` | `const existing = await activeReviewExists(` |
| `src/modules/review/review.service.ts:225` | `const review = await insertReview({` |

**驗證方式**：真實 isolated MongoMemoryServer、現行 schema 索引、真實 review service/repository；只替換未使用的 AI client 初始化。新增、soft delete、同一使用者及 place 再新增。

**結果**：

```text
exit=0
afterDeleteActiveExists= false
recreateErrorCode= 11000
```

**影響**：使用者刪除評論後失去重建該地點評論的能力；service 未捕捉 E11000，錯誤向 controller 傳播。

**修復方向**：統一 soft delete 和唯一性契約：採 active-only partial unique index 並提供索引遷移，或明確恢復原 deleted record；同時將並行建立的 E11000 轉成合理領域回應。

**驗收方式**：真實 Mongo 測 create→delete→create，重建成功且只存在一筆 active；並行 create 仍只能建立一筆 active。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node /tmp/auth-audit.djPi3r/review-probe.cjs
```

### P2-03 — PATCH memory 傳 expiresAt:null 無法取消到期日，Mongo 仍保留舊期限

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/ai/ai.schema.ts:252` | `expiresAt: z.string().datetime().nullable().optional(),` |
| `src/modules/ai/memory.service.ts:423` | `: (input.expiresAt ?? undefined);` |
| `src/modules/ai/memory.service.ts:431` | `expiresAt: expiresAtUpdate,` |
| `src/modules/ai/memory.repository.ts:171` | `{ $set: fields },` |

**驗證方式**：主流程補強為呼叫真實 updateMemory service + repository + 隔離 Mongo；僅替換 embedding 和 Chroma 外部 I/O。讀回期限仍與原值相同。

**結果**：

```text
exit=0; EXPIRY_CLEAR requested=null, persisted=original expiry, cleared=false（主流程真實 service 複驗）。
```

**影響**：API 接受取消期限的輸入卻繼續讓記憶在舊期限失效並被 retention tombstone；使用者得到成功回應而其取消到期日意圖未保存。

**修復方向**：保留 undefined 代表不更動、null 代表清除的契約；null 用 $unset expiresAt，或持久化 null 並更新型別。

**驗收方式**：先建立有未來 expiresAt 的記憶，再 PATCH expiresAt:null；讀回無到期日，將時鐘推過原期限仍可讀；省略 expiresAt 的 PATCH 保留原值。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node -r ts-node/register/transpile-only /tmp/backend-audit-VOKIiX/data-probe.cjs
```

### P2-04 — hazard reports 的 createdAt 排序與 _id 游標不一致，分頁會跳過仍存在的報告

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/hazard-report/hazard-report.repository.ts:445` | `query._id = { $lt: new Types.ObjectId(filter.cursor) };` |
| `src/modules/hazard-report/hazard-report.repository.ts:450` | `.sort({ createdAt: -1 })` |
| `src/modules/hazard-report/hazard-report.repository.ts:508` | `query._id = { $gt: new Types.ObjectId(cursor) };` |
| `src/modules/hazard-report/hazard-report.repository.ts:513` | `.sort({ createdAt: 1 })` |

**驗證方式**：隔離 Mongo 插入兩筆合法排序資料，其 createdAt 與 ObjectId 順序相反；直接呼叫 findReportsByReporter(limit=1) 和其 cursor 下一頁，第二筆永遠未回傳。多進程 ObjectId 同秒部分含隨機 process id，並不保證與 createdAt 排序相同。

**結果**：

```text
exit=0; PAGINATION {"stored":2,"page1":["600000000000000000000001"],"page2":[]}
```

**影響**：我的回報漏列；相同 cursor/sort 不一致也存在人工審核列表，未看到的項目會被跳過。

**修復方向**：改用 createdAt + _id 複合穩定排序及同樣兩欄 cursor predicate，或將排序與 cursor 都改成 _id 並明定 API 排序契約。

**驗收方式**：建立 ObjectId/createdAt 逆序與同毫秒 createdAt fixture；以 limit=1 翻完 mine 與 review queue，所有符合條件 id 恰好出現一次。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node -r ts-node/register/transpile-only /tmp/backend-audit-VOKIiX/data-probe.cjs
```

### P2-05 — hazard expiredAt 已到期但掃描器尚未更新 status 時，confirm/deny 仍接受新票

**證據類型**：`behavior`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/hazard-report/hazard-report.service.ts:466` | `if (report.status === "expired" &#124;&#124; report.contentScrubbedAt) {` |
| `src/modules/hazard-report/hazard-report.repository.ts:223` | `confirmedBy: { $ne: voterId },` |
| `src/modules/hazard-report/hazard-report.repository.ts:229` | `{ $inc: { confirmCount: 1 }, $push: { confirmedBy: voterId } },` |
| `src/modules/hazard-report/hazard-report.expire.ts:8` | `process.env.HAZARD_EXPIRY_SCAN_INTERVAL_MS ?? 5 * 60 * 1000,` |

**驗證方式**：真實 Mongo 插入 expiredAt 已過 60 秒但 status=verified 的正常掃描間隙狀態，呼叫 addConfirmation；confirmCount 由0變1。讀 service 可見只以 status 判斷 expired，缺 expiredAt 時間檢查。

**結果**：

```text
exit=0; EXPIRED_VOTE {"expiredAt":"2026-10-10T01:22:59.492Z","status":"verified","confirmCount":1}
```

**影響**：已過期回報的票數與身份列表仍變動，且 expiry job 跟投票寫入互相競爭時 service 先前讀取也不能保證寫入仍有效。已另查 activeVerifiedFilter 與路線 consumer 都有 expiredAt > now，故此缺陷不會使過期回報重新影響導航，低於綁定併發優先序。

**修復方向**：service 依 expiredAt 判定回 410，repository confirm/deny 的原子條件也加 expiredAt > now 與允許投票的 status；沒有命中時重新讀取並回明確狀態。

**驗收方式**：expiredAt 已過但 status=verified 的報告投票應410且資料不變；在讀取後、更新前觸發過期的併發測試亦不可增加票。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
node -r ts-node/register/transpile-only /tmp/backend-audit-VOKIiX/data-probe.cjs
```

### P2-06 — agent-tools 同時持有跨模組資料寫入與工具分派，未納入檔名式分層規則

**證據類型**：`presence`，strict gate 通過。

| 來源 | 當行引文 |
| --- | --- |
| `src/modules/ai/agent-tools.ts:39` | `import EmergencyContact from "../../model/emergency-contact.model";` |
| `src/modules/ai/agent-tools.ts:173` | `const contact = await EmergencyContact.findOne({` |
| `src/modules/ai/agent-tools.ts:1279` | `await contact.save();` |
| `src/modules/ai/agent-tools.ts:1349` | `await User.updateOne({ _id: linkCode.userId }, { $set: { lineUserId } });` |
| `src/scripts/check-architecture.mjs:31` | `if (file.endsWith(".service.ts")) return "service";` |
| `src/scripts/check-architecture.mjs:35` | `return undefined;` |

**驗證方式**：逐行核對兩個不同領域寫入範例與 roleFor 全部判斷，不把 build green 當成所有架構規則均有覆蓋。 此檔仍有 module cycle checking，缺口僅指 role-based model/import 邊界。

**結果**：

```text
pnpm build 內的 lint:arch exit=0；roleFor 不分類 agent-tools.ts，故其直接 model I/O 不會被 service/repository 規則攔下。
```

**影響**：帳號與聯絡人綁定的資料規則直接耦合在 AI tool dispatcher，HTTP/LINE/AI 的相同領域契約難以共用；綁定併發缺陷的修復落在工具檔而非該領域持久層。這是結構性維護債，不表示整體分層失敗。

**修復方向**：將帳號/聯絡人綁定分別收斂至所屬 module service + repository，AI tool 僅轉換參數與結果；邊界檢查補上 tools/helper 檔的 model import 政策。

**驗收方式**：agent-tools 不再直接讀寫這些 model；現有 LINE/tool contract 測試及同碼競態測試通過；架構檢查能拒絕 helper 直接重引 model。

**重現命令**（暫存探針內容保存於附錄，可另存 repo 外）：

```sh
pnpm lint:arch
rg -n "EmergencyContact|User.updateOne|contact.save|executeLocalTool" src/modules/ai/agent-tools.ts
```

## 3. 測試真實性

**結論：抽查的關鍵防護確實由測試守住，但現有 suite 沒有涵蓋本報告重現的全部故障與競態。** 不將作者身分、mock 數量或 coverage 當成測試真假的判定。

### 3.1 突變抽測

所有突變只發生於 repo 外的 `git archive HEAD` 副本。先曾一起執行三個互不相依的突變，得到 3 files failed / 5 tests failed；為排除交互影響，再逐項執行並在每次結束後還原，以下採單項結果。

| 防護 | 原始檔／破壞 | 測試 | 結果 |
| --- | --- | --- | --- |
| 照片只能由 owner/admin 讀取 | `hazard-report.photo-access.service.ts`：把 ownership 條件替換為 `true` | `hazard-report.photo-access.test.ts` | 其他帳號照片測試失敗；**killed** |
| uploading/cleanup 不可被查到 | `hazard-report.predicates.ts`：`$nin: ["uploading", "cleanup"]` 改成 `$nin: []` | `hazard-report.visibility.integration.test.ts` | private intakes invisibility 測試失敗；**killed** |
| revoked session 不可再視為 active | `user.auth-session.repository.ts`：僅移除 `findActiveSessionById` 的 `revokedAt: null` | `user.auth-session.repository.integration.test.ts` | 撤銷與重播相關 3 tests 失敗；**killed** |

指令為 `pnpm test <上表測試相對路徑> --maxWorkers=1`。三份完整路徑分別位於 `src/modules/hazard-report/`、`src/modules/hazard-report/`、`src/modules/user/`。單項還原以保存原始 bytes 的 `try/finally` 完成，未使用 reset/checkout 覆蓋原始工作目錄。

### 3.2 分層與略過項目

`tests/helpers/mongo-test-harness.ts` 使用 MongoMemoryServer、獨立 dbName、真實 Mongoose model 初始化；finally dropDatabase/disconnect/stop。Review、hazard、auth-session repository integration tests 不只是 mock API。照片 HTTP 測試則是真實 router/service/decoder，隔離 storage I/O；這兩類證據應分開看。

17 個略過測試來自未提供 PostGIS 連線的 7 個 suite，以下命令能找到條件：

```sh
rg -n 'describe\.skip|skipIf|runIf|it\.skip|test\.skip' src --glob '*.test.ts'
```

位置：`src/scripts/{migrate-ped-graph-lifecycle,ped-graph-schema,import-taipei-ramps,promote-ped-graph}.integration.test.ts`，以及 `src/modules/accessible-route/planners/pedestrian-a11y/{astar,ramp-query,graph-loader}.integration.test.ts`。沒有因此宣稱 PostGIS 功能已通過驗證。

### 3.3 Git 歷史鑑識

`test_forensics.py` 以最近 500 commits 排出 7 個候選，不代表篡改。實際抽讀：

| commit | 人工判讀 |
| --- | --- |
| `fc3dd6bdd`、`eca5b68bd`、`7e6b9dd94` | 測試減少對應移除 feature flag，未將這些刪除直接判為掩蓋 BUG |
| `364f3429e` | 明示 breaking contract：不再接受 inline route，測試同步移除該輸入 |
| `d6b833e97` | repository 重構後，斷言從 fake document mutation 改成 `$set` 寫入值；仍保留數值斷言 |
| `12c03f7e3` | 抽讀 AI vision 測試，存在 deadline、取消與 SDK attempt 斷言；timeout 關鍵字命中不能單獨證明放寬測試 |
| `e4ee353e3` | 抽讀新增 campus tool fixtures 與斷言，未找到足以確認故意放寬的證據；未完整裁決整份 commit |

本輪沒有確認「為了讓 suite 變綠而篡改測試」的案例；這不代表全歷史經過逐條人工驗證。實際需補的行為已寫在各發現的驗收條件。

## 4. 已排除的疑點

| 疑點 | 回查結果 |
| --- | --- |
| 私人照片只靠前端權限 | `hazard-report.photo-access.service.ts:68` 起有 owner/admin 與 scrub/deidentify 檢查，I/O 後再檢查；ownership 突變被 HTTP 測試攔下 |
| JWT 登出只是前端刪 token | `src/config/auth.ts:44` 起查 user/session、tokenVersion、revocation、期限；session 突變被真實 Mongo 測試攔下 |
| emergency-contact router 無 auth | `src/app.ts:148` mount 已掛 middleware，不以子 router 表面判 IDOR |
| 評論可任意修改他人資料 | `review.service.ts:284`、`:341` 有 ownership；本輪確認的是資料一致性，不是已證明越權 |
| 未完成照片 intake 被公開／使用 | 共同 predicate 與真實 Mongo visibility tests 有防護，移除 predicate 會測紅 |
| 晚到 AI 結果一定復活已清理內容 | worker/job repository 有 lease/generation fence；未沿用舊版稽核結論當現況 |
| Google geocode cache 無界增長 | adapter 有容量上限；確認的問題是暫時錯誤被長期快取，不是無上限 cache |
| 過期投票讓舊 hazard 重回導航 | 路線讀取另要求 `expiredAt > now`；P2-05 僅限票數與狀態一致性 |
| audit 的 critical 等於已證明可利用 | [proxy-addr 公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)依賴 IPv4-mapped IPv6 subnet 設定；`app.ts:58` 使用數字 hop count，不符合該特定觸發條件，沒有列為 P0 |
| Python 失敗表示 CI 缺依賴 | `requirements-test.txt` 已列 shapely，CI 安裝該檔；本機缺依賴未列正式缺陷 |

## 5. 未驗證／查不到

- 未連正式 Mongo、PostGIS、Redis、Chroma、GCS，未讀 production `.env` 或憑證；未執行正式 migration/import、未發送真實 LINE 訊息。
- 真實 TDX／Google／OTP／LINE／Apple 故障、正式流量與雲端資源限制未實測。Probe 替換外部邊界，只證明現有程式在指定條件的行為；Voice 的約 2.12 秒是 20ms/session lookup 模型結果，不能當 production latency。
- Python `build-ped-graph.test.py` 因本機 shapely 缺失無法完整驗證；PostGIS 7 suites/17 cases 未跑。
- 未在 CI 的 Node 22/Python 3.12 重跑，未查遠端 branch protection、required checks 或每個 PR 的人為 review 狀態。Git 有 PR merge 痕跡，不能據此保證所有變更都被 review。
- 沒有執行正式帳號流程、瀏覽器／手機／導航裝置驗收，也未做正式服務壓力測試。
- 未做完整 secret 歷史掃描或有效性測試；只確認 tracked env 檔為 `.env.example`、`.env.development.example`、`.env.production.example`。不能宣稱歷史從未出現 secret。
- 依賴掃描的其餘項目沒有全部建立 request 可達性。[source-map-js 公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)要求處理受攻擊者控制的 indexed source map，本輪沒有證明正式 HTTP 路徑接受它；未把全部 audit metadata 當成已證實漏洞。
- EmergencyContact 的 read→save 綁定路徑有同型競態線索，但本輪動態驗證的是 LINE account bind，未另列成已重現的安全漏洞。
- 未完整追查每條 log 的 request correlation、所有運維告警、供應商刪除／保留結果與跨重啟故障；既有文件不是正式環境驗收證據。

## 6. 處理順序

| 順序 | 工作 | 完成條件 |
| --- | --- | --- |
| 1 | P1-01 SOS、P1-02 公車可搭性、P1-03 綁定原子性 | 故障／競態 probe 對應迴歸測試通過；回應狀態與真實業務結果一致 |
| 2 | P1-04 snapshot 舊資料保護、P1-05 compression | 故障不破壞既有集合；提前斷線釋放串流；重新驗 audit gate |
| 3 | P1-06/07 上游恢復、P1-08 Voice queue | 供應商恢復即能重試；queue 有硬上限且取消不被音訊阻塞 |
| 可平行 | P1-09 型別與 CI | 修測試型別，維持 strict，所有 gate 通過 |
| 4 | P2-01～05 資料契約 | 評分一致、評論可重建、null 清除有效、分頁無遺漏、到期後不可投票 |
| 5 | P2-06 分層整理 | 在已補足的測試下收斂領域寫入，擴充 boundary checker |

不建議整體重寫或換框架。先增加可重現缺陷的測試，再局部改資料與錯誤契約；避免先做大規模重構讓故障來源更難辨識。

## 6.9 本報告修正過的數字與判斷

| 初步訊號 | 最終採用 | 原因 |
| --- | --- | --- |
| forensics 正則：3,126 test cases | Vitest 實跑 3,473 passed + 17 skipped | 正則不等於 runner 展開 `it.each` 的實際案例數 |
| forensics 正則：skip/only=0 | 7 suites / 17 cases skipped | `.skipIf` 與 `describeWithDatabase` alias 未被簡單 pattern 計入 |
| forensics：7 可疑 commits | 未確認測試篡改 | feature flag 移除、breaking contract 與重構需看 diff，不能用分數判罪 |
| lint 931 warnings | 工具在整個 lint scope 的結果 | 包含測試與 fixture，不宣稱 931 個 runtime BUG |
| audit critical=1 | 沒有因此列 P0 | subnet 觸發條件與本 repo hop-count 設定不同 |
| import「錯誤來源」 | 限可讀但零筆合法資料 | 檔案讀取直接失敗會在 delete 前退出，已由第二審查者指出並縮小 |
| compression probe | 限本機 streaming response、threshold:0 | 證明安裝套件未關閉串流，不宣稱已量測全部正式 endpoint |
| memory 初始只驗 repository | 主流程改成真實 updateMemory + repository | 避免僅重製轉換式而未跨 service 的證據缺口 |

## 7. 本輪動過什麼

- 唯一新增的 repo 成品：`docs/audit/2026-10-10-product-grade-audit.md`。Endpoint mount 與契約未修改。
- 執行 build（重建忽略追蹤的 dist）、lint、format check、typecheck、tests、coverage、Python tests、dependency audit；沒有安裝／升級專案依賴。
- 掃描、JSON、coverage、probe 與 HEAD 副本全部在 repo 外。突變只改副本中的三個檔案，已逐檔還原並核對 bytes，沒有修改原 repo 的 source/tests。
- Probe 的隔離 Mongo 透過 finally 刪除資料庫並停止程序；本機 HTTP/WebSocket 連線與 server 關閉。
- 收尾刪除本輪建立的暫存目錄。附錄保留探針內容供複驗，故無須保留暫存程式檔。
- 最終 `git status --porcelain --untracked-files=all` 實際僅有：

```text
?? docs/audit/2026-10-10-product-grade-audit.md
```

## 附錄 A. 可重現探針

以下是本輪實際執行的內容。可存為對應名稱的 repo 外檔案，再於 repo 根目錄執行 `node <path>`；data probe 使用 `node -r ts-node/register/transpile-only <path>`。探針不載入 `.env`，資料庫探針使用專案的隔離 Mongo harness；不要把測試資料庫替換成正式連線。外部 I/O 替身範圍已在各發現說明。

<details>
<summary>routing-probe.cjs</summary>

```javascript
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=process.argv[2]||process.cwd();
const ts=require(path.join(root,'node_modules/typescript'));
const now=Date.parse('2030-01-01T10:00:00+08:00');
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
function load(file,extras={}){const out=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const sandbox={exports:{},console,URLSearchParams,Date:FixedDate,...extras};vm.runInNewContext(out,sandbox,{filename:file});return sandbox.exports;}
(async()=>{
let tokenCalls=0;
const tdx=load('src/adapters/tdx.adapter.ts',{process:{env:{TDX_CLIENT_ID:'fixture-id',TDX_CLIENT_SECRET:'fixture-secret'}},fetch:async()=>{tokenCalls++;if(tokenCalls===1)throw Error('temporary network failure');return {ok:true,json:async()=>({access_token:'recovered-token',expires_in:3600})};}});
for(let i=0;i<3;i++){try{console.log('TDX attempt',i+1,await tdx.tdxTokenManager.getToken());}catch(e){console.log('TDX attempt',i+1,e.message);}}
console.log('TDX upstream fetch calls:',tokenCalls);
let geoCalls=0;
const geo=load('src/adapters/google.adapter.ts',{process:{env:{GOOGLE_MAPS_API_KEY:'fixture-key'}},require:name=>name==='axios'?{post:async()=>{geoCalls++;if(geoCalls===1)throw Error('temporary 503');return {data:{places:[{location:{latitude:25.0478,longitude:121.517}}]}};}}:name.includes('/lang')?{DEFAULT_LANG:'zh-TW'}:{TaiwanCityEn:{Taipei:'Taipei'}}});
console.log('geocode first:',await geo.getCoordinates('台北車站'));
console.log('geocode second after upstream recovered:',await geo.getCoordinates('台北車站'));
console.log('geocode upstream calls:',geoCalls);
const busConstants={BUS_DIRECTIONS:[0,1,2,10,255],BUS_ETA_CLOCK_SKEW_MS:30000,BUS_ETA_MAX_AGE_MS:120000};
const mocks={
'../../../config/fetch':{tdxFetch:async()=>({ok:true,json:async()=>[{StopName:{Zh_tw:'起站'},Direction:0,EstimateTime:60,StopStatus:0,StopSequence:1},{StopName:{Zh_tw:'終站'},Direction:0,EstimateTime:1200,StopStatus:0,StopSequence:2}]})},
'../../../constants/bus':busConstants,
'../../../config/transit':{busUrl:{cityEstimatedTimeOfArrivalUrl:'https://fixture.invalid'},trainUrl:{},traUrl:{},thsrUrl:{}},
'../../../utils/rail-suspension':{railOdIsBoardable:()=>true},
'../../../utils/transit-text':{odataUrlLiteral:encodeURIComponent},
'./otp-routing':{fetchRailLegGeometry:async()=>[]},
'../../transit/bus.repository':{findVehiclesByPlate:async()=>[]},
'../../transit/bus-fleet.repository':{recordRealtimeSightings:async()=>0},
'../../../utils/tdx-bus-eta':load('src/utils/tdx-bus-eta.ts',{require:()=>busConstants}),
'../../../config/taipei-time':load('src/config/taipei-time.ts'),
'./gtfs-time':load('src/modules/accessible-route/planners/gtfs-time.ts')
};
const realtime=load('src/modules/accessible-route/planners/realtime-transit.ts',{require:name=>{if(mocks[name])return mocks[name];throw Error('unexpected import '+name);}});
const route={routeId:'fixture',routeName:'fixture',totalMinutes:30,transferCount:0,accessibilityHighlights:[],_scheduledDepartureTime:now,legs:[{type:'WALK',from:'起點',to:'起站',distanceM:600,minutesEst:10,a11yFacilities:[],polyline:[[121.51,25.04],[121.52,25.04]]},{type:'BUS',routeName:'R',subRouteUid:'TPE-R-A',subRouteName:'R',departureStop:'起站',arrivalStop:'終站',departureStopId:'TPE-A',arrivalStopId:'TPE-B',direction:0,departureTime:'10:12',arrivalTime:'10:30',waitInfo:{source:'schedule',time:'10:12'},estimatedWaitMinutes:2,rideMinutes:18,polyline:[],departureStopA11y:[],arrivalStopA11y:[]}]};
await realtime.overlayRealtimeTransit([route]);
console.log('BUS',JSON.stringify({now:'10:00',walkArrivalAtStop:'10:10',busDeparture:route.legs[1].departureTime,busArrival:route.legs[1].arrivalTime,wait:route.legs[1].waitInfo,totalMinutes:route.totalMinutes}));
})().catch(e=>{console.error(e);process.exitCode=1;});

```

</details>

<details>
<summary>review-probe.cjs</summary>

```javascript
const {createRequire}=require('node:module');
const r=createRequire(process.cwd()+'/package.json');
r('ts-node').register({transpileOnly:true});
const Module=require('node:module');
const original=Module._load;
Module._load=function(id,parent,isMain){if(parent?.filename.endsWith('/review.service.ts') && id==='../../config/ai')return {googleGenAi:{},model:'unused'};return original.apply(this,arguments)};
const mongoose=r('mongoose');
const Review=r('./src/model/review.model.ts').default;
const repo=r('./src/modules/review/review.repository.ts');
const svc=r('./src/modules/review/review.service.ts');
const harness=r('./tests/helpers/mongo-test-harness.ts');
(async()=>{const ctx=await harness.startMongoTest();try{
const input={placeId:'audit-place',placeType:'osm',passageWidthRating:1,toiletRating:1,elevatorRating:1,serviceRating:1};
const initial=await svc.createReview('audit-user',input);
const id=initial.data.review._id;
await svc.deleteReview(id,'audit-user');
console.log('afterDeleteActiveExists=',await repo.activeReviewExists('audit-place','osm','audit-user'));
try{await svc.createReview('audit-user',input);console.log('recreate=success')}catch(e){console.log('recreateErrorCode=',e.code)}
await Review.deleteMany({});
const fresh=await svc.createReview('audit-user',input);const freshId=fresh.data.review._id;
const originalFind=repo.findActiveReviewById;let reads=0,release;const bothRead=new Promise(resolve=>release=resolve);
repo.findActiveReviewById=async(...args)=>{const value=await originalFind(...args);reads++;if(reads===2)release();await bothRead;return value};
await Promise.all([svc.updateReview(freshId,'audit-user',{passageWidthRating:5}),svc.updateReview(freshId,'audit-user',{toiletRating:5})]);
const final=await Review.findById(freshId).lean();
console.log(JSON.stringify({dimensions:[final.passageWidthRating,final.toiletRating,final.elevatorRating,final.serviceRating],persistedRating:final.rating,persistedAggregate:final.aggregateAccessibilityScore,expectedRating:3}));
}finally{await harness.stopMongoTest(ctx)}})().catch(e=>{console.error(e);process.exitCode=1});

```

</details>

<details>
<summary>voice-probe.cjs</summary>

```javascript
const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/package.json');r('ts-node').register({transpileOnly:true});
const Module=require('node:module'),orig=Module._load;let checks=0,audio=0;const delay=ms=>new Promise(r=>setTimeout(r,ms));
Module._load=function(id,parent,isMain){if(parent?.filename.endsWith('/voice.gateway.ts')){
if(id==='../../config/auth')return {authenticateToken:async()=>({ok:true,userId:'audit-user'}),verifyActiveSession:async()=>{checks++;await delay(20);return true}};
if(id==='./live-bridge')return {createLiveBridge:async()=>({sendAudio(){audio++},close(){},endSession(){}})};
if(id==='../accessible-route/navigation-state.repository')return {deleteNavigationSnapshot:async()=>{}};
}return orig.apply(this,arguments)};
const http=require('node:http'),WebSocket=r('ws');const gateway=r('./src/modules/voice/voice.gateway.ts');
(async()=>{const server=http.createServer();gateway.attachVoiceWebSocket(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/api/v1/voice/ws');await new Promise(resolve=>ws.once('open',resolve));const ready=new Promise(resolve=>ws.once('message',resolve));ws.send(JSON.stringify({type:'session.start',token:'stub-verified'}));await ready;
const started=Date.now();for(let i=0;i<100;i++)ws.send(Buffer.alloc(16384));ws.send(JSON.stringify({type:'session.end'}));await delay(150);console.log(JSON.stringify({afterMs:Date.now()-started,checks,audio,connectionStillOpen:ws.readyState===WebSocket.OPEN}));
const code=await new Promise(resolve=>ws.once('close',resolve));console.log(JSON.stringify({closedAfterMs:Date.now()-started,code,checks,audio}));await new Promise(resolve=>server.close(resolve));})().catch(e=>{console.error(e);process.exitCode=1});

```

</details>

<details>
<summary>sos-probe.cjs</summary>

```javascript
const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/package.json');r('ts-node').register({transpileOnly:true});
const Module=require('node:module'),orig=Module._load;let attempts=0;
Module._load=function(id,parent,isMain){if(parent?.filename.endsWith('/line.adapter.ts')&&id==='@line/bot-sdk')return {HTTPFetchError:class extends Error{},messagingApi:{MessagingApiClient:class{async multicast(){attempts++;throw new Error('injected provider unavailable')}}}};if(parent?.filename.endsWith('/sos.service.ts')&&id==='../user/user.push.service')return {pickLocale(){},sendPushToUser:async()=>{}};return orig.apply(this,arguments)};
const Contact=r('./src/model/emergency-contact.model.ts').default;
const svc=r('./src/modules/sos/sos.service.ts');const harness=r('./tests/helpers/mongo-test-harness.ts');
(async()=>{const ctx=await harness.startMongoTest();try{await Contact.create({userId:'000000000000000000000001',name:'test',bindStatus:'bound',lineUserId:'line-test',bindCode:'TEST01'});const input={userId:'000000000000000000000001',type:'body',lat:25,lng:121};const one=await svc.createSession(input);const two=await svc.createSession(input);console.log(JSON.stringify({first:{http:one.httpCode,notifiedCount:one.data.notifiedCount},retry:{http:two.httpCode,notifiedCount:two.data.notifiedCount},providerAttempts:attempts}));}finally{await harness.stopMongoTest(ctx)}})().catch(e=>{console.error(e);process.exitCode=1});

```

</details>

<details>
<summary>data-probe.cjs</summary>

```javascript
process.env.GEMINI_API_KEY='test-dummy';
process.env.OPENAI_API_KEY='test-dummy';
delete process.env.REDIS_URL;
const root=process.cwd();
const local=(p)=>require(root+'/'+p);
const mongoose=local('node_modules/mongoose');
const {startMongoTest,stopMongoTest}=local('tests/helpers/mongo-test-harness');
const Memory=local('src/model/user-memory.model').default;
const memoryRepo=local('src/modules/ai/memory.repository');
const embedding=local('src/adapters/embedding.adapter');
const chroma=local('src/adapters/chroma.adapter');
embedding.embedText=async()=>[0,1];
chroma.upsertDocumentsWithin=async()=>{};
const memoryService=local('src/modules/ai/memory.service');
const Hazard=local('src/model/hazard-report.model').default;
const hazardRepo=local('src/modules/hazard-report/hazard-report.repository');
const User=local('src/model/user.model').default;
const Code=local('src/model/line-link-code.model').default;
const {bindLineAccountCode}=local('src/modules/ai/agent-tools');
(async()=>{let context;const original=User.findById;try{
context=await startMongoTest();
const userId=new mongoose.Types.ObjectId().toString();
const expiry=new Date(Date.now()+86400000);
const m=await Memory.create({userId,content:'test',promptText:'test',retrievalText:'test',category:'preference',sensitivity:'low',source:'explicit_user',expiresAt:expiry});
// Real memory service and repository; only embedding/vector external I/O is stubbed.
const memory=await memoryService.updateMemory(userId,String(m._id),{expiresAt:null});
console.log('EXPIRY_CLEAR',JSON.stringify({requested:null,persisted:memory.expiresAt,original:expiry,cleared:!memory.expiresAt}));
const olderId=new mongoose.Types.ObjectId('600000000000000000000001');
const newerId=new mongoose.Types.ObjectId('600000000000000000000002');
const data={reporterId:userId,reportedLocation:{type:'Point',coordinates:[121.5,25]},hazardType:'obstacle',severity:'difficult',status:'verified',expiredAt:new Date(Date.now()-60000),confirmedBy:[],deniedBy:[],confirmCount:0,denyCount:0};
await Hazard.collection.insertMany([{...data,_id:olderId,createdAt:new Date('2026-10-10T12:00:01Z')},{...data,_id:newerId,createdAt:new Date('2026-10-10T12:00:00Z')}]);
const p1=await hazardRepo.findReportsByReporter(userId,{},1);
const p2=await hazardRepo.findReportsByReporter(userId,{cursor:String(p1[0]._id)},1);
console.log('PAGINATION',JSON.stringify({stored:2,page1:p1.map(x=>String(x._id)),page2:p2.map(x=>String(x._id))}));
const voted=await hazardRepo.addConfirmation(String(olderId),'independent-user');
console.log('EXPIRED_VOTE',JSON.stringify({expiredAt:voted.expiredAt,status:voted.status,confirmCount:voted.confirmCount}));
const user=await User.create({name:'Race fixture',email:'race@example.invalid'});
await Code.create({userId:String(user._id),code:'ABC123',expiresAt:new Date(Date.now()+60000)});
let readers=0;let release;const barrier=new Promise(r=>release=r);
// Delay after REAL Mongo reads so both requests see an unbound account.
User.findById=function(...args){const query=original.apply(this,args);const lean=query.lean;query.lean=async function(...xs){const value=await lean.apply(this,xs);readers++;if(readers===2)release();await barrier;return value};return query};
const results=await Promise.all([bindLineAccountCode({code:'ABC123'},'line-user-A'),bindLineAccountCode({code:'ABC123'},'line-user-B')]);
User.findById=original;
console.log('BIND_RACE',JSON.stringify({results:results.map(JSON.parse),persistedLineUserId:(await User.findById(user._id).lean()).lineUserId,remainingCodes:await Code.countDocuments()}));
}finally {User.findById=original;await stopMongoTest(context)}})().catch(e=>{console.error(e);process.exitCode=1});

```

</details>

<details>
<summary>import-probe.cjs</summary>

```javascript
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=process.cwd(),ts=require(path.join(root,'node_modules/typescript'));
async function probe(file) {
 const logs=[];let rows=['existing-place'],inserts=0,done;
 const finished=new Promise(r=>done=r);
 const model={deleteMany:async()=>{const n=rows.length;rows=[];return {deletedCount:n}},insertMany:async docs=>{inserts++;rows.push(...docs);return docs}};
 const exports={};
 const ctx={exports,console:{log:(...a)=>logs.push(a.join(' ')),error:console.error},__dirname:path.dirname(path.join(root,file)),process:{env:{DATABASE_URL:'mongodb://fixture.invalid/never-used'},argv:['node','fixture','header-only.csv'],exit:code=>done(code)},require:id=>{
 if(id==='dotenv/config') return {};
 if(id==='fs') return {readFileSync:()=> 'header1,header2,header3\n'};
 if(id==='path')return path;
 if(id==='mongoose')return {connect:async()=>{},disconnect:async()=>done(0)};
 if(id.includes('/model/'))return model;
 if(id.includes('csv'))return {parseCsvLine:()=>[]};
 if(id.includes('metro-a11y-parse'))return {rowToMetroA11yDoc:()=>null};
 throw Error(id);
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,ctx);
 const exit=await finished;console.log(JSON.stringify({file,input:'header-only CSV',beforeRows:1,afterRows:rows.length,insertCalls:inserts,exit,logs}));
}
(async()=>{await probe('src/scripts/import-bathrooms.ts');await probe('src/scripts/import-a11y-metro.ts')})().catch(e=>{console.error(e);process.exitCode=1});

```

</details>

<details>
<summary>compression-probe.cjs</summary>

```javascript
const {createRequire}=require('module'); const r=createRequire(process.cwd()+'/package.json');
const zlib=require('zlib'),http=require('http');
const streams=[]; const old=zlib.createGzip;
Object.defineProperty(zlib,'createGzip',{value:function(...args){const s=old(...args);streams.push(s);return s}, configurable:true});
const express=r('express'),compression=r('compression');
(async()=>{
const app=express();app.use(compression({threshold:0}));app.get('/',(req,res)=>{res.type('json');res.write('{"a":"'+ 'x'.repeat(10000));res.flush();});
const server=http.createServer(app);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
await new Promise(ok=>{const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:'/',headers:{'Accept-Encoding':'gzip'}},res=>{res.once('data',()=>{req.destroy();ok()})});req.on('error',()=>{})});
await new Promise(ok=>setTimeout(ok,150));console.log(JSON.stringify({compression:r('compression/package.json').version,afterClientDisconnect:streams.map(s=>({destroyed:s.destroyed,closed:s.closed,writableEnded:s.writableEnded}))}));
streams.forEach(s=>s.destroy());await new Promise(ok=>server.close(ok));
})().catch(e=>{console.error(e);process.exitCode=1});

```

</details>

