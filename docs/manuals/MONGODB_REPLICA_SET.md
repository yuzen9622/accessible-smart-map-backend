# MongoDB 單節點 replica set

此部署使用 MongoDB 7、rs0、成員 mongo:27017，保留既有 mongo-data volume 與帳密。單節點提供多文件交易，但沒有第二份副本、主機故障切換或跨主機容錯。

## 設定與首次啟動

- 部署設定只放根目錄 `Dockerfile` 與 `docker-compose.yml`。MongoDB 的啟動與初始化腳本直接定義於 `docker-compose.yml` 的 `configs.content`，由 Compose 掛載到容器 `/opt/mongo/`；不需要主機腳本檔案。此功能需要 Docker Compose 2.23.1 以上。
- Compose 內嵌的 `mongo-entrypoint` 在 mongo-keyfile volume 首次建立內部認證 key，owner=mongodb、mode=400；重啟不重建。不可提交或輸出 key。
- Compose 只對主機127.0.0.1:27018開埠，內部後端用 mongo:27017。初始化與健康檢查分離，健康須 rs0 PRIMARY。
- 新環境直接 `docker compose up -d`：`mongo` 容器自行啟動資料庫，等待正式 MongoDB 認證連線可用（最多120秒），再初始化／驗證 replica set 並等待 PRIMARY（最多30秒）。不再建立獨立的 `mongo-init` 容器；只執行 `docker compose up -d mongo` 也會完成初始化。
- 後端等待 `mongo` 健康才啟動。健康檢查只讀取本次啟動的初始化成功標記與 PRIMARY 狀態，不執行初始化。每次啟動都清除舊標記並驗證拓樸；發現其他 replica set／member 設定時拒絕覆寫，初始化失敗會停止容器並依 restart policy 重試，不會放行後端。
- 容器啟用 init process 回收孤兒程序；啟動包裝程式轉送停止訊號並等待子程序退出，正常停機寬限為30秒。初始化使用 `mongo:27017`，避免誤連官方 image 首次建立 root 帳號時的暫時 localhost-only standalone。
- 初始化失敗時檢查 `docker compose logs mongo`，修正原因後執行 `docker compose restart mongo`，讓啟動流程重新驗證。不可透過刪 volume 或停用認證排除。
- 後端容器 DATABASE_URL 含 `authSource=admin&replicaSet=rs0`。主機腳本連127.0.0.1:27018，另加 `directConnection=true`，避免 driver 嘗試解析 Docker 專用 mongo hostname。其他客戶端也需檢查；不要改帳密／資料庫名稱。
- 啟動交易版應用前必須完成 PRIMARY 初始化；standalone 沒有交易降級寫法，舉報會503。

## 既有正式機切換

1. 確認 Compose project、mongo-data 實際 volume、Mongo 版本、所有讀寫客戶端與排程。保留舊 image ID、Compose、設定與新程式可重現的 build；先用隔離 Mongo 演練既有 auth/data 轉換、重啟、commit/abort。
2. 停止 backend（包含背景 workers）及其他 writer/import jobs。standalone 在線 mongodump 不提供跨集合一致快照；最終備份必須在停 writer 後建立。
3. 在權限700的備份目錄保存最終 mongodump archive（含 admin 帳號）、Compose／連線設定；最好另停 Mongo 取得 data volume 冷備份。從備份還原到隔離 Mongo，核對集合數量／索引／關鍵資料後才進行切換。備份不可上傳 Git。
4. 套用根目錄 `docker-compose.yml`（已包含全部 MongoDB 部署腳本）；維持原 project 與 mongo-data 名稱，執行 `docker compose up -d --wait mongo` 啟動 MongoDB 與容器內 authenticated init，確認 PRIMARY 與重啟後 key／資料保持。
5. 更新主機連線 URI 的 replicaSet／directConnection 選項；重建後端 image，啟動 backend。其他 OTP／Valhalla／Web 不需重啟。
6. 核對資料數量、索引與舊 mail accepted 狀態。用獨立驗證資料庫測試兩集合 transaction commit 及 abort，測後只刪該驗證庫。檢查 API health、受保護端點與 worker error；不重設或重寄已接受的郵件。

## 從獨立 mongo-init 容器更新

已使用 rs0 的環境不需搬移資料或重新初始化 replica set。安排短暫維護時段，停止 backend 與其他 writer，執行 `docker compose up -d --wait mongo` 套用啟動流程；此操作會重建 Mongo 容器，但保留原 data 與 keyfile volumes。確認健康後執行 `docker compose up -d --no-deps backend`。依原方式恢復其他 writer。

確認舊容器屬於本 Compose project、service label 為 `mongo-init` 且已退出後，以 `docker rm <舊 mongo-init 容器名稱>` 移除；不要加 `-v`，也不要使用廣泛的 prune／`--remove-orphans` 清理其他服務。後續 `docker compose up -d` 不會再建立該容器。

## 回復

若切換失敗，先停止 writer，保留失敗狀態供查核。若尚未受理新寫入，可用原 Compose／image／連線設定回復 standalone（或從已驗證冷備份還原）。若已開放新寫入，不可直接覆蓋成舊備份，必須先保存新資料並制定一致的回復點。不要執行 `docker compose down -v`，也不要刪正式資料或 keyfile volume。

## 備份與可用性

備份須涵蓋 data、keyfile 及部署秘密；使用限制權限與既有保存政策。新增256MiB oplog，磁碟需留空間。未配置第二節點，因此停機／硬碟故障仍會中斷服務；這次變更只增加交易能力。
