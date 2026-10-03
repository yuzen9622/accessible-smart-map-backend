# 公車／鐵路軟性偏好：設計與實作驗證

日期：2026-10-03。狀態：後端與 AI 串接完成、本機驗證通過；真實 OTP 路線驗收及部署待完成。

## 契約與設計

沿用 `POST /api/v1/a11y/accessible-route`，增加選填 `transitPreference`：

| 值 | 語意 |
| --- | --- |
| `none` | 不指定或明確取消偏好 |
| `bus` | 偏好公車，仍允許鐵路／捷運等接駁 |
| `rail` | 偏好鐵路（台鐵、高鐵），不包含捷運；仍允許公車接駁 |

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
- OTP 2.9.0 `plan.modeWeight`：偏好運具為 1，其餘支援的大眾運輸運具為 1.5。bus 包含 BUS/TROLLEYBUS；rail 使用 RAIL；SUBWAY/TRAM/MONORAIL 為其他運具。none 不傳權重，保留原預設。沿用原 transportModes allowlist。
- 初始、加寬、站點吸附重試及後續時段搜尋均攜帶權重；快取鍵既有的完整 variables 序列化包含權重。none 與省略可共用原本快取，bus/rail 分開。
- 後端預排序、最終排序及低地板資訊重排，加上「非偏好運具乘車分鐘 × 0.5」。不修改真實總時間或無障礙分數；等待、步行不計入此附加成本。公車新增選填 rideMinutes，避免僅有鐵路可計算乘車成本。
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

## 限制與待驗收

設定的 OTP 端點連線回 `ECONNREFUSED`，未啟停或部署服務。已完成真實 LLM 語意／工具參數驗證與 mock 上游的程式整合測試，尚未實測真實 OTP 班次的偏好路線、延遲或部署 HTTP。語音共用工具與 prompt 已更新並通過回歸測試，未進行真實麥克風／Live WebSocket 驗收。

1.5 是初版軟性成本，不是經全臺路線校準的最佳值；OTP 恢復後應比較相同起訖／出發時間下 none/bus/rail 的短程與長程結果，含 normal/elderly/wheelchair。偏好不保證排序第一必用指定運具，其他時間、設施、安全因素及既有未來班次保留仍會影響結果。rail 無法區分只搭台鐵或只搭高鐵；本次不提供硬性禁搭或帳號持久設定。

## 變更檔案

| 檔案 | 用途 |
| --- | --- |
| `src/modules/accessible-route/planners/transit-preference.ts` | 單一運具權重及後端附加成本計算。 |
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
| `src/scripts/agent-cases.ts` | 新增 6 個可重複執行的真實模型工具選擇驗收案例。 |
| `src/types/ai.ts` | RouteIntent.preferences 增加選填 transitPreference。 |
| `src/types/route.ts` | 定義 TransitPreference；公車路段增加選填 rideMinutes，保留 OTP 乘車分鐘。 |
| `docs/reports/transit-preference.md` | 設計、使用方式、驗證範圍與待驗收項目。 |
