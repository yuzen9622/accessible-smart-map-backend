# OTP2 維運手冊 — 資料匯入、建圖與部署

適用版本為 OpenTripPlanner **2.9.0**。`pnpm import:sidewalks` 只負責人行道下載、驗證與匯入 PostGIS；`pnpm otp:rebuild` 負責建圖預檢、完整 OTP 建圖、候選驗證及載入。建圖檔案由後者管理，不必手動準備 graph、manifest 或資料目錄環境變數。

## 新環境啟用

從 repository 根目錄執行。需要 Node **22 以上**、專案指定的 pnpm、Python **3.12 以上**、Docker Engine／Docker Desktop 與 Compose，以及 `curl`、`zip`、`unzip`、`git`。依 `.env.example` 填妥 TDX 憑證、MongoDB、PostGIS 與原有應用程式設定；主機腳本的資料庫位址須使用主機可連到的埠，Compose 預設 Mongo 為 **27018**、PostGIS 為 **5434**。

安裝主機上的專案與 Python 相依套件：

```bash
pnpm install --frozen-lockfile
python3 -m venv otp-data/python-venv
source otp-data/python-venv/bin/activate
python -m pip install -r requirements-test.txt psycopg2-binary
```

`requirements-test.txt` 包含建圖使用的 osmium、Shapely 與 rasterio；psycopg2 用於讀取 PostGIS。Ubuntu 需先安裝 `python3-venv`。以下建圖指令請在已啟用這個 Python 環境的終端機執行。

已有 Conda 環境時可沿用，不必另建 venv。Conda 的 `psycopg2` 與 pip 的 `psycopg2-binary` 都提供程式需要的 `psycopg2` 模組，已安裝前者不需再裝後者。建圖與預檢使用同一個終端機 `PATH` 中的 `python3`；先啟用已裝齊相依套件的環境（將佔位符換成自己的名稱或路徑）：

```bash
conda activate <環境名稱或絕對路徑>
python3 -c 'import sys; print(sys.executable); print(sys.version)'
pnpm otp:preflight
```

預檢會顯示實際 Python 路徑及個別載入失敗的套件。若路徑仍指向系統／Homebrew Python，先修正環境啟用；若路徑正確，依列出的缺項補齊。只有 psycopg2 安裝成功，仍不代表 osmium、Shapely、rasterio、numpy 或 Python 版本均已符合要求。

啟動資料庫，並依[一般部署手冊](./DEPLOY_UBUNTU.md)完成 Mongo 基礎資料準備：

```bash
docker network inspect accessible-shared >/dev/null 2>&1 || docker network create accessible-shared
docker compose up -d --wait mongo postgis redis
```

Mongo 補強、站牌對照表及交通品質驗證仍需要原有資料。Valhalla 路網與 `GCS_KEY_FILE` 等設定屬於其他後端功能的部署要求，不是人行道匯入或 OTP 建圖的必要條件；這個指令不會代替所有應用程式資料匯入或建立雲端憑證。

服務與工具就緒後，依序執行，前一個指令成功後才執行下一個：

```bash
pnpm import:sidewalks
pnpm otp:rebuild
```

第一個指令下載並匯入官方人行道來源，完成後就結束；它不執行 OTP 預檢、建圖或重啟服務。第二個指令讀取已匯入的來源，檢查建圖必要條件並完成 OTP 重建；候選驗證與載入失敗都回傳非零狀態。只匯入人行道不需要 Python 建圖套件、TDX 憑證或 MongoDB。首次建圖及完整交通班表處理可能耗時較長，請預留磁碟與主機／Docker VM 記憶體，並安排維護時段。

成功後部署後端：

```bash
docker compose up -d --build backend
```

`docker compose up` 本身只載入已建好的 OTP release，不會在服務啟動時下載資料或重建路網。若後端以主機 Node／systemd 執行，依一般部署手冊編譯並啟動該服務。

## 指令與來源選項

| 指令 | 行為 |
| --- | --- |
| `pnpm import:sidewalks` | 下載、驗證並匯入官方人行道來源；不建圖或切換 OTP。 |
| `pnpm import:sidewalks --zip <path>` | 使用既有原始 ZIP 匯入；不修改原始 ZIP。 |
| `pnpm import:sidewalks --url <URL>` | 從指定公開網址下載並匯入人行道來源。 |
| `pnpm import:sidewalks --dry-run` | 檢查來源、清洗與 PostGIS 幾何，不發布來源、不建圖。 |
| `pnpm otp:rebuild` | 使用已匯入的 ACTIVE 來源，重跑既有完整 OTP 建圖、驗證及載入。 |
| `pnpm build:otp` | 與 `pnpm otp:rebuild` 相同的建圖流程。 |

`--zip` 與 `--url` 不可同時使用。資料庫連線只從環境設定讀取，不支援 `--db-url`；公開來源網址也不應夾帶憑證。`pnpm data:sync` 的 `sidewalks` 步驟使用同一個純匯入指令；同步後要套用新來源時執行 `pnpm otp:rebuild`。

## 建圖與檔案位置

既有完整建圖流程包含以下工作：

1. 下載完整 TDX GTFS，清理交通資料，補強公車班表、台鐵／捷運與無障礙屬性。
2. 保留 Mongo 中的北捷設施補強、重複站牌合併及對照表匯入。
3. 準備台灣 OSM 與官方 DEM，套用行人禁行標記，再將已匯入的政府人行道編入路網。
4. 固定建圖輸入及政策封裝，使用 native OTP 映像建圖，產生同一份圖的來源 manifest。
5. 執行既有交通品質驗證，再追加來源／政策身分核對，以及一般、輪椅各自的直接步行與中途點試排，通過後載入服務。

GTFS 必須通過鐵路／捷運服務窗口檢查。`pnpm fetch:gtfs` 是供 Mongo 匯入使用的流程，不能取代 OTP 使用的完整 feed。建圖會使用暫時的 Docker 建圖／候選容器，這些不是額外常駐服務。

資料固定放在專案的 `otp-data/`，release、指標與高程檔由腳本管理：

```text
otp-data/
├── active-release
├── dem/
│   └── taiwan-dtm-20m.tif
└── releases/
    └── <release>/
        ├── inputs/            # graph.obj、完整 GTFS、PBF、DEM 與設定
        ├── evidence/          # build-manifest.json 與建圖檢查資料
        └── ...                # 原始來源與建圖封裝
```

OTP 以唯讀方式掛載 `otp-data/`，由 `active-release` 取得同一個 release 的圖與 manifest。後端從固定的 `./otp-data/dem` 唯讀掛載高程。不需手動建立目錄指標、填寫 graph 路徑、manifest SHA-256 或政策 JSON；核定政策清單隨程式封裝。原生程式仍核對實際 graph 位元組、來源與政策，不能混用不同版本的檔案。

## 更新與失敗處理

日常更新官方人行道並套用路網，先執行 `pnpm import:sidewalks`，成功後再執行 `pnpm otp:rebuild`。只更新交通圖或套用程式變更而沿用目前來源時，執行 `pnpm otp:rebuild`；後端程式有變更時再依部署方式重建／重啟後端。既有 `scheduled-otp-rebuild.sh` 先更新部署 checkout，再呼叫建圖流程，應只用在已設定妥當的部署主機。

**匯入會切換 ACTIVE 來源，建圖須另行執行。** 從來源切換到新圖載入完成之間，包含兩個指令之間的時間，後端可能因舊圖與來源不符回傳 503。`pnpm otp:rebuild` 也會在建圖與候選驗證期間暫停現有 OTP，以保留記憶體空間，因此須安排維護時段。相同 archive 重匯會保留原有來源版本 ID。

建圖失敗會保留舊圖與 release 檔案，但不代表來源已回復或所有服務均已恢復。若匯入已完成而後續建圖／載入失敗，先核對目前 ACTIVE 來源、服務圖及錯誤 log，修正後執行 `pnpm otp:rebuild`。不要只重啟後端，也不要手動補造 manifest、改來源 ID 或移動指標略過驗證。

候選驗證的完整輸出保存在該 release 的 `evidence/transport-verification-*.log` 與 `evidence/native-verification-*.log`，失敗訊息會列出檔案路徑。交通行程失敗時另列出 OTP 的 `routingErrors`、起點或終點欄位及說明；例如 `NO_STOPS_IN_RANGE` 應檢查步行路網與站點的連通性，不能只靠重新下載班表判斷已修復。

備份及搬遷須保留整個 `otp-data/`、對應 PostGIS 來源、程式與映像；來源版本 ID、批次及 archive SHA-256 必須一致。僅搬移 `graph.obj` 不足以恢復服務。`promote-otp-graph.sh` 是重建流程內部使用的整個 release 驗證與發布步驟，不接受單一 graph；日常操作使用上述主要指令。

## 直接步行的資料與回應契約

`travelMode: "walk"`、`mode: "normal"` 或 `"wheelchair"` 預設使用 native OTP，包含依序經過中途點的直接步行，不需要額外的功能啟用環境變數。後端必須先取得目前人行道來源版本，再核對 OTP 實際載入的圖、建圖 manifest、已核定政策身分與選中路段證據；缺少所需資料時回傳 503。其他輔助模式、大眾運輸接駁與停車行程中的步行段仍沿用既有 CSR 政策流程。

一般模式的 `avoidStairs: true` 會使用 `stairsReluctance: 12` 作為避梯偏好；它仍是一般步行，不等於輪椅模式或保證無階梯。未知的淨寬、坡度與設施資料不會被補成已確認無障礙。來源版本無法確認、身分不符、路段證據不完整，或實際選中幾何的端點／接續缺口超過 **0.25 公尺**時，後端會拒絕該候選，不用直線補洞或改用未驗證的步行路線。服務可啟動、TCP 可連線或 GraphQL 有回應，均不能代替這些檢查。

輪椅模式以 0.8 m/s 搜尋，先排除階梯。只有所有中途點分段的嚴格搜尋均已完成，且確有分段無路可走時，才對該段啟用明示需協助的階梯備援；每段仍使用前段實際抵達時間。兩種輪椅搜尋均拒絕已知淨寬不足 0.9 公尺、不可通行路面、電扶梯與票閘。階梯協助只放寬階梯本身的輪椅旗標與坡度，非階梯的已知禁止輪椅通行或超過 12% 坡度仍被排除。此固定政策不等於已套用使用者任意指定的坡度上限。

原生請求若確認本次端點連接因已知寬度或非階梯坡度受限，API 回傳 `422 ENDPOINT_CONSTRAINT_BLOCKED`，`data.endpointConstraint.pointIndex` 指出起點、中途點、終點序列中的位置（從 0 起算）。這表示目前端點連接不符合輪椅條件，不是整個區域都無路可走的證明，也不會啟用樓梯備援。無法完成這項確認、搜尋受限或逾時時，仍回傳 503。

本版後端需要提供 search schema 2 與端點限制欄位的核定 OTP 映像。保留舊證據解析不代表舊映像能接受新查詢；更新時須一起核對後端、政策映像、建圖 manifest 與核定清單。

空的 itinerary 不能單獨證明無路。後端要求原生搜尋確實耗盡可搜尋路徑的證據；逾時、搜尋距離上限或時間剪枝會回報 503，不觸發階梯備援。新增端點接線須有政府有效面完整覆蓋、來源、樓層及局部寬度證據，且是 OTP 真正走過、計入距離與時間的邊。接線的 `parentOsmWayId` 只識別接入目標，不能計為政府原生路段的使用證據。

此版本新增圖內來源與端點證據，必須重新建圖。舊圖會在反序列化前被明確拒絕；回復舊版本時須使用舊圖原本對應的執行映像，不可只修改格式標記或 manifest。

## 後端搜尋範圍與品質回歸

後端的每輪搜尋窗口與總搜尋範圍分開設定。預設先查 1 小時，再視候選情況擴大至 2 小時；仍無合格大眾運輸候選時，每次向後追加最多 8 小時，直到請求出發時間之後 24 小時。最後一輪只查剩餘範圍。找到合格候選可提早返回，並非每筆請求都查滿 24 小時。

| 後端環境變數 | 預設秒數 | 意義 |
| --- | ---: | --- |
| `OTP_SEARCH_WINDOW_S` | 3600 | 初次搜尋窗口 |
| `OTP_SEARCH_WINDOW_WIDE_S` | 7200 | 同一起點的擴大窗口，與初次窗口重疊 |
| `OTP_CONTINUATION_WINDOW_S` | 28800 | 每輪後續搜尋窗口上限 |
| `OTP_SEARCH_HORIZON_S` | 86400 | 從請求出發時間起算的總搜尋截止範圍 |

這些窗口針對可搜尋的出發班次，不是行程可花費的時間。變更分段大小不得暗中縮小總範圍：例如 12:30 的請求，`2h + 8h + 8h` 只到隔天 06:30，會漏掉 06:37／06:40 的早班。預設總範圍保留既有 24 小時行為，追加至隔天 12:30。

### 請求時限（`ROUTE_PLAN_BUDGET_MS`，預設 45000）

一次大眾運輸規劃的所有 OTP 階段共用同一個時限。主查詢保留用戶端原本的逾時（OTP 自己在 `apiProcessingTimeout` 25 秒放棄），所以 OTP 卡住仍會觸發斷路器；之後的擴大窗口、改從站牌重查、偏好運具、延伸時段，以及「區分沒有無障礙路線與沒有路線」的放寬重試，只能用剩下的時間，用完就略過。被時限截斷的查詢不算 OTP 故障。短程不再有「公車算太久就改回步行」：步行候選直接取 OTP 主查詢裡的直走行程，與公車一起排名；只有 OTP 回 `WALKING_BETTER_THAN_TRANSIT` 才標 `WALKING_BETTER`，其他只剩步行的情況標 `NO_TRANSIT_ROUTE`，OTP 不可用一律回 503。

### 轉乘快取必須涵蓋後端送出的每一組參數

OTP 依「步速＋輪椅旗標（＋其他步行偏好）」快取站間轉乘。請求的組合不在 `router-config.json` 的 `transit.transferCacheRequests` 裡時，OTP 會在請求當下重建一份快取，實測卡住 40 秒以上，而且每次重啟後都會再發生。後端的步速表在 `src/config/routing.ts`（`WALK_SPEED_MPS`，不可用環境變數改），每個步速都可能以輪椅旗標開或關送出（勾選避梯、輪椅模式放寬），`src/config/routing.test.ts` 會檢查兩邊一致。新增步速或改步行偏好時，兩邊一起改。

`build-config.json` 的 `transferRequests` 另含輪椅一筆：OTP 預設只替一般行人預算轉乘，沒有這筆時輪椅使用者的站間轉乘沒有保證無階梯的路徑（改動要重建圖）。

### 重複站牌合併

TDX 每條路線各有一個站牌，同一根站牌被多條路線停靠時會出現多筆座標相同的站牌。`merge-gtfs-duplicate-stops.py` 只合併「座標（小數 7 位）、站名、城市代碼都相同，只有公車停靠、無 parent station，且不會讓同一條路線的兩個站牌合在一起」的站牌，並重寫 `stop_times`、`pathways`、`stop_areas`、站名翻譯。合併後每條路線原本的站牌 ID 由 `import-gtfs-stop-aliases.ts` 寫入 Mongo `gtfsstopaliases`，後端在 OTP 回傳後換回，所以 API 的 `departureStopId`／`arrivalStopId` 與警示比對不變。完整建圖流程會執行合併與對照表匯入；合併後若對照表寫入失敗，必須中止建圖，避免 API 回傳錯誤的站牌 ID。

### 公車班次的無障礙旗標與路線低底盤歷史

`inject-tdx-bus-trips-a11y.ts` 不會推論 `wheelchair_accessible=2`，但保留上游 feed 自己發布的 2。路線的低底盤比例（台中、新竹的城市派車資料，以及即時到站資料中看到的車牌）存在 Mongo `busfleetsightings`，只當作後端排序訊號，不寫成 GTFS 班次旗標：GTFS 的旗標是「這一班」的事實，路線比例只說明這條路線多常派低底盤車。

### 基準與比較

```bash
python3 src/scripts/bench-otp-routing.py otp --label before --out logs/bench/before-otp.jsonl
python3 src/scripts/bench-otp-routing.py api --label before --out logs/bench/before-api.jsonl
python3 src/scripts/bench-otp-routing.py compare logs/bench/before-otp.jsonl logs/bench/after-otp.jsonl
```

`otp` 以 OTP 自己的 `debugOutput` 逐筆計時（不受其他人的查詢干擾），`compare` 報告 p50／p95、錯誤數，以及基準中的好方案（到達時間、步行、轉乘的 Pareto）改動後消失的比例。服務日用固定日期（`--date`），新舊圖都要涵蓋該日。

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

## 交通資料品質

建圖流程保留完整上游交通資料；目前直接步行的驗收範圍為台灣本島 **19 縣市**，離島暫緩。`build-config.json` 的 `islandPruning` 指路網不連通分量，不是地理上的離島開關，不可用它代替地理範圍設定。

原生政策映像在兩個 pruning 門檻均為零時，保留步行路段及原有通行權限，同時重新連接符合上游孤立判準的站點；無可用替代連接時保留原連接。大眾運輸的座標起終點會略過已完整確認沒有站點的小型孤立路網，直接步行仍保留原本端點規則。這兩種規劃共用路網，因此修改步行建圖設定後仍須通過交通路線驗證。

- `patch_gtfs.py` 會移除原有公車班次，再依完整城市清單與公路客運來源重建。不要為了縮短建圖時間刪減 `CITIES`，否則其他城市的公車會消失。
- `inject-tra-gtfs.py` 優先保留有效的上游逐日台鐵班表，補充車種名、來源明示的輪椅旗標及軌道幾何；原生班表不足時才使用一般班表注入。注入的週期班表仍有假日與上游快照限制，不能當成即時營運保證。
- 官方 TRTC feed 在捷運缺班補強之前處理，避免同一路線重複注入。交通輸入用 ZIP 不得另放進 `inputs/`，OTP 會將其中每個 ZIP 當作獨立 feed 載入。
- DEM 必須成功準備，不能省略高程後宣稱輪椅坡度限制已生效。它是地形估計，不是現場路面量測。
- 未知的站點或班次無障礙資料維持未知；路線的低底盤歷史不能改寫成每一班車均可供輪椅使用。

## 故障排查

| 現象 | 檢查與處置 |
| --- | --- |
| 建圖預檢失敗 | 依終端輸出補齊主機工具、設定或服務，再執行 `pnpm otp:rebuild`；已完成的人行道匯入不會因此回復。 |
| 下載失敗或 TDX 回 429 | 確認憑證、網路與上游狀態，等待限流冷卻；人行道下載失敗重跑 `pnpm import:sidewalks`，建圖資料下載失敗重跑 `pnpm otp:rebuild`。 |
| 建圖或 OTP 以 137 結束 | 檢查主機／Docker VM 記憶體與並行服務用量，增加容量或安排維護時段。 |
| 班表服務窗口檢查失敗 | 檢查上游 GTFS 與注入資料，不改日期或縮短門檻讓舊 feed 通過。 |
| 首次部署找不到 graph 或 manifest | 先完成 `pnpm import:sidewalks`，再執行 `pnpm otp:rebuild`；Docker 啟動不會補建這些檔案。 |
| 來源匯入成功，但建圖／載入失敗 | 來源可能已切換，舊圖即使仍在也可能被後端拒絕；修正原因後執行 `pnpm otp:rebuild`。 |
| OTP 反覆重啟、回報圖格式或身分不符 | 確認程式、native 映像、active release 與 PostGIS 來源相配，再重建。 |
| API 直接步行回 503 | 檢查 OTP、PostGIS 來源及實際路段證據；GraphQL 可連線不代表資料合格。 |
| API 輪椅步行回 `422 ENDPOINT_CONSTRAINT_BLOCKED` | 端點連接不符合已知輪椅條件，依回傳的 `pointIndex` 調整位置。 |
| 交通路線缺少台鐵／捷運 | 檢查 graph 的 feed 是否包含有效班表，重新建圖並載入。 |

人行道匯入失敗會標示 `options`（參數）、`download`（官方 ZIP 下載）、`local-zip`（本機 ZIP 讀取）或 `store`（來源驗證與 PostGIS 入庫）階段，並顯示可安全輸出的 HTTP／連線／資料庫錯誤代碼。每次下載逾時上限為 180 秒；暫時斷線、逾時或 HTTP 408／429／5xx 最多嘗試三次，每次重新下載，不沿用未完成檔案。資料驗證及入庫失敗不會自動重試；若失敗在 `store`，先核對來源快照狀態再重試。輸出不包含資料庫密碼或原始資料列。

匯入與建圖各自的終端輸出顯示執行結果與進度；服務狀態可另查：

```bash
docker compose logs --tail 100 otp backend
docker compose ps -a otp backend postgis mongo
```

部署後仍須使用實際 API 驗證一般步行、輪椅步行、中途點與主要交通行程；安全拒絕不是所有地點均能通行的保證。
