# 部署手冊 — Ubuntu 24.04 LTS（noble）自建主機

> 適用情境：單台 Ubuntu 24.04 伺服器，**自建 MongoDB**、OTP **在本機建圖**、API **不對外公開**（內網／埠口存取）。
> 相關文件：OTP 生命週期見 [`OTP_OPERATIONS.md`](./OTP_OPERATIONS.md)。

## 架構總覽

本手冊使用主機 Node 與 MongoDB，OTP 和政府人行道來源資料庫由 Compose 管理：

```
                ┌─────────────────────────────────────────┐
   client ───►  │  Node API (systemd, :8000)               │
                │   ├─► MongoDB        (localhost:27017)    │  ← a11y/bus/metro 資料
                │   ├─► OTP sidecar    (127.0.0.1:18080)    │  ← 交通與直接步行路網
                │   └─► PostGIS        (127.0.0.1:5434)     │  ← 政府人行道來源
                └─────────────────────────────────────────┘
```

| 元件        | 跑法                       | 必要？                                  |
| ----------- | -------------------------- | --------------------------------------- |
| Node API    | systemd service            | ✅                                      |
| MongoDB 8.0 | apt 安裝、systemd          | ✅（存 a11y/公車站/捷運站等）           |
| OTP 2.9.0   | Docker（`docker compose`） | ✅（大眾運輸與 native 直接步行） |
| PostGIS     | Docker（`docker compose`） | ✅（政府人行道來源及來源版本核對） |
| Redis       | —                          | ❌ 選用（`REDIS_URL` 沒設就全程 no-op） |

> ⚠️ 重點：`src/server.ts` **不會自己讀 `.env`**（只有 `dev` 腳本用 dotenvx）。生產環境靠 systemd 用 `node -r dotenv/config` 載入 `.env`（`dotenv` 已是正式依賴）。

---

## Phase 0 — 系統準備

```bash
# 建一個非 root 部署帳號（若還沒有）
sudo adduser deploy && sudo usermod -aG sudo deploy
# 之後步驟都用 deploy 登入操作

sudo apt update && sudo apt upgrade -y
sudo apt install -y git python3 build-essential ca-certificates curl gnupg
```

### Node.js 22 LTS（NodeSource）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 應為 v22.x（v20 也可）

# 本專案的套件管理器是 pnpm，版本由 package.json 的 packageManager 欄位釘住
sudo corepack enable
```

### Docker Engine + compose plugin

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy      # 加入 docker 群組
# ⚠️ 重新登入（或 newgrp docker）讓群組生效
docker run --rm hello-world          # 驗證
```

---

## Phase 1 — 自建 MongoDB 8.0

MongoDB 8.0 官方支援 noble（24.04）。

```bash
curl -fsSL https://pgp.mongodb.com/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

### 開啟驗證 + 建使用者

```bash
# 1) 先建管理者（趁還沒開 auth）
mongosh <<'EOF'
use admin
db.createUser({ user: "admin", pwd: "<強密碼>", roles: ["root"] })
use accessible_map
db.createUser({ user: "app", pwd: "<app密碼>", roles: [{ role: "readWrite", db: "accessible_map" }] })
EOF

# 2) 開啟 auth（保留預設只綁 127.0.0.1，不對外）
sudo sed -i 's/^#security:/security:\n  authorization: enabled/' /etc/mongod.conf
sudo systemctl restart mongod
```

> `mongod` 預設 `bindIp: 127.0.0.1` —— 只走本機，外網碰不到，符合「不對外」需求。
> 你的 `DATABASE_URL` 會是：`mongodb://app:<app密碼>@127.0.0.1:27017/accessible_map?authSource=accessible_map`

---

## Phase 2 — 取得程式碼 + 設定環境變數

```bash
sudo mkdir -p /opt && sudo chown deploy:deploy /opt
cd /opt
git clone <你的 repo url> accessible-smart-map-backend
cd accessible-smart-map-backend
git checkout feat/hybrid-transit-routing    # 含本次捷運修正的分支
cp .env.example .env
nano .env
```

`.env` 至少要填（依本專案實際用到的變數）：

```ini
PORT=8000
NODE_ENV=production
CORS_ORIGINS=https://你的前端網域            # 逗號分隔多個
DATABASE_URL=mongodb://app:<app密碼>@127.0.0.1:27017/accessible_map?authSource=accessible_map

GOOGLE_MAPS_API_KEY=...
GEMINI_API_KEY=...
JWT_ACCESS_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
TDX_CLIENT_ID=...
TDX_CLIENT_SECRET=...

# OTP 路徑規劃引擎
OTP_BASE_URL=http://127.0.0.1:18080
OTP_SERVE_XMX=6g

# Compose PostGIS；主機 Node／匯入腳本走 5434
PED_PG_USER=<資料庫使用者>
PED_PG_PASSWORD=<資料庫密碼>
PED_GRAPH_DATABASE_URL=postgresql://<資料庫使用者>:<資料庫密碼>@127.0.0.1:5434/ped_graph
```

> OTP 資料固定放在專案的 `otp-data/`，由主機建圖腳本產生，不必設定資料目錄環境變數。`OTP_SERVE_XMX` 控制服務 heap，請依主機與其他服務的記憶體用量設定。使用 Compose 後端時，內部 OTP 與 PostGIS 位址會由 Compose 覆寫。

---

## Phase 3 — 安裝依賴 + 編譯

```bash
cd /opt/accessible-smart-map-backend
pnpm install --frozen-lockfile   # 含 devDependencies；postinstall 會自動跑 pnpm run build → dist/
ls dist/server.js                # 確認編譯產物存在
```

> 為什麼裝 devDependencies？`postinstall` 用 `tsc`（devDep）編譯；且 `import:*` 資料灌入腳本走 `ts-node`（devDep）。這台 RAM 充足，不需 prune。
>
> `--frozen-lockfile` 保證裝出來的版本與 `pnpm-lock.yaml` 完全一致（lockfile 與 `package.json` 不同步時會直接報錯而不是悄悄升級），部署一律加這個旗標。

---

## Phase 4 — 灌 MongoDB 資料（兩條路，擇一）

App 需要 Mongo 裡的 a11y 地點、公車站、捷運站、TRA/THSR 站等資料才完整。

### 路徑 A（推薦）：從本機 dump 搬過去

避免在伺服器重打 TDX（有 429 限流）與 Overpass。在**本機**：

```bash
# 本機（macOS）匯出
mongodump --uri="<本機 DATABASE_URL>" --out=/tmp/mongo-dump
tar czf /tmp/mongo-dump.tgz -C /tmp mongo-dump
scp /tmp/mongo-dump.tgz deploy@<伺服器>:/tmp/
```

```bash
# 伺服器匯入
tar xzf /tmp/mongo-dump.tgz -C /tmp
mongorestore --uri="$DATABASE_URL" --drop /tmp/mongo-dump/<原db名>
```

### 路徑 B：在伺服器重新灌（會打 TDX/Overpass）

```bash
cd /home/nutcai/1111131042/accessible-smart-map-backend
pnpm import:osm          # OSM 無障礙設施
pnpm import:tdx-stops    # 公車站
pnpm import:tdx-metro    # 捷運站
pnpm import:tdx-thsr     # 高鐵站
pnpm import:tdx-tra      # 台鐵站
pnpm fetch:gtfs          # 下載 TDX 全國 GTFS 到 data/gtfs
pnpm import:gtfs-all     # GTFS stops/trips/pathways/levels（OTP 方向反查 + 室內導引用；
                            # 排程表 routes/calendar/stop_times/shapes 已隨自製 router 退役，不再匯入）
```

> ⚠️ TDX 連續呼叫會 429（burst 4–6 次就觸發），腳本間隔已內建；若 429 就等幾分鐘重跑該支。所以推薦走路徑 A。

#### 一鍵版：`pnpm data:sync`

上面的步驟（加上 PostGIS 坡道、Valhalla 地磚、RAG 等）已整合成一個指令，依相依順序執行，TDX 步驟之間自動間隔：

```bash
pnpm data:sync --all --plan   # 先看會跑哪些步驟，並檢查 env／指令／Mongo、PostGIS、Chroma、docker 連線
pnpm data:sync:all            # 新環境完整灌一次
pnpm data:sync                # 日常更新：只跑 upsert 類步驟（不清空集合、不重啟 Valhalla、不花錢）
```

- 加選群組：`--with-snapshot`（a11y-metro／bathrooms，staging 驗證後整批替換）、`--with-valhalla`（缺 PBF 才下載 → 建地磚並重啟 Valhalla → 重建 traffic map／tar）、`--with-slow`（停車場全台掃描、校園爬蟲，校園會先清空）、`--with-paid`（welfare Geocoding 後整批替換、RAG embedding）。
- `--skip=<id,...>` 排除步驟；`--only=<id,...>` 只跑指定步驟（忽略群組旗標）；前置步驟沒選到會直接報錯。另有 `--fail-fast`（第一個失敗就停）、`--tdx-gap=<秒>`（TDX 步驟間隔，預設 10）。
- 公開資料每次同步都直接從官方來源下載，不需要預先放檔案：GTFS（`gtfs-feed` 步驟，TDX 全國 feed 約 470 MB，需要 `unzip`；只解出 levels／stops／trips／pathways 到 `data/gtfs`）、捷運無障礙出入口（data.taipei）、無障礙廁所（環境部 `fac_p_07`，需要 `MOENV_API_KEY`）、身障福利機構（衛福部）。下載或驗證失敗時保留舊資料。
- 仍需本地檔案的只有非公開資料：`data/rag`（paid）與 `data/venues/nutc-sanmin.osm`（snapshot）。缺檔時 preflight 會擋下，什麼都不執行。
- Valhalla 的 PBF 只在檔案不存在時下載；要更新 OSM 就先刪掉舊的 PBF 再跑。
- `traffic-tar` 和 `traffic-map` 即使沒產出也可能 exit 0，結束時摘要會列出提醒，請看該步驟的 Result 行。
- 全台人行道 `sidewalks` 是 base 步驟，只需 `PED_GRAPH_DATABASE_URL` 指向可用的 PostGIS，首次匯入不需 `ped_graph_version`。預設每次從[內政部官方 ZIP](https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/11D38E3D-F980-40BF-B714-4E0DB8AA1252/resource/673E16B8-66BC-4DD6-BA39-767BE3324F5C/download) 下載；可用 `SIDEWALK_SOURCE_URL` 或 `--url <URL>` 指定來源。

  ```bash
  pnpm import:sidewalks --dry-run       # 驗證 ZIP／22 縣市／清洗與 PostGIS 幾何，不發布
  pnpm import:sidewalks --zip <path>    # 本地 ZIP 匯入，不改原檔、不建圖
  pnpm data:sync --only=sidewalks       # 網路下載並發布來源快照，不建圖
  ```

  資料庫連線只從 `.env`／環境變數 `PED_GRAPH_DATABASE_URL` 讀取，不支援 `--db-url`；不要將含密碼的 URI 放進命令列，pnpm 可能回顯參數。`--url` 也只應填不含憑證的公開網址。

  清洗保留有效人行道存在幾何與原始屬性；無效／矛盾淨寬是未知證據，不代表可通行。報告列出 SHA256、原始／接受／隔離筆數與原因，相同 ZIP 不重複建立版本；重匯歷史 ZIP 時會驗證並切換來源快照。`ped_sidewalk_source_version`／`ped_sidewalk_polygon` 是獨立、版本化的參考來源，來源本身不是路網。`pnpm import:sidewalks` 與 `data:sync` 的人行道步驟都只匯入來源；套用路網須另行執行 `pnpm otp:rebuild`。新來源先切 ACTIVE，在新圖載入前，舊圖可能因來源不符而回傳 503，須安排維護時段。
- `import:taipei-ramps` 仍需要 PostGIS 已有 ped graph（`ped_graph_version` 表）；還沒建就加 `--skip=taipei-ramps`。
- 在 host 上跑時，`.env` 的 `DATABASE_URL`／`PED_GRAPH_DATABASE_URL` 要指向 compose 對外的埠（Mongo `27018`、PostGIS `5434`）。

#### 全國步行圖（PostGIS／CSR）

先備妥原始全國 PBF、已匯入的人行道來源版本及 GTFS。建圖主機需要 Python 的 osmium、Shapely、psycopg2；API 的 Node 程序不會在請求時替你建圖。以下 `<SOURCE_ID>` 為匯入產生的不可變來源版本，`<GRAPH_ID>` 為建圖輸出的候選版本：

```bash
pnpm build:ped-graph --pbf otp-data/taiwan-latest.osm.pbf --bbox taiwan --sidewalk-source-version <SOURCE_ID> --exclude-invalid-osm-areas --disk-stage-edges
pnpm inject:ped-indoor --version-id <GRAPH_ID> --bbox taiwan --gtfs-dir data/gtfs --exclude-invalid-gtfs
```

- `--disk-stage-edges` 將邊資料暫存至私人 SQLite，降低邊的常駐記憶體；面網格、節點與後續載入仍需要 RAM，並非固定記憶體上限。`TMPDIR` 應指向有足夠可寫空間的磁碟；全國建圖和資料庫索引均須預留容量。
- 兩個 `--exclude-invalid-*` 都是**明確選用**。省略時保留嚴格診斷；選用時只隔離可識別的壞來源記錄，警告及候選 notes 保存原始識別、內容、原因、政策與輸入雜湊。不能靠排除有效資料或吞掉程式／I/O／資源錯誤完成建圖。未匹配的 GTFS 接線不會靠距離補直線，獨立有效的站內通道仍保留。
- CSV 模式直接讀標準 GTFS `stops.txt`／`pathways.txt`（有 `levels.txt` 時一併保留來源），不需要 PyMongo。未指定 `--gtfs-dir` 可沿用 Mongo 來源；排除 GTFS 壞記錄的選項僅適用 CSV 模式。
- 新圖保持 `CANDIDATE`，完成站內注入也不會自動啟用。先核對來源雜湊、22 縣市與離島的代表路線、合法接線／禁行反例、實際 CSR 載入與冷／暖／並行請求資源，並審閱缺漏。不可將建圖 exit 0、面資料匯入或少數範例成功當成路線驗收。
- 完成自己的驗收後，操作人員才明確執行 `pnpm promote:ped-graph --version-id <GRAPH_ID>`；不要直接 UPDATE lifecycle 繞過檢查，也不要讓兩個資料庫程序共用同一 PGDATA。本文範例不會自動執行 promotion。
- 舊圖只有 `sidewalk-v1` 標籤並不足以證明已處理同層來源淨寬衝突；需用新 builder 重建，產生 `source_width_policy` 的版本／規則雜湊證據。不得直接補寫舊 notes 假裝重建。局部寬度限制須同時保留在面、原生邊與站內接線，不靠較寬或未知資料繞過已知較窄的同層範圍。
- 涉及 WALK 的 API 會拒絕未合格、來源不符、未完成注入或無法合法接線的路網；不改走未驗證的 OTP／Valhalla 步行線。缺失或不確定的坡度、淨寬、障礙與電梯狀態不等於現場無障礙，保留的來源缺漏亦不代表已補齊。

---

## Phase 5 — OTP sidecar

在主機上分別執行政府人行道匯入與 OTP 建圖。建圖前依 [OTP 維運手冊](./OTP_OPERATIONS.md#新環境啟用) 安裝 Python 建圖套件（osmium、Shapely、rasterio、psycopg2）、啟用虛擬環境，並確認 Node／pnpm、Docker Compose、`curl`、`zip`、`unzip`、`git` 可用。

完成 `.env` 中的 TDX、PostGIS、Mongo 設定，並依 Phase 4 備妥 Mongo 基礎資料。主機腳本須連到實際對外埠；本手冊採主機 Mongo，PostGIS 則使用 Compose 的 **5434**。Valhalla 路網屬於其他後端功能的部署要求，不是本步驟的建圖前提。

```bash
docker network inspect accessible-shared >/dev/null 2>&1 || docker network create accessible-shared
docker compose up -d --wait postgis
pnpm import:sidewalks
pnpm otp:rebuild
```

`import:sidewalks` 只下載、驗證並匯入官方人行道來源，成功後才執行 `otp:rebuild`。後者負責建圖預檢、完整 GTFS 下載／清理、台鐵及捷運補強、Mongo 設施補強、站牌合併及對照表匯入、OSM／DEM 與政府人行道編圖。既有交通驗證和新增的一般／輪椅／中途點試排都通過後，才載入 OTP。各指令失敗會回傳非零狀態，請先修正原因，再繼續下一步。

所有產物由腳本放進固定的 `otp-data/`，不需手動建立 graph、manifest、release 指標或設定資料目錄環境變數。`docker compose up` 只載入已建好的圖，不會在啟動時下載或建圖。第一次全國資料處理可能耗時較長，請預留主機／Docker VM 記憶體與磁碟，並安排維護時段。

來源會先切換為 ACTIVE；建圖或載入失敗後，即使舊圖檔仍保留，後端也可能因來源不符回傳 503。不要把保留舊檔解讀為已完整復原；修正後可用 `pnpm otp:rebuild` 重建目前來源。

本手冊的主機 Node 服務依 Phase 6 啟動。若採用 Compose 後端，建圖成功後執行：

```bash
docker compose up -d --build backend
```

Compose 內後端使用 `http://otp:8080`；主機 Node 使用 `http://127.0.0.1:18080`。不要同時啟動兩種後端部署方式占用相同埠。

日後更新人行道並套用圖，先執行 `pnpm import:sidewalks`，成功後再執行 `pnpm otp:rebuild`。只沿用目前來源重建時，執行 `pnpm otp:rebuild`（`pnpm build:otp` 為同流程別名）。匯入指令的 `--dry-run` 不發布來源；`data:sync` 的人行道步驟也只負責匯入。完整選項、備份與失敗處理見 [OTP 維運手冊](./OTP_OPERATIONS.md#指令與來源選項)。

目前直接步行驗收範圍為本島 19 縣市，離島暫緩。其他輔助模式、大眾運輸接駁與停車步行仍需既有 CSR 資料。雲端憑證、Valhalla 與其他後端功能仍依原有部署要求準備。

---

## Phase 6 — Node API 設為 systemd 服務

```bash
sudo tee /etc/systemd/system/accessible-backend.service > /dev/null <<'EOF'
[Unit]
Description=Accessible Backend API
After=network-online.target mongod.service docker.service
Wants=network-online.target mongod.service

[Service]
Type=simple
User=nutcai
WorkingDirectory=/home/nutcai/1111131042/accessible-smart-map-backend
# -r dotenv/config 會從 WorkingDirectory 載入 .env（dotenv 是正式依賴）
ExecStart=/usr/bin/node -r dotenv/config dist/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now accessible-backend
sudo systemctl status accessible-backend --no-pager
journalctl -u accessible-backend -f      # 看 log
```

開機自動：`mongod`（systemd enable）、`otp`（compose `restart: unless-stopped` + docker 服務開機啟動）、`accessible-backend`（systemd enable）都會自動回來。

---

## Phase 7 — 防火牆 + 冒煙測試

```bash
# 只開 SSH；MongoDB(27017)、OTP(18080)、PostGIS(5434) 只綁 127.0.0.1，不需開
sudo ufw allow OpenSSH
# 若 API 要給「內網其他機器」連，才開該埠（否則連這條都不用）：
# sudo ufw allow from <內網網段> to any port 8000 proto tcp
sudo ufw enable
sudo ufw status
```

冒煙測試：

```bash
# 1) API 活著
curl -s http://localhost:8000/ -o /dev/null -w "API HTTP %{http_code}\n"

# 2) 端到端路由（含本次捷運修正）— 忠孝復興 → 松山機場（純文湖線）
#    路徑 = /api/v1/a11y/accessible-route；座標欄位是 latitude/longitude
curl -s -X POST http://localhost:8000/api/v1/a11y/accessible-route \
  -H 'Content-Type: application/json' \
  -d '{"origin":{"latitude":25.0411,"longitude":121.5437},"destination":{"latitude":25.0631,"longitude":121.5516},"mode":"normal"}' \
  | python3 -m json.tool | head -40
# 應出現 type:"METRO" / 文湖線 的 leg
```

---

## 日常維運

| 工作 | 指令 |
| --- | --- |
| 看主機 API log | `journalctl -u accessible-backend -f` |
| 重啟主機 API | `sudo systemctl restart accessible-backend` |
| 更新程式碼 | `git pull && pnpm install --frozen-lockfile && sudo systemctl restart accessible-backend` |
| OTP 啟停 | `docker compose up -d otp` / `docker compose stop otp` |
| OTP log | `docker compose logs --tail 100 otp` |
| 更新人行道來源 | `pnpm import:sidewalks` |
| 使用已匯入來源建圖及載入 OTP | `pnpm otp:rebuild` |

交通班表有期限，應定期執行 `pnpm otp:rebuild`，完成建圖、驗證及載入。`scheduled-otp-rebuild.sh` 會先更新部署 checkout，再呼叫同一流程；主機的 Python 環境、設定及服務也必須可用。來源更新與失敗處理以 [OTP 維運手冊](./OTP_OPERATIONS.md) 為準。

## 疑難排解

| 症狀                           | 多半原因 / 處置                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| API 啟動即崩、env 都 undefined | systemd 沒載到 `.env` → 確認 `WorkingDirectory` 正確、`.env` 在該目錄、用了 `-r dotenv/config` |
| 路由都沒捷運/台鐵              | OTP 沒起來或 graph 沒含注入 → `docker logs otp`、確認 `OTP_BASE_URL` 可連                      |
| API 每次卡 ~30 秒才回          | MongoDB 連不上 → `systemctl status mongod`、檢查 `DATABASE_URL` 帳密/authSource                |
| 建圖 `exit 137` | 檢查主機／Docker VM 記憶體與並行服務，增加容量或安排維護時段；不要假定大型主機不會 OOM。 |
| 圖或來源身分不符 | 檢查匯入與建圖 log，確認 release 與 PostGIS 來源、程式／映像一致，再執行 `pnpm otp:rebuild`；不要只替換單一 graph。 |
