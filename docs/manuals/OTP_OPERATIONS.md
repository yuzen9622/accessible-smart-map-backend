# OTP2 維運手冊 — 資料更新、建圖、Docker 部署

> 適用版本：OpenTripPlanner **2.9.0**（pin 於 `docker-compose.yml` 與 `build-otp-graph.sh`，2026-06-12 起）
> 相關規格：`docs/specs/FUNCTIONAL_SPEC_OTP2_INTEGRATION.md`（Phase 16）

本文件涵蓋 OTP sidecar 的完整生命週期：GTFS 資料取得 → 清理 → 台鐵班表注入 → graph 建置 → Docker 配置與啟動 → 驗證 → 故障排查。

## 後端搜尋範圍與品質回歸

後端的每輪搜尋窗口與總搜尋範圍分開設定。預設先查 1 小時，再視候選情況擴大至 2 小時；仍無合格大眾運輸候選時，每次向後追加最多 8 小時，直到請求出發時間之後 24 小時。最後一輪只查剩餘範圍。找到合格候選可提早返回，並非每筆請求都查滿 24 小時。

| 後端環境變數 | 預設秒數 | 意義 |
| --- | ---: | --- |
| `OTP_SEARCH_WINDOW_S` | 3600 | 初次搜尋窗口 |
| `OTP_SEARCH_WINDOW_WIDE_S` | 7200 | 同一起點的擴大窗口，與初次窗口重疊 |
| `OTP_CONTINUATION_WINDOW_S` | 28800 | 每輪後續搜尋窗口上限 |
| `OTP_SEARCH_HORIZON_S` | 86400 | 從請求出發時間起算的總搜尋截止範圍 |

這些窗口針對可搜尋的出發班次，不是行程可花費的時間。變更分段大小不得暗中縮小總範圍：例如 12:30 的請求，`2h + 8h + 8h` 只到隔天 06:30，會漏掉 06:37／06:40 的早班。預設總範圍保留既有 24 小時行為，追加至隔天 12:30。`skipLaterService` 的短途流程與上游錯誤處理仍各自適用。

避樓梯模式下，OTP 已明示含樓梯的候選不算搜尋已滿足，必須繼續尋找無樓梯候選。這項判定不能代替後續設施、電梯與步行無障礙資料檢查；資料未知也不能推論為已確認無障礙。

品質評測的固定案例在 `src/scripts/fixtures/route-known-feasible.json`；另可把前一版評測輸出作為參考，按完整請求內容配對，不能只比較樣本編號。保存參考資料後再測新版：

```bash
python3 src/scripts/eval-route-quality.py --help
python3 src/scripts/eval-route-quality.py \
  --base http://127.0.0.1:8000 --otp http://127.0.0.1:18080 \
  --out logs/route-eval/candidate --baseline logs/route-eval/baseline
```

`--baseline PATH` 與 `--known-feasible PATH` 可重複指定。輸出的 `reference-set.json` 保存固定參考集合與來源，`regression-summary.json` 列出已知可行案例的退步與缺測；保留它們連同 `records.jsonl` 才能追溯比較。固定案例的日期不得自動平移後沿用原可行性證明；日期過期或超出圖的服務範圍時，先確認評測前提。

Oracle 的短窗口空結果只能表示該次沒有找到候選，不能證明完整支援範圍內無路。召回分母也不能取決於本輪自己找到哪些路。報告分開顯示「已測已知可行召回率」與「固定參照全集成功覆蓋率」：只測到兩筆中的一筆且成功時，前者是 1/1，後者是 1/2；未測不能當作成功，也不能當作查無路線。離線重算既有結果時使用 `--report-only` 與同一份 baseline；請另指定複製後的輸出目錄，保留原始報告。

修改評測腳本後至少執行 `python3 src/scripts/test_eval_route_quality.py`；此測試也列入 `pnpm test:python`。

---

## ⭐ 全套重建 SOP（自助版 — 2026-07-29 實跑驗證，要重建整份圖資看這段就夠）

下面幾節（§0–§5）是沿用現有 feed 的局部更新流程，檔名與埠號有部分過時（現在主 feed 叫 `feed-1.gtfs.zip`、對外埠是 **18080**、GraphQL 路徑是 `/otp/routers/default/index/graphql`）。**要從 TDX 重抓全台資料、重建整份 graph，只走這一段。**

### 一、開跑前必檢（自動，`pnpm otp:preflight`，幾秒）

`build-otp-graph.sh` 第 0 步會自動跑 `src/scripts/otp-preflight.sh`。任何一項 **FAIL** 都會在打 TDX 之前就停下，什麼都不會建。也可以單獨跑：

```bash
pnpm otp:preflight
```

| 檢查 | FAIL 代表什麼 |
| --- | --- |
| `TDX_CLIENT_ID/SECRET`、`OTP_GTFS_URLS`、`OTP_DATA_DIR` 三個 config | 缺環境變數或 config 檔 |
| checkout 落後 upstream | **要先 `git pull`**：建圖用的是本機 checkout 的 patch/inject 腳本，舊 code 也會「建成功」，只是修正沒進圖（07-30 白跑 50 分鐘） |
| `src/scripts`、`otp-data` 有未 commit 改動 | 建出來的圖跟版本對不上。確定要用本地改動就加 `OTP_PREFLIGHT_ALLOW_DIRTY=1`（降成 WARN） |
| 磁碟空間 | 資料目錄要 3 GiB＋現有 graph 大小（換圖會留一份 `graph.obj.prev`），暫存區要 5 GiB；同一顆碟就相加（約 8–10 GiB）。**寫滿會弄壞 Docker 儲存區** |
| Docker daemon、記憶體 ≥ build heap + 2 GiB | daemon 沒回應時，腳本可能誤判 otp 沒在跑，把 12g build 疊在 12g serve 上 |
| `import osmium` | 行人路權強化（致命步驟）會失敗 |
| `node_modules/.bin/ts-node` | 1e–1g 注入步驟會失敗，要先 `pnpm install` |
| MongoDB（`DATABASE_URL`）連得上 | 1e 只印 WARN，**北捷車站的輪椅旗標會靜默消失** |
| `patch_gtfs.py` 的 `CITIES` = 22、`CALENDAR_VALID_DAYS` ≥ 180 | patch 會先刪光全部公車，再依 CITIES 重建；名單少一個縣市，那個縣市的公車就沒了 |

WARN 不會擋（例如沒有 DEM 就不注入坡度、沒裝 gtfs-validator 就跳過驗證）。

**內建碟空間不夠時**，把暫存區放到別顆碟：`OTP_WORK_ROOT=/Volumes/<外接碟>/otp-work`。

- macOS 要先允許 Docker 存取卸除式卷宗（系統設定 → 隱私權與安全性 → 檔案與檔案夾 → Docker → 卸除式卷宗）。沒授權時，`docker run -v /Volumes/...` 會卡在 `Created` 不動。
- exFAT 碟會產生 `._*` 的 AppleDouble 檔，腳本在建圖前會自動清掉。不清的話，`._feed-1.gtfs.zip` 會被 OTP 當成一份 feed 吃進去。

### 二、跑

```bash
cd /Users/yuen/project/taipei-accessible-backend
caffeinate -dims pnpm otp:rebuild 2>&1 | tee ~/otp-backup/rebuild-$(date +%m%d).log
```

（等同 `set -a; . ./.env; set +a; bash src/scripts/build-otp-graph.sh`。排程請用 §7 的 `scheduled-otp-rebuild.sh`。）

- **`caffeinate -dims` 不可省。** 電腦睡眠會讓 build 凍死。症狀是 log 停住、出現 `Network error: read operation timed out`，**而且 otp 容器會一起 `Exited(137)`，線上服務會靜悄悄中斷好幾個小時**。判別法：`ps -o etime,time -p <pid>`，elapsed 兩小時但 cputime 只有一分鐘，就是被凍住，不是還在算。
- 全程約 **25–50 分鐘**：patch 10–30 分 → 各項注入 3 分 → 驗證 0.5 分 → graph build 7–10 分 → 載入候選圖＋驗收 3–5 分 → 換圖＋healthcheck 2 分。
- **不要看 `$?` 判斷成功**：`| tee` 會把腳本的退出碼蓋成 tee 的 0。要看 log 最後一行。

### 三、跑的時候看這幾行

| log 行                                                | 意義                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `[otp-preflight] 0 FAIL`                              | 第 0 步通過                                                       |
| `Route matching: ... 0 unmatched`                     | **`unmatched` 必須是 0**，非 0 表示有班次被丟掉                  |
| `Shape assignment: ...`                               | `rejected as unfit` 幾百個是正常的（守門攔下不貼合的幾何），上千個就要查 |
| `stopping otp container for graph build`              | 線上服務從這裡開始中斷，要到換圖完成才恢復（約 15 分鐘）          |
| `[promote-otp-graph] ... verifying candidate graph`   | 新圖在 18081 埠載入，開始跑驗收閘門                              |
| `RESULT PASS` / `RESULT FAIL`                         | 驗收結果。FAIL 就**不換圖**，舊圖會被拉回來繼續服務              |
| `OTP healthy — new graph promoted` → `build complete` | **成功。** 沒有這兩行就是沒成功                                    |

### 四、驗收（自動，`verify-otp-graph.py`）

舊流程是換圖之後才用眼睛看三個指令。現在 `promote-otp-graph.sh` 會先把新圖載到**備用埠 18081**跑驗收，**全部通過才換圖**；任何一項 FAIL 都會保留舊圖，並把線上 otp 拉回舊圖。這台機器的記憶體不夠同時跑兩份 12g，所以驗收期間線上 otp 會停著。

| 檢查 | 門檻 | 擋的是哪次事故 |
| --- | --- | --- |
| `feeds` | 只載入 `feed-*.gtfs.zip` 的數量（通常 1） | 07-29 注入用的 zip 被當成第二份 feed，整個北捷重複一份、且沒有幾何 |
| `geometry` | 各運具「幾何點數 ≤ 站數」（畫成站到站直線）的 pattern 比例：BUS ≤ 5%、RAIL ≤ 10%、SUBWAY ≤ 10%；FERRY/AIRPLANE 不計 | 07-29 公車 shape 掛錯子路線，14.5% 變直線 |
| `coverage` | 公車 route_id 縣市前綴 ≥ 20 個 | `CITIES` 被縮短，只剩 TPE/NWT/THB |
| `freshness` | THSR/TRA/TRTC/KRTC/NTMC/TYMC 今天都有班次 | 軌道行事曆過期，只剩公車 |
| `trip` | 天母→北車要有 BUS（且 polyline > 10 點）、南港→北車要有捷運或台鐵、北車→左營要有 THSR、台中→豐原要有 TRA、板橋→101（輪椅）要有捷運 | 端到端規劃壞掉 |
| `audit` | `audit-gtfs-feed.py` 跟目前線上的 `feed-1.gtfs.zip` 比，不能有 REGRESSION（掉 20% 或歸零） | 某縣市公車整批消失 |

隨時可以對**線上的圖**跑同一套檢查（唯讀，不影響服務）：

```bash
pnpm otp:verify
# 加上 audit：
python3 src/scripts/verify-otp-graph.py --otp http://127.0.0.1:18080 \
  --feed otp-data/feed-1.gtfs.zip --baseline ~/otp-backup/feed-1.<上次成功那份>.gtfs.zip
```

**`audit` 報 REGRESSION 時要先判斷是不是指標假象**，再決定要不要放行（見下方說明）。確認是假象後，用 `OTP_VERIFY_SKIP_AUDIT=1` 重跑。其他項目沒有跳過開關，FAIL 就是圖有問題。

後端 API 層的端到端試排（驗收不包含，因為後端連的是 `otp:8080`；換圖後可以手動跑）：

```bash
curl -s -X POST http://127.0.0.1:8000/api/v1/a11y/accessible-route \
  -H 'Content-Type: application/json' \
  -d '{"origin":{"latitude":25.1176,"longitude":121.5316},"destination":{"latitude":25.0478,"longitude":121.5170},"travelMode":"transit"}' \
| python3 -c "
import json,sys
d=json.load(sys.stdin); print('ok=',d.get('ok'))
for i,r in enumerate(d.get('data',{}).get('routes',[])[:3]):
    print(f'  路線{i+1}:', [(l['type'], len(l.get('polyline') or [])) for l in r['legs']])"
```

2026-07-30 重建後的實際輸出（可當對照基準）：

```
幾何退化:   BUS 155/6790 (2.3%)  RAIL 2/663 (0.3%)  SUBWAY 4/100 (4.0%)
           FERRY/AIRPLANE 100% 是已知議題（本該排除，不影響規劃）
feeds:     只有 feed 1（404 agencies）—— 出現 feed 2 就是有雜 zip 被吃進去，見下方
audit:     （07-29 數字，07-30 這次未重跑）bus routes=8,615  with service=6,700 (77%)  usable>=6/day=3,528 (40%)
端到端:     （07-29）路線1: [('WALK',22),('BUS',41),('WALK',7),('METRO',18),('WALK',20)]
```

⚠️ `**{feeds{feedId}}` 只該回一個 feed。** 2026-07-29 那次重建，注入用的 `trtc-official.gtfs.zip` 放在建圖目錄裡被 OTP 當成獨立 feed 吃進去 = 整個北捷重複一份、且那份沒有 shapes.txt，捷運腿隨機變站到站直線。當時記錄的 `SUBWAY 95/189 (50.3%)` 就是這個重複 feed，不是「合成捷運無 shape」。修法：注入輸入改放 `AUX_DIR`，並在建圖前斷言 WORK_DIR 只有 `feed-*.gtfs.zip`（腳本已內建，遞迴檢查）。

已知仍退化的 SUBWAY pattern（4 條，皆為 shape 與站序不吻合被 OTP 丟棄）：`KRTC_R_R_0`（高雄紅線 dir 0）、`TRTC_G_G-3`（小碧潭支線兩向，2 站接駁本來就近似直線）。

`**audit` 報 REGRESSION 不代表一定要回滾。** `usable>=6/day` 這個指標會因為「班次正確分散到各子路線」而下降 —— 2026-07-29 就出現 `TNN 5→0`、`PEN 13→2`，但實測 TNN 總班次 560→560、PEN 191→191 完全沒變，純粹是分布改變。**判別法：比對該縣市的總班次數**，總量沒掉就是指標假象。更誠實的指標是 audit 開頭的 `with service`（有班次的路線數）。

### 五、失敗了怎麼辦

**先確認你不需要做什麼。** 腳本任何失敗路徑（preflight、建圖、驗收）都會做三件事，所以 build 失敗後線上服務會自己恢復：

- 保留舊 graph，`otp-data/` 不動。
- 把停掉的 otp 自動拉回來。
- 清掉暫存目錄和 `otp-candidate` 容器。

**驗收 FAIL（`RESULT FAIL`）**：log 裡會列出是哪幾項失敗。

- 圖有問題：修好資料或腳本後重建。
- 只有 `audit` 失敗，而且確認是指標假象（見 §四）：用 `OTP_VERIFY_SKIP_AUDIT=1 pnpm otp:rebuild` 重建。

只有這兩種情況要手動處理：

```bash
# graph 換上去了但 healthcheck 沒過（腳本已自動回滾，若仍異常）
mv otp-data/graph.obj.prev otp-data/graph.obj && docker compose restart otp

# Docker 儲存區被磁碟寫滿弄壞（症狀:input/output error、image blob 讀不出來）
# → 先清出空間,再重啟 Docker Desktop,然後 docker compose up -d otp
```

### 六、失敗模式對照表（都是實際踩過的）

| 症狀                                                    | 真因                                                       | 處理                                            |
| ------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| log 凍住、CPU 時間遠小於 elapsed、otp 變 `Exited(137)`  | 電腦睡眠                                                   | 用 `caffeinate -dims` 包住                      |
| `IncompleteRead` 後整個 patch 失敗                      | TDX 回應被截斷                                             | 已修（納入重試白名單），若重試 5 次耗盡才會致命 |
| `missing required entity: Agency`                       | gtfs-validator 報告目錄寫在 OTP 資料目錄裡被當成 GTFS feed | 已修（報告改寫到獨立 temp 目錄）                |
| `No space left on device` + Docker `input/output error` | 磁碟寫滿                                                   | 開跑前檢查 ≥8 GiB                               |
| graph build 被 OOM 殺掉                                 | serve 12g + build 12g &gt; Docker VM 15.6GB                | 已修（腳本會在建圖前停 otp）                    |
| 只剩 TPE/NWT/THB 三個縣市有公車                         | `CITIES` 被縮短                                            | 還原成 22 縣市重跑                              |
| 公車大量畫直線                                          | shape 配錯子路線                                           | 看 `Route matching` 的 `prefix` 是否非 0；驗收的 `geometry` 會擋 |
| 建了 50 分鐘，修正卻沒進圖                              | 建圖機 checkout 沒 `git pull`                              | preflight 會擋（落後 upstream 即 FAIL）          |
| 北捷車站輪椅旗標消失、log 只有一行 WARN                 | step 1e 連不到 Mongo                                       | preflight 會擋（Mongo 連不上即 FAIL）            |
| `docker run -v /Volumes/...` 卡在 `Created`             | macOS 沒授權 Docker 存取卸除式卷宗                         | 系統設定授權（見 §一）                           |
| `unexpected zip in the build directory: ._feed-1...`    | exFAT 的 AppleDouble 檔                                    | 已修（建圖前自動刪 `._*`）                       |

### 七、成功後做一件事

驗收的 `audit` 會自動拿 `otp-data/feed-1.gtfs.zip`（也就是被換掉的那份）當 baseline，所以不需要手動準備。另外留一份到 `~/otp-backup/`，之後要跨好幾版比較，或要手動對線上的圖跑 audit 時才有東西可比：

```bash
cp otp-data/feed-1.gtfs.zip ~/otp-backup/feed-1.$(date +%Y%m%d).gtfs.zip
```

---

## 0. 指令大全（複製貼上即用）

### 0.1 一鍵更新（沿用現有主 feed：更新 TRA 班表 → 重建 → 部署 → 驗證）

在專案根目錄整段貼上（subshell 包裹，中途失敗不會動到正在服務的資料；全程約 10–12 分鐘）：

```bash
( set -e
  BUILD_DIR=/tmp/otp-build
  rm -rf $BUILD_DIR && mkdir -p $BUILD_DIR

  # 1) 複製現有資料到建圖目錄（不動 otp-data 正本）
  cp otp-data/{otp-config.json,build-config.json,router-config.json,taiwan-gtfs.zip,taiwan-otp.osm.pbf} $BUILD_DIR/

  # 2) 抓最新 TRA 班表並注入（2 個 TDX 呼叫）
  TOKEN=$(npx dotenvx run -q -- sh -c 'curl -fsS -X POST "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=client_credentials&client_id=$TDX_CLIENT_ID&client_secret=$TDX_CLIENT_SECRET"' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
  curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" -o /tmp/tra-timetable.json "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON"
  python3 src/scripts/inject-tra-gtfs.py $BUILD_DIR/taiwan-gtfs.zip /tmp/tra-timetable.json

  # 3) 停服務容器釋放記憶體（必要！否則建圖 OOM）→ 離線建圖（~9 分鐘）
  docker stop otp
  docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx12g" -v $BUILD_DIR:/var/opentripplanner opentripplanner/opentripplanner:2.9.0 --build --save

  # 4) 建圖成功才換檔（舊 graph 留 .prev 可回滾）→ 重啟
  cp otp-data/graph.obj otp-data/graph.obj.prev
  cp $BUILD_DIR/taiwan-gtfs.zip otp-data/taiwan-gtfs.zip
  mv $BUILD_DIR/graph.obj otp-data/graph.obj
  OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp

  # 5) 等就緒（~40 秒）→ 驗證 TRA 在 graph 裡
  until curl -fsS -m 3 http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' -d '{"query":"{feeds{feedId}}"}' 2>/dev/null | grep -q feedId; do sleep 5; done
  curl -s http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' -d '{"query":"{ agency(id: \"1:TRA\") { routes { shortName } } }"}'
  echo "✅ OTP 更新完成"
)
```

> 主 feed（公車/捷運/高鐵）也要換新時，先手動從 TDX 平台下載新的全國 GTFS zip 覆蓋 `otp-data/taiwan-gtfs.zip` 並跑 `python3 src/scripts/clean-gtfs-feed.py otp-data/taiwan-gtfs.zip`，再執行上面整段。未來 `OTP_GTFS_URLS` 確認後改用 §2.1 的一鍵腳本。

### 0.2 日常啟停

```bash
OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp    # 啟動
docker stop otp                                         # 停止
docker logs otp --tail 20                               # 看載入進度
```

### 0.3 健康檢查（一行）

```bash
curl -s http://localhost:8080/otp/gtfs/v1 -X POST -H 'Content-Type: application/json' -d '{"query":"{feeds{feedId}}"}' && echo " ← 有 feedId 即正常"
```

### 0.4 故障急救

```bash
# API 每次 30 秒才回 → 十之八九是 Mongo 掛了
brew services restart mongodb-community@7.0

# Docker daemon 整個沒反應
pkill -9 -f "Docker.app" ; sleep 3 ; open -a Docker

# graph 換壞了 → 回滾上一版
mv otp-data/graph.obj.prev otp-data/graph.obj && OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp
```

---

## 1. 架構與檔案位置

```
TDX 全國 GTFS feed ──┐
                     ├─ clean-gtfs-feed.py（去髒資料、移除票價）
TRA 班表 JSON ───────┤
                     ├─ inject-tra-gtfs.py（台鐵：保留原生班表或注入）
Geofabrik 台灣 OSM ──┤
                     └─► otp --build --save ──► graph.obj
                                                  │
                              docker compose up ──┴─► localhost:8080（GraphQL）
                                                        ▲
                              otp-routing.service.ts ───┘（Node 後端唯一消費者）
```

| 路徑                             | 內容                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `otp-data/`                      | OTP 資料目錄（容器 mount 到 `/var/opentripplanner`）          |
| `otp-data/graph.obj`             | 序列化路網圖（~1.8 GB，**與 OTP 版本綁定**）                  |
| `otp-data/taiwan-gtfs.zip`       | 清理＋注入後的全國 GTFS feed                                  |
| `otp-data/taiwan-otp.osm.pbf`    | 台灣 OSM 街道圖（Geofabrik，~324 MB）                         |
| `otp-data/build-config.json`     | 建圖設定（transitService 區間、OSM tag mapping）              |
| `otp-data/router-config.json`    | 查詢設定（輪椅成本、searchWindow、street timeout）            |
| `otp-data/otp-config.json`       | 功能開關（`ActuatorAPI: true`，healthcheck 用過、現已改 TCP） |
| `src/scripts/build-otp-graph.sh` | 一鍵更新 pipeline（`pnpm otp:rebuild`；排程用 `scheduled-otp-rebuild.sh`，見 §7） |
| `src/scripts/otp-preflight.sh`   | 第 0 步：建圖前檢查（`pnpm otp:preflight`，見 SOP §一）       |
| `src/scripts/promote-otp-graph.sh` | 第 5 步：候選圖載到 18081 → 驗收 → 通過才換圖               |
| `src/scripts/verify-otp-graph.py` | 驗收閘門本體；也能對線上圖跑（`pnpm otp:verify`，見 SOP §四） |
| `src/scripts/clean-gtfs-feed.py` | TDX feed 髒資料修復（見檔頭註解的完整清單）                   |
| `src/scripts/inject-tra-gtfs.py` | 台鐵班表注入（TDX 無官方 TRA GTFS，見 §3）                    |

### 必要環境變數

| 變數                                  | 用途                                     | 範例            |
| ------------------------------------- | ---------------------------------------- | --------------- |
| `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` | TDX OAuth2 憑證（`.env` 已有）           | —               |
| `OTP_GTFS_URLS`                       | 全國 GTFS zip 下載 URL（空白分隔可多個） | 見 §2.1         |
| `OTP_DATA_DIR`                        | 資料目錄絕對路徑                         | `$PWD/otp-data` |
| `OTP_JAVA_XMX`                        | 建圖 heap（選填，預設 12g）              | `12g`           |
| `OTP_SERVE_XMX`                       | 服務 heap（選填，預設 6g）               | `6g`            |
| `OTP_OSM_BBOX`                        | OSM 裁切範圍（選填，**不設 = 全台**）    | —               |
| `OTP_WORK_ROOT`                       | 建圖暫存區（選填，預設 `/tmp`；內建碟不夠時指到別顆碟） | `/Volumes/X/otp-work` |
| `OTP_CANDIDATE_PORT`                  | 驗收用候選圖的埠（選填，預設 18081）     | `18081`         |
| `OTP_PREFLIGHT_ALLOW_DIRTY`           | `1` = 有未 commit 改動也照建（選填）     | `1`             |
| `OTP_VERIFY_SKIP_AUDIT`               | `1` = 驗收跳過 audit（確認是指標假象才用） | `1`           |

---

## 2. 資料更新

### 2.1 路徑 A：一鍵完整更新（建議走法）

```bash
export OTP_DATA_DIR="$PWD/otp-data"
export OTP_GTFS_URLS="<全國 GTFS zip 的下載 URL>"
src/scripts/build-otp-graph.sh
```

腳本自動執行：**preflight** → 抓 feed → 清理 → **抓 TRA 班表並注入** → OSM 月度更新 → gtfs-validator 驗證 → 離線建圖 → **候選圖驗收（不過就不換）** → 原子換檔 → 重啟容器 → healthcheck（失敗自動回滾舊 graph）。

> **⚠️ 全國 feed URL 注意事項**
> 目前 repo 內的 `taiwan-gtfs.zip` 來自 TDX「GTFS 服務（Beta）」的全國靜態資料集，當初為手動下載。TDX 的軌道 GTFS API 端點（`/api/gtfs/V3/Map/GTFS/Static/Rail/*`）**只提供北捷 TRTC**（實測 400：「目前只提供北捷(TRTC)的GTFS資料」），v2 premium 端點已棄用。設定 `OTP_GTFS_URLS` 前先到 [TDX 平台](https://tdx.transportdata.tw/) 會員中心的 GTFS 服務頁確認現行下載端點。

> **⚠️ 建圖前務必停掉服務容器**
> 本機 Docker VM 僅 15.6 GB，服務中的 otp 容器實際吃 ~12 GB，與 12g 建圖 heap 同時跑**必定 OOM（exit 137）**。`build-otp-graph.sh` 會在建圖前自己停掉 otp，驗收和換圖完成後再拉起來。不過 daemon 回應慢時，「查不到容器」可能被誤判成「沒在跑」（2026-07-30 因此把 12g build 疊在 12g serve 上，整台 Docker 掛掉），所以保險做法還是先手動 `docker stop otp`，確認停了再執行。

### 2.2 路徑 B：沿用現有 feed 重建（升級版本、改 build-config、僅更新 TRA）

不重新下載主 feed，直接用 `otp-data/` 裡的現有檔案：

```bash
# 1. 準備建圖目錄（複製、不動正在服務的資料）
BUILD_DIR=/tmp/otp-build
mkdir -p $BUILD_DIR
cp otp-data/{otp-config.json,build-config.json,router-config.json,taiwan-gtfs.zip,taiwan-otp.osm.pbf} $BUILD_DIR/

# 2.（選擇性）更新台鐵班表 — 見 §3
# 3. 停服務容器（釋放記憶體）
docker stop otp

# 4. 離線建圖（~9 分鐘）
docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx12g" \
  -v $BUILD_DIR:/var/opentripplanner \
  opentripplanner/opentripplanner:2.9.0 --build --save

# 5. 換檔並重啟
cp otp-data/graph.obj otp-data/graph.obj.prev   # 留回滾備份
cp $BUILD_DIR/graph.obj otp-data/graph.obj.new && mv otp-data/graph.obj.new otp-data/graph.obj
OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp
```

---

## 3. 台鐵（TRA）班表注入

> **2026-10 起現況**：TDX 全國 feed 已自帶逐日台鐵班表（每車次每服務日一個 trip，約 59 天，含軌道 shape）。`inject-tra-gtfs.py` 會先判斷原生班表是否涵蓋至少 `NATIVE_MIN_DAYS`（14）天：
>
> - **native 模式**（有）：原樣保留，只補 `route_long_name` 車種名、`WheelChairFlag=1` 車次的 `wheelchair_accessible=1`，並以台鐵軌道幾何修復離 shape 超過 500 m 的站序；修不好就中止且不覆寫輸入 zip。下方「下載 GeneralTrainTimetable」步驟與 45 天效期限制都不適用。
> - **inject 模式**（沒有）：退回下述舊流程。
>
> 以下為 inject 模式的原始說明。

**背景（inject 模式）**：舊版 TDX 全國 feed 只有 TRA 的站點與 agency，**沒有班表**（routes/trips/calendar 為 0），官方也沒有 TRA 的 GTFS 端點。沒有注入的 graph 永遠排不出台鐵腿，台鐵覆蓋將完全依賴有 429 限流的 TDX MaaS API。

`inject-tra-gtfs.py` 把 TDX v3 `GeneralTrainTimetable` JSON 轉成 GTFS 列注入主 feed，引用 feed 既有的 `TRA_<StationID>` 站點（239 站全對齊、零新增）。路徑 A 已自動包含；手動執行：

```bash
# 1. 取 token 並下載班表（1 個 TDX 呼叫）
TOKEN=$(curl -fsS -X POST \
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$TDX_CLIENT_ID&client_secret=$TDX_CLIENT_SECRET" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -fsSL --compressed -H "Authorization: Bearer $TOKEN" \
  -o /tmp/tra-timetable.json \
  "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/GeneralTrainTimetable?%24format=JSON"

# 2. 注入（冪等：重跑會先剝掉舊注入）
python3 src/scripts/inject-tra-gtfs.py otp-data/taiwan-gtfs.zip /tmp/tra-timetable.json
# inject 模式預期輸出類似：injecting: routes=7 trips=943 services=15 stop_times=21622 ...（數字隨 TDX 快照變動）

# 3. 注入只改 zip，必須重建 graph 才生效 → 回 §2.2 步驟 3
```

### 已知限制（inject 模式；設計取捨，非 bug）

- **班表效期**：TDX 以「快照」發布（EffectiveDate == ExpireDate），注入時 calendar 設為生效日 +45 天，靠每週 rebuild 滾動。超過 45 天不更新，台鐵班次會從 OTP 消失。
- **假日班表**：`NationalHolidays`／`DayBeforeHoliday` 等旗標 GTFS calendar 無法表達，國定假日的加開/停駛不會反映——與 MaaS 班表漂移同級別誤差，誤點由 realtime overlay 修正。
- **輪椅標記**：`WheelChairFlag=1` 的 164 班標 `wheelchair_accessible=1`，其餘留「未知」。**不要改成 2（不可及）**——router-config 的 3600 秒 inaccessibleCost 會把輪椅查詢全部擠到那 164 班。

---

## 4. Docker 配置

`docker-compose.yml` 重點逐項：

```yaml
services:
  otp:
    image: opentripplanner/opentripplanner:2.9.0 # 永遠 pin 版本，不用 latest
    command:
      ["--load"] # 只給 flags！entrypoint 寫死 /var/opentripplanner，
      # 多給路徑會報 "must supply a single directory name"
    ports:
      - "127.0.0.1:8080:8080" # 只綁 localhost，永不對外
    volumes:
      - ${OTP_DATA_DIR:-/var/otp}:/var/opentripplanner
    environment:
      JAVA_TOOL_OPTIONS: "-Xmx${OTP_SERVE_XMX:-6g}" # 全台 graph 服務 heap
    healthcheck:
      # 2.9 image 沒帶 curl/wget；bash /dev/tcp 等價 —— Grizzly 在 graph
      # 載入完成後才綁 8080，TCP 通 = ready for routing
      test: ["CMD", "bash", "-c", "</dev/tcp/localhost/8080"]
```

**版本升級 SOP**：`graph.obj` 序列化與 OTP 版本綁定，**升級＝必須重建**。順序：改 compose 與 build script 的 pin → 走 §2.2 用新 image 建圖 → 換檔 → `docker compose up -d otp`（compose 會用新 image 重建容器）。舊 graph 留 `graph.obj.prev` 可配舊 image 回滾。

---

## 5. 啟動與驗證

```bash
OTP_DATA_DIR=$PWD/otp-data docker compose up -d otp
```

載入 1.8 GB graph 約 30–60 秒。**判斷健康打 GraphQL，別只看 actuator**：

```bash
# ready 檢查（回 {"data":{"feeds":[{"feedId":"1"}]}} 即就緒）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST \
  -H 'Content-Type: application/json' -d '{"query":"{feeds{feedId}}"}'

# TRA 注入驗證（應回 7 種車種）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ agency(id: \"1:TRA\") { routes { shortName } } }"}'

# 端對端試排（台中→豐原，應出現 RAIL 腿；locale 影響站名語言）
curl -s http://localhost:8080/otp/gtfs/v1 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ plan(from:{lat:24.137288,lon:120.6869251}, to:{lat:24.254204,lon:120.723735}, transportModes:[{mode:TRANSIT},{mode:WALK}], numItineraries:3, locale:\"zh-TW\") { itineraries { duration legs { mode from { name } } } } }"}'
```

Node 端固定使用 OTP 作為唯一路徑規劃引擎；設定 `OTP_BASE_URL` 指向 GraphQL 服務即可。

---

## 6. 故障排查

| 症狀                             | 原因                                                     | 處置                                                                          |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 建圖 exit 137（Killed）          | Docker VM 記憶體不足（服務容器 ~12 GB + 建圖 12g heap）  | 先 `docker stop otp` 再建                                                     |
| 容器無限重啟、載入 NPE           | feed 有自迴圈電梯 pathway（from==to）                    | 確認 feed 過了 `clean-gtfs-feed.py`                                           |
| 查詢 20 秒以上                   | feed 帶 384 萬行票價，OTP 每條 itinerary 掃票價          | cleaner 已整包移除 `fare_*.txt`，確認沒用未清理的 zip                         |
| plan 全回空陣列（連純步行都空）  | 起訖點 snap 到斷裂街道孤島（2.5 的台中車站正門案例）     | 2.9 已大幅改善；Node 端有 snap-to-stop fallback 防禦                          |
| API 回應每次都 ~30 秒            | 不是 OTP——通常是 **MongoDB 掛了**，mongoose 連線逾時疊加 | `brew services restart mongodb-community@7.0`                                 |
| healthcheck unhealthy 但查詢正常 | healthcheck 用了 image 沒有的指令（如 curl）             | 用 bash `/dev/tcp` TCP 檢查（現行配置）                                       |
| `/otp/actuators/health` 404      | ActuatorAPI 是 sandbox 功能預設關                        | `otp-config.json` 開 `{"otpFeatures":{"ActuatorAPI":true}}`，或直接打 GraphQL |
| 排不出台鐵腿                     | TRA 注入後沒重建 graph；或 calendar 過期（+45 天）       | 重走 §3 + §2.2；檢查 `agency(id:"1:TRA")` 的 routes 數                        |
| 站名變英文                       | plan 預設 locale=en，feed 的 translations.txt 只有英譯   | 查詢帶 `locale:"zh-TW"`（`otp-routing.service.ts` 已內建）                    |
| 文湖線/環狀線/台中捷運排不到     | OTP graph 沒含該路線有效班表                             | 比照 TRA 注入或修補 feed 後重建 graph                                         |
| TDX 下載 429                     | quota 限流（burst 4–6 呼叫即觸發）                       | 等冷卻重試；pipeline 每次 build 僅 2–3 個呼叫，正常不會撞                     |

---

## 7. 例行排程（必裝，不是建議）

軌道班表只涵蓋 TDX 發布的 4–8 週（TRA `CALENDAR_DAYS=45`、捷運 60 天、高鐵與北捷官方依 TDX 區間），**不每週重建，圖資約一個月後就會靜默腐爛成只剩公車**（2026-10 實際發生：dev 捷運/鐵路全數過期、正式機高鐵過期）。

用 `src/scripts/scheduled-otp-rebuild.sh`，不要直接把 `build-otp-graph.sh` 塞進 cron：wrapper 會上鎖防重疊、先 `git pull --ff-only`（建圖吃的是主機 checkout）、讀 `.env`、每次一個 log（`logs/otp-rebuild/`，保留 8 份）、只跑一輪、失敗回非 0。

cron（每週日 04:00）：

```cron
0 4 * * 0  /path/to/repo/src/scripts/scheduled-otp-rebuild.sh
```

systemd timer（Ubuntu 建議，失敗可接 `OnFailure=` 通知）：

```ini
# /etc/systemd/system/otp-rebuild.service
[Service]
Type=oneshot
User=<部署帳號>
ExecStart=/path/to/repo/src/scripts/scheduled-otp-rebuild.sh

# /etc/systemd/system/otp-rebuild.timer
[Timer]
OnCalendar=Sun 04:00 Asia/Taipei
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now otp-rebuild.timer
```

兩道防線確認排程真的有效：

- **建圖門檻**：`check-feed-service-window.py` 要求 THSR/TRA/TRTC/KRTC/NTMC/TYMC 在「今天+14 天起的 7 天」內都有班次，否則不換圖（注入步驟是 fail-soft，沒有這道門檻，TDX 掛掉時會靜默換上沒有台鐵的圖）。
- **執行期偵測**：後端每 30 分鐘問 OTP 各軌道業者今天與 7 天後的班次數；過期會 `console.error("[otp-freshness] ... expired")`，`GET /health` 的 `transitData.expired` / `expiring` 會列出業者。看到非空就代表排程沒在跑或建圖失敗。

---

## 8. 市區公車班表 patch（`patch_gtfs.py`）與重建後驗證

> 2026-07-20 新增。`build-otp-graph.sh` 在「清理 feed」之後、「TRA 注入」之前，會對 `feed-1.gtfs.zip` 跑 `src/scripts/patch_gtfs.py`，用 TDX 班表把市區公車 + 公路客運補成 180 天週期日曆的班次。本節是 §2.1 pipeline 沒細講的一環。

### 8.1 patch_gtfs.py 做什麼（務必先懂它的破壞性語意）

- **會先刪光 base feed 內所有 `route_type==3`（公車）班次，再只從 `CITIES` 名單（+ InterCity 公路客運）用 TDX `Bus/Schedule` 重建**，日曆改為 `CALENDAR_VALID_DAYS`（180）天週期。
- 對「只有起站時刻（origin-only）」的路線，再抓 `Bus/DailyTimeTable` 補逐站；TDX 已把 **Taipei/NewTaipei/Tainan/Kinmen/Lienchiang 的 DailyTimeTable 下架（v2 400、v3 僅 Tainan 且為 origin-only）**，這些市自動級聯降級：v2→v3→`StopOfRoute` 合成（每站 +2 分近似）。其餘 17 市走 v2 真實 daily。
- 純班距（`Frequencys`）路線本就 skip（`freq_only`），由 base feed 的 `frequencies.txt` 涵蓋。

### 8.2 ⚠️ 最大的坑：不要縮短 `CITIES`

因為是「先刪全部再只重建名單內」，**把 `patch_gtfs.py` 的 `CITIES` 改短 = 靜默刪掉其他縣市的公車**，而且建置仍會「成功」。2026-07-20 就發生過 `CITIES` 被改成只剩 `["Taipei","NewTaipei"]`，重建後 OTP 只剩台北/新北/公路客運三種公車、其餘 20 縣市全消失。**改 `CITIES` 前務必記得此語意；正常應維持完整 22 縣市。**

```bash
# 重建前自我檢查
python3 -c "import sys;sys.path.insert(0,'src/scripts');import patch_gtfs as p;print(len(p.CITIES),'cities, CAL',p.CALENDAR_VALID_DAYS)"
# 期望：22 cities, CAL 180
```

patch 成功時 log 會列出 **22 個縣市各自的 `schedule=…` 摘要** 與 `Generated 十萬+ new bus trips`。

### 8.3 重建後兩層驗證（公車專用，補充 §5）

對外埠是 **127.0.0.1:18080**（容器內 8080），backend 在 8000。

```bash
# (a) OTP 圖層：公車應涵蓋 ~22 縣市、~4000+ 條（只剩 TPE/NWT/THB 3 個 = CITIES 被縮了）
curl -s -X POST http://localhost:18080/otp/routers/default/index/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ routes(transportModes:[BUS]){ gtfsId } }"}' \
  | python3 -c "import sys,json;from collections import Counter;r=json.load(sys.stdin)['data']['routes'];c=Counter(x['gtfsId'].split(':')[1][:3] for x in r);print(len(c),'縣市 /',len(r),'條',dict(c))"

# (b) 後端 API 層：用無捷運區（天母）強迫排公車，legs 應含 BUS
curl -s -X POST http://localhost:8000/api/v1/a11y/accessible-route \
  -H "Content-Type: application/json" \
  -d '{"origin":{"latitude":25.1176,"longitude":121.5316},"destination":{"latitude":25.0478,"longitude":121.5170},"mode":"normal","travelMode":"transit"}' \
  | python3 -c "import sys,json;print([l.get('type') for l in json.load(sys.stdin)['data']['routes'][0]['legs']])"
```

### 8.4 OTP 沒起來（exit 137）

重建腳本結尾會原子換圖 + 重啟 otp 並等 healthcheck。但 otp 服務曾 `Exited(137)`（記憶體/被殺，serve `-Xmx` 見 `OTP_SERVE_XMX`）。若重建後 `docker ps` 沒有 otp：

```bash
docker ps -a | grep otp                 # 看是否 Exited(137)
docker compose up -d otp                 # 重新拉起
docker inspect otp --format '{{.State.Status}} {{.State.Health.Status}}'  # 等 running healthy
```

> 相關背景與 TDX v2→v3 遷移細節，另見 `docs/specs/FUNCTIONAL_SPEC_OTP2_INTEGRATION.md` 與 `patch_gtfs.py` 檔頭。
