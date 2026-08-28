# IMPL：步行指引本地化收斂為單一來源

狀態：待實作。使用者回報前端顯示英文 enum 而發現。**範圍極小。**

## 1. 問題

前端直接渲染 `leg.steps[].relativeDirection`（`DEPART` / `CONTINUE` / `RIGHT`…），只有 1 步顯示中文。
根因是 `csr-steps.ts` 只為設施步填了中文 `instruction`，其他 43 步留空 ——
一個半中半英的欄位讓 `leg.steps` 看起來像可直接顯示，誘導了誤用。

分層本身是對的：`/accessible-route` 一次回最多 3 條路線，逐步指引只在使用者選定路線後才需要，
且 `/route/instructions` 另有合併碎片、切長段、`initialBearing` 等語音導向處理
（實測同一路線 44 步 → 29 條指令，原始 steps 有 14 步 ≤10 公尺）。

真正要修的是：**本地化目前散在三處**

1. `src/utils/transit-text.ts` 的 `formatWalkStepInstruction`：已有 `ELEVATOR` / `ENTER_STATION` /
   `EXIT_STATION` 三個 case，**寫死中文字面值**
2. `src/constants/messages.ts` 的 `NAV_MSG`：同樣三句 + `ESCALATOR` / `MOVING_WALKWAY` / `FARE_GATE`
3. `csr-steps.ts`：把 `NAV_MSG` 的字串填進 `WalkStep.instruction`

## 2. 變更

### 2.1 `formatWalkStepInstruction`（`src/utils/transit-text.ts`）

- 現有三個 facility case 的寫死字面值改為引用 `NAV_MSG.ELEVATOR` / `NAV_MSG.ENTER_STATION` /
  `NAV_MSG.EXIT_STATION`（消除重複，避免日後兩處漂移）
- 補上缺少的三個 case：`ESCALATOR` → `NAV_MSG.ESCALATOR`、
  `MOVING_WALKWAY` → `NAV_MSG.MOVING_WALKWAY`、`FARE_GATE` → `NAV_MSG.FARE_GATE`

### 2.2 `csr-steps.ts`

**不再填 `instruction`**（移除該欄位的設定與相關 import）。CSR 產生的 `WalkStep` 從此完全是機器資料：
`relativeDirection` 為 enum、`streetName` 為原始路名、無任何顯示文字。

### 2.3 `walkStepText`（`nav-instructions.service.ts`）

現行邏輯 `isFacilityDirection(dir) && upstreamText ? upstreamText : formatWalkStepInstruction(...)`
在 `instruction` 消失後會自然落到 `formatWalkStepInstruction`，而 2.1 已讓它能處理全部六種 facility token。
**輸出必須與現況逐字相同** —— 這是本案的驗收核心，不是重寫文案。

若 OTP 的 leg 仍會帶 `instruction`（上游自帶文字），該分支需保留給 OTP 使用，不得刪除。

## 3. 對外契約文件

`accessible-route.schema.ts` 的 `WalkStep` description 必須寫明：

- `relativeDirection` 是**機器可讀 enum**，不是顯示文字
- `instruction` 只在上游規劃器自帶逐字文案時出現；**CSR 選出的路線不會有此欄位**
- 可朗讀的中文逐步指引請呼叫 `POST /api/v1/a11y/route/instructions`（帶 `routeToken` 或完整 route echo），
  該端點另會合併過短步驟（實測 44 步 → 29 條）

## 4. 測試

1. `nav-instructions.service.test.ts`：六種 facility token 在**沒有** `instruction` 的情況下，
   `text` 仍分別產出對應中文（**這是守門測試**，證明移除 `instruction` 未造成文案退化）
2. OTP 形狀的 step（帶 `instruction`）仍優先採用上游原文
3. `csr-steps.test.ts`：斷言產出的 step **不含** `instruction` 鍵
4. `transit-text` 既有測試若斷言寫死字面值，改為斷言 `NAV_MSG` 常數

## 5. 驗收

```bash
npx tsc --noEmit   # 必須 0
pnpm test          # 基線 149 files / 1752 passed / 16 skipped，須淨增且零回歸
```

不要起服務、不要 commit。

## 6. 明確不做

- 不改 `/accessible-route` 的回應結構（**不**把 instructions 內嵌進去）
- 不改 `mergeWalkSteps` / `splitLongWalkSteps` / `stepType` 行為
- 不改任何中文文案的用字（只改它從哪裡取得）
- 不動坡道／坡度／路名／fallback 邏輯
