# 前端遷移說明：統一地點搜尋（2026-07-27）

後端 `/api/v1/a11y/search/*` 已從「只有 Google」改為 **Nominatim（OSM）+ Google 兩路合併**。
本文列出前端要改的每一處。後端規格見 `docs/specs/FUNCTIONAL_SPEC_PLACE_SEARCH_UNIFIED.md`。

---

## 1. 拔掉直連 Nominatim

`usePlacePredictions.ts` 目前直接 fetch `nominatim.openstreetmap.org/search`。**請改打後端。**

除了「拿不到無障礙資訊」之外，有一個你可能沒發現的問題：**Nominatim `/search` 沒有前綴比對能力**，
它是 geocoder 不是 autocomplete。實測 `q=台北1` 回的是淡水區的中山北路一段和行政區界，
`q=台北10` 回的是淡水一條真的叫「北10」的路 —— 只有打完整的 `台北101` 才會命中。
這與 `accept-language` 無關（zh/en 都一樣），也與中文無關（`Taipei 1` 同樣到不了 `Taipei 101`）。

後端這一路已改用 **Photon**（Komoot 以 OSM 資料建的索引，專為前綴輸入設計），
`q=台北1` 會正確回傳台北101。**這是改打後端最實際的好處**，不只是架構整潔。

```
GET /api/v1/a11y/search/autocomplete?q=<text>&sessiontoken=<uuid>&lat=&lng=&sources=&limit=
```

- `q` 必填；`sessiontoken` 前端產生 UUID，逐字期間共用同一個，選定後作廢換新。
- `lat`/`lng` 可選（偏好用）。`sources` 可選，預設 `osm,google`，逗號分隔，只接受這兩個值。
- `limit` 可選，1–20，預設 8。
- 任一來源失敗只掉該來源，仍回 200。

> ⚠️ **`lat`/`lng` 不是「使用者裝置 GPS」的代名詞，而是任意的距離基準點**：`distanceMeters` 是相對於你傳進來的 `lat`/`lng` 的直線距離（haversine），不是固定用裝置 GPS。想要「距離地圖中心多遠」就傳地圖中心的座標，想要「距離使用者目前位置」就傳裝置 GPS——兩種用途都用同一對參數，差別只在你傳什麼進去。若未傳，`distanceMeters` 回 `null`，**不會**自動回退使用伺服器端的任何位置。另外：目前是**直線距離**，對輪椊使用者來說意義有限（中途可能有階梯、沒有縨石斜坡），中長期若需要「無障礙路徑距離」請別提需求。

## 2. `AutocompleteItem` 欄位變了

```ts
interface AutocompleteItem {
  id: string;                    // ⚠️ 新：前綴 id。取代舊的 placeId
  source: "osm" | "google";      // 新
  primaryText: string;
  secondaryText: string | null;  // OSM 是完整地址（≈ display_name）；Google 是預測副標
  placeClass: string | null;     // 新：OSM 字彙，對應舊的 class/category
  placeType: string | null;      // 新：對應舊的 type
  typeLabel: string | null;      // 新：後端給的中文標籤
  location: { type: "Point"; coordinates: [number, number] } | null;  // 新，[lng, lat]
  distanceMeters: number | null; // 新
}
```

對照舊的 Nominatim 直連寫法：

| 前端原本用 | 改用 |
|---|---|
| `place.name ‖ place.display_name` | `item.primaryText` |
| `place.display_name` | `item.secondaryText` |
| `getPlaceIcon(place.class ‖ place.category, place.type)` | `getPlaceIcon(item.placeClass, item.placeType)`（字彙相同，Google 筆已在後端映射成 OSM 字彙，可不改 icon 邏輯） |
| `place.osm_type` + `place.osm_id` 自組 key | `item.id` |

**兩個要注意的**：

- **Google 筆的 `location` 恆為 `null`**，`placeClass`/`placeType`/`typeLabel` 也是 `null`。
  這不是 bug —— Google Autocomplete 在預測階段不回座標。UI 需容忍：距離不顯示、圖示走 fallback。
  座標與類型在使用者點選、呼叫 details 後才有。
- **歷史紀錄要改存 `id`**（含前綴），否則無法重查。只存 name/display_name 會失去回查能力。

## 3. details 端點：路徑與回傳都變了

```
GET /api/v1/a11y/search/details/:id?sessiontoken=&lat=&lng=
```

- ⚠️ **`:id` 必須帶前綴**：`google:<placeId>` 或 `osm:<node|way|relation>:<id>`，
  直接把 `AutocompleteItem.id` 丟進去即可。傳裸 id 會得到 **400**。
- `osm:` 開頭的 id 不會呼叫 Google，也不消耗 session token。
- 查無地點或無座標 → **404**。

```ts
interface PlaceResult {
  id: string;
  source: "osm" | "google";
  name: string;
  fullAddress: string | null;          // ⚠️ 舊欄位叫 address；≈ display_name
  addressComponents: {                 // 新：後端已做完 ‖ fallback，前端不用再自己挑
    road: string | null;               //   ← road
    district: string | null;           //   ← suburb ‖ neighbourhood
    city: string | null;               //   ← city ‖ town ‖ county
    postcode: string | null;
  };
  location: { type: "Point"; coordinates: [number, number] };  // [lng, lat]
  placeClass: string | null;
  placeType: string | null;
  typeLabel: string | null;            // 新：可取代 getPlaceTypeLabel(type)
  distanceMeters: number | null;
  rating: number | null;               // 只有 google 來源有
  accessibility: {
    status: "accessible" | "limited" | "unknown";
    wheelchair: "yes" | "limited" | "no" | null;
    nearbyFacilityCount: number;
    source: "local-db" | "google" | "none";
  };
  nearbyFacilities: {                  // 新：各 4 筆，不用再另外呼叫
    toilets: NearbyFacilityBrief[];
    metro: NearbyFacilityBrief[];
  };
  reviewKey: { placeId: string; placeType: ReviewPlaceType };  // 新，見 §4
  externalLinks: { osm: string | null; google: string | null };  // 新，已組好的連結
  attribution: string | null;          // "Powered by Google" / "© OpenStreetMap contributors"
}

interface NearbyFacilityBrief {
  id: string; name: string; address: string | null;
  category: string;       // "toilet" | "elevator" | "ramp" | "other"
  typeLabel: string;      // "無障礙廁所" / "電梯" / "坡道"
  distanceMeters: number;
}
```

**已移除的欄位**：`address`（改叫 `fullAddress`）、`category`（改叫 `placeType`，語意更精確）。

**OSM 外連**不用再自己拼 —— 直接用 `externalLinks.osm`（非 OSM 來源為 `null`，該按鈕請隱藏）。
`attribution` 依 Google 與 OSM 條款都要顯示在結果附近。

## 4. ⚠️ 評論 API 的 `osmId` 改名 `placeId`

三支端點的參數名都改了，這是**破壞性變更**：

```
GET    /api/v1/a11y/reviews?placeId=<id>&placeType=<type>&page=&limit=
GET    /api/v1/a11y/reviews/summary?placeId=<id>&placeType=<type>
POST   /api/v1/a11y/reviews          body: { placeId, placeType, ...ratings }
```

- **值沒有變**：OSM 地點仍然是 `node/123456` 這種斜線形式。只有欄位名改了。
- `placeType` 新增 `"google"`，Google 來源的地點現在也能掛評論。
- **不要自己組這個 key** —— 直接用 `PlaceResult.reviewKey.placeId` 與 `.placeType`。
  注意 `reviewKey.placeId` 與 `PlaceResult.id` **不同**：前者是 `node/123456`（相容既有評論資料），
  後者是 `osm:node:123456`（路由用）。

後端部署時需跑一次 `pnpm migrate:review-place-id`（純欄位改名，不動值）。

## 5. 已知限制（UI 需容忍）

- **可能出現同一地點兩張卡**。Google 預測階段沒有座標，跨來源去重只能比名稱字串，
  「台北101」對上「台北 101 購物中心」比不出來。
- **同名 OSM 結果會被合併成一筆**（一個地標在 OSM 常有建物／車站／商場三四筆同名），
  保留 Photon 相關度排序的第一筆。副作用：搜「台大醫院」保留的可能是捷運站而非醫院本體。
- **debounce 建議維持 300–500ms**。後端有 Redis 快取，但 Photon 與 Google 都是外部服務，
  不要因為結果變好就縮短間隔。
