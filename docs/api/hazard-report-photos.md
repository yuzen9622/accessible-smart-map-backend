# 路況回報照片：公開與私人存取

## 契約

- **公開**：`GET /api/v1/a11y/reports/{id}/photo/public`，免登入。回報必須 `status=verified`、`expiredAt` 尚未到期、照片存在且未被下架／清除／去識別化。v2 AI 必須 `state=completed` 且 `decision=supported`；人工 `manualReview.decision=verified` 也可核可。人工拒絕或已知 SafeSearch 阻擋的照片不公開。legacy 需 AI verdict=verified 或人工核可，只有社群票數升為 verified 不公開照片。
- **私人**：保留 `GET /api/v1/a11y/reports/{id}/photo`，需有效 `Authorization: Bearer <accessToken>`，僅回報者／管理員可看。過期、拒絕或下架後仍可私人查看，至現有 retention 清除為止，不延長保存期限。
- **儲存**：由後端讀取配置 bucket 中該回報的 canonical key，GCS 不需改成公開。兩個入口共用影像正規化（去 metadata、轉 JPEG），不暴露 storage key／URL、不簽公開儲存連結、不 redirect。
- **撤下**：I/O 前與解碼後再次確認資格及 key；公開入口直接比較到期時間，不依賴 expiry job 先更新 status。兩個入口皆 no-store、nosniff；成功 JPEG 回應沒有 ETag／304，JSON 錯誤仍走既有 envelope（可能含 ETag，但禁止快取）。第二次資格查核之後已送出的 bytes／下載副本無法遠端撤回。
- **資源界線**：公開／私人讀取共用 process-wide 容量，整個 DB／下載／解碼最多同時 2 件，最多等待 8 件（等待期間不讀 DB／GCS、不持有照片 bytes），佇列等待最多 10 秒。容量滿、等待逾時或資源暫不可用回 503；取消與所有成功／失敗路徑會釋放資源。不依賴 Redis 限流成功才有此上限。
- AI「照片支持回報」不代表現地已獨立核實，也不代表畫面中的人臉／車牌已遮罩。現有影像處理移除 metadata，不新增人臉／車牌遮罩。

| HTTP | 公開照片 | 私人照片 |
| --- | --- | --- |
| 200 | JPEG bytes（不是 JSON） | JPEG bytes（不是 JSON） |
| 400 | ID 不是 24 位十六進位字串 | 同左（先通過登入） |
| 401 | 不需要登入，不回此碼 | 未登入／token 過期 |
| 403 | 不驗證附帶 token，不回此碼 | token 無效 |
| 404 | 不存在、沒有照片、不符合公開資格、讀取中被撤下；`PHOTO_NOT_FOUND` | 非本人／管理員、不存在、已清除；`PHOTO_NOT_FOUND` |
| 429 | 與 nearby 共用 30/min 配額 | 同左（先通過登入） |
| 503 | 容量滿／等待逾時／DB／儲存／解碼不可用；`PHOTO_UNAVAILABLE` | 同左 |

錯誤回傳既有 JSON envelope。公開入口不因帶有 owner/admin token 就退回私人存取；想看私人照片必須明確用私人入口。

## 回報 DTO

所有既有完整回報 DTO（建立、合併、附近、單筆、本人、審核）新增：

```ts
interface ReportPhotoFields {
  hasPhoto: boolean;
  publicPhotoUrl: string | null;
}
```

- `hasPhoto` 仍是照片是否保留，**不是一般訪客的讀取權限**。
- `publicPhotoUrl` 為同源相對路徑，例如 `/api/v1/a11y/reports/6670abc123def4567890abcd/photo/public`。不符合公開條件一律 `null`，即使本人／管理員 DTO 也一樣；不含私人儲存資訊。
- URL 是 DTO 產生當下的提示，不是永久授權；回傳之後過期／下架仍會 404。
- `/reports/safety` 的無圖片事實投影維持不變。

## 前端修改

1. 回報型別新增 `publicPhotoUrl: string | null`。分批部署時可暫時容忍欄位缺少，但不可退回猜私人 URL。
2. 一般地圖、公開詳情、別人的回報只在 `publicPhotoUrl` 有值時顯示圖片，不再用 `hasPhoto` 組 `/photo`。同源可以直接 `<img src={report.publicPhotoUrl} ... />`；跨源前端則將相對路徑解析至 **後端 origin**（不是把已有 `/api/v1` 再加一次）。
3. 「我的回報」／管理員審核可沿用私人 `/photo`，以帶 Bearer token 的 fetch 取 blob，轉 `URL.createObjectURL()` 顯示；切換照片／元件卸載時 `URL.revokeObjectURL()`。`img` 本身不會自動帶上程式管理的 Bearer token；不要把 access token 放進 query string。
4. `publicPhotoUrl=null` 或圖片載入失敗時顯示合適的無圖片／待審核／已過期狀態，不要無限重試，不要偷偷嘗試私人入口。404 不存在與不公開故意不可區分；依回報 DTO 呈現可知的狀態。
5. AI 狀態更新後重新讀取 DTO，讓 null 變為公開 URL。過期時清掉已顯示圖片並刷新回報；no-store 不會主動刪除已在 DOM／blob／App image cache 的圖。不要把照片或其錯誤持久存入 Service Worker／離線快取。
6. 私人入口 401 走原有登入／refresh 流程；公開照片不需因 404 要求使用者登入。503 可有限次重試、429 遵守 Retry-After。

## 驗證與部署

- `hazard-report.photo-access.test.ts`：真實 router/service/decoder，隔離 DB／GCS／session I/O，含匿名公開、私人權限、撤下與到期競態。
- `hazard-report.visibility.integration.test.ts`：隔離 real MongoDB，確認公開與本人投影保留資格欄位、URL/null 與內部欄位不洩漏。
- `hazard-report.photo-contract.test.ts`：產生 OpenAPI 及序列化 DTO 的 schema 契約。
- 後端先部署，再更新前端；沒有資料 migration／bucket ACL 變更。正式 bucket 若曾被設定成公開，必須另外查核 IAM/ACL；本次程式修改無法證明或撤銷既有外部公開存取。
