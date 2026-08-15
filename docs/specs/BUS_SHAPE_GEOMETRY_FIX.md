# 公車路線幾何遺失修復計畫（patch_gtfs 子路線錯配）

**狀態**：待實作（交由 Codex）
**日期**：2026-07-29
**唯一變更檔案**：`src/scripts/patch_gtfs.py`、`src/scripts/test_patch_gtfs.py`
**不需重建即可驗收的部分**：單元測試；graph 重建與線上驗收由人工執行（見 §8）

---

## 1. 問題與根因（已實測證實，非推測）

### 1.1 現象

前端拿到的部分公車路段只有「站到站直線」，沒有真實路徑。以新竹縣 **61B** 為例，直接查線上 OTP：

```
route 1:HSQ0081B1_0 (61B) 共 3 個 pattern：
  :01  geomPts 1149 / stops 66   ← 正常
  :02  geomPts   64 / stops 64   ← 每站一點 = 直線
  :03  geomPts   65 / stops 65   ← 每站一點 = 直線
```

「幾何點數 == 站數」是 OTP2 丟棄 shape 後的 straight-line hop 幾何。

### 1.2 OTP 為何丟棄

OTP2 會把每站投影到 shape 上；只要**任一站**離 shape 超過 `maxStopToShapeSnapDistance`，就把**整條 pattern** 降級成站點直線。`otp-data/build-config.json` 未設此值，吃 OTP2 預設 150 m。

本次實測的門檻落點：最大偏離 **84 m 的 pattern 保留幾何**、**199 m 的被丟棄**，與預設 150 m 相符。

61B 三個 pattern 對 feed 內 shape `HSQ0081B1_0` 的最大站→線距離：

| pattern | 站數 | 最大偏離 | OTP 結果        |
| ------- | ---- | -------- | --------------- |
| A       | 66   | 32 m     | 保留（1149 點） |
| B       | 65   | 345 m    | 丟棄 → 直線     |
| C       | 64   | 345 m    | 丟棄 → 直線     |

偏離來源是 B/C 多出來、根本不在 61B 上的站：`文化公園(HSQ309386)`、`文化局(HSQ303554)`、`東海`、`成瀧`。

### 1.3 根因 A（主因，佔 95%）：班次被掛到錯的子路線

trip `patched_HSQ0081B1_0_HSQ008101_0909_1` 的來源子路線是 **HSQ008101（61 主線）**，卻被寫進 route **HSQ0081B1_0（61B）**。

肇因在 `src/scripts/patch_gtfs.py:941-972`（`process_schedule_records_to_gtfs`）比對順序寫反：

```python
matched_id = None
# 1. Match by RouteUID + Direction        ← 先跑，且會做前綴比對
if route_uid:
    exact = f"{route_uid}{suffix}"        # "HSQ0081_0" 不存在於 routes.txt
    if exact in route_ids_set: ...
    else:
        for r_id in route_ids_set:        # ← set，迭代順序不確定
            if r_id.startswith(route_uid) and r_id.endswith(suffix):
                matched_id = r_id; break
# 2. Match by SubRouteUID + Direction     ← 正解在這，但永遠跑不到
```

RouteUID `HSQ0081` 的前綴同時命中 `HSQ008101_0`、`HSQ0081A1_0`、`HSQ0081B1_0`，而 `route_ids_set` 是 `set`（`patch_gtfs.py:1063`），**誰中獎不確定**。用 SubRouteUID 精準比對（`HSQ008101` + `_0` = `HSQ008101_0`，確實存在）本來就會對。

全台規模（掃 `otp-data/feed-1.gtfs.zip` + 線上 OTP 全量 pattern）：

| 指標                                                   | 數字                                       |
| ------------------------------------------------------ | ------------------------------------------ |
| 公車 pattern 幾何退化成直線                            | 963 / 6658（14.5%）                        |
| patched 班次掛錯路線（該子路線自己有 route_id 卻沒用） | **11,399 / 128,050（8.9%）**，1,509 組錯配 |
| 幾何偏離 >150 m 的 pattern 中由錯配造成                | **837 / 882（95%）**                       |
| 完全沒有 shape_id 的 pattern                           | 4                                          |
| dangling shape_id                                      | 0                                          |

> 此錯配同時是**資料正確性問題**，不只是畫線問題：61 主線的班次被標成 61B，使用者看到的路線號碼與班表都是錯的。

### 1.4 根因 B（次因）：shape 索引鍵漏掉 SubRouteUID

`build_shape_index`（`patch_gtfs.py:557-568`）只用 RouteUID 當鍵：

```python
ruid = r.get("RouteUID")
index[(ruid, direction)] = pts     # 同 RouteUID 的不同子路線 → 後者覆蓋前者
```

但 `_select_shape_id`（`patch_gtfs.py:777-786`）卻查 `(sub_route_uid, direction)` — **只要 `SubRouteUID != RouteUID`（也就是所有分支路線，正是出問題的那些），該查詢必定 miss**。只有在兩者相等時（測試 fixture 的 `_sor_route` 就是這樣造的，`test_patch_gtfs.py:82-83`）才會命中，所以現有測試看不出這個缺口。

TDX 實測（`/v2/Bus/Shape/City/HsinchuCounty`）確認幾何是**逐 SubRouteUID** 提供的：

```
RouteUID HSQ0081 底下：
  HSQ008101 (61)       769 pts
  HSQ0081A1 (61支線A)  763 pts
  HSQ0081B1 (61B)     1177 pts
```

新竹兩市縣共 179 份子路線幾何，其中 29 個 `(RouteUID, Direction)` 桶裝了多份子路線 → **36/179（20%）幾何被 last-wins 靜默覆蓋**。`HSQ0551B1_0` 用到 `patched_shp_` 卻偏離 4.2 km，就是這條路徑造成的。

### 1.5 根因 C（防呆缺口）：選完 shape 不驗證貼合度

`_select_shape_id` 無條件優先沿用 route 層繼承的舊 shape（`route_shape_by_route[matched_id]`，來源是該 route_id 第一個看到的 shape_id），從不檢查它是否貼合這個 trip 的實際站序。偏離量分布：300–1000 m 有 312 個 pattern、1–10 km 有 421 個、>10 km 有 82 個。

### 1.6 資料是否存在？完全存在

把新竹**每一個**退化 pattern 拿去對同 RouteUID 底下所有子路線幾何做最佳擬合：

```
HSQ0081B1_0 (65站)  現況 345m → HSQ008101 dir0 =  51m  OK
HSQ0081B1_0 (64站)  現況 345m → HSQ0081A1 dir0 =  51m  OK
HSQ006601_0 (26站)  現況2289m → HSQ0066B1 dir0 =  12m  OK
HSQ010901_0 (84站)  現況2112m → HSQ0109A1 dir0 =  18m  OK
HSQ0551B1_0 (17站)  現況4237m → HSQ055101 dir0 =  13m  OK
… 全 19 個退化 pattern，19 個都有 <150 m 的正解
```

**不需要任何新資料來源。**

---

## 2. 需求（R 編號，測試 docstring 請引用）

| ID     | 需求                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | TDX 子路線班表比對 GTFS route_id 時，**SubRouteUID 精準比對優先於 RouteUID**；精準比對一律優先於前綴比對。                                                                                               |
| **R2** | 前綴比對必須**決定性**（不得迭代 `set`）；候選 >1 時記入 `route_match_prefix_ambiguous` 並取排序後第一個。                                                                                               |
| **R3** | shape 索引以 `(SubRouteUID or RouteUID, Direction)` 為主鍵，並另存 RouteUID 層粗略備援；備援不得被後續子路線覆蓋（first-wins）。                                                                         |
| **R4** | shape 候選依序：本子路線 TDX shape → RouteUID 層 TDX shape → 反向 TDX shape（反轉點序）→ 靜態繼承 shape。**每個候選都要通過貼合度驗證**，全部不過就不寫 `shape_id`。                                     |
| **R5** | 貼合度定義：trip 站序中所有「有座標」的站，其到 shape 折線的最短距離皆 ≤ `SHAPE_FIT_TOLERANCE_M = 100`。無任何站有座標時視為「無法判定 → 通過」（fixture feed 沒有 stops.txt，不得因此全面丟失 shape）。 |
| **R6** | 產出的 shape_id 不得因不同子路線共用 route_id 而互相覆蓋：命名改為 `patched_shp_{key_uid}_{direction}`，反向候選另加 `r` 後綴。                                                                          |
| **R7** | 新增可觀測性 stats 並印在 summary（見 §5），使「有沒有修好」不需重建 graph 就能從 patch 日誌判斷。                                                                                                       |

---

## 3. 實作細節

> 行號以 commit `1807d1e` 為基準，實作時會位移，以函式名為準。

### 3.1 R1+R2 — 路線比對順序（`process_schedule_records_to_gtfs`, 約 941-972）

在 `for route in records:` **之前**建一次 `sorted_route_ids = sorted(route_ids_set)`（同時消掉目前每筆 record 都掃整個 set 的成本）。

比對改為五段，一旦命中即停：

1. `sub_route_uid` 精準：`f"{sub_route_uid}{suffix}" in route_ids_set` → `stats["route_match_subroute_exact"]`
2. `route_uid` 精準：`f"{route_uid}{suffix}" in route_ids_set` → `stats["route_match_route_exact"]`
3. `sub_route_uid` 前綴：`[r for r in sorted_route_ids if r.startswith(sub_route_uid) and r.endswith(suffix)]`
4. `route_uid` 前綴：同上，以 `route_uid` 為前綴
5. 既有的 RouteName / RouteID 名稱比對（`route_list`，邏輯不變）

第 3、4 段：候選為空 → 進下一段；候選 == 1 → 採用，記 `route_match_prefix`；候選 > 1 → 採用 `candidates[0]`（已排序，決定性），記 `route_match_prefix` **與** `route_match_prefix_ambiguous`。

完全沒命中 → `stats["route_unmatched"] += 1` 後 `continue`（現行行為是靜默 `continue`）。

**不要**用「編號結尾是 01 就是主線」之類的推測規則補救歧義 — 專案原則是探測 + 依序回退，不寫死猜測。

### 3.2 R3 — `build_shape_index`（約 557-568）

```
for each record:
    pts = parse_linestring(Geometry);  空 → skip
    suid = SubRouteUID; ruid = RouteUID; d = Direction (預設 0)
    if suid: index[(suid, d)] = pts            # 精確鍵，可覆蓋（同鍵應為同一份）
    if ruid: index.setdefault((ruid, d), pts)  # 粗略備援，first-wins
```

docstring 必須說明：主鍵是子路線，RouteUID 只是備援且在多子路線時是任意一份（由 R4 的貼合度驗證擋掉錯用）。

**注意**：這改變了既有行為（RouteUID 鍵由 last-wins 變 first-wins）。若 `ShapeAndStopOfRouteTests` 有相依斷言，一併更新。

### 3.3 R4+R5+R6 — 引入 `ShapeAssigner`

現行 `_select_shape_id` 已有 8 個位置參數，再塞 stop 座標與快取會失控。改為一個小類別，把 shape 指派的狀態與策略收在一起：

```
class ShapeAssigner:
    """Chooses a shape_id for a patched trip and validates that the geometry
    actually fits the trip's stop sequence, so OTP will not silently discard it."""

    def __init__(self, route_shape_by_route, tdx_shapes, static_shape_points,
                 stop_coords, stats):
        # new_shapes 也內含，改由 .new_shapes 對外暴露給 zip 寫出階段

    def select(self, matched_id, sub_route_uid, route_uid, direction, stop_ids) -> str
```

`select()` 候選順序（R4），每個候選都跑 `_fits()`：

| 順序 | 來源                                                    | 產生的 shape_id                                                                                                                                                                                                                                     | 統計                          |
| ---- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1    | `tdx_shapes[(sub_route_uid, direction)]`                | `patched_shp_{sub_route_uid}_{direction}`                                                                                                                                                                                                           | `shape_from_subroute`         |
| 2    | `tdx_shapes[(route_uid, direction)]`                    | `patched_shp_{route_uid}_{direction}`                                                                                                                                                                                                               | `shape_from_route_uid`        |
| 3    | 上兩者的反向（`[::-1]`，先試 sub 再試 route）           | `patched_shp_{key_uid}_{direction}r`，其中 `key_uid` 取**實際命中的那一個**：命中 `(sub_route_uid, 1-direction)` 就用 `sub_route_uid`，命中 `(route_uid, 1-direction)` 就用 `route_uid`；`direction` 一律用**該 trip 的方向**，不是被反轉的來源方向 | `shape_from_reversed`         |
| 4    | `route_shape_by_route.get(matched_id)` 的原始靜態 shape | 沿用原 shape_id（**不**寫入 `new_shapes`）                                                                                                                                                                                                          | `shape_from_static`           |
| —    | 全不通過                                                | `""`                                                                                                                                                                                                                                                | `shape_rejected_unfit`        |
| —    | 完全沒有任何候選                                        | `""`                                                                                                                                                                                                                                                | `missing_shape`（維持現有鍵） |

注意：候選 1–3 只在**通過驗證後**才寫入 `self.new_shapes`（現行程式是先寫再用，會把不合格幾何留在 shapes.txt 變孤兒列）。

貼合度：

```
SHAPE_FIT_TOLERANCE_M = 100
```

選 100 而非 OTP 的 150：讓我方判定**嚴於** OTP，凡我方接受的 OTP 必接受。實測良品最大偏離 ≤84 m，錯配最小 199 m，100 m 落在安全帶內。

`_fits(pts, stop_ids)`：

- 取 `stop_coords` 有座標的站；一站都沒有 → 回 `True`（R5）。
- 距離用等距圓柱投影：以 shape 各點緯度平均為 `lat0`，`kx = 111320 * cos(lat0)`、`ky = 110540`，轉成公尺平面後算**點到線段**最短距離（不是點到頂點）。誤差 <1%，對 100 m 門檻足夠。
- 逐段先做便宜的 bounding-box 剪枝（線段 x/y 範圍外擴 tolerance，不相交就跳過）。
- **任一站超標即回 `False`（early exit）** — 錯配案例幾乎都在前幾站就被判掉。
- 結果以 `(shape_cache_key, tuple(stop_ids))` 記憶化在 `self._fit_cache`；全台約 7k 個相異 pattern，重複 trip 不重算。

呼叫端：

- `process_schedule_records_to_gtfs`：`shape_id = shape_assigner.select(matched_id, sub_route_uid, route_uid, direction, [r["stop_id"] for r in stop_rows])`。此時 `stop_rows` 已建好（約 1037 行前），順序無需調整。
- `_emit_frequency_trip`：同樣改用 `shape_assigner.select(...)`，站序取 `[r["stop_id"] for r in stop_rows]`。
- 參數瘦身：`process_schedule_records_to_gtfs`、`_generate_frequency_trips`、`_emit_frequency_trip` 的 `route_shape_by_route, tdx_shapes, new_shapes` 三個參數合併為一個 `shape_assigner`。四處測試呼叫點（`test_patch_gtfs.py:446, 467, 532, 638` 全為位置引數）必須同步更新。

### 3.4 `patch_gtfs_zip` 需要新增兩份輸入資料

在既有 `with zipfile.ZipFile(zip_path, "r") as zin:` 區塊內加兩步（放在讀 trips.txt 之後，因為要用 `route_shape_by_route`）：

**(a) `stop_coords`** — 讀 `stops.txt`（不存在則空 dict），建 `{stop_id: (lat, lon)}`。實測全台 161,939 列，記憶體約 20–30 MB。`stop_lat`/`stop_lon` 解析失敗的列跳過。

**(b) `static_shape_points`** — 只為 `set(route_shape_by_route.values())`（公車 route 繼承到的 shape_id，約 5–6k 份）串流讀 `shapes.txt`，其他 shape_id 一律丟棄。**必須用 `array("d")` 存平坦座標序列**（每 shape 一個 `array('d')`，`[lat0, lon0, lat1, lon1, ...]`），不要用 tuple list：實測約 600 萬點，tuple list 約 430 MB，`array('d')` 約 96 MB。`_fits()` 需能吃這兩種表示（TDX 的是 `[(lat, lon), ...]`）— 在 `ShapeAssigner` 內統一轉成 flat 序列處理。

`shapes.txt` 未壓縮約 213 MB，這趟串流約 60–90 s；相對於整體 build（~50 min）可接受。

其餘寫出階段（約 1220-1237 的 shapes.txt 串流複製 + 追加 `new_shapes`）邏輯不變。

---

## 4. 明確不要做的事

1. **不要調高 `maxStopToShapeSnapDistance`。** 偏離量有 421 個 pattern 落在 1–10 km、82 個 >10 km；放寬只會讓 OTP 把站硬吸到錯的線上，畫出「路線正確但走錯路」的假幾何，比直線更糟。`build-config.json` 不在本次變更範圍。
2. **不要動 `CITIES` 名單。** `patch_gtfs_zip` 會先刪光全部公車再依 CITIES 重建，縮短名單等於靜默刪縣市。
3. **不要動非公車（route_type != 3）路徑**：TRA / THSR / 捷運的 preserve 邏輯與 `inject-*.py` 完全不碰。
4. **不要處理 FERRY / AIRPLANE / 合成捷運線的直線問題**（渡輪 36/36、航空 64/64、SUBWAY 95/191）。那是另外兩個議題（transit 模式洩漏、MaaS 合成班表無 shape），不在此範圍。
5. **不要改 OTP 端或 `src/modules/accessible-route/**`。** 後端只是照抄 OTP 的 `legGeometry`，沒有 bug。

---

## 5. 新增 stats 與 summary 輸出（R7）

`stats` 初始化（`patch_gtfs.py:1145` 與測試的 `_full_stats()` / `_base_stats()`）補上：

```
route_match_subroute_exact, route_match_route_exact, route_match_prefix,
route_match_prefix_ambiguous, route_match_name, route_unmatched,
shape_from_subroute, shape_from_route_uid, shape_from_reversed,
shape_from_static, shape_rejected_unfit
```

summary 增印兩行：

```
Route matching: {subroute_exact} subroute-exact, {route_exact} route-exact,
  {prefix} prefix ({prefix_ambiguous} ambiguous), {name} by name, {unmatched} unmatched.
Shape assignment: {from_subroute} subroute TDX, {from_route_uid} route TDX,
  {from_reversed} reversed, {from_static} inherited static,
  {rejected_unfit} rejected as unfit, {missing_shape} with no candidate.
```

修復成功的判讀依據：`route_match_prefix` 應從主要路徑退成少數，`route_match_subroute_exact` 成為多數；`shape_rejected_unfit` 應為小數量（幾十而非上千）。

---

## 6. 測試要求（`src/scripts/test_patch_gtfs.py`）

沿用現有風格：`unittest`、無網路、`build_travel_profile` 以 `_FIXED_PROFILE` mock。新增類別與案例：

### `RouteMatchingPrecedenceTests`（R1/R2）

1. `test_subroute_exact_wins_over_route_uid_prefix` — **61B 迴歸案**。`route_ids_set = {"HSQ008101_0", "HSQ0081A1_0", "HSQ0081B1_0"}`，餵一筆 `RouteUID="HSQ0081"`、`SubRouteUID="HSQ008101"`、`Direction=0` 的班表；斷言產出的 trip `route_id == "HSQ008101_0"`，且**沒有任何** trip 落在 `HSQ0081B1_0`。
2. `test_route_uid_exact_used_when_no_subroute_route_id` — routes 只有 `HSQ0081_0` 時，仍照 RouteUID 精準命中。
3. `test_prefix_match_is_deterministic_and_flagged` — 只能靠前綴時，重複跑（或打亂 `route_ids_set` 插入順序）結果一致，且 `route_match_prefix_ambiguous == 1`。
4. `test_unmatched_route_counted` — 無任何可比對 → `route_unmatched == 1`、不產 trip。

### `ShapeIndexTests`（R3）

5. `test_subroute_key_is_primary_and_route_uid_is_first_wins` — 兩筆同 `(RouteUID, Direction)` 不同 `SubRouteUID` 的 shape record，斷言兩個子路線鍵都存在且各自正確，RouteUID 鍵等於**第一筆**。

### `ShapeFitTests`（R4/R5/R6）

6. `test_unfit_shape_is_rejected_and_not_emitted` — 站序離候選 shape 約 300 m：`shape_id == ""`、`shape_rejected_unfit == 1`、`new_shapes` 不含該 shape。
7. `test_subroute_shape_preferred_over_inherited_static` — 同時有貼合的子路線 TDX shape 與不貼合的靜態繼承 shape，斷言採用前者，shape_id 為 `patched_shp_{sub}_{dir}`，`shape_from_subroute == 1`。
8. `test_reversed_opposite_direction_shape_gets_distinct_id` — 只有反向 shape 且反轉後貼合，斷言 id 以 `r` 結尾、`shape_from_reversed == 1`。
9. `test_missing_stop_coords_does_not_reject` — `stop_coords` 為空 → shape 照樣採用（保護 fixture feed 與缺座標的邊界情形）。
10. `test_fit_uses_segment_distance_not_vertex_distance` — 兩個頂點相距 2 km 的長線段，站點落在線段中點旁 20 m：必須通過（若誤用點到頂點距離會失敗）。
11. `test_inherited_static_shape_used_when_fit` — 只有靜態繼承 shape（`route_shape_by_route` + `static_shape_points`）且貼合：斷言採用**原始 shape_id**（不是 `patched_shp_*`）、`new_shapes` 不含該 id、`shape_from_static == 1`。這是唯一會真正命中候選 4 的案例（案例 7 只走「靜態不合格 → 退到 subroute」路徑，永遠碰不到 `shape_from_static`）。
12. `test_route_uid_tdx_shape_used_when_no_subroute_shape` — TDX 只有 `(route_uid, direction)` 沒有子路線鍵且貼合：斷言 `shape_from_route_uid == 1`、shape_id 為 `patched_shp_{route_uid}_{dir}`。

### `MatchAndShapeCountersTests`（R7）

13. `test_all_new_counters_are_populated` — 用一組涵蓋四種比對路徑的班表（subroute 精準 / RouteUID 精準 / 前綴 / 名稱）跑一次 `process_schedule_records_to_gtfs`，逐一斷言 `route_match_subroute_exact`、`route_match_route_exact`、`route_match_prefix`、`route_match_name` 各為預期值。
    **理由**：§8 的人工驗收是「先看 summary 兩行判斷比對與 shape 指派是否轉正」。若計數器本身加錯分支，測試全綠但 summary 會騙人，整個驗收基礎就失效 — 所以這 11 個鍵每一個都必須至少被一條測試斷言過（對照表：`route_match_prefix_ambiguous`→案例3、`route_unmatched`→案例4、`shape_from_subroute`→案例7、`shape_from_route_uid`→案例12、`shape_from_reversed`→案例8、`shape_from_static`→案例11、`shape_rejected_unfit`→案例6、其餘四個→案例13）。

### 既有測試調整

- `_full_stats()` / `GtfsOutputTests._base_stats()` 補齊新鍵。
- `test_patch_gtfs.py:446, 467, 532, 638` 四處 `process_schedule_records_to_gtfs` 位置引數改為傳 `ShapeAssigner`。
- `FrequencyZipEmissionTests._write_fixture_zip` 建議加 `stops.txt`（含 `S1`/`MS1` 座標），順帶覆蓋 `patch_gtfs_zip` 讀 stops.txt 的新分支；但**必須另留一個沒有 stops.txt 的案例**確認不會爆（R5）。

---

## 7. 驗收（Codex 端）

```bash
python3 src/scripts/test_patch_gtfs.py          # 全綠，含上述 13 個新案例
python3 -m py_compile src/scripts/patch_gtfs.py
```

不得有網路呼叫、不得需要 TDX 憑證、不得需要 Docker。

「全綠」不是唯一標準，還要滿足：**§5 列出的 11 個新 stats 鍵，每一個都至少被一條測試斷言過**（對照表見 §6 案例 13）。理由：§8 的人工驗收依賴 summary 那兩行數字，沒被測試鎖住的計數器可能本來就加錯分支，會讓驗收看到假的「已轉正」。

註解風格遵守專案慣例：只在函式寫 JSDoc/docstring（`@param`/`@returns` 語意），不要行內註解、不要 Phase/Step 字樣。

---

## 8. 後續（人工執行，不在 Codex 範圍）

1. 重建 feed + graph：根目錄載 `.env` 跑 `src/scripts/build-otp-graph.sh`（~50 min，舊圖不斷線）。先看 patch 日誌的兩行新 summary 判斷比對與 shape 指派是否已轉正。
2. 線上驗收查詢：

```bash
# 目標：BUS 中 geomPts <= stops 的比例由 14.5% 降到 <1%
curl -s -X POST http://127.0.0.1:18080/otp/routers/default/index/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ patterns { geometry{lat} stops{gtfsId} route{mode} } }"}'

# 61B 定點檢查：三個 pattern 都應該 geomPts >> stops
curl -s -X POST http://127.0.0.1:18080/otp/routers/default/index/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ routes(name:\"61B\"){ gtfsId patterns { code geometry{lat} stops{gtfsId} } } }"}'
```

3. 順帶確認 61 主線班次已回到 `HSQ008101_0`（路線號碼正確性，不只幾何）。
4. 後端重啟需 `docker compose up -d --build backend`（程式碼編進 image，單純重啟無效）— 本次若只改 python 腳本則不需要。

---

## 9. 風險與回退

| 風險                                          | 說明                                                                         | 處置                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 比對順序改動使某些城市班次改掛到別的 route_id | 這正是修復目的，但會改變 11k 個 trip 的歸屬                                  | 靠 summary 統計與 61B 定點檢查驗證；`route_match_prefix_ambiguous` 若異常高需回報 |
| `shape_rejected_unfit` 異常高（>2000）        | 表示驗證過嚴或投影/解析有 bug                                                | 先別放寬 tolerance，改抽樣三條路線人工核對距離計算                                |
| 記憶體上升                                    | 新增 stop_coords（~30 MB）+ static_shape_points（~96 MB，須用 `array('d')`） | 若 OOM，先確認沒有誤用 tuple list                                                 |
| build 時間上升                                | 多一趟 shapes.txt 串流（60–90 s）                                            | 可接受                                                                            |
| 回退                                          | 全部改動集中在兩個 python 檔                                                 | `git revert` 該 commit，重建 graph 即回舊行為                                     |
