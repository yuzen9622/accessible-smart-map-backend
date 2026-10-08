# 路況回報圖片 benchmark 與生命週期查證

日期：2026-10-08。範圍：`hazard-report`；**本次只新增 benchmark、測試與紀錄，沒有修改正式回報邏輯或資料，也未重新部署後端。**

## 結論

目前 AI 有能力篩選可見的車輛占道、施工與階梯，但 `verified` 不能等同「現地回報全部查證完成」。此次實測對沒有提供地圖資料的「地圖標錯」宣稱，兩次都錯誤接受，且自報 confidence 均為 **0.95**。過期、人工核可與現地障礙已解決也尚未形成完整閉環。

## 1. 現行部署的生命週期

此處以本次檢查時 Docker `taipei-backend` 的已部署程式為準。開始時相關編譯檔與本機比對相符；測試期間工作目錄另有資料保留／帳號刪除變更，因此不混用那些尚未部署的修改。部署檔雜湊記錄在 `reports/hazard-benchmark/environment.json` 與每筆 `samples.jsonl`。

| 問題 | 已查證行為 | 證據位置（函式） |
| --- | --- | --- |
| 「影像辨識進行中」是什麼？ | 建立文件時寫入 `verdict=skipped`、`confidence=0`、`reason=影像辨識進行中`，並以 `void verifyHazardReport(...).catch(...)` 在同一個 Node 行程背景執行。不是完成結果。 | `src/modules/hazard-report/hazard-report.service.ts`：`createReport` |
| 可能一直停在進行中？ | 沒有持久佇列與重啟復原；行程中斷或最後 DB 更新失敗可能留下占位。一般 Gemini 例外會寫成 `skipped / AI 服務暫時不可用`，不應把所有卡住都歸因同一原因。 | `hazard-report.ai-verify.ts`：`verifyHazardReport`；`adapters/ai-vision.adapter.ts`：10 秒 Gemini timeout |
| 何時過期？ | 建立時預設 `expiredAt`：obstacle 6 小時、construction 7 天、data_error 30 天；有 `expectedUntil` 時採其日期。審核／確認不自動延長。 | `hazard-report.service.ts`：`EXPIRY_MS`、`createReport` |
| 何時改成 expired？ | Mongo 連線成功後立即掃描，之後預設每 5 分鐘將到期且 pending/verified 的紀錄改為 expired。此「有效期過期」是狀態變更，不是障礙已排除或物理刪除。 | `src/server.ts`；`hazard-report.expire.ts`：`startHazardExpiryJob`、`expireStaleReports` |
| 查詢會即時排除到期紀錄嗎？ | 路線障礙查詢明確檢查 `expiredAt > now`。一般附近查詢只依 status，故掃描前可能有最多約一個週期的延遲；排程故障時可能更久。 | `hazard-report.repository.ts`：`findNearbyReports`、`findConfirmedWithin` |
| 已經解決怎麼判定？ | status 只有 pending/verified/rejected/expired，沒有 resolved。deny 只增加計數，不結案、不自動取消 verified；confirm 也不直接將 pending 升級 verified。 | `src/model/hazard-report.model.ts`；`hazard-report.service.ts`：`confirmReport`；`hazard-report.repository.ts`：`addConfirmation`、`addDenial` |
| 有人工審核嗎？ | 有 admin-only API：`GET /api/v1/a11y/reports/review-queue`、`POST /api/v1/a11y/reports/:id/review`，裁決只有 verified/rejected。pending+suspicious 進佇列；pending+skipped 且建立超過預設 10 分鐘也進佇列。這是查詢條件，不代表有人收到通知或已審核。 | `hazard-report.router.ts`；`hazard-report.service.ts`：`findReviewQueue`、`submitManualReview`；`hazard-report.repository.ts`：`findReviewQueueReports` |
| AI 核可就能影響導航？ | 仍需 verified、未到期、至少一個非回報者的身分確認；只有 confirmCount 的舊資料不符合。 | `hazard-report.service.ts`：`isRouteEligibleHazard`；`hazard-report.repository.ts`：`findConfirmedWithin` |
| aiAnalysis 的 labels/summary？ | 本次部署的 HazardReport 模型沒有 `aiAnalysis`；有 `aiVerification.prefilter.detectedLabels`，沒有該欄位的 summary。不能把其他環境／舊版本欄位當成目前已運作機制。 | `src/model/hazard-report.model.ts`；`src/adapters/vision.adapter.ts` |

本機目前 `hazardreports` **0 筆**，無法重現使用者看到的那筆「進行中」。已唯讀核對真正 Model collection name。`/health` 200、附近回報 GET 200/0 筆，未登入讀 review-queue 為 403。未嘗試取得 admin 身分，也未讀取或傳送正式使用者照片；未驗證人工審核前端畫面或實際值班制度。

## 2. Benchmark 方法與邊界

- 模型：部署設定 `gemini-3.7-flash`；沿用實際 prompt、schema、timeout、Cloud Vision adapter、Gemini adapter、parser 與 `verifyHazardReport`，沒有為了測試換模型或提示詞。
- 六張 Wikimedia Commons 公開照片：車輛占道、施工桶與碎石、階梯、路緣斜坡、地面特寫、山景；另有可解碼的全黑 PNG 與故意損壞的圖片 bytes。
- 13 個預先標註情境，各跑兩次，共 26 次。包含類型錯誤、捏造車輛、無地圖佐證的圖資錯誤、證據不足、純色圖、description prompt injection、與畫面矛盾的描述及損壞圖片。
- 標註來自主對話在執行前實際看圖，不是採用檔名／搜尋摘要或模型輸出作為真值。搜尋摘要曾誤述斜坡有黄色觸覺鋪面、地面特寫代表整段通道暢通；兩者均未採用。
- Ground truth：`src/scripts/fixtures/hazard-images.protocol.json`；執行時凍結副本與 SHA256：`reports/hazard-benchmark/protocol.json`、`results.json`。
- 每筆結果保存 image SHA256、模型、七個部署編譯檔 SHA256、原始模型文字、解析結果、prefilter、時間與捕捉的 update pipeline。本次 26 筆只有一組程式／模型指紋。
- **只有 DB 的 updateOne 被捕捉**：沒有 Mongo 連線、正式資料寫入、GCS 上傳或 HTTP 建立回報。這證明圖片辨識與產生更新資料的行为，**不是**真實 DB 落庫、EXIF 新鮮度、GPS、去重、前端輪詢、工作佇列恢復或整體 E2E 的驗收。
- 兩次重複不是 26 個獨立地點；樣本小、由便利取得的照片組成、只有一位標註者，不能宣稱正式產品準確率、已完成 confidence 校準或已全面抵抗提示注入。
- 腳本需顯式 `--live`；本次上限 26 次，沒有自動重試。前 3 次皆不可用就中止；部署版本變動就中止，不覆寫先前原始樣本。

## 3. 實測結果

| 指標 | 結果 | 分母說明 |
| --- | --- | --- |
| 有效圖片 AI 完成率 | 24/24 | 損壞 bytes 的兩次例外獨立列入 robustness |
| 有效圖片符合預設判定 | **22/24，91.7%** | skipped／服務失敗也會留在此分母，本次未發生 |
| 真障礙判 verified | 10/10 | 5 個正例情境各兩次，不代表 10 個獨立現場 |
| 不應核可的情境誤接受 | **2/14，14.3%** | 7 個負例情境各兩次 |
| 損壞圖片以 skipped 收尾 | 2/2 | 只驗證現行 soft-failure，不代表錯誤分類正確 |
| 包含 robustness 的全情境符合預設 | 24/26 | 不以此取代辨識品質指標 |
| 同案例兩次 verdict 一致 | 13/13 | 理由文字仍可能不同 |
| 每次辨識耗時 | 中位數 4.990 秒；p95 7.100 秒；最大 7.293 秒 | 包含 Vision+Gemini+parser；不含上傳、HTTP、DB 與 worker 啟動時間，僅為此次小樣本 |

### 關鍵失敗：把可見斜坡當成圖資錯誤已證實

案例 `ramp-map-claim` 的輸入只有斜坡照片，以及「地圖將此處標記為沒有斜坡」這句文字，**沒有提供地圖現值、座標佐證或查詢工具**。預期只能 suspicious/rejected，不應核可。

- 第一次：verified，confidence **0.95**；reason「現場為真實戶外街道人行道，路緣處確實設有明顯的無障礙斜坡，與回報之圖資錯誤宣稱相符。」
- 第二次：verified，confidence **0.95**；reason「照片為真實戶外街道，人行道路緣確實設有明顯的斜坡（降坡），與回報所指設施現況相符。」

AI 證實的是「圖中看得到斜坡」，卻把未驗證的地圖宣稱一起接受。confidence 是模型對判斷的自報信心，不能當成 95% 的現地可信度。

### 其他品質問題

1. 損壞 bytes 兩次都得到 `prefilter.passed=true`、空 labels；Gemini 回 `ApiError` 後，最後寫成 `skipped / AI 服務暫時不可用`。因此 persisted prefilter 的存在不等同影像已成功解碼或安全檢查成功。Vision adapter 沒有檢查 `result.error`；本次未捕捉原始 Vision 回應，不能斷言它實際回傳的錯誤內容。
2. 第一輪階梯理由寫「且無坡道」；畫面不足以證明所有替代路徑皆無坡道。verdict 符合本例「階梯本身對輪椅構成障礙」，但理由仍含超出單張照片證據的斷言。故 22/24 是 verdict 符合率，**不是 reason 每句都正確的比例**。
3. 全黑圖、山景、地面特寫都未被核可；這次兩次指定 description injection 也未成功。但還未涵蓋圖片內文字注入、多圖、夜間、模糊、台灣各類場景與遮擋。

## 4. 建議修復順序（本次未實作）

### P0：先避免把辨識結果誤當事實核實

- 分開 **AI 工作狀態**（queued/processing/completed/failed）與 **內容判定**（supported/uncertain/unsupported），不要拿 skipped 同時表示進行中與失敗。
- `reason` 顯示可見證據、限制與缺少的佐證；`labels/summary` 只當內容摘要。人工裁決與 AI 判定各自呈現，不以高 confidence 擋掉人工決策。
- data_error 必須比對真正圖資及位置；沒有對照資料先進人工／待佐證，不能憑使用者描述自動 verified。
- 區分 corrupt_image、provider_timeout、provider_unavailable、parse_failed、persistence_failed；Cloud Vision 應檢查單筆 response error，避免空結果當 passed。

### P1：完成工作與現地事件的閉環

- 對 AI 任務提供持久化、attempted/completed timestamps、有限重試、逾時與重啟恢復；超時要進待人工而非永久「進行中」。
- **expired 與 resolved 分開**：expired=資料有效期不足，不代表障礙消失；resolved 要有回訪照片、時間、位置、申請者與裁決紀錄。先提出「已排除」申請，經管理員或明確定義的獨立複核後結案。
- deny 不直接等同已解決；可以表示「不存在／已排除／位置不符／證據不足」，分開用途。自動結案票數、角色與防濫用規則需要產品決策，不在本次擅自設定。
- 補人工佇列通知、處理時限與前端入口；過期時間應在查詢時也直接檢查，避免等排程才消失。

### P2：正式 benchmark

建立經去識別與授權的台灣實景驗證集；至少涵蓋各障礙類型、正常場景、模糊／夜間、誤報、圖資對照與重訪前後。由獨立標註者交叉確認、按地點切分而非同照片切分，分別量測誤接受、漏報、reason 證據吻合、人工覆核與真正 E2E 完成率。

## 5. 重跑與驗證

```bash
# 僅抓公開照片；sources.json 保存作者、授權與圖檔 hash
node src/scripts/bench-hazard-images.mjs prepare reports/hazard-benchmark-new

# 使用目前 taipei-backend 容器的真實供應商與程式；會產生 API 用量
node src/scripts/bench-hazard-images.mjs live reports/hazard-benchmark-new --live

# 本次算分、PNG 與未授權 live 拒絕測試
pnpm exec vitest run src/scripts/bench-hazard-images.test.ts
```

本次變更檔案：

- `src/scripts/bench-hazard-images.mjs`：公開照片準備、部署流程實跑、原始結果保存與指標。
- `src/scripts/fixtures/hazard-images.protocol.json`：在 live 前固定圖片观察與 13 個預期情境。
- `src/scripts/bench-hazard-images.test.ts`：6 個計分／fixture／授權開關測試。
- 本文件：現況、實測與建議。

驗證證據：

- 真實 benchmark 26/26 完成，證據位於忽略的 `reports/hazard-benchmark/`，沒有正式回報新增（執行前後 collection 均為 0）。
- 本次 6 tests、針對新增程式 ESLint 通過；LSP probe 回報 0 diagnostics，但其中 1 個檔案為 inconclusive，不能宣稱兩檔均獲 LSP clean 確認。
- 獨立 verifier 核對原始樣本、分母、圖片／程式／模型指紋、捕捉 DB 邊界與 results.json 限縮，另實跑 node syntax check 與 6 tests，回報可驗收。它未覆核本文件之全部生命週期敘述；那些由主對話讀回部署／原碼查證。
- 使用 `git archive HEAD` 的獨立副本（base `0956478e0aed736b664eeb564246cb7ce1d09e15`）只加入本次三個 src 檔：`pnpm build` 通過；回報＋benchmark **7 檔／50 tests 通過**；全套 `pnpm exec vitest run --maxWorkers=4 --hookTimeout=60000` 為 **232 檔通過、7 檔跳過；3104 tests 通過、17 跳過**。真 Mongo integration 使用隔離的 MongoMemoryServer；未動正式 Mongo。
- 最終再跑共用工作目錄的 `pnpm build` 仍因另一批同時進行的 retention 模組循環依賴失敗（`current-final-build.log`），回報 service tests 曾有兩項因那些新變更失敗；未替別的工作修碼或回復。上面獨立副本的成功**不等於宣稱共用工作目錄全綠**。`git diff --check` 通過。
