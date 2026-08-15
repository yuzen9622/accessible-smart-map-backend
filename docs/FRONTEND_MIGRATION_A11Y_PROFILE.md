# 前端遷移說明：使用者無障礙偏好 Profile

Onboarding 的「開始設定」步驟現在有實際效果了：使用者填的偏好會存起來，並且**規劃路線時若登入，未明確指定的欄位會自動套用**。

## 一、讀寫偏好

```
GET  /api/v1/user/a11y-profile     （需登入）
PUT  /api/v1/user/a11y-profile     （需登入，部分更新，只改傳入欄位）
```

欄位皆為選填、未設定回 `null`：

```jsonc
{
  "mobilityAid": "manual_wheelchair" | "power_wheelchair" | "walker" | "none" | null,
  "canUseStairs": boolean | null,
  "maxSlopePercent": number | null,        // 0-100，尚未接入路線引擎（見下方限制）
  "needsAccessibleToilet": boolean | null, // 尚未接入任何篩選邏輯
  "needsElevator": boolean | null,
  "needsHandrail": boolean | null,         // 尚未接入任何篩選邏輯
  "visualAssistance": boolean | null,
  "preferredFontScale": number | null      // 0.5-3，純前端顯示用，後端只負責存
}
```

`GET` 首次呼叫時若使用者從未設定過，會自動建立一筆全部為 `null` 的空白設定，不會回 404。

## 二、對路線規劃 API 的影響

`POST /api/v1/a11y/accessible-route` 維持**完全公開、不強制登入**。差別只在於：**帶 `Authorization: Bearer` 時**，若請求本身沒有明確傳 `mode` / `avoidStairs` / `requireElevator`，後端會依序退回：

1. 請求裡明確帶的值（最優先，一次性覆蓋帳號預設）
2. `query` 自然語言解析出的意圖（例如「幫我找一條給長者走的路線」）
3. 已儲存的無障礙 profile（`manual_wheelchair`/`power_wheelchair` → `mode=wheelchair`；`canUseStairs:false` → `avoidStairs=true`；`needsElevator:true` → `requireElevator=true`；`needsAccessibleToilet`/`needsHandrail`/`maxSlopePercent` 同樣會從 profile 帶入，見下方第三、四節說明實際效果）
4. 最後才是 `mode==='normal'` 的原本預設

**前端不需要改任何呼叫方式**——只要規劃路線時附上使用者的登入 token，行為就會自動套用其偏好；若該次請求想暫時忽略帳號設定（例如幫別人規劃），照舊自己傳入 `mode`/`avoidStairs`/`requireElevator` 即可覆蓋。

⚠️ **帶了 token 但 token 無效或過期**：這支路由會回 401/403，而不是靜默當成訪客——如果前端的路線規劃頁面允許訪客使用，記得在 access token 過期時對這支 API 做跟其他受保護 API 一樣的重新登入處理，不要讓使用者卡住。

## 三、`needsAccessibleToilet` / `needsHandrail` 實際效果

這兩項**不會改變選路**，但會執行真實的資料檢查並反映在回應裡：

- `needsAccessibleToilet: true` → 檢查目的地 300m 內是否有登記的無障礙廁所：有就加進 `accessibilityHighlights`（例如「目的地附近有 2 處無障礙廁所」），查無則加進 `warnings`（不代表確定沒有，只是資料庫沒登記）。
- `needsHandrail: true` → 若路線包含樓梯段落且 OSM 資料中該樓梯未標記 `handrail=yes`，會在 `warnings` 加上提醒。**OSM 扶手標記涵蓋率很低**，大多數樓梯都會落入「未確認」，前端不要把這個提醒讀成「確定沒有扶手」。

## 四、`maxSlopePercent`：誠實回報是否真的有篩選（重要）

這一項**目前無法真正影響選路**，原因是基礎設施限制（已確認，不是偷懶）：

- **開車/駕駛車（Valhalla）**：伺服器**完全沒有地形高程資料**（`valhalla.json` 有寫 `elevation` 路徑，但那個目錄從未被掛進容器、也從未實際存在過）。沒有高程資料，就沒有坡度可以篩，這不是寫代碼能解決的問題。
- **大眾運輸/步行（OTP）**：伺服器目前固定套用 8.3%（ADA 標準）作為輪椅模式的上限，**且只有在 `avoidStairs`/輪椅模式實際啟用時才會套用**；現有 API 也不支援每次請求自訂數值（需要從 OTP 舊版 `plan` query 改用新版 `planConnection` query 才能接受每次請求自訂坡度，屬於核心路徑引擎的協議層級改動，不是一次小修改）。即使有高程資料，OTP 的坡度計算也只能有一部分依賴 OSM 的 `incline` 標記，而台灣道路有標記坡度的比例非常低。

因此回應不會假裝這項生效，而是回傳一個誠實的 `data.slopeConstraint` 物件：

```jsonc
{
  "slopeConstraint": {
    "requestedMaxPercent": 5,
    "enforced": false, // 真的有被套用時才是 true
    "note": "大眾運輸/步行路線引擎目前固定以 8.3% 作為輪椅模式上限，無法套用您要求的更嚴格數值",
  },
}
```

**前端一定要檢查 `enforced`**，不能只看有沒有傳 `maxSlopePercent`。`enforced: false` 時建議將 `note` 直接顯示給使用者，讓他知道這個設定目前沒有實際作用，而不是讓他以為系統已經幫他避開陡坡。

**若未來要讓這項真正生效，需要的基礎建設（已確認的需求，需獨立排程）：**

1. 為台灣下載/建置 SRTM 或同等級 DEM 地形高程資料，並正確掛進 Valhalla 容器的 `/data/valhalla/elevation/`，重建 tiles。Valhalla 本身對行人模式只有軟性避山權重（`use_hills`），沒有硬性百分比上限，還需自己後處理回傳的每段坡度來實現硬篩選。
2. 為 OTP graph build 配上 `elevationBucket`（目前 `otp-data/build-config.json` 沒有），讓坡度計算不完全依賴稀疏的 OSM incline 標記。
3. 將 otp-routing.ts 從舊版 `plan` GraphQL query 改寫成新版 `planConnection` query（支援每次請求自訂 `wheelchairAccessibility.maxSlope`）——這是一個會改變核心路徑規劃邏輯的重構，需要獨立規劃與充分測試。

## 五、`preferredFontScale`

純粹是前端的顯示設定，後端只負責儲存與回傳，不影響任何 API 的其他回應內容。
