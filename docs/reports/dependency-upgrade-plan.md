# 依賴升級與安全漏洞修補計劃（2026-08-13）

> 官方公告來源（2026-08-13 已核實）：Express 5 migration guide & release blog、Mongoose 9 migration guide、TypeScript 7.0 官方公告、js-genai / ioredis / openai-node / google-cloud-vision CHANGELOG、GitHub Security Advisory (GHSA) API。

## 現況摘要

| 項目 | 數值 |
| --- | --- |
| 本機 Node | v26.6.0（無 engines 欄位） |
| Docker | node:22-bookworm-slim（builder + runtime） |
| 安全漏洞 | 11 個（High 6 / Moderate 2 / Low 3，其中 protobufjs 佔 7 個、mongoose 1、body-parser 1） |
| 待升級 | 6 個 patch/minor + 7 個 major |

## 漏洞與修補版本（GHSA 官方）

| GHSA | 套件 | 影響版本 | 修補版本 | 在本專案的引入路徑 |
| --- | --- | --- | --- | --- |
| GHSA-f38q-mgvj-vph7 (High) | protobufjs | ≤7.6.2 / 8.0.0–8.5.0 | **7.6.3 / 8.6.0** | @google-cloud/vision → google-gax |
| GHSA-j3f2-48v5-ccww (High) | protobufjs | 同上 | 同上 | 同上 |
| GHSA-664h-wqgq-64gw (Moderate) | mongoose | <8.24.1 / <9.7.2 | **8.24.1 / 9.7.2** | 直接依賴 |
| GHSA-v422-hmwv-36x6 (Low) | body-parser | <1.20.6 / 2.0–<2.3.0 | **1.20.6 / 2.3.0** | express 4.22.2 釘死 body-parser 1.20.3，**express 4 無解，唯一正解是 express 5** |

## Major 升級官方公告重點 → 本專案對應改動

### express 4.22.2 → 5.2.1（框架級，高風險）

- path-to-regexp v8：`*` 必須具名 `/*splat`；`:param?` → `{:param}`；不支援 regex 路由；參數必須具名。
  - **本專案必改**：`src/app.ts:104` `app.use("*", ...)` → `app.use("/*splat", ...)`（404 handler；注意 root path 需 `/{*splat}` 或另處理）。
  - grep 確認：無 `:x?`、無 regex 路由 ✓
- `req.query` 變成 getter、**不可寫入**。
  - **本專案必改**：`src/middleware/validate-request.middleware.ts:49` `req.query = validated.query` 會失敗（invariant #3 的「回寫 req.*」機制受影響）。方案：instance 層 `Object.defineProperty(req, 'query', {...})` 遮罩 getter，或原地清空重建。`req.params` 仍可寫（實作時用測試確認）。
- async handler 的 rejected promise 自動轉交 error middleware（行為變更：先前被吞掉的 rejection 現在會走 `classifyError` → 500；以全測試驗證）。
- body-parser 2.x 內建 → 修 GHSA-v422-hmwv-36x6；`req.body` 不再恆為 `{}`；urlencoded `extended` 預設 false（app.ts:60 已顯式 `{ extended: true }` ✓）。
- 移除：`res.sendfile`、`res.redirect('back')`、`res.send(status, body)`、`app.del`、`req.param()` 等（grep 確認未使用 ✓）。
- `express.static` dotfiles 預設 ignore（確認專案未使用 static ✓）。
- Node ≥18 ✓（26 本機 / 22 Docker）。
- 需換 `@types/express` ^5；`src/types/express.d.ts` augmentation 視型別調整。
- 相容確認：express-rate-limit 8.6.2 peer `express >=4.11` ✓、cors/morgan/helmet/cookie-parser/multer 為純 middleware ✓、rate-limit-redis 6.0.1 無 express 依賴 ✓。

### mongoose 8.24.0 → 9.9.2（最大改動面）

- Node ≥20.19 ✓（26 / 22）
- `FilterQuery` → `QueryFilter`（TS 型別更名；grep 專案使用處）
- UUID 型別改回傳 bson.UUID（**本專案無 UUID schema** ✓）
- update pipelines 預設禁止（47 處 updateOne/updateMany/findOneAndUpdate，確認全部是 `$set` 等 operator 風格）
- `Document.updateOne` 不接受 callback、isAsync middleware 移除、custom methods/statics hooks 不支援 callback（**本專案無 callback 風格** ✓，全 async/await）
- `promiseOrCallback`、`skipOriginalStackTraces`、`caster`/`casterConstructor` 移除（內部 API）
- `Document.id` 型別不再 any
- 影響面：44 個 model/schema 檔 + 20+ scripts + conn.ts。主要為型別層改動；執行行為以測試覆蓋。

### typescript 5.9.3 → 7.0.2（工具鏈）

- TS7 = Go 原生版（typescript@7 提供自己的 `tsc`），**無穩定 programmatic API** → ts-node / typescript-eslint 等依賴 compiler API 的工具必須留在 TS6（官方提供 `@typescript/typescript6` alias）。
- 6.0 以來行為變更：`rootDir` 預設變 `./`（本專案已顯式 `./src` ✓）；**`types` 預設 `[]`**（本專案無 `types` 欄位 → 需加 `"types": ["*"]` 或顯式列出）；import attributes 需 `with`；CLI 檔案參數需 `--ignoreConfig`。
- `moduleResolution: "node"`（node10）在 TS7 是否仍支援需實測；不支援則改 `node16`（module 同步調整，CJS 專案風險中等）。
- **方案 A（推薦）**：`typescript` → `npm:@typescript/typescript6`（ts-node/編輯器用）+ `@typescript/native` → `npm:typescript@^7.0.2`（build 的 tsc 用）。雙編譯器並存。
- **方案 B**：只升 TS 6.x 暫緩 7（零風險，dev-only 套件無安全影響）。→ 需使用者決策。
- vitest（esbuild 轉譯）不受影響。

### @google-cloud/vision 5.3.7 → 6.0.0（低風險）

- 官方公告唯一 breaking：**min Node 22**（26 / 22 ✓）。
- 預期帶新版 google-gax → protobufjs ≥8.6.0，一次修掉 7 個 protobufjs 漏洞。若沒帶到 → `pnpm.overrides` 強制（Plan B）。
- 影響面：僅 `src/adapters/vision.adapter.ts`（annotateImage API 穩定）。

### @google/genai 1.52.0 → 2.16.0（中風險）

- 官方公告：2.x breaking changes **僅限 Interactions API**（`GenerateContent` 用法不受影響）；Live API 有 `GenerationConfig` 併入 `LiveConnectConfig` 等變更。
- **雙模組發布**（exports 含 `require: ./dist/node/index.cjs`）✓ CJS 專案直接 require，不需 dynamic import。
- engines node ≥20 ✓。
- 影響面：config/ai.ts（GoogleGenAI 建構式 + httpOptions）、config/ai/tool.ts、agent-manager.service、history-adapter、**voice/live-bridge.ts（Live 連線，需核對 liveConnectConfig 參數面）**、scripts/eval-*.ts。

### openai 6.49.0 → 7.4.0（中風險）

- 7.0.0 (2026-07-27) 起，7.1–7.4 為後續補丁。breaking 細節在實施步驟從 changelog（已入庫）核對。
- 影響面：config/ai.ts（OpenAI 建構式 baseURL）、ai-chat.service、agent-manager、line 服務、ai-vision.adapter、tool-catalog、types/agent.ts。

### ioredis 5.11.1 → 6.0.0（低風險）

- 官方公告：BREAKING = **Node ≥20** + **RESP3 預設**（`protocol: 2` 可保留 v5 線路協定）。
- 影響面：僅 `src/config/redis.ts`。建議保守設 `protocol: 2`（Redis 伺服器 ≥6 才支援 RESP3；本專案只用 get/set/setnx/del，無需 RESP3 特性）。→ 依 Redis 伺服器版本決策。
- rate-limit-redis 6.0.1 無 ioredis 依賴 ✓ 不受影響。

## 升級順序（風險由低到高，每步獨立 commit + 驗證）

| 步驟 | 內容 | 驗證 |
| --- | --- | --- |
| 0 | 基線：git 乾淨、`pnpm build` + `pnpm test` 紀錄 | — |
| 1 | mongoose 8.24.0 → **8.24.1**（純 patch 修漏洞） | build + test |
| 2 | @google-cloud/vision → 6.0.0（修 protobufjs 7 個漏洞） | build + test + `pnpm why protobufjs` 確認 ≥8.6.0 |
| 3 | 低風險批次：google-auth-library 11.0.1、mammoth 1.12.1、ws 8.21.3、@dotenvx/dotenvx 2.21.0、@google-cloud/storage 7.22.0、@scalar/express-api-reference 0.10.13 | build + test |
| 4 | ioredis 6.0.0 | build + test + redis 連線 smoke |
| 5 | @google/genai 2.16.0 | build + test + agent smoke |
| 6 | openai 7.4.0 | build + test + ai smoke |
| 7 | express 5.2.1 + @types/express 5（修 body-parser DoS） | build + 全測試 + server 開機 smoke（/health、/docs、openapi、404 handler、query 驗證路由、錯誤路徑） |
| 8 | mongoose 9.9.2 | build + 全測試 + conn 連線 + 一條 import script dry-run |
| 9 | typescript 7（方案 A/B 待決） | build + test + ts-node script smoke |
| 10 | 收尾：`pnpm audit` 期望歸零、`pnpm outdated` 殘留檢視、Docker build 驗證（node:22）、更新本文件為執行紀錄 | — |

每步流程固定：官方公告核對（本文件已涵蓋，openai 7.0.0 / ioredis 6.0.0 段落於實作時再細讀）→ `pnpm add/update` → 必要程式碼修改 → `pnpm build`（含 lint:arch）→ `pnpm test` → commit。

## 待使用者決策

1. **typescript 7**：方案 A（TS7 tsc + typescript6 給 ts-node/編輯器，雙編譯器）vs 方案 B（升 6.x 暫緩 7）。無安全影響，純工具鏈。
2. **ioredis RESP3**：Redis 伺服器版本 ≥6 才支援 RESP3；若伺服器版本不明 → 保守 `protocol: 2`。
3. **mongoose 9**：修漏洞最低只要 8.24.1；升 9 是最大化選擇（本計劃預設執行，若想保守可停在 8.24.1）。
