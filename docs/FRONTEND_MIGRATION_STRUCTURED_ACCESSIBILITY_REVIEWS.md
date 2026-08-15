# 前端／API 遷移說明：結構化無障礙評價

**影響端點**：`POST` / `GET /api/v1/a11y/reviews`、`PATCH /api/v1/a11y/reviews/{id}`  
**日期**：2026-08-11  
**性質**：純新增（additive）。既有 `rating`、四個既有子評分、登入／本人權限及 response envelope 都不變。

---

## 新增欄位

所有欄位均採穩定英文 API 名稱。它們在建立與更新 request 都是 optional；MongoDB 欄位也沒有 default 或 required 設定，因此不需要遷移舊文件。

| 欄位                          | 型別                                                                  | 說明                                                            |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `entranceAccessibility`       | `"step_free" \| "ramp" \| "stairs_with_assistance" \| "inaccessible"` | 入口是否可無階通行、經坡道、需協助上下階梯，或不可通行          |
| `toiletTurningRoom`           | `boolean`                                                             | 輪椅能否在無障礙廁所內迴轉                                      |
| `wheelchairTableHeight`       | `boolean`                                                             | 桌面高度是否適合輪椅使用者                                      |
| `adequateAisleWidth`          | `boolean`                                                             | 主要走道寬度是否足夠輪椅通行                                    |
| `staffHelpfulnessRating`      | integer `1`–`5`                                                       | 工作人員協助程度                                                |
| `aggregateAccessibilityScore` | number `1`–`5`                                                        | 後端衍生的總合無障礙分數；只出現在 response，不可由 client 寫入 |

`POST` 的既有 `passageWidthRating`、`toiletRating`、`elevatorRating`、`serviceRating` 仍然必填，範圍仍為整數 `1`–`5`。request body 是 strict schema：未知欄位、非列舉的入口值、非布林值，以及超出範圍或非整數的 `staffHelpfulnessRating` 都會得到原本的 `400` response envelope。

## `rating` 與 aggregate 分數

`rating` 的既有語意完全保留：建立時、或更新任一既有子評分時，仍為：

```text
rating = (passageWidthRating + toiletRating + elevatorRating + serviceRating) / 4
```

結構化欄位不會覆寫 `rating`。它們另外產生 `aggregateAccessibilityScore`；此分數固定是 `1`–`5`，以下公式是後端的 deterministic contract：

1. 以現有 `rating` 作為 legacy baseline。極舊文件若沒有可用的 `rating`，才使用已存在的四個 legacy 子評分的平均值。
2. 將每個**有提供**的結構化證據轉為一個 1–5 分值：

   | 證據                                              |      分值 |
   | ------------------------------------------------- | --------: |
   | `entranceAccessibility: "step_free"`              |         5 |
   | `entranceAccessibility: "ramp"`                   |         4 |
   | `entranceAccessibility: "stairs_with_assistance"` |         2 |
   | `entranceAccessibility: "inaccessible"`           |         1 |
   | 任一結構化 boolean 為 `true` / `false`            |     5 / 1 |
   | `staffHelpfulnessRating`                          | 該 1–5 值 |

3. 對 baseline 與上述有提供的 evidence 等權重取算術平均，四捨五入到小數一位。

例如原本 `rating` 為 `4`，且送出 `step_free`、`toiletTurningRoom: true`、`wheelchairTableHeight: false`、`adequateAisleWidth: true`、`staffHelpfulnessRating: 3`：

```text
aggregateAccessibilityScore = round1((4 + 5 + 5 + 1 + 5 + 3) / 6) = 3.8
```

新建或更新的評價會把這個值 materialize 到 MongoDB。舊評價本身不會被改寫；讀取舊評價時，回應中的 aggregate 分數會以其既有 `rating` 衍生，且五個新 evidence 欄位仍省略。

## 請求範例

```json
POST /api/v1/a11y/reviews
{
  "placeId": "node/123456",
  "placeType": "osm",
  "passageWidthRating": 4,
  "toiletRating": 4,
  "elevatorRating": 4,
  "serviceRating": 4,
  "entranceAccessibility": "step_free",
  "toiletTurningRoom": true,
  "wheelchairTableHeight": false,
  "adequateAisleWidth": true,
  "staffHelpfulnessRating": 3,
  "comment": "入口平坦，但桌面略高"
}
```

更新只送需要更正的欄位即可：

```json
PATCH /api/v1/a11y/reviews/{id}
{
  "entranceAccessibility": "ramp",
  "staffHelpfulnessRating": 5
}
```

這種只更新結構化 evidence 的 PATCH 會重新計算 `aggregateAccessibilityScore`，但不改變既有 `rating`。原有本人驗證與 response envelope 不變。

## 列表篩選

`GET /api/v1/a11y/reviews` 新增可選 query parameter：

```text
minAggregateScore=3.5
```

接受含小數的數字，範圍為 `1` 到 `5`（含）。只有有效、指定地點，且 aggregate 分數大於或等於該值的評價會出現在 `data.items`；`totalCount` 與 `avgRating` 也使用同一篩選集合。沒有 materialized aggregate 分數的舊文件以其既有 `rating` 比較，因此舊資料不會因新增 filter 被無故排除。

列表、建立與更新的 `data.review`／`data.items[]` 都可讀取新增欄位。例如：

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "取得評價列表成功",
  "data": {
    "items": [
      {
        "_id": "66a1f2c3e4b5a6d7c8e9f0d4",
        "rating": 4,
        "entranceAccessibility": "step_free",
        "toiletTurningRoom": true,
        "wheelchairTableHeight": false,
        "adequateAisleWidth": true,
        "staffHelpfulnessRating": 3,
        "aggregateAccessibilityScore": 3.8
      }
    ]
  }
}
```

前端可漸進採用：不送新欄位時，建立／更新與改版前相容；展示時須把未出現的 evidence 欄位視為「未評估」，不要推斷為 `false`。
