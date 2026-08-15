# 無障礙智慧地圖 API 回傳資訊合理性與多餘欄位審計報告

> **狀態更新 (2026-07-12)**
> ✅ **已完成優化**：所有在報告中指出的多餘與重複欄位已全面修復。
>
> - Mongoose 的 `__v` 欄位已在 `sendResponse` 全域處理與 JWT 簽發中被自動剔除。
> - 當 API 回傳 GeoJSON 的 `location` 欄位時，平鋪的冗餘經緯度座標（`經度`/`緯度` 與 `latitude`/`longitude`）亦已被全域剔除。
> - 專案內的 TypeScript 定義檔與 Zod Schema 均已同步完成更新。
> - 自動化測試通過（20/20，Redundancies 檢測結果全數為 None detected）。

本報告針對整個 API 路由回傳資訊的合理性進行審計，整理並標出所有多餘、重複的欄位，同時將自動化測試腳本寫於 [api.test.ts](file:///Users/yuen/project/taipei-accessible-backend/tests/e2e/api.test.ts)。

---

## 一、 測試執行與整體合理性評估

我們建立了 20 條 API 路由的真實資料整合測試，所有測試均已通過（Passed: 20/20）。

API 設計整體結構分明，遵循了一致的回應信封結構（Response Envelope）：

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "OK",
  "data": { ... },
  "accessToken": "..."
}
```

資訊的合理性除以下列出的多餘欄位外，其餘商務邏輯欄位（如大眾運輸到站時間、無障礙路線規劃步驟、無障礙設施標籤等）皆符合前端渲染與路線演算的實際需求，設計相當合理。

---

## 二、 多餘或重複欄位審計清單（Redundant Fields）

經過自動化程式掃描與人工代碼審查，我們確認了整個 API 中以下欄位為**多餘（Redundant）**或**重複（Duplicate）**資訊：

### 1. Mongoose 內部版本控制鍵 `__v`

Mongoose 在建立 Document 時，預設會為每個 Document 加入 `__v`（Version Key）來處理併發版本控制。此欄位對前端介面渲染、資料傳輸或後端業務邏輯沒有任何實質用途，不應曝露在對外 API 中。

- **影響路由：**
  - `POST /api/v1/user/login` 內的 `data.user.__v` 與 `data.config.__v`
  - `GET /api/v1/user/info` 內的 `data.user.__v` 與 `data.config.__v`
  - `POST /api/v1/user/config` 內的 `data.__v`
  - `POST /api/v1/user/config/update` 內的 `data.__v`
  - `POST /api/v1/user/token` 內的 `data.user.__v`
  - `POST /api/v1/user/refresh` 內的 `data.user.__v`
  - `GET /api/v1/a11y/nearby-a11y` 內的 `data.nearbyOsm[].__v`
  - `GET /api/v1/a11y/place` 內的 `data[].__v`
- **改善建議：**
  在 Mongoose 查詢時加上 `.select("-__v")`，或在 `toObject` / `toJSON` 轉換中設定排除 `__v`，以減少傳輸頻寬並確保 API 的乾淨性。

### 2. 重複的經緯度座標欄位（Duplicate Coordinates）

在無障礙地點與無障礙廁所的資料中，同一個點位同時存在傳統的「經度」/「緯度」平面欄位，又同時存在符合 GeoJSON 規範的 `location.coordinates` 陣列欄位。這屬於典型的資料重複（冗餘）。

- **影響路由：**
  - `GET /api/v1/a11y/all-places`：
    - `經度` (Longitude) 與 `緯度` (Latitude)
    - 與 `location.coordinates: [經度, 緯度]` 內容完全相同且重複。
  - `GET /api/v1/a11y/all-bathrooms` 與 `GET /api/v1/a11y/nearby-a11y`：
    - `latitude` 與 `longitude`
    - 與 `location.coordinates` (若資料庫含有) 內容重複。
- **合理性分析：**
  - GeoJSON 格式（`location.coordinates`）是用於 MongoDB 做 `$near` 或 `$nearSphere` 2dsphere 空間地理查詢所必須的。
  - 獨立的 `經度`、`緯度` 則是傳統關聯式資料庫的平面設計。
- **改善建議：**
  - 若前端已全面升級支援 GeoJSON 格式，應在 API 統一移除非標準的 `經度` / `緯度` / `latitude` / `longitude`，統一改讀 `location.coordinates`。

---

## 三、 API 欄位合理性審計表

下表列出每條路由的回傳資訊合理性與多餘欄位：

| 路由路徑                             | 功能說明                       | 回傳資訊合理性評估                                    | 偵測到之多餘/重複欄位                                    |
| :----------------------------------- | :----------------------------- | :---------------------------------------------------- | :------------------------------------------------------- |
| `GET /health`                        | 伺服器健康檢查                 | **合理**。僅回傳 minimal 狀態資訊。                   | 無                                                       |
| `GET /api/v1/openapi.json`           | Swagger/OpenAPI 文件           | **合理**。符合 OpenAPI 規範標準。                     | 無                                                       |
| `POST /api/v1/user/login`            | 使用者 OAuth 登入              | **合理**。傳回 user 與預設 config 物件。              | `user.__v`, `config.__v`                                 |
| `GET /api/v1/user/info`              | 取得當前登入者資訊             | **合理**。                                            | `user.__v`, `config.__v`                                 |
| `POST /api/v1/user/config`           | 取得使用者無障礙偏好           | **合理**。                                            | `__v`                                                    |
| `POST /api/v1/user/config/update`    | 更新使用者偏好設定             | **合理**。回傳更新後的 config 物件。                  | `__v`                                                    |
| `POST /api/v1/user/token`            | 重新發行 Access Token          | **合理**。                                            | `user.__v`                                               |
| `POST /api/v1/user/refresh`          | Cookie 換發 Token              | **合理**。                                            | `user.__v`                                               |
| `POST /api/v1/transit/bus`           | 即時公車到站預估               | **合理**。包含 TDX 即時預估秒數與站點。               | 無 (屬 TDX 原始資料透傳)                                 |
| `GET /api/v1/transit/bus/realtime`   | 即時公車 GPS 位置              | **合理**。                                            | 無 (屬 TDX 原始資料透傳)                                 |
| `GET /api/v1/a11y/all-places`        | 取得所有無障礙出口/電梯        | **欄位冗餘**。平面座標與 GeoJSON 座標重複。           | `經度`, `緯度` (與 `location` 重複)                      |
| `GET /api/v1/a11y/all-bathrooms`     | 取得所有無障礙廁所             | **欄位冗餘**。平面座標與 GeoJSON 座標重複。           | `longitude`, `latitude`                                  |
| `GET /api/v1/a11y/nearby-a11y`       | 尋找指定座標鄰近設施           | **欄位冗餘**。同時帶有資料庫 version key 與重複座標。 | `nearbyOsm[].__v`, `nearbyBathroom[].latitude/longitude` |
| `GET /api/v1/a11y/place`             | 取得單一設施詳細資料           | **合理**。包含原始標籤供 AI/前端分析。                | `__v`                                                    |
| `POST /api/v1/a11y/accessible-route` | 無障礙綜合路線規劃             | **合理**。回傳經無障礙引擎評分與排序的 Leg 陣列。     | 無                                                       |
| `GET /api/v1/air/air-quality`        | 依經緯度取得空氣品質與 AI 建議 | **合理**。回傳由 Gemini 合併 PM2.5 指數後生成的建議。 | 無                                                       |
| `POST /api/v1/ai/intent`             | 自然語言意圖解析               | **合理**。                                            | 無                                                       |
| `POST /api/v1/ai/explain`            | AI 路線無障礙亮點說明          | **合理**。                                            | 無                                                       |
| `POST /api/v1/ai/chat`               | AI 無障礙助理對話 (SSE/JSON)   | **合理**。                                            | 無                                                       |
| `POST /api/v1/user/logout`           | 登出並清除 Cookie              | **合理**。                                            | 無                                                       |

---

## 四、 測試執行指引 (How to Run)

如需在本地執行本 API 整合測試，請使用以下指令：

```bash
# 確保 backend 容器已啟動 (或本地 API 已啟動於 port 8000)
npx dotenvx run -- ts-node tests/e2e/api.test.ts
```
