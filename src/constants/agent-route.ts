export const AGENT_ROUTE_CONTRACT_VERSION = 1;
export const AGENT_ROUTE_ERRORS = {
  INVALID_ROUTE_TOKEN: "路線已過期或無效，請重新規劃。",
  ROUTE_CONTEXT_REQUIRED: "尚未選擇路線；請先規劃並選擇路線，再查詢詳細指引。",
  ROUTE_CONTEXT_UNAVAILABLE:
    "目前無法讀取路線資料，請稍後重試；不會自動重新規劃。",
  STALE_SELECTION: "路線選擇已更新，這份舊結果已取消。",
  INVALID_ROUTE_ARGUMENTS:
    "路線工具參數格式錯誤，請使用有效的無障礙條件、朝向與語言。",
  EMPTY_ROUTES: "沒有可用的路線。",
} as const;
