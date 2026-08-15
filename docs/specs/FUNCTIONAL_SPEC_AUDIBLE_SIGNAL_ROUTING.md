# 有聲號誌無障礙路徑規劃（視障優先）

## Functional Specification — Audible Pedestrian Signal Routing

**版本**：v1.0.0  
**狀態**：Proposed — 尚未實作  
**日期**：2026-06-17  
**作者**：yuzen9622

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [外部資料來源（TDX CityAPS）](#4-外部資料來源tdx-cityaps)
5. [資料模型](#5-資料模型)
6. [資料匯入 Pipeline](#6-資料匯入-pipeline)
7. [路徑規劃整合（post 層評分）](#7-路徑規劃整合post-層評分)
8. [API 影響](#8-api-影響)
9. [實作 Roadmap](#9-實作-roadmap)
10. [測試策略](#10-測試策略)
11. [新增環境變數](#11-新增環境變數)
12. [前端職責邊界](#12-前端職責邊界)
13. [風險與緩解](#13-風險與緩解)

---

## 1. 系統概述

本功能規格書描述「有聲號誌無障礙路徑規劃」功能，目標是在現有路徑規劃系統中落地 **視障優先（visual_impaired）模式的語音號誌偏好**，讓 `mode=visual_impaired` 的路徑結果優先引導使用者行走設有有聲號誌（Accessible Pedestrian Signal，APS）的路口。

### 1.1 背景與現況

`A11Y_SCORING_REWORK.md §2.3` 已確認：OTP2 路由引擎僅支援 `wheelchair` 一個無障礙維度，**沒有導盲磚或語音號誌的概念**，因此 `elderly` / `visual_impaired` 模式的差異化邏輯 **100% 在 post 層完成**。

`scoring.ts` 中的 `MODE_PROFILES.visual_impaired` 已定義 `audioSignal` 權重為 **25**（全模式最高），`tactilePaving` 權重為 **30**。然而目前評分邏輯中，`hasAudioSignal` 的判斷來自 OsmA11y 節點的 `traffic_signals:sound = yes` tag，覆蓋率極為稀疏（現有 `OsmA11y` collection 主要為電梯、坡道類設施）。

本功能透過引入 TDX **CityAPS 有聲號誌靜態 API** 的完整路口資料，建立 `ApsSignal` 模型並預先匯入資料庫，再在 post 層的路段標註流程中查詢附近路口、給予 `visual_impaired` 模式的評分加成，實現語音號誌偏好的真實落地。

### 1.2 功能定位

| 組件                   | 本功能角色                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| OTP2 sidecar           | 不異動。重型 journey planning 維持現狀                            |
| ORS                    | 不異動。步行 / 輪椅路段引擎                                       |
| `scoring.ts`           | 新增 `apsSignalBonus` 計算邏輯（post 層）                         |
| `ApsSignal` collection | 新增。儲存全台有聲號誌路口，2dsphere 索引                         |
| `import-aps.ts`        | 新增。逐縣市呼叫 TDX CityAPS，bulkWrite upsert                    |
| `route-a11y.ts`        | 擴充 `enrichTopRoutes`：`visual_impaired` 模式額外做 APS geo 查詢 |

---

## 2. 系統目標

### 2.1 核心能力

- 當 `mode=visual_impaired` 時，路徑評分中的 `audioSignal` 分項能反映真實的 TDX APS 資料，而非僅依賴稀疏的 OSM tag
- `WalkLeg.accessibilityHighlights` 能顯示「本路段行經有聲號誌路口 N 處」
- 路線評分結果使行經多個有聲號誌路口的路段獲得明顯更高分，在排序中實際影響候選路線排名

### 2.2 非功能目標

| 目標               | 說明                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| 不改動路由引擎     | 全部邏輯在 post 層，不動 OTP2 / ORS                                             |
| 靜態資料預先匯入   | CityAPS 為靜態 API，不在 query 時即時呼叫 TDX，避免觸發 429                     |
| 向後相容           | 新增欄位均為 optional，不破壞現有 `wheelchair` / `normal` 路線回應              |
| 與評分引擎架構對齊 | 遵循 `A11Y_SCORING_REWORK.md` 的兩段式排序（prerank → enrich top-N → re-score） |

---

## 3. 系統架構

### 3.1 整體流程

```
client POST /api/v1/a11y/accessible-route  { mode: "visual_impaired", ... }
      ↓
[OTP2 sidecar] Journey Planning（不改動）
      ↓
[Post 層 — finalizeRoutes]
  ├─ Stage 1: prerankByProxy（time + transfer + walk penalty，不需 DB）→ top-8
  ├─ Stage 2: enrichTopRoutes
  │    ├─ enrichWalkLegsWithOsmA11y（現有邏輯）
  │    ├─ enrichWalkLegsWithApsSignals（新增，僅 mode=visual_impaired）← 本功能
  │    └─ overlayFacilityStatus（TDX 即時電梯故障）
  └─ Stage 3: scoreAndRank（scoring.ts：含 audioSignal criticalWeight 25）→ top-3
      ↓
ApiResponse<AccessibleRouteData>
```

### 3.2 APS 資料查詢位置

`enrichWalkLegsWithApsSignals` 運作在 **Stage 2 enrich** 內，在 `scoreRoute` 重算之前完成，確保語音號誌資訊能被計入最終分數（對應 `A11Y_SCORING_REWORK.md §P1` 兩段式排序的設計意圖）。

### 3.3 檔案結構（新增 / 修改）

```
src/
├── model/
│   └── aps-signal.model.ts          ← 新增：ApsSignal MongoDB 模型
├── scripts/
│   └── import-aps.ts                ← 新增：TDX CityAPS 匯入腳本
└── modules/accessible-route/
    ├── planners/
    │   └── route-a11y.ts            ← 修改：新增 enrichWalkLegsWithApsSignals()
    └── scoring.ts                   ← 修改：新增 apsSignalBonus 計算（audioSignal 加成）
```

---

## 4. 外部資料來源（TDX CityAPS）

### 4.1 API 概覽

| 項目       | 值                                            |
| ---------- | --------------------------------------------- |
| 資料集名稱 | CityAPS — 無障礙號誌（有聲號誌）              |
| API 類型   | RESTful 靜態 JSON                             |
| 認證       | TDX OAuth2（現有 `TdxTokenManger` singleton） |
| 呼叫方式   | 現有 `tdxFetch()`（`src/config/fetch.ts`）    |
| 更新頻率   | 靜態，每月或按縣市公告更新                    |
| 分縣市     | 是。需逐縣市查詢                              |

### 4.2 端點與查詢模式

```
GET https://tdx.transportdata.tw/api/basic/v2/Accessible/City/{City}/APS
    ?%24format=JSON
    &%24top=500
    &%24skip=0
```

- `{City}` 為縣市英文代碼，例如 `Taipei`、`NewTaipei`、`Taichung`
- 支援 `$top` / `$skip` 分頁，每次最多 500 筆
- 無 Webhook；須輪詢更新

### 4.3 支援縣市清單（⚠️ 待確認）

以下為初步列表，實際可用縣市須在匯入前透過 TDX API 驗證回傳非空：

```
Taipei / NewTaipei / Taichung / Tainan / Kaohsiung
Taoyuan / Keelung / Hsinchu / HsinchuCounty / MiaoliCounty
ChanghuaCounty / NantouCounty / YunlinCounty / ChiayiCounty
Chiayi / PingtungCounty / YilanCounty / HualienCounty
TaitungCounty / KinmenCounty / PenghuCounty / LienchiangCounty
```

### 4.4 回應欄位對應

TDX CityAPS API 回傳的欄位依縣市可能略有差異，以下為常見可用欄位（⚠️ 部分欄位待以實際 API 回應驗證）：

| TDX 欄位           | 說明                                  | 對應 ApsSignal 欄位       |
| ------------------ | ------------------------------------- | ------------------------- |
| `IntersectionID`   | 路口識別碼                            | `intersectionId`          |
| `IntersectionName` | 路口名稱（如「忠孝東路/敦化南路口」） | `intersectionName`        |
| `PositionLon`      | 經度                                  | `location.coordinates[0]` |
| `PositionLat`      | 緯度                                  | `location.coordinates[1]` |
| `HasAudibleSignal` | 是否具有語音提示                      | `hasAudibleSignal`        |
| `HasTactilePaving` | 是否具有觸覺引導設施                  | `hasTactilePaving`        |
| `CityCode`         | 縣市代碼                              | `cityCode`                |
| `Direction`        | 可服務方向描述（若提供）              | `direction`               |
| `UpdateTime`       | 資料更新時間                          | `updatedAt`（匯入時覆寫） |

> ⚠️ 待確認：`HasTactilePaving` 是否為所有縣市均有的欄位；部分縣市可能僅提供 `HasAudibleSignal`。

### 4.5 TDX 配額注意事項

依 `tdx-quota-and-data-drift.md` 已知限制：**burst 4–6 次呼叫即可觸發 429**。CityAPS 為靜態資料，**嚴禁在 query 時即時呼叫**；所有資料必須透過 `import-aps.ts` 預先匯入資料庫，路徑規劃流程完全走 MongoDB 本地查詢。

---

## 5. 資料模型

### 5.1 ApsSignal（`src/model/aps-signal.model.ts`）

```typescript
import { Schema, model, Document } from "mongoose";

export interface IApsSignal extends Document {
  intersectionId: string; // TDX IntersectionID，全台唯一鍵
  intersectionName: string; // 路口名稱
  cityCode: string; // 縣市代碼，例如 "Taipei"
  location: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
  hasAudibleSignal: boolean; // 是否具有語音提示
  hasTactilePaving: boolean; // 是否具有觸覺引導設施（⚠️ 待確認欄位覆蓋率）
  direction?: string; // 可服務方向描述（若 API 提供）
  updatedAt: Date; // 匯入時間
}

const ApsSignalSchema = new Schema<IApsSignal>({
  intersectionId: { type: String, required: true, unique: true },
  intersectionName: { type: String, required: true },
  cityCode: { type: String, required: true, index: true },
  location: {
    type: { type: String, enum: ["Point"], required: true },
    coordinates: { type: [Number], required: true },
  },
  hasAudibleSignal: { type: Boolean, required: true, default: false },
  hasTactilePaving: { type: Boolean, required: true, default: false },
  direction: { type: String },
  updatedAt: { type: Date, required: true },
});

// 2dsphere 地理索引，供 $near 查詢
ApsSignalSchema.index({ location: "2dsphere" });
// 複合索引：依縣市快速過濾
ApsSignalSchema.index({ cityCode: 1, hasAudibleSignal: 1 });

export const ApsSignalModel = model<IApsSignal>("ApsSignal", ApsSignalSchema);
```

**Index 設計說明**

| 索引                             | 用途                                 |
| -------------------------------- | ------------------------------------ |
| `location` (2dsphere)            | walk leg 路段附近路口查詢（`$near`） |
| `intersectionId` (unique)        | bulkWrite upsert 唯一鍵              |
| `{ cityCode, hasAudibleSignal }` | 未來縣市層級統計或管理查詢           |

---

## 6. 資料匯入 Pipeline

### 6.1 腳本設計（`src/scripts/import-aps.ts`）

比照現有 `import-gtfs-stops.ts` 的串流 + bulkWrite 模式，但由於 CityAPS 為 HTTP API（非本地 CSV），改為 HTTP 分頁拉取。

**執行指令**

```bash
npx ts-node src/scripts/import-aps.ts
```

### 6.2 匯入流程

```
1. 讀取 SUPPORTED_CITIES 清單（環境變數 APS_CITIES 可覆寫，見 §11）
2. for each city in cities:
   a. 以 tdxFetch() 呼叫 CityAPS API（$top=500, $skip=0）
   b. 若回應 429 → 等待 THROTTLE_DELAY_MS（預設 2000ms），重試一次
   c. 若資料筆數 = 500 → 繼續 $skip += 500 直到回傳 < 500 筆（分頁完畢）
   d. 組裝 ApsSignal 文件，bulkWrite upsert（以 intersectionId 為唯一鍵）
   e. 記錄：縣市名稱 / 筆數 / 耗時 / 錯誤數
3. 全部縣市完成後，輸出總覽：總筆數 / 總耗時
```

### 6.3 節流策略

| 參數           | 預設值             | 說明                               |
| -------------- | ------------------ | ---------------------------------- |
| 縣市間延遲     | 1500 ms            | 每個縣市呼叫完成後等待，避免 burst |
| 429 退避       | 2000 ms + 重試一次 | 單次限流時的退避                   |
| 分頁大小       | 500                | TDX 建議最大值                     |
| 批次 bulkWrite | 500 筆             | 與分頁對齊                         |

> 因 CityAPS 為靜態資料，匯入腳本**不在應用程式啟動時自動執行**，須由運維人員手動或排程觸發（見 §9 Roadmap）。

### 6.4 更新策略

| 頻率     | 動作                                             |
| -------- | ------------------------------------------------ |
| 每月     | 執行 `import-aps.ts`，以 upsert 更新所有縣市資料 |
| 縣市新增 | 修改 `APS_CITIES` 環境變數後重新執行腳本         |
| 緊急修正 | 直接對 MongoDB `ApsSignal` 集合執行修補          |

### 6.5 預估資料規模（⚠️ 待確認）

依公開資料估算，全台有聲號誌路口約數千處，匯入後 `ApsSignal` 集合預計 **5,000–20,000 筆**（遠小於 OsmA11y），對 MongoDB 儲存與查詢不構成效能疑慮。

---

## 7. 路徑規劃整合（post 層評分）

### 7.1 架構定位聲明

本節所有邏輯均在 **post 層（Stage 2 enrich）** 完成，完全不修改 OTP2 路由引擎或 ORS 呼叫流程。這是依據 `A11Y_SCORING_REWORK.md §2.3` 的硬限制：OTP 結構上無法表達導盲磚 / 語音號誌的概念。

### 7.2 觸發條件

`enrichWalkLegsWithApsSignals` 僅在以下條件成立時執行：

```typescript
if (mode === "visual_impaired") {
  await enrichWalkLegsWithApsSignals(route.legs, APS_ENRICH_RADIUS_M);
}
```

`wheelchair` / `elderly` / `normal` 模式不觸發，避免不必要的 MongoDB 查詢。

### 7.3 新增函式：`enrichWalkLegsWithApsSignals`

**位置**：`src/modules/accessible-route/planners/route-a11y.ts`

```typescript
/**
 * 對路線中的 WalkLeg 查詢附近有聲號誌路口，並寫入標註。
 * 僅供 visual_impaired 模式的 Stage 2 enrich 呼叫。
 *
 * @param legs    路線的所有路段（僅處理 type=WALK 的路段）
 * @param radiusM 查詢半徑（公尺），預設 APS_ENRICH_RADIUS_M 環境變數或 40m
 */
export async function enrichWalkLegsWithApsSignals(
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[],
  radiusM: number = 40,
): Promise<void>;
```

**查詢邏輯**

每個 `WalkLeg` 帶有 `polyline`（Google Encoded Polyline），函式需：

1. 解碼 polyline 取出路段點序列
2. 對路段起點與終點各做一次 `ApsSignal.$near` 查詢（半徑 `radiusM`，僅回傳 `hasAudibleSignal=true` 的路口）
3. 以 `intersectionId` 去重，避免同一路口被起終點雙重計入
4. 結果寫入 `WalkLeg.apsSignals`（新增欄位，見 §8.2）
5. 若有查詢結果，於 `WalkLeg.accessibilityHighlights` 附加提示字串（見 §8.3）

**MongoDB 查詢範例**

```typescript
const nearbySignals = await ApsSignalModel.find({
  location: {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  },
  hasAudibleSignal: true,
})
  .select("intersectionId intersectionName location hasTactilePaving")
  .lean();
```

### 7.4 評分加成機制

`scoring.ts` 中 `scoreRoute()` 計算 `criticalFeatureScore` 時，`hasAudioSignal` 目前依賴 OsmA11y 節點的 `traffic_signals:sound = yes` tag（`scoring.ts:563–564`）。本功能需在同一判斷點補強：

**修改邏輯（`scoring.ts`）**

```typescript
// 現有：僅讀 OsmA11y tag
const hasAudioSignal = facilityNodes.some(
  (n) => n.tags?.["traffic_signals:sound"] === "yes",
);

// 修改後：OsmA11y tag OR ApsSignal 查詢結果（任一成立即為 true）
const hasAudioSignal =
  facilityNodes.some((n) => n.tags?.["traffic_signals:sound"] === "yes") ||
  (walkLeg.apsSignals != null && walkLeg.apsSignals.length > 0);
```

`mode=visual_impaired` 的 `criticalWeights.audioSignal = 25`（`MODE_PROFILES` 現有設定），加成邏輯無需另外修改。

### 7.5 觸覺引導協同加成

若 APS 路口同時具備 `hasTactilePaving=true`，可對 `hasTactilePaving` 標記一併補強：

```typescript
const hasTactilePaving =
  facilityNodes.some((n) => n.tags?.["tactile_paving"] === "yes") ||
  (walkLeg.apsSignals?.some((s) => s.hasTactilePaving) ?? false);
```

`mode=visual_impaired` 的 `criticalWeights.tactilePaving = 30`，兩者同時成立時，視障模式最高可增加 55 分的 criticalFeature 加成（25 + 30），大幅拉開與無語音號誌路線的分數差距。

### 7.6 `accessibilityHighlights` 文字生成

當 `walkLeg.apsSignals` 非空時，在 `enrichTopRoutes` 完成後，以現有 `facilityHighlights` 的字串陣列格式附加文字：

```typescript
if (walkLeg.apsSignals && walkLeg.apsSignals.length > 0) {
  const count = walkLeg.apsSignals.length;
  walkLeg.accessibilityHighlights = [
    ...(walkLeg.accessibilityHighlights ?? []),
    `本路段行經有聲號誌路口 ${count} 處`,
  ];
  // 若同時有觸覺引導
  if (walkLeg.apsSignals.some((s) => s.hasTactilePaving)) {
    walkLeg.accessibilityHighlights.push("本路段設有觸覺引導設施");
  }
}
```

### 7.7 評分流程圖（Stage 2 修改後）

```
Stage 2: enrichTopRoutes（mode=visual_impaired）
  ├─ enrichWalkLegsWithOsmA11y()        ← 現有，不改
  ├─ enrichWalkLegsWithApsSignals()     ← 新增（本功能）
  │    ├─ for each WalkLeg
  │    │    ├─ decode polyline → [起點, 終點]
  │    │    ├─ ApsSignal.$near(起點, radiusM, hasAudibleSignal=true)
  │    │    ├─ ApsSignal.$near(終點, radiusM, hasAudibleSignal=true)
  │    │    ├─ 去重（by intersectionId）
  │    │    └─ 寫入 leg.apsSignals + leg.accessibilityHighlights
  │    └─ 完成
  └─ overlayFacilityStatus()            ← 現有，不改

Stage 3: scoreRoute()（有 apsSignals 資料後重算）
  └─ criticalFeatureScore 中 audioSignal（25） + tactilePaving（30） 生效
```

---

## 8. API 影響

### 8.1 端點

本功能**不新增端點**。所有修改在現有端點的回應 schema 中體現：

| Method | Path                            | 影響說明                                     |
| ------ | ------------------------------- | -------------------------------------------- |
| `POST` | `/api/v1/a11y/accessible-route` | `WalkLeg` 新增 `apsSignals` 欄位（optional） |

### 8.2 WalkLeg 新增欄位

`WalkLeg`（`src/types/route.ts` 或相應型別定義）新增如下 optional 欄位，保持向後相容：

```typescript
type WalkLeg = {
  // ... 現有欄位不變 ...
  type: "WALK";
  from: string;
  to: string;
  distanceM: number;
  minutesEst: number;
  polyline: string;
  a11yFacilities: OsmA11yFeature[];
  exitInfo?: A11yExit;
  accessibilityHighlights?: string[]; // 現有（補充型別定義）

  // 新增（optional，不影響現有呼叫端）
  apsSignals?: ApsSignalSummary[];
};

// 新增輔助型別（輕量，不回傳完整 IApsSignal document）
type ApsSignalSummary = {
  intersectionId: string;
  intersectionName: string;
  lat: number;
  lng: number;
  hasTactilePaving: boolean;
};
```

### 8.3 回應範例（mode=visual_impaired，有 APS 資料）

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 3 條無障礙路線",
  "data": {
    "routes": [
      {
        "routeId": "route_0",
        "routeName": "捷運直達（推薦）",
        "totalMinutes": 38,
        "transferCount": 0,
        "legs": [
          {
            "type": "WALK",
            "from": "起點",
            "to": "忠孝復興站",
            "distanceM": 320,
            "minutesEst": 5,
            "polyline": "...",
            "a11yFacilities": [],
            "accessibilityHighlights": [
              "本路段行經有聲號誌路口 2 處",
              "本路段設有觸覺引導設施"
            ],
            "apsSignals": [
              {
                "intersectionId": "APS-TPE-001234",
                "intersectionName": "忠孝東路四段/復興南路口",
                "lat": 25.0417,
                "lng": 121.5443,
                "hasTactilePaving": true
              },
              {
                "intersectionId": "APS-TPE-001235",
                "intersectionName": "忠孝東路四段/大安路口",
                "lat": 25.0412,
                "lng": 121.546,
                "hasTactilePaving": false
              }
            ]
          }
        ],
        "accessibilityHighlights": ["有聲號誌路口 2 處", "觸覺引導設施"],
        "accessibilityScore": 82,
        "accessibilityLabel": "good",
        "scoreComponents": {
          "totalScore": 82,
          "label": "good",
          "dataConfidence": "medium",
          "scoreWarnings": [],
          "components": {
            "facilityScore": 40,
            "timeScore": 78,
            "criticalFeatureScore": 55,
            "walkPenalty": 2
          }
        },
        "source": ["ORS", "TDX", "A11Y_ENGINE"]
      }
    ]
  }
}
```

### 8.4 OpenAPI schema 更新

`src/openapi/document.ts` 中的 `WalkLeg` schema 需補充 `apsSignals` 欄位定義（optional array）。現有 `AccessibleRoute` 的 `source` 陣列可考慮新增 `"APS"` 標記，以識別回應中包含了 APS 資料（⚠️ 待確認是否有必要）。

### 8.5 錯誤處理

| 情境                                  | 行為                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `ApsSignal` collection 為空（未匯入） | `apsSignals = []`，評分不加成，回傳仍正常（不報錯）          |
| MongoDB `$near` 查詢逾時              | fail-soft：`apsSignals = []`，記 warning log，不影響路線回傳 |
| mode 非 `visual_impaired`             | 直接略過 `enrichWalkLegsWithApsSignals`，效能零影響          |

---

## 9. 實作 Roadmap

| 階段        | 任務                                                                              | 依賴             |
| ----------- | --------------------------------------------------------------------------------- | ---------------- |
| **Phase A** | 建立 `ApsSignalModel`（`aps-signal.model.ts`），含 2dsphere index                 | 無               |
| **Phase A** | 撰寫 `import-aps.ts`，實作逐縣市拉取 + 節流 + bulkWrite upsert                    | Phase A 模型     |
| **Phase A** | 手動執行匯入腳本，驗證至少台北市資料正確入庫                                      | Phase A 腳本     |
| **Phase B** | 在 `route-a11y.ts` 新增 `enrichWalkLegsWithApsSignals()`                          | Phase A 入庫     |
| **Phase B** | 修改 `scoring.ts`：`hasAudioSignal` / `hasTactilePaving` 加入 APS 來源            | Phase B enrich   |
| **Phase B** | 修改 `accessible-route.service.ts`：`finalizeRoutes` Stage 2 加入 APS enrich 呼叫 | Phase B 函式     |
| **Phase C** | 補充型別定義：`WalkLeg.apsSignals`、`ApsSignalSummary`                            | Phase B          |
| **Phase C** | 更新 OpenAPI schema（`document.ts`）                                              | Phase C 型別     |
| **Phase C** | 撰寫單元測試（見 §10）                                                            | Phase B          |
| **Phase D** | 設定定期匯入排程（cron 或 CI/CD job），更新策略文件                               | Phase A + DevOps |

---

## 10. 測試策略

### 10.1 單元測試（純函數）

比照 `scoring.test.ts` 的現有模式，對以下純函數撰寫 vitest 單元測試：

**`scoring.ts`：`scoreRoute()` APS 加成驗證**

```typescript
describe("scoreRoute — visual_impaired APS 加成", () => {
  it("有 APS 路口的路段，audioSignal 應計入 criticalFeatureScore（+25）", () => {
    // 測試 WalkLeg 帶有 apsSignals: [{ hasTactilePaving: false }] 時
    // criticalFeatureScore 應包含 audioSignal 加成
  });

  it("有 APS 且有觸覺引導，應同時計入 audioSignal(+25) + tactilePaving(+30)", () => {
    // 測試 apsSignals: [{ hasTactilePaving: true }]
  });

  it("wheelchair 模式下，apsSignals 不為空也不應觸發 audioSignal(25) 的高分加成", () => {
    // wheelchair criticalWeights.audioSignal = 4，非 25
  });

  it("ApsSignal collection 為空時，score 應退回 OsmA11y 純邏輯（向後相容）", () => {
    // apsSignals = undefined，行為與舊版一致
  });
});
```

**`route-a11y.ts`：`enrichWalkLegsWithApsSignals()` 去重邏輯**

```typescript
describe("enrichWalkLegsWithApsSignals", () => {
  it("起點與終點查詢結果重複的路口，以 intersectionId 去重後只計一次", () => {
    /* ... */
  });
  it("非 visual_impaired 模式不應觸發此函式", () => {
    /* ... */
  });
});
```

### 10.2 整合驗收條件

| 條件                                         | 預期結果                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `mode=visual_impaired`，路線行經有聲號誌路口 | `WalkLeg.apsSignals` 非空，`accessibilityHighlights` 含「有聲號誌路口 N 處」 |
| 有 APS 路線 vs 無 APS 路線排名               | 有 APS 路線 `accessibilityScore` 應明顯高於無 APS 路線（差距 > 10）          |
| `mode=wheelchair` 請求                       | `WalkLeg.apsSignals` 不出現（undefined），現有行為不受影響                   |
| `ApsSignal` collection 為空時查詢            | 正常回傳路線，`apsSignals` 欄位缺席，log 無 error                            |
| `dataConfidence`                             | 有 APS 資料的路段因補強了 criticalFeature，`dataConfidence` 相應提升         |

### 10.3 測試資料前置條件

單元測試應 mock `ApsSignalModel.find()`，不依賴 MongoDB 連線（比照現有 `scoring.test.ts` 的純函數測試方式）。

---

## 11. 新增環境變數

| 變數名稱                | 預設值               | 說明                                                            |
| ----------------------- | -------------------- | --------------------------------------------------------------- |
| `APS_CITIES`            | （見 §4.3 完整清單） | 逗號分隔的縣市代碼清單，供 `import-aps.ts` 使用；可覆寫預設清單 |
| `APS_ENRICH_RADIUS_M`   | `40`                 | APS 路口查詢半徑（公尺）；值越大覆蓋越廣但可能引入不相關路口    |
| `APS_THROTTLE_DELAY_MS` | `1500`               | `import-aps.ts` 各縣市間的節流延遲（毫秒）                      |

以上三個變數**僅影響匯入腳本與 post 層查詢半徑**，不影響路由引擎。須加入 `.env.example`。

---

## 12. 前端職責邊界

本規格書僅涵蓋後端職責。以下為**前端負責**的對應工作，列出供介面對齊：

| 前端任務                       | 說明                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 地圖標記渲染                   | 讀取 `WalkLeg.apsSignals` 陣列，於地圖上以特殊圖示標示有聲號誌路口位置                                   |
| 路口語音提示                   | 當使用者接近 `apsSignals` 中的路口座標時，觸發語音提示（前端邏輯，後端不介入）                           |
| `accessibilityHighlights` 顯示 | 在路線卡片顯示「本路段行經有聲號誌路口 N 處」等文字                                                      |
| APS 路口詳情頁                 | 若需顯示 `intersectionName` / `direction` 等細節，直接使用後端 `apsSignals` 回傳資料，**不另開後端 API** |

---

## 13. 風險與緩解

| 風險                                 | 說明                                                                                       | 緩解方式                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **TDX CityAPS 縣市覆蓋不完整**       | 部分縣市 API 可能回傳空資料或 404                                                          | `import-aps.ts` 對每個縣市獨立錯誤處理，空回傳記 warning 而非中斷整體匯入                                                 |
| **TDX 429 限流**                     | 逐縣市拉取 23 個縣市仍有可能觸發                                                           | 縣市間固定延遲 1500ms + 429 退避 2000ms；靜態資料離線匯入，不影響 query 流程                                              |
| **APS 欄位結構差異**                 | 不同縣市的 API 回應欄位可能有差異                                                          | 匯入時對缺失欄位給預設值（`hasAudibleSignal: false`），記欄位缺失 warning                                                 |
| **查詢半徑設定不當**                 | 半徑過小（< 20m）導致大量路口未被匹配；過大（> 100m）納入不相關路口影響評分                | 以 `APS_ENRICH_RADIUS_M=40` 為初始值，並記錄匹配筆數於 debug log，供調校參考                                              |
| **polyline 解碼效能**                | 長路段 polyline 解碼後點數過多，若對每個點都查詢 DB 效能差                                 | 僅對路段起點與終點各查詢一次（非每個中間節點），並以 `intersectionId` 去重                                                |
| **OsmA11y 與 APS 重複計算**          | 同一路口可能同時存在於 OsmA11y tag 與 ApsSignal collection，導致 `hasAudioSignal` 重複觸發 | `hasAudioSignal` 為布林值（any-of 判斷），重複來源不影響最終評分結果                                                      |
| **APS 資料時效性**                   | TDX CityAPS 為靜態 API，實際路口狀況可能與資料有落差                                       | 每月定期重新匯入；於 `WalkLeg.accessibilityHighlights` 文字中使用「設有有聲號誌路口」而非「有聲號誌運作中」，降低誤導風險 |
| **`dataConfidence` 不反映 APS 來源** | APS 加成提升了分數，但 `dataConfidence` 目前依 OsmA11y leg 覆蓋率計算，可能低估信心度      | ⚠️ 待確認：評估是否需將 APS 匹配數納入 `dataCoverageRatio` 計算，或以另一欄位 `apsEnriched: boolean` 示意                 |

---

_本文件狀態為 Proposed — 尚未實作。實作時如發現 TDX CityAPS 實際欄位與 §4.4 有差異，請於此文件標註並更新 §5.1 資料模型。_
