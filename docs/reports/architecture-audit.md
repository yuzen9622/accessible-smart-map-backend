# 架構稽核報告（Clean Backend Architecture）

> 版本：1.0　日期：2026-06-15　稽核者：Claude（`/clean-backend-architecture`）
> 範圍：以 **6 大分層不變式** 重新檢視現有後端，並產出可逐片（slice）執行的遷移計畫。
> v1.0 為純稽核（未改碼）。

> **執行進度（2026-06-15，分支 `refactor/eliminate-service-layer`）**
> ✅ **Slice 4 已執行：消滅頂層 `src/service/`**。11 個 accessible-route 專屬 planner 已 `git mv` 進
> `src/modules/accessible-route/planners/`（去掉 `.service` 後綴），`TdxTokenManger` → `src/adapters/tdx.adapter.ts`。
> `tsc` 全綠、git 全部記錄為 rename（保留歷史）。結果：`*.service.ts` 只剩在模組內，命名不再重複。
>
> ✅ **Slice 0 已執行：常數化（不變式 5）+ 收斂回應契約（不變式 4）**。新增 `src/constants/messages.ts`（`MSG` / `ERROR_MESSAGE`）；
> 全部 `sendResponse` 的原始狀態碼改用 `ResponseCode.*`（含 auth middleware 的 401/403），重複訊息改引用具名常數；
> 4 處自拼 envelope（`ai.chat` success+error、`user` login catch、`app.ts` 404、validate middleware）改走 `sendResponse`。
> `tsc` 全綠、API 回應形狀不變（`ResponseCode.OK === 200`）。**不變式 5 由 🔴 FAIL → 🟢 PASS**。
>
> ✅ **Slice 1**（不變式 3）：`validateRequest` 將解析後的值寫回 `req.*`，controller 一律讀已驗證輸入；`/air/air-quality` 補上 schema。
> ✅ **Slice 2**（不變式 2）：`ai.service`（intent/explain）、`ai-chat.service`（tool loop）、`air.service.getAirQualityWithAI` 從 controller 抽出；controller 不再呼叫 LLM SDK 或 import 別的 controller。
> ✅ **Slice 3**（不變式 2）：accessible-route controller 的編排下沉到 `planAccessibleRouteFromRequest`；controller 只剩 parse → 呼叫 service → `sendResponse`。
> ✅ **Slice 5**（不變式 1）：`a11y-scoring`（735 行）→ `modules/accessible-route/scoring.ts`；transit 文字工具 → `src/utils/transit-text.ts`；`config/` 只剩設定。
> ✅ **Slice 6**（治理）：`AGENTS.md` 規則書 + `npm run lint:arch`（`scripts/check-architecture.mjs`）邊界檢查，掛進 `prebuild` 成為 build gate。
>
> **全部 7 片完成。六大不變式現況：1🟢 2🟢 3🟢 4🟢 5🟢 6🟢。**

## 與既有 `docs/reports/ARCHITECTURE.md` 的關係

`ARCHITECTURE.md`（v1.1）記錄的是 **歷史重構（Phase 1–8）** 與「路由型別倒置依賴」的深度分析。
本報告 **不取代** 它，而是補上它未涵蓋的面向（回應契約、魔術常數、邊界驗證、跨層 import），
並用一套**與技術棧無關的不變式**重新打分。

先做一個重要校正 —— `ARCHITECTURE.md` §4/§6/§7 描述的多數問題**其實已經修好了**，
但該文件未把這些項目勾掉，容易誤導讀者以為仍待辦：

| ARCHITECTURE.md 提到的待辦                                         | 目前程式碼的實際狀態                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `config/map.ts`（getCity 呼叫 Google）                             | ✅ 已不存在；併入 `adapters/google.adapter.ts`        |
| `config/ors.ts`（ORS HTTP client）                                 | ✅ 已移至 `service/ors.service.ts`                    |
| `config/lib.ts::getCoordinates()`                                  | ✅ 已移除；`lib.ts` 現僅剩純工具函式 + `sendResponse` |
| `a11y.service.ts` / `transit.service.ts` / `air.service.ts` 不存在 | ✅ 三者皆已建立                                       |
| 路由領域型別倒置依賴（§9）                                         | ✅ Phase 8 已下沉至 `src/types/route.ts`              |

換句話說：**§7 路線圖的 Phase 1–8 已實質落地**。本報告聚焦於**之後仍未處理、或當時未列入**的結構問題。

---

## TL;DR — 總體結論

分層骨架已經建立得不錯（模組化、單一 `/api/v1` 前綴、有共用 `sendResponse`、有 schema 驗證中介層、型別已下沉）。
**剩下的「亂」集中在四件事**：

1. **`src/service/` 這個扁平層裡的 11 個檔案，其實只屬於 `accessible-route` 一個模組** —— 不是跨模組共用，卻住在頂層。
2. **沒有 `src/constants/`** —— HTTP 狀態碼、錯誤訊息、外部 URL 全靠魔術字面值散落各處。
3. **回應契約有破口** —— 仍有 3~4 處繞過 `sendResponse` 自己拼 envelope。
4. **驗證在邊界做了、卻沒被使用** —— controller 讀原始 `req.body`，把 `req.validated` 丟掉。

外加兩個既有 god-file：1995 行的 `accessible-route.service.ts` 協調器、735 行被誤放在 `config/` 的評分引擎。

---

## §1 六大不變式 Scorecard

| #   | 不變式                   | 評級       | 一句話結論                                                                                                                 |
| --- | ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | **一檔一責，檔名即職責** | 🟠 PARTIAL | 模組命名乾淨，但 `config/a11y-scoring.ts`（735 行領域邏輯）與 1995 行協調器違反單一職責                                    |
| 2   | **單向依賴**             | 🟠 PARTIAL | service 層乾淨（無 req/res）；但 controller→controller 跨模組 import、controller 直接呼叫 LLM SDK、controller 內含業務邏輯 |
| 3   | **邊界驗證**             | 🟠 PARTIAL | 有驗證中介層，但 `req.validated` 完全沒被用；6 條路由無 schema                                                             |
| 4   | **單一回應契約**         | 🟠 PARTIAL | 多數走 `sendResponse`，但 4 處（ai.chat / user / app.ts / 驗證中介層）自拼 envelope                                        |
| 5   | **零魔術字面值**         | 🔴 FAIL    | 無 `constants/`；狀態碼/錯誤字串/外部 URL 全為內聯字面值                                                                   |
| 6   | **單一註冊點**           | 🟢 PASS    | 單一 `/api/v1` 前綴、每模組一個 `index.ts`（唯一小瑕疵：a11y 與 accessible-route 共用同一前綴）                            |

---

## §2 詳細發現（附 file:line 佐證）

### 不變式 1 — 一檔一責 🟠

| 證據                                                                  | 問題                                                                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/a11y-scoring.ts:241-712`                                  | 735 行的**無障礙評分引擎**（`scoreRoute`、`routeCost`、`scoreOsmNode`…）是核心領域邏輯，卻放在 `config/`。config 應只有常數與 client 初始化           |
| `src/modules/accessible-route/accessible-route.service.ts`（1995 行） | 同時是「領域協調器」與超大 god-file；`ARCHITECTURE.md §9` 已修掉型別倒置，但檔案體積與職責仍過載                                                      |
| `src/config/lib.ts:34-196`                                            | `normalizeStopName`、`detectBusApiType`、`getRouteDirectionImproved` 等是 transit 領域工具，混在 `lib.ts`（同檔還有 transport 相關的 `sendResponse`） |

### 不變式 2 — 單向依賴 🟠

✅ **好消息**：掃描全部 `*.service.ts` 與 `src/service/*`，**沒有任何一個 import `Request`/`Response` 或 controller/router**。領域層對 transport 是乾淨的。

🔴 **破口**：

| 證據                                                             | 問題                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/ai/index.ts:2` + `accessible-route.controller.ts:8` | `parseRouteIntent`/`generateRouteExplanation` 從 **controller** 匯出，又被另一模組的 controller import → **controller → controller 跨模組依賴**。這兩個其實是領域函式，應住在 service |
| `air.controller.ts:23-37`                                        | `air.service` 已存在且被用（`:17`），但 **Gemini `generateContent` 仍在 controller 裡**。AI 生成那一半從未進 service                                                                  |
| `ai.chat.controller.ts:66,171,201`                               | 整個 agent tool-loop（多次 `openai.chat.completions.create`）都在 controller 內                                                                                                       |
| `accessible-route.controller.ts:23-55, 61-93`                    | controller 內含實質業務邏輯：語意意圖解析、座標解析、城市 fallback、出發時間正規化。應下沉成一個 service 入口（如 `planFromRequest`）                                                 |

### 不變式 3 — 邊界驗證 🟠

`validate-request.middleware.ts:45` 把結果寫進 **`req.validated`**，且**不會**改寫 `req.body`。但所有 controller 仍讀原始來源：

| 證據                                                                                                                | 問題                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessible-route.controller.ts:16-18`                                                                              | 讀 `req.body`，丟棄 `req.validated`（已驗證/已 coerce/已 strip 的資料被浪費）                                                                                                     |
| `transit.controller.ts:10-11,38` · `air.controller.ts:16` · `a11y.controller.ts:40-41` · `ai.controller.ts:185,224` | 同上，全讀原始 `req.body`/`req.query`                                                                                                                                             |
| 無 schema 的 6 條路由                                                                                               | `user`: `/refresh`、`/info`、`/logout`；`air`: `/air-quality`；`a11y`: `/all-places`、`/all-bathrooms`（見 `user.router.ts:24-25,32`、`air.router.ts:7`、`a11y.router.ts:13-14`） |

> 注意：中介層在「某個 key 沒給 schema」時不會把該 key 放進 `req.validated`，這正是 controller 不敢用 `req.validated` 的原因 —— 修這個中介層是讓 controller 統一改讀 validated 的前置條件。

### 不變式 4 — 單一回應契約 🟠

共用 envelope 是 `config/lib.ts:5` 的 `sendResponse`。以下繞過它自拼 envelope：

| 證據                                                         | 問題                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `ai.chat.controller.ts:208-221`                              | 成功路徑 `res.json({ ok, status, code, ... })` 手拼             |
| `ai.chat.controller.ts:224-229` · `user.controller.ts:51-56` | 錯誤路徑 `res.status(500).json({...})` 手拼                     |
| `app.ts:40-45, 72-79`                                        | health check 與 404 handler 各自拼 shape                        |
| `validate-request.middleware.ts:36-42`                       | 400 驗證錯誤直接拼 envelope（可接受，但應共用同一份錯誤 shape） |

### 不變式 5 — 零魔術字面值 🔴

**沒有 `src/constants/` 目錄**，沒有 `HTTP_STATUS`/`ERROR_MESSAGE` 來源。

| 類別                                 | 證據                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **內聯狀態碼**                       | `sendResponse(res, …, 200/400/404/500, …)` 全用原始數字而非 `ResponseCode` enum：`accessible-route.controller.ts:28,58,73,112,126`、`a11y.controller.ts`（9 處）、`air.controller.ts:20,43,52`、`transit.controller.ts`（7 處）、`ai.controller.ts:202,205,213,237`、`user.controller.ts:249,251`（共 ~27 處） |
| **重複錯誤字串**                     | `"缺少必要參數"`（accessible-route:58、transit:14,41、a11y:26）、`"Internal Server Error"`（5+ 處）、`"無法解析您的查詢…"`（accessible-route:36、ai:233）                                                                                                                                                      |
| **內聯外部 URL（非來自 typed env）** | ORS base `ors.service.ts:11`、TDX MaaS `tdx-routing.service.ts:43`、TDX token `TdxTokenManger.ts:11`、STA 空品 `air.service.ts:20`、Gemini fallback `config/ai.ts:13`、OTP fallback `http://localhost:8080`（`otp-routing.service.ts:217,292,369`，重複 3 處）                                                 |

> `config/transit.ts` 的 TDX URL 已集中為常數，屬正確示範；其餘服務的 URL 應比照辦理。

### 不變式 6 — 單一註冊點 🟢

`app.ts:64-69` 單一 `/api/v1` 前綴、每模組一個 `createXRouter()` factory、每模組一個 `index.ts`。唯一小瑕疵：

- `app.ts:66-67`：`createA11yRouter()` 與 `createAccessibleRouteRouter()` **都掛在 `/api/v1/a11y`**。功能上可行，但「一個前綴兩個註冊點」會讓人找路由時要看兩個檔案。建議 accessible-route 改掛 `/api/v1/route`（或明確記錄此共用前綴的分工）。

---

## §3 `src/service/` 扁平層所有權地圖

**校正先前假設**：`gtfs-time`、`indoor-graph`、`walk-cache` **並非死碼** —— 它們是此叢集的內部 helper，用相對路徑互相 import（先前以 `service/` 前綴掃描才漏掉）。

```
src/service/（11 個檔案 = accessible-route 專屬叢集 + 1 個真．跨切面）

  accessible-route.service.ts (協調器, 在 modules/ 內)
    ├── otp-routing.service ──┐
    ├── tdx-routing.service ──┤── route-a11y.service ── indoor-graph.service ┐
    ├── realtime-transit.service ── gtfs-time              │                  │
    ├── facility-status.service                            │                  │
    └── transfer-finder (在 modules/ 內)                    │                  │
          ├── a11y-exit.service ───────────────────────────┘                  │
          ├── reachable-stops.service ── ors.service ── walk-cache.service ───┘
          └── ors.service

  ⮕ 以上 11 檔的 import 來源「只有」accessible-route 模組（已用 grep 全 src 驗證）

  TdxTokenManger.ts  ⮕ 被 config/fetch.ts 使用 = 真正的跨切面基礎設施（不屬任何模組）
```

**結論**：`src/service/` 名義上是「跨模組共用層」，**實際上只有 `TdxTokenManger` 是跨切面**。其餘 11 個是 `accessible-route` 的領域 planner，住錯地方了。

> 這與 `ARCHITECTURE.md §6`「service/ 其餘不動」的決定**有意見分歧**。當時把 `service/` 當共用層保留；
> 但按「模組私有服務應住在模組內」的不變式，且這些檔案只被一個模組使用 —— 把它們收進模組才是乾淨解。
> 由於型別已於 Phase 8 下沉到 `src/types/route.ts`，搬移**不會**重新產生循環依賴。

---

## §4 遷移計畫（逐片執行，每片皆可獨立 PR + `tsc` 驗證）

> 順序依「風險低→高、前置依賴」排列。每片結束都應 `npm run build` 綠燈才算完成。
> ⚠️ **與工作目錄衝突警告**：目前未提交的改動正好落在 `config/transit.ts`、`service/otp-routing`、
> `service/realtime-transit`、`service/tdx-routing`。**Slice 5 會搬移這些檔案，務必先 commit 或 stash 再做。**

### Slice 0 — 建立 `constants/` + 收斂回應契約（不變式 4、5）

- 新建 `src/constants/http-status.ts`（沿用既有 `ResponseCode`，或包一層 `HTTP_STATUS`）與 `error-message.ts`。
- 全面把 `sendResponse(…, 200/400/…, …)` 的原始數字換成具名常數；重複錯誤字串改引用 `ERROR_MESSAGE.*`。
- `ai.chat.controller.ts:208,224`、`user.controller.ts:51`、`app.ts:40,72`、驗證中介層 → 全部改走 `sendResponse`（或一個共用的 envelope builder，供非 Express-`Response` 場景）。
- **風險：低**（純內部、API 行為不變）；改動點多但機械化。

### Slice 1 — 補滿邊界驗證（不變式 3）

- 修 `validate-request.middleware.ts`：沒給 schema 的 key 也要把原始值放進 `req.validated`，讓 controller 能統一讀 validated。
- 所有 controller 改讀 `req.validated.{body,query,params}`，停止讀原始 `req.body`/`req.query`。
- 為無 schema 的 6 條路由補 schema（或明確標記為 schema-exempt 並寫進註解）。
- **風險：中**（行為等價，但需逐路由確認 coerce 結果）。

### Slice 2 — 把 AI / air 的領域邏輯下沉到 service（不變式 2）

- `parseRouteIntent`/`generateRouteExplanation`：`ai.controller.ts` → `ai.service.ts`（或新 `ai-intent.service.ts`）；`ai/index.ts` 改從 service re-export；`accessible-route.controller.ts:8` 的 import 改指 service。
- air 的 Gemini 呼叫（`air.controller.ts:23-37`）→ `air.service.ts::getAirQualityWithAI()`。
- `ai.chat.controller.ts` 的 agent tool-loop → 抽到 service（controller 只留 SSE 串流與 parse）。
- **風險：中**；消除 controller→controller import 與 controller 端 LLM 呼叫。

### Slice 3 — 瘦身 `accessible-route.controller`（不變式 2）

- 把意圖解析 + 座標/城市解析 + 出發時間正規化（`controller:20-93`）抽成 service 入口（如 `accessibleRouteService.planFromRequest(input)`）。
- controller 回到「parse 輸入 → 呼叫一個 service → `sendResponse`」。
- **風險：中**。

### Slice 4 — 把 accessible-route 專屬 planner 收進模組（不變式 1、2）

- 將 11 個檔案從 `src/service/` 移入 `src/modules/accessible-route/planners/`（保留 `TdxTokenManger` 等跨切面基礎設施於共用處）。
- 純搬移 + 更新 import 路徑；型別已在 `src/types/route.ts`，不會生循環。
- **風險：低（機械）但 ⚠️ 與未提交改動衝突最大 —— 先 commit/stash。**

### Slice 5 — 把領域邏輯移出 `config/` + 外部 URL 進 typed config（不變式 1、5）

- `config/a11y-scoring.ts`（735 行）→ `modules/accessible-route/scoring.ts`（或一個 scoring service）。
- `config/lib.ts` 的 transit 工具 → `transit` 模組或 `utils/transit.ts`；`lib.ts` 只留 envelope/純工具。
- ORS / MaaS / TDX token / STA / OTP fallback 的 URL → 集中進 `config`/typed env（比照 `config/transit.ts`）。
- **風險：中**。

### Slice 6 — 治理鎖定（防止再次腐化）

- 落地 `AGENTS.md`/補強 `CLAUDE.md`：六大不變式 + 強制閱讀順序 + 交付檢查表。
- 加一條自動邊界檢查（eslint `import` 規則或 import-linter）：禁止 service import controller/router/express、禁止 controller import model、禁止跨模組 controller import。
- 用「逐步縮小的 allowlist」豁免尚未遷移的檔案，每遷移一個就刪一筆。

---

## §5 建議的下一步

- **若要先止血**：做 Slice 0 + Slice 6（常數 + 治理），最低風險、立刻擋住新債。
- **若要結構收斂**：照 Slice 0 → 6 順序逐 PR 推進；**動 Slice 4/5 之前務必先處理掉目前未提交的 5 個檔案改動**。
- 本報告所有結論皆附 `file:line`，可直接作為各 PR 的 checklist。

---

## 附錄 A — 證據索引（file:line）

- 回應 envelope：`config/lib.ts:5`（`sendResponse`）
- 驗證中介層：`validate-request.middleware.ts:11,45`（寫 `req.validated`、不改 `req.body`）
- 路由掛載：`app.ts:64-69`（單一 `/api/v1`，66-67 共用 `/a11y`）
- controller→controller import：`ai/index.ts:2` ← `accessible-route.controller.ts:8`
- controller 內 LLM：`air.controller.ts:23-37`、`ai.chat.controller.ts:66,171,201`
- controller 內業務邏輯：`accessible-route.controller.ts:23-55,61-93`
- config 內領域邏輯：`config/a11y-scoring.ts:241-712`、`config/lib.ts:34-196`
- 內聯外部 URL：`ors.service.ts:11`、`tdx-routing.service.ts:43`、`TdxTokenManger.ts:11`、`air.service.ts:20`、`config/ai.ts:13`、`otp-routing.service.ts:217,292,369`
- service 叢集所有權：見 §3
