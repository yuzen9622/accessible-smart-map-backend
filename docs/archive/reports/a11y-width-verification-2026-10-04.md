# 輪行臺北寬度欄位交叉核實

查證日期：2026-10-04。此次新增官方資料間的面幾何與欄位比對，沒有修改路由程式、匯入設定或正式資料庫。

## 決策

**仍不將 Wheelroute `width` 當作輪椅可通行淨寬。** 新證據顯示，類別 11 的寬度值大多與另一官方來源的「人行道寬度」相同，而不是「人行道淨寬」。這比數值看起來像公尺更具體：即使日後確認單位，也不能直接解開淨寬限制。

類別 11 的數值尺度高度支持它與官方人行道寬度使用相同尺度；但 API 文件仍寫公分，現行網站未找到有效顯示單位的程式，因此本報告不宣稱已獲主管機關確認為公尺。更不能把類別 11 的推論推廣到類別 7 入口或其他設施。

## 本次直接讀取的官方證據

1. [輪行臺北公開 API 類別 11](https://wheelroute.gov.taipei/wheelrouteApi/api/facility/Get/11)：重新以正常 TLS 下載 15,291 筆，SHA-256 與候選建置時原始檔完全一致。
2. [資料平台正式欄位說明](https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7)仍標寬度為公分。[正式 API PDF](https://www-ws.gov.taipei/Download.ashx?icon=.pdf&n=6Lyq6KGM6Ie65YyX6Kit5pa9QVBJ6Kqq5piOLnBkZg%3D%3D&u=LzAwMS9VcGxvYWQvMzkwL3JlbGZpbGUvMC8xMjQ2ODkvNjcwOWE0ZjEtMjIwYS00ZWU1LWIwMTUtOWZjNjQ0NjU3MjJmLnBkZg%3D%3D)也相同。這是契約衝突，不能以數值合理性單方面改定義。
3. 重新下载[官方首頁](https://wheelroute.gov.taipei/)：含單位 `m` 的舊資訊框程式都在單行或區塊註解內。特別是 HTML 第 1798、1801 行雖沒有 `//`，實際被第 1797 至 1802 行 `/* ... */` 包住，不能當作運作中的 UI 證明。這次沒有完成瀏覽器點選式驗證，因此僅陳述原始碼檢查結果。
4. 重新讀取[國土管理署人行道資料集 58791](https://data.gov.tw/dataset/58791)：正式說明區分 `SW_WTH` 人行道寬度與 `SWW_WTH` 人行道淨寬。本次使用候選建置已下載的 202606 臺北市人行道，共 18,304 面。[原始官方下載](https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/11D38E3D-F980-40BF-B714-4E0DB8AA1252/resource/673E16B8-66BC-4DD6-BA39-767BE3324F5C/download)。本次沒有重新下載整份全國 ZIP。

## 實際交叉比對

方法：以 WGS84 面幾何建立 Shapely STRtree；對每一筆有效 Wheelroute Polygon，選取交集／聯集面積比（IoU）最高且至少 0.95 的有效官方人行道面。不使用名稱猜配，也不只取最近中心點。此處經緯度平面面積只用作幾何相似度，未聲稱平方公尺面積。不是一對一全域配對，也不是現地量測。

寬度相同定義為絕對差不超過 0.005 個原始數值單位。

| 實測項目 | 結果 |
| --- | ---: |
| Wheelroute 總筆數 | 15,291 |
| IoU ≥ 0.95 配對 | 14,232（93.07%） |
| `width` 等於 `SW_WTH` | 13,840／14,232（97.25%） |
| `width` 等於 `SWW_WTH` | 4,732／14,232（33.25%） |
| 兩官方寬度欄位不同的配對 | 9,344 |
| `width` 等於總寬、同時不等於淨寬 | 9,125 |
| `width / 100` 等於 `SW_WTH` | 0／14,232 |
| `width / 100` 等於 `SWW_WTH` | 0／14,232 |

最後兩列僅檢验將 API 公分數值縮小 100 倍後是否符合另一來源數值，**不是單位已定案**。高一致性也可能反映兩來源共用原始調查資料，而不是兩次獨立量測。

| Wheelroute 名稱 | IoU | width | 官方總寬 | 官方淨寬 |
| --- | ---: | ---: | ---: | ---: |
| 15509-大安區-和平東路一段-人行道 | 0.999826 | 4.8 | 4.8 | 2.25 |
| 15491-中正區-中華路一段-人行道 | 0.999585 | 16.59 | 16.59 | 10.27 |
| 15502-南港區-南深路-人行道 | 0.993810 | 1.2 | 1.2 | 1.15 |
| 15512-中山區-市民大道三段-人行道 | 0.999629 | 1.0 | 8.64 | 8.64 |
| 15507-北投區-稻香路-人行道 | 0.994886 | 2.8 | 0.48 | 0.48 |

最後兩例顯示高度重疊也不保證屬性相同；可能涉及不同調查版本、欄位維護或資料錯誤，本次證據不能判斷原因。不得以 97.25% 一致為由覆寫剩下記錄或把面資料轉成每一條路段的通行保證。

## 可追溯材料與重現條件

- Wheelroute 原始檔：`/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/wheelroute/facility-11.json`；本次另下載 `/tmp/wheelroute-facility11-fresh.json`。兩者 SHA-256：`6629797b32e8dd7206715de9bd8d57f882a49162054f9427d996037a9ebd80de`。
- 官方面轉檔：`/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/SIDEWALK_台北市_202606_WGS84.geojson`；SHA-256：`3edbec55237266f2e49e729e7cf531610833744ffae6ef329ba9fd820a10204f`。
- 本次首頁：`/tmp/wheelroute-width-home.html`；SHA-256：`0f9e262e4aaba1a95c253ae4689522c1c521ddbf9c6ca5b521cd34813bf9706c`。
- 比對程式 `/tmp/verify-wheel-width.py`，執行 `/tmp/a11y-feasibility-20261004-venv/bin/python /tmp/verify-wheel-width.py`；完整統計與前 12 例在 `/tmp/wheel-width-comparison.json`。這些 `/tmp` 檔為可刪除的工作證據；本報告已保存規則、輸入雜湊、結果與具名例子。

本次可确认的是欄位衝突與大多數配對的總寬／淨寬差異；尚未确认的是主管機關對各設施類型的單位修訂、數值有效年代，以及現地最窄處是否仍通行。因此維持 `width_unit=unresolved` 與 `routing_eligible=false`；參考幾何可用，數值不可直接當作最小淨寬。

核實完成後已將比對程式、HTML 與 JSON 複製保存至 `/Volumes/KINGSTON/codex-tmp/a11y-candidate-20261004/verification/`，避免只依赖 `/tmp`。統計亦保存在 repo 的 [比較 JSON](a11y-width-comparison-2026-10-04.json)。
