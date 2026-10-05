# 實作計畫：walk `leg.steps` 統一為「純機器欄位」（前端全 i18n）

## 0. 使用者決策（已拍板，不得再議）

- `leg.steps` **不得再有任何文案欄位**。文案一律由前端用 enum 做 i18n。
- 三個步行引擎（OTP、CSR＝`pedestrian-a11y`、Valhalla 步行備援）給出的 step
  **key 集合與值域必須完全一致**，不准有兩個版本。
- 前端破壞性變更可接受，不需相容層。

## 1. 背景事實（已查證，不要重新推測）

- 使用者畫面上的 `CONTINUE 文心南七路 · 260 m` 不是 OTP 英文，是前端讀
  `step.instruction` 失敗後自己 fallback 印 `${relativeDirection} ${streetName}`。
  `formatWalkStepInstruction()`（`src/utils/transit-text.ts:245-303`）的 `switch` 有中文
  `default`，英文 token 不可能進到文案欄位。
- 等距重複列（260×5、290×5）來自 `splitLongWalkSteps()`
  （`src/utils/nav-instructions-engine.ts:206-275`）：第一段保留 `instruction`，
  後續合成 chunk 刻意剝掉 `instruction`。
- 現存分歧：`instruction`（OTP/Valhalla 有、CSR 無）、`maneuver`（只有 Valhalla）、
  `absoluteDirection`（OTP 英文 enum、CSR 走 `degToCompassWord` 是**中文字**、Valhalla 恆 null）、
  `steepSlope`（只有 CSR）。
- `WalkStep.instruction` 在非測試碼的唯一消費點是
  `nav-instructions-engine.ts:333-341` 的 facility 分支（`upstreamText`）。
- 語音 `navigation-session.ts` 用的是自己的內部 step 型別，`instruction` 來自
  `generateNavInstructions()` 的 `instruction.text`（第 559 行），**與 `WalkStep` 無關**。

## 2. 範圍

### 2.1 `WalkStep` 對外契約（統一後，恆定 9 欄，每欄都必填）

| 欄位 | 型別 | 備註 |
| --- | --- | --- |
| `relativeDirection` | `string`（封閉集合，見 §2.2） | 未知值正規化為 `CONTINUE` |
| `absoluteDirection` | 英文八方位 enum 或 `null` | **統一英文** |
| `streetName` | `string` | 可為 `""` |
| `bogusName` | `boolean` | |
| `area` | `boolean` | |
| `stairs` | `boolean` | |
| `steepSlope` | `boolean` | **三引擎皆必填**；`false` = 未觀測 |
| `distanceM` | `number` | |
| `location` | `[number, number]` | |

移除欄位：`instruction`、`maneuver`、`text`、`type`（僅限 `WalkStep`）。

### 2.2 `relativeDirection` 封閉集合

`DEPART` `CONTINUE` `STRAIGHT` `LEFT` `RIGHT` `SLIGHTLY_LEFT` `SLIGHTLY_RIGHT`
`HARD_LEFT` `HARD_RIGHT` `UTURN_LEFT` `UTURN_RIGHT` `CIRCLE_CLOCKWISE`
`CIRCLE_COUNTERCLOCKWISE` `ELEVATOR` `ESCALATOR` `MOVING_WALKWAY` `FARE_GATE`
`ENTER_STATION` `EXIT_STATION`

（`formatWalkStepInstruction` 的 `switch` case 全集；OTP 可能回集合外的值如
`FOLLOW_SIGNS`，一律映射為 `CONTINUE`。）

### 2.3 `absoluteDirection` 值域

`NORTH` `NORTHEAST` `EAST` `SOUTHEAST` `SOUTH` `SOUTHWEST` `WEST` `NORTHWEST` | `null`

### 2.4 保留：合併／切段仍在後端做

`leg.steps` 仍要經過 `mergeWalkSteps` + `splitLongWalkSteps`（否則 CSR 與 OTP 的
step 粒度天差地遠，等於另一種「兩個版本」）。**只拿掉文案，不拿掉粒度正規化。**

## 3. 檔案清單與具體動作

1. `src/types/route.ts`
   - `WalkStep`：刪 `instruction?`、`maneuver?`、`text?`、`type?`；`steepSlope` 由
     `steepSlope?: boolean` 改為必填 `steepSlope: boolean`。
   - `DriveStep`（第 322 行的 `instruction: string`）**不動**。
2. `src/utils/nav-instructions-engine.ts`
   - 新增（或移入）純函式：`normalizeRelativeDirection(raw: string): string`（§2.2 白名單，
     未命中回 `CONTINUE`）。
   - `localizeWalkLegSteps` → 改名 `normalizeWalkLegSteps(leg, isFirstLeg): WalkStep[]`，
     回傳 merge/split 後的純機器 step（不含 `text`/`type`）。
   - 刪 `isLocalizedWalkStep` 與 `prepareWalkSteps` 內的「已本地化就放行」分支
     （文案欄位不再存在，幂等問題自然消失）。
   - `walkStepText` 的 facility 分支（`upstreamText`，第 333-341 行）改為直接用
     `NAV_MSG`；`splitLongWalkSteps`／`prepareWalkSteps` 中對 `instruction`/`maneuver`
     的 destructure 剝除改為不需要。
   - `roadLegToInstructions` 讀 `step.instruction` 的部分**不動**（那是 `DriveStep`）。
   - 內部 `prepareWalkSteps` 的產出要保證每個 step 的 `steepSlope` 為布林、
     `relativeDirection` 已正規化、`absoluteDirection` 在 §2.3 值域內。
3. `src/modules/accessible-route/accessible-route.service.ts`
   - `localizeWalkSteps()` → 改名 `normalizeWalkSteps()`，呼叫 `normalizeWalkLegSteps`；
     語意仍是 best-effort per leg（空陣列→保留原 steps；throw→整條路線原樣回傳，
     保留現有 `console.error`）。
   - 呼叫點依 §5.2 上移到 `planAccessibleRouteFromRequest` 的成功回傳前，
     `planAccessibleRouteForHttp` 不再自己做（只附加 routeToken）。
4. `src/modules/accessible-route/planners/otp-routing.ts`（`walkLegFrom`，約 780-810 行）
   - 不再產生 `instruction`（連 `，此路段含樓梯` 串接一併移除）。
   - `relativeDirection` 過 `normalizeRelativeDirection`。
   - 補 `steepSlope: false`。
   - `absoluteDirection`：OTP 原生已是英文 enum，僅需白名單過濾，非法值→`null`。
5. `src/modules/accessible-route/planners/valhalla-routing.ts`（`walkSteps`，約 246-269 行）
   - 刪 `instruction`、`maneuver` 兩欄；`localizedInstruction()` 若因此只剩道路 leg 使用
     則保留，若完全無用則刪（不得留死碼）。
   - 補 `steepSlope: false`；`relativeDirection` 過正規化。
6. `src/modules/accessible-route/planners/pedestrian-a11y/csr-steps.ts`
   - `absoluteDirection` 改用**英文**八方位（新增 `degToCompassToken()` 於
     `src/utils/geo.ts`，回 §2.3 token；`degToCompassWord()` 中文版保留給文案層用）。
   - `relativeDirection` 過正規化（現有 token 已在集合內，作為防護）。
7. `src/modules/accessible-route/accessible-route.schema.ts`（`WalkStep` 區塊，約 308-345 行）
   - 刪 `instruction`、`maneuver`、`text`、`type` 四欄；`steepSlope` 改必填並更新 description
     （`false` = 未觀測）；`relativeDirection` 改 `z.enum([...§2.2])`；
     `absoluteDirection` 改 `z.enum([...§2.3]).nullable()`。
   - 第 641 行道路 leg 的 `instruction`**不動**。
   - ✅ 已查證：`/route/instructions` 的 echo 驗證走自己的
     `NavWalkStepSchema`（`nav-instructions.schema.ts:10-21`，`looseObject` + 全 optional），
     **不吃 `AccessibleRouteSchema`**，所以收緊成 `z.enum` 不會讓導航端點 400。
     `NavWalkStepSchema` 本身**不要動**（它刻意寬鬆，`instruction` 為 optional，
     少了該欄仍能匹配 union 的 walk 分支）。
8. `src/openapi/document.ts`：若有 `WalkStep`/`NavInstructionsData` 相關敘述隨之調整。
9. 文件：更新 `docs/specs/WALK_STEPS_I18N_VOCABULARY.md` §3（契約表移除 `text`/`type`、
   改註明文案由前端組）、§5 驗收條列同步。刪除已被推翻的
   `docs/specs/IMPL_INLINE_NAV_INSTRUCTIONS.md`、`docs/specs/IMPL_STEPS_ARE_THE_INSTRUCTIONS.md`
   （兩份都是本次被反轉的方案），或在檔頭標註「已被本計畫取代」。

## 4. 禁改範圍

- `POST /a11y/route/instructions` 的回應形狀與文案（`instructions[].text` 仍是中文，那是該端點的
  存在意義）——除了 facility 文案來源改為 `NAV_MSG` 之外，文案**逐字不得改動**。
- 語音模組（`src/modules/voice/**`）的行為與文案。
- 道路 leg（`DriveLeg`/`DriveStep`）的 `instruction`、`maneuver`。
- 交通 leg（BUS/METRO/THSR/TRA）全部欄位。
- 不新增任何平行欄位（不得為了「保險」留 `textLegacy` 之類）。

## 5. 失敗行為與邊界

1. `normalizeWalkLegSteps` 回空陣列 → 該 leg 保留原 `steps`（現行語意，不改）。
2. **粒度統一（已定案）**：在 `planAccessibleRouteFromRequest` 成功回傳前正規化一次
   （merge/split + 欄位統一），HTTP wrapper `planAccessibleRouteForHttp` 只再附加
   routeToken，**不得二次 merge/split**。因此 AI agent 路徑與 HTTP 路徑拿到同一份 steps，
   徹底消除「兩個版本」。原本「agent 路徑不本地化以省成本」的設計隨文案欄位一併作廢。
   測試要鎖住：agent 路徑取得的 steps 與 HTTP 路徑逐字相同。
3. OTP 回 `relativeDirection` 為 null/未知 → `CONTINUE`。
4. CSR 無法算出 bearing → `absoluteDirection: null`（不得填字串 `"UNKNOWN"`）。

## 6. 測試

- 修：所有斷言 `text`/`type`/`instruction` 出現在 `leg.steps` 上的測試
  （`accessible-route.service.test.ts`、`accessible-route.routes.test.ts`、
  `accessible-route.schema.test.ts`、`nav-instructions.service.test.ts` 等）。
- 新增守門測試：
  1. **key 集合一致**：以 OTP fixture 與 CSR fixture 各產一條 walk leg，斷言
     `Object.keys(steps[0]).sort()` 兩邊逐字相同，且等於 §2.1 的 9 欄。
  2. `JSON.stringify(route)` 的 walk leg 內不得出現 `"instruction"`、`"maneuver"`、
     `"text"`、`"type"`（walk step 層）。
  3. `absoluteDirection` 只出現 §2.3 token 或 `null`（含一條 CSR 案例，明確斷言
     **不是中文字**）。
  4. `relativeDirection` 給 `FOLLOW_SIGNS` 這類集合外輸入 → 輸出 `CONTINUE`。
  5. `/route/instructions` 吃「新的無文案 steps」仍產出與現行逐字相同的中文
     `instructions[].text`（facility 文案除外，若有差異需在報告中列出前後對照）。
- 保留現有 `/route/instructions`、語音的所有測試不得放寬。

## 7. 驗證指令（三道都要跑，缺一不可）

```bash
pnpm build          # 含 lint:arch，模組循環只有這道抓得到
npx tsc --noEmit
pnpm test
```

另需產出 OpenAPI 前後深比對（`/api/v1/openapi.json` 的 `WalkStep` component），
列出增／減／變更三類數字。

## 8. 假設

- 前端會改讀 enum 自行組文案，後端不提供任何過渡欄位（使用者已確認）。
- `NAV_MSG` 現有設施文案足以取代 OTP 上游 facility 文案。

## 9. 回滾

單一 commit，`git revert` 即可。目前工作區尚有上一輪未 commit 的內聯文案改動，
本計畫即是在其上反轉；實作前先確認 `git status` 與 §3 檔案清單一致。
