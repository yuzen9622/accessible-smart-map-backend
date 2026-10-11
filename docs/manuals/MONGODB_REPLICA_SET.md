# MongoDB 單節點 replica set

此部署使用 MongoDB 7、rs0、成員 mongo:27017，保留既有 mongo-data volume 與帳密。單節點提供多文件交易，但沒有第二份副本、主機故障切換或跨主機容錯。

## 設定與首次啟動

- 部署設定只放根目錄 `Dockerfile` 與 `docker-compose.yml`。MongoDB 的啟動與初始化腳本直接定義於 `docker-compose.yml` 的 `configs.content`，由 Compose 掛載到容器 `/opt/mongo/`；不需要主機腳本檔案。此功能需要 Docker Compose 2.23.1 以上。
- Compose 內嵌的 `mongo-entrypoint` 在 mongo-keyfile volume 首次建立內部認證 key，owner=mongodb、mode=400；重啟不重建。不可提交或輸出 key。
- Compose 只對主機127.0.0.1:27018開埠，內部後端用 mongo:27017。初始化與健康檢查分離，健康須 rs0 PRIMARY。
- 新環境直接 `docker compose up -d`：一次性的 `mongo-init` 服務在 MongoDB 啟動後等待認證連線可用（最多120秒），執行內嵌的初始化腳本；後端必須同時等初始化成功與 MongoDB 健康才啟動。健康檢查只讀取 PRIMARY，不執行初始化。初始化可重跑，若發現其他 replica set／member 設定則拒絕覆寫。
- 只啟動 `mongo` 不會啟動初始化服務，因此新 replica set 尚未初始化時顯示 unhealthy 是預期狀態。維護時可執行 `docker compose up -d mongo-init` 或 `docker compose exec -T mongo mongosh --quiet /opt/mongo/init.js` 完成初始化。初始化失敗時檢查 `docker compose logs mongo mongo-init`；不可透過刪 volume 或停用認證排除。
- 後端容器 DATABASE_URL 含 `authSource=admin&replicaSet=rs0`。主機腳本連127.0.0.1:27018，另加 `directConnection=true`，避免 driver 嘗試解析 Docker 專用 mongo hostname。其他客戶端也需檢查；不要改帳密／資料庫名稱。
- 啟動交易版應用前必須完成 PRIMARY 初始化；standalone 沒有交易降級寫法，舉報會503。

## 既有正式機切換

1. 確認 Compose project、mongo-data 實際 volume、Mongo 版本、所有讀寫客戶端與排程。保留舊 image ID、Compose、設定與新程式可重現的 build；先用隔離 Mongo 演練既有 auth/data 轉換、重啟、commit/abort。
2. 停止 backend（包含背景 workers）及其他 writer/import jobs。standalone 在線 mongodump 不提供跨集合一致快照；最終備份必須在停 writer 後建立。
3. 在權限700的備份目錄保存最終 mongodump archive（含 admin 帳號）、Compose／連線設定；最好另停 Mongo 取得 data volume 冷備份。從備份還原到隔離 Mongo，核對集合數量／索引／關鍵資料後才進行切換。備份不可上傳 Git。
4. 套用根目錄 `docker-compose.yml`（已包含全部 MongoDB 部署腳本）；維持原 project 與 mongo-data 名稱，執行 `docker compose up -d mongo-init` 啟動 MongoDB 與 authenticated init，確認 PRIMARY 與重啟後 key／資料保持。
5. 更新主機連線 URI 的 replicaSet／directConnection 選項；重建後端 image，啟動 backend。其他 OTP／Valhalla／Web 不需重啟。
6. 核對資料數量、索引與舊 mail accepted 狀態。用獨立驗證資料庫測試兩集合 transaction commit 及 abort，測後只刪該驗證庫。檢查 API health、受保護端點與 worker error；不重設或重寄已接受的郵件。

## 回復

若切換失敗，先停止 writer，保留失敗狀態供查核。若尚未受理新寫入，可用原 Compose／image／連線設定回復 standalone（或從已驗證冷備份還原）。若已開放新寫入，不可直接覆蓋成舊備份，必須先保存新資料並制定一致的回復點。不要執行 `docker compose down -v`，也不要刪正式資料或 keyfile volume。

## 備份與可用性

備份須涵蓋 data、keyfile 及部署秘密；使用限制權限與既有保存政策。新增256MiB oplog，磁碟需留空間。未配置第二節點，因此停機／硬碟故障仍會中斷服務；這次變更只增加交易能力。
