import type { SupportedLang } from "../types/lang";

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
  LOCATION_REQUIRED:
    "目前無法取得使用者位置，請詢問出發地點，或請使用者開啟定位後再試。不要猜測起點；這不表示目的地沒有可用路線。",
  ROUTE_PLANNING_FAILED: "路線規劃失敗",
} as const;

const AGENT_ROUTE_ERRORS_EN: Record<keyof typeof AGENT_ROUTE_ERRORS, string> = {
  INVALID_ROUTE_TOKEN:
    "The route has expired or is invalid. Please plan a new route.",
  ROUTE_CONTEXT_REQUIRED:
    "No route has been selected. Please plan and select a route before requesting instructions.",
  ROUTE_CONTEXT_UNAVAILABLE:
    "The route is temporarily unavailable. Please try again; it will not be replanned automatically.",
  STALE_SELECTION:
    "The route selection has changed. This outdated result was cancelled.",
  INVALID_ROUTE_ARGUMENTS:
    "The route tool arguments are invalid. Check the accessibility options, heading and language.",
  EMPTY_ROUTES: "No routes are available.",
  LOCATION_REQUIRED:
    "The current location is unavailable. Ask for a starting point or request location access; do not guess the origin or infer that no route exists.",
  ROUTE_PLANNING_FAILED: "Route planning failed. Please try again later.",
};

export function agentRouteError(
  reason: keyof typeof AGENT_ROUTE_ERRORS,
  language?: SupportedLang,
): string {
  return language === "en"
    ? AGENT_ROUTE_ERRORS_EN[reason]
    : AGENT_ROUTE_ERRORS[reason];
}
