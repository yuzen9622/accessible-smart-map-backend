# 使用者路況回報系統

## Functional Specification — Hazard Report

**版本**：v1.2.1  
**狀態**：Implemented — 已實作（2026-06-19）  
**日期**：2026-06-19  
**作者**：yuzen9622

> v1.1.0 修訂：①回報強制登入、`reporterId` 必填；②到期不物理刪除，保留歷史；③新增「查看我的回報」端點；④移除街景／衛星參考影像比對（圖資老舊無法比對即時障礙），AI 改為 Cloud Vision 預篩 + Gemini 單圖語意判斷。  
> v1.2.0 修訂：⑤架構對齊現有 clean-backend-architecture——feature 收斂為 `src/modules/hazard-report/`（router/controller/service/ai-verify/parse/schema/type/index），外部 I/O 進 `src/adapters/*.adapter.ts`，移除規格中不存在的 `src/service/`、`src/routes/` 路徑；錯誤以 `ResponseCode` enum 標 HTTP 狀態、領域 reason 放 `data.reason`；auth middleware 改注入 `req.auth`。  
> v1.2.1 修訂（as-built，已實作）：S1–S6 全數完成，`tsc --noEmit` 乾淨、vitest 63 passed、`npm run build` 綠燈、app 可掛載 5 條路由。實作相對本文的調整：① 型別檔採 `.types.ts`（對齊 repo 2026-06-19 reorg 慣例），`IHazardReport`/`HazardType`/`AiVerdict`/`HazardStatus` 放 `src/types/index.d.ts`，模組內 DTO 放 `hazard-report.types.ts`；② 新增 `hazard-report.middleware.ts`（multer 記憶體上傳 + express-rate-limit）與 `hazard-report.expire.ts`（過期掃描），Haversine 放 `src/utils/geo.ts`；③ 過期以 in-process `setInterval`（`server.ts`，unref）+ `npm run hazard:expire` 腳本實作；④ `constants/messages.ts` 同時提供 `HAZARD_REASON` 與 `HAZARD_MSG`；⑤ GCS `photoUrl` 採 `storage.googleapis.com/<bucket>/<path>` public-read（bucket 需開放公開讀取，否則改 signed URL）；⑥ EXIF UTC 時區問題（§6.3 待確認）尚未解，目前以 ±10 分鐘 clock skew 容忍。未 commit。

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [資料模型](#4-資料模型)
5. [API 規格](#5-api-規格)
6. [外部服務整合](#6-外部服務整合)
7. [照片儲存策略](#7-照片儲存策略)
8. [濫用防護](#8-濫用防護)
9. [實作 Roadmap](#9-實作-roadmap)
10. [測試策略](#10-測試策略)
11. [新增環境變數](#11-新增環境變數)
12. [新增 npm 依賴](#12-新增-npm-依賴)
13. [前端職責邊界](#13-前端職責邊界)
14. [風險與緩解](#14-風險與緩解)

---

## 1. 系統概述

使用者路況回報系統讓**已登入**使用者以即時相機拍照，向系統回報在無障礙移動途中所遭遇的實際障礙——包含障礙物、施工圍籬、資料錯誤等類型。後端接收回報後依序執行：登入驗證、地理柵欄驗證、影像 EXIF 時間與 GPS 真實性驗證、AI 影像辨識（Google Cloud Vision 物件／SafeSearch 預篩 + Gemini 單圖語意判斷），並將回報持久化至 MongoDB，同時開放附近查詢與「我的回報」端點供前端地圖疊加顯示。回報到期後不物理刪除，僅標記為 `expired` 以保留歷史紀錄。

系統架構沿用專案既有的 Express + TypeScript + MongoDB(Mongoose) + Redis 技術棧，所有端點統一以 `sendResponse()`（`src/config/lib.ts`）包裝回應，Zod 負責請求驗證。

---

## 2. 系統目標

### 2.1 核心能力

- 限**已登入**使用者提交含照片的即時路況回報，並在後端驗證回報可信度（回報綁定 `reporterId`）
- 20 公尺地理柵欄：拒絕距回報地點超過 20m 的請求
- 影像真實性驗證：EXIF 時間新鮮度、EXIF GPS 與宣稱座標一致性
- AI 影像辨識（兩階段）：Google Cloud Vision 物件偵測／SafeSearch 預篩擋掉不雅或無關圖，再以 Gemini 單圖語意判斷照片是否合理呈現所宣稱的障礙
- 附近回報查詢：以 MongoDB `$near` 提供地理範圍查詢
- 我的回報查詢：登入使用者可依 `reporterId` 檢視自己的回報紀錄（含已過期）
- 社群二次確認：其他使用者可確認或否認既有回報以提升可信度
- 過期保留歷史：回報到期後標記為 `expired` 而非刪除，從預設查詢結果排除但保留供統計與人工複核

### 2.2 非功能目標

| 目標              | 說明                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| 後端統一驗證      | 登入、地理柵欄與 EXIF 驗證皆在後端執行，前端無法繞過                                                               |
| AI 僅作第一道過濾 | Cloud Vision 預篩 + Gemini 語意判斷為輔助篩選，verdict 記錄但不強制擋，`rejected` 狀態需人工複核流程（本期未納入） |
| Fail-soft AI      | Cloud Vision 或 Gemini 呼叫失敗時回報降級為 `pending`，不阻擋回報提交                                              |
| 資料時效性        | 路況回報具時效，到期由定時任務設為 `expired`，文件保留供歷史查詢，不物理刪除                                       |
| 路徑規劃暫不整合  | 本期回報僅供前端顯示，與路徑評分的整合列為未來選項（見 §9）                                                        |

---

## 3. 系統架構

### 3.1 請求流程

單一方向流經各層，依賴只往內/往前指；router 不直接呼叫 service，service 不碰 `req`/`res`。

```
Client Request
      ↓
Express 入口 (src/app.ts) — 單一前綴 /api/v1；app.use("/api/v1/a11y", createHazardReportRouter())
      ↓
[僅 POST /reports、GET /reports/mine]
Auth Middleware (src/middleware/middleware.ts) — 驗 JWT、注入 req.auth = { userId, user }；失敗 401/403
      ↓
[僅 POST /reports] Multer — multipart/form-data → req.file（照片 buffer）
      ↓
validateRequest(schema) (src/middleware/validate-request.middleware.ts) — Zod 驗 body/query/params → req.validated
      ↓
Controller (modules/hazard-report/hazard-report.controller.ts)  ← 薄層
  讀 req.auth / req.validated / req.file → 呼叫「單一」service 方法 → sendResponse() 包成 envelope
      ↓
Service (hazard-report.service.ts)  ← 純業務，無 req/res
  ├─ Geo fence（Haversine 20m）              → utils/geo
  ├─ EXIF 驗證（timestamp / GPS）            → hazard-report.parse.ts（exifr 原始值 → domain）
  ├─ 去重合併查詢 / 持久化                    → model
  ├─ 上傳照片                                → adapters/gcs.adapter.ts
  └─ 非同步觸發 AI 辨識（hazard-report.ai-verify.ts）
        ├─ 階段一 Cloud Vision 預篩          → adapters/vision.adapter.ts
        └─ 階段二 Gemini 單圖判斷            → adapters/ai-vision.adapter.ts（沿用既有 AI client）
      ↓
Model (src/model/hazard-report.model.ts) — Mongoose
      ↓
sendResponse(res, ok, status, ResponseCode.*, message, data?) → ApiResponse<T>
```

### 3.2 模組目錄結構

> 對齊本專案現有 clean-backend-architecture（`src/modules/<feature>/` + `src/adapters/` + `src/constants/` + `src/openapi/`）。本專案**已無** `src/routes/`、`src/controller/`、`src/service/` 目錄——外部 I/O 一律放 `src/adapters/*.adapter.ts`，feature 全收斂在模組內。

```
src/
├── app.ts                              # 單一掛載點：app.use("/api/v1/a11y", createHazardReportRouter())
├── modules/
│   └── hazard-report/
│       ├── index.ts                    # 唯一註冊點：export { createHazardReportRouter }
│       ├── hazard-report.router.ts     # transport：path+method、串 auth/multer/validate、委派 controller
│       ├── hazard-report.schema.ts     # validation：Zod body/query/params（邊界驗證，註冊到 openapi）
│       ├── hazard-report.controller.ts # handler：讀 req.auth/validated/file → 呼叫單一 service → sendResponse
│       ├── hazard-report.service.ts    # domain：業務協調（geo fence / 去重 / 持久化 / 觸發 AI），無 req/res
│       ├── hazard-report.ai-verify.ts  # domain：非同步 AI 辨識協調（呼叫 vision/ai-vision adapter）
│       ├── hazard-report.parse.ts      # I/O mapping：exifr 原始值→exifValidation；Gemini text→AiVerifyResult
│       ├── hazard-report.middleware.ts # transport：multer 記憶體上傳 + express-rate-limit 限流器
│       ├── hazard-report.expire.ts     # domain：過期掃描（updateMany 標記 expired，不刪除）
│       └── hazard-report.types.ts      # types：模組內 DTO（CreateReportInput / ServiceResult / AiVerifyResult 等）
├── adapters/                           # I/O（每檔一個外部來源；沿用 google.adapter.ts / tdx.adapter.ts 慣例）
│   ├── gcs.adapter.ts                  # 新增：GCS 上傳/刪除
│   ├── vision.adapter.ts              # 新增：Cloud Vision label/object/SafeSearch
│   └── ai-vision.adapter.ts          # 新增（或併入既有 ai 模組 client）：Gemini 多模態單圖判斷
├── model/
│   └── hazard-report.model.ts          # Mongoose model（沿用 src/model 扁平慣例）
├── constants/messages.ts               # 擴充：HAZARD_REASON 等重複字串（reason 常數，去除魔術字串）
├── middleware/middleware.ts            # 擴充：注入 req.auth = { userId, user }（共用 spine）
├── types/
│   ├── code.ts                         # 擴充 ResponseCode：GONE=410、TOO_MANY_REQUESTS=429
│   ├── express.d.ts                    # 擴充 req.auth 型別（userId / user）
│   └── index.d.ts                      # 新增：IHazardReport / HazardType / AiVerdict / HazardStatus（model 介面）
├── utils/geo.ts                        # 新增：Haversine 距離（地理柵欄 / EXIF GPS 比對共用）
├── scripts/expire-hazard-reports.ts    # 新增：過期掃描 CLI（npm run hazard:expire；供 Cloud Scheduler/cron）
├── server.ts                           # 擴充：mongoose 連線後 startHazardExpiryJob()（in-process 過期掃描）
└── openapi/document.ts                 # 擴充：import hazard-report.schema（schema 自身呼叫 registry.registerPath）
```

### 3.3 各層職責（clean-architecture 契約）

| 層          | 檔案                                                     | 唯一職責                                                                                    | 不可以做                                     |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| transport   | `hazard-report.router.ts`                                | 宣告 path/method、串 middleware（auth→multer→validate）、委派**單一** controller            | 業務邏輯、直接呼叫 service                   |
| validation  | `hazard-report.schema.ts`                                | 以 Zod 宣告 body/query/params 形狀並拒絕未知欄位                                            | I/O、業務規則、塑形回應                      |
| handler     | `hazard-report.controller.ts`                            | 讀 `req.auth`/`req.validated`/`req.file`，呼叫**一個** service 方法，用 `sendResponse` 包裝 | 業務 if/else、外部/DB 呼叫、解析原始上游資料 |
| domain      | `hazard-report.service.ts`、`hazard-report.ai-verify.ts` | 業務邏輯與協調，呼叫 adapter / model，落實領域規則                                          | import `req`/`res`、驗證請求形狀             |
| I/O mapping | `hazard-report.parse.ts`                                 | exifr 原始值 ↔ `exifValidation`、Gemini 文字 → `AiVerifyResult`                             | 請求驗證、業務決策、HTTP 細節                |
| I/O client  | `adapters/*.adapter.ts`                                  | 封裝單一外部來源（GCS / Cloud Vision / Gemini）                                             | 業務決策、HTTP envelope                      |
| types       | `hazard-report.types.ts`                                 | 模組內 domain 型別來源（DTO / ServiceResult / 結果型別）；model 介面在 `types/index.d.ts`   | 邏輯、執行期值                               |

### 3.4 需動到的共用 spine（一次定義、處處沿用）

這些是 feature 之外、所有受保護端點共用的橫切基礎，本期需小幅擴充（皆為**加法、向後相容**）：

| 變更          | 檔案                                                      | 原因                                                                                                                                                                        |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth 注入身分 | `src/middleware/middleware.ts` + `src/types/express.d.ts` | 現有 auth middleware 只「擋」不「注入」（controller 目前各自 re-decode token）；改為 `req.auth = { userId, user }`，controller 統一從 `req.auth` 讀身分（取代手動解 token） |
| 補狀態碼      | `src/types/code.ts`（`ResponseCode`）                     | 目前缺 `410`（過期投票）與 `429`（rate limit）；補 `GONE=410`、`TOO_MANY_REQUESTS=429` 才能讓這兩種錯誤也走同一 `sendResponse` envelope                                     |
| reason 常數   | `src/constants/messages.ts`                               | `GEOFENCE_VIOLATION` 等 `data.reason` 字串集中成 `HAZARD_REASON` 常數，避免魔術字串散落                                                                                     |
| docs 來源     | `src/openapi/registry.ts`                                 | 將 hazard-report 的 Zod schema 註冊進去，`/docs` 與 `/api/v1/openapi.json` 自動同步                                                                                         |

> 單一方向依賴、邊界驗證、單一 envelope（`sendResponse`）、無魔術字串（`ResponseCode` + `HAZARD_REASON`）、單一註冊點（`index.ts` + `app.ts` 一行）——六項不變量逐項對齊。

---

## 4. 資料模型

### 4.1 HazardReport（`src/model/hazard-report.model.ts`）

```typescript
import { Schema, model, Document } from "mongoose";

// 回報類型
export type HazardType = "obstacle" | "construction" | "data_error";

// AI 辨識結果
export type AiVerdict = "verified" | "suspicious" | "rejected" | "skipped";

export interface IHazardReport extends Document {
  // 回報識別
  reporterId: string; // 必填，回報者使用者 ID（須登入）

  // 地點資訊
  reportedLocation: {
    // 使用者宣稱的回報地點
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
  reporterLocation: {
    // 回報當下使用者的 GPS 座標
    type: "Point";
    coordinates: [number, number];
  };
  distanceM: number; // Haversine 計算結果（公尺，記錄用）

  // 回報內容
  hazardType: HazardType;
  description?: string; // 選用文字說明（最多 500 字）
  photoUrl: string; // 上傳後的公開 URL（GCS Signed URL 或 CDN URL）
  photoStoragePath: string; // bucket 內部路徑（用於刪除或重新取得）

  // EXIF 驗證結果
  exifValidation: {
    timestampFresh: boolean; // 拍攝時間距回報時間 ≤ 10 分鐘
    gpsPresent: boolean; // 照片含 EXIF GPS
    gpsMatchesClaimed: boolean; // EXIF GPS 與宣稱座標距離 ≤ 50m
    rawExifTime?: string; // ISO 8601 字串（記錄用）
    rawExifLat?: number;
    rawExifLng?: number;
  };

  // AI 影像辨識結果（兩階段）
  aiVerification: {
    verdict: AiVerdict;
    confidence: number; // 0.0 – 1.0
    reason: string; // Gemini 回傳的判斷說明（繁中）
    prefilter?: {
      // 第一階段：Cloud Vision 預篩結果
      passed: boolean; // 是否通過預篩（未被 SafeSearch 擋下）
      detectedLabels?: string[]; // 偵測到的物件／標籤（傳給 Gemini 作提示）
      safeSearchBlocked?: boolean; // SafeSearch 判定不雅／暴力／spoof 而擋下
    };
    attemptedAt?: Date;
  };

  // 狀態
  status: "pending" | "verified" | "rejected" | "expired";

  // 社群確認
  confirmCount: number; // 確認票數（其他使用者認同）
  denyCount: number; // 否認票數
  confirmedBy: string[]; // 已確認使用者 ID 清單（防重複投票）
  deniedBy: string[]; // 已否認使用者 ID 清單

  // 時間
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date; // TTL 欄位（建立時依 hazardType 計算）
}

const HazardReportSchema = new Schema<IHazardReport>(
  {
    reporterId: { type: String, required: true, index: true },

    reportedLocation: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
    },
    reporterLocation: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
    },
    distanceM: { type: Number, required: true },

    hazardType: {
      type: String,
      enum: ["obstacle", "construction", "data_error"],
      required: true,
    },
    description: { type: String, maxlength: 500, default: null },
    photoUrl: { type: String, required: true },
    photoStoragePath: { type: String, required: true },

    exifValidation: {
      timestampFresh: { type: Boolean, required: true },
      gpsPresent: { type: Boolean, required: true },
      gpsMatchesClaimed: { type: Boolean, required: true },
      rawExifTime: String,
      rawExifLat: Number,
      rawExifLng: Number,
    },

    aiVerification: {
      verdict: {
        type: String,
        enum: ["verified", "suspicious", "rejected", "skipped"],
        required: true,
      },
      confidence: { type: Number, min: 0, max: 1, required: true },
      reason: { type: String, required: true },
      prefilter: {
        passed: Boolean,
        detectedLabels: { type: [String], default: undefined },
        safeSearchBlocked: Boolean,
      },
      attemptedAt: Date,
    },

    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "expired"],
      default: "pending",
    },

    confirmCount: { type: Number, default: 0 },
    denyCount: { type: Number, default: 0 },
    confirmedBy: { type: [String], default: [] },
    deniedBy: { type: [String], default: [] },

    expiredAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Index 定義
HazardReportSchema.index({ reportedLocation: "2dsphere" });
HazardReportSchema.index({ status: 1, createdAt: -1 });
HazardReportSchema.index({ hazardType: 1, status: 1 });
HazardReportSchema.index({ reporterId: 1, createdAt: -1 }); // GET /reports/mine
HazardReportSchema.index({ expiredAt: 1, status: 1 }); // 過期掃描定時任務查詢
// 注意：不使用 MongoDB TTL index（expireAfterSeconds）——回報到期僅標記為 expired，保留歷史不物理刪除

export const HazardReport = model<IHazardReport>(
  "HazardReport",
  HazardReportSchema,
);
```

### 4.2 過期策略（保留歷史）

`expiredAt` 於建立時依 `hazardType` 計算，僅決定回報何時從「附近查詢」的預設結果中淡出，**不觸發刪除**：

| hazardType     | expiredAt 計算       | 說明                               |
| -------------- | -------------------- | ---------------------------------- |
| `obstacle`     | `createdAt + 6 小時` | 障礙物通常短暫，若無確認即視為過期 |
| `construction` | `createdAt + 7 天`   | 施工工期較長                       |
| `data_error`   | `createdAt + 30 天`  | 資料問題需較長觀察期               |

**保留歷史的做法（取代 MongoDB TTL index）**：

- **不使用** `expireAfterSeconds: 0` 的 TTL index——它會物理刪除文件，無法保留歷史。
- 改以**定時任務**（Cloud Scheduler 或 Node.js cron，每 N 分鐘）執行：

  ```typescript
  // 將到期但尚未標記的回報設為 expired，文件保留
  await HazardReport.updateMany(
    {
      expiredAt: { $lte: new Date() },
      status: { $in: ["pending", "verified"] },
    },
    { $set: { status: "expired" } },
  );
  ```

- `expired` 文件：從 `GET /reports`（附近查詢，預設 `status=pending,verified`）排除，但仍可經 `GET /reports/:id`、`GET /reports/mine` 查得，並保留供統計與人工複核。
- 照片同步保留（見 §7.3）；若日後需控管儲存量，可另立**更長週期**的封存／清理機制，與「過期」解耦。

### 4.3 狀態機

```
             ┌─────────────────────┐
             │  POST /reports 提交  │
             └──────────┬──────────┘
                        ↓
                   [ pending ]
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   AI: verified   AI: suspicious  AI: rejected
          │             │             │
      [ verified ]  [ pending ]  [ rejected ]
          │             │
     confirmCount    denyCount
       >= 3 加分     >= 3 加分
```

> `verified`：`aiVerification.verdict === 'verified'` 且 EXIF 驗證通過後，後端直接設定；  
> `rejected`：`aiVerification.verdict === 'rejected'`，或未來人工複核否決。

---

## 5. API 規格

### 5.1 端點總覽

| Method | Path                               | 功能               | 認證             |
| ------ | ---------------------------------- | ------------------ | ---------------- |
| `POST` | `/api/v1/a11y/reports`             | 提交路況回報       | **JWT 必要**     |
| `GET`  | `/api/v1/a11y/reports/mine`        | 查詢自己的回報紀錄 | **JWT 必要**     |
| `GET`  | `/api/v1/a11y/reports`             | 查詢附近回報       | 公開             |
| `GET`  | `/api/v1/a11y/reports/:id`         | 取得單一回報       | 公開             |
| `POST` | `/api/v1/a11y/reports/:id/confirm` | 社群二次確認／否認 | 公開（選用 JWT） |

> **回報（`POST /reports`）與「我的回報」（`GET /reports/mine`）強制 JWT**，`reporterId` 取自 `req.auth.userId`（由共用 auth middleware 注入，見 §3.4）。token 過期→401、缺少/無效→403，皆由 middleware 直接回應（不進 controller）。  
> 附近查詢與單筆查詢為公開路由。社群確認（`/confirm`）維持公開：帶 JWT 以 `req.auth.userId` 記入 `confirmedBy` / `deniedBy`，未帶則以 IP hash 作匿名識別（避免重複投票）。  
> ⚠️ **掛載方式**：本專案的 auth middleware（`src/middleware/middleware.ts`）目前只整段掛在 `/api/v1/user`。回報端點掛在 `/api/v1/a11y`（與 `createA11yRouter` 等並列），故**不能**整段套 auth——須在 `hazard-report.router.ts` 內**逐路由**對 `POST /reports` 與 `GET /reports/mine` 串上 auth middleware，其餘公開。

---

### 5.2 POST /api/v1/a11y/reports — 提交路況回報

**Content-Type**：`multipart/form-data`

**請求欄位**

| 欄位          | 型別                                         | 必要 | 說明                    |
| ------------- | -------------------------------------------- | ---- | ----------------------- |
| `photo`       | File（JPEG/PNG）                             | 必要 | 即時拍攝照片，最大 10MB |
| `hazardType`  | `obstacle` \| `construction` \| `data_error` | 必要 | 回報類型                |
| `reportedLat` | number                                       | 必要 | 回報地點緯度            |
| `reportedLng` | number                                       | 必要 | 回報地點經度            |
| `reporterLat` | number                                       | 必要 | 使用者當前緯度（GPS）   |
| `reporterLng` | number                                       | 必要 | 使用者當前經度（GPS）   |
| `description` | string                                       | 選用 | 文字說明，最多 500 字元 |

**Zod Schema（`hazard-report.schema.ts`）**

```typescript
import { z } from "zod";

// photo 欄位由 Multer 處理（→ req.file），不在 body schema 內
// 多 part 欄位皆為字串，故以 z.coerce 轉數值；.strict() 拒絕未知欄位（邊界驗證不變量）
export const CreateHazardReportSchema = z
  .object({
    hazardType: z.enum(["obstacle", "construction", "data_error"]),
    reportedLat: z.coerce.number().min(-90).max(90),
    reportedLng: z.coerce.number().min(-180).max(180),
    reporterLat: z.coerce.number().min(-90).max(90),
    reporterLng: z.coerce.number().min(-180).max(180),
    description: z.string().max(500).optional(),
  })
  .strict();
```

> 其餘 schema（`NearbyReportsQuerySchema`、`MyReportsQuerySchema`、`ReportIdParamSchema`、`ConfirmSchema`）同樣 `.strict()`，並於 `src/openapi/registry.ts` 註冊，使 `/docs` 與 schema 單一同步。

**後端驗證流程**

```
[auth middleware] 驗 JWT、注入 req.auth；token 過期→401、缺少/無效→403（不進 controller）
[multer]          multipart → req.file（photo buffer）
[validateRequest] Zod 驗 body → req.validated.body
─────────── 以下在 controller → service 內（controller 只讀 req.auth/validated/file 並呼叫 service）───────────
1. service 取 reporterId = req.auth.userId（由 controller 傳入）
2. Haversine 計算 reportedLocation ↔ reporterLocation 距離
   → 距離 > 20m → 400 INVALID_INPUT，data.reason = GEOFENCE_VIOLATION
3. EXIF 解析（hazard-report.parse.ts，內部用 exifr）
   a. 拍攝時間 vs 請求時間 > 10 分鐘 → exifValidation.timestampFresh = false
      → 整體 EXIF 驗證失敗 → 400 INVALID_INPUT，data.reason = EXIF_TOO_OLD
   b. 有 GPS EXIF → 比對 EXIF GPS ↔ reporterLocation
      → 距離 > 50m → 400 INVALID_INPUT，data.reason = EXIF_GPS_MISMATCH
4. 上傳照片至 GCS（adapters/gcs.adapter.ts）
5. 建立並儲存 HazardReport document（aiVerification.verdict 先以 'skipped' 佔位）
6. 回傳 201 + 回報資料（含 _id 供前端輪詢）
7. 非同步觸發 AI 影像辨識（hazard-report.ai-verify.ts，不阻擋回應）
   a. 階段一：Cloud Vision 物件偵測 + SafeSearch（reportedLocation 不參與）
      → SafeSearch 判定不雅／暴力／spoof → prefilter.passed=false，verdict='rejected'，跳過 Gemini
   b. 階段二：Gemini 單圖語意判斷（帶入偵測標籤作提示）→ verdict + confidence + reason
   c. updateOne：更新 aiVerification + 依 verdict 更新 status
```

> ⚠️ **設計說明（非同步 + 輪詢）**：步驟 5 先建立文件並於步驟 6 回傳 `201`，**回應務必包含 `_id`**——前端據此向 `GET /reports/:id` 輪詢，待步驟 7 的 AI 辨識完成後即可讀到更新後的 `aiVerification` 與 `status`（推播本期未納入）。AI 辨識為兩階段（Cloud Vision 預篩 → Gemini），任一階段失敗皆 fail-soft（見 §6），不影響此 201 回應。

**成功回應（201）**

```json
{
  "ok": true,
  "status": "success",
  "code": 201,
  "message": "回報已提交，正在進行影像驗證",
  "data": {
    "report": {
      "_id": "6670abc123def456",
      "reporterId": "665f0011aa22bb33cc44dd55",
      "hazardType": "obstacle",
      "reportedLocation": {
        "type": "Point",
        "coordinates": [121.5654, 25.033]
      },
      "description": "人行道上有施工鐵板未固定",
      "photoUrl": "https://storage.googleapis.com/bucket/reports/6670abc123def456.jpg",
      "status": "pending",
      "exifValidation": {
        "timestampFresh": true,
        "gpsPresent": true,
        "gpsMatchesClaimed": true
      },
      "aiVerification": {
        "verdict": "skipped",
        "confidence": 0,
        "reason": "影像辨識進行中"
      },
      "confirmCount": 0,
      "denyCount": 0,
      "createdAt": "2026-06-17T08:30:00.000Z",
      "expiredAt": "2026-06-17T14:30:00.000Z"
    }
  }
}
```

**錯誤回應**

> envelope 的 `code` 欄位 = HTTP 狀態（`ResponseCode` enum）；領域錯誤類別放 `data.reason`（建議集中為 `HAZARD_REASON` 常數）。下表 reason 即 `data.reason`。

| HTTP（ResponseCode）         | data.reason             | message                            | 說明                                                  |
| ---------------------------- | ----------------------- | ---------------------------------- | ----------------------------------------------------- |
| 401 / 403（auth middleware） | —（由 middleware 回應） | Unauthorized / Forbidden           | token 過期→401、缺少/無效→403；在 controller 之前攔截 |
| 400 `INVALID_INPUT`          | `GEOFENCE_VIOLATION`    | 使用者位置距回報地點超過 20 公尺   | Haversine 距離 > 20m                                  |
| 400 `INVALID_INPUT`          | `EXIF_TOO_OLD`          | 照片拍攝時間距回報時間超過 10 分鐘 | 疑似從相簿選取                                        |
| 400 `INVALID_INPUT`          | `EXIF_GPS_MISMATCH`     | 照片 GPS 位置與宣稱位置不符        | EXIF GPS ↔ reporterLocation > 50m                     |
| 400 `INVALID_INPUT`          | `PHOTO_REQUIRED`        | 未上傳照片                         | Multer 未收到 photo 欄位                              |
| 400 `INVALID_INPUT`          | `PHOTO_TOO_LARGE`       | 照片超過 10MB                      | Multer 檔案大小限制                                   |
| 400 `INVALID_INPUT`          | `INVALID_PHOTO_TYPE`    | 僅接受 JPEG 或 PNG                 | MIME type 不符                                        |
| 429 `TOO_MANY_REQUESTS`      | `RATE_LIMITED`          | 回報提交過於頻繁，請稍後再試       | Rate limit 觸發（需擴充 enum；見 §3.4）               |
| 500 `INTERNAL_ERROR`         | `UPLOAD_FAILED`         | 照片上傳失敗，請重試               | GCS 上傳錯誤                                          |

```json
{
  "ok": false,
  "status": "error",
  "code": 400,
  "message": "使用者位置距回報地點超過 20 公尺",
  "data": {
    "reason": "GEOFENCE_VIOLATION",
    "distanceM": 47.3
  }
}
```

---

### 5.3 GET /api/v1/a11y/reports — 查詢附近回報

**Query Parameters**

| 參數         | 型別   | 必要 | 說明                                                         |
| ------------ | ------ | ---- | ------------------------------------------------------------ |
| `lat`        | number | 必要 | 查詢中心緯度                                                 |
| `lng`        | number | 必要 | 查詢中心經度                                                 |
| `radius`     | number | 選用 | 查詢半徑（公尺），預設 500，最大 5000                        |
| `hazardType` | string | 選用 | 過濾回報類型（`obstacle` \| `construction` \| `data_error`） |
| `status`     | string | 選用 | 過濾狀態，預設 `pending,verified`（逗號分隔）                |
| `limit`      | number | 選用 | 回傳筆數上限，預設 20，最大 50                               |

**查詢邏輯**

```typescript
// 排除 expired / rejected，依距離排序
HazardReport.find({
  reportedLocation: {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radius,
    },
  },
  status: { $in: statusFilter },
  ...(hazardType ? { hazardType } : {}),
})
  .select("-reporterId -photoStoragePath -confirmedBy -deniedBy") // 公開查詢不洩漏回報者 ID
  .limit(limit);
```

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 2 筆附近路況回報",
  "data": {
    "reports": [
      {
        "_id": "6670abc123def456",
        "hazardType": "obstacle",
        "reportedLocation": {
          "type": "Point",
          "coordinates": [121.5654, 25.033]
        },
        "description": "人行道上有施工鐵板未固定",
        "photoUrl": "https://storage.googleapis.com/bucket/reports/6670abc123def456.jpg",
        "status": "verified",
        "aiVerification": {
          "verdict": "verified",
          "confidence": 0.87,
          "reason": "照片為人行道實景，可見未固定施工鐵板，與宣稱障礙相符"
        },
        "confirmCount": 3,
        "denyCount": 0,
        "createdAt": "2026-06-17T08:30:00.000Z",
        "expiredAt": "2026-06-17T14:30:00.000Z"
      }
    ],
    "total": 2,
    "queryCenter": { "lat": 25.033, "lng": 121.5654 },
    "radiusM": 500
  }
}
```

---

### 5.4 GET /api/v1/a11y/reports/:id — 取得單一回報

**路徑參數**

| 參數 | 說明                  |
| ---- | --------------------- |
| `id` | MongoDB ObjectId 字串 |

**成功回應（200）**：回傳 `HazardReport` document（同 §5.3 格式，公開端點同樣以 `.select('-reporterId -photoStoragePath -confirmedBy -deniedBy')` 隱藏回報者 ID 與內部欄位）。前端輪詢即打此端點讀取最新 `status` / `aiVerification`。

**錯誤回應**

| HTTP（ResponseCode） | data.reason        | message            |
| -------------------- | ------------------ | ------------------ |
| 400 `INVALID_INPUT`  | `INVALID_ID`       | 無效的回報 ID 格式 |
| 404 `NOT_FOUND`      | `REPORT_NOT_FOUND` | 找不到對應的回報   |

---

### 5.5 POST /api/v1/a11y/reports/:id/confirm — 社群二次確認

**Content-Type**：`application/json`

**請求 Body**

```json
{
  "action": "confirm"
}
```

| 欄位     | 型別                | 必要 | 說明             |
| -------- | ------------------- | ---- | ---------------- |
| `action` | `confirm` \| `deny` | 必要 | 確認或否認此回報 |

**後端邏輯**

```
1. 查詢 HazardReport，確認存在且 status != 'expired'
2. 若請求帶有 JWT，取出 userId；否則以 IP hash 作匿名識別碼
3. 檢查 confirmedBy / deniedBy 清單，同一使用者不可重複投票
4. action === 'confirm' → confirmCount += 1，userId 加入 confirmedBy
   action === 'deny'    → denyCount += 1，  userId 加入 deniedBy
5. 回傳更新後的票數
```

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "已確認此回報",
  "data": {
    "reportId": "6670abc123def456",
    "action": "confirm",
    "confirmCount": 4,
    "denyCount": 0
  }
}
```

**錯誤回應**

| HTTP（ResponseCode） | data.reason        | message                                        |
| -------------------- | ------------------ | ---------------------------------------------- |
| 400 `INVALID_INPUT`  | `INVALID_ID`       | 無效的回報 ID 格式                             |
| 400 `INVALID_INPUT`  | `ALREADY_VOTED`    | 您已對此回報投過票                             |
| 404 `NOT_FOUND`      | `REPORT_NOT_FOUND` | 找不到對應的回報                               |
| 410 `GONE`           | `REPORT_EXPIRED`   | 此回報已過期，無法投票（需擴充 enum；見 §3.4） |

---

### 5.6 GET /api/v1/a11y/reports/mine — 查詢我的回報紀錄

**認證**：**JWT 必要**（未登入由共用 auth middleware 回 401/403）。`reporterId` 取自 `req.auth.userId`，使用者僅能查得自己的回報。

**Query Parameters**

| 參數         | 型別   | 必要 | 說明                                                                                                                     |
| ------------ | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `status`     | string | 選用 | 過濾狀態（`pending` \| `verified` \| `rejected` \| `expired`，逗號分隔）；預設**全部**（含 `expired`，供使用者檢視歷史） |
| `hazardType` | string | 選用 | 過濾回報類型                                                                                                             |
| `limit`      | number | 選用 | 回傳筆數上限，預設 20，最大 50                                                                                           |
| `cursor`     | string | 選用 | 分頁游標（前一頁最後一筆的 `_id`），依 `createdAt` 由新到舊                                                              |

**查詢邏輯**

```typescript
// 依 reporterId 過濾，最新在前；不做地理排序
HazardReport.find({
  reporterId, // 來自 JWT，非 query 參數
  ...(statusFilter ? { status: { $in: statusFilter } } : {}),
  ...(hazardType ? { hazardType } : {}),
  ...(cursor ? { _id: { $lt: cursor } } : {}),
})
  .select("-photoStoragePath -confirmedBy -deniedBy")
  .sort({ createdAt: -1 })
  .limit(limit);
```

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "找到 3 筆您的回報",
  "data": {
    "reports": [
      {
        "_id": "6670abc123def456",
        "reporterId": "665f0011aa22bb33cc44dd55",
        "hazardType": "obstacle",
        "status": "expired",
        "description": "人行道上有施工鐵板未固定",
        "photoUrl": "https://storage.googleapis.com/bucket/reports/6670abc123def456.jpg",
        "aiVerification": {
          "verdict": "verified",
          "confidence": 0.87,
          "reason": "..."
        },
        "confirmCount": 3,
        "denyCount": 0,
        "createdAt": "2026-06-17T08:30:00.000Z",
        "expiredAt": "2026-06-17T14:30:00.000Z"
      }
    ],
    "total": 3,
    "nextCursor": "6670abc123def456"
  }
}
```

**錯誤回應**

| HTTP（ResponseCode）         | data.reason             | message                  |
| ---------------------------- | ----------------------- | ------------------------ |
| 401 / 403（auth middleware） | —（由 middleware 回應） | Unauthorized / Forbidden |

---

## 6. 外部服務整合

> **為何不採用街景／衛星參考影像比對？** 早期設計曾以 Google Street View Static / Static Maps 衛星圖作為比對基準，但**街景與衛星圖在台灣常為 1～5 年前的舊圖**，而路況回報的本質是「**新出現**的暫時障礙（施工、占道、破損）」——拿即時照片去比對舊參考圖，對「現在是否有障礙」沒有判斷力；而「是否在宣稱地點拍攝」已由 EXIF GPS（§6.3）把關。因此移除參考影像比對，AI 改為**對單張使用者照片做辨識**，分兩階段如下。

### 6.1 Google Cloud Vision API（第一階段：影像預篩，`adapters/vision.adapter.ts`）

**用途**：在呼叫 LLM 前，先以低成本、確定性的傳統 CV 過濾明顯不合格的圖（不雅、無關、純色／截圖），並擷取物件標籤作為第二階段的提示。

**呼叫**：`@google-cloud/vision` SDK，對使用者照片 buffer 同時做兩種偵測：

| 偵測                                    | 用途                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `labelDetection` / `objectLocalization` | 取得物件標籤（如 `Construction`、`Traffic cone`、`Fence`、`Sidewalk`、`Road`），作為 Gemini 判斷的提示，並判別是否為戶外街景 |
| `safeSearchDetection`                   | 偵測 `adult` / `violence` / `racy` / `spoof`，擋下濫用或惡意圖                                                               |

**預篩判定**

```
1. SafeSearch：adult / violence / racy 任一為 LIKELY 或 VERY_LIKELY，或 spoof 為 VERY_LIKELY
   → prefilter.passed = false，prefilter.safeSearchBlocked = true
   → verdict = 'rejected'，confidence = 1，reason = '影像未通過安全檢測'
   → 直接結束，不呼叫 Gemini（省成本）
2. 其餘情形：prefilter.passed = true，detectedLabels = 取信心度前幾名標籤
   → 進入第二階段（Gemini）
```

> 設計取捨：預篩**只在 SafeSearch 命中時硬擋**；「是否拍到障礙、地點是否合理」這類語意判斷交給 Gemini，避免 Cloud Vision 標籤集涵蓋不足而誤殺真實回報。偵測標籤僅作為 Gemini 的 context hint，不單獨決定 verdict。
>
> **認證**：Cloud Vision 與 GCS 同屬一個 GCP 專案，沿用 `GCS_KEY_FILE`（service account）或 Workload Identity，無需額外金鑰。需在 GCP 啟用 Cloud Vision API。可由 `USE_VISION_PREFILTER=false` 關閉預篩（直接進 Gemini）。

---

### 6.2 Gemini 單圖語意判斷（第二階段，`adapters/ai-vision.adapter.ts`，由 `hazard-report.ai-verify.ts` 協調）

**模型**：`gemini-2.5-flash`（`GEMINI_MODEL` 環境變數，與現有 AI 功能共用設定）

**呼叫方式**：使用現有的 OpenAI 相容端點（`GEMINI_API_URL`），以 multimodal message 傳入**單張使用者照片**，並在文字部分附上 `hazardType`、`description` 與第一階段的 `detectedLabels` 作為提示。**不再傳入街景／衛星參考圖**。

**Prompt 設計（系統指令）**

```
你是一個路況回報真實性驗證助手。你會收到一張使用者在現場即時拍攝的照片，
以及該回報所宣稱的障礙類型與（可能的）物件標籤提示。

請僅根據這張照片判斷：
1. 這是否為真實的戶外街道／人行道場景（而非截圖、室內自拍、純色圖或與路況無關的圖）？
2. 照片中是否可見與宣稱類型相符的路況障礙（obstacle 障礙物 / construction 施工 / data_error 標示或設施錯誤）？

請以 JSON 格式回傳以下欄位：
{
  "verdict": "verified" | "suspicious" | "rejected",
  "confidence": 0.0 ~ 1.0,
  "reason": "繁體中文說明（最多 100 字）"
}

判斷標準：
- verified：確為戶外路況場景，且可見與宣稱類型相符的合理障礙
- suspicious：像戶外場景但障礙不明確，或與宣稱類型不完全相符
- rejected：明顯非戶外路況場景（截圖／室內／無關），或完全看不到任何障礙
```

**回傳解析**

```typescript
interface AiVerifyResult {
  verdict: "verified" | "suspicious" | "rejected";
  confidence: number;
  reason: string;
}
```

**Fail-soft 策略**

| 情境                         | 處理                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Cloud Vision 預篩呼叫失敗    | 略過預篩、直接進 Gemini（`prefilter.passed` 留空）；不阻擋流程                                |
| Gemini API 呼叫失敗          | `verdict: 'skipped'`，`confidence: 0`，`reason: 'AI 服務暫時不可用'`，`status` 維持 `pending` |
| JSON 解析失敗                | `verdict: 'skipped'`                                                                          |
| 超時（10 秒）                | `verdict: 'skipped'`                                                                          |
| `USE_HAZARD_AI_VERIFY=false` | 兩階段皆跳過，`verdict: 'skipped'`，`status` 維持 `pending`                                   |

---

### 6.3 EXIF 解析（`exifr` 套件）

**解析欄位**

| EXIF 欄位                      | 用途                                    |
| ------------------------------ | --------------------------------------- |
| `DateTimeOriginal`             | 拍攝時間，比對請求時間是否在 10 分鐘內  |
| `GPSLatitude` / `GPSLongitude` | 比對是否與 `reporterLocation` 在 50m 內 |

**邊界條件**

| 情境                   | 處理                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| 照片無任何 EXIF        | `timestampFresh: false`，`gpsPresent: false`，`gpsMatchesClaimed: false` → 400 EXIF_TOO_OLD |
| 照片有時間戳但無 GPS   | `gpsPresent: false`，`gpsMatchesClaimed: false`；時間戳仍驗證                               |
| 時間戳格式異常無法解析 | 視同無時間戳，`timestampFresh: false` → 400 EXIF_TOO_OLD                                    |

> ⚠️ **待確認**：部分 Android 相機 App 以 UTC 儲存 EXIF 時間（無時區標記），驗證時需以 UTC 比對，或要求前端另外傳入設備時間（`deviceTimestamp`）作為對照。

---

## 7. 照片儲存策略

**建議採用 Google Cloud Storage（GCS）Bucket**，而非 MongoDB GridFS。

### 7.1 選擇依據

| 面向             | GCS Bucket                                | GridFS                       |
| ---------------- | ----------------------------------------- | ---------------------------- |
| 擴充性           | 無上限，CDN 整合容易                      | MongoDB 受儲存空間限制       |
| 讀取效能         | CDN 快取，靜態 URL                        | 每次查詢走 MongoDB Streaming |
| 費用             | 依用量計費（GCS 標準儲存）                | MongoDB Atlas 儲存費用較高   |
| 管理複雜度       | 需額外設定 bucket + IAM                   | 零外部依賴                   |
| 現有技術棧吻合度 | 已有 `GOOGLE_MAPS_API_KEY`，同一 GCP 專案 | 無額外依賴                   |

**結論**：採用 GCS，建立專用 bucket `taipei-a11y-hazard-reports`，照片以 `reports/{reportId}.jpg` 路徑儲存，上傳後取得公開 CDN URL 記錄於 `photoUrl`。

### 7.2 上傳流程

```typescript
// src/adapters/gcs.adapter.ts
async function uploadHazardPhoto(
  buffer: Buffer,
  reportId: string,
  mimeType: "image/jpeg" | "image/png",
): Promise<{ url: string; storagePath: string }>;
```

### 7.3 生命週期

- 照片與 `HazardReport` document 同步**長期保留**——回報到期僅標記 `status='expired'`（§4.2），不刪除文件，照片亦保留供歷史查詢與人工複核。
- 由於要保留歷史，**不**在 `expiredAt` 到期時刪照片。若日後儲存量需控管，再另立**獨立的長週期封存／清理**機制（例如保留 1 年後轉冷儲存或刪除），與「過期」狀態解耦，並同步刪 GCS 物件與標記文件。

---

## 8. 濫用防護

### 8.1 Rate Limit

以 `express-rate-limit` + Redis 儲存（`ioredis`，與現有 Redis 共用）實作：

| 端點                        | 限制  | 時間窗  | 識別鍵 |
| --------------------------- | ----- | ------- | ------ |
| `POST /reports`             | 3 次  | 10 分鐘 | IP     |
| `POST /reports/:id/confirm` | 10 次 | 1 分鐘  | IP     |
| `GET /reports`              | 30 次 | 1 分鐘  | IP     |

觸發 rate limit 時回傳 429 + `RATE_LIMITED`。

### 8.2 同地點重複回報合併

提交回報前，查詢是否已有 50m 內、同 `hazardType`、`status` 為 `pending` 或 `verified` 的回報：

```typescript
const existing = await HazardReport.findOne({
  reportedLocation: {
    $near: {
      $geometry: { type: "Point", coordinates: [reportedLng, reportedLat] },
      $maxDistance: 50,
    },
  },
  hazardType,
  status: { $in: ["pending", "verified"] },
});
```

- **有近似回報**：不建立新 document，改以 `POST /reports/:id/confirm` 邏輯自動對既有回報加 `confirmCount += 1`，回傳 200 + 既有回報資料（`merged: true`）。
- **無近似回報**：正常建立新 document。

---

## 9. 實作 Roadmap

### 待實作

| Phase      | 功能                                                                                                                                                    | 優先度   | 依賴         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| **S1**     | 基礎架構：`HazardReport` model、Multer 中介層、Zod schema、路由掛載（`POST /` 與 `GET /mine` 掛 JWT auth）                                              | Critical | —            |
| **S2**     | `POST /reports`：JWT 驗證 + 地理柵欄 + EXIF 驗證 + GCS 上傳 + document 建立（AI 辨識先以 `skipped` 佔位）                                               | Critical | S1           |
| **S3**     | `GET /reports`、`GET /reports/:id`、`GET /reports/mine`：查詢端點                                                                                       | High     | S1           |
| **S3**     | `POST /reports/:id/confirm`：社群確認端點                                                                                                               | High     | S1           |
| **S4**     | `hazard-report.ai-verify.ts` + `adapters/vision.adapter.ts` + `adapters/ai-vision.adapter.ts`：Cloud Vision 預篩 + Gemini 單圖判斷 + 非同步 status 更新 | High     | S2           |
| **S5**     | Rate limit（`express-rate-limit` + Redis）+ 同地點重複回報合併                                                                                          | Medium   | S1           |
| **S6**     | 過期標記定時任務（cron 將到期回報 `status` 設為 `expired`，文件與照片保留）                                                                             | Medium   | S2           |
| **Future** | 長週期封存／清理：保留期滿後刪 GCS 物件並標記文件（與「過期」解耦）                                                                                     | Low      | S6           |
| **Future** | 環境感知路徑規劃：將 `verified` 回報餵入路徑評分以動態避開障礙（本期不納入，路徑規劃端另立規格）                                                        | —        | 路徑規劃重構 |

---

### S1 詳細：基礎架構

**新增檔案**

```
src/
├── model/
│   └── hazard-report.model.ts
├── modules/
│   └── hazard-report/
│       ├── index.ts                    # export { createHazardReportRouter }
│       ├── hazard-report.router.ts
│       ├── hazard-report.schema.ts
│       ├── hazard-report.controller.ts
│       ├── hazard-report.service.ts
│       └── hazard-report.types.ts
└── adapters/
    └── gcs.adapter.ts                  # 照片上傳/刪除（I/O 層）
```

**修改既有檔案（共用 spine，見 §3.4）**：`src/app.ts`（掛載一行）、`src/middleware/middleware.ts` + `src/types/express.d.ts`（注入 `req.auth`）、`src/types/code.ts`（`GONE`/`TOO_MANY_REQUESTS`）、`src/constants/messages.ts`（`HAZARD_REASON`）、`src/openapi/registry.ts`（註冊 schema）。

**掛載方式**：沿用現有 `createXRouter()` 慣例——`index.ts` 匯出 `createHazardReportRouter()`，在 `src/app.ts` 加**一行**（與 `createA11yRouter` 等並列同前綴）：

```typescript
// src/app.ts
import { createHazardReportRouter } from "./modules/hazard-report";
app.use("/api/v1/a11y", createHazardReportRouter());
```

```typescript
// src/modules/hazard-report/hazard-report.router.ts — 逐路由掛 auth（僅 POST / 與 GET /mine）
export function createHazardReportRouter(): Router {
  const router = Router();
  router.post(
    "/reports",
    middleware,
    uploadPhoto,
    validateRequest({ body: CreateHazardReportSchema }),
    createReport,
  );
  router.get(
    "/reports/mine",
    middleware,
    validateRequest({ query: MyReportsQuerySchema }),
    getMyReports,
  );
  router.get(
    "/reports",
    validateRequest({ query: NearbyReportsQuerySchema }),
    getNearbyReports,
  );
  router.get(
    "/reports/:id",
    validateRequest({ params: ReportIdParamSchema }),
    getReport,
  );
  router.post(
    "/reports/:id/confirm",
    validateRequest({ params: ReportIdParamSchema, body: ConfirmSchema }),
    confirmReport,
  );
  return router;
}
```

---

### S4 詳細：AI 影像辨識服務

**新增檔案**：`src/modules/hazard-report/hazard-report.ai-verify.ts`（domain 協調）、`src/adapters/vision.adapter.ts`、`src/adapters/ai-vision.adapter.ts`（I/O）；JSON/EXIF 解析放 `hazard-report.parse.ts`。

**流程**

```
1. 取得使用者照片 buffer（從 POST 流程直接傳入，避免從 GCS 二次下載）
2. 階段一 Cloud Vision（@google-cloud/vision）：labelDetection + objectLocalization + safeSearchDetection
   → SafeSearch 命中 → verdict='rejected'，prefilter.safeSearchBlocked=true，結束
   → 否則 prefilter.passed=true，detectedLabels=前幾名標籤
3. 階段二 Gemini（OpenAI 相容端點）：單圖 + hazardType/description/detectedLabels 提示 → JSON verdict
4. 解析 JSON verdict（解析失敗 → 'skipped'）
5. updateOne HazardReport：aiVerification（含 prefilter）+ 依 verdict 更新 status
```

---

## 10. 測試策略

> 沿用 `CLAUDE.md` 說明，本專案目前無正式測試框架。以下為建議手動測試案例。

### 10.1 手動測試案例

| 測試案例        | 輸入條件                                    | 預期結果                                                      |
| --------------- | ------------------------------------------- | ------------------------------------------------------------- |
| 未登入提交      | 無 JWT 或 token 無效                        | 401/403（auth middleware 攔截）                               |
| 正常提交        | 已登入、距離 < 20m、EXIF 時間新鮮、GPS 吻合 | 201 pending，文件建立且帶 reporterId 與 _id                   |
| 地理柵欄拒絕    | reporterLocation 距 reportedLocation 25m    | 400 GEOFENCE_VIOLATION                                        |
| EXIF 過舊       | 照片拍攝於 15 分鐘前                        | 400 EXIF_TOO_OLD                                              |
| EXIF GPS 不符   | EXIF GPS 距 reporterLocation 100m           | 400 EXIF_GPS_MISMATCH                                         |
| 無 EXIF 照片    | 截圖或純白圖                                | 400 EXIF_TOO_OLD                                              |
| SafeSearch 擋下 | 上傳不雅／無關圖（通過 EXIF）               | 非同步後 verdict: rejected，prefilter.safeSearchBlocked: true |
| AI skipped 情境 | Gemini API Key 無效                         | 201 pending，非同步後 verdict: skipped                        |
| 我的回報        | 已登入查 /mine                              | 200，僅回傳該 reporterId 的回報（含 expired）                 |
| 我的回報未登入  | 無 JWT 查 /mine                             | 401/403（auth middleware 攔截）                               |
| 附近查詢        | lat/lng/radius 正常值                       | 200，回傳距離排序清單（排除 expired）                         |
| 超出範圍查詢    | radius=10000（超過 5000m 上限）             | 400 驗證錯誤                                                  |
| 重複同地點回報  | 50m 內已有相同 hazardType pending 回報      | 200 merged:true，confirmCount+1                               |
| Rate limit      | 同 IP 1 分鐘內送 4 次 POST                  | 第 4 次 429 RATE_LIMITED                                      |
| 社群確認重複    | 同使用者對同回報 confirm 兩次               | 400 ALREADY_VOTED                                             |
| 過期標記        | 文件 expiredAt 已過、cron 執行後            | status 變 expired，文件仍存在、可由 /mine 查得                |

### 10.2 驗證重點

- Haversine 計算正確性（20m 邊界值：19.9m 允許，20.1m 拒絕）
- EXIF 時間解析：UTC 與本地時間差異處理
- GCS 上傳後 `photoUrl` 可公開存取
- 過期標記 cron 將到期文件設為 `expired` 且**不刪除**（保留歷史），`GET /reports` 不再回傳、`GET /reports/mine` 仍可查得
- 2dsphere index 的 `$near` 查詢以距離正確排序
- `reporterId` index 支援 `/mine` 查詢效能
- AI 辨識非同步更新後，`GET /reports/:id` 反映最新 verdict 與 prefilter 結果

---

## 11. 新增環境變數

| 變數                           | 用途                                                               | 必要性               | 預設值 |
| ------------------------------ | ------------------------------------------------------------------ | -------------------- | ------ |
| `GCS_BUCKET_NAME`              | GCS bucket 名稱，照片儲存目標                                      | **必要**             | —      |
| `GCS_KEY_FILE`                 | GCS Service Account JSON 金鑰路徑（或使用 Workload Identity）      | **必要**（GCS 認證） | —      |
| `HAZARD_REPORT_MAX_DISTANCE_M` | 地理柵欄最大允許距離（公尺）                                       | 選配                 | `20`   |
| `HAZARD_PHOTO_MAX_SIZE_MB`     | 照片檔案大小上限（MB）                                             | 選配                 | `10`   |
| `USE_HAZARD_AI_VERIFY`         | `false` 時跳過整個 AI 辨識（兩階段皆略過，省 API 費用 / 開發環境） | 選配                 | `true` |
| `USE_VISION_PREFILTER`         | `false` 時跳過 Cloud Vision 預篩，直接進 Gemini                    | 選配                 | `true` |

> `GEMINI_API_KEY` / `GEMINI_API_URL` / `GEMINI_MODEL` 已存在於現有環境，無需重複新增。Cloud Vision 沿用 `GCS_KEY_FILE`（同一 GCP 專案的 service account）認證，需在 GCP 啟用 Cloud Vision API。`GOOGLE_MAPS_API_KEY` 本系統已不再需要（移除街景後）。

---

## 12. 新增 npm 依賴

| 套件                    | 用途                                                     | 版本建議 |
| ----------------------- | -------------------------------------------------------- | -------- |
| `@google-cloud/storage` | GCS Bucket 操作（上傳、刪除、取得 URL）                  | `^7.x`   |
| `@google-cloud/vision`  | Cloud Vision 影像預篩（物件偵測、SafeSearch）            | `^4.x`   |
| `exifr`                 | EXIF 解析（時間戳、GPS），支援 JPEG/HEIC                 | `^7.x`   |
| `multer`                | multipart/form-data 照片解析                             | `^1.x`   |
| `express-rate-limit`    | IP-based rate limiting                                   | `^7.x`   |
| `rate-limit-redis`      | express-rate-limit 的 Redis store（與現有 ioredis 整合） | `^4.x`   |

> ⚠️ `multer` 與 `@types/multer` 請同步安裝。`exifr` 為 ESM-first 套件，TypeScript 設定需確認 `moduleResolution: "bundler"` 或以動態 import 引入。

---

## 13. 前端職責邊界

### 13.1 前端負責

| 職責            | 說明                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| 登入把關        | 回報與「我的回報」前確認使用者已登入並附上 JWT；未登入引導登入（後端仍會以 401 把關） |
| 即時相機啟動    | 強制開啟裝置相機 API，**禁止從相簿選取**，由前端 UI 層面限制                          |
| GPS 擷取        | 以 Geolocation API 取得使用者當前座標，傳入 `reporterLat/Lng`                         |
| 回報表單 UI     | 選擇 hazardType、輸入 description、拍照並預覽                                         |
| 地圖疊加顯示    | 呼叫 `GET /reports` 取得附近回報，於地圖 render 標記                                  |
| 狀態輪詢        | 回報提交後，視需求輪詢 `GET /reports/:id` 以顯示 AI 驗證結果                          |
| 確認 / 否認互動 | 呼叫 `POST /reports/:id/confirm`                                                      |

### 13.2 前端不負責（後端職責）

| 禁止事項         | 原因                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| 地理柵欄計算     | 後端以 Haversine 重新計算，前端傳入座標僅作顯示用                                                          |
| EXIF 驗證        | 後端解析 EXIF，前端無法可靠讀取所有 MIME 類型的 EXIF                                                       |
| AI 影像辨識      | Cloud Vision 預篩與 Gemini 判斷皆在後端執行，金鑰不外露                                                    |
| 相簿選取限制邏輯 | **後端補強**：EXIF 時間戳與 GPS 驗證是防相簿選取的後端把關機制；前端相機限制屬 UX 層，後端驗證才是實質關卡 |
| 照片上傳至 GCS   | adapters/gcs.adapter.ts 在後端處理，GCS 憑證不外露                                                         |

---

## 14. 風險與緩解

| 風險                                                                                                        | 影響                                             | 緩解策略                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **EXIF 剝除**：部分裝置或社群媒體 App 自動剝除 EXIF                                                         | EXIF 驗證失效，回報被擋                          | 無 EXIF GPS 時允許僅以時間戳驗證（降級允許），但記錄 `gpsPresent: false` 作為信心度參考                       |
| **EXIF 偽造**：進階使用者手動修改 EXIF 後再拍照                                                             | 繞過時間戳與 GPS 驗證                            | AI 辨識（Cloud Vision + Gemini）為獨立第二道過濾；可評估加入 perceptual hash 比對（未來選項）                 |
| **AI 誤判**：照片語意判斷錯誤、或非戶外場景被誤放行                                                         | `suspicious/rejected` 誤殺真實回報，或濫用圖漏接 | AI verdict 不直接刪除回報，`rejected` 需社群否認達門檻或人工複核才真正排除；SafeSearch 硬擋僅限明確不雅／暴力 |
| **GCS 費用 / 儲存累積**：保留歷史使照片不隨過期刪除                                                         | 長期儲存成本上升                                 | Multer 檔案大小 10MB 上限 + rate limit 3 次/10 分鐘；長週期封存／清理列入 Roadmap Future（§9）與「過期」解耦  |
| **Cloud Vision 費用**：每則回報觸發一次預篩                                                                 | Vision API 費用                                  | 費用低於 LLM；可由 `USE_VISION_PREFILTER=false` 或 `USE_HAZARD_AI_VERIFY=false` 關閉                          |
| **環境感知路徑規劃整合**：本期回報未餵入路徑評分，使用者期待路線自動避障                                    | 功能落差                                         | Roadmap Future 列入；本期文件及前端應明確說明「回報供顯示，路線規劃不受影響」                                 |
| **TDX 額度**：Hazard Report 系統本身不呼叫 TDX，但若未來整合路徑規劃，附近回報查詢可能觸發更多 TDX 路線查詢 | 429 rate limit                                   | 整合時參照 [[tdx-quota-and-data-drift]] 的緩解策略                                                            |
