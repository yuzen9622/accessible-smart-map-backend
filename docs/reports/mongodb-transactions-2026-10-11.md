# 2026-10-11 MongoDB replica set 與內容舉報交易驗證

## 完成狀態

正式 Ubuntu 主機已於台灣時間2026-10-11 12:56完成切換。MongoDB 7.0.39，rs0 單一 PRIMARY，保留原 mongo-data volume、資料庫名稱及帳密；keyfile 使用獨立持久化 volume。後端 image 已重建並啟動，容器 URI 含 replicaSet=rs0，主機 URI 另含 directConnection=true。

## 程式行為

- 舉報案件、雙郵件工作、quota 與 admission 結果使用同一筆 snapshot／majority 交易。失敗完整回滾；duplicate key 競爭只能在 abort 後重開交易。
- 管理處分保留交易外 durable pending intent；目標內容／version／receipt 與案件稽核一起提交。audit CAS 失敗回滾內容效果。舊 pending 及 recovery receipt 仍可恢復。
- 郵件留在交易外，沿用 worker lease、固定 payload 與 provider idempotency key。此次不改重複舉報不重寄的契約。

## 本機及獨立驗證

- 41項內容安全整合測試：真正單節點 MongoMemoryReplSet，僅郵件 adapter 是替身；涵蓋 rollback、CAS miss、提交前郵件不可見、transient conflict、unknown commit retry、去重、配額上限、舊資料恢復與處分競爭。
- 8項 email adapter 測試、1項 standalone 拒絕交易且不留下部分寫入測試通過；合計50項，分批執行。
- `pnpm build`、變更的 TypeScript ESLint、`git diff --check` 通過。
- `pnpm typecheck` 的35項錯誤與乾淨 HEAD `6ed2647e3c49c7c95919783db89c1f12ff863767` 診斷逐字相同：hazard-report 13、retention 21、Apple auth 1。沒有新增型別錯誤；不宣稱全專案 typecheck 通過。
- 獨立代理審查未發現阻擋；非跨模型審查。非阻擋限制：處分已提交後若 readback／receipt cleanup 暫時失敗，API 仍可能先回503，背景工作會接續。
- 隔離 Docker 以既有帳密／資料轉換，驗證兩集合 commit／abort、重啟、keyfile 持久化及初始化可重跑。

## 正式機證據

1. 停止 backend／workers 與 MongoDB後建立 cold volume archive，備份保存在正式機使用者的 `backups/mongo-rs-20261011043935` 限制權限目錄，含部署設定、原版後端編譯檔、cold archive、SHA-256、keyfile與驗證結果；不在Git中。
2. 備份還原到隔離 MongoDB，39個應用集合的 dbHash、儲存層筆數與索引和停機基準一致。正式轉換後再次完全相符。初始化只改 replica-set 系統資料。
3. 正式 rs0 PRIMARY 已實測兩集合 commit／abort；驗證僅寫入專屬暫存資料庫，完成後清除該庫。
4. 新後端的實際 `reportContent` 與 repository 在正式 Mongo 的另一個隔離驗證庫執行：正常提交成功、重送回 duplicate、在 quota 寫入後注入故障使新案件與quota一起回滾。測試未啟動 mail worker，沒有真實寄信；該庫已清除。
5. 執行中的 transaction／admission／decision／worker JS SHA-256 與本機build一致。host 127.0.0.1:27018 的 direct connection 也通過認證與PRIMARY檢查。
6. 後端容器 `/health` 200；對外受保護案件API未登入回403。正式原有案件仍為 admitted，team／reporter都維持accepted；檢查時無 content-safety worker unavailable 或 unsupported transaction錯誤。

部署前曾遇到舊容器 image ID 無法查找、備份掛載與檔案擁有者問題；均恢復原服務後修正並重新演練。最後切換使用已驗證可還原的最新冷備份。保留原編譯檔的回復映像使用相同鎖定依賴建置，未將容器環境秘密寫進映像。

## 邊界

這次未新建正式使用者舉報或寄送真實通知。單節點提供交易但沒有第二份資料副本及自動故障切換。本機原有 map-dev Docker 尚未切換；日後啟動交易版後端前，須依 [操作手冊](../manuals/MONGODB_REPLICA_SET.md) 先初始化 replica set。程式與正式機工作目錄保留未提交變更，沒有commit或push。
