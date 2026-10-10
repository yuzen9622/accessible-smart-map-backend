# 規劃班次的逐站即時到站資訊

## 行為與分工

規劃 10:00 搭車、09:00 查看時，各站顯示該次規劃的時刻；不以當下路線的下一班覆蓋。
接近上車時間，只有後端能確定為規劃班次的即時資料才回傳分鐘數。各站獨立判斷：上車站 8 分鐘、某中途站缺資料、下車站 25 分鐘時，中途站仍保留原定時刻。

- 後端保存 OTP 原定班次及各站 epoch milliseconds，負責班次、車牌、支線、方向、StopUID、資料新鮮度與步行可達時間的判定。
- Web / App 傳送 `routeToken` 與完整 `route.legs` 中的 `legIndex`（包含步行路段），以同一識別隔離快取及輪詢。沿用既有分鐘數／時刻文字；車輛定位只追後端匹配的車牌。
- 一般公車搜尋／路線詳情繼續使用既有通用 endpoint；規劃路段不再退回「下一班」查詢。

## API

新增 `GET /api/v1/a11y/accessible-route/bus-arrivals?routeToken=...&legIndex=...`。

由 `createAccessibleRouteRouter()` 註冊、`src/app.ts` 的 `/api/v1/a11y` 掛載；schema 同步產生 OpenAPI。回應沿用 `BusRouteDetailResponse` 與全站 envelope，停站列額外提供已匹配車牌 `plateNumb`。

- `estimateMinutes` 為數值：後端已匹配該班次及該站即時 ETA。
- `estimateMinutes: null`：`statusLabel` 為原定 `HH:mm`；原資料沒有時刻則保持缺值，不推算不存在的班表。
- 缺少或無效參數／非公車 leg 為 400；快照不存在或過期為 404；不改查下一班。
- 成功／服務失敗回應皆 `Cache-Control: private, no-store`。應用程式 access logger 使用 route template，不記錄 query token。

## 保存與失效

`routeToken` 原有導航／重新規劃效期仍為 30 分鐘。另以 `bus-plan:<token>` 保存唯讀公車資料至最後公車預定抵達後 30 分鐘，最長 48 小時，讀取不續期。初次規劃與重新規劃成功時均保存；只含公車識別、站序時刻及公車線形，不複製使用者偏好、完整起終點 intent、步行線形或設施文件。

因此 09:00 規劃、09:55 更新 10:00 班次可繼續使用公車查詢，即使原導航 token 已不能重新規劃。Redis 不可用、查詢失敗、資料不足或快照最終過期時，前端保留規劃回應內的時刻快照。

## 配對保守條件與實測界線

- 沿用已修正的 matcher：同日、預定上車時間已進入 15 分鐘範圍，具有排程 trip ID、支線／站牌 ID、與預定上車時刻相符的 `ScheduledTime`、有效車牌與新鮮 ETA；多個候選不任選。
- TDX 方向與規劃方向不同時，另要求同車下游站序證據。各站僅採同方向、同支線、同車牌的唯一有效列；重複站牌無法確定則保留時刻。
- TDX 沒提供足以識別班次的欄位時，會較常顯示時刻表，不能宣稱每條路線都能顯示即時資訊。
- 目前配對以規劃的上車站為依據。車已通過該站而上游不再提供該筆資料時，逐站列表退回原定時刻；App 已上車流程仍依已鎖定車牌查下車站。
- 尚未部署，也尚未以真實 TDX 班次、瀏覽器互動或手機裝置做端到端驗收。自動測試包含 HTTP router/controller/envelope、Redis JSON 邊界與 mock provider，以及前端 API／快取／追蹤／顯示。

## 驗證

- Backend `pnpm build`：通過（含 `lint:arch` 與 TypeScript）。
- Backend 最新全套：3,510 通過、17 跳過、1 失敗；失敗為未改動的 `hazard-report.http.integration.test.ts` 中 publicReport 回 404 而預期 200。該檔獨立重跑 6/6 通過；不能將全套這輪記為全綠。
- Backend 本次相關 12 檔：209/209 通過，涵蓋 HTTP 輸入／回應、OTP 時刻、JSON 快照、跨 30 分鐘效期、逐站配對、重新規劃與既有 matcher。
- Web `pnpm build`／`tsc --noEmit` 通過；全套 76 檔、915/915 通過；變更檔 Biome 檢查通過。
- App `pnpm lint`／`pnpm typecheck` 通過；全套 130 檔、1,347/1,347 通過。最後型別標註調整後，追蹤測試 19/19 再驗通過。
- Backend 變更檔 ESLint 無 errors，既有 `any` warnings 留存；三個 repo 的 `git diff --check` 通過。
- 無部署、無 commit；外部 provider 使用 mock，非即時 TDX 班次或手機裝置驗收。

## 變更檔案

### Backend

| 檔案 | 用途 |
| --- | --- |
| `src/constants/messages.ts` | 新增規劃過期與無效公車路段錯誤訊息。 |
| `src/modules/accessible-route/accessible-route.controller.ts` | 註冊查詢 endpoint、驗證輸入並使用標準 envelope。 |
| `src/modules/accessible-route/accessible-route.router.ts` | 註冊查詢 endpoint、驗證輸入並使用標準 envelope。 |
| `src/modules/accessible-route/accessible-route.routes.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/modules/accessible-route/accessible-route.schema.ts` | 同步 API、規劃快照與車牌的型別／schema。 |
| `src/modules/accessible-route/bus-arrivals.service.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/modules/accessible-route/bus-arrivals.service.ts` | 從可信伺服器快照取指定 leg，交由 transit 配對。 |
| `src/modules/accessible-route/bus-plan.repository.ts` | 保存有期限的唯讀公車規劃快照。 |
| `src/modules/accessible-route/planners/bus-trip-match.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/modules/accessible-route/planners/bus-trip-match.ts` | 將既有 matcher 移至 transit，供初次規劃與後續查詢共用，避免循環相依。 |
| `src/modules/accessible-route/planners/otp-routing.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/modules/accessible-route/planners/otp-routing.ts` | 取得並保留原定班次各站時間。 |
| `src/modules/accessible-route/planners/otp-routing.types.ts` | 取得並保留原定班次各站時間。 |
| `src/modules/accessible-route/planners/realtime-transit.ts` | 改用共用班次 matcher 與型別。 |
| `src/modules/accessible-route/planners/realtime-transit.types.ts` | 同步 API、規劃快照與車牌的型別／schema。 |
| `src/modules/accessible-route/reroute.service.ts` | 規劃成功後保存公車查詢快照。 |
| `src/modules/accessible-route/route-token.service.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/modules/accessible-route/route-token.service.ts` | 規劃成功後保存公車查詢快照。 |
| `src/modules/accessible-route/stop-aliases.ts` | 同步還原時刻快照中的 TDX 站牌 ID。 |
| `src/modules/transit/bus-trip-match.ts` | 將既有 matcher 移至 transit，供初次規劃與後續查詢共用，避免循環相依。 |
| `src/modules/transit/bus.service.ts` | 匹配班次後，逐站回傳同車 ETA 或原定時刻。 |
| `src/modules/transit/transit.schema.ts` | 同步 API、規劃快照與車牌的型別／schema。 |
| `src/modules/transit/transit.types.ts` | 同步 API、規劃快照與車牌的型別／schema。 |
| `src/types/route.ts` | 同步 API、規劃快照與車牌的型別／schema。 |
| `src/types/transit.ts` | 同步 API、規劃快照與車牌的型別／schema。 |

### Web

| 檔案 | 用途 |
| --- | --- |
| `src/components/Wrapper/LiveBusWrapper.tsx` | 只追後端匹配車牌，避免獨立下一班查詢混入。 |
| `src/components/shared/RouteCard/BusLegStops.tsx` | 傳遞原規劃識別並套用逐站即時分鐘／時刻顯示。 |
| `src/components/shared/RouteCard/LegDetail.tsx` | 傳遞原規劃識別並套用逐站即時分鐘／時刻顯示。 |
| `src/components/shared/RouteCard/RouteCard.tsx` | 傳遞原規劃識別並套用逐站即時分鐘／時刻顯示。 |
| `src/components/shared/RouteCard/TransitStops.tsx` | 傳遞原規劃識別並套用逐站即時分鐘／時刻顯示。 |
| `src/components/shared/__tests__/TransitStops.test.tsx` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/hook/__tests__/useBusLegStopEtas.test.tsx` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/hook/__tests__/useLiveBusPositions.lifecycle.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/hook/__tests__/useLiveBusPositions.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/hook/useBusLegStopEtas.ts` | 以行程 token 與 leg index 隔離快取、輪詢與失敗清除。 |
| `src/hook/useLiveBusPositions.ts` | 只追後端匹配車牌，避免獨立下一班查詢混入。 |
| `src/lib/api/__tests__/transit.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/lib/api/busParsers.ts` | 傳送行程識別並保留後端匹配車牌。 |
| `src/lib/api/transit.ts` | 傳送行程識別並保留後端匹配車牌。 |
| `src/lib/transit/__tests__/busLegStops.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/lib/transit/__tests__/busRouteDetailCache.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/lib/transit/busLegStops.ts` | 查詢失敗時使用原規劃各站時刻。 |
| `src/lib/transit/busRouteDetailCache.ts` | 以行程 token 與 leg index 隔離快取、輪詢與失敗清除。 |
| `src/types/route.ts` | 同步 API、規劃快照與車牌的型別／schema。 |

### App

| 檔案 | 用途 |
| --- | --- |
| `src/features/bus/api/__tests__/busRouteDetailCache.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/features/bus/api/__tests__/transit.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/features/bus/api/busRouteDetailCache.ts` | 以行程 token 與 leg index 隔離快取、輪詢與失敗清除。 |
| `src/features/bus/api/transit.ts` | 傳送行程識別並保留後端匹配車牌。 |
| `src/features/bus/components/BusLegStops.tsx` | 傳遞原規劃識別並套用逐站即時分鐘／時刻顯示。 |
| `src/features/bus/controller/__tests__/busWatchers.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/features/bus/controller/__tests__/liveBusTracker.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/features/bus/controller/busWatchers.ts` | 以行程 token 與 leg index 隔離快取、輪詢與失敗清除。 |
| `src/features/bus/controller/liveBusTracker.ts` | 只追後端匹配車牌，避免獨立下一班查詢混入。 |
| `src/features/bus/domain/__tests__/busLegStops.test.ts` | 驗證班次隔離、原定時刻、查詢契約或既有相容行為。 |
| `src/features/bus/domain/busLegStops.ts` | 查詢失敗時使用原規劃各站時刻。 |
| `src/features/bus/hooks/useBusLegStopEtas.ts` | 以行程 token 與 leg index 隔離快取、輪詢與失敗清除。 |
| `src/features/bus/store/busStore.ts` | 以行程 token 與 leg index 隔離快取、輪詢與失敗清除。 |
| `src/features/bus/types/transit.ts` | 同步 API、規劃快照與車牌的型別／schema。 |
| `src/features/navigation/hooks/useNavigationEffects.ts` | 傳遞原規劃識別並套用逐站即時分鐘／時刻顯示。 |
| `src/features/route/types/route.ts` | 同步 API、規劃快照與車牌的型別／schema。 |

