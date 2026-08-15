/**
 * Centralized user-facing message strings — clean-architecture invariant #5
 * (no magic literals). Only messages that repeat across call sites live here;
 * one-off per-endpoint messages stay inline where they are used.
 *
 * HTTP status codes are deliberately NOT duplicated here: they already live in
 * the `ResponseCode` enum (`src/types/code.ts`), which doubles as the HTTP
 * status and the response envelope's `code`. Pass `ResponseCode.*` to
 * `sendResponse`.
 */

export const MSG = {
  OK: "OK",
} as const;

/**
 * Shared user-facing strings for the transit (bus) endpoints. `INVALID_CITY` is
 * emitted from `resolveCityOr400`, which backs four handlers, so it is
 * centralized rather than inlined.
 */
export const TRANSIT_MSG = {
  INVALID_PLATE: "無效的車牌號碼",
  INVALID_CITY: "請提供有效的縣市 (city)，例如 台北、台中",
} as const;

export const ERROR_MESSAGE = {
  INTERNAL: "Internal Server Error",
  BAD_REQUEST: "請求格式錯誤",
  MISSING_PARAMS: "缺少必要參數",
  INTENT_PARSE_FAILED:
    "無法解析您的查詢，請改用『從 A 到 B』的描述或直接提供 origin/destination",
} as const;

export const ROUTE_WARNING = {
  OTP_WALK_FALLBACK:
    "OTP 步行規劃暫時不可用，已降級使用 Valhalla 步行路線，指引品質可能不同",
  STAIRS_CONSTRAINT_UNSATISFIED:
    "目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件",
  NO_ACCESSIBLE_TOILET_NEARBY:
    "目的地附近查無登記的無障礙廁所資料，不代表確定沒有，建議到場前先自行確認",
  STAIRS_HANDRAIL_UNKNOWN:
    "路線包含樓梯段落，OSM 資料未確認此處是否有扶手，請自行確認",
  SLOPE_LIMIT_NOT_ENFORCED_NO_ELEVATION:
    "開車/機車路線引擎目前無地形高程資料，無法依坡度篩選路徑，您設定的坡度上限未被實際執行",
  SLOPE_LIMIT_STRICTER_THAN_SERVER_DEFAULT:
    "大眾運輸/步行路線引擎目前固定以 8.3% 作為輪椅模式上限，無法套用您要求的更嚴格數值；且受限於 OSM 坡度標記稀疏，實際執行範圍有限",
  HAZARD_ON_ROUTE:
    "此路線經過社群已確認的路況障礙（hazardAdvisory.onRoute），請留意或改採其他候選路線",
  HAZARD_ALL_ROUTES_BLOCKED:
    "所有候選路線都經過社群已確認的路況障礙，已為您保留受影響最小的路線，出發前請務必確認現場狀況",
} as const;

/**
 * Stable domain reason codes for accessible-route failures. These stay in
 * `data.reason`; the envelope `code` remains the HTTP status.
 */
export const ROUTE_REASON = {
  OUT_OF_RANGE: "OUT_OF_RANGE",
  OUT_OF_COVERAGE: "OUT_OF_COVERAGE",
  NO_ACCESSIBLE_ROUTE: "NO_ACCESSIBLE_ROUTE",
  NO_ROUTE: "NO_ROUTE",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
} as const;

export const ROUTE_MSG = {
  OUT_OF_RANGE: "起點與終點距離過遠",
  OUT_OF_COVERAGE: "本服務目前涵蓋台灣",
  NO_ACCESSIBLE_ROUTE: "找不到符合無障礙需求的路線",
  NO_ROUTE: "找不到可行路線",
  UPSTREAM_TIMEOUT: "路線規劃服務逾時，請稍後再試",
} as const satisfies Record<keyof typeof ROUTE_REASON, string>;

export const MEMORY_MSG = {
  CREATED: "記憶已建立",
  UPDATED: "記憶已更新",
  DELETED: "記憶已刪除",
  CLEARED: "記憶已清空",
  LIST_OK: "取得記憶列表成功",
  SETTINGS_OK: "取得記憶設定成功",
  SETTINGS_UPDATED: "記憶設定已更新",
  NOT_FOUND: "找不到該筆記憶或無權存取",
  DISABLED: "記憶功能尚未開啟",
} as const;

/**
 * User-facing messages for the pre-trip environment aggregation endpoint. The
 * partial message is built from the number of sources that came back unavailable.
 */
export const ENV_MSG = {
  OK: "環境資訊查詢成功",
  partial: (unavailableCount: number): string =>
    `環境資訊部分查詢成功（${unavailableCount} 項來源不可用）`,
} as const;

/**
 * Domain reason codes for the hazard-report feature. These ride in
 * `data.reason` of the response envelope (the envelope `code` stays the HTTP
 * status from `ResponseCode`). Referenced by both the service and the OpenAPI
 * schema, so they are centralized here to avoid magic literals.
 */
export const HAZARD_REASON = {
  EXIF_TOO_OLD: "EXIF_TOO_OLD",
  EXIF_GPS_MISMATCH: "EXIF_GPS_MISMATCH",
  PHOTO_REQUIRED: "PHOTO_REQUIRED",
  PHOTO_TOO_LARGE: "PHOTO_TOO_LARGE",
  INVALID_PHOTO_TYPE: "INVALID_PHOTO_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  UPLOAD_FAILED: "UPLOAD_FAILED",
  INVALID_ID: "INVALID_ID",
  REPORT_NOT_FOUND: "REPORT_NOT_FOUND",
  ALREADY_VOTED: "ALREADY_VOTED",
  SELF_CONFIRMATION: "SELF_CONFIRMATION",
  REPORT_EXPIRED: "REPORT_EXPIRED",
} as const;

export const CAMPUS_MSG = {
  NOT_FOUND: "查無此校區",
} as const;

export const REVIEW_MSG = {
  CREATED: "評價已建立",
  UPDATED: "評價已更新",
  DELETED: "評價已刪除",
  NOT_FOUND: "找不到此評價",
  ALREADY_REVIEWED: "您已對此地點留下評價",
  FORBIDDEN: "無權限修改此評價",
  LIST_OK: "取得評價列表成功",
  SUMMARY_OK: "取得 AI 評價摘要成功",
} as const;

export const HAZARD_MSG = {
  EXIF_TOO_OLD: "照片拍攝時間距回報時間超過 10 分鐘",
  EXIF_GPS_MISMATCH: "照片 GPS 位置與宣稱位置不符",
  PHOTO_REQUIRED: "未上傳照片",
  PHOTO_TOO_LARGE: "照片超過大小上限",
  INVALID_PHOTO_TYPE: "僅接受 JPEG 或 PNG",
  RATE_LIMITED: "回報提交過於頻繁，請稍後再試",
  UPLOAD_FAILED: "照片上傳失敗，請重試",
  INVALID_ID: "無效的回報 ID 格式",
  REPORT_NOT_FOUND: "找不到對應的回報",
  ALREADY_VOTED: "您已對此回報投過票",
  SELF_CONFIRMATION: "無法確認自己提交的回報",
  REPORT_EXPIRED: "此回報已過期，無法投票",
  CREATED: "回報已提交，正在進行影像驗證",
  MERGED: "已合併至附近的既有回報",
  CONFIRMED: "已確認此回報",
  DENIED: "已否認此回報",
} as const;

export const CONTACT_REASON = {
  CONTACT_LIMIT_REACHED: "CONTACT_LIMIT_REACHED",
  NOT_CONTACT_OWNER: "NOT_CONTACT_OWNER",
  CONTACT_NOT_FOUND: "CONTACT_NOT_FOUND",
} as const;

export const CONTACT_MSG = {
  LIST_OK: "OK",
  CREATED: "聯絡人已建立，請將綁定連結與綁定碼分享給對方",
  DELETED: "已刪除",
  CONTACT_LIMIT_REACHED: "緊急聯絡人已達上限（5 位）",
  NOT_CONTACT_OWNER: "無權刪除此聯絡人",
  CONTACT_NOT_FOUND: "找不到該聯絡人",
} as const;

export const SOS_REASON = {
  NOT_SESSION_OWNER: "NOT_SESSION_OWNER",
  SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  TRACKING_EXPIRED: "TRACKING_EXPIRED",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  ALREADY_RESOLVED: "ALREADY_RESOLVED",
  NOT_AUTHORIZED_CONTACT: "NOT_AUTHORIZED_CONTACT",
} as const;

export const SOS_MSG = {
  CREATED: "已發出求救通知",
  ALREADY_ACTIVE: "已有進行中的求救",
  RESOLVED: "已解除求救",
  PUBLIC_OK: "OK",
  ACKNOWLEDGED: "已確認收到通知",
  CLAIMED: "你已承接此事件",
  STATUS_UPDATED: "已更新處理狀態",
  NOT_SESSION_OWNER: "無權更新此求救紀錄",
  SESSION_NOT_ACTIVE: "此求救已結束",
  SESSION_NOT_FOUND: "找不到該求救紀錄",
  TRACKING_NOT_FOUND: "找不到此追蹤連結",
  TRACKING_EXPIRED: "此追蹤連結已失效",
  ALREADY_CLAIMED: "此事件已由其他家人承接",
  ALREADY_RESOLVED: "此事件已結案",
  NOT_AUTHORIZED_CONTACT: "你沒有此事件的權限",
} as const;

export const SOS_TYPE_LABEL: Record<
  "body" | "trapped" | "share_location",
  string
> = {
  body: "人身安全",
  trapped: "受困",
  share_location: "分享位置",
} as const;

export const LINE_MSG = {
  WELCOME: "歡迎加入！請輸入朋友分享給你的 6 碼綁定碼以完成綁定。",
  BIND_SUCCESS: "綁定成功！當對方發出緊急求救時，你會在這裡收到通知。",
  INFO: "這是緊急求救通知官方帳號。若你收到綁定碼，請直接輸入以完成綁定；當你綁定的親友發出求救時，我們會在此通知你。如遇緊急狀況，請直接撥打 119（消防/救護）或 110（警察）。",
  SOS_NOTIFY_TITLE: "緊急求救通知",
  SOS_RESOLVED_TITLE: "求救已解除",
  SOS_ALREADY_RESOLVED: "此求救已解除，無需處理。",
  VIEW_LOCATION: "查看即時位置",
  APP_INFO:
    "這是無障礙緊急家人助理 LINE 帳號。你可以在這裡查詢已綁定家人的求救狀態與位置，也能查天氣、空氣品質、公車、火車、地點與無障礙設施。若收到 6 碼綁定碼，直接輸入即可完成綁定。",
  CLARIFY: "請問您想查公車、火車、天氣、地點、無障礙設施還是路線規劃呢？",
  RECOVERABLE_ASK: "系統暫時有點忙，麻煩您再說一次剛剛的需求，謝謝！",
  SOS_MENU_TITLE: "SOS 資訊查詢",
  SOS_MENU_PROMPT: "請選擇要查詢或管理的項目：",
  SOS_BIND_PROMPT: "請輸入 6 碼綁定驗證碼",
  SOS_HELP:
    "SOS 使用方式\n1. 對方在 App 按下求救後，你會在這裡收到通知卡片，可直接按「我收到了」或「我來處理這件事」。\n2. 承接事件後，可用按鈕更新「前往中」「已抵達」，抵達並確認平安後按「解除警報」。\n3. 通知卡片可查看即時位置，也可以直接問我前往對方位置的無障礙路線。\n4. 想新增可以照顧的家人，向對方索取 6 碼綁定碼後輸入即可。\n如遇緊急狀況，請直接撥打 119（消防/救護）或 110（警察）。",
  SOS_CONTACTS_TITLE: "目前綁定的使用者",
  SOS_NO_CONTACTS:
    "你目前沒有綁定任何使用者。請向對方索取 6 碼綁定驗證碼後輸入即可完成綁定。",
  SOS_HISTORY_TITLE: "求助歷史",
  SOS_NO_HISTORY: "目前沒有求助紀錄。",
  SOS_CONTACT_NOT_FOUND: "找不到這筆綁定，可能已解除綁定。",
  SOS_RENAME_PROMPT: "請直接輸入新的顯示名稱（輸入「取消」可放棄）。",
  SOS_RENAME_CANCELLED: "已取消修改顯示名稱。",
  SOS_RENAME_INVALID:
    "顯示名稱請輸入 1 到 50 個字，請再輸入一次（輸入「取消」可放棄）。",
  SOS_UNBIND_DONE: "已解除綁定，你不會再收到這位使用者的求救通知。",
} as const;

/**
 * Shared user-facing strings for the authentication endpoints. Credential
 * failures deliberately reuse one message so the response cannot be used to
 * discover which email addresses are registered.
 */
export const AUTH_MSG = {
  REGISTERED: "註冊成功，請至信箱點擊驗證連結後即可登入",
  REGISTERED_EMAIL_FAILED: "註冊成功，但驗證信寄送失敗，請稍後重新寄送驗證信",
  EMAIL_TAKEN: "此電子郵件已被註冊",
  INVALID_CREDENTIALS: "電子郵件或密碼錯誤",
  EMAIL_NOT_VERIFIED: "請先完成電子郵件驗證後再登入",
  EMAIL_VERIFIED: "電子郵件驗證成功",
  INVALID_TOKEN: "連結無效或已過期，請重新申請",
  VERIFICATION_SENT: "若該電子郵件尚待驗證，我們已重新寄出驗證信",
  RESET_SENT: "若該電子郵件已註冊，我們將寄出後續操作說明",
  RESET_QUEUE_UNAVAILABLE: "帳號協助服務暫時無法受理，請稍後再試",
  PASSWORD_RESET: "密碼已重設，請使用新密碼登入",
  PASSWORD_CHANGED: "密碼已更新，其他裝置的登入狀態已失效",
  PASSWORD_REQUIRED: "請提供目前的密碼",
  RATE_LIMITED: "操作過於頻繁，請稍後再試",
} as const;
