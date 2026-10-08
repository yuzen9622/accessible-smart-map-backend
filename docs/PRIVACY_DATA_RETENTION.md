# 隱私資料保存期限：執行方式

本文件說明後端如何落實隱私政策的資料保存表，以及哪些項目程式碼管不到、必須由基礎設施或供應商揭露處理。

## 政策與執行對照

| 資料 | 政策 | 執行方式 | 位置 |
|---|---|---|---|
| 帳號、偏好、聯絡人 | 驗證刪除申請後 30 日內清除 | 刪除帳號時即時硬刪；另登記 `DeletedAccount`，補掃刪除帳號刪除後才寫入的資料（併發請求） | `user.account.service.ts`、`user.account.retention.ts` |
| 一般導航位置 | 即時處理，不保存軌跡 | route token 存 Redis 30 分鐘 TTL；voice 不落地；access log 只記路由樣板（不含 query、path 參數） | `navigation-state.repository.ts`、`middleware/access-log.middleware.ts` |
| SOS 位置與事件 | 解除後 30 日內刪除 | 解除滿期限即刪整筆 session；位置超過 24 小時未更新的 active SOS 由系統自動解除並通知聯絡人（失敗會重送） | `sos.retention.ts` |
| 聯絡人 LINE 分享位置 | 視同 SOS 位置，30 日 | `lastLineLat/Lng` 超過期限未更新即清空 | `line.retention.ts` |
| 原始語音 | 本系統不持久保存 | 不寫入任何儲存 | `modules/voice` |
| AI 對話 | 伺服器歷史 ≤ 30 日 | HTTP `/ai/chat` 不存歷史；LINE 對話在 Redis 保存 30 分鐘 | `line-memory.ts` |
| AI 長期記憶 | 使用者可刪除；12 個月未使用清除 | 刪除即移除內容與分類等中繼資料（只留 `_id`/`userId`/`embeddingId`/時間的 tombstone 供向量補掃，最多 30 天）；`max(lastUsedAt, updatedAt)` 超過期限或 `expiresAt` 已過即刪；逐使用者比對 Chroma 清除孤兒向量 | `memory.retention.ts` |
| 回報照片與可識別內容 | 過期或結案後 90 日內清除 | 階段 A：移除回報者／投票者／審核者身分、描述、EXIF 原始值、AI 理由與標籤；階段 B：刪除 GCS 照片與 URL。保留類型、位置、嚴重度、狀態、票數、時間供統計 | `hazard-report.retention.ts` |
| 一般維運紀錄 | ≤ 30 日 | **基礎設施設定**（見下） | — |
| 必要資安紀錄、備份 | ≤ 90 日 | **基礎設施設定**（見下） | — |

## 期限保證

- 每類資料在「政策期限 − 安全緩衝（預設 1 天）」時就會被處理，掃描間隔（預設 1 小時，上限 6 小時）必須 ≤ 緩衝的一半，所以漏跑一次仍在期限內。
- 每次執行以批次輪流處理各類別，預算用完會在數秒後續跑，直到積壓清空。
- 已超過政策期限仍未處理的資料會以 `[retention] data past policy deadline` warning 記錄，可作為告警依據。
- 設定只能縮短期限；不合法的設定會讓服務啟動失敗。
- **限制**：retention job 在 MongoDB 連線成功後才啟動。若啟動時連不上 MongoDB，HTTP 仍會繼續服務（既有啟動行為）但 retention 不會執行，需以「一段時間沒有 `[retention] run` log」或部署健康檢查監控。

## 使用者可見的變化

- 忘記解除的 SOS 會在位置 24 小時沒更新後自動結束，聯絡人收到「SOS 已結束」通知，timeline 記為系統解除。
- 危害回報過期或被拒絕滿 90 天後：照片消失（`photoUrl` 不再出現）、描述移除，且不再出現在回報者的「我的回報」；對它投票或審核會回 410。
- 管理員把被拒絕的回報重新核定為 verified 時，以「被拒絕」起算的計時取消、下次結案重新起算；但回報原本的有效期（`expiredAt`）一過，仍以它起算 90 天。
- 刪除的 AI 記憶內容立即從資料庫移除。

## 操作

```bash
pnpm retention:run --dry-run      # 只計算各類別待處理數量
pnpm retention:run                # 立即執行一次（任一類別失敗時 exit code 非 0）
pnpm retention:fix-photo-cache    # 把既有回報照片的 Cache-Control 改為目前設定
```

環境變數見 `.env.example` 的「隱私資料保存」區塊與 `src/config/retention.ts`。

## 程式碼無法保證、需另行處理的項目

宣稱符合政策之前，下列項目必須完成設定，這是驗收門檻，不是選配：

1. **維運 log 保存 30 日**：部署平台（Cloud Logging bucket retention 或 Docker log driver／log 收集器）設定 30 天。Docker `json-file` 只能依大小輪替，無法保證天數。
2. **資安紀錄與備份 90 日**：MongoDB、Redis 備份與資安紀錄的保存期設為 ≤ 90 天；個別依法保全另行處理。
3. **GCS 後備規則**：在 bucket 的 `reports/` prefix 設 lifecycle rule 作為後備（例如 120 天刪除），防止 retention job 長期停擺時照片永久留存。
4. **既有照片快取**：本修改之前上傳的照片帶 1 年 `max-age`。執行 `pnpm retention:fix-photo-cache` 只能更新物件本身，**已被瀏覽器或中介快取存下的副本無法遠端撤回**，最長可能留存至原 max-age 到期。新上傳照片的快取為 1 小時。

## 供應商保存（需於隱私政策揭露）

- **Gemini Interactions API**：AI agent 以 `previous_interaction_id` 串接多輪工具呼叫，代表 interaction 會保存在 Google 端，保存期依 Google 條款。
- **Gemini Live（語音）**：原始音訊送往 Google，供應商端保存依其條款。
- **LINE Messaging API**：通知內容經 LINE 傳遞。
- **Google Places／Geocoding**：查詢座標與關鍵字送往 Google。
