# 緊急求救與家人通報系統

## Functional Specification — SOS Emergency & LINE Family Notification

**版本**：v1.0.1
**狀態**：Proposed — 待實作
**日期**：2026-07-07
**作者**：yuzen9622

> v1.0.0 修訂說明：前端已先行草擬過一版 API 規格，其中「加好友連結帶入 state token、由 follow event 解析並自動綁定」的綁定機制經查證**技術上不可行**（LINE 平台限制，詳見 §4），本規格將其正式否決並改以 **bindCode（6 碼綁定碼）** 取代。本文件為後端實作與前端對接的唯一依據，前端既有草案中與本文衝突之處以本文為準。
>
> v1.0.1 修訂（Opus 對抗式審查後修正，4 項 P1 + 4 項 P2 + 1 項 P3）：① SosSession 改用 unique partial index（`{userId:1}` + `partialFilterExpression: {status:"active"}`）擋 race，insert 撞 `E11000` 才 fallback 查既有 session（§5.2、§7.5）；② `lineUserId` 非唯一鍵，message 事件改列出所有已綁定聯絡人並依 active session 數量分流（0/1/多筆），unfollow 改 `updateMany`（§8.3）；③ 補上 webhook 路由層級錯誤處理器，攔截 `@line/bot-sdk` 拋出的 `SignatureValidationFailed` 轉 401（原設計會因 `app.ts` 無全域 error handler 而落到 Express 預設 500，§8.2）；④ 家人端 Agent 補 reply token ~1 分鐘時效與 push fallback 策略（§9、§11）；另補 bindCode 大小寫正規化、重複建立不重送推播、`findGooglePlaces` 無隱含定位需顯式帶入受困者座標、`express.raw()`／SDK 版本待實作核對、`sos.expire.ts` 先執行一次再進 `setInterval` 等澄清。

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統目標](#2-系統目標)
3. [系統架構](#3-系統架構)
4. [為何否決原設計：加好友連結帶 State Token](#4-為何否決原設計加好友連結帶-state-token)
5. [資料模型](#5-資料模型)
6. [LINE Messaging API 建立步驟](#6-line-messaging-api-建立步驟)
7. [API 規格](#7-api-規格)
8. [Webhook 簽章驗證與事件處理](#8-webhook-簽章驗證與事件處理)
9. [家人端 AI Agent（P1）](#9-家人端-ai-agentp1)
10. [背景 Job（P2）](#10-背景-jobp2)
11. [LINE 推播額度與風險](#11-line-推播額度與風險)
12. [分期 Roadmap](#12-分期-roadmap)
13. [測試策略](#13-測試策略)
14. [新增環境變數](#14-新增環境變數)
15. [新增 npm 依賴](#15-新增-npm-依賴)
16. [前端職責邊界](#16-前端職責邊界)
17. [風險與緩解](#17-風險與緩解)

---

## 1. 系統概述

緊急求救系統讓**已登入**使用者在遭遇人身危險（受困、受傷、需要立即協助）時，一鍵建立 SOS 求救紀錄，並自動透過 **LINE 官方帳號**將求救類型、姓名與即時位置的公開追蹤連結，以 Flex Message 推播給使用者事先綁定的最多 5 位緊急聯絡人。家人收到通知後可直接在 LINE 對話中與**家人端 AI Agent** 互動——查詢即時位置、附近醫院／無障礙設施、規劃前往路線、或按「我來處理」認領處理，AI Agent 底層重用既有 `src/modules/ai/agent-tools.ts` 的工具生態（`findGooglePlaces`、`findA11yPlaces`、`planAccessibleRoute` 等），不重新造輪子。

聯絡人與 LINE 帳號的綁定，因 LINE 平台限制（見 §4）無法透過「加好友連結帶 state」自動完成，改採**綁定碼（bindCode）**：使用者在 App 建立聯絡人後取得 6 碼綁定碼與加好友連結，轉發給家人；家人加好友後，在對話中輸入該碼完成綁定。

系統架構沿用專案既有的 Express + TypeScript + MongoDB(Mongoose) 技術棧，一般端點統一以 `sendResponse()`（`src/config/lib.ts`）包裝回應、Zod 負責邊界驗證；LINE Webhook 端點則因平台簽章驗證需求，走獨立的原始 body 處理路徑（見 §8）。

---

## 2. 系統目標

### 2.1 核心能力

- 使用者可管理最多 5 位緊急聯絡人（新增／列表／刪除），每位聯絡人綁定一組 LINE 帳號
- 綁定機制不依賴 LINE follow event 帶入自訂狀態（該路徑已驗證不可行，見 §4），改用 bindCode 人工輸入完成綁定
- 一鍵建立 SOS 求救（受困 / 人身安全 / 分享位置），自動 multicast 推播 Flex Message 給所有已綁定聯絡人
- 求救進行中，前端每 10–15 秒回報一次最新位置（`PATCH .../location`）
- 求救解除時推播全員「已解除」訊息
- 提供**免登入**的公開追蹤頁端點，供聯絡人在瀏覽器查看即時位置（無需加入 LINE 官方帳號也可看，連結本身即憑證）
- 家人端可在 LINE 對話中與 AI Agent 互動：問位置、問附近醫院/設施、規劃前往路線、認領處理（P1）
- 背景 Job：24 小時未解除自動結案、10 分鐘無位置更新發出「疑似斷線」警示（P2）

### 2.2 非功能目標

| 目標                 | 說明                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| 綁定不可偽造狀態穿透 | 不假設 LINE 平台會回傳任何自訂 state，綁定完全由後端 bindCode 比對驅動               |
| Push 額度意識        | 家人端對話一律走 reply token（免費），僅 SOS 開始/解除/警示走 push（計額度），見 §11 |
| Webhook 快速 ACK     | 簽章驗證通過後立即回 200，事件處理非同步進行，避免 LINE 平台重送                     |
| Fail-soft 推播       | 推播失敗（如聯絡人已封鎖官方帳號）僅記錄，不阻擋 SOS 建立/回應                       |
| 公開追蹤頁最小揭露   | `shareToken` 高熵、24 小時後失效，明確標示為「接受的風險」而非解決方案（見 §17）     |
| 不取代正式求救管道   | AI Agent 對話中不得暗示「已幫忙叫救護車」等，逾時需引導撥打 119/110                  |

---

## 3. 系統架構

### 3.1 請求流程

一般（已登入）端點沿用既有單一方向流程；LINE Webhook 因需要 HMAC 簽章驗證原始 body，是**唯一**必須掛在全域 `express.json()` **之前**的路由，架構上是本專案目前的例外，需在 `app.ts` 中特別標注。

```
【一般端點：聯絡人 CRUD / SOS 生命週期 / 公開追蹤】

Client Request
      ↓
Express 入口 (src/app.ts)
      ↓
[emergency-contact 走 /api/v1/user 前綴，SOS 走 /api/v1/sos 前綴]
Auth Middleware (src/middleware/middleware.ts) — 驗 JWT、注入 req.auth = { userId, user }
  （SOS 公開追蹤端點 GET /sos/:token/public 不掛 auth）
      ↓
validateRequest(schema) (src/middleware/validate-request.middleware.ts) — Zod 驗 body/query/params
      ↓
Controller（*.controller.ts）← 薄層：讀 req.auth/req.validated → 呼叫單一 service 方法 → sendResponse()
      ↓
Service（*.service.ts）← 純業務，無 req/res
  ├─ emergency-contact.service.ts → 綁定碼生成/校驗、5 筆上限
  └─ sos.service.ts               → 建立/更新/解除 session、觸發推播
      ↓
adapters/line.adapter.ts（push / multicast / reply / Flex 模板）──→ LINE Messaging API
      ↓
Model（emergency-contact.model.ts / sos-session.model.ts）— Mongoose
      ↓
sendResponse(res, ok, status, ResponseCode.*, message, data?) → ApiResponse<T>


【LINE Webhook：獨立路徑，必須掛在 express.json() 之前】

LINE Platform (POST /api/v1/line/webhook)
      ↓
express.raw({ type: "application/json" })  ← 保留原始 body 供簽章驗證，取代全域 json parser
      ↓
@line/bot-sdk middleware（HMAC-SHA256 驗 x-line-signature，對照 LINE_CHANNEL_SECRET）
  失敗 → 401，不進 controller
      ↓
line.controller.ts → 立即回 200（LINE 要求快速 ACK）
      ↓
非同步事件分派（line.service.ts）
  ├─ follow    → 歡迎訊息 + 詢問綁定碼
  ├─ message   → 優先序：① 比對 pending bindCode ② 已綁定聯絡人且對象有 active SOS → family-agent.service.ts
  │              ③ 皆不符 → 固定說明訊息
  └─ unfollow  → 對應聯絡人 bindStatus 復原為 pending、清空 lineUserId
      ↓
adapters/line.adapter.ts（reply：免費 / push：計額度）
```

### 3.2 模組目錄結構

```
src/
├── app.ts                                   # 擴充：line webhook 掛在 express.json() 之前；其餘照既有慣例
├── modules/
│   ├── emergency-contact/
│   │   ├── index.ts                         # export { createEmergencyContactRouter }
│   │   ├── emergency-contact.router.ts      # transport：掛在 /api/v1/user 前綴（沿用既有 JWT 全域保護）
│   │   ├── emergency-contact.schema.ts      # Zod：CreateContactSchema / ContactIdParamSchema
│   │   ├── emergency-contact.controller.ts  # 讀 req.auth/req.validated → 呼叫單一 service → sendResponse
│   │   ├── emergency-contact.service.ts     # 5 筆上限、bindCode 生成（24h 到期）、owner 檢查
│   │   └── emergency-contact.types.ts       # 模組內 DTO
│   ├── sos/
│   │   ├── index.ts                         # export { createSosRouter }
│   │   ├── sos.router.ts                    # transport：3 端點掛 middleware，1 個公開端點不掛
│   │   ├── sos.schema.ts                    # Zod：CreateSosSchema / UpdateLocationSchema / SessionIdParamSchema / ShareTokenParamSchema
│   │   ├── sos.controller.ts                # 薄層
│   │   ├── sos.service.ts                   # 建立/查重/更新/解除、觸發 line.adapter 推播、shareToken 生成
│   │   ├── sos.expire.ts                    # 背景 Job：24h 自動解除、10 分鐘斷線警示（P2）
│   │   └── sos.types.ts                     # 模組內 DTO
│   └── line/
│       ├── index.ts                         # export { createLineRouter }
│       ├── line.router.ts                   # transport：POST /webhook，需接在 express.json() 之前掛載
│       ├── line.middleware.ts               # @line/bot-sdk 簽章驗證中介層封裝
│       ├── line.controller.ts               # 立即回 200、委派 line.service 非同步處理
│       ├── line.service.ts                  # follow/message/unfollow 事件分派、bindCode 比對、綁定狀態轉換
│       ├── family-agent.service.ts          # P1：家人端對話 Agent，重用 agent-tools.ts 的 executeLocalTool
│       └── line.types.ts                    # LINE webhook event 型別、內部 DTO
├── adapters/
│   └── line.adapter.ts                      # 新增：封裝 @line/bot-sdk messagingApi.MessagingApiClient
│                                             #   push(to, messages) / multicast(to[], messages) / reply(replyToken, messages)
│                                             #   Flex Message 模板 builder（SOS 通知卡、解除卡、認領卡）
├── model/
│   ├── emergency-contact.model.ts           # Mongoose model
│   └── sos-session.model.ts                 # Mongoose model
├── server.ts                                # 擴充：mongoose 連線後 startSosExpiryJob()（P2，沿用 hazard-report 慣例）
└── openapi/document.ts                      # 擴充：side-effect import emergency-contact.schema / sos.schema
```

### 3.3 各層職責（clean-architecture 契約）

| 層           | 檔案                                                                                              | 唯一職責                                                                      | 不可以做                         |
| ------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| transport    | `emergency-contact.router.ts` / `sos.router.ts` / `line.router.ts`                                | 宣告 path/method、串 middleware、委派**單一** controller                      | 業務邏輯、直接呼叫 model         |
| validation   | `emergency-contact.schema.ts` / `sos.schema.ts`                                                   | Zod 宣告 body/query/params 並拒絕未知欄位                                     | I/O、業務規則                    |
| handler      | `*.controller.ts`                                                                                 | 讀 `req.auth`/`req.validated`，呼叫**一個** service 方法，`sendResponse` 包裝 | 業務 if/else、外部/DB 呼叫       |
| domain       | `emergency-contact.service.ts` / `sos.service.ts` / `line.service.ts` / `family-agent.service.ts` | 業務邏輯與協調，呼叫 adapter / model                                          | import `req`/`res`、驗證請求形狀 |
| webhook 簽章 | `line.middleware.ts`                                                                              | 封裝 `@line/bot-sdk` HMAC-SHA256 驗證、快速 ACK                               | 業務邏輯                         |
| I/O client   | `adapters/line.adapter.ts`                                                                        | 封裝 LINE Messaging API（push/multicast/reply/Flex 模板）                     | 業務決策、HTTP envelope          |
| types        | `*.types.ts`                                                                                      | 模組內 DTO；跨模組共用型別放 `src/types/`（沿用既有 reorg 慣例）              | 邏輯、執行期值                   |

### 3.4 需動到的共用 spine

| 變更                         | 檔案                      | 原因                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook 例外掛載順序         | `src/app.ts`              | `POST /api/v1/line/webhook` 必須掛在第 41 行 `app.use(express.json({ limit: "10mb" }))` **之前**（改用 `express.raw({ type: "application/json" })` 保留原始 body），否則簽章驗證會因 body 已被消耗而永遠失敗                                                    |
| 第二個 `/api/v1/user` 掛載點 | `src/app.ts`              | 既有 `app.use("/api/v1/user", middleware, createUserRouter())`（第 65 行）僅涵蓋 `createUserRouter()`；新增 `app.use("/api/v1/user", middleware, createEmergencyContactRouter())`，兩次掛載各自帶 `middleware`（Express 中介層不會跨 `app.use()` 呼叫自動延續） |
| 新前綴                       | `src/app.ts`              | 新增 `app.use("/api/v1/sos", createSosRouter())`——router 內對 3 個保護端點個別掛 `middleware`（沿用 `hazard-report.router.ts` 的 per-route 掛法），公開追蹤端點不掛                                                                                             |
| docs 來源                    | `src/openapi/document.ts` | side-effect import `emergency-contact.schema` / `sos.schema`，讓 `/docs` 自動同步                                                                                                                                                                               |
| env                          | `.env.example`            | 新增 `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `PUBLIC_TRACKING_BASE_URL`                                                                                                                                                                           |

> `ResponseCode` 已具備本功能所需的全部狀態碼（`GONE=410`、`INVALID_INPUT=400`、`FORBIDDEN=403`、`NOT_FOUND=404` 等，見 `src/types/code.ts`），**不需要新增 enum 值**。

---

## 4. 為何否決原設計：加好友連結帶 State Token

**原設計（前端草案，已否決）**：使用者建立聯絡人時，後端產生一個「加好友連結」，連結中嵌入自訂 state（例如 `userId` 或聯絡人 `contactId`），家人點擊連結加入官方帳號好友後，LINE 平台在 `follow` webhook 事件中把該 state 一併回傳，後端解析 state 即可自動完成綁定，全程不需要家人手動輸入任何東西。

**否決原因（技術不可行，非設計偏好）**：

1. **加好友連結格式固定，不支援自訂 query 穿透到 follow 事件**：LINE 官方帳號的加好友連結為 `https://line.me/R/ti/p/@{basicId}`（或含 LIFF 的變形），此連結由 LINE 平台代管導轉，**不是**後端可控的中繼頁；即使在連結後方硬接 query string，LINE 的導轉流程也不會把這些參數保留並回傳給 webhook。
2. **`follow` event payload 本身沒有自訂欄位**：LINE 的 `follow` webhook 事件 payload 固定只有 `replyToken`、`source.userId`、`timestamp` 等平台欄位，**不存在**可供開發者塞入業務資料（如 `contactId`）的欄位。除非透過 **LIFF（LINE Front-end Framework）搭配 LINE Login** 另建一個網頁流程，在網頁端讀取 LIFF context 並回傳給後端——但這已經是完全不同的技術棧與使用者流程（需要開一個瀏覽器頁面、走 LINE Login OAuth），超出本期範圍，且對「家人隨手加好友」的低摩擦體驗是負分。
3. **結論**：凡是「加好友連結」都無法攜帶可回收的自訂狀態，follow 事件端也收不到。任何試圖靠連結參數自動配對使用者與 LINE 帳號的設計，在 LINE 平台上都會落空。

**新設計（bindCode，本規格採用）**：既然 follow 事件無法帶狀態，就把「配對」這一步從平台事件搬到**使用者主動輸入的訊息內容**——這是 `message` 事件唯一保證會攜帶、且完全由後端定義格式的資料管道。流程：

1. 使用者建立聯絡人 → 後端產生 6 碼英數 `bindCode`（24 小時內有效）與官方加好友連結（固定 `https://line.me/R/ti/p/@{basicId}`，不帶任何自訂參數）。
2. 使用者把連結 + 綁定碼轉發給家人（App 內顯示、可分享）。
3. 家人加好友 → `follow` 事件觸發 → 官方帳號自動回覆歡迎訊息，提示「請輸入好友分享給你的 6 碼綁定碼」。
4. 家人在對話中輸入綁定碼（純文字 `message` 事件）→ 後端比對所有 `bindStatus: pending` 且未過期的 `bindCode` → 命中則將該聯絡人的 `lineUserId` 設為 `event.source.userId`、`bindStatus` 改為 `bound`，回覆綁定成功訊息。

**取捨**：多了一步「手動輸入 6 碼」，體驗略遜於原本設想的全自動，但這是 LINE 平台限制下**唯一可行**的路徑；6 碼 + 24 小時到期在便利性與被誤綁風險間取得平衡（風險分析見 §17）。

---

## 5. 資料模型

### 5.1 EmergencyContact（`src/model/emergency-contact.model.ts`）

```typescript
import { Schema, model } from "mongoose";
import type { IEmergencyContact } from "../types";

const emergencyContactSchema = new Schema<IEmergencyContact>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, maxlength: 50 },

    lineUserId: { type: String, default: null },
    bindStatus: {
      type: String,
      enum: ["pending", "bound"],
      default: "pending",
    },
    bindCode: { type: String, default: null },
    bindCodeExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// 依 userId 列出聯絡人、依 createdAt 排序（5 筆上限在 service 層檢查，不在 schema 層限制）
emergencyContactSchema.index({ userId: 1, createdAt: -1 });
// bindCode 需全域唯一以支援 O(1) 查找比對；sparse 允許已綁定聯絡人的 bindCode 為 null
emergencyContactSchema.index({ bindCode: 1 }, { unique: true, sparse: true });
// unfollow 事件需以 lineUserId 反查聯絡人
emergencyContactSchema.index({ lineUserId: 1 }, { sparse: true });

const EmergencyContact = model<IEmergencyContact>(
  "EmergencyContact",
  emergencyContactSchema,
);

export default EmergencyContact;
```

`IEmergencyContact`（`src/types/index.d.ts`，沿用專案「跨模組型別集中放 `src/types/`」慣例）：

```typescript
export interface IEmergencyContact {
  _id: string;
  userId: string;
  name: string;
  lineUserId: string | null;
  bindStatus: "pending" | "bound";
  bindCode: string | null;
  bindCodeExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

> 上限 5 筆聯絡人在 `emergency-contact.service.ts` 建立前以 `EmergencyContact.countDocuments({ userId })` 檢查，超過回 400（非 schema 層限制，理由與 model 不掛業務規則的分層原則一致）。`unfollow` 事件觸發時，`line.service.ts` 以 `lineUserId` 找到聯絡人並執行 `bindStatus: "pending"`、`lineUserId: null`（見 §8）。

### 5.2 SosSession（`src/model/sos-session.model.ts`）

```typescript
import { Schema, model } from "mongoose";
import type { ISosSession } from "../types";

const sosSessionSchema = new Schema<ISosSession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["body", "trapped", "share_location"],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "resolved"],
      default: "active",
    },

    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    address: { type: String, default: null },

    // crypto.randomBytes(16).toString("hex") — 刻意不用 Mongo ObjectId：
    // ObjectId 可列舉/遞增，猜得到相鄰 id 就能看到別人的即時位置，是嚴重隱私外洩面
    shareToken: { type: String, required: true },

    locationUpdatedAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    claimedBy: {
      type: Schema.Types.ObjectId,
      ref: "EmergencyContact",
      default: null,
    },

    // 10 分鐘無位置更新警示是否已發送過（避免重複推播，見 §10）
    staleAlertSent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// 同一使用者同時只能有一個 active session——用唯一「部分索引」在 DB 層擋住 race，
// 而非只靠 service 層 check-then-insert（雙擊恐慌按鈕會在兩個平行請求都通過檢查後各自
// insert 成功，造成 2 筆 active session + 重複推播）。寫法比照本專案既有先例
// src/model/gtfs-stop.model.ts:20-23（gtfsStopSchema 對 location 的 2dsphere 索引即用
// partialFilterExpression 限定 locationType，此處同樣手法用在 unique 索引上）。
sosSessionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
// 公開追蹤端點以 shareToken 查找，需唯一且高效
sosSessionSchema.index({ shareToken: 1 }, { unique: true });
// 背景 Job 掃描：24h 自動解除
sosSessionSchema.index({ status: 1, createdAt: 1 });
// 背景 Job 掃描：10 分鐘斷線警示
sosSessionSchema.index({ status: 1, locationUpdatedAt: 1 });

const SosSession = model<ISosSession>("SosSession", sosSessionSchema);

export default SosSession;
```

`ISosSession`（`src/types/index.d.ts`）：

```typescript
export interface ISosSession {
  _id: string;
  userId: string;
  type: "body" | "trapped" | "share_location";
  status: "active" | "resolved";
  lat: number;
  lng: number;
  address?: string | null;
  shareToken: string;
  locationUpdatedAt: Date;
  resolvedAt?: Date | null;
  claimedBy?: string | null;
  staleAlertSent: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

> **只允許一個 active session（race-safe）**：`sos.service.ts` 建立時**直接嘗試 insert**，不先 check-then-insert（後者在雙擊恐慌按鈕的並發請求下無法防止兩筆 active session 同時被建立）。真正的唯一性保證來自上方的 unique partial index：若 insert 撞到 `E11000 duplicate key` 錯誤，代表同一使用者已有一筆 active session 存在——此時 catch 該錯誤、改用 `findOne({ userId, status: "active" })` 查出既有 session 並直接回傳，HTTP **200**（非 201，因為沒有新建任何東西，也**不**重新觸發 multicast 推播，見 §7.5）。

---

## 6. LINE Messaging API 建立步驟

本功能依賴的 LINE 官方帳號 **尚未建立**，實作前需先完成以下設定（一次性，由專案負責人操作）：

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)，登入 LINE 帳號。
2. 建立一個 **Provider**（若尚未有，可用專案名稱，如「無障礙智慧地圖」）。
3. 在該 Provider 下建立一個 **Messaging API Channel**（頻道類型選 Messaging API，非 LINE Login）。填入頻道名稱、說明、圖示、分類等基本資料。
4. 進入該 Channel 的「Messaging API」分頁：
   - 取得 **Channel access token（long-lived）**：點選「Issue」產生，對應 `LINE_CHANNEL_ACCESS_TOKEN`。
   - 取得 **Channel secret**：在「Basic settings」分頁，對應 `LINE_CHANNEL_SECRET`。
5. 設定 **Webhook URL**：填入 `https://<你的網域>/api/v1/line/webhook`，並開啟「Use webhook」。
   - **必須是 https**：LINE 平台不接受 http 或未受信任憑證的 URL。
   - **本機開發**：後端跑在 Docker（本機通常是 `localhost:5001` 等），需用 [ngrok](https://ngrok.com/) 或 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) 開一條臨時公開 https 隧道指向本機埠，把隧道網址填進 webhook URL。
   - 設定完成後可用 Console 內建的「Verify」按鈕測試連通性。
6. 關閉「自動回應訊息」（Auto-reply messages）與「加入好友的歡迎訊息」（Greeting messages）的**官方預設行為**——這兩者由本系統的 `follow`／`message` webhook 處理邏輯自行接管（見 §8），避免與自訂歡迎詞衝突重複發送。
7. 取得官方帳號的 **Basic ID**（形如 `@xxxxxxx`），用於組出加好友連結 `https://line.me/R/ti/p/@xxxxxxx`（見 §4、§7.2）。

> ⚠️ 待確認：正式上線前需確認 LINE 帳務方案（Communication Plan / Light Plan，見 §11）與帳號驗證等級（未驗證帳號的好友上限與部分功能限制）。

---

## 7. API 規格

### 7.1 端點總覽

| Method | Path                                  | 功能                            | 認證                |
| ------ | ------------------------------------- | ------------------------------- | ------------------- |
| GET    | `/api/v1/user/emergency-contacts`     | 列出我的緊急聯絡人              | JWT                 |
| POST   | `/api/v1/user/emergency-contacts`     | 新增緊急聯絡人（回傳 bindCode） | JWT                 |
| DELETE | `/api/v1/user/emergency-contacts/:id` | 刪除緊急聯絡人                  | JWT                 |
| POST   | `/api/v1/line/webhook`                | LINE 平台事件回呼               | LINE 簽章（非 JWT） |
| POST   | `/api/v1/sos/sessions`                | 建立 SOS 求救                   | JWT                 |
| PATCH  | `/api/v1/sos/sessions/:id/location`   | 更新求救中位置                  | JWT（限本人）       |
| PATCH  | `/api/v1/sos/sessions/:id/resolve`    | 解除求救                        | JWT（限本人）       |
| GET    | `/api/v1/sos/sessions/:token/public`  | 公開追蹤頁查詢                  | 無（token 即憑證）  |

### 7.2 GET /api/v1/user/emergency-contacts — 列出緊急聯絡人

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "OK",
  "data": {
    "contacts": [
      {
        "_id": "66a1f0...",
        "name": "媽媽",
        "bindStatus": "bound",
        "lineUserId": "U4af49...",
        "createdAt": "2026-07-01T02:00:00.000Z"
      },
      {
        "_id": "66a1f1...",
        "name": "哥哥",
        "bindStatus": "pending",
        "lineUserId": null,
        "bindCodeExpiresAt": "2026-07-08T02:00:00.000Z",
        "createdAt": "2026-07-07T02:00:00.000Z"
      }
    ]
  }
}
```

> `lineUserId` 對前端無實質用途，僅供除錯；正式回應可視隱私考量遮蔽（⚠️ 待確認，非阻塞項）。

### 7.3 POST /api/v1/user/emergency-contacts — 新增緊急聯絡人

**Zod Schema（`emergency-contact.schema.ts`）**

```typescript
import { z } from "zod";

export const CreateEmergencyContactSchema = z
  .object({
    name: z.string().min(1).max(50),
  })
  .strict();
```

**請求範例**

```json
{ "name": "媽媽" }
```

**成功回應（201）**

```json
{
  "ok": true,
  "status": "success",
  "code": 201,
  "message": "聯絡人已建立，請將綁定連結與綁定碼分享給對方",
  "data": {
    "contact": {
      "_id": "66a1f1...",
      "name": "媽媽",
      "bindStatus": "pending",
      "bindCodeExpiresAt": "2026-07-08T02:00:00.000Z"
    },
    "bindUrl": "https://line.me/R/ti/p/@xxxxxxx",
    "bindCode": "K7X2QD"
  }
}
```

**錯誤碼**

| HTTP（ResponseCode） | data.reason             | message                           | 說明                              |
| -------------------- | ----------------------- | --------------------------------- | --------------------------------- |
| 400 `INVALID_INPUT`  | `CONTACT_LIMIT_REACHED` | 緊急聯絡人已達上限（5 位）        | `countDocuments({ userId }) >= 5` |
| 400 `INVALID_INPUT`  | —                       | Zod 驗證失敗（`name` 空白或超長） | 邊界驗證                          |

### 7.4 DELETE /api/v1/user/emergency-contacts/:id — 刪除緊急聯絡人

**錯誤碼**

| HTTP（ResponseCode） | data.reason         | message          | 說明                                 |
| -------------------- | ------------------- | ---------------- | ------------------------------------ |
| 403 `FORBIDDEN`      | `NOT_CONTACT_OWNER` | 無權刪除此聯絡人 | `contact.userId !== req.auth.userId` |
| 404 `NOT_FOUND`      | `CONTACT_NOT_FOUND` | 找不到該聯絡人   | id 不存在                            |

**成功回應（205 `DELETED`，沿用專案既有刪除語意）**

```json
{
  "ok": true,
  "status": "success",
  "code": 205,
  "message": "已刪除",
  "data": null
}
```

### 7.5 POST /api/v1/sos/sessions — 建立 SOS 求救

**Zod Schema（`sos.schema.ts`）**

```typescript
import { z } from "zod";

export const CreateSosSchema = z
  .object({
    type: z.enum(["body", "trapped", "share_location"]),
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    address: z.string().max(200).optional(),
  })
  .strict();
```

**請求範例**

```json
{
  "type": "trapped",
  "lat": 25.033,
  "lng": 121.5654,
  "address": "台北市信義區松壽路上"
}
```

**成功回應（201，新建）**

```json
{
  "ok": true,
  "status": "success",
  "code": 201,
  "message": "已發出求救通知",
  "data": {
    "sessionId": "66a20a...",
    "shareToken": "9f3a1c...e02b",
    "notifiedCount": 2
  }
}
```

**成功回應（200，已有 active session，回傳既有紀錄）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "已有進行中的求救",
  "data": {
    "sessionId": "66a20a...",
    "shareToken": "9f3a1c...e02b",
    "notifiedCount": 2
  }
}
```

> `notifiedCount` 為 multicast 推播成功／嘗試的聯絡人數（best-effort，個別推播失敗不影響此請求成功；聯絡人數為 0 時 `notifiedCount: 0`，session 仍正常建立）。
>
> **重複建立不重送通知**：上方「200，已有 active session」路徑走的是 §5.2 所述的 insert 撞唯一索引後 fallback 查詢，回傳的是**既有** session，其 `notifiedCount` 是原本建立當下那一次的通知結果——這條路徑本身**不會**重新觸發 multicast 推播，避免使用者反覆點擊求救按鈕造成聯絡人被重複轟炸。

### 7.6 PATCH /api/v1/sos/sessions/:id/location — 更新位置

**Zod Schema**

```typescript
export const UpdateSosLocationSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    address: z.string().max(200).optional(),
  })
  .strict();
```

前端於求救進行中每 10–15 秒呼叫一次。

**錯誤碼**

| HTTP（ResponseCode） | data.reason          | message            | 說明                                 |
| -------------------- | -------------------- | ------------------ | ------------------------------------ |
| 403 `FORBIDDEN`      | `NOT_SESSION_OWNER`  | 無權更新此求救紀錄 | `session.userId !== req.auth.userId` |
| 400 `INVALID_INPUT`  | `SESSION_NOT_ACTIVE` | 此求救已結束       | `status !== "active"`                |
| 404 `NOT_FOUND`      | `SESSION_NOT_FOUND`  | 找不到該求救紀錄   | id 不存在                            |

### 7.7 PATCH /api/v1/sos/sessions/:id/resolve — 解除求救

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "已解除求救",
  "data": { "sessionId": "66a20a...", "status": "resolved" }
}
```

錯誤碼與 §7.6 相同（`NOT_SESSION_OWNER` / `SESSION_NOT_ACTIVE` / `SESSION_NOT_FOUND`）。解除成功後推播全員「已解除」訊息（best-effort，失敗不影響本次回應）。

### 7.8 GET /api/v1/sos/sessions/:token/public — 公開追蹤頁

**無認證**，供家人在瀏覽器（非 LINE 對話內）打開追蹤連結時使用。

**Zod Schema**

```typescript
export const ShareTokenParamSchema = z
  .object({ token: z.string().length(32) })
  .strict();
```

**成功回應（200）**

```json
{
  "ok": true,
  "status": "success",
  "code": 200,
  "message": "OK",
  "data": {
    "type": "trapped",
    "status": "active",
    "lat": 25.033,
    "lng": 121.5654,
    "address": "台北市信義區松壽路上",
    "updatedAt": "2026-07-07T03:12:00.000Z"
  }
}
```

**錯誤碼**

| HTTP（ResponseCode） | data.reason         | message          | 說明                                                 |
| -------------------- | ------------------- | ---------------- | ---------------------------------------------------- |
| 404 `NOT_FOUND`      | `SESSION_NOT_FOUND` | 找不到此追蹤連結 | token 不存在                                         |
| 410 `GONE`           | `TRACKING_EXPIRED`  | 此追蹤連結已失效 | `status === "resolved"` 且 `resolvedAt` 超過 24 小時 |

---

## 8. Webhook 簽章驗證與事件處理

### 8.1 掛載順序（關鍵限制）

`app.ts` 目前於第 41 行 `app.use(express.json({ limit: "10mb" }))` 對所有後續路由套用 JSON body parser。LINE 的簽章驗證演算法（HMAC-SHA256）必須對**未經解析的原始 request body** 計算，一旦被 `express.json()` 讀取並解析過，原始 byte stream 就消失，簽章永遠對不上。

因此 `createLineRouter()` 的掛載**必須寫在第 41 行之前**：

```typescript
// app.ts —— 必須在 express.json() 之前
app.use("/api/v1/line", createLineRouter()); // 內部用 express.raw() 取代 json()

app.use(express.json({ limit: "10mb" })); // 第 41 行，其餘路由沿用
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// ... 其餘既有 app.use(...) 不變
```

`line.router.ts` 內對 webhook 路由套用 `express.raw({ type: "application/json" })`，取得 `req.body` 為 `Buffer`，再交給 `@line/bot-sdk` 的 middleware 驗證。

> ⚠️ 待確認（實作前需以實際安裝的 `@line/bot-sdk` 版本核對）：本專案目前**尚未安裝** `@line/bot-sdk`（見 §15），無法從已安裝套件直接確認其 v11 `middleware()` 是否自行讀取/緩衝 raw body、或必須依賴應用層預先以 `express.raw()` 轉出 `Buffer` 才能取得未解析內容。本規格先假設需要顯式 `express.raw()`（較保守、較不依賴 SDK 內部實作細節的組合方式），但實作時務必對照當時實際安裝版本的型別定義或官方文件核對這段組合關係，避免 body 被重複讀取或驗證時拿到 `undefined`。

### 8.2 簽章驗證

使用 `@line/bot-sdk` v11 內建的 `middleware({ channelSecret })`：對 `req.body`（raw Buffer）以 `LINE_CHANNEL_SECRET` 做 HMAC-SHA256，Base64 編碼後與請求標頭 `x-line-signature` 比對。

> **重要（已用 Read/Grep 驗證）**：`@line/bot-sdk` 的 `middleware()` 在簽章不符時是**拋出** `SignatureValidationFailed` 例外，不是回傳一般的 4xx response。已確認 `src/app.ts` 目前**沒有任何** 4 參數 `(err, req, res, next)` 的錯誤處理 middleware——整份檔案結尾只有一個 `app.use("*", ...)` 404 catch-all（`app.ts:79-87`），沒有全域 `try/catch` 或 error-handling middleware 攔截同步/非同步拋出的例外。若不特別處理，簽章驗證失敗會直接掉進 Express 預設錯誤處理器，回傳未經 `sendResponse()` 包裝的 **500** HTML 錯誤頁，而非規格原意的 401。

因此需在 webhook 路由的 middleware 鏈**最後**加一個路由層級（僅此路由適用，非全域）的 4 參數錯誤處理器，專門攔截 `SignatureValidationFailed` 並以 `sendResponse()` 包成 401；其他型別的錯誤一律 `next(err)` 往下丟，不吞掉：

```typescript
import {
  middleware as lineSignatureMiddleware,
  SignatureValidationFailed,
} from "@line/bot-sdk";
import { sendResponse } from "../../config/lib";
import { ResponseCode, ResponseMessage } from "../../types/code";

router.post(
  "/webhook",
  lineSignatureMiddleware({ channelSecret: process.env.LINE_CHANNEL_SECRET! }),
  handleLineWebhook,
  // 路由層級錯誤處理器：只接在這個路由後面，不影響其他路由，也不需要改 app.ts 加全域 error handler
  (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SignatureValidationFailed) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.UNAUTHORIZED,
        ResponseMessage.UNAUTHORIZED,
      );
    }
    next(err);
  },
);
```

> ⚠️ 待確認：`SignatureValidationFailed` 的確切匯出名稱／例外型別需以實際安裝的 `@line/bot-sdk` 版本為準（本規格撰寫時該套件尚未安裝於本專案，見 §15），實作時應以型別定義或官方文件核對後調整 catch 條件。

### 8.3 事件處理優先序

Controller 收到請求後**先回 200**（LINE 平台若在數秒內收不到 200 會判定失敗並重送，可能造成事件重複處理），再非同步跑事件迴圈：

```
for event of events:
  switch event.type:
    case "follow":
      → 回覆歡迎訊息：「歡迎加入！請輸入朋友分享給你的 6 碼綁定碼以完成綁定。」

    case "message"（text）:
      1. 文字正規化為大寫（.toUpperCase()，見下方說明）後符合 6 碼英數格式
         → 查找 pending 且未過期、bindCode 相符（bindCode 儲存時也已 .toUpperCase()）的 EmergencyContact
         命中 → lineUserId = event.source.userId, bindStatus = "bound"，回覆綁定成功
         查無 → 落到步驟 2（可能已過期或打錯）
      2. 查出 event.source.userId 對應的**所有**已綁定 EmergencyContact——`lineUserId` 並非唯一鍵
         （例如同一位家長可能同時是兩個孩子的緊急聯絡人），因此不能只抓第一筆：
           - 檢查這些聯絡人各自的 userId 目前是否有 active SosSession
           - 0 個 active → 回覆「目前平安」彙總（無人正在求救）
           - 恰好 1 個 active → 直接進入該 session 的 family-agent 對話（見 §9），走 reply token 回覆
           - 多個 active（同一 LINE 帳號同時是多位正在求救者的聯絡人）→ 回覆 quick-reply 讓家人選擇要查看哪一位，選定後才進入該 session 的對話 context
      3. 皆不符（非綁定碼格式、也非已綁定聯絡人）→ 回覆固定說明訊息

    case "unfollow":
      → 以 event.source.userId 執行 updateMany（而非 findOne 單筆處理）：
        所有 lineUserId 相符的 EmergencyContact 全部 → bindStatus = "pending", lineUserId = null
        （同一 LINE 帳號可能同時是多個使用者的聯絡人，需全部復原，只處理其中一筆會漏掉其餘綁定）
```

> 步驟 1、2 的判斷順序刻意固定：**先試綁定碼，再試家人對話**，避免已綁定聯絡人不小心輸入的普通訊息被誤判成綁定碼嘗試（6 碼英數字串本身空間不大，理論上仍可能碰撞既有 pending bindCode，但機率低且僅影響誤觸發歡迎詞，不造成資料錯亂——命中的判斷同時要求 `bindStatus: "pending"` 且未過期）。
>
> **bindCode 大小寫正規化**：`bindCode` 在**生成/儲存時**與**比對時**都統一 `.toUpperCase()`，家人不論輸入大寫、小寫或混合大小寫都能匹配，避免因為輸入習慣造成誤判「查無此碼」。

---

## 9. 家人端 AI Agent（P1）

當 `message` 事件符合「發送者是已綁定聯絡人 且 其綁定的使用者目前有 active SosSession」時，訊息交由 `family-agent.service.ts` 處理，內部重用既有 agent 工具生態：

```typescript
// src/modules/ai/agent-tools.ts
export async function executeLocalTool(
  name: string,
  args: Record<string, any>,
  userLocation?: { latitude: number; longitude: number },
  userId?: string,
  options: { allowMemoryWrite?: boolean; explicitMemoryRequest?: boolean } = {},
): Promise<string>;
```

`family-agent.service.ts` 組出對話 context（以受困者的 `SosSession.lat/lng` 作為 `userLocation`），呼叫 LLM 判斷要不要調用工具、再透過 `executeLocalTool` 執行，最後把結果整理成 LINE 訊息（優先 Flex Message / quick-reply，減少家人手動輸入）。

**能力**

| 家人輸入意圖                   | 處理方式                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「他在哪」                     | 讀取 session 最新 `lat/lng/address/locationUpdatedAt`，附**本服務公開追蹤頁連結**（`{PUBLIC_TRACKING_BASE_URL}/sos/{shareToken}`，與求救推播中的連結一致——家人點開就是前端地圖即時位置）；不以 Google Maps 連結為主要入口 |
| 「附近有醫院／無障礙設施」     | 重用 `findGooglePlaces` / `findA11yPlaces`，以受困者當前位置為中心                                                                                                                                                        |
| 「我要過去」                   | 重用 `planAccessibleRoute`；**前提**：家人需先透過 LINE 的「分享位置」訊息把自己的位置傳給官方帳號，作為起點                                                                                                              |
| 「我來處理」                   | 認領流程：`SosSession.claimedBy = contactId`，並 push 通知其他已綁定聯絡人「OOO 已認領處理」                                                                                                                              |
| 環境資訊查詢（天氣/空品）      | 重用既有 environment 模組（`getEnvironmentInfo`），以受困者位置為準                                                                                                                                                       |
| 無 active session 時的任意訊息 | 回覆最近一次已解決 session 的狀態摘要，或「目前平安」（若從無求救紀錄）                                                                                                                                                   |

> `findGooglePlaces`（`src/modules/ai/agent-tools.ts:26-30`，已 Read 確認）簽章為 `(args: { query: string; latitude?: number; longitude?: number })`——`latitude`/`longitude` 是直接攤平在 `args` 上的頂層欄位，**不是**巢狀的 `userLocation` 物件；`executeLocalTool` 的 dispatcher（`agent-tools.ts:920` 起）對 `findGooglePlaces` 只是原樣轉傳呼叫方給的 `args`，並未像對 `findA11yPlaces` 那樣額外把呼叫者位置注入進去。一般聊天情境下 `latitude/longitude` 由 LLM 依對話上下文自行決定要不要填；但家人端 Agent 是跨使用者情境（發問者是家人，要查的卻是受困者的位置），沒有「以發話者為中心」的隱含行為可依賴——`family-agent.service.ts` 的 system prompt／工具呼叫組裝**必須明確**把 `SosSession.lat/lng` 寫進 `findGooglePlaces`（以及 `findA11yPlaces` 等其他位置相關工具）呼叫的 `args.latitude`／`args.longitude`，不能依賴預設行為自動置中。

**升級提示**：若 session 已進行超過 30 分鐘仍未解除，Agent 的每次回覆都附加提醒——「如情況緊急，請直接撥打 119（消防/救護）或 110（警察），不要只靠此對話」。Agent **絕不**用語氣暗示已經呼叫正式救援管道，僅作為資訊輔助與家庭內部協調。

**Reply Token 時效與 Push Fallback**：LINE 的 reply token 為一次性且約 1 分鐘後失效，單次 reply 呼叫最多可批次夾帶 5 則訊息。Agent 的 LLM + tool-calling 迴圈需在收到訊息後約 **50 秒內**完成並呼叫 reply（保留約 10 秒緩衝，避免卡在 LINE 平台 ~60 秒視窗邊緣）；若處理時間超過此門檻，或 reply 呼叫本身失敗（例如 token 已過期），則改用 **push** 呼叫把結果補送出去，作為 fallback。

**額度**：本節所有回覆原則上使用 **reply token**（同一 webhook 請求的回覆，免費、不計入 push 額度）；push 額度只消耗在 SOS 開始/解除通知、背景警示（§10、§11），以及上述 reply 逾時/失敗時的 push fallback。

---

## 10. 背景 Job（P2）

沿用 `hazard-report.expire.ts` 既有的『先立即執行一次、再進入 `setInterval`』+ `.unref()` 慣例——已用 Read 確認 `hazard-report.expire.ts:30-38` 的 `startHazardExpiryJob()` 是先呼叫一次 `run()`，才建立 `setInterval`（而非等滿一個掃描週期才做第一次檢查），`startSosExpiryJob()` 沿用相同寫法，於 `server.ts` mongoose 連線成功後呼叫，`timer.unref?.()` 確保不阻止進程正常結束：

```typescript
// src/modules/sos/sos.expire.ts（比照 hazard-report.expire.ts 的 startHazardExpiryJob 寫法）
export async function runSosMaintenance(): Promise<void> {
  /* 見下 */
}

export function startSosExpiryJob(): NodeJS.Timeout {
  const run = () => {
    void runSosMaintenance().catch((err) => console.error("[sos.expire]", err));
  };
  run();
  const timer = setInterval(run, SOS_EXPIRY_SCAN_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
```

`server.ts` 在 mongoose 連線成功後、與 `startHazardExpiryJob()` 同一位置追加 `startSosExpiryJob()`。

**兩項任務**：

1. **24 小時自動解除**：`status: "active"` 且 `createdAt` 超過 24 小時 → 標記 `resolved`、`resolvedAt = now`，push 通知所有已綁定聯絡人「求救已逾時自動結案」。
2. **10 分鐘斷線警示**：`status: "active"` 且 `locationUpdatedAt` 超過 10 分鐘未更新、且 `staleAlertSent: false` → push 一次「位置已停止更新，可能手機沒電或離線」給已綁定聯絡人，並將 `staleAlertSent` 設為 `true`（避免每次掃描重複發送；若之後又收到新位置更新，`sos.service.ts` 的 `location` 端點需把 `staleAlertSent` 重置回 `false`，讓警示可以再次觸發）。

---

## 11. LINE 推播額度與風險

LINE Messaging API 官方帳號免費方案（**Communication Plan**）每月 **200 則 push 訊息**額度（**multicast 對 N 位聯絡人算 N 則**；reply 訊息不計額度）。

**額度估算**：每次 SOS 約消耗 `已綁定聯絡人數 × 2`（建立 1 次 + 解除 1 次）+ 背景警示（每個 session 最多 1 則斷線警示 + 可能 1 則 24h 自動結案通知）。以 3 位聯絡人估算，一次完整 SOS 生命週期約 `3×2 + 3(警示) ≈ 9` 則。200 則額度約可支撐 **20 餘次完整求救事件**／月，Demo／小規模試用足夠，正式上線建議升級至 **Light Plan（5,000 則/月）**。此外，家人端 Agent 若因處理逾時或 reply 失敗而改走 push fallback（見 §9），也會額外消耗當月 push 額度，估算時應一併考慮。

**其他風險**：

- **Webhook 需要公開 https**：現行部署為 Docker（見專案 memory），後端程式碼是**編進 image**、非掛載檔案系統，改動程式碼後單純「重啟容器」不會生效，必須 `docker compose up -d --build backend` 重建映像才會反映到執行中的容器；本機開發需 ngrok/cloudflared 開臨時公開網址。
- **公開追蹤頁隱私**：任何取得追蹤連結（`{PUBLIC_TRACKING_BASE_URL}/sos/{shareToken}`）的人都能看到即時位置，無需登入、無需是綁定聯絡人。緩解僅止於 `shareToken` 高熵（`crypto.randomBytes(16)`，128 bit）與解除後 24 小時失效——這是**接受的風險**（accepted risk），並非已解決的問題；連結一旦外流（如轉發到公開群組）在到期前仍可被任何人查看，本期不做額外存取控制（如密碼、一次性驗證）。

---

## 12. 分期 Roadmap

| 階段   | 範圍                                                                                                                                                                                                                            | 優先度     | 依賴                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| **P0** | Model（EmergencyContact/SosSession）、聯絡人 CRUD（含 5 筆上限、bindCode 生成）、Webhook 簽章驗證 + follow/message-綁定/unfollow、SOS 生命週期三端點、multicast 建立/解除通知、公開追蹤端點、env/openapi/app.ts 共用 spine 佈線 | P0（必須） | LINE Messaging API Channel 已建立（§6）                               |
| **P1** | 家人端 AI Agent（位置查詢／附近設施／認領）、Flex Message／quick-reply 模板                                                                                                                                                     | P1         | P0 完成、`agent-tools.ts` 既有工具可直接重用                          |
| **P2** | 背景 Job（24h 自動解除、10 分鐘斷線警示）、Agent 的「我要過去」路線規劃、環境資訊查詢整合                                                                                                                                       | P2         | P1 完成（Agent 主迴圈已存在）；路線規劃依賴既有 `planAccessibleRoute` |

---

## 13. 測試策略

沿用專案既有 vitest + supertest 路由層整合測試慣例（`tests/helpers/test-helpers.ts` 的 `buildTestApp()` / `buildAuthorizationHeader(user?)`），以 `vi.mock` 掛掉 service 層，讓請求真正跑過 router + middleware + validation + controller + envelope。**LINE adapter 全程 mock，測試中不打真實 LINE API。**

| 測試案例                                                                                 | 型態      | 重點                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /emergency-contacts` 未帶 token → 401/403                                           | 整合      | auth middleware 攔截，未進 controller                                                                                                                            |
| `POST /emergency-contacts` 已有 5 筆 → 400 `CONTACT_LIMIT_REACHED`                       | 整合      | mock service 回傳上限錯誤，controller 正確轉譯                                                                                                                   |
| `POST /emergency-contacts` 成功 → 201 含 `bindUrl`/`bindCode`                            | 整合      | 回應形狀符合 envelope                                                                                                                                            |
| `DELETE /emergency-contacts/:id` 非本人 → 403 `NOT_CONTACT_OWNER`                        | 整合      | owner 檢查                                                                                                                                                       |
| `POST /sos/sessions` 首次建立 → 201                                                      | 整合      | `notifiedCount` 欄位存在                                                                                                                                         |
| `POST /sos/sessions` 已有 active session → 200（非 201）回傳既有 session                 | 整合      | 驗證「重複建立回既有紀錄」語意                                                                                                                                   |
| `PATCH /sos/sessions/:id/location` 非本人 → 403                                          | 整合      | owner 檢查                                                                                                                                                       |
| `PATCH /sos/sessions/:id/location` session 已 resolved → 400 `SESSION_NOT_ACTIVE`        | 整合      | 狀態機檢查                                                                                                                                                       |
| `GET /sos/sessions/:token/public` 有效 token → 200                                       | 整合      | 無需 Authorization header                                                                                                                                        |
| `GET /sos/sessions/:token/public` 已解除超過 24h → 410 `GONE`                            | 整合      | 過期邏輯                                                                                                                                                         |
| `GET /sos/sessions/:token/public` 不存在 token → 404                                     | 整合      | —                                                                                                                                                                |
| `POST /line/webhook` 簽章不符 → 401                                                      | 整合      | mock `@line/bot-sdk` middleware 拋出 `SignatureValidationFailed`，驗證路由層級錯誤處理器攔截並轉換為 401（而非未處理例外落到 Express 預設 500），不進 controller |
| `POST /line/webhook` bindCode 命中 → 更新聯絡人為 bound（mock line.service）             | 單元/整合 | 驗證比對邏輯（含大小寫、過期判斷）                                                                                                                               |
| `POST /line/webhook` bindCode 過期 → 不綁定，回落到說明訊息                              | 單元      | `bindCodeExpiresAt` 邊界                                                                                                                                         |
| `sos.expire.ts`：24h 逾時 session 被標記 resolved                                        | 單元      | 比照 `hazard-report.parse.test.ts` 風格的純函式測試                                                                                                              |
| `sos.expire.ts`：10 分鐘無更新且 `staleAlertSent=false` → 觸發一次警示、置 true 後不重複 | 单元      | 驗證去重旗標                                                                                                                                                     |

---

## 14. 新增環境變數

| 變數                        | 用途                                                                            | 必要性                                 | 預設值 |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- | ------ |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API 頻道存取權杖，`line.adapter.ts` 建立 `MessagingApiClient` 用 | 必要（缺少則 push/reply 一律失敗）     | 無     |
| `LINE_CHANNEL_SECRET`       | Webhook 簽章驗證密鑰（HMAC-SHA256）                                             | 必要（缺少則 webhook 一律 401）        | 無     |
| `PUBLIC_TRACKING_BASE_URL`  | 組出公開追蹤連結（`{PUBLIC_TRACKING_BASE_URL}/sos/{shareToken}`）的網域前綴     | 必要（缺少則推播訊息無法附上可用連結） | 無     |

比照 `.env.example` 既有風格追加（沿用區塊註解慣例，如 `# --- Hazard Report ---`）：

```
# --- SOS / LINE ---
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
# 公開追蹤頁的對外網域（前端頁面，非後端 API），如 https://app.example.com
PUBLIC_TRACKING_BASE_URL=
```

---

## 15. 新增 npm 依賴

| 套件            | 版本  | 用途                                                                                                                                |
| --------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@line/bot-sdk` | `^11` | LINE Messaging API 官方 SDK：webhook 簽章驗證 middleware、`messagingApi.MessagingApiClient`（push/multicast/reply）、事件與訊息型別 |

> 確認：目前 `package.json` 的 `dependencies` 中**尚未**存在 `@line/bot-sdk`，需新增。

---

## 16. 前端職責邊界

### 16.1 前端負責

- 呼叫聯絡人 CRUD 三端點、顯示 `bindUrl`（加好友連結）與 `bindCode`，提供「分享給家人」的轉發入口（如系統分享 sheet）
- 呼叫 `POST /sos/sessions` 觸發 SOS，並在求救進行中以計時器每 10–15 秒呼叫 `PATCH .../location`
- 呼叫 `PATCH .../resolve` 讓使用者主動解除求救
- 提供公開追蹤頁的前端頁面（消費 `GET /sos/sessions/:token/public`），此頁面**不需要**登入態
- 向使用者清楚說明綁定流程需要家人「手動輸入 6 碼綁定碼」（非全自動），避免使用者誤以為加好友就自動完成

### 16.2 前端不負責（後端職責）

- LINE 官方帳號的 webhook 事件處理、簽章驗證、bindCode 比對邏輯
- Push/multicast 推播的觸發與內容組裝（Flex Message 模板）
- 家人端 AI Agent 的對話邏輯與工具調用
- `shareToken` 的生成與到期判斷
- 背景 Job（24h 自動解除、斷線警示）

---

## 17. 風險與緩解

| 風險                                    | 影響                                                                                                                                                                                                                                | 緩解                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push 額度耗盡（免費方案 200 則/月）     | 超額後 push 失敗，SOS 通知發不出去（家人收不到任何提醒）                                                                                                                                                                            | Fail-soft：push 失敗只記錄不擋主流程；正式上線前升級 Light Plan（5,000 則/月，見 §11）；額度使用量建議加監控告警（⚠️ 待確認：監控方式非本期範圍）                                                                                                                                                                                                          |
| Webhook 需要公開 https，本機開發摩擦    | 本機測試需額外架設 ngrok/cloudflared 隧道，且 Docker 部署改 code 需 `docker compose up -d --build backend` 才生效，忘記重建會排錯困難                                                                                               | 文件明確記載重建指令（本文 §11）；開發環境提供固定的 ngrok/cloudflared 啟動腳本（⚠️ 待確認，非阻塞）                                                                                                                                                                                                                                                       |
| 公開追蹤頁隱私外洩                      | 連結一旦外流，任何人在到期前都能看到即時位置                                                                                                                                                                                        | `shareToken` 128-bit 高熵 + 解除後 24h 失效，明確標示為**接受的風險**而非解決方案；不做額外存取控制                                                                                                                                                                                                                                                        |
| bindCode 暴力猜測                       | 6 碼英數字（統一以 `.toUpperCase()` 儲存與比對，見 §8.3；有效組合空間 ≈ 36^6 ≈ 21.7 億種）理論上可窮舉，但需精準命中「某個 pending 且未過期」的 code，且每次嘗試都是一次 LINE 訊息（人力/自動化成本高）；24h 到期進一步縮小攻擊視窗 | 現階段熵值/時效已足夠抵禦隨手嘗試；⚠️ 待確認：是否需要對單一 LINE 帳號的綁定嘗試次數做 rate limit——`express-rate-limit`（`^8.5.2`）已是本專案既有依賴（已 Grep 確認於 `package.json`，`hazard-report.middleware.ts` 已在使用），webhook 路由要加限流可直接複用、不需新增套件，但依 LINE userId 或來源 IP 限流的具體設計待補，P0 可先不做，觀察濫用情形再補 |
| Unfollow 競態                           | 家人在 SOS 通知推播的極短時間內取消追蹤，可能導致推播對象剛好失效、push 回傳好友關係已解除的錯誤                                                                                                                                    | Fail-soft：push 失敗僅記錄；`unfollow` 事件本身會把該聯絡人狀態復原為 `pending`，下次建立 SOS 時 multicast 名單已自動排除                                                                                                                                                                                                                                  |
| 家人端 AI Agent 給出錯誤的醫療/急救建議 | 家人可能因此延誤真正需要的專業急救行動                                                                                                                                                                                              | Agent 系統提示明確禁止給予醫療處置指示；session 超過 30 分鐘未解除時每次回覆強制附加「請撥打 119/110」提示；Agent 用途定位為資訊輔助與家庭協調，不取代正式求救管道                                                                                                                                                                                         |

---

_文件版本 v1.0.0 — 涵蓋緊急聯絡人管理（bindCode 綁定，取代已否決的 follow-event state 方案）、SOS 求救生命週期（建立/位置更新/解除/公開追蹤）、LINE Webhook 簽章驗證與事件分派、家人端 AI Agent（P1，重用既有 `agent-tools.ts` 工具生態）、背景自動結案與斷線警示 Job（P2）。P0 範圍（模型、聯絡人 CRUD、Webhook 綁定、SOS 生命週期、共用 spine 佈線）待實作；P1/P2 依此規格分期展開。_
