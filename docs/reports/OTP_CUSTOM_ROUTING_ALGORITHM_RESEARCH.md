# 在 OpenTripPlanner 2.x 建立自訂路徑規劃演算法：可行邊界、擴充點與本專案路線圖

> 研究日期：2026-07-30  
> 適用版本：正式部署基準為 OTP `v2.9.0`；原始碼定位另以當日 `dev-2.x`
> commit `a477b9df48b74652a370e8857b04d5fb37b269c4` 固定。  
> 結論先行：OTP 2.x 可以被修改成使用自己的成本、支配、剪枝、街道搜尋或
> transit worker，但官方沒有承諾一個可把第三方 JAR 丟進去就替換規劃器的穩定
> runtime plugin ABI。實務上應依序採「請求/設定調權 → OTP 回候選、Node 重排 →
> 固定版本 fork → 完全另建引擎」，不要一開始就重寫 RAPTOR。

## 1. 研究範圍、版本與證據邊界

OTP 官方目前的開發主幹是 `dev-2.x`，不是 `main`。2026-07-30 所取快照為
`2.10.0-SNAPSHOT`；當時最新正式版是 2026-03-18 發布的 `v2.9.0`。`v2.9.0`
是 annotated tag，tag object 為 `9d4f93a…`，實際 commit 是
`9babe45ffc9327933129f705c648137ecd96cdbe`，不可把兩者混為同一 SHA。
正式環境應 pin release commit/JAR；本文以當日 dev commit 說明最新結構，升版時
必須重新核對行號與 API。

官方建置文件要求修改 OTP 時從原始碼以 `mvn clean package` 建置，產物在
`otp-shaded/target/`；當前文件建議 JDK 25，且明言 `dev-2.x` 不是最穩定的部署版。
因此本專案既有「OTP 2.5+/Java 21」規格若升到 2.9，必須先驗證 Java、映像與
設定遷移，不能假定原環境直接相容。

本報告把「自訂演算法」分成四種不同深度，避免把改權重誤稱為換演算法：

| 策略 | 真正改變什麼 | 是否 fork OTP | 適合本專案 |
|---|---|---:|---|
| A. 請求/設定 | 既有 A*、McRangeRaptor 的成本與約束 | 否 | 立刻做 |
| B. OTP 內擴充 | edge cost、cost calculator、Pareto、filter，甚至 worker | 是，或向 upstream 合併 | 僅搜尋階段確有缺口時 |
| C. sidecar/後處理 | OTP 產生候選，外部服務補資料、Pareto/重排 | 否 | **目前最佳解** |
| D. 完全替換 | 自己讀 GTFS/OSM/RT、建圖並搜尋 | 否，但等同另造引擎 | 目前不建議 |

「官方未驗證」的邊界：本次沒有找到官方文件宣告穩定的 algorithm
`ServiceLoader`、plugin registry 或跨版本 binary compatibility；這是對上述固定
commit 與官方 extension 文件的查核結果，不是對所有未來版本的絕對否定。

## 2. OTP 2.x 一次規劃實際經過哪些演算法

OTP 不是「一個 Dijkstra」：

1. API 將 GraphQL 參數映射成 `RouteRequest`。
2. `DefaultRoutingService` 建立 `RoutingWorker`。
3. `RoutingWorker` 分別啟動 direct street、transit、flex 等搜尋，再合併結果。
4. direct street 由 street graph 上的 A* 搜尋；heuristic 為零時退化成 Dijkstra。
5. transit 先以街道搜尋求 access/egress，再將請求映射成 RAPTOR 請求。
6. transit 預設為 multi-criteria dynamic Range RAPTOR：先跑快速 heuristic，
   再跑主要的多時間點、分輪 transit/transfer 搜尋。
7. RAPTOR path 轉成 itinerary，最後經 decorator/filter/sort/crop。

固定原始碼證據：

- [`RoutingWorker` 分流並最後套 filter chain](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/RoutingWorker.java#L85-L141)
- [`TransitRouter` 建 access/egress、映射請求、呼叫 `RaptorService`](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/raptoradapter/router/TransitRouter.java#L102-L162)
- [`RaptorService` 在 dynamic 與 standard worker 間分流](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/RaptorService.java#L44-L63)
- [`RangeRaptorDynamicSearch` 先 heuristic、再建立主要 worker](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/service/RangeRaptorDynamicSearch.java#L72-L83)
- [`RangeRaptor` 支援 R/RR/McRR 並逐分鐘、逐 round 搜尋](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/rangeraptor/RangeRaptor.java#L18-L49)
- [`RangeRaptor` round 內依序 route transit、apply transfers](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/rangeraptor/RangeRaptor.java#L94-L146)
- [`AStar` 官方註解：零 heuristic 即 Dijkstra](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/astar/src/main/java/org/opentripplanner/astar/AStar.java#L27-L30)

這個分層很重要：改 itinerary 排序不會讓被 RAPTOR 剪掉的路徑復活；改 transit
cost calculator 也不會自動改 street access 的 edge cost。

## 3. 策略 A：不 fork，先用 OTP 已有成本與約束

### 3.1 能做到的事

官方 `RouteRequest`/router defaults 已能調：

- `numItineraries`、`searchWindow`；
- `maxTransfers`、`transferPenalty`、transfer slack、board/alight slack；
- `waitReluctance`、`walkReluctance`、不同 transit mode reluctance；
- wheelchair 的 trip/stop/elevator `onlyConsiderAccessible`、
  `unknownCost`、`inaccessibleCost`；
- `maxSlope`、`slopeExceededReluctance`、`stairsReluctance`、
  `inaccessibleStreetReluctance`；
- route/agency/mode select、ban、unpreferred cost；
- itinerary generalized-cost limit、相似路線分組與數量裁切。

這些參數會進入既有的 generalized cost、hard constraint 或結果 filter。它們可以
大幅改變候選集合，但仍然是 OTP 的 McRangeRaptor/A*，不是新的搜尋核心。

官方文件：

- [OTP 2.9 RouteRequest](https://docs.opentripplanner.org/en/v2.9.0/RouteRequest/)
- [OTP 2.9 Accessibility](https://docs.opentripplanner.org/en/v2.9.0/Accessibility/)
- [OTP 2.9 Router Configuration](https://docs.opentripplanner.org/en/v2.9.0/RouterConfiguration/)
- [OTP 2.9 GTFS GraphQL API](https://docs.opentripplanner.org/en/v2.9.0/apis/GTFS-GraphQL-API/)
- [OTP 2.9 API 總覽](https://docs.opentripplanner.org/en/v2.9.0/apis/Apis/)

原始碼確認 legacy GraphQL 並非只能事後限轉乘：
[`LegacyRouteRequestMapper` 會把 `maxTransfers` 寫入 transfer preferences](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/apis/gtfs/mapping/routerequest/LegacyRouteRequestMapper.java#L136-L167)。
因此本專案規格
`docs/specs/FUNCTIONAL_SPEC_OTP2_INTEGRATION.md:216-217` 的「OTP 不直接限制轉乘」
已過時；目前程式確實只在 Node 後濾，但可以先把同一 `maxTransfers` 傳入 OTP，
降低無用搜尋與候選遺失。

### 3.2 本專案最小改造鏈

目前實作在：

- `src/modules/accessible-route/planners/otp-routing.ts:221-269`：仍使用 deprecated
  legacy `plan` query，只傳 wheelchair、walkSpeed、numItineraries、searchWindow。
- 同檔 `:271-304`：實際 endpoint 是
  `/otp/routers/default/index/graphql`，與規格 `:180` 的 `/otp/gtfs/v1` 不一致。
- 同檔 `:849-882`：依 mode 決定 wheelchair/walk speed。
- 同檔 `:906-917`：`maxTransfers` 只在 OTP 回傳後檢查。
- 同檔 `:922-963`：候選不足時擴大 query。

第一階段建議：

1. 先盤點部署 OTP 實際版本與 schema introspection；不要直接假定 2.9。
2. 在現有 query 增加 `maxTransfers`、`transferPenalty`、`waitReluctance`、
   `walkReluctance` 等經實驗決定的參數。
3. 保留 Node 後濾作防線，但以 OTP 內約束為主。
4. 提高候選數時同步量測 latency、timeout、候選多樣性。
5. 逐步由 deprecated `plan` 遷至 `planConnection`；不要同時升版、換 API、
   換成本模型，否則無法歸因。

## 4. 策略 B：fork OTP，在核心內加入自己的規則或演算法

### 4.1 最小侵入：自訂街道 edge cost

wheelchair 街道成本本來就會考量 inaccessible street、stairs、slope：
[`StreetEdgeReluctanceCalculator`](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/street/src/main/java/org/opentripplanner/street/model/edge/StreetEdgeReluctanceCalculator.java#L47-L73)。
若要加入遮蔭、路面震動、淹水、施工風險，可仿官方 sandbox Data Overlay：

- `StreetEdgeCostExtension` 每條 edge **只能有一個** extension，回傳只能是 0 或正值：
  [介面契約](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/street/src/main/java/org/opentripplanner/street/model/edge/StreetEdgeCostExtension.java#L6-L15)。
- `StreetEdge` traversal 將 extension cost 加到 weight：
  [呼叫點](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/street/src/main/java/org/opentripplanner/street/model/edge/StreetEdge.java#L892-L900)。
- request-specific context 沒有 type-safe API：
  [`ExtensionRequestContext`](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/street/src/main/java/org/opentripplanner/street/model/edge/ExtensionRequestContext.java#L3-L17)。
- 官方 Data Overlay 是可參照的實作：
  [依時間、請求參數與 edge 長度計算正 penalty](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/ext/java/org/opentripplanner/ext/dataoverlay/DataOverlayStreetEdgeCostExtension.java#L19-L57)；
  [Data Overlay 說明](https://docs.opentripplanner.org/en/v2.9.0/sandbox/DataOverlay/)。

這條路是「把新資料納入 A* weight」，不是替換 A*。而且 one-extension 限制意味著
多個部署功能要自己組合為 composite，否則互相覆蓋。

### 4.2 中侵入：自訂 street A* 的 heuristic、dominance、剪枝

`StreetSearchBuilder` 可注入 heuristic、dominance function、skip-edge strategy、
termination strategy：
[builder 擴充點](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/street/src/main/java/org/opentripplanner/street/search/StreetSearchBuilder.java#L69-L103)。
direct street 的實際 wiring 在 `GraphPathFinder`，目前固定 Euclidean heuristic 與
minimum-weight dominance：
[呼叫位置](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/raptoradapter/router/street/GraphPathFinder.java#L63-L98)。

所以「自己的 street search」至少要：

1. 建立新的 `RemainingWeightHeuristic`/`DominanceFunction`/strategy；
2. 修改 `GraphPathFinder` 或更上層 factory 來選它；
3. 同步處理 direct、transit access、transit egress 的 call site；
4. 為 depart-after、arrive-by、wheelchair、rental、timeout 寫回歸測試。

A* heuristic 必須是剩餘成本下界；高估會錯誤剪掉最佳路。edge weight 應非負，
否則 A*/Dijkstra 的最優性前提破壞。

### 4.3 中侵入：自訂 transit generalized cost

`RaptorCostCalculator` 是最接近「自訂 transit 評價函數」的編譯期介面，負責
boarding、riding、arrival、waiting、egress 與 heuristic 剩餘下界：
[完整介面](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/spi/RaptorCostCalculator.java#L1-L70)。
內建 wheelchair 正是 decorator：
[`WheelchairCostCalculator`](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/raptoradapter/transit/cost/WheelchairCostCalculator.java#L9-L44)。
factory 先建 default，再依 wheelchair、unpreferred pattern 包裝：
[`CostCalculatorFactory`](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/raptoradapter/transit/cost/CostCalculatorFactory.java#L6-L34)。

最低風險做法是再加一層 immutable、thread-safe decorator，並在 factory wiring；
額外參數則沿 GraphQL schema → generated types → mapper → `RouteRequest` preferences →
generalized-cost parameter mapper 傳入。特別注意：

- RAPTOR cost 是整數 centi-seconds，不是任意浮點分數。
- `calculateRemainingMinCost` 必須是樂觀下界；介面原文亦如此要求。
- 只改 scalar generalized cost 不等於增加新的 Pareto 維度。

### 4.4 高侵入：新增 Pareto 維度或換掉 RAPTOR worker

若要把「無障礙風險」變成獨立 Pareto 維度，而非折進 generalized cost，會牽涉：

- stop arrival、pattern ride、destination path 的 state；
- 各層 Pareto comparator/factory；
- heuristic 與 relaxed dominance；
- path extraction、序列化與測試。

入口可見於 [`McRangeRaptorConfig` 建立 comparator、strategy、state 與 Pareto set](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/rangeraptor/multicriteria/configure/McRangeRaptorConfig.java#L123-L176)。
若真的換 worker，還要修改
[`RaptorConfig` 的 standard/multi-criteria worker factories](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/raptor/src/main/java/org/opentripplanner/raptor/configure/RaptorConfig.java#L46-L113)
以及 `RaptorService` 分流。這已是維護一個 OTP fork，不是「裝 plugin」。

Pareto 維度增加會造成 label/state 爆炸；需以每 stop/round label 數、候選數、
p95/p99 latency、heap/GC、最終候選 recall 做基準測試，不能只看單次平均時間。

### 4.5 最後處理：自訂 itinerary filter/decorator

若新規則只需看到完整 itinerary，最便宜的 OTP 內改法是 filter/decorator：
[`ItineraryListFilter` 可 filter、sort、decorate，但要求單一責任且不原地改 list](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/filterchain/framework/spi/ItineraryListFilter.java#L6-L32)。
它不是自動發現；要明確加入
[`RouteRequestToFilterChainMapper`](https://github.com/opentripplanner/OpenTripPlanner/blob/a477b9df48b74652a370e8857b04d5fb37b269c4/application/src/main/java/org/opentripplanner/routing/algorithm/mapping/RouteRequestToFilterChainMapper.java#L27-L125)。

其限制與 Node 後處理相同：只能處理已由 RAPTOR/A* 產生的候選。

### 4.6 Sandbox 不是穩定 plugin ABI

官方 sandbox 規約是把程式放進 OTP source tree 的 `src/ext`、測試放 `src/ext-test`，
package 用 `org.opentripplanner.ext.<name>`，必要時仍要在 core 新增 extension point。
官方同時明言：

- extension「provided with no guarantees」；
- API 可隨時變；
- 合併 core 也不保證 backward compatibility；
- core 維護者只需保持能編譯、測試甚至可暫時 ignore；
- deployment-only 功能應考慮 fork。

來源：[OTP 2.9 Sandbox Extension](https://docs.opentripplanner.org/en/v2.9.0/SandboxExtension/)。
因此 `raptor.spi` 的 package 名稱不能被解讀為官方承諾的跨版二進位 plugin 合約。

## 5. 策略 C：OTP 當候選產生器，自己的 sidecar/Node 做重排

這是本專案已採取且最合理的路線。現況：

- `accessible-route.service.ts:453-496`：
  dedupe/exclusion → proxy pre-rank top 8 → Mongo a11y enrichment → 真實 score/rank top 3。
- 同檔 `:137-185`：`scoreAndRank` 以路程、轉乘、a11y、步行距離計 cost。
- `scoring.ts:301-420`：不同障別的權重、步行 penalty、walk speed。
- `scoring.ts:520-571`：明確分開 final `routeCost` 與 pre-rank proxy。
- `accessible-route.service.ts:1029-1062`：目前 transit planner 實際只有 OTP。

優點是：

- 無須追 OTP internal API；
- 可使用 Mongo/即時設施/天氣等 OTP 不擁有的資料；
- 能快速 A/B 權重，並保留 OTP 作可靠 timetable search；
- 升 OTP 時只需維護 GraphQL contract。

目前最大的演算法風險不是「沒有自己的 RAPTOR」，而是 **top 8 前置截斷**：
facility 尚未 enrichment 前，proxy 可能把真正最無障礙的第 9 名丟掉。應量測
`recall@8`：以離線全候選 enrichment 後的 top 3 當 oracle，觀察它們有多少在 proxy
top 8；再決定 `PRERANK_N`、OTP `numItineraries` 與 search window。

推薦在 Node 增加 Pareto pre-filter（時間、轉乘、步行距離、已知風險），但保留
「選擇用 cost」與「顯示給使用者的 accessibility score」兩個概念，不可把部署特定
proxy 說成已校準的無障礙機率。

若要獨立 Java/Python sidecar，不建議解析 `graph.obj`：官方沒有把 OTP serialized
graph 宣告為外部穩定資料契約。完整自訂搜尋應直接讀 canonical GTFS/NeTEx、OSM、
GBFS 與 GTFS-RT；OTP GraphQL 適合拿 itinerary/實體，不適合作為完整 street
adjacency 的通用匯出 API。

## 6. 策略 D：完全替換 OTP 搜尋核心

只有以下條件才值得：

- 新問題不是一般 timetable routing，且 RAPTOR round/state 模型根本無法表達；
- 需要研究性演算法的可重現完整控制；
- 團隊願意長期維護 feed 正規化、service day、frequency、transfer、RT、street
  linking、wheelchair、timezone、DST、API 與效能；
- 有固定資料集和 OTP baseline 證明品質/效能收益。

兩種做法：

1. **OTP 外完整另建引擎**：直接讀原始資料，OTP 作比較/回退。邊界乾淨，工作最大。
2. **把 OTP Maven modules 當 library**：官方確實發布 Maven artifact，也可嵌入；
   但這不代表 internal API 穩定，仍會高度耦合版本。

官方建置與 artifact 說明：[Getting OTP](https://docs.opentripplanner.org/en/v2.9.0/Getting-OTP/)；
設定跨版會變且應檢查 unknown config：
[Migrating Configuration](https://docs.opentripplanner.org/en/v2.9.0/Migrating-Configuration/)。

## 7. 最小可執行模型：generalized cost + Pareto

下例不是 OTP patch，而是先在 sidecar 驗證「成本與支配語意」的可執行縮影。
成本越低越好：

```js
const candidates = [
  { id: "A", arrival: 45, transfers: 1, walkM: 300, risk: 10 },
  { id: "B", arrival: 50, transfers: 0, walkM: 100, risk: 5 },
  { id: "C", arrival: 55, transfers: 1, walkM: 400, risk: 20 },
  { id: "D", arrival: 42, transfers: 2, walkM: 100, risk: 0 },
];
const gc = r => r.arrival + 8*r.transfers + 0.02*r.walkM + 0.3*r.risk;
const vector = r => [r.arrival, r.transfers, gc(r)];
const dominates = (a, b) =>
  vector(a).every((x, i) => x <= vector(b)[i]) &&
  vector(a).some((x, i) => x < vector(b)[i]);
const front = candidates.filter(a =>
  !candidates.some(b => b !== a && dominates(b, a))
);
console.log(candidates.map(r => `${r.id}:${gc(r)}`).join(" "));
console.log("pareto=" + front.map(r => r.id).join(","));
```

本研究實際以系統 Node 執行，輸出：

```text
A:62 B:53.5 C:77 D:60
pareto=A,B,D
```

`C` 被 `A` 全面支配；A/B/D 則各保留速度、轉乘或成本的 trade-off。真正放進
OTP 時：

- 若只把 `gc` 加入 `RaptorCostCalculator`，是既有 C1 generalized cost；
- 若把 `risk` 變成獨立支配維度，就必須改 McRR state/comparator；
- heuristic 只能回傳不超過真實剩餘 cost 的下界；
- 權重與 threshold 應由資料/使用者研究校準，不應直接照抄示例。

## 8. 驗證、效能與升級風險

### 8.1 正確性測試矩陣

- depart-after / arrive-by、跨午夜、DST、feed timezone；
- 0/1/2 transfers、stay-seated、constrained transfer、minimum slack；
- wheelchair possible/unknown/not possible、電梯停用、stairs、坡度；
- access/egress/direct street 三條路徑是否都套到自訂成本；
- static vs GTFS-RT delay/cancel；
- 無路、timeout、候選 paging；
- 成本單調性、非負 edge cost、heuristic admissibility；
- 與 pinned OTP baseline 比較：不能只比「有沒有回路線」，還要比 Pareto/front。

### 8.2 Benchmark

固定 OTP commit、JDK、heap、硬體、graph、feed/RT snapshot 與 OD/time query corpus；
先 warm-up，再報 p50/p95/p99、timeout rate、CPU、heap/GC、visited states、
stop/round label 數、原始候選數、去重後候選數、`recall@N`。新增 Pareto 維度時
尤其要設 per-query state/candidate guardrail。

### 8.3 維運風險

- Sandbox/internal API 無相容保證，fork 每次升版都要重做差異審計。
- GraphQL schema 也有 legacy/current 兩代；`plan` 已 deprecated。
- 設定 schema 會變；啟動時應使用 `--abortOnUnknownConfig` 於 CI/staging 驗證。
- source build 的 JDK/Maven/模組版本與現行 OTP container 可能不一致。
- 自訂 heuristic 或 dominance 寫錯會「安靜地」漏掉最佳路，危險高於一般排序 bug。
- 即時設施/天氣是 time-dependent；快取與 route request timestamp 必須一致。
- 新成本資料缺失時要分辨 unknown 與 inaccessible，不可默認同義。

## 9. 對本專案的三階段決策

### 階段 1：先把 OTP 既有能力用完整

1. 對正在跑的 OTP 做 version/schema introspection。
2. 傳入 `maxTransfers`，並以設定檔/請求做 wheelchair、transfer、wait、walk 的
   小規模參數實驗。
3. 保留後濾與 fail-soft；記錄 OTP 原始 candidate metrics。
4. 規劃 `plan` → `planConnection` 遷移。

成功門檻：不增加 timeout，candidate diversity/recall 改善，Node 最終結果無回歸。

### 階段 2：強化既有 Node rerank

1. 建立固定 OD/time/a11y corpus，離線 enrich 全候選作 oracle。
2. 評估 `PRERANK_N=8` 的 recall@8，再調候選數而非憑感覺。
3. 加 Pareto pre-filter 與 ranking explanation/log。
4. 對 wheelchair/elderly/visual-impaired 分別校準，unknown 顯示為 confidence。

這一階段已能達到多數「自己的演算法」需求，且保留 OTP timetable 正確性。

### 階段 3：只有搜尋階段缺候選才 fork

進入條件：已證明目標好路徑在 OTP 搜尋期間被剪掉，無法由 request/config 增加候選，
且 backend rerank 無法補救。依最小改動排序：

1. street positive edge-cost extension；
2. transit cost decorator；
3. itinerary filter；
4. custom street heuristic/dominance；
5. 新 McRR 維度；
6. 全新 worker/引擎。

fork 必須 pin `v2.9.0` commit、保留一個小而可 rebase 的 patch stack，建立 upstream
同步節奏與 baseline benchmark。未先取得實驗證據，不建議進到第 4–6 項。

## 10. 最終判斷

「有人可以在 OTP 使用自己的演算法」通常指三件不同的事：在 source fork 裡換
cost/worker、以 sandbox/core extension point 加功能，或只把 OTP 當候選產生器再
自行重排；不是官方提供一個穩定的 drop-in algorithm plugin。

對本專案，最有價值且風險最低的答案是：**OTP 管 timetable 與可達候選生成，
Node 管部署特定的無障礙資料、Pareto 與排序**。先修正 `maxTransfers` 只後濾、
量測 top-8 candidate recall，再判斷是否真的需要 fork。只有「好路徑在 OTP 搜尋中
根本沒有生成」且可用固定基準重現時，才應把成本規則推入 OTP。

## 11. 官方來源索引

1. [OTP GitHub repository](https://github.com/opentripplanner/OpenTripPlanner)
2. [OTP v2.9.0 release](https://github.com/opentripplanner/OpenTripPlanner/releases/tag/v2.9.0)
3. [OTP v2.9.0 changelog](https://docs.opentripplanner.org/en/v2.9.0/Changelog/)
4. [Getting OTP](https://docs.opentripplanner.org/en/v2.9.0/Getting-OTP/)
5. [Developers Guide](https://docs.opentripplanner.org/en/v2.9.0/Developers-Guide/)
6. [RouteRequest](https://docs.opentripplanner.org/en/v2.9.0/RouteRequest/)
7. [Accessibility](https://docs.opentripplanner.org/en/v2.9.0/Accessibility/)
8. [Router Configuration](https://docs.opentripplanner.org/en/v2.9.0/RouterConfiguration/)
9. [GTFS GraphQL API](https://docs.opentripplanner.org/en/v2.9.0/apis/GTFS-GraphQL-API/)
10. [API overview](https://docs.opentripplanner.org/en/v2.9.0/apis/Apis/)
11. [Sandbox Extension](https://docs.opentripplanner.org/en/v2.9.0/SandboxExtension/)
12. [Sandbox Data Overlay](https://docs.opentripplanner.org/en/v2.9.0/sandbox/DataOverlay/)
13. [Migrating Configuration](https://docs.opentripplanner.org/en/v2.9.0/Migrating-Configuration/)
14. [Version Comparison](https://docs.opentripplanner.org/en/v2.9.0/Version-Comparison/)
15. [OTP Bibliography](https://docs.opentripplanner.org/en/v2.9.0/Bibliography/)
16. [Delling, Pajor, Werneck: RAPTOR original paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2012/01/raptor_alenex.pdf)

### 明確尚未驗證

- 未在本機完整編譯 OTP `v2.9.0` fork，也未對本專案 graph 跑 Java benchmark。
- 未對目前實際運行中的 OTP instance 做 version/schema introspection；所以
  `planConnection`、endpoint 與新增參數必須先對 runtime 驗證。
- 未驗證本專案現行 container 是否已具 JDK 25 或能直接升到 OTP 2.9。
- 官方沒有提供本專案資料的最佳權重；示例係機制驗證，不是效度/校準證據。
- 本次固定 source permalink 使用當日 `dev-2.x`，不是承諾 v2.9.0 行號完全相同。
