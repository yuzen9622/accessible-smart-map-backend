# 公車／鐵路軟性偏好：設計與實作驗證

日期：2026-10-03；端對端補驗：2026-10-04。狀態：後端與 AI 串接完成，已以本機 Docker 後端及真實 OTP 驗證偏好排序、自然語言解析與 reroute；正式部署、前端／Live 語音及更廣班次校準仍待驗收。

## 契約與設計

沿用 `POST /api/v1/a11y/accessible-route`，增加選填 `transitPreference`：

| 值 | 語意 |
| --- | --- |
| `none` | 不指定或明確取消偏好 |
| `bus` | 偏好公車，仍允許鐵路／捷運等接駁 |
| `rail` | 偏好鐵路（台鐵、高鐵），不包含捷運；仍允許公車接駁 |
| `metro` | 偏好捷運／輕軌（OTP SUBWAY／TRAM／MONORAIL，後端 METRO）；2026-10-04 新增，仍允許其他運具接駁 |

```json
{
  "origin": "台北車站",
  "destination": "板橋車站",
  "travelMode": "transit",
  "mode": "wheelchair",
  "transitPreference": "rail"
}
```

- 優先序：明確 request 值（含 `none`）→ AI `intent.preferences.transitPreference` → 無偏好。未給偏好且有 transit query，即使已給起訖點，也可解析需求；明確起訖點保留。此路徑需要 AI 可用。
- transit 成功回應的 `data.transitPreference` 表示實際採用的偏好，不保證回傳路線必含該運具。其他 travelMode 不採用此偏好。
- canonical request 保留解析結果；既有 `POST /api/v1/a11y/accessible-route/reroute` 延續同一偏好。不新增 endpoint、環境變數或帳號偏好儲存欄位。
- OTP 2.9.0 `plan.modeWeight`：偏好運具為 1，其餘支援的大眾運輸運具為 1.5。bus 包含 BUS/TROLLEYBUS；rail 使用 RAIL；metro 包含 SUBWAY/TRAM/MONORAIL；未被偏好的運具為 1.5。none 不傳權重，保留原預設。沿用原 transportModes allowlist。
- 初始、加寬、站點吸附重試及後續時段搜尋均攜帶權重；快取鍵既有的完整 variables 序列化包含權重。none 與省略可共用原本快取，bus/rail/metro 分開。
- 後端預排序、最終排序及低地板資訊重排，加上「非偏好運具乘車分鐘 × 0.5」（metro 偏好時，後端 METRO 段為偏好、BUS／TRA／THSR 乘車分鐘計入）。不修改真實總時間或無障礙分數；等待、步行不計入此附加成本。公車新增選填 rideMinutes，避免僅有鐵路可計算乘車成本。
- 原無障礙排除、危險路段處理、電梯警告、未來最早班次保留規則保持；偏好不是硬性運具限制。既有搜尋時間窗與長程 horizon 不變。
- AI 的 `planAccessibleRoute`、`getNavInstructions` 工具都接受偏好；文字／語音共用規則。實作亦更新 `POST /api/v1/ai/intent` 回傳意圖。目的地「火車站」不自動代表想搭火車；延續行程保留已確認偏好，取消或改口以最新指示為準。

## 驗證

- `pnpm build`：PASS（含 lint:arch 與 TypeScript 編譯）。
- 14 個相關 Vitest 檔案，423 項測試：PASS。涵蓋 enum 邊界、AI 輸出驗證、工具 dispatch、request 優先序、中途點／reroute 傳遞、所有後續 OTP 搜尋、快取隔離、無障礙限制、正常／輪椅／年長者排序、保留接駁、非偏好但快很多的路線、偏好第九候選通過預排序、低地板重排。
- 修改 TypeScript 檔案 ESLint：0 errors，195 warnings（no-explicit-any 等；未執行自動全專案清理）。
- `git diff --check`：PASS。
- 實際 AI `routeOnce`，使用正式文字 prompt 與工具目錄但不執行工具：6/6 PASS，每案例單次。新增案例收於 `src/scripts/agent-cases.ts`，id 前綴 `transit-preference-`。
- 實際 `parseRouteIntent`：4/4 PASS（公車、火車、取消、不把目的地火車站視為偏好）。

| 真實工具選擇案例 | 預期 | 結果 |
| --- | --- | --- |
| 台北→板橋，偏好公車 | planAccessibleRoute + bus | PASS |
| 台北→板橋，偏好火車、接受接駁 | planAccessibleRoute + rail | PASS |
| 取消之前的火車偏好 | planAccessibleRoute + none | PASS |
| 台北101→台北火車站 | planAccessibleRoute + 無偏好 | PASS |
| 輪椅＋偏好火車 | planAccessibleRoute + rail + wheelchair | PASS |
| 偏好公車，要求逐步導航 | getNavInstructions + bus | PASS |

## 原實作日（2026-10-03）的限制與待驗收

以下為原實作日紀錄；OTP／HTTP／reroute 的後續補驗見下一節，其他缺口仍保留。

當日設定的 OTP 端點連線回 `ECONNREFUSED`，未啟停或部署服務。已完成真實 LLM 語意／工具參數驗證與 mock 上游的程式整合測試，尚未實測真實 OTP 班次的偏好路線、延遲或部署 HTTP。語音共用工具與 prompt 已更新並通過回歸測試，未進行真實麥克風／Live WebSocket 驗收。

1.5 是初版軟性成本，不是經全臺路線校準的最佳值；OTP 恢復後應比較相同起訖／出發時間下 none/bus/rail 的短程與長程結果，含 normal/elderly/wheelchair。偏好不保證排序第一必用指定運具，其他時間、設施、安全因素及既有未來班次保留仍會影響結果。rail 無法區分只搭台鐵或只搭高鐵；本次不提供硬性禁搭或帳號持久設定。

## 2026-10-04 真實 HTTP／OTP 端對端補驗

### 環境與方法

- 後端：`http://127.0.0.1:8000`；OTP：`http://127.0.0.1:18080`。沒有 mock 路線、AI 或 Redis，也沒有啟停／重新部署服務。
- 運行中的 OpenAPI 包含 `transitPreference`，OTP introspection 確認 `InputModeWeight` 支援實作使用的各運具欄位。容器與本機 `dist` 的 preference、OTP planner、route service、request schema 四個 JavaScript 檔案 SHA-256 相同；這是抽查，不是整個映像的版本認證。
- 起訖使用明確座標，固定 `departureTime: 2026-10-05T09:00:00+08:00`、`maxTransfers: 2`。每組只改 `transitPreference`，比較實際路段、排序、乘車分鐘及分數，不比較隨機 token 或候選索引。
- 規劃矩陣 33 次：9 組 normal 起訖，以及台北→板橋的 wheelchair／elderly，各跑 none／bus／rail。另跑 6 次省略、取消、無效值及自然語言契約請求；2 次真實 reroute。合計 41 次 HTTP：40 次 200，無效 enum 1 次預期 400。
- 原始 request／response（含短效導航 token，勿公開分享）：`/tmp/transit-preference-e2e-20261004/`。這是本機暫存證據，不是永久 fixture；以下表格保留關鍵結果。

### 實際有效性的證據

**結論：已證明偏好會改變真實候選與排序，而不只是回傳偏好欄位；尚不能宣稱偏好一定成為第一名或已全臺校準。**

大安站（25.033, 121.5435）→松山車站（25.0492, 121.5782）：

| 偏好 | 第一名 | 第二名 | 第三名 |
| --- | --- | --- | --- |
| none／省略 | 捷運轉乘，33 分／91 分 | 捷運＋台鐵 1142，33 分／85 分 | 公車 1062，36 分／83 分 |
| bus | 捷運轉乘，33 分／91 分 | **公車 1062，36 分／83 分** | 捷運＋台鐵 1142，33 分／85 分 |
| rail | 捷運轉乘，33 分／91 分 | 捷運＋台鐵 1142，33 分／85 分 | 公車 1062，36 分／83 分 |

- 公車由第 3 升第 2，這三條公共候選的時間、分數及路段不變；不是 token／routeId 差異。再送 none，恢復原排序。
- bus 仍保留捷運與捷運＋台鐵接駁；rail 仍保留公車。第一名捷運沒有被軟性偏好強制排除。本案例未呈現 rail 相對 none 的升名，不能把它當成 rail 必然提升的證據。
- 台北→六張犁：none 的第二、三名為捷運轉乘（40 分）、292 公車（63 分）；bus 改為 1916A＋568 公車（41 分）、步行，證明真實候選集合亦有變化。第一名仍是 32 分捷運轉乘。
- 台北→板橋：三種偏好皆為高鐵／台鐵，normal 為 10／12 分、wheelchair 為 13／16 分、elderly 為 11／13 分。這是「明確 bus 但不一定回公車」的真實案例，不應宣傳成硬性指定運具。
- 其他矩陣包含台北→松山、台北101→台北、台北→桃園、中山→大安、台北→市政府、公館→南京復興。多數第一名不變；台北101→台北的 rail 次選公車候選有變化，但不代表找到鐵路。

### 串接與回歸

- 真實自然語言 query＋明確座標：公車／台鐵需求分別解析為 bus／rail，排序符合明確 enum 的結果，明確起訖座標保留。明確 none 覆蓋「偏好公車」query；`metro` 非法值回 400。
- bus／rail 初始回應皆取得真實 Redis routeToken；以 MANUAL 原因呼叫 reroute，皆成功由版本 1 升 2。再透過實際 token service 讀取**本次測試產生**的 Redis envelope，確認 canonicalRequest 仍分別保存 bus／rail，mode 仍為 normal。不能只靠 reroute 回 200 推論偏好保存。
- 本次重跑 9 個相關 Vitest 檔案、329 項測試通過；與上節原實作日的 14 檔／423 項為不同執行範圍，不累加計數。`pnpm build`（含架構檢查）與 `git diff --check` 通過。
- 獨立 verifier 已核對 41 筆 JSON、排序及數值一致性、自然語言優先序與 reroute canonical 證據；核對的是已執行的原始產物，沒有另外重跑 HTTP。

### 仍未驗收

- 前端操作／地理編碼全流程、agent chat 真實工具執行迴圈、麥克風／Live WebSocket，以及正式部署環境。
- 本次 wheelchair 僅驗證真實正常路線可規劃；未在真實環境注入樓梯、故障電梯或封路反例，因此不宣稱已重新證明所有無障礙硬限制與危險排除。
- 更多長程、跨縣市、不同時段與無服務場景；未找到本次 rail 相對 none 升名的案例。1.5 權重的產品效益仍需擴充對照樣本。
- 單次請求延遲受快取與外部資訊影響，不是可靠的效能基準。

## 新目標的六都基準：偏好運具應盡量出現在前三條（2026-10-04）

本節是使用者提出更強「選哪種就大機率看見哪種」目標後的**現行實作基準**，不是新策略已實作的驗收。沒有改動功能程式或部署。

### 案例與實跑結果

固定 `2026-10-05T09:00:00+08:00`，六都各兩組。第二組多數使用車站東側約數百公尺的街區座標，而非車站本身；這些是測試座標，不代表使用者的住家。每組先以真實 OTP 分別搜尋 BUS＋WALK、RAIL＋WALK，確認回傳含實際乘車段，而不是只回 WALK；限定 OTP `maxTransfers: 3`，對應後端 `maxTransfers: 2`。12 組均找到兩類方案，鐵路證據均為 TRA，不以捷運充數。此可行性探測使用 normal／非輪椅條件，未證明所有公車均可供輪椅搭乘；探測步速 1.33 m/s，現行後端 normal 為 1.3 m/s，因此不拿兩層的分鐘數作精確等值比較。

後端正常模式每組 none／bus／rail，共 36 次；每都第一組另跑 wheelchair 的三種偏好，共 18 次。54 次真實 HTTP 均回 200，但 **200 不等於符合運具偏好目標**。

| 城市 | 兩組起訖 | normal 選 bus，前三條含 BUS | normal 選 rail，前三條含 TRA／THSR |
| --- | --- | --- | --- |
| 台北 | 松山→南港；萬華站東側街區→松山 | 2/2 | 2/2 |
| 新北 | 板橋→樹林；樹林站東側街區→鶯歌 | 0/2 | 2/2 |
| 桃園 | 桃園→中壢；中壢站東側街區→埔心 | 0/2 | 2/2 |
| 台中 | 台中公園雙十路→潭子；台中站東側街區→新烏日 | 1/2 | 2/2 |
| 台南 | 台南→永康；大橋站東側街區→台南 | 1/2 | 2/2 |
| 高雄 | 高雄→鳳山；新左營站東側街區→楠梓 | 1/2 | 2/2 |

- normal bus 存在率 **5/12**；若只算 WALK＋BUS 的公車主體方案、不把 BUS＋TRA 接駁計為成功，為 **4/12**。normal rail 為 **12/12**，但多數是原本即佔優勢的台鐵走廊，不可推廣為全臺鐵路偏好成功率。
- wheelchair 六組的 bus 存在率 **2/6**、rail 為 **6/6**。尚未逐一驗證那些未回傳公車的案例是否具備輪椅可搭條件，不能直接宣稱都是安全方案被誤排除。
- 台中公園→潭子：normal 火車方案 26 分、步行 842 m；wheelchair none 時第一名為 41 分／步行 202 m 的公車，33 分／步行 842 m 的台鐵排第二。選 rail 後台鐵升第一；選 bus 後台鐵降第三，仍保留。這個案例證實較遠步行的火車可以被保留，但不是其他起訖也必然如此。
- 完整座標：`/tmp/transit-preference-six-cities-cases.json`；OTP 基準：`/tmp/transit-preference-six-cities-feasibility-v2/`；HTTP 基準：`/tmp/transit-preference-six-cities-http-baseline/`。HTTP 原始檔含短效 routeToken，不公開分享。腳本為 `/tmp/transit-preference-six-cities-probe.js` 與 `/tmp/transit-preference-six-cities-backend.js`，皆已在實際服務上執行。

### 早期建議策略（尚未實作，非後續採用方案）

以下保留當時的建議紀錄；後續已改為先診斷／保留既有候選、不新增搜尋分支，且以回應時間不退化為優先。不是本次 metro 擴充的實作內容。

1. **搜尋層補偏好候選**：一般全運具搜尋仍保留；額外取得公車主體／鐵路候選，混合接駁亦保留。不將偏好變成全局禁搭其他運具。單靠加大權重無法救回 OTP 未提供的候選。
2. **保留到補資料階段**：前 8 名至少留一個偏好候選，避免步行成本先把它淘汰，導致它連無障礙設施檢查都沒機會做。
3. **先安全檢查，再保留展示名額**：通過已知樓梯、電梯及危險路段條件後，前三條至少保留一個偏好方案，不強迫第一名；不得為了湊名額復活已排除／degraded 的路線。真實步行距離、時間與無障礙分數保持不變。
4. **明確揭露取捨**：偏好方案若需多走路或多等待，讓使用者看得到；找不到或搜尋逾時，不假稱確定沒有實體路線。不要用極短公車接駁段充數「公車為主」。
5. **後續驗收**：沿用六都每都至少兩組，加平日早／晚與假日時段，含 normal／wheelchair；先證明同條件下的偏好候選可行，再衡量前三條存在率。另驗證 none 原行為、接駁、中途點、reroute、快取隔離與安全反例。

## 變更檔案

| 檔案 | 用途 |
| --- | --- |
| `src/modules/accessible-route/planners/transit-preference.ts` | 單一運具權重及後端附加成本計算。 |
| `src/modules/accessible-route/planners/transit-preference.test.ts` | 本次 metro 擴充新增：四種偏好的完整權重矩陣、混合乘車與異常分鐘罰分測試。 |
| `src/modules/ai/ai.intent.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/schemas/transit-preference.schema.ts` | API、AI 意圖與工具共用的 enum 驗證。 |
| `src/config/ai/__fixtures__/chat-system-prompt.golden.txt` | 同步刻意新增的 prompt 規則。 |
| `src/config/ai/agent-prompt-shared.ts` | 文字與語音共用偏好、取消及軟性限制規則。 |
| `src/config/ai/chat-prompt.ts` | 文字 agent 掛入共用規則。 |
| `src/config/ai/config.ts` | Gemini structured output 的偏好 enum。 |
| `src/config/ai/contents.ts` | 自然語言意圖解析規則，區分車站目的地與乘車偏好。 |
| `src/config/ai/tool.ts` | 摘要／導航工具宣告偏好參數。 |
| `src/constants/messages.ts` | 共用無效偏好錯誤訊息。 |
| `src/modules/accessible-route/accessible-route.schema.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/accessible-route/accessible-route.schema.ts` | 路線請求、回應及公車乘車時間的 OpenAPI 契約。 |
| `src/modules/accessible-route/accessible-route.service.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/accessible-route/accessible-route.service.ts` | 解析優先序、保留明確起訖點、各中途點傳遞、預排序／最終排序、回應及 reroute intent。 |
| `src/modules/accessible-route/accessible-route.types.ts` | 規劃選項、canonical request 與回應型別傳遞偏好。 |
| `src/modules/accessible-route/low-floor-rerank.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/accessible-route/low-floor-rerank.ts` | 低地板資訊更新後的重排仍計入偏好成本。 |
| `src/modules/accessible-route/planners/otp-routing.cache.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/accessible-route/planners/otp-routing.ts` | 所有 transit 搜尋傳入 modeWeight，納入既有變數快取鍵，保留公車乘車時間。 |
| `src/modules/accessible-route/planners/otp-routing.types.ts` | OTP 規劃選項增加偏好。 |
| `src/modules/accessible-route/ranking.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/accessible-route/reroute.service.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/accessible-route/transit-waypoints.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/ai/agent-tools.test.ts` | 新增／擴充偏好行為的回歸測試。 |
| `src/modules/ai/agent-tools.ts` | 摘要與逐步導航工具參數驗證、dispatch 與 shared planner 傳遞。 |
| `src/modules/ai/ai.service.ts` | 接收、驗證 AI 意圖偏好；舊輸出或無效值回到 none。 |
| `src/modules/voice/voice-prompt.ts` | 語音 agent 掛入共用規則。 |
| `src/schemas/route-intent.schema.ts` | 意圖回應與 OpenAPI 支援偏好。 |
| `src/scripts/agent-cases.ts` | 新增 6 個可重複執行的真實模型工具選擇驗收案例；2026-10-04 再新增 1 個 metro 案例（尚未對真實模型執行）。 |
| `src/types/ai.ts` | RouteIntent.preferences 增加選填 transitPreference。 |
| `src/types/route.ts` | 定義 TransitPreference；公車路段增加選填 rideMinutes，保留 OTP 乘車分鐘。 |
| `docs/reports/transit-preference.md` | 設計、使用方式、驗證範圍與待驗收項目。 |

## 2026-10-04 追加：新增 `metro` 偏好

本次變更檔案（與上方累積的 bus／rail 改動清單分開）：

| 本次檔案 | 原因 |
| --- | --- |
| `src/types/route.ts`、`src/schemas/transit-preference.schema.ts` | 增加 metro 型別及共用輸入 enum。 |
| `src/modules/accessible-route/planners/transit-preference.ts`、`otp-routing.ts`（同目錄） | metro 權重與 MONORAIL 映射一致。 |
| `src/modules/accessible-route/accessible-route.schema.ts`、`src/constants/messages.ts` | 更新 OpenAPI 說明及非法值訊息。 |
| `src/config/ai/config.ts`、`tool.ts`、`contents.ts`、`agent-prompt-shared.ts`（同目錄）、`__fixtures__/chat-system-prompt.golden.txt`（同目錄） | structured output、兩工具與文字／語音共用規則同步。 |
| `src/modules/accessible-route/accessible-route.schema.test.ts`、`accessible-route.service.test.ts`、`ranking.test.ts`、`reroute.service.test.ts`（同目錄） | enum、優先序、排序、canonical／reroute 回歸測試。 |
| `src/modules/accessible-route/planners/otp-routing.cache.test.ts`、`transit-preference.test.ts`（同目錄，後者新增） | 查詢矩陣、模式映射、cache 隔離、純運算測試。 |
| `src/modules/ai/ai.intent.test.ts`、`agent-tools.test.ts`（同目錄） | AI 值解析與兩工具實際傳遞 metro。 |
| `src/scripts/agent-cases.ts` | 新增尚未執行的真實模型工具選擇案例。 |
| `docs/reports/transit-preference.md` | 更新契約並分開記錄實測結果與未驗事項。 |

本次只新增選填 `transitPreference: "metro"`，其他語意不變：`rail` 仍只含台鐵＋高鐵；既有 bus/rail 權重 1／1.5 與查詢梯、transportModes allowlist、快取／逾時、站點皆未修改。未實作候選保留、50% 里程分類或三態安全政策，未新增搜尋分支、未調整既有重試梯，也未部署；不宣稱各偏好的實際 OTP 呼叫數恆相同。上述各節的六都與真實 OTP 結果皆為 none/bus/rail 的歷史紀錄，**不是 metro 的證據**。

- 契約：HTTP、`/ai/intent`、structured output 與 `planAccessibleRoute`／`getNavInstructions` 兩個工具宣告共用 enum `none|bus|rail|metro`；省略仍為 undefined，未知值（如 `subway`、`train`、null、陣列）被拒或 AI 意圖回到 none。
- OTP 權重：metro 時 SUBWAY／TRAM／MONORAIL 為 1，BUS／TROLLEYBUS／RAIL 為 1.5。`otp-routing.ts` 把 `MONORAIL` 與 SUBWAY／TRAM 同樣映射為後端 METRO，避免 OTP 偏好輕軌、後續卻當作公車。
- 後端排序：metro 時 METRO 乘車分鐘不加罰，BUS／TRA／THSR 每分鐘 0.5；非有限或負的 rideMinutes 不計；總時間與無障礙分數不變。
- Prompt：想搭捷運／地鐵／輕軌→metro；僅目的地為「捷運站」不代表偏好；取消與最新指示優先沿用。chat system prompt golden fixture 以 `CHAT_SYSTEM_PROMPT` 當前輸出重生（僅偏好規則一行變動），`chat-prompt.test.ts` 的逐位元比對未放寬。
- 測試（全為 mock／fake 外部 I/O，未打真實 OTP／模型）：新增 `planners/transit-preference.test.ts`（四種偏好六模式權重、混合 BUS＋METRO＋TRA＋THSR 與異常 rideMinutes 的罰分）；擴充 schema、ai.intent、agent-tools（兩工具 enum 與 dispatch）、otp-routing.cache（metro modeWeight 矩陣、cache 隔離、none／省略共用、SUBWAY／TRAM／MONORAIL→METRO）、ranking（normal／wheelchair／elderly 偏好 metro、保留其他運具接駁與快很多的非偏好路線）、service（request 優先、AI metro、canonical 保留）與 reroute（rail、metro 保留）。
- 實作者交付時未驗證：metro 偏好在真實 OTP 的排序效果、延遲、六都結果與真實模型的工具選擇。後續主對話驗證如下；`agent-cases.ts` 的對話工具選擇案例仍未對真實模型執行。

### 主對話後續驗證（真實依賴、獨立測試程序）

將 `pnpm build` 產物複製至既有 backend 容器的 `/tmp/metro-preference-new/dist`，只啟動獨立 Express 測試程序；連接既有真實 OTP 2.9、Mongo、Redis、TDX，行人圖預熱為 ready。不重啟、不替換 `/app/dist` 或既有服務；這不是部署。

- 七組：市政府→西門、新店→頂溪、長庚醫院→高鐵桃園、文華高中→高鐵臺中、台南→永康、高雄車站→左營、鼓山區公所→愛河之心（輕軌）。各測 normal／wheelchair 與 none／bus／rail／metro，共 **56 次規劃 HTTP 全 200**，回應偏好皆與輸入一致。固定出發 `2026-10-05T09:00:00+08:00`、`maxTransfers: 2`。
- 14 次 metro 規劃中 **12 次含 METRO**；其餘是沒有捷運的台南案例，正確保留 TRA 回退，不強迫不存在的運具。這是選定案例的存在率，不代表全臺或主體保留保證，也不證明所有路線已完成全部無障礙查證。
- 真實模型自然語言「我想從市政府站到西門站，偏好搭捷運」解析及套用為 metro；同句加明確 `none` 時套用 none。這測的是意圖解析，不是對話／語音模型的工具選擇。
- metro 路線 Redis canonical 值為 metro；MANUAL reroute HTTP 200，版本 1→2，新 canonical 仍為 metro。
- 非法 `subway` HTTP 400；獨立程序的 OpenAPI 三處偏好 enum 均為 `none|bus|rail|metro`。
- 舊程式另跑六都 36 次 none／bus／rail 作基準；新程式對應 36 次的乘車模式、總分鐘、步行距離、degraded 摘要全相同。未逐位元比較設施陣列、即時延誤或 token。
- 效能觀察：上述匹配 36 次，舊 p50／p95 為 1241／4999 ms，新為 1178／4814 ms；新 metro 14 次 p50 為 1185 ms、最慢 5072 ms。兩輪依序執行、混合快取狀態且樣本少，**不是受控延遲驗收，不可宣稱確定變快或 p99 無退化**。
- 同容器交錯 CPU 批次測量（僅 `transitModeWeights`＋`transitPreferencePenalty`）：舊／新既有偏好的批次平均每次 p50 為 0.287／0.294 μs，metro 為 0.401 μs。分位數是批次平均，不是完整 HTTP 延遲，也不含外部查詢。
- 主對話重跑 `pnpm build`、`git diff --check`；全套測試 **2747 passed／16 skipped，211 files passed／6 skipped**。第一次在 context-mode 新 TMPDIR 下重下載 MongoMemoryServer binary 造成 3 個 integration suite 啟動逾時及下載 rename 錯誤；改以既有主機 binary 快取重跑全綠，未修改或放寬測試。
- 產物：`/tmp/metro-preference-http-check.cjs`、`/tmp/metro-http-before-summary.json`、`/tmp/metro-http-after-summary.json`、`/tmp/metro-preference-cpu-check.cjs`、`/tmp/metro-preference-cpu-result.jsonl`。summary 不含 routeToken；測試過程的原始 log 留本機，不公開分享。

### 獨立審查與補測

唯讀 reviewer 在 8-turn 上限內審查，未找到 BLOCKING 程式缺陷，但以 MAJOR 指出既有 reroute 單元測試 mock 掉規劃 service，不能獨立守住兩段串接；並建議兩個工具描述同步「地鐵」同義詞。審查未執行測試／build／live API，不代表無限範圍的完整稽核。

主對話已處理：

- `accessible-route.service.test.ts` 新增可重複的 canonical reroute 串接測試：先由真實 `planAccessibleRouteFromRequest` 產生 metro canonical，再呼叫真實 `rerouteAccessibleRoute`；只在 Redis repository／OTP 等資料邊界沿用 fake，沒有 mock 規劃 service 或導航指令生成。斷言新起點、metro 到達 OTP 選項、版本 2、非空導航步驟，以及提交的 canonical 仍為 metro。
- `src/config/ai/tool.ts` 兩工具的 metro 描述皆列出捷運／地鐵／輕軌。
- 補測後四個相關檔案 **241 tests passed**；再跑全套 **2748 passed／16 skipped、211 files passed／6 skipped**；`pnpm build` 與 `git diff --check` 通過，兩個補改 TS 檔主動 LSP 均 confirmed clean。
- 上述補改由主對話自驗，沒有再次派獨立審查；先前真實 HTTP 的權重、路由與儲存程式不變，僅新增測試與工具描述。

**仍未驗證／未完成**：受控冷／暖快取與負載下的端對端 p95／p99 回歸驗收、真實文字／語音工具選擇、前端偏好選單、候選保留策略。尚未 commit 或部署。
