# TDX 契約同步與實效驗證（2026-10-05）

## 結果與範圍

本次修正臺鐵停駛解析／班次配對、公車 ETA 時效、方向契約與捷運站點匯入，並更正停車供應狀態文件。使用目前工作樹、官方現行文件及會員認證後的真實 API 回應驗證。未更換仍有效的 V2 API，也未修改 OTP／DEM 建圖流程。

## 行為修正

1. **臺鐵停駛**：整班停駛或搭乘起訖站停駛時排除；部分停駛只有起訖站皆明確仍營運才保留。有效資料全部停駛時回傳成功的空班表，格式壞掉仍回 `BAD_PAYLOAD`。班次配對套用同一判斷，OD 快取由 6 小時縮成 10 分鐘。
2. **ETA**：依來源時間扣除經過秒數。過舊、時間格式壞掉、來源時鐘明顯超前、車已過站、交管／未營運等資料不提供可搭乘 ETA。正值預估已經過期不截成 0；收到的原始 JSON 不加入內部時間欄位。到站查詢、route-detail 與路線疊加共用此判斷。30 秒快取中的倒數仍持續減少。
3. **方向**：REST 查詢／回應 schema、OpenAPI、TDX 上游 filter、標籤與 AI 工具契約支援 `0/1/2/10/255`。路線即時疊加支援已知的迴圈與循環線方向；255 表示未知，不據此推測路線行進方向。
4. **捷運匯入**：預設涵蓋 9 系統。Station 與 StationOfLine 改以共同的 `StationID` 對應；保留來源 `StationUID`，不再假定 UID 等於 `${railSystem}-${StationID}`。真實資料中有 `NTMCC-`、`KLRT-NETWORK-`、`MG-` 等前綴。無效站點、空資料與缺路線對應均使執行結果失敗，避免以成功訊息掩蓋資料漂移。新增 `--dry-run`，驗證與正式匯入共用相同 bulkWrite 操作產生器。
5. **停車文件**：basic 臺北路外停車場已恢復／存在供數，不再沿用「basic 全縣市空」當成現況。空間匯入保持 advanced NearBy；其他縣市與資源仍須分別比較資料覆蓋。token 有效期限也改為以 `expires_in` 描述。

## 驗證證據

### 真實 TDX 資料

`pnpm import:tdx-metro --dry-run` 回傳 exit 0；9 系統 **292 筆**操作全部有有效座標與路線對應，沒有連線／寫入正式資料庫：

| 系統 | 站點 |
| --- | ---: |
| TRTC | 122 |
| KRTC | 39 |
| TYMC | 22 |
| TMRT | 18 |
| NTMC | 26 |
| KLRT | 38 |
| NTDLRT | 14 |
| NTALRT | 9 |
| TRTCMG | 4 |

`pnpm exec ts-node src/scripts/import-tdx-metro.ts --dry-run --system=NOT_A_SYSTEM` 回傳 exit 1，未嘗試正式資料庫連線。

2026-10-05 13:43（臺北）使用真實 API 回應執行現有函式：

- 臺鐵臺北→臺中當日 OD 10 筆、臺北站別班表 10 筆可正常解析；以真實回應的結構改變旗標，確認整班停駛／到站停駛排除、仍可搭乘的部分停駛保留。這些停駛情境是**真實格式的合成變體**，不是當下發生停駛的現場紀錄。
- 公路客運逐筆 N1 30 筆皆有可用預估；其中一筆原始 **1486 秒**，依 `SrcTransTime` 校正成 **1474.946 秒**。把來源時間改成超過時效門檻、保留最新 TDX UpdateTime 時，仍被拒絕為即時預估。
- 臺北 basic CarPark 回應 **673 筆**；修正文獻中「basic 全空」的現況描述。
- 生成 OpenAPI 的 `/transit/bus/arrival`、`/transit/bus/positions` 方向 enum 均為 `[0,1,2,10,255]`。

2026-10-05 13:45（臺北）另啟動實際 Express HTTP server 與獨立 MongoMemoryServer，未 mock 公車 service／TDX fetch：

`GET /api/v1/transit/bus/arrival?routeName=1145&stopName=豐濱&city=InterCity&direction=0`

回應 **HTTP 200、ok=true、2 筆到站資料皆有即時分鐘數**。此驗證通過真實 router → validation → controller → service → MongoDB → TDX 路徑，測試後關閉 server 與隔離資料庫。

### 回歸與工具鏈

- 全套測試、最終 build 與 diff 檢查結果見下方「最終檢查」。
- 回歸涵蓋：正常／整班停駛／站點停駛／部分停駛、空班表與壞格式、來源年齡校正、過期正值不誤報到站、舊零秒預估、2 小時保留資料、未提供來源時間的快取倒數、來源時鐘偏差、循環線 filter／標籤／HTTP／OpenAPI、過期同名站不改配附近站。
- MongoDB integration 使用正式 model、真正的 bulkWrite 與 repository，確認淡海、安坑及不規則 UID 的站點可以匯入、更新、查回；重複匯入不產生重複站點，路線與座標正確保存。

## 修改檔案

| 檔案 | 原因 |
| --- | --- |
| `src/utils/rail-suspension.ts`、`src/types/rail.ts` | 共用列車／站點停駛契約與區間判斷 |
| `src/adapters/rail.parse.ts`、`rail.parse.test.ts` | 班表過濾及正常／停駛／部分停駛回歸 |
| `src/utils/tdx-bus-eta.ts`、`tdx-bus-eta.test.ts` | 來源時間、倒數、時效及快取收件時間 |
| `src/types/transit.ts`、`src/constants/bus.ts`、`src/utils/transit-text.ts` | N1 時間欄位、方向值、標籤與時效常數 |
| `src/modules/transit/bus.service.ts`、`bus.service.test.ts` | 單站及路線詳細資料的 ETA 校正與上游方向 filter |
| `src/modules/transit/transit.schema.ts`、`transit.routes.test.ts` | HTTP 邊界契約、OpenAPI 與新增方向路由測試 |
| `src/modules/accessible-route/planners/realtime-transit.ts`、`realtime-transit.types.ts`、`realtime-transit-contracts.test.ts` | 即時疊加、快取倒數及班次配對 |
| `src/config/ai/tool.ts`、`src/modules/ai/agent-tools.ts` | AI 工具方向描述及公車通阻傳遞 |
| `src/config/transit.ts`、`src/scripts/import-tdx-metro.ts`、`src/scripts/tdx-metro-parse.ts` | 系統清單、真實匯入 dry-run／失敗結果與依 StationID 對應操作 |
| `src/modules/transit/metro.repository.integration.test.ts` | 真正 MongoDB 中的站點 upsert／更新／查回 |
| `src/scripts/import-tdx-parking.ts`、`docs/reports/TDX_QUOTA_AND_DATA_DRIFT.md` | 更正過時供應狀態註解與限制文件 |
| 本報告 | 保存修正範圍、實測證據與驗收限制 |

端點掛載維持 `/api/v1/transit/bus/arrival`、`/api/v1/transit/bus/positions`、`/api/v1/transit/bus/route-detail`；OpenAPI 位於 `/api/v1/openapi.json`。未新增路由註冊。

## 政策與驗收限制

- **5 分鐘來源年齡、30 秒零值時效／時鐘偏差是本系統政策，非官方門檻**。來源缺時間時只能校正本機快取年齡，無法證明收到前有多舊。
- 停駛修正涵蓋查詢班表及班次配對，沒有擴展成刪除所有 OTP 已帶數字車次的靜態行程；未知／上游失敗保持既有規劃 fallback。10 分鐘 OD 快取仍可能有更新延遲。
- 生產資料庫未重新匯入，服務未部署，正式 OTP graph 未重建；本次證據是本機修正、真實 TDX、真實本機 HTTP 與隔離 MongoDB，不宣稱生產系統已套用。
- 沒有獨立代理審查；採主代理 diff 審查、正反例、完整測試與真實資料驗證。

官方依據：[公車動態使用指引](https://motc-ptx.gitbook.io/tdx-zi-liao-shi-yong-kui-hua-bao-dian/data_notice/public_transportation_data/bus_dynamic_data)、[公車 OpenAPI](https://tdx.transportdata.tw/webapi/File/Swagger/V3/2998e851-81d0-40f5-b26d-77e2f5ac4118)、[軌道 OpenAPI](https://tdx.transportdata.tw/webapi/File/Swagger/V3/268fc230-2e04-471b-a728-a726167c1cfc)。

## 最終檢查

- `pnpm build`：exit 0；`lint:arch` 通過、TypeScript 編譯通過。
- `pnpm test`：exit 0；**218 個測試檔通過、7 個略過；2930 個測試通過、17 個略過**。結果為 2026-10-05 13:46 起跑的工作樹；包含最後的精確站名回歸調整。其後只修正測試 fixture：排程保持 GTFS 方向 0、即時來源使用 TDX 方向 10，該測試檔 9 項於 13:51 再次全數通過。
- 額外的 `pnpm typecheck`（包含測試檔）：exit 1，剩餘 12 處既有測試型別錯誤。以獨立 HEAD `2cbfd89` worktree 執行同指令，錯誤檔案、位置與訊息完全一致；本次新增測試沒有留下新型別錯誤。此檢查不能宣稱全綠。
- `git diff --check`：exit 0。
- 全 src 搜尋確認沒有其他直接消費 `EstimateTime` 的業務路徑繞過共用校正；雙鐵的 0/1 方向限制保留，不把公車新增值誤套到雙鐵。
