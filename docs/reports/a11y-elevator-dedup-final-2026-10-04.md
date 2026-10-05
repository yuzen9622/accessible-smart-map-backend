# 電梯增量逐筆裁定（2026-10-04）

83 筆不是 83 台新電梯。重新比對後，可新增 **80 個來源參考位置**、合併 **1 筆來源別名重複**、**2 筆設備身分不明暫緩獨立新增**。80 個位置只表示此份現有資料沒有對應電梯位置；未有設備編號或樓層連通證據，不能宣稱不同實體電梯，更不能因此新增可通行路由邊。

## 範圍與方法

檢查輪行臺北全部 221 筆電梯、其中先前距既有同型點 >15m 的 83 筆；交叉比對原本 138 筆匹配記錄、accessibilities.json（190）、osma11ies.json（11,110）、parkinglots.json（2,984）、campusa11ies.json（82 個校區）。既有同型最近距離沿用原比對 EPSG:3826 座標運算；本輪 parking venue 的顯示距離為臺北緯度局部近似，僅供同名／別名核對，不用於設備合併閾值。83 筆內兩兩檢查，100m 內唯一一組為世貿別名同座標。校園資料電梯無有效二維座標，且 83 筆停車場名稱沒有對應同校名，不能將校園電梯當成已完整排除的實體設備清冊。

來源 API：[輪行臺北電梯](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/3)。既有資料範圍僅為本專案匯出快照，非全臺設備清冊。

## 裁定

| 裁定 | 筆數 | 可以做什麼 |
|---|---:|---|
| add_reference_location | 80 | 地圖新增來源參考位置，保留設備身分未核實／運轉未知，不產生通路 |
| merge_source_alias_duplicate | 1 | source 98 合併到 99 的同位置群組，保留雙來源，不新增第二個標記 |
| hold_equipment_identity | 2 | 林森公園 29、大湖公園 46 保留候選，不作獨立新設備計數 |
| 合計 | 83 | 82 組原始不同座標，80 組可新增參考位置、2 組保留 |

其中 **33 筆來源記錄可對上既有停車場 venue，對應 32 個既有停車場 ID**。這些是既有地點新增電梯資訊，不是新停車場；其餘 50 筆沒有在此份 parkinglots 名称／已核對別名表匹配，不代表現實新建場所。原有 138 筆來源記錄均可對上同名、同位置的既有記錄，不在本輪新增範圍。最近鄰結果只有 137 個 ID，是同座標距離平手選擇造成，不能解讀為只匹配 137 筆或名稱不一致；仍不能把 138 筆記錄當成 138 台獨立設備。

### 需要明確處理的例外

- source 99 世貿公園地下停車場與 source 98 南港世貿地下停車場座標完全相同（121.616240991081,25.0577757688701），並指向既有 TPE0827。官方使用「南港區世貿公園地下停車場」名稱，支持場址別名歸戶。合併的是參考標記，不宣稱該停車場只存在一台電梯。[官方公告](https://www.gov.taipei/News_Content.aspx?n=D0042A87C2F0270A&s=BD12C2CBA8B40A8F&sms=78D644F2755ACCAA)
- source 29 林森公園：既有 osm:12438301813 名稱「嘟嘟房林森公園場 (行人電梯)」，距離 78.5251m。同場已知有電梯；來源沒有設備 ID，不能區分第二台或座標偏移。官方附件僅確認設有電梯設備，未解開點位身分。[官方附屬設施表](https://www-ws.gov.taipei/001/Upload/455/relfile/22477/8983597/acecd8d1-9bb1-4e01-97b1-0acc9eddfe3b.pdf)
- source 46 大湖公園：距「大湖公園站出口電梯2」21.6601m。停車場與捷運名稱不同，但資料沒有樓層、設備編號、入口對照，不能只因超過 15m 就保證獨立新設備；暫緩獨立新增。
- 原 138 筆中，東湖站出口電梯 1 與出口電梯 2 在新來源同座標（121.611238,25.067189）；既有 metro:31 與 metro:32 也同座標，名稱分別正確對應出口 1、2。最近鄰平手選到 metro:32 不表示名稱匹配錯誤。記錄層的名稱、位置相符，實體設備是否獨立則不能只靠共用座標判定；不應改寫既有名稱或新增兩台設備。
- source 110 名稱含「新糖?」，原始編碼瑕疵保留；參考位置可用，但不把推測校名／場名改寫成官方值。
- 已核對別名包括青年棒球場→青年公園棒球場、災變中心→臺北市災害應變中心、忠信公園→忠信廣場、健康國小地下→健康國小B1、洛陽立體→洛陽綜合立體、青年高球場→青年公園高爾夫球場、金華地下→金華公園地下。只掛 venue 關聯，不把 parking centroid 當 elevator 位置。

## 逐筆結果

完整來源 hash ID、群組、最近既有電梯、距離、既有停車場 ID 與理由見 external artifact。表內來源號碼僅為此輪來源名稱前綴，不保證跨版穩定。

| 來源號 | 名稱 | 裁定 | 已知停車場 ID |
|---|---|---|---|
| 110 | 新糖?公園地下停車場 | add_reference_location | 未匹配 |
| 108 | 萬華國中地下停車場 | add_reference_location | TPE0690 |
| 107 | 艋舺公園地下停車場 | add_reference_location | 未匹配 |
| 105 | 青年棒球場地下停車場 | add_reference_location | TPE0318 |
| 104 | 雙園國中地下停車場 | add_reference_location | TPE0288 |
| 103 | 青年高球場地下停車場 | add_reference_location | TPE0305 |
| 101 | 洛陽立體停車場 | add_reference_location | TPE0010 |
| 100 | 峨眉立體停車場 | add_reference_location | 未匹配 |
| 99 | 世貿公園地下停車場 | add_reference_location | TPE0827 |
| 98 | 南港世貿地下停車場 | merge_source_alias_duplicate | TPE0827 |
| 97 | 玉成公園地下停車場 | add_reference_location | TPE0775 |
| 96 | 南港國小地下停車場 | add_reference_location | 未匹配 |
| 95 | 玉成國小地下停車場 | add_reference_location | 未匹配 |
| 93 | 興中立體停車場 | add_reference_location | 未匹配 |
| 92 | 景勤2號公園地下停車場 | add_reference_location | 未匹配 |
| 91 | 松山車站地下停車場 | add_reference_location | TPE0851 |
| 90 | 松山工農地下停車場 | add_reference_location | TPE0848 |
| 89 | 信義國小地下停車場 | add_reference_location | TPE0816 |
| 88 | 雅祥公園地下停車場 | add_reference_location | 未匹配 |
| 87 | 災變中心地下停車場 | add_reference_location | TPE0567 |
| 86 | 三張里地下停車場 | add_reference_location | 未匹配 |
| 85 | 春光公園地下停車場 | add_reference_location | 未匹配 |
| 84 | 信義廣場地下停車場 | add_reference_location | TPE0334 |
| 83 | 忠信公園地下停車場 | add_reference_location | TPE0230 |
| 81 | 五分埔公園地下停車場 | add_reference_location | TPE0075 |
| 79 | 松壽廣場地下停車場 | add_reference_location | 未匹配 |
| 78 | 府前廣場地下停車場 | add_reference_location | 未匹配 |
| 77 | 偶戲博物館地下停車場 | add_reference_location | 未匹配 |
| 76 | 松山國小地下停車場 | add_reference_location | TPE0884 |
| 75 | 民生社區地下停車場 | add_reference_location | 未匹配 |
| 73 | 八德立體停車場 | add_reference_location | 未匹配 |
| 72 | 民有市場地下停車場 | add_reference_location | TPE0534 |
| 71 | 中崙高中地下停車場 | add_reference_location | 未匹配 |
| 70 | 健康國小地下停車場 | add_reference_location | TPE1345 |
| 64 | 民生立體停車場 | add_reference_location | TPE0003 |
| 63 | 民權公園地下停車場 | add_reference_location | 未匹配 |
| 62 | 立農公園地下停車場 | add_reference_location | 未匹配 |
| 61 | 七星公園地下停車場 | add_reference_location | 未匹配 |
| 59 | 石牌國小地下停車場 | add_reference_location | 未匹配 |
| 58 | 振興公園地下停車場 | add_reference_location | 未匹配 |
| 57 | 大豐公園地下停車場 | add_reference_location | 未匹配 |
| 56 | 興隆公共住宅2區地下停車場 | add_reference_location | 未匹配 |
| 55 | 永建國小地下停車場 | add_reference_location | 未匹配 |
| 54 | 萬興國小地下停車場 | add_reference_location | TPE0835 |
| 53 | 景美國小地下停車場 | add_reference_location | 未匹配 |
| 52 | 興隆公園地下停車場 | add_reference_location | TPE0715 |
| 51 | 花木市場地下停車場 | add_reference_location | 未匹配 |
| 49 | 景華公園地下停車場 | add_reference_location | 未匹配 |
| 48 | 康樂合署大樓地下停車場 | add_reference_location | 未匹配 |
| 47 | 西康地下停車場 | add_reference_location | 未匹配 |
| 46 | 大湖公園地下停車場 | hold_equipment_identity | 未匹配 |
| 45 | 西湖公園地下停車場 | add_reference_location | 未匹配 |
| 44 | 洲子立體停車場 | add_reference_location | TPE0654 |
| 40 | 麗湖國小地下停車場 | add_reference_location | 未匹配 |
| 39 | 東湖國小地下停車場 | add_reference_location | TPE0360 |
| 37 | 榮星花園地下停車場 | add_reference_location | 未匹配 |
| 36 | 長安國小地下停車場 | add_reference_location | TPE0606 |
| 35 | 永盛公園地下停車場 | add_reference_location | TPE0425 |
| 34 | 濱江市場地下停車場 | add_reference_location | 未匹配 |
| 33 | 進安公園地下停車場 | add_reference_location | 未匹配 |
| 29 | 林森公園停車場 | hold_equipment_identity | 未匹配 |
| 27 | 嘉興公園地下停車場 | add_reference_location | 未匹配 |
| 26 | 僑安地下停車場 | add_reference_location | 未匹配 |
| 25 | 龍門國中地下停車場 | add_reference_location | TPE0449 |
| 24 | 附中公園地下停車場 | add_reference_location | 未匹配 |
| 23 | 大安高工地下停車場 | add_reference_location | 未匹配 |
| 22 | 金華地下停車場 | add_reference_location | TPE0086 |
| 21 | 大安森林公園地下停車場 | add_reference_location | TPE0095 |
| 19 | 啟聰學校地下停車場 | add_reference_location | TPE0930 |
| 18 | 大龍國小地下停車場 | add_reference_location | TPE0828 |
| 17 | 建成公園地下停車場 | add_reference_location | 未匹配 |
| 16 | 蓬萊國小地下停車場 | add_reference_location | 未匹配 |
| 15 | 朝陽公園地下停車場 | add_reference_location | 未匹配 |
| 14 | 建成國中地下停車場 | add_reference_location | TPE0239 |
| 12 | 大稻埕公園地下停車場 | add_reference_location | 未匹配 |
| 10 | 塔城公園地下停車場 | add_reference_location | 未匹配 |
| 9 | 福林公園地下停車場 | add_reference_location | 未匹配 |
| 8 | 蘭雅公園地下停車場 | add_reference_location | 未匹配 |
| 7 | 承德公園地下停車場 | add_reference_location | 未匹配 |
| 6 | 社子國小地下停車場 | add_reference_location | 未匹配 |
| 5 | 海光公園地下停車場 | add_reference_location | TPE0538 |
| 4 | 文昌國小地下停車場 | add_reference_location | 未匹配 |
| 2 | 前港公園地下停車場 | add_reference_location | TPE0062 |

## 產物與限制

- `/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/duplication/elevator-adjudication-final.json`：83 筆逐筆決策，原 hash ID 可追溯。
- `/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/duplication/elevator-new-reference-locations.geojson`：80 個可新增參考位置。仍 `routing_eligible=false`。
- 未修改正式資料庫或路由，未確認即時開放、故障狀態或實地精度。未來取得設備 ID、平面圖／樓層對照時，才可判定獨立設備與路由連接。
