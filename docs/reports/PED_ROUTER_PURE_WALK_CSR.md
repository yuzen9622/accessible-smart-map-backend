# 台北純步行 CSR production integration

**狀態：程式與測試已完成；本機 development PostGIS 已套用 lifecycle migration 並完成真實 API 驗收。尚未重建／注入新 candidate、執行 production promotion 或啟用 production traffic。**

本報告記錄 `travelMode: "walk"` 的 production assembly，不重新宣稱 Phase 0 或 OTP 對比的量測結果。production search 使用 `h≡0`（Dijkstra-equivalent），且以選定 endpoint 距離做 snap acceptance；舊 proxy-A\*／邊投影 latency 與 snap 數字不適用於此版本。既有歷史量測與限制仍見 `PED_ROUTER_PHASE0.md`、`PED_ROUTER_OTP_COMPARISON.md` 與 `PED_GRAPH_CONNECTIVITY_DIAGNOSIS.md`。

## 1. 範圍與未變更介面

- API mount 維持 `POST /api/v1/a11y/accessible-route`（外層版本前綴仍由既有 router 提供）。
- 僅純步行請求接 CSR；transit itinerary 內的 WALK leg **沒有**改用 CSR，仍由 OTP2 規劃。
- CSR production coverage 目前只限台北 bbox：`121.43,24.95,121.68,25.22`。bbox 外不代表失敗，而是 OTP2 primary。
- CSR 成功 route 與所有純步行 fallback route 都有 optional route-level `engine`：
  - `pedestrian-a11y`：CSR 選出的路線。
  - `otp-fallback`：CSR 未選出該純步行路線。若 OTP2 其後不可用而使用既有 Valhalla recovery，仍以這個 provenance 值表示「非 CSR」，並由 warning 說明 Valhalla。
- transit、drive 與 motorcycle route 可省略 `engine`，保持既有回應相容性。

## 2. CSR selection 與 tri-state fallback

CSR 只在 `PED_GRAPH_CSR_WALK_ENABLED=true` 且所有點都位於台北 bbox 時參與選路。此旗標未設定時一律為 `false`，即使 `PED_GRAPH_DATABASE_URL` 已設定，仍由 OTP2 作為 non-degraded primary。normal、elderly 與 visual_impaired 的預設組合會進 CSR 的各自 neutral profile；不會把非輪椅請求偷偷改成 wheelchair profile。

| CSR disposition                                          | Next planner                       | `engine`          | `degraded` and warning                             | Valhalla                          |
| -------------------------------------------------------- | ---------------------------------- | ----------------- | -------------------------------------------------- | --------------------------------- |
| `ok`                                                     | CSR route                          | `pedestrian-a11y` | omitted; indoor proxy warning only when applicable | not called                        |
| feature disabled（包括未設定 flag）or `outside_coverage` | OTP2 primary                       | `otp-fallback`    | omitted; no CSR failure warning                    | only if OTP2 is unavailable       |
| `unsupported_constraints`                                | OTP2 first                         | `otp-fallback`    | `true` plus unsupported-constraint warning         | existing OTP-unavailable recovery |
| `unavailable` or `topology_disconnected`                 | OTP2 first                         | `otp-fallback`    | `true` plus cause warning                          | existing OTP-unavailable recovery |
| `fare_policy_blocked`                                    | terminal `422 NO_ROUTE`            | omitted           | no fallback route                                  | not called                        |
| `accessibility_blocked`                                  | terminal `422 NO_ACCESSIBLE_ROUTE` | omitted           | no fallback route                                  | not called                        |

The second row is deliberately non-degraded: a disabled deployment（包括缺少 flag）or ground outside the Taipei graph never promised CSR protection. The fallback-eligible non-CSR results inside coverage are visible to clients as a degradation. The warnings state that CSR stair, slope, width, and fare-gate protection was not enforced by the returned OTP2 route. A CSR fare-policy or accessibility block is instead a terminal failure, so no unprotected route is returned.

The compatibility gate is also explicit. When an enabled, in-Taipei request asks for an `avoidStairs` value the selected CSR mode cannot faithfully represent (for example normal plus `avoidStairs: true`, or wheelchair plus `avoidStairs: false`), it returns `unsupported_constraints`, then uses marked OTP2 fallback. Coverage and feature checks happen first, so the same combination outside Taipei or while disabled remains ordinary OTP-primary behavior.

## 3. Fallback ordering and fare-gate safety

For fallback-eligible CSR results, the normal order is CSR → OTP2 → Valhalla only when OTP2 is unavailable. It preserves the existing OTP-first behavior.

CSR fare and accessibility blocks are terminal before either fallback planner runs: `fare_policy_blocked` returns `422 NO_ROUTE`, and `accessibility_blocked` returns `422 NO_ACCESSIBLE_ROUTE`. This prevents any unprotected engine from bypassing a binding CSR result. A returned OTP2 fallback is never presented as CSR-protected; its `engine`, `degraded`, and warning fields make the loss of protection explicit.

Fare and exit gates remain fail-closed under normal policy. Both endpoints must have the same non-blank stable parent-station ID authorized by transit context. There is no request field, public route policy, or client-accessible allow-all mode.

A planner-local diagnostic allow-all probe exists only to classify a discarded search result. It catches a malformed gate with blank or mismatched station identity as `fare_policy_blocked` rather than incorrectly labelling it `accessibility_blocked`. Promotion rejects candidates with generated pathway endpoint identity mismatch, so a production-ready promoted graph cannot activate such a gate; the diagnostic remains a defense for legacy or otherwise unverified loaded data.

## 4. Geometry and accessibility transparency

- CSR returns one WALK leg per requested adjacent point pair, in origin → waypoint(s) → destination order.
- CSR derives distance, duration, slope, crossing, curb-ramp, width, and surface observations from selected graph edges. It does **not** enforce an arbitrary request `maxSlopePercent`; CSR responses report `slopeConstraint.enforced=false` with an engine-specific note instead of reusing OTP's 8.3% claim.
- Snap acceptance is based on the chosen routable endpoint, not a nearby edge projection. Accepted straight connectors from the request point to that endpoint are included at the polyline end and counted in distance and duration; a close mid-edge projection with distant endpoints is rejected as `unavailable` so OTP2 can take over.
- Indoor proxy eligibility is provenance-based, never inferred from `geom IS NULL`: the injector's `gtfs_pathways:pathway:<pathway-id>:(forward|reverse)` and `gtfs_pathways:connector-edge:<entrance-id>:…` edges receive `EDGE_FLAG.INDOOR`. NULL, malformed, or missing geometry for one of those selected edges may use endpoint proxies and adds `CSR_WALK_APPROXIMATE_INDOOR_GEOMETRY`; a straight segment on the map is explicitly an approximation, not a claimed indoor survey. A selected outdoor edge without a valid LineString remains outdoor, returns `unavailable`, and triggers the marked OTP2 fallback.
- When an approximate selected indoor edge has no stored `length_m`, CSR derives its distance from `traversal_time_s × profile.walkSpeedMps`, matching the base cost semantics; it never derives distance from coincident station-centroid proxies. Missing, invalid, or non-positive traversal time in that case makes CSR `unavailable` rather than reporting a zero-distance route.
- The strict Zod/OpenAPI `AccessibleRoute` response publishes only `pedestrian-a11y` and `otp-fallback` for `engine`. Invalid values are rejected by the schema.

## 5. Deferred work

Transit WALK-leg replacement, station canonicalization for transit authorization, and any client-visible transit policy are explicitly deferred. This integration does not alter OTP transit planning or use CSR inside transit itineraries.

## 6. 本機 operational verification（2026-08-27）

Development PostGIS 已套用 idempotent lifecycle migration；既有 version 1 成為唯一 `ACTIVE`，且 metadata／實表皆維持 165,432 nodes、453,144 directed edges。

以 `PED_GRAPH_CSR_WALK_ENABLED=true` 對真實 API `POST /api/v1/a11y/accessible-route` 驗收；兩案皆明確傳入 `mode=wheelchair`、`avoidStairs=true`（若省略則會使用 normal profile，路徑距離可能不同）：

| 案例                 | HTTP／engine             | 結果                                                                   |
| -------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `route_2`            | `200`／`pedestrian-a11y` | 1,065 m、44 edges、fare gate 0、exit gate 0；首次 graph load 約 14.5 s |
| `indoor_route`       | `200`／`pedestrian-a11y` | 356 m、7 edges、fare gate 0、exit gate 0；cached planning 約 1 ms      |
| 故意無效 PostGIS URL | `200`／`otp-fallback`    | `degraded=true`，warning 明示 CSR 樓梯／坡度／寬度／閘門保護未套用     |

以上是本機功能證據，不代表 production latency/SLA。首次載入時間包含完整 ACTIVE graph 與 spatial index 建置；常駐程序後續重用 cache。

## 7. Remaining production operational steps

1. 在目標 production PostGIS 套用 lifecycle migration，先以 read-only query 驗證唯一 ACTIVE 與實表 counts。
2. 找回與 version 1 等價的政府人行道及 DEM 輸入後，再建立包含 explicit-foot cycleway 修正的 immutable CANDIDATE；目前不可用缺少來源資料的降級 graph 覆蓋既有 ACTIVE。
3. 對 candidate 執行 indoor injection、200 OD replay、route_2／indoor_route 與 promotion integrity checks；通過後才 promotion。
4. 在 client response path 之外做 shadow review，檢查 CSR status、fallback reason、graph version 與 OTP／Valhalla ordering。
5. 最後才設定 production `PED_GRAPH_CSR_WALK_ENABLED=true`；保留該 flag 作為立即回退 OTP-primary pure walking 的開關。

未宣稱 production availability、route-quality、adoption 或 SLA 數字。
