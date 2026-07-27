# 地點搜尋（Place Search）後端實作計劃

> ⚠️ **本文已被 `docs/specs/FUNCTIONAL_SPEC_PLACE_SEARCH_UNIFIED.md` 取代（2026-07-27）。**
> 本文描述的是只有 Google 的第一版；現行實作已改為 Nominatim + Google 兩路合併，
> id 加前綴、`details` 路由參數改為 `:id`、回傳欄位大幅擴充。請以新文件為準。

> 目標：讓前端搜尋框在 OSM 覆蓋不足時，能透過 Google Places 找到店家／地點。
> 本計劃的核心不是「串 Google」（adapter 已串好），而是**回傳格式統一**與**無障礙資訊如何呈現**。

---

## 0. 現況（已具備的資產）

- `src/adapters/google.adapter.ts` 已整合 Google Places v1 `searchText`。**注意 adapter 內有兩個相近但不同的函式，別搞混**：
  - `searchPlaces()`（`google.adapter.ts:164`）：多筆結果，body 只有 `textQuery / languageCode:"zh-TW" / maxResultCount / locationBias(radius **1000m=1km**)`，可依距離排序、錯誤吞掉回 `[]`。**沒有 `regionCode`、沒有快取**。← 本功能要包的就是它。
  - `getCoordinates()`（`:95`）：單筆結果，帶 `regionCode:"TW"`、`locationBias` **50km**、有 in-memory cache。目前 `accessible-route.service.ts` 用它解析起訖點座標。（勿把它的特性套到 `searchPlaces`）
- `GOOGLE_MAPS_API_KEY` 已在 `.env.example`／env 中。
- **缺口**：`searchPlaces()` 目前只被 `src/modules/ai/agent-tools.ts` 內部使用，
  **沒有對外 HTTP endpoint**，且回傳的是 Google 原生 `{latitude, longitude}`（非 GeoJSON），
  也沒有和你自己的無障礙資料對齊。
- **實作提醒**：`searchPlaces` 的 `locationBias` 只有 1km，對「搜尋整個台北」太小；包成搜尋端點時應把半徑放大（如 15–50km）或改由參數帶入。

結論：本次工作 = **把既有 adapter 包成一個對外搜尋 endpoint，並正規化成統一格式**。

---

## 1. 核心設計決策：格式統一

### 決策 1｜不要污染 `A11yFacility`，另立 `PlaceResult`

`A11yFacility`（`a11y.schema.ts` 的 discriminated union）語意是「**一項無障礙基礎設施**」——
category 只有 `elevator/ramp/toilet/parking/other`。一間星巴克、一家診所**不是設施**，
硬塞 `source:"google"` 進去會讓 category 語意崩壞。

因此新增一個**平行但格式對齊**的 `PlaceResult`：沿用同一套 GeoJSON `GeoPoint`、同一套 envelope、
同一套 `source` 判別欄位，但語意是「**使用者可能想前往的目的地**」。

> 原則：**幾何與外框統一，語意分層。** 前端渲染搜尋卡片時只認 `PlaceResult` 一種形狀，
> 不需要為「Google 來的」和「OSM 來的」寫兩套。

### 決策 2｜統一 Schema（`PlaceResult`）

```ts
// src/modules/place-search/place-search.schema.ts
const GeoPointSchema = z.object({          // 與 a11y.schema.ts 完全一致
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]), // [lng, lat]
}).openapi("GeoPoint");

// 無障礙狀態：這是整個 app 的核心呈現訊號
const AccessibilitySchema = z.object({
  status: z.enum(["accessible", "limited", "unknown"]),
  //   accessible = 本地 DB 有無障礙設施 / Google wheelchair=yes
  //   limited    = wheelchair=limited，或僅部分設施
  //   unknown    = 兩邊都沒資料 → 誠實顯示「尚無資料」，不可假裝無障礙
  wheelchair: z.enum(["yes", "limited", "no"]).nullable(),
  nearbyFacilityCount: z.number().int().nonnegative(), // 本地 DB 半徑 N m 內設施數
  source: z.enum(["local-db", "google", "none"]),       // 這個判斷是誰給的
}).strict().openapi("PlaceAccessibility");

export const PlaceResultSchema = z.object({
  id: z.string(),                          // 穩定 id：google place_id / "osm:<osmId>" / facility _id
  source: z.enum(["google", "osm", "metro", "campus", "bathroom", "parking", "local"]),
  name: z.string(),
  address: z.string().nullable(),
  location: GeoPointSchema,                // 一律 [lng, lat]
  category: z.string().nullable(),         // 地點類型（可選）
  distanceMeters: z.number().nullable(),   // 有帶使用者座標時才算
  rating: z.number().nullable(),           // Google 才有
  accessibility: AccessibilitySchema,
  attribution: z.string().nullable(),      // Google 授權標註（見決策 6）
}).strict().openapi("PlaceResult");
```

- 座標轉換：Google 的 `{latitude, longitude}` → `coordinates: [longitude, latitude]`。
- envelope 沿用 `sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data)`；
  用既有 `ApiResponseSchema()` helper 包成 `PlaceSearchResponseSchema`。
- 全 schema `.strict()` + `.openapi()`，與現有模組一致。

### 決策 3｜無障礙狀態怎麼算（資訊呈現的重點）

搜尋結果卡片最重要的一格就是「這裡無障礙嗎？」。定義三態，**寧可誠實顯示 unknown，也不要誤導**：

| status | 判斷來源 | 前端呈現建議 |
|---|---|---|
| `accessible` | 本地 DB 半徑 N m 內有設施，或 Google `wheelchair=yes` | 綠色 ✓ 無障礙 |
| `limited` | `wheelchair=limited` / 僅部分設施 | 琥珀色 △ 部分無障礙 |
| `unknown` | 兩邊皆無資料 | 灰色「尚無資料」+ 鼓勵回報 |

> 這一格同時是你的產品飛輪：`unknown` 卡片可導向「回報無障礙資訊」，把 Google 補來的地點反哺進你自己的 DB。

---

## 2. API 設計（已定案：兩段式 search-as-you-type）

採 Google Places **Autocomplete + Session Token** 兩段式設計，把「逐字輸入 → 選定」綁成一次計費。
分工原則：**逐字階段最輕（不解析座標、不查無障礙）；選定階段才做重活（座標 + 無障礙 join）**。

> Session Token 由前端產生一個 UUID，逐字期間每次 autocomplete 都帶同一個 token，
> 選定後呼叫 details 帶同一 token，Google 才會把整段視為一次 session 計費。details 回來後該 token 作廢，下次搜尋換新的。

### 端點 A｜Autocomplete（每次按鍵都打，要最便宜）

```
GET /api/v1/a11y/search/autocomplete?q=<text>&sessiontoken=<uuid>&lat=<num>&lng=<num>
```
- 呼叫 Places **Autocomplete**（`places.googleapis.com/v1/places:autocomplete`），非 `searchText`。
- 帶 `sessionToken`、`languageCode:"zh-TW"`、`regionCode:"TW"`、`locationBias`（依 lat/lng，半徑放大到 15–50km）。
- **不解析座標、不查無障礙、不落地。** 只回預測清單：

```ts
// AutocompleteItem（輕量）
{ placeId: string; primaryText: string; secondaryText: string | null }  // secondaryText 通常是地址/行政區
```
- 回傳 `AutocompleteItem[]`，envelope 照舊。前端渲染成純文字下拉清單（**此階段不顯示無障礙徽章**——連座標都還沒有）。

### 端點 B｜Details（使用者點選某筆後才呼叫）

```
GET /api/v1/a11y/search/details/:placeId?sessiontoken=<uuid>&lat=<num>&lng=<num>
```
- 呼叫 Places **Place Details**（`places/{placeId}`）取座標 + 欄位（FieldMask 只取需要的：`id,displayName,formattedAddress,location,rating`）。
- 座標轉 GeoJSON `[lng,lat]`；有帶 lat/lng 就用 `utils/geo.ts` 算 `distanceMeters`。
- **此時才做本地 DB 近鄰查詢**（`$near`，半徑 N m）→ 算出 `accessibility`（三態 + `nearbyFacilityCount`）。
- 回傳單一 `PlaceResult`（含徽章所需的 `accessibility`）。前端此時才畫無障礙徽章、落地圖標。

### 共通事項
- 400 由 `validateRequest` 中介層處理；Google 失敗時 adapter 已吞錯回空 → 端點優雅降級（回空清單／404）。
- 前端只認 `AutocompleteItem`（清單）與 `PlaceResult`（詳細）兩種形狀。

> 備援選項（非本次範圍）：若某情境只需「打完按 Enter 一次拿多筆結果」，可另加單一 `GET /a11y/search`
> 直接複用 `searchPlaces()` + 逐筆 join。但主線走上面兩段式。

---

## 3. 與本地資料的關係（去重 / 合併）

- Phase 1：**只做狀態標註**，不做完整合併——對每筆 Google 結果查半徑內設施數，設定 `accessibility`。
- Phase 2+：**近鄰 + 名稱模糊比對**若命中本地既有設施（如捷運站），改以本地較豐富的資料為主，
  Google 結果附 `matchedFacilityId`，避免同一地點出現兩張卡。

---

## 4. 非功能性：成本 / 快取 / 限流 / 授權

| 項目 | 做法 |
|---|---|
| **費用** | FieldMask 只取需要欄位（已做）；Phase 2 用 Session Token；前端 debounce 300–400ms、最少字數才觸發 |
| **快取** | Redis（`ioredis` 已有）快取 `q + 粗略座標` 短 TTL（如 60–300s）；比 adapter 現用的 in-memory Map 更適合多實例 |
| **限流** | `express-rate-limit` + `rate-limit-redis`（已有），對搜尋端點按 IP 限流，擋盜刷 |
| **授權（重要）** | Google 條款：`place_id` 可長期存，**其他欄位不可長期落地建 DB**。故 Google 為「即時查詢層」，不進 DB。回傳帶 `attribution` 供前端標註。**實作前實際核對一次當前 Places ToS**（政策常變） |
| **金鑰保護** | 一律走後端代理，前端**不得**直呼 Google（避免金鑰外洩／盜刷） |

---

## 5. 實作任務拆解（兩段式）

- [ ] `src/adapters/google.adapter.ts`：新增兩個 adapter 函式
  - [ ] `autocompletePlaces(q, {sessionToken, lat?, lng?})` → 呼叫 v1 `places:autocomplete`，回預測清單
  - [ ] `getPlaceDetails(placeId, {sessionToken})` → 呼叫 v1 `places/{placeId}`，FieldMask 取 id/displayName/formattedAddress/location/rating
  - （既有 `searchPlaces`/`getCoordinates` 不動）
- [ ] `src/modules/place-search/place-search.schema.ts`：`GeoPointSchema`、`AccessibilitySchema`、`AutocompleteItemSchema`、`PlaceResultSchema`、兩支端點的 query/params schema（`.strict()`）+ `registry.registerPath`
- [ ] `src/modules/place-search/place-search.service.ts`：
  - [ ] `autocomplete()`：轉成 `AutocompleteItem[]`（不查座標/無障礙）
  - [ ] `details()`：`googleToPlaceResult()`（`{latitude,longitude}` → GeoJSON `[lng,lat]`）+ `computeAccessibility(location)`（本地 DB `$near` → 三態 + count，複用 `utils/geo.ts`）
- [ ] `src/modules/place-search/place-search.controller.ts`：兩個 handler，`sendResponse` 包裝
- [ ] `src/modules/place-search/place-search.router.ts` + `index.ts`：`createPlaceSearchRouter()`（兩條路由）
- [ ] `src/app.ts`：掛載於 `/api/v1/a11y`
- [ ] Session Token：確認 Google v1 autocomplete/details 帶 token 的欄位名與計費綁定方式
- [ ] 快取／限流：Redis 快取 autocomplete（`q+粗座標` 短 TTL）；`express-rate-limit` 對兩端點按 IP 限流
- [ ] 測試：`place-search.*.test.ts`（vitest + supertest），含 Google 回空的降級案例
- [ ] `npm run lint:arch` 通過；OpenAPI 文件更新
- [ ] 前端型別鏡像：`AutocompleteItem` + `PlaceResult` 同步到前端 `src/types/`（與 route.ts 同慣例，檔頭註明 aligned with backend）

---

## 6. 已定案 / 待決定

已定案（2026-07-22）：
- ✅ 兩段式 Autocomplete + Session Token（search-as-you-type）。
- ✅ 無障礙徽章在**選定後**（details 端點）才算，autocomplete 階段不算。
- ✅ 另立 `PlaceResult`，不污染 `A11yFacility`。

待決小參數（不擋開發）：
- **`accessibility.status` 的近鄰半徑 N**：暫定 30–50m，依實際設施密度微調。
- **成本敏感度**：若為低預算，前端 debounce 拉大（300–400ms）＋最少字數才觸發 autocomplete。

---

## 7. 實作結果（2026-07-22 已完成）

模組 `src/modules/place-search/`（schema / service / controller / middleware / router / index）+
`google.adapter.ts` 新增 `autocompletePlaces` / `getPlaceDetails`（既有函式未動）+ `app.ts` 掛載。
`npm run build`（lint:arch + tsc）綠、`npm test` 744 綠（新增 20）。跨模型審核採納 4/5（可空 location→404、
Redis JSON try/catch、限流器分別前綴、lat/lng 有值才轉數字）；駁回 1（token 不進快取鍵——會摧毀跨使用者共用、
且不影響計費，計費只綁真正打到 Google 的呼叫）。

實作參數：近鄰半徑 `N=50m`；autocomplete 快取 TTL 120s（key=`ps:ac:<q>:<粗座標>`，不含 token）；
限流 autocomplete 120/min、details 60/min（per IP）；details **不快取**（Google ToS）。

### 前端契約（供前端 repo 鏡像，後端不改前端）

兩個端點都在 `/api/v1/a11y` 下，回傳既有 envelope `{ ok, status, code, message, data }`。

**`GET /a11y/search/autocomplete?q=&sessiontoken=&lat=&lng=`** → `data: AutocompleteItem[]`
```ts
interface AutocompleteItem { placeId: string; primaryText: string; secondaryText: string | null }
```
- `q` 必填（≥1 字）；`sessiontoken` 前端產生 UUID，逐字期間共用同一個；`lat`/`lng` 可選（偏好用）。
- 此階段**不含座標與無障礙**；渲染純文字下拉清單即可。Google 失敗時 `data: []`（仍 200）。

**`GET /a11y/search/details/:placeId?sessiontoken=&lat=&lng=`** → `data: PlaceResult`
```ts
interface PlaceResult {
  id: string;
  source: "google" | "osm" | "metro" | "campus" | "bathroom" | "parking" | "local";
  name: string;
  address: string | null;
  location: { type: "Point"; coordinates: [number, number] };   // [lng, lat]
  category: string | null;
  distanceMeters: number | null;                                 // 有帶 lat/lng 才算
  rating: number | null;
  accessibility: {
    status: "accessible" | "limited" | "unknown";
    wheelchair: "yes" | "limited" | "no" | null;
    nearbyFacilityCount: number;
    source: "local-db" | "google" | "none";
  };
  attribution: string | null;                                    // "Powered by Google"
}
```
- 選定某筆後帶**同一個** `sessiontoken` 呼叫；回來後該 token 作廢，下次搜尋換新的。
- 查無地點或無座標 → **404**（envelope `ok:false`）。
- 徽章渲染建議見 §決策3：`unknown` 顯示「尚無資料」並可導向回報。
