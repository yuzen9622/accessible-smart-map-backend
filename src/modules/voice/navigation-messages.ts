import type { SupportedLang } from "../../types/lang";
import type { HazardType } from "../../types";
import { englishPlaceLabel } from "../../utils/nav-instructions-english";

/** Backend-authored navigation text; source names and alert details stay intact. */
export const NAVIGATION_MESSAGES = {
  "zh-TW": {
    inProgress: "導航進行中",
    noRoute: "尚未選擇路線",
    invalidToken: "路線憑證格式無效",
    invalidResume: "恢復導航請求格式無效",
    invalidRoute: "路線資料無效，請重新規劃",
    roadLegEnd: "抵達車行路段終點，請停車",
    walkLegEnd: (destination: string) => `抵達「${destination}」`,
    offRoute: "您似乎偏離路線，請確認目前位置",
    replacementInvalid: "替代路線無法啟動",
    routeExpired: "路線已過期，請重新規劃",
    snapshotExpired: "導航進度已過期，請重新規劃",
    userMismatch: "導航進度不屬於此帳號",
    versionMismatch: "導航版本已更新，請重新規劃",
    resumeFailed: "無法恢復導航，請重新規劃",
    rerouteFailed: "無法重新規劃路線，請稍後再試",
    started: "已開始導航",
    stopped: "已停止導航",
    repeat: "將重播目前步驟",
    hazard: (type: HazardType, distance: number) => {
      const label = {
        obstacle: "障礙物",
        construction: "施工",
        data_error: "資料錯誤",
      }[type];
      return distance > 0
        ? `前方 ${Math.round(distance)} 公尺有${label}回報`
        : `前方有${label}回報`;
    },
    facility: (station: string, keyword: string) =>
      `${station}站電梯${keyword}中`,
    advisory: (title: string, rerouting: boolean, alternative = false) =>
      `注意，${title}${rerouting ? "，正在為你重新規劃路線" : alternative ? "，可查看替代路線" : ""}`,
    transitAlert: (title: string, rerouting: boolean) =>
      `注意，即時通阻警報：${title}${rerouting ? "，正在為你重新規劃路線" : ""}`,
  },
  en: {
    inProgress: "Navigation is already in progress.",
    noRoute: "No route has been selected.",
    invalidToken: "The route token format is invalid.",
    invalidResume: "The navigation resume request is invalid.",
    invalidRoute: "The route is invalid. Please plan a new route.",
    roadLegEnd: "You have reached the end of the driving segment. Please park.",
    walkLegEnd: (destination: string) =>
      `Arrive at ${englishPlaceLabel(destination)}.`,
    offRoute: "You appear to be off route. Please check your location.",
    replacementInvalid: "The alternative route could not be started.",
    routeExpired: "The route has expired. Please plan a new route.",
    snapshotExpired:
      "Your navigation progress has expired. Please plan a new route.",
    userMismatch: "This navigation progress belongs to a different account.",
    versionMismatch:
      "The navigation version has changed. Please plan a new route.",
    resumeFailed: "Navigation could not be resumed. Please plan a new route.",
    rerouteFailed: "The route could not be replanned. Please try again later.",
    started: "Navigation has started.",
    stopped: "Navigation has stopped.",
    repeat: "Repeating the current navigation step.",
    hazard: (type: HazardType, distance: number) => {
      const label = {
        obstacle: "An obstacle",
        construction: "Construction",
        data_error: "A map data error",
      }[type];
      return `${label} has been reported ${distance > 0 ? `${Math.round(distance)} metres ahead` : "ahead"}`;
    },
    facility: (station: string, _keyword: string) =>
      `An elevator at ${station} station is unavailable`,
    advisory: (title: string, rerouting: boolean, alternative = false) =>
      `Caution: ${title}.${rerouting ? " Replanning your route." : alternative ? " You can view alternative routes." : ""}`,
    transitAlert: (title: string, rerouting: boolean) =>
      `Transit service alert: ${title}.${rerouting ? " Replanning your route." : ""}`,
  },
} satisfies Record<SupportedLang, unknown>;
