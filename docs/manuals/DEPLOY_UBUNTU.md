# 部署手冊 — Ubuntu 24.04 LTS（noble）自建主機

> 適用情境：單台 Ubuntu 24.04 伺服器，**自建 MongoDB**、OTP **在本機建圖**、API **不對外公開**（內網／埠口存取）。
> 相關文件：OTP 生命週期見 [`OTP_OPERATIONS.md`](./OTP_OPERATIONS.md)。

## 架構總覽

這個後端有三個必須一起跑的元件：

```
                ┌─────────────────────────────────────────┐
   client ───►  │  Node API (systemd, :8000)               │
                │   ├─► MongoDB        (localhost:27017)    │  ← a11y/bus/metro 資料
                │   └─► OTP sidecar    (127.0.0.1:8080)     │  ← 大眾運輸路網 graph
                └─────────────────────────────────────────┘
```

| 元件        | 跑法                       | 必要？                                  |
| ----------- | -------------------------- | --------------------------------------- |
| Node API    | systemd service            | ✅                                      |
| MongoDB 8.0 | apt 安裝、systemd          | ✅（存 a11y/公車站/捷運站等）           |
| OTP 2.9.0   | Docker（`docker compose`） | ✅（路徑規劃唯一引擎）                  |
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
OTP_BASE_URL=http://localhost:8080

# 給 docker compose 用（OTP 資料目錄）
OTP_DATA_DIR=/opt/accessible-smart-map-backend/otp-data
OTP_SERVE_XMX=8g          # 125GB RAM，給足
```

> `docker compose` 會讀同目錄的 `.env` 來替換 `${OTP_DATA_DIR}` / `${OTP_SERVE_XMX}`，所以這兩個放 `.env` 即可。

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
pnpm import:gtfs-all     # GTFS stops/trips/pathways/levels（OTP 方向反查 + 室內導引用；
                            # 排程表 routes/calendar/stop_times/shapes 已隨自製 router 退役，不再匯入）
```

> ⚠️ TDX 連續呼叫會 429（burst 4–6 次就觸發），腳本間隔已內建；若 429 就等幾分鐘重跑該支。所以推薦走路徑 A。

---

## Phase 5 — OTP sidecar

OTP 容器只需要 `otp-data/`（內含 `graph.obj` + 3 個 config）。`graph.obj` 與 OTP 版本綁定，務必都用 `2.9.0`。

### 路徑 A（推薦）：把本機建好的 graph 搬上去

本機這次已建好含**文湖線/環狀線**的新 graph，直接搬：

```bash
# 本機 → 伺服器（~2GB，含 graph.obj + feed + osm + configs）
rsync -avz --progress otp-data/ deploy@<伺服器>:/home/nutcai/1111131042/accessible-smart-map-backend/otp-data/
```

```bash
# 伺服器啟動（compose 已把 8080 綁 127.0.0.1，不對外）
cd /home/nutcai/1111131042/accessible-smart-map-backend
docker compose up -d otp
docker logs otp --tail 20          # 看 "Graph loaded" / "Started listener"
# 健康檢查（載入 graph 約需 30–60 秒）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' \
  -d '{"query":"{feeds{feedId}}"}' && echo "  ← 有 feedId 即正常"
```

### 路徑 B：在伺服器自己建圖（RAM 夠，可行）

需要 `otp-data/` 裡有 `taiwan-gtfs.zip` + `taiwan-otp.osm.pbf`（先 rsync 這兩個，或讓 `build-otp-graph.sh` 重抓）。

```bash
cd /opt/accessible-smart-map-backend
export OTP_DATA_DIR="$PWD/otp-data"
export OTP_GTFS_URLS="<全國 GTFS zip 下載 URL>"   # 見 OTP_OPERATIONS.md §2.1 的注意事項
# 這台 RAM 125GB，建圖(12g) 與服務(8g) 同時跑不會 OOM，不必先停容器
bash src/scripts/build-otp-graph.sh
```

> `build-otp-graph.sh` 會自動：抓 feed → 清理 → 注入 TRA → **注入捷運(本次新增)** → 建圖 → 原子換檔 → 重啟 → healthcheck。
> 驗證碼可選裝 `gtfs-validator`、`osmium-tool`（`sudo apt install osmium-tool`）；沒裝腳本會跳過驗證 gate。

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
# 只開 SSH；MongoDB(27017) 與 OTP(8080) 都只綁 127.0.0.1，不需開
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

| 工作           | 指令                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| 看 API log     | `journalctl -u accessible-backend -f`                                                     |
| 重啟 API       | `sudo systemctl restart accessible-backend`                                               |
| 更新程式碼     | `git pull && pnpm install --frozen-lockfile && sudo systemctl restart accessible-backend` |
| OTP 啟停       | `docker compose up -d otp` / `docker stop otp`                                            |
| OTP log        | `docker logs otp --tail 30`                                                               |
| 每週重建 graph | cron：`0 4 * * 0`，見下                                                                   |

每週日 04:00 自動重建 OTP graph（含捷運/台鐵班表更新）：

```bash
crontab -e
# 加入（OTP_GTFS_URLS 確認後再啟用整段；先用「沿用現有 feed」版本見 OTP_OPERATIONS.md §2.2）
0 4 * * 0 cd /opt/accessible-smart-map-backend && OTP_DATA_DIR=$PWD/otp-data OTP_GTFS_URLS="<url>" bash src/scripts/build-otp-graph.sh >> /var/log/otp-build.log 2>&1
```

## 疑難排解

| 症狀                           | 多半原因 / 處置                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| API 啟動即崩、env 都 undefined | systemd 沒載到 `.env` → 確認 `WorkingDirectory` 正確、`.env` 在該目錄、用了 `-r dotenv/config` |
| 路由都沒捷運/台鐵              | OTP 沒起來或 graph 沒含注入 → `docker logs otp`、確認 `OTP_BASE_URL` 可連                      |
| API 每次卡 ~30 秒才回          | MongoDB 連不上 → `systemctl status mongod`、檢查 `DATABASE_URL` 帳密/authSource                |
| 建圖 `exit 137`                | OOM（這台不會發生；若在小機器則先 `docker stop otp` 釋放記憶體）                               |
| graph 換壞                     | 回滾：`mv otp-data/graph.obj.prev otp-data/graph.obj && docker compose up -d otp`              |
