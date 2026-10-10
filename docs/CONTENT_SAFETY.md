# 內容檢舉、確認信與封鎖

三端共用此契約；沒有管理網頁。App／Web 檢舉自建評論或障礙回報，後端保存案件，分別排程團隊通知與使用者受理確認信。`queued` 是待寄／曾排程；`accepted` 只代表 Resend 接受，並非 Gmail 收件證明。

## 環境設定

在部署環境 `.env`／秘密管理服務設定（不要放前端）：

```dotenv
CONTENT_REPORT_TEAM_EMAIL=nutcaiedlab@gmail.com
RESEND_FROM=你的已驗證寄件網域地址
RESEND_API_KEY=由既有秘密管理服務提供
```

收件地址沒有程式預設值。缺少或無效的團隊地址只延後團隊通知，使用者信件獨立執行；缺少寄件設定保留案件與工作，背景重試。此變更只更新 `.env.example`，不讀取／覆寫實際 `.env`。

沿用 server 啟動時的 MongoDB 連線啟動 worker、shutdown 等待正在執行工作。部署須建立 ContentReport 複合唯一索引與 purgeAt TTL、UserBlock 唯一索引、ContentSafetyQuota TTL；模型初始化不能被跳過。本功能支援 standalone MongoDB，不使用多文件交易，也不要求變更既有資料庫拓樸。新增欄位均可相容既有資料，不需資料遷移。

## 公開 API

API 路徑前綴 `/api/v1`，沿用 `{ok,status,code,message,data}`。下列寫入／私人名單需登入；未登入／失效 session 403、過期 token 401。無權查看內容回 404。其他原因放在 `data.reason`。

| Method / path | Request | Response data |
| --- | --- | --- |
| POST /content-reports | `{targetType,targetId,reason,details?,language?}` | `{caseNumber,receivedAt,confirmationEmail,duplicate}` |
| GET /user/blocks | 無 | `{items:[{blockId,label,createdAt}]}` |
| PUT /user/blocks | `{targetType,targetId}` | `null`；重複封鎖不建立第二筆 |
| DELETE /user/blocks/:id | `id` 為 blockId | `null`；不存在也成功，不影響別人的封鎖 |
| GET /a11y/reports/safety | lat/lng/radius/limit，沿用附近查詢驗證 | `{reports,total}`；只包含有效 verified 的 id/type/severity/location/status/expiry |

`targetType`: `review` / `hazard_report`。`reason`: `inappropriate_image` / `harassment` / `personal_information` / `spam` / `misinformation` / `other`。`details` trim 後最多 1000 字，other 必填；language 為 zh-TW / en。schema 拒絕自行指定作者、收件人、檢舉者或其他未知欄位。

`confirmationEmail` 為 queued / unavailable（信箱未驗證）。案件與兩個角色的寄信工作單文件原子保存，配額確認後才回成功並允許寄送。後端從登入帳號讀取信箱，寄送前再查帳號存在、emailVerified、信箱仍相同；不符合取消使用者寄送。

同一檢舉者／目標／內容版本以唯一索引去重並回原案件；評論修改、障礙原始內容改變可以再次提交。每帳號每小時最多 20 個新案件，由 MongoDB 單文件配額預留跨 process 限制；預留成功但等待恢復的案件也占額度，不因不確定寫入結果而退額。另有 process 的帳號／IP HTTP 限流。網路重送先查原案件，不重複排程。使用者登出再登入其他帳號不合併案件。

封鎖名單 `label` 是 `review` / `hazard_report` 的中性來源標記，由前端翻譯，並非姓名或 email。解除只用不透明 blockId，不向外暴露障礙作者 ID。匿名／已刪除作者不可封鎖；自己內容不可檢舉／封鎖。

## 顯示與處分的差異

| 讀取路徑 | 個人封鎖 | 平台下架 |
| --- | --- | --- |
| 登入評論列表、平均分數、AI 摘要 | 排除封鎖作者 | 排除下架內容 |
| 登入附近障礙列表、公開詳情 | 排除封鎖作者 | 排除下架內容 |
| 匿名公開內容 | 不適用個人偏好 | 排除下架內容 |
| 導航安全事實、路線障礙證據 | 不移除路況風險；安全事實不含 UGC 原文 | 排除下架內容 |
| 本人回報歷史、管理者證據 | 保留既有授權 | 本人可辨識 moderationHiddenAt，供追溯；不是重新公開 |
| 私人照片 | 保持既有 owner/admin 授權 | 保持既有授權，不透過郵件提供公開儲存網址 |

限制帳號阻止該帳號新增／修改評論與提交障礙回報，仍可導航、刪除自己的評論、檢舉及管理帳號。原先匿名障礙回報契約保留；限制帳號不等於裝置／IP 禁用，不能阻止換帳號或匿名濫用，需配合既有上傳限流與人工審核。

## 團隊處理（無管理網頁）

1. 團隊從 Gmail 主旨取得案件編號；授權人員用既有一般登入取得 Bearer access token，後端每次從 DB 驗證角色。
2. `GET /content-reports/:id` 取得必要文字快照、原因與寄信狀態；不含檢舉者 email、原始照片或 storage URL。
3. `GET /content-reports?cursor=...` 管理者分頁查看案件及寄信狀態，每頁 50 筆；未收信時也可檢查 pending / manual_review。
4. `POST /content-reports/:id/decision` body 如下，requestId 每個處理動作新建 UUID，重送同一動作沿用相同 UUID。

```json
{"requestId":"f4762994-9164-411b-a607-0a261b491206","action":"hide","note":"人工確認內容含有他人個資"}
```

action: dismiss / hide / restore / restrict_author / unrestrict_author。hide/restore 僅改 moderationHiddenAt，不改原有刪除、到期與審核狀態；restore 不會復活刪除評論或過期障礙。處分先將 requestId、操作人／理由／時間、觀察到的目標版本與 pending 狀態原子存入案件，再以目標單文件 CAS 一起更新效果、版本與恢復記號，最後補寫 applied 稽核並清理記號。相同 UUID 但不同 action/note 回 400 CONFLICT；目標版本已改變則記錄 superseded、回 400 SUPERSEDED，需重新查看後用新 UUID 提出決定，不能盲目重放舊處分。暫時失敗回 503 PENDING，沿用原 UUID 重試或等待背景恢復；200 才代表處理完成。無權限回 403。

信件不含「一鍵下架」連結，避免郵件掃描器或轉寄誤觸。圖片審查仍透過既有受權限保護的 `/a11y/reports/:id/photo`；不能憑案件編號授權公開圖片。

## 寄信失敗與資料期限

- 每個角色獨立 lease/CAS，120 秒 lease 大於寄信請求 10 秒 timeout。已接受的角色不再重寄。
- 首次發送前凍結完整 from/to/subject/text/html，重試使用相同 payload 與 Resend idempotency key。
- 供應商去重 24 小時；第一次嘗試超過 23 小時仍未確認接受時標記 manual_review，停止自動重寄。由值班人員查 Resend 記錄，確認是否已接受後人工處理，不能盲目重置工作或宣稱 exactly-once。
- 尚未結案的案件最多保存 365 天；結案後最多 90 天，且不超過建立起 365 天，之後 TTL 刪除快照、email、寄送 payload 與稽核紀錄。worker 與案件讀取會主動檢查 purgeAt，不等待 TTL 實際掃描。
- 既有帳號刪除／殘留 sweep 清除該帳號提出或被檢舉的案件與雙向相關封鎖；已刪帳號不再寄信。短期寄信配額在兩小時內 TTL 到期。
- Gmail／Resend 中的副本不是 MongoDB TTL 的範圍，團隊須設定相同或更短的郵件保存期限、刪除請求處理流程與值班處理時限。上線前應同步現有隱私政策中的內容檢舉用途／郵件處理者與保存期限。

## 上線驗收

先部署後端，再上 Web／App。確認索引、環境設定、寄件網域；用隔離測試帳號實際驗證團隊信箱與使用者信箱各收一封、不同角色獨立失敗重試、未驗證信箱提示、封鎖與解除跨端一致、處分後公開／安全資料一致。此次開發測試以假 outbound email 驗證，未代替真實 Gmail 收件或正式部署驗收。


## Standalone 恢復協定

### 案件與配額

1. 唯一索引合併同一內容版本的重送；第一次寫入即保存案件與兩封獨立工作，`admission.state=pending`。worker 的 claim 與 CAS 都排除 pending／rejected 案件；既有未含 admission 的案件視為已受理。
2. 每帳號／小時的 quota 文件以單次條件更新，將 caseId 加入最多 20 筆的 caseIds 並增加 count。重送和背景恢復先查同一 caseId，不重扣；舊 quota 只有 count 時保守保留原數值，不重設額度。
3. 以案件 admission 的原 hour＋pending 作 CAS，補寫 admitted 或 rejected 與歷史證據。任何階段遇到程序中止或回應遺失，都能由原案件恢復。成功前 API 回 503 REPORT_RETRY_REQUIRED，重送相同內容即可找回；即使客戶端收到暫時錯誤，已持久化工作仍可能在背景完成，不能當成必然未受理。
4. 額滿回 429，保留 rejected 證據、不寄信；下個小時使用者可重試同一案件。過了 quota 的兩小時保存窗口，舊 pending 改為 RESERVATION_EXPIRED，不重建已過期預留。只讓使用者新一輪提交開新 hour。
5. pending／rejected 案件從最初建立起最多保留 7 天；admitted 依原案件 365 天／結案90天規則。history 最多 96 筆（48次嘗試），達上限保留證據並回503，交人工查看；不任意截掉稽核。預留與狀態證據都留在案件，短期 quota TTL 不是唯一紀錄。

### 處分與恢復記號

- 管理者權限在接受每個新指令時查最新 DB role；已持久化受理的指令會完成，之後撤銷管理者權限會擋新指令，不會讓執行中的指令和取消互相競爭。此機制不提供撤銷已受理指令的功能；反向處分必須是另一筆新指令。
- 原案件的 pending 意圖在任何效果之前持久化。目標版本改變時，舊命令不能覆寫新狀態。兩個不同指令同時基於同一版本，只有一個能套用，另一個明確標記 superseded。
- 目標恢復記號只含 caseId／request key／時間，不含原因、操作人、email 或內容，且 `select:false` 不進公開 DTO。效果已套用但稽核補寫失敗時，可依記號補齊 applied，即使之後已經完成反向處分也不重改目標。
- 每案件最多200筆指令，額满拒絕建立新的指令並回503 CAPACITY；目標最多100筆未清除記號，額滿則保留已受理的pending指令並回503 PENDING。不刪除必要證據。先完成稽核，再清記號；清理失敗由 receiptCleanupPending 恢復。再次處理目標時會回收已結束、已刪除或到期案件的殘留記號，版本數字不重置。
- 不再承諾跨文件立即一致：查詢可能短暫看到效果已套用但案件仍 pending。200 僅於完成狀態返回；管理查詢顯示 admission、pendingDecisions、每個決定的 state／reason／attempts／nextAttemptAt。
- 背景 worker 每次最多處理20個待恢復案件，持久化30秒重試間隔，重啟會接續。配額／處分恢復和寄信分開執行，個別失敗不阻止另一部分；日誌不輸出內容、email 或供應商秘密。

### 驗證邊界

新增測試以 MongoMemoryServer 的 standalone 模式執行並檢查 `hello.setName` 不存在，涵蓋正常提交、並行去重／額度上限、配額ACK遺失、配額完成後案件寫入失敗、跨小時與到期、處分ACK遺失、稽核補寫失敗後反向處分、版本競爭、記號清理失敗與過期案件。真實 Gmail 收件的先前結果另見 `CONTENT_SAFETY_VERIFICATION.md`；這次程式調整尚未部署到現有容器。
