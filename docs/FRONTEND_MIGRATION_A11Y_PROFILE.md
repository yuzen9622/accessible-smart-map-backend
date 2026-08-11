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
3. 已儲存的無障礙 profile（`manual_wheelchair`/`power_wheelchair` → `mode=wheelchair`；`canUseStairs:false` → `avoidStairs=true`；`needsElevator:true` → `requireElevator=true`）
4. 最後才是 `mode==='normal'` 的原本預設

**前端不需要改任何呼叫方式**——只要規劃路線時附上使用者的登入 token，行為就會自動套用其偏好；若該次請求想暫時忽略帳號設定（例如幫別人規劃），照舊自己傳入 `mode`/`avoidStairs`/`requireElevator` 即可覆蓋。

⚠️ **帶了 token 但 token 無效或過期**：這支路由會回 401/403，而不是靜默當成訪客——如果前端的路線規劃頁面允許訪客使用，記得在 access token 過期時對這支 API 做跟其他受保護 API 一樣的重新登入處理，不要讓使用者卡住。

## 三、目前的限制（尚未實作）

- `maxSlopePercent`、`needsHandrail`、`needsAccessibleToilet` 目前**只存不用**：路徑引擎（OTP/Valhalla）還沒有坡度成本或設施篩選可以吃這些欄位，屬於中長期工程（B12 路線無障礙細節的前置條件）。
- `preferredFontScale` 純粹是前端的顯示設定，後端只負責儲存與回傳，不影響任何 API 的其他回應內容。
