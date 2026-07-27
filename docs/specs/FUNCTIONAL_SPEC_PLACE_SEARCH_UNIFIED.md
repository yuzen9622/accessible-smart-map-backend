# 統一地點搜尋（Unified Place Search）實作計畫

> 前身：`docs/place-search-plan.md`（2026-07-22，只做了 Google 兩段式）。
> 本計畫承接其 §3「Phase 2+：合併／去重」，並補上當初漏掉的 **OSM 地點來源**。
> 範圍已於 2026-07-27 收斂：**只合併 Nominatim 與 Google 兩個來源**，本地 collection 不列為搜尋結果。
> 狀態：**待審核**（cross-model gate CLI 已退役 — `~/.local/bin/cross-model-review` 指向已刪除的 script，改人工審）。

---

## 0. 問題陳述

目前 `GET /api/v1/a11y/search/autocomplete` 唯一資料來源是 Google Places Autocomplete
（`place-search.service.ts:86`）。本地資料只在 `details()` 階段以 `countNearbyFacilities()`
（定義於 `place-search.service.ts:102`，唯一呼叫點在 `computeAccessibility()` 的 `:125`）
算「50m 內設施數」當徽章依據，不作為搜尋結果本身。

`PlaceResult.source` 宣告了 `"google" | "osm" | "metro" | "campus" | "bathroom" | "parking" | "local"`
（`place-search.service.ts:34`），但 service 唯一的 return 寫死 `source: "google"`（`:192`）—— 其餘 6 個值是
為 Phase 2 預留、從未產出的死分支。

同時前端 **完全沒走後端** —— 前端 repo（不在本 repo 內）的 `PlaceInput.tsx` / `usePlacePredictions.ts:24`
直接 fetch Nominatim（limit=5、debounce 500ms、countrycodes=tw）。現況是後端有一套 Google 搜尋沒人用、
前端有一套 OSM 搜尋不經後端。

> 本文出現的 `PlaceInput.tsx`、`usePlacePredictions.ts`、`PlaceContent.tsx`、`getPlaceIcon`、
> `getPlaceTypeLabel`、`PlaceReviewSection` 皆屬**前端 repo**，行號無法在本 repo 查證，
> 資訊來源為 2026-07-27 的前端現況盤點。其餘 `檔案:行號` 引用皆指本 repo。

---

## 1. 關鍵釐清：「OSM place」指的是 Nominatim


| 名稱                              | 是什麼                   | 涵蓋                                                     | 本次角色                              |
| ------------------------------- | --------------------- | ------------------------------------------------------ | --------------------------------- |
| **Nominatim**（前端現用）             | OSM 官方地理編碼服務（外部 HTTP） | 全部 POI／道路／行政區                                          | ✅ 搜尋來源之一，**本次要新增 adapter**（⚠️ 實作後修正為 Photon 負責搜尋、Nominatim 只負責 lookup，見 §12） |
| `**osm-a11y` collection**（後端現有） | 我們匯入的無障礙設施            | 只有 elevator/ramp/toilet/kerb_cut/wheelchair_accessible | ❌ 不是通用 POI，搜「台北101」恆 0 筆；維持只當徽章依據 |


---

## 2. 目標 / 非目標

**目標**

1. `autocomplete` 從單一 Google，改為 **Nominatim + Google 兩路合併去重**。
2. `details` 依 id 前綴分派：`osm:` 走 Nominatim lookup、`google:` 走 Google Details，**OSM 分支完全不打 Google、不耗 session token**。
3. 回傳欄位涵蓋前端現有全部渲染需求（§4.1 對照表），讓前端得以拔掉直連 Nominatim 的程式碼。
4. review 的 key 泛化，讓 Google 來源的地點也能掛評論（§6）。

**非目標**

- **本地 collection 不作為搜尋結果**（metro/campus/bathroom/parking/welfare/bus 全部不進清單）。
本地資料只做兩件事：`accessibility` 徽章、`nearbyFacilities` 列表。
- 不做全文檢索引擎，不動 `$text` / Atlas Search。
- 不把 Google 欄位落地進 DB（ToS 僅允許存 `place_id`）。
- 不改前端；交付契約與遷移說明，前端另案。

---

## 3. id 與 source

現況 `id` 是裸 Google place id、路由 `/search/details/:placeId`。改為兩來源都加前綴：

```
google:<placeId>
osm:<osmType>:<osmId>        // 例 osm:node:123456
```

- **OSM 用冒號不用斜線**：Nominatim 慣用 `node/123456`，但斜線會切斷 Express 的 `:id` 路徑參數。
對外 id 一律 `osm:node:123456`，需要還原成 `node/123456` 時（Nominatim lookup、review key）在 service 內轉換。
- `source` 收斂為 `"google" | "osm"`，刪掉從未使用的 5 個值。
- 路由參數改名 `:id`，schema 以 regex 驗前綴白名單，未知前綴 → 400。
- 這是**破壞性變更**（現行吃裸 id）。依專案慣例可接受，交付遷移說明。

---

## 4. API 契約

### 4.1 前端需求對照（必填欄位的出處）


| 前端使用處                                       | 前端欄位                                                           | 後端欄位                                              | 備註                                         |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| 建議清單圖示 `getPlaceIcon(class‖category, type)` | `class`/`category`, `type`                                     | `placeClass`, `placeType`                         | OSM 原值直通；Google 由 `types[]` 映射（§4.4）       |
| 建議清單主標題                                     | `name ‖ display_name`                                          | `primaryText`                                     | 一律非空                                       |
| 建議清單副標題                                     | `display_name`                                                 | `secondaryText`                                   | OSM 給 display_name；Google 預測只有短版 secondary |
| 空字串態歷史紀錄                                    | `name`, `display_name`                                         | `primaryText`, `secondaryText`                    | 前端需一併存 `id`（含前綴）才能重查                       |
| 詳情標題／副標                                     | `name`, `display_name`                                         | `name`, `fullAddress`                             |                                            |
| 詳情類型 Badge `getPlaceTypeLabel(type)`        | `type`                                                         | `placeType` + `typeLabel`                         | 後端直接給中文標籤，前端可漸進改用                          |
| 詳情 OSM 外連                                   | `osm_type`, `osm_id`                                           | `externalLinks.osm`                               | Google 來源為 `null`                          |
| 詳情地址明細                                      | `road`, `suburb‖neighbourhood`, `city‖town‖county`, `postcode` | `addressComponents.{road,district,city,postcode}` | 後端做完 fallback，前端不再 `‖`                     |
| 詳情附近無障礙（廁所／捷運各 4）                           | 另外查                                                            | `nearbyFacilities.{toilets,metro}`                | 併進 details，省一次往返                           |
| 評論區 `PlaceReviewSection`                    | `osmId`, `placeType`                                           | `reviewKey.{placeId,placeType}`                   | §6                                         |
| 規劃路線／收藏／分享                                  | 座標                                                             | `location`, `id`, `name`                          |                                            |


### 4.2 端點 A：`GET /a11y/search/autocomplete`

```
?q=<text>&sessiontoken=<uuid>&lat=<num>&lng=<num>&sources=<csv>&limit=<int>
```

```ts
type PlaceSource = "osm" | "google";

// 本文共用的兩個型別（本 repo 目前沒有同名 TS 型別，需在 place-search.types.ts 新增）：
//   GeoPoint        —— 與 a11y.schema.ts 的 GeoPoint OpenAPI schema 同形狀，
//                      TS 側現有的同義型別是 a11y.service.ts:105 的 A11yGeoPoint
type GeoPoint = { type: "Point"; coordinates: [number, number] };  // [lng, lat]
//   ReviewPlaceType —— 即 review.model.ts:3 匯出的 PlaceType（加上 "google" 之後），
//                      本文以 ReviewPlaceType 為別名稱呼，實作時直接 import PlaceType
type ReviewPlaceType = "osm" | "a11y" | "bathroom" | "welfare" | "parking" | "google";

interface AutocompleteItem {
  id: string;                      // 前綴 id（§3）
  source: PlaceSource;
  primaryText: string;
  secondaryText: string | null;
  placeClass: string | null;       // 圖示用
  placeType: string | null;        // 圖示 + 標籤用
  typeLabel: string | null;        // 中文標籤，如「捷運站」
  location: GeoPoint | null;       // OSM 有；google 恆為 null（預測階段拿不到座標）
  distanceMeters: number | null;   // location 與 lat/lng 都有時才算
}
```

- `sources` 白名單（預設 `osm,google`），可單獨關掉某一路做 A/B 或降級。
- 兩路 `Promise.allSettled`，任一路失敗只掉那一路，整體仍 200（沿用既有降級精神）。
- `location: null` 是誠實表達 Google 預測階段的限制，不是 bug；前端算距離時需容忍。
- **此階段不含 `accessibility`**（沿用原計畫決策：徽章在 details 才算）。OSM 結果雖有座標，
但為每筆預測跑一次 `$near` 會讓逐字輸入每按鍵打 5 次地理查詢，成本不划算。

### 4.3 端點 B：`GET /a11y/search/details/:id`

```ts
interface PlaceResult {
  id: string;
  source: PlaceSource;
  name: string;
  fullAddress: string | null;                // ≈ display_name / formattedAddress
  addressComponents: {
    road: string | null;
    district: string | null;                 // suburb ‖ neighbourhood
    city: string | null;                     // city ‖ town ‖ county
    postcode: string | null;
  };
  location: GeoPoint;                        // [lng, lat]
  placeClass: string | null;
  placeType: string | null;
  typeLabel: string | null;
  distanceMeters: number | null;
  rating: number | null;                     // 僅 google
  accessibility: PlaceAccessibility;         // 沿用現有三態（local-db / google / none）
  nearbyFacilities: {                        // 各取 N 筆（預設 4）
    toilets: NearbyFacilityBrief[];
    metro: NearbyFacilityBrief[];
  };
  reviewKey: { placeId: string; placeType: ReviewPlaceType };   // §6
  externalLinks: { osm: string | null; google: string | null };
  attribution: string | null;                // "Powered by Google" / "© OpenStreetMap contributors"
}

interface NearbyFacilityBrief {
  id: string; name: string; address: string | null;
  category: string; typeLabel: string; distanceMeters: number;
}
```

- Google FieldMask 需**新增 `addressComponents,types`**
（現為 `id,displayName,formattedAddress,location,rating,accessibilityOptions`，`google.adapter.ts:317`）。
- OSM 分支 `addressdetails=1` 直接拿到 `address{}`，映射到 `addressComponents`。
- 查無 / 無座標 → 404（維持現行行為）。

### 4.4 class/type 映射（圖示相容）

前端 `getPlaceIcon` 照 OSM 字彙寫成，故 **Google 結果借用 OSM 字彙**輸出，前端圖示邏輯不用改：


| Google `types[]`                                       | placeClass | placeType               |
| ------------------------------------------------------ | ---------- | ----------------------- |
| `subway_station` / `train_station` / `transit_station` | `railway`  | `station`               |
| `bus_station` / `bus_stop`                             | `highway`  | `bus_stop`              |
| `restaurant` / `cafe` / `food`                         | `amenity`  | `restaurant` / `cafe`   |
| `hospital` / `doctor` / `pharmacy`                     | `amenity`  | `hospital` / `pharmacy` |
| `school` / `university`                                | `amenity`  | `school` / `university` |
| `store` / `shopping_mall`                              | `shop`     | `mall` / `yes`          |
| 其他                                                     | `null`     | Google 原 type 字串        |


映射表放 `place-search.types.ts`；未命中就給 `null`，前端 `getPlaceIcon` 已有 fallback 圖示。
`typeLabel` 一律由後端輸出中文字串（OSM 與 Google 共用同一張對照表）。

---

## 5. 合併、排序、去重

1. 兩路並行：Nominatim `limit 5`、Google 預設 5。
2. **名稱正規化**：去空白／全形半形／大小寫／「台↔臺」互換。
3. **去重（受限，需誠實標註）**：Google 預測階段**沒有座標**，跨源只能做正規化名稱完全相同的比對。
 名稱寫法不同（「台北101」vs「台北 101 購物中心」）就會漏，會出現兩張卡。
 → 接受此限制。命中重複時**保留 OSM 那筆**（有座標、有距離、有 OSM 外連、免費）。
4. 排序：先分「名稱以 `q` 開頭」與否兩層，層內 OSM 優先（有座標可算距離）；`limit`（預設 8）截斷。
5. 對應 §10 的 R2：若實測重複卡太明顯，備案是把 Google 那路改成 `searchText`（有座標，可做距離去重），
 代價是計費從 Autocomplete 轉為 Text Search（較貴）且失去 session token 綁定。**本次不做，先觀察。**

---

## 6. review key 泛化（已決策：選項 A）

`review.model.ts` 現況鍵為 `osmId + placeType`，enum 為 `"osm" | "a11y" | "bathroom" | "welfare" | "parking"`
—— **沒有 `google`**，Google 來源的地點掛不了評論。

實查後遷移比預期單純：`review.schema.ts:13` 的 `osmId` 範例就是 `"node/123456"`，
**現存資料的 `osmId` 值本身不需要改**，只需：

- [ ] `IReview.osmId` → `placeId`（型別、schema、service filter、controller 全部改名）
- [ ] `PlaceType` enum 加 `"google"`
- [ ] 遷移腳本 `src/scripts/migrate-review-place-id.ts`：`db.reviews.updateMany({}, { $rename: { osmId: "placeId" } })`
      —— 純欄位改名，**無值轉換**，冪等（已改名的 doc `$rename` 不存在的欄位是 no-op）
- [ ] 索引：`review.model.ts` 有**兩個**含 `osmId` 的複合索引，都要 drop 後以新欄位名重建 ——
      `:46` `{ osmId, placeType, userId }`（unique）與 `:47` `{ osmId, placeType, status }`（非 unique）

`reviewKey` 的產生規則：

- `source: "osm"` → `{ placeId: "node/123456", placeType: "osm" }`（把 id 的 `osm:node:123456` 還原成斜線形式，**與既有資料相容**）
- `source: "google"` → `{ placeId: "<裸 google place id>", placeType: "google" }`

> 這保住原計畫 §決策3 的產品飛輪：Google 補來的地點也能被評論、反哺回自家 DB。

**破壞性變更**：review 三支端點的 `osmId` 參數改名 `placeId`。列入前端遷移說明。

---

## 7. 非功能性

### 7.1 Nominatim 使用政策（最大營運風險）

前端直連時流量分散在各使用者 IP；**搬到後端會集中成單一伺服器 IP**，極易觸發 OSM 封鎖。
官方 Usage Policy 硬性要求：絕對上限 **1 req/s**、必須帶可識別 `User-Agent`（含聯絡方式）、
禁止大量自動化查詢、結果需標註 `© OpenStreetMap contributors`。

緩解措施（**全部列為實作必做**）：

1. Redis 快取 `ps:osm:<q>:<粗座標>`，TTL 300s（OSM 資料變動慢，比 Google 那層 120s 長）。
2. Adapter 內建**全域 1 req/s 節流佇列** —— 限流擋的是使用者，節流保護的是我們對 OSM 的守約，兩者都要。
3. 逾時 2s 即放棄該路（`allSettled` 吞掉），不拖累整體回應。
4. `NOMINATIM_BASE_URL` 做成 env。**中期建議自架**：本專案已有 `VALHALLA_PBF_PATH`（台灣 OSM PBF），
 自架 Nominatim/Photon 可複用同一份圖資，徹底解除政策風險。列為後續案，不擋本次。

### 7.2 快取／限流／成本


| 項目              | 做法                                                                                |
| --------------- | --------------------------------------------------------------------------------- |
| autocomplete 快取 | 現有 `ps:ac:<q>:<粗座標>` 擴為 `ps:ac:<sources>:<q>:<粗座標>`，TTL 120s；token 不進 key（沿用既有決策） |
| Nominatim 快取    | `ps:osm:<q>:<粗座標>` TTL 300s；lookup `ps:osmd:<id>` TTL 600s                        |
| details 快取      | Google 分支**不快取**（ToS）；OSM 分支可快取 600s                                              |
| 限流              | 沿用 `place-search.middleware.ts` 既有兩個 limiter（120/min、60/min per IP）               |
| Google 成本       | 不變；OSM 命中越多、Google details 呼叫越少 → **成本會下降**                                       |


---

## 8. 實作任務拆解

- [ ] `src/adapters/nominatim.adapter.ts`（新）
  - [ ] `searchOsmPlaces(q, {lat?, lng?, limit})` → `/search?format=jsonv2&addressdetails=1&countrycodes=tw`
  - [ ] `lookupOsmPlace(osmType, osmId)` → `/lookup?osm_ids=<N|W|R><id>&addressdetails=1`
        —— 注意三層 id 形式要轉換：對外 `osm:node:123` ／ review key `node/123` ／ Nominatim lookup `N123`
  - [ ] 全域 1 req/s 節流、2s timeout、User-Agent、失敗回 `[]`/`null`
- [ ] `src/adapters/google.adapter.ts`：FieldMask 加 `addressComponents,types`，解析出對應欄位（既有簽章不變，只擴回傳）
- [ ] `src/modules/place-search/place-search.types.ts`（新，依 types/constants layout 慣例）：
      `PlaceSource`、`GeoPoint`、id parse/build（三層形式互轉）、class/type 與 typeLabel 映射表、名稱正規化
- [ ] `place-search.schema.ts`：`AutocompleteItemSchema` / `PlaceResultSchema` 擴欄位、`sources`/`limit` query、
      `:id` 前綴驗證、OpenAPI 重註冊
- [ ] `place-search.service.ts`
  - [ ] `autocomplete()` 改兩路合併 + 去重 + 排序（§5）
  - [ ] `resolveById()` 依前綴分派（§4.3）
  - [ ] `nearbyFacilities` 取廁所／捷運各 4 筆 —— **`a11y.service.ts` 沒有現成可直接複用的函式**：
        `findNearby`（`:395`）與 `findNearbyLimited`（`:417`）中，廁所上限是 5 不是 4，
        且「捷運」那格實際是 `A11y`(10) + `OsmA11y`(15) + campus(15) 三源合併的混合物件，不是單一分類。
        → 需在 place-search service 內新寫兩支各取 4 筆的查詢（可沿用其 `$near` 寫法與 `A11yFacility` 映射函式）
  - [ ] `reviewKey` 產生（§6）
- [ ] `place-search.controller.ts` / `place-search.router.ts`：`:placeId` → `:id`
- [ ] review module 泛化 + `src/scripts/migrate-review-place-id.ts`（§6）
- [ ] `.env.example`：`NOMINATIM_BASE_URL`、`NOMINATIM_USER_AGENT`
- [ ] `docs/place-search-plan.md` 補「已被本計畫取代」指標；本檔補實作結果章節
- [ ] 前端遷移說明（後端不改前端）

---

## 9. 測試計畫

沿用 vitest + supertest 既有 harness（`tests/helpers/test-helpers.ts`）。

**單元**

- id 前綴 parse/build 往返（含 `osm:node:123` ↔ `node/123` 轉換）、非法輸入
- 名稱正規化（台/臺、全半形、大小寫）
- 去重：同名合併且保留 OSM 那筆；異名不合併
- 排序：前綴命中優先、層內 OSM 優先、limit 截斷
- Google `types[]` → class/type 映射全分支；未命中回 null

**路由整合**（mock adapter 與 model）

- 兩路都有結果 → 合併排序正確
- Nominatim 逾時 / Google 失敗 → 各自只掉一路，仍 200
- `sources=osm` → 完全不打 Google
- `details` 各前綴分派：`osm:` / `google:` 各一案；未知前綴 → 400；查無 → 404
- `details` 的 `osm:` 分支**不呼叫** Google adapter（以 spy 斷言）
- 快取命中不重打 adapter
- review 三端點改名後的 `placeId` 契約 + `placeType: "google"` 可建立評論

**回歸**：現有 20 個 place-search 測試依新契約更新；review 既有測試隨改名更新。

---

## 10. 風險與待決


| #   | 項目                                       | 狀態                                     |
| --- | ---------------------------------------- | -------------------------------------- |
| R1  | Nominatim 集中流量遭封鎖                        | 已列緩解（§7.1）；中期自架                        |
| R2  | Google 預測無座標 → 跨源去重只能靠名稱，會出現重複卡          | 接受；備案（改 `searchText`）記於 §5 項目 5，本次不做      |
| R3  | review `osmId → placeId` 改名為破壞性變更，需跑遷移腳本 | 已決策採 A；遷移為純 `$rename`，風險低              |
| R4  | Nominatim 對台灣中文 POI 的召回率可能不如 Google      | 實作後以實際 query 抽驗；`sources` 參數可隨時調整權重／關閉 |
| R5  | 契約破壞性變更（id 加前綴、`:placeId`→`:id`、欄位擴充）    | 依專案慣例可接受，交付遷移說明                        |


**已決策（2026-07-27）**

- ✅ 只合併 Nominatim + Google；本地 collection 不當搜尋來源。
- ✅ review key 採選項 A（`osmId` → `placeId`、enum 加 `google`）。
- ✅ 本地文字搜尋只做前綴比對 —— 因本地來源已排除，此項自動失效（不再需要 `$regex` 與新索引）。

---

## 11. 實作結果（2026-07-27 已完成）

`npm run build`（lint:arch + tsc）綠、`npm test` **813 綠**（原 744，新增 69）。

**新增**：`src/adapters/nominatim.adapter.ts`、`src/modules/place-search/place-search.types.ts`
（+ `place-search.types.test.ts`）、`src/scripts/migrate-review-place-id.ts`（`npm run migrate:review-place-id`）。

**修改**：`google.adapter.ts`（FieldMask 加 `types,addressComponents` + `toAddressComponents()`）、
place-search 的 schema／service／controller／router 與兩支測試、review module 全面 `osmId → placeId`、
`.env.example` 加兩個 Nominatim 變數。

**實作參數**：Nominatim 全域節流 1 req/s、佇列等待上限 2s（超過即放棄該路）、HTTP timeout 2s、
`viewbox` 偏好 ±0.3°（不加 `bounded`，僅為軟偏好）；每來源取 5 筆、合併後預設上限 8；
快取 `ps:ac:` 120s／`ps:osm:` 300s／`ps:osmd:` 600s，Google details 不快取。

### 真實 API 煙測（2026-07-27）

直接呼叫 adapter 打正式 Nominatim，非 mock：

| query | 結果 | 耗時 |
|---|---|---|
| `台北101` | 2 筆，首筆 `way/1159328965` `tourism/attraction` | 473ms |
| `台北車站` | 5 筆，首筆 `node/3495094870` `railway/station` | 1340ms |
| `台大醫院` | 4 筆，首筆 `node/2051219232` `railway/stop` | 1380ms |
| `台北1`（部分輸入） | 3 筆，**全是雜訊**（淡水區的中山北路一段、臺北市與新北市的行政區界） | 1083ms |
| lookup `way/370565540` | 成功，address 四格完整（road/district/city/postcode） | 692ms |

**兩個煙測才看得到的事實**：

1. **`q=台北1` 在 Nominatim 完全失效** —— 只回淡水的中山北路與行政區界，找不到台北101。
   原因不是「中文召回差」（見 §12 的根因），而是 Nominatim `/search` 沒有前綴比對能力。
   → **此發現直接導致 §12 的引擎更換。**
2. **OSM 自己就有大量同名重複**：「台北車站」5 筆全部同名、「台大醫院」4 筆（台/臺混用）。
   §5 的名稱正規化去重原本只為跨源設計，實際上**同源重複才是主要清理對象**。

---

## 12. 修正：OSM 搜尋改用 Photon（2026-07-27 同日）

### 根因

§11 煙測的失敗被誤判為「Nominatim 對中文召回差」。實際對照實驗（前端原參數 vs adapter 參數、
`accept-language` zh/en 兩種）證明**兩者結果一字不差**，且與語言無關：

| query | Nominatim 結果 |
|---|---|
| `台北` | 臺北市（行政區） |
| `台北1` | 淡水區中山北路一段 ×2、臺北市、新北市 |
| `台北10` | 淡水區一條真的叫「北10」的路 |
| `台北101` | ✅ 台北101, 7, 信義路五段, 信義區 |
| `台北 101`（加空格） | 門牌號 101 的地址們（羅斯福路六段 97;99;101…） |

**真正的根因：Nominatim `/search` 是 geocoder，只做整詞比對，沒有前綴比對。**
與中文無關 —— `Taipei 1` 同樣到不了 `Taipei 101`。官方文件明載不適合 type-ahead。
前端過去直連 Nominatim 時是同樣行為，只是使用者只會注意到打完整名稱那一刻的正確結果。

### 修法

**搜尋改用 Photon**（Komoot 以 OSM 資料建的 Elasticsearch 索引，專為前綴輸入設計），
**details 維持 Nominatim `/lookup`**。兩者回傳同一組 `osm_type`/`osm_id`（實測 Photon 的
`W/1159328965` 就是 Nominatim 的 `way/1159328965`），所以 §3 的 id 體系、§5 的合併去重、
`PlaceResult` 全部不用改，改動只在 adapter 一層。

- 新增 `src/types/osm.ts`：`OsmPlace` / `OsmType` / `OsmAddress` 抽成共用型別（兩個 adapter 都產出這個形狀）。
- 新增 `src/adapters/photon.adapter.ts`：`searchOsmPlaces()`。
- `src/adapters/nominatim.adapter.ts` 收斂為只有 `lookupOsmPlace()`。
- `.env.example` 加 `PHOTON_BASE_URL`。

### 兩個 Photon 專屬的坑（都已處理）

1. **Photon 索引是全球的，公用 API 沒有 `countrycodes` 參數。** 不過濾的話
   `市政府站` 會回一筆**廈門市**的公車站、`台北101` 會回兩筆**東京都／日光市**的地點。
   → 以每筆自帶的 `countrycode === "TW"` 過濾（實測每筆都有此欄位且正確），
   並以 3 倍 over-fetch 確保過濾後仍湊得到 caller 要的筆數。
2. **同一地標在索引中重複三四次**（建物、車站、商場各一筆），會吃光 limit 名額。
   → adapter 內先去重（保留第一筆）。去重鍵用的是**與服務層同一個**正規化函式
   （`src/utils/place-name.ts` 的 `normalizePlaceName`，NFKC + 去空白 + 臺/台 + 小寫），
   否則 adapter 只擋得掉字面完全相同的重複，「台北101」與「臺北 101」仍會各佔一個名額、
   到服務層才被丟掉 —— 名額白白浪費。

### 節流策略的差異（刻意）

Nominatim 保留全域 1 req/s 節流（官方硬性政策）；**Photon 不設人工節流** —— 它沒有公布硬性速率上限，
政策是「合理使用，過量會被限速」，控制手段改為既有的 per-IP 限流與 Redis 快取。程式碼註解已載明此差異。

### 更換後煙測（2026-07-27，實打 photon.komoot.io）

| query | 結果 |
|---|---|
| `台北1` | ✅ 5 筆：台北101 / 台北101世貿站 / 台北1號隧道 / 台北1號院 / 台北101購物中心 |
| `台北10` | ✅ 首筆台北101（246ms） |
| `台大醫` | ✅ 台大醫院 / 景通停車場 / 台大醫學院附設醫院 / 雲林分院 / 新竹分院 |
| `市政府站` | ✅ 2 筆（TW 過濾 + 同名去重後），廈門那筆已消失 |
| lookup `way/1159328965` | ✅ Nominatim 仍正常，address 四格完整（605ms） |

**§10 R4 結論更新**：不再成立。換 Photon 後 OSM 這路在逐字輸入階段是**真的有用的**，
不再只是「打完整名稱才有結果」。

`npm run build` 綠、`npm test` **826 綠**（新增 13 個 Photon adapter 測試）。

