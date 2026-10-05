# 路線起點縣市：改為行政區代碼或 null

## 影響範圍

- `POST /api/v1/a11y/accessible-route` 成功回應的 `data.city`。
- `GET /api/v1/line/route-preview` 成功回應的 `data.city`（沿用路線 schema）。
- AI 工具 `planAccessibleRoute` 的 `city`。

## 新契約

`city` 欄位必定存在，型別為 `TaiwanCityEn | null`。非 null 時代表**起點座標的行政縣市**，不是最近站牌的 TDX 資料集，也不代表終點或路線沿途縣市。

例如板橋回 `"NewTaipei"`（沒有尾空白），基隆回 `"Keelung"`；不再回 `"InterCity"`。嘉義市／縣分別為 `"Chiayi"`／`"ChiayiCounty"`，新竹市／縣分別為 `"Hsinchu"`／`"HsinchuCounty"`。完整合法值由 `src/types/transit.ts` 的 `TaiwanCityEn` 定義，並反映於 `/api/v1/openapi.json`（文件介面 `/docs`）。

行政區反查以國土測繪中心 NLSC 為主（包含金門 `"KinmenCounty"`）；NLSC 查無地號（`NO_LAND`）、1.5 秒逾時或回應異常時，退回 Google。兩者都無法辨識時回 `null`，不因縣市查詢失敗而中止路線規劃；其他既有範圍限制、無路線或路由引擎錯誤仍適用。這次來源替換不改變 nullable 契約，前端不需新增欄位；公車 GPS 縣市退路也採同一策略，明確指定的縣市／`InterCity` 優先順序保持不變。

成功回應片段：

```json
{ "ok": true, "data": { "city": "NewTaipei" } }
```

```json
{ "ok": true, "data": { "city": null } }
```

## 前端調整

1. 將回應型別由必填字串改為必填 `TaiwanCityEn | null`，保留所有其他欄位。
2. 顯示前先判空；`null` 時隱藏縣市標籤或顯示「縣市未知」，不要呼叫字串方法、不要預設成台北。
3. 不要用路線的 `data.city` 推斷公車 TDX 查詢 scope；公車資料集與查詢的 `InterCity` 用法保持不變。
4. `city` 是資訊欄位，不是路線成功與否的判準；繼續以既有 `ok` 與路線資料處理結果。
