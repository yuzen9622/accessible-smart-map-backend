# IMPL：CSR 付費區／無障礙阻擋改為 OTP2 fallback（原為終局 422）

狀態：待實作。使用者本輪明確要求改為 fallback。**範圍極小，不得擴大。**

## 1. 現況與為何要改

`accessible-route.service.ts:1633-1640` 目前把兩個 CSR 狀態當成終局失敗：

```ts
if (csrWalk.status === "fare_policy_blocked")   return routeFailure(ROUTE_REASON.NO_ROUTE);
if (csrWalk.status === "accessibility_blocked") return routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE);
```

問題：`accessibility_blocked` 的真實語意是「**CSR 在它自己的圖上**找不到符合條件的路徑」，
而 CSR 圖有已知覆蓋缺口（坡道點位約 35% 無法吸附、footway 標註稀疏、部分區域無人行道線）。
把引擎的資料缺口當成「現場沒有無障礙路線」而完全不詢問 OTP2，是替使用者下了不該下的結論。

另一個證據：`CSR_WALK_FALLBACK_WARNING`（`:2177`）本來就為這兩個狀態備好了警告字串
（`CSR_WALK_FALLBACK_FARE_POLICY_BLOCKED`、`CSR_WALK_FALLBACK_ACCESSIBILITY_BLOCKED`），
但因為終局 422 而成為**不可達的死碼**。本案讓它們可達。

已知風險（使用者已被告知並接受）：`fare_policy_blocked` 原本用於阻止路線穿越車站付費區，
改為 fallback 後回傳的 OTP2 路線是 CSR 閘門政策會拒絕的那條。緩解為 OTP2 純步行走街道網、
不走站內通道，且 `degraded` 與警告明示閘門保護未套用。

## 2. 變更

移除 `:1633-1640` 的兩個提早 `return`，讓兩個狀態自然流入既有 fallback 路徑。
**不需新增其他邏輯** —— 該路徑已會：

1. 取 `CSR_WALK_FALLBACK_WARNING[csrWalk.status]` 附上對應警告
2. 呼叫 `planOtpWalkSegments`
3. 設 `degraded: true`、`engine: "otp-fallback"`
4. OTP2 也無路線時才回 422（含既有 avoidStairs 放寬重試）

`csr-walk-planner.ts` 的判定邏輯、`CsrWalkFailureReason` 型別、fare-access 政策**一律不動** ——
本案只改「阻擋後怎麼處理」，不改「如何判定阻擋」。

## 3. 測試

`accessible-route.service.test.ts:723-724` 現有參數化測試斷言這兩個狀態回 422，**必須反轉**：

- 兩個狀態都應回 **200**、`engine: "otp-fallback"`、`degraded: true`
- 警告需分別為 `ROUTE_WARNING.CSR_WALK_FALLBACK_FARE_POLICY_BLOCKED` 與
  `CSR_WALK_FALLBACK_ACCESSIBILITY_BLOCKED`（此前無任何測試覆蓋這兩個字串，本案補上）
- `planOtpWalkDetailed` **應**被呼叫（原測試斷言 `not.toHaveBeenCalled`）
- 新增：OTP2 也無路線時仍回 422，`reason` 維持 `NO_ROUTE` / `NO_ACCESSIBLE_ROUTE` 的既有語意

## 4. 文件同步（必做，否則文件與行為不一致）

- `docs/reports/PED_ROUTER_PURE_WALK_CSR.md`：§2 表格中 `fare_policy_blocked` /
  `accessibility_blocked` 兩列改為「OTP2 first、`otp-fallback`、`degraded: true` 加原因警告」；
  §3 段落刪除「terminal before either fallback planner runs」的敘述
- `accessible-route.schema.ts` 端點 description 若提及這兩種終局 422，一併更正
- `docs/specs/FUNCTIONAL_SPEC_PEDESTRIAN_A11Y_ROUTER.md` 與
  `IMPL_PEDESTRIAN_A11Y_ROUTER_PHASE0.md` 若有對應敘述，同步更正

## 5. 驗收

```bash
npx tsc --noEmit   # 必須 0
pnpm test          # 基線 149 files / 1750 passed / 16 skipped，須淨增且零回歸
```

不要起服務、不要 commit。

## 6. 明確不做

- 不動 CSR 阻擋的判定邏輯（`fare-access.ts`、`csr-walk-planner.ts`）
- 不動其他三個 fallback 狀態的既有行為
- 不動 `a11ySegments` / `a11yPoints` / 坡道 / 坡度 / 路名任何邏輯
