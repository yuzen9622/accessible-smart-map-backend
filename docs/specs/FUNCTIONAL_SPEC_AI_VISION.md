# AI 影像辨識輔助服務（視障使用者）

## Functional Specification — Vision AI for Accessibility

**版本**：v1.0.0  
**狀態**：Proposed — 未實作  
**日期**：2026-06-17  
**作者**：yuzen9622

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [API 規格](#4-api-規格)
5. [AI 視覺整合設計](#5-ai-視覺整合設計)
6. [資料模型](#6-資料模型)
7. [實作 Roadmap](#7-實作-roadmap)
8. [測試策略](#8-測試策略)
9. [新增環境變數](#9-新增環境變數)
10. [前端職責邊界](#10-前端職責邊界)
11. [風險與緩解](#11-風險與緩解)

---

## 1. 系統概述

本規格書定義後端 **AI 影像辨識輔助服務**，以 Gemini 多模態（Vision）能力為視障使用者提供三類影像理解功能：

| 功能           | 說明                                                       | 參考產品               |
| -------------- | ---------------------------------------------------------- | ---------------------- |
| **場景描述**   | 對準周遭拍照，後端回傳自然語言場景說明（適合 TTS 朗讀）    | Seeing AI、Envision AI |
| **讀字 / OCR** | 辨識照片中的文字（菜單、信件、招牌、產品包裝）             | Seeing AI Documents    |
| **目的地確認** | 使用者到站後拍照，後端比對目的地資訊，回傳是否抵達正確位置 | Seeing AI Places       |

> **範圍排除**：Be My Eyes 真人視訊屬第三方服務與前端職責，本規格**不涵蓋**真人遠端協助功能。

**定位**：本服務屬 `/api/v1/a11y/vision/*` 路由群，與現有無障礙導航（`/api/v1/a11y/accessible-route`）及 AI 問答（`/api/v1/a11y/chat`）並列，共用 Gemini AI 基礎設施（`src/config/ai/`、`GEMINI_API_URL`、`GEMINI_MODEL`）。

---

## 2. 系統目標

### 2.1 核心能力

- 接收前端傳入的影像（base64 或 公開 URL）並呼叫 Gemini Vision API 分析
- 回傳**繁體中文自然語句**，適合直接傳給前端 TTS 引擎朗讀
- 目的地確認任務額外整合 Google Places API（取參考照片與名稱）進行比對
- 快取相同影像的結果（依影像 SHA-256 雜湊），降低重複請求的 API 費用

### 2.2 非功能目標

| 目標             | 說明                                                            |
| ---------------- | --------------------------------------------------------------- |
| Backend 統一處理 | 所有 Gemini Vision 呼叫在後端完成，API 金鑰不暴露前端           |
| 輸出適合 TTS     | 語句長度、語氣、標點符號皆以口語朗讀為設計基準                  |
| 影像大小限制     | 後端拒絕超過 5 MB 的 base64 影像（Gemini inline 建議上限）      |
| 逾時防護         | Vision 呼叫上限 30 秒，超時回傳 503 而非 hang 住 event loop     |
| 成本可控         | Redis 快取命中跳過 Gemini 呼叫；`USE_VISION_API` 開關可整體停用 |

---

## 3. 系統架構

### 3.1 請求流程

```
Client Request (含 base64 影像 或 imageUrl)
      ↓
Express (src/app.ts)
      ↓
Zod Validation Middleware
      ↓
Vision Controller (src/modules/vision/vision.controller.ts)
      ↓
┌──────────────────────────────────────────────┐
│              Vision Service                  │
│  src/modules/vision/vision.service.ts        │
│                                              │
│  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Image Hash      │  │  Redis Cache     │  │
│  │  (SHA-256)       │→ │  vision:{hash}   │  │
│  └──────────────────┘  └──────────────────┘  │
│            ↓（cache miss）                   │
│  ┌──────────────────────────────────────────┐ │
│  │          Gemini Vision Call              │ │
│  │  @google/genai（OpenAI-compat endpoint） │ │
│  │  model: GEMINI_MODEL（gemini-2.5-flash） │ │
│  │  contents: [text prompt + inline image] │ │
│  └──────────────────────────────────────────┘ │
│            ↓（confirm-destination only）      │
│  ┌──────────────────────────────────────────┐ │
│  │  Google Places Details + Photo Fetch     │ │
│  │  src/config/map.ts                       │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
      ↓
sendResponse() → ApiResponse<VisionResult>
```

### 3.2 路由群組

| Prefix                | Route 檔案                            | 說明                           |
| --------------------- | ------------------------------------- | ------------------------------ |
| `/api/v1/a11y/vision` | `src/modules/vision/vision.router.ts` | 視覺辨識端點（公開，不需 JWT） |

> 視覺輔助屬無障礙公共服務，不要求登入。如日後需流量管控，建議在 middleware 層加 IP rate-limit 而非強制 JWT。

### 3.3 模組結構

```
src/modules/vision/
├── vision.controller.ts    # 三個端點的 handler
├── vision.service.ts       # Gemini 呼叫、快取、Places 整合
├── vision.router.ts        # 路由宣告
├── vision.schema.ts        # Zod request schema
└── vision.prompts.ts       # Gemini prompt 模板（集中管理）
```

---

## 4. API 規格

### 4.1 端點總覽

| Method | Path                                      | 功能            | 狀態        |
| ------ | ----------------------------------------- | --------------- | ----------- |
| `POST` | `/api/v1/a11y/vision/describe`            | 場景描述        | 📋 Proposed |
| `POST` | `/api/v1/a11y/vision/read-text`           | 文字辨識（OCR） | 📋 Proposed |
| `POST` | `/api/v1/a11y/vision/confirm-destination` | 目的地確認      | 📋 Proposed |

### 4.2 端點設計取捨說明

**選項 A（本規格採用）：分離端點**

三個任務分別對應獨立端點。優點：Prompt 邏輯分離，每個端點的 Zod schema、錯誤碼、回應欄位各自清晰；前端呼叫意圖明確，不需解析 `task` 欄位再切換行為。

**選項 B：統一端點 + `task` 參數**

`POST /api/v1/a11y/vision` 加上 `task: "describe" | "read-text" | "confirm-destination"`。優點：路由簡單。缺點：三個任務的 required 欄位不同（confirm-destination 需 `placeId` 或 `destination`），Zod 需 discriminated union，回應型別也須 union，增加閱讀成本。本規格以可讀性為優先，選擇分離端點。

---

### 4.3 `POST /api/v1/a11y/vision/describe`

**功能**：對使用者拍攝的周遭環境照片，回傳適合 TTS 朗讀的場景描述。

#### Request Schema（Zod）

```typescript
const DescribeRequest = z.object({
  image: z.union([
    z.object({
      type: z.literal("base64"),
      data: z.string().min(1), // base64 字串（不含 data URI prefix）
      mimeType: z
        .enum(["image/jpeg", "image/png", "image/webp"])
        .default("image/jpeg"),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string().url(), // 公開可存取的影像 URL
    }),
  ]),
  context: z.string().max(200).optional(), // 使用者的情境補充（如「我在捷運站內」）
});
```

#### Request 範例

```json
{
  "image": {
    "type": "base64",
    "data": "/9j/4AAQSkZJRgAB...",
    "mimeType": "image/jpeg"
  },
  "context": "我在捷運站出口附近"
}
```

#### Response 範例（成功）

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "場景描述完成",
  "data": {
    "description": "您正站在一個室外廣場，前方有一條約三公尺寬的人行道，地面鋪有導盲磚。左側是一排商店，右側有幾棵行道樹。遠方可以看到一個巴士站牌。",
    "spokenGuidance": "前方是寬廣的人行道，有導盲磚引導，左側為商店，右側有行道樹，請直行。",
    "cached": false
  }
}
```

#### 欄位說明

| 欄位             | 型別      | 說明                                           |
| ---------------- | --------- | ---------------------------------------------- |
| `description`    | `string`  | 完整場景描述（較詳細，適合顯示）               |
| `spokenGuidance` | `string`  | 精簡口語版，適合 TTS 直接朗讀                  |
| `cached`         | `boolean` | `true` 表示此結果來自快取（未重新呼叫 Gemini） |

#### 錯誤回應

| HTTP | code                 | reason                         | 說明 |
| ---- | -------------------- | ------------------------------ | ---- |
| 400  | `INVALID_IMAGE`      | 影像格式不符或 base64 無法解碼 |      |
| 413  | `IMAGE_TOO_LARGE`    | base64 解碼後超過 5 MB         |      |
| 503  | `VISION_UNAVAILABLE` | Gemini 呼叫失敗或逾時（30s）   |      |
| 503  | `VISION_DISABLED`    | `USE_VISION_API=false`         |      |

---

### 4.4 `POST /api/v1/a11y/vision/read-text`

**功能**：辨識照片中的所有文字，回傳適合 TTS 朗讀的內容。

#### Request Schema（Zod）

```typescript
const ReadTextRequest = z.object({
  image: z.union([
    z.object({
      type: z.literal("base64"),
      data: z.string().min(1),
      mimeType: z
        .enum(["image/jpeg", "image/png", "image/webp"])
        .default("image/jpeg"),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string().url(),
    }),
  ]),
  hint: z
    .enum(["menu", "sign", "letter", "product", "general"])
    .default("general"),
  // hint 用於調整 Gemini prompt 策略（如 menu 重視品項與價格結構）
});
```

#### Request 範例

```json
{
  "image": {
    "type": "url",
    "url": "https://example.com/photo.jpg"
  },
  "hint": "menu"
}
```

#### Response 範例（成功）

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "文字辨識完成",
  "data": {
    "rawText": "今日特餐\n排骨飯 120 元\n雞腿便當 150 元\n素食可選",
    "spokenGuidance": "今日特餐：排骨飯一百二十元，雞腿便當一百五十元，提供素食選項。",
    "textFound": true,
    "cached": false
  }
}
```

#### 欄位說明

| 欄位             | 型別      | 說明                                 |
| ---------------- | --------- | ------------------------------------ |
| `rawText`        | `string`  | 原始辨識文字（保留換行，適合顯示）   |
| `spokenGuidance` | `string`  | 口語化版本（數字轉國字、適合 TTS）   |
| `textFound`      | `boolean` | `false` 表示照片中未偵測到可辨識文字 |
| `cached`         | `boolean` | 同上                                 |

---

### 4.5 `POST /api/v1/a11y/vision/confirm-destination`

**功能**：使用者到達目的地後拍照，後端以 Google Places 資料（名稱、類型、照片）為參考，呼叫 Gemini 比對照片，判斷是否為正確目的地並回傳語音導引。

#### Request Schema（Zod）

```typescript
const ConfirmDestinationRequest = z.object({
  image: z.union([
    z.object({
      type: z.literal("base64"),
      data: z.string().min(1),
      mimeType: z
        .enum(["image/jpeg", "image/png", "image/webp"])
        .default("image/jpeg"),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string().url(),
    }),
  ]),
  destination: z.union([
    z.object({
      type: z.literal("placeId"),
      placeId: z.string().min(1), // Google Places ID
    }),
    z.object({
      type: z.literal("coords"),
      lat: z.number(),
      lng: z.number(),
      name: z.string().min(1).optional(), // 選填地標名稱，協助 Gemini 比對
    }),
    z.object({
      type: z.literal("address"),
      address: z.string().min(1),
    }),
  ]),
});
```

#### Request 範例

```json
{
  "image": {
    "type": "base64",
    "data": "/9j/4AAQSkZJRgAB...",
    "mimeType": "image/jpeg"
  },
  "destination": {
    "type": "placeId",
    "placeId": "ChIJN1t_tDeuEmsRUsoyG83frY4"
  }
}
```

#### Response 範例（成功 — 確認抵達）

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "目的地確認完成",
  "data": {
    "matched": true,
    "confidence": 0.91,
    "placeName": "台北 101 購物中心",
    "spokenGuidance": "您已到達台北一零一購物中心。正門在您正前方，入口處有自動門，無障礙通道在右側。",
    "description": "照片中可見台北 101 大樓的外觀與購物中心正門，與目的地資訊相符。",
    "cached": false
  }
}
```

#### Response 範例（無法確認）

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "目的地確認完成",
  "data": {
    "matched": false,
    "confidence": 0.24,
    "placeName": "台北 101 購物中心",
    "spokenGuidance": "照片與台北一零一的外觀不符，您目前可能尚未抵達，請繼續導航。",
    "description": "照片中顯示的是一般街道環境，未見台北 101 建築或相關標誌。",
    "cached": false
  }
}
```

#### 欄位說明

| 欄位             | 型別      | 說明                                                                                                      |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `matched`        | `boolean` | 照片與目的地吻合（`confidence >= 0.6` 視為吻合）⚠️ 待確認：閾值可由 `VISION_MATCH_THRESHOLD` 環境變數覆寫 |
| `confidence`     | `number`  | 0.0–1.0，Gemini 從結構化輸出回傳的信心度                                                                  |
| `placeName`      | `string`  | 解析後的地點名稱（來自 Google Places 或使用者輸入）                                                       |
| `spokenGuidance` | `string`  | 給視障使用者的語音導引文字                                                                                |
| `description`    | `string`  | Gemini 的比對說明（較詳細，適合顯示）                                                                     |
| `cached`         | `boolean` | 同上                                                                                                      |

#### 錯誤回應（confirm-destination 額外）

| HTTP | code                         | reason                                          | 說明 |
| ---- | ---------------------------- | ----------------------------------------------- | ---- |
| 400  | `DESTINATION_RESOLVE_FAILED` | 無法從 `coords` 或 `address` 解析出有效地點資訊 |      |
| 404  | `PLACE_NOT_FOUND`            | `placeId` 在 Google Places 查無資料             |      |

---

### 4.6 共用錯誤格式

所有端點的錯誤回應皆遵循 `sendResponse()` 標準封包（`src/config/lib.ts`）：

```json
{
  "ok": false,
  "status": "error",
  "code": 413,
  "message": "影像超過大小限制（最大 5 MB）",
  "data": {
    "reason": "IMAGE_TOO_LARGE",
    "maxBytes": 5242880
  }
}
```

---

## 5. AI 視覺整合設計

### 5.1 Gemini 多模態呼叫架構

本服務使用 `@google/genai` SDK 以 OpenAI 相容端點（`GEMINI_API_URL`）呼叫，與現有 AI agent（`src/config/ai/`）共用同一套 client 初始化邏輯。

**影像輸入方式**

| 輸入型別              | Gemini API 處理方式                    |
| --------------------- | -------------------------------------- |
| `base64` + `mimeType` | `inlineData: { data, mimeType }`       |
| 公開 `url`            | `fileData: { fileUri: url, mimeType }` |

> ⚠️ **待確認**：Gemini OpenAI-compat 端點是否支援 `fileData.fileUri` 直接傳 URL；若不支援，後端需先以 `fetch` 下載再轉 inline base64。

### 5.2 Prompt 結構設計

所有 prompt 集中於 `src/modules/vision/vision.prompts.ts`，以函式形式回傳，便於單元測試與日後調整。

#### 場景描述 Prompt

```typescript
export function describePrompt(context?: string): string {
  return `你是一位無障礙導覽助理，正在協助視障使用者了解周遭環境。
請以繁體中文描述這張照片的環境，重點包括：
- 可通行的路徑與方向
- 障礙物或需注意的地物
- 重要地標（如招牌、出入口、交通設施）
- 地面狀況（台階、坡道、導盲磚）
${context ? `使用者補充情境：${context}` : ""}

請分兩段回傳（JSON 格式）：
1. "description"：完整描述（100–200 字）
2. "spokenGuidance"：簡短口語版（30–60 字，適合語音朗讀，避免標點堆疊）`;
}
```

#### 讀字 Prompt

```typescript
export function readTextPrompt(hint: string): string {
  const hintMap: Record<string, string> = {
    menu: "這是菜單，請依序列出品項名稱與價格，跳過無關的裝飾性文字。",
    sign: "這是指示標示或招牌，請完整讀出所有文字，並說明方向或指示意涵。",
    letter: "這是信件或文件，請逐段讀出正文，保留段落結構。",
    product: "這是產品包裝，請讀出品名、成分、使用說明等重要資訊。",
    general: "請讀出照片中所有可辨識的文字。",
  };
  return `你是一位文字辨識助理，正在協助視障使用者閱讀文件。
${hintMap[hint] ?? hintMap.general}

請以繁體中文回傳 JSON 格式：
1. "rawText"：原始辨識文字，以換行分段
2. "spokenGuidance"：口語化版本（數字轉國字，如 120 → 一百二十；適合 TTS 朗讀）
3. "textFound"：布林值，照片中是否有可辨識文字`;
}
```

#### 目的地確認 Prompt

```typescript
export function confirmDestinationPrompt(
  placeName: string,
  placeTypes: string[],
  referencePhotoDescription?: string,
): string {
  return `你是一位無障礙導覽助理，正在協助視障使用者確認是否已抵達目的地。

目的地資訊：
- 名稱：${placeName}
- 類型：${placeTypes.join("、")}
${referencePhotoDescription ? `- 參考外觀描述：${referencePhotoDescription}` : ""}

請比對使用者拍攝的照片與以上目的地資訊，以繁體中文回傳 JSON 格式：
1. "matched"：布林值，照片是否與目的地相符
2. "confidence"：0.0–1.0 的信心度
3. "description"：比對說明（50–100 字）
4. "spokenGuidance"：給視障使用者的語音導引（30–60 字）
   - 若 matched=true：說明已抵達，並描述入口方向或無障礙通道
   - 若 matched=false：告知尚未抵達，建議繼續導航`;
}
```

### 5.3 回應 Schema 強制結構化輸出

與現有 `src/config/ai/config.ts` 的 `intentConfig`、`explainConfig` 相同，使用 `responseJsonSchema` 強制 Gemini 輸出結構化 JSON，避免 parsing 失敗。

```typescript
// src/modules/vision/vision.service.ts

const describeSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    spokenGuidance: { type: "string" },
  },
  required: ["description", "spokenGuidance"],
};

const readTextSchema = {
  type: "object",
  properties: {
    rawText: { type: "string" },
    spokenGuidance: { type: "string" },
    textFound: { type: "boolean" },
  },
  required: ["rawText", "spokenGuidance", "textFound"],
};

const confirmSchema = {
  type: "object",
  properties: {
    matched: { type: "boolean" },
    confidence: { type: "number" },
    description: { type: "string" },
    spokenGuidance: { type: "string" },
  },
  required: ["matched", "confidence", "description", "spokenGuidance"],
};
```

### 5.4 影像預處理與大小限制

```typescript
// src/modules/vision/vision.service.ts

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function validateBase64Image(data: string): Buffer {
  const buf = Buffer.from(data, "base64");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new VisionError("IMAGE_TOO_LARGE", 413);
  }
  return buf;
}
```

### 5.5 逾時與重試策略

```
Gemini Vision 呼叫
  ↓
AbortController timeout = 30s
  ↓（逾時）
503 VISION_UNAVAILABLE（不重試，避免佔用 event loop）
```

> Vision 呼叫比文字呼叫耗時，一般在 5–15 秒。設定 30 秒上限配合 Nginx 預設的 60 秒 upstream timeout，留足夠緩衝。**不做重試**：若模型過載，重試只會加重壅塞；前端應在 UI 層提示使用者重拍。

### 5.6 快取策略

| 屬性            | 說明                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| 快取鍵          | `vision:{task}:{sha256(imageBytes)}`                                                    |
| TTL             | 24 小時（同樣照片、同任務的分析結果穩定）                                               |
| 儲存位置        | Redis（`src/config/redis.ts`，與 walk-time 快取共用連線）                               |
| Cache-miss 成本 | Gemini Vision 約 $0.001–0.003 / 張（⚠️ 待確認：依 token 計費，視影像大小與輸出長度）    |
| 快取失效條件    | 僅依影像雜湊，相同影像不同 `context`/`hint` 視為不同快取鍵（鍵含 task + 輸入參數 hash） |

```typescript
// 快取鍵範例
// describe: "vision:describe:a3f2...8b1"
// read-text + hint: "vision:read-text:menu:a3f2...8b1"
// confirm: "vision:confirm:{placeId_or_destHash}:a3f2...8b1"
```

### 5.7 與 S1 路況回報影像處理的共用可能

S1 路況回報功能（交通事件影像辨識）若日後實作，其影像驗證（格式、大小）、base64→Buffer 轉換、SHA-256 雜湊快取等邏輯可抽取為共用 helper（如 `src/config/image-utils.ts`），避免重複實作。本規格建議在 `vision.service.ts` 中即以可複用的函式形式實作上述邏輯，預留未來提取介面。

### 5.8 將視覺能力包裝為 AI Agent 工具（Roadmap 選項）

現有 AI agent 有 7 個工具（`src/config/ai/tool.ts`、`agent-tools.ts`）。下一步可新增：

| 工具名稱              | 說明                                                          | 觸發情境                       |
| --------------------- | ------------------------------------------------------------- | ------------------------------ |
| `describeEnvironment` | 同 `/vision/describe`，但由 agent 在對話中呼叫                | 使用者說「幫我看看周圍有什麼」 |
| `readVisibleText`     | 同 `/vision/read-text`                                        | 使用者說「幫我讀這個招牌」     |
| `confirmArrival`      | 同 `/vision/confirm-destination`，搭配 agent 已知的導航目的地 | 使用者說「我到了，確認一下」   |

此為 **Roadmap Phase 3 選項**，非本版本必要交付項目。

---

## 6. 資料模型

本服務無需新增 MongoDB collection，所有狀態以 Redis 快取持存。

### 6.1 Redis 快取 Schema

```
Key:   "vision:{task}:{cacheKey}"
Type:  String（JSON）
TTL:   86400 秒（24 小時）

Value 範例（describe task）:
{
  "description":    "您正站在一個室外廣場...",
  "spokenGuidance": "前方是寬廣的人行道...",
  "cachedAt":       "2026-06-17T10:30:00.000Z"
}
```

### 6.2 快取鍵建構規則

```typescript
import { createHash } from "crypto";

function buildVisionCacheKey(
  task: "describe" | "read-text" | "confirm",
  imageBytes: Buffer,
  extra?: string, // hint、placeId 等區分相同影像不同請求的參數
): string {
  const imageHash = createHash("sha256").update(imageBytes).digest("hex");
  const extraHash = extra
    ? createHash("sha256").update(extra).digest("hex").slice(0, 8)
    : "";
  return `vision:${task}:${extraHash ? extraHash + ":" : ""}${imageHash}`;
}
```

---

## 7. 實作 Roadmap

### 待實作

| Phase                      | 功能                                                                                          | 優先度       | 依賴                                        |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------- |
| **Phase Vision-1**         | 核心基礎設施：模組骨架 + 影像驗證 + Redis 快取 + `USE_VISION_API` 開關                        | **Critical** | Redis 連線、GEMINI_MODEL                    |
| **Phase Vision-2**         | `describe` 端點：Gemini 多模態呼叫 + Prompt + 結構化輸出 + 逾時防護                           | **Critical** | Phase Vision-1                              |
| **Phase Vision-3**         | `read-text` 端點：OCR Prompt + hint 分類 + 數字國字轉換後處理                                 | High         | Phase Vision-1                              |
| **Phase Vision-4**         | `confirm-destination` 端點：Google Places 詳情取得 + 多模態比對                               | High         | Phase Vision-1、`src/config/map.ts`         |
| **Phase Vision-5（選配）** | AI Agent 工具整合：`describeEnvironment`、`readVisibleText`、`confirmArrival` 加入現有 7 工具 | Medium       | Phase Vision-2/3/4、`src/config/ai/tool.ts` |

---

### Phase Vision-1 — 核心基礎設施（詳細）

**新增檔案**

```
src/modules/vision/
├── vision.controller.ts
├── vision.service.ts
├── vision.router.ts
├── vision.schema.ts
└── vision.prompts.ts
```

**wire 進 app.ts**

```typescript
// src/app.ts（新增）
import visionRouter from "./modules/vision/vision.router";
app.use("/api/v1/a11y/vision", visionRouter);
```

**功能要點**

- `USE_VISION_API` 環境變數檢查：`false` 時所有端點直接回傳 `503 VISION_DISABLED`
- `validateBase64Image()`：解碼 + 大小檢查（> 5 MB → 413）
- `buildVisionCacheKey()`：SHA-256 雜湊
- Redis 快取讀寫封裝（async get/set，連線失敗 fail-soft 繼續呼叫 Gemini）

---

### Phase Vision-2 — `describe` 端點（詳細）

**核心流程**

```
收到請求
    ↓
Zod 驗證 (DescribeRequest)
    ↓
影像轉 Buffer（base64）或保留 URL
    ↓
建構快取鍵 → 查 Redis
    ↓（cache hit）→ 回傳快取結果（cached: true）
    ↓（cache miss）
AbortController（30s timeout）
    ↓
Gemini Vision 呼叫
  model: GEMINI_MODEL
  contents: [describePrompt(context), inlineImage or fileUri]
  responseJsonSchema: describeSchema
    ↓
解析 JSON → VisionDescribeResult
    ↓
寫入 Redis（TTL 24h）
    ↓
sendResponse()
```

---

### Phase Vision-4 — `confirm-destination` 端點（詳細）

**核心流程**

```
收到請求
    ↓
Zod 驗證 (ConfirmDestinationRequest)
    ↓
解析 destination：
  placeId → Google Places Details（map.ts）
  coords  → Google Places Nearby Search → 取最近一筆
  address → Google Geocoding + Places Search
    ↓
取得 placeName、placeTypes（+ 選配：place photo URL）
    ↓
建構快取鍵（task + imageHash + placeId/destHash）
    ↓（cache miss）
Gemini Vision 呼叫
  contents: [confirmDestinationPrompt(placeName, types, photoDesc?), inlineImage]
  responseJsonSchema: confirmSchema
    ↓
matched = confidence >= VISION_MATCH_THRESHOLD（預設 0.6）
    ↓
寫入 Redis + sendResponse()
```

> **Google Places 照片限制**：Places API 回傳的照片 URL 為授權 URL，有效期約 30 分鐘，**不適合**直接存入快取或當作長期參考。後端僅取照片進行一次性描述（由 Gemini 生成 `referencePhotoDescription` 文字），文字才存入快取。⚠️ 待確認：Places API v1 photo URL 是否可從後端直接 fetch（CORS 不適用於 server-to-server，但需確認 IP 限制）。

---

## 8. 測試策略

### 8.1 手動測試案例

| 測試案例               | 輸入                                    | 預期                                            |
| ---------------------- | --------------------------------------- | ----------------------------------------------- |
| 場景描述 — 捷運站出口  | 捷運站出口照片 + context "我在捷運出口" | description 含方向資訊，spokenGuidance 30–60 字 |
| 讀字 — 菜單            | 菜單照片 + hint "menu"                  | rawText 含品項與價格，spokenGuidance 數字轉國字 |
| 讀字 — 無文字影像      | 純風景照 + hint "general"               | `textFound: false`，spokenGuidance 告知無文字   |
| 目的地確認 — 正確地點  | 台北 101 外觀照 + placeId               | `matched: true`，`confidence >= 0.6`            |
| 目的地確認 — 錯誤地點  | 非台北 101 環境 + 台北 101 placeId      | `matched: false`，`confidence < 0.6`            |
| 影像過大               | base64 > 5 MB                           | 413 IMAGE_TOO_LARGE                             |
| 逾時防護               | 模擬 Gemini 不回應 30s                  | 503 VISION_UNAVAILABLE                          |
| 快取命中               | 同張照片送兩次                          | 第二次 `cached: true`，回應時間 < 100ms         |
| `USE_VISION_API=false` | 任意請求                                | 503 VISION_DISABLED                             |

### 8.2 驗證重點

- `spokenGuidance` 輸出不含 Markdown 符號（`**`、`-`、`#` 等），確保 TTS 朗讀正常
- `confidence` 欄位確為 0.0–1.0 浮點數（Gemini 有時回傳字串，需後處理解析）
- Redis 快取鍵衝突測試：相同影像 + 不同 hint 應命中不同快取項目
- `confirm-destination` 的 Places API 失敗時（404 / 網路錯誤）正確回傳 `DESTINATION_RESOLVE_FAILED`

---

## 9. 新增環境變數

| 變數                     | 用途                                              | 必要性 | 預設值             |
| ------------------------ | ------------------------------------------------- | ------ | ------------------ |
| `USE_VISION_API`         | 整體開關，`false` 時所有 `/vision/*` 端點回傳 503 | 選配   | `true`             |
| `VISION_MATCH_THRESHOLD` | `confirm-destination` 的 matched 信心度閾值       | 選配   | `0.6`              |
| `VISION_TIMEOUT_MS`      | Gemini Vision 呼叫逾時（毫秒）                    | 選配   | `30000`            |
| `VISION_MAX_IMAGE_BYTES` | base64 影像大小上限（bytes）                      | 選配   | `5242880`（5 MB）  |
| `VISION_CACHE_TTL_SECS`  | Redis 快取 TTL（秒）                              | 選配   | `86400`（24 小時） |

> 以上變數與現有 `GEMINI_API_URL`、`GEMINI_MODEL`、`GOOGLE_MAPS_API_KEY`、`REDIS_URL` 搭配使用，無需重複宣告。

---

## 10. 前端職責邊界

### 10.1 前端負責

| 職責             | 說明                                                           |
| ---------------- | -------------------------------------------------------------- |
| 相機拍攝         | 觸發裝置相機、取得影像 Blob                                    |
| 影像壓縮（選配） | 建議在送出前將影像壓縮至 2 MB 以下，降低上傳時間               |
| base64 編碼      | `Blob → base64` 轉換在前端完成，後端不接受 multipart/form-data |
| TTS 朗讀         | 以裝置 Web Speech API 或原生 TTS 朗讀 `spokenGuidance` 欄位    |
| 無障礙 UI        | 按鍵、焦點、螢幕閱讀器標籤等無障礙 UI 元件                     |
| 錯誤提示語音化   | 將 HTTP 錯誤（413、503 等）轉為使用者可理解的語音提示          |

### 10.2 前端不負責

| 禁止事項                          | 原因                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| 直接呼叫 Gemini Vision API        | API 金鑰安全性，所有 AI 呼叫由後端代理                             |
| 影像分析邏輯                      | 分析邏輯（prompt 設計、結構化輸出解析）在後端統一管理              |
| Google Places 呼叫                | API 金鑰安全性，目的地資料由後端取得                               |
| 快取管理                          | Redis 由後端管理，前端可依 `cached` 欄位顯示「使用快取結果」提示   |
| `spokenGuidance` 的國字轉換後處理 | 數字→國字、標點正規化皆在 `vision.prompts.ts` 的 prompt 指示中完成 |

---

## 11. 風險與緩解

| 風險                                 | 影響                                                      | 緩解措施                                                                                                       |
| ------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Gemini Vision 費用偏高**           | Vision 每張較純文字約貴 5–10×（⚠️ 待確認：以 token 計費） | SHA-256 快取（同照片 24h 不重算）；`USE_VISION_API=false` 可整體停用                                           |
| **Gemini Vision 延遲（5–15s）**      | 視障使用者等待體驗差                                      | 30s timeout 防止無限等待；前端在等待期間給予語音回饋（「正在分析中」）                                         |
| **`spokenGuidance` 輸出含 Markdown** | TTS 朗讀出符號（"星星"、"井號"）                          | Prompt 明確禁止 Markdown；後端後處理去除殘留符號（whitelist 合法字元）                                         |
| **`confidence` 數值不可信**          | Gemini 信心度非校準機率，可能虛高                         | 閾值設 0.6 而非 0.5；`matched` 僅作為輔助建議，`spokenGuidance` 不論 matched 值皆回傳，由使用者自行判斷        |
| **Google Places photo URL 授權過期** | confirm-destination 快取中的 photo URL 失效               | 快取儲存 Gemini 生成的文字描述，而非 URL；Places 呼叫在每次 cache miss 時重新進行                              |
| **Redis 連線失敗**                   | 快取不可用                                                | Fail-soft：Redis 錯誤不影響主流程，直接呼叫 Gemini，僅記錄 warning log                                         |
| **base64 注入攻擊**                  | 惡意影像內含指令操控 Gemini（prompt injection via image） | Prompt 明確說明角色與任務，輸出強制 JSON schema，忽略影像中的文字指令（prompt 不含「執行影像中的指令」語句）   |
| **TDX 額度衝突**                     | 大量視覺請求同時觸發 Places API，間接衝擊 TDX 額度管理    | Vision 端點直接呼叫 Google Maps API（非 TDX），與 TDX 額度無關；但需注意 Google Maps Places API 各自有每日配額 |
