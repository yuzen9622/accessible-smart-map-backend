import type { SupportedLang } from "../types/lang";
import { ERROR_MESSAGE } from "./messages";

/** Stable reasons for the Phase-1 search and AI boundaries. */
export const API_ERROR_COPY = {
  PLACE_NOT_FOUND: {
    "zh-TW": "查無此地點",
    en: "Place not found",
    legacy: "查無此地點",
  },
  PLACE_SEARCH_FAILED: {
    "zh-TW": "地點查詢失敗，請稍後再試",
    en: "Place search failed. Please try again later.",
    legacy: ERROR_MESSAGE.INTERNAL,
  },
  AI_EMPTY_RESPONSE: {
    "zh-TW": "AI 未能產生回覆，請稍後再試",
    en: "The assistant could not produce a response. Please try again.",
    legacy: ERROR_MESSAGE.INTERNAL,
  },
  AI_REQUEST_FAILED: {
    "zh-TW": "AI 服務暫時無法使用，請稍後再試",
    en: "The assistant is temporarily unavailable. Please try again later.",
    legacy: ERROR_MESSAGE.INTERNAL,
  },
  AI_RATE_LIMITED: {
    "zh-TW": "AI 服務目前忙線（配額不足），請稍後再試。",
    en: "The assistant is currently busy. Please try again later.",
    legacy: "AI 服務目前忙線（配額不足），請稍後再試。",
  },
  AI_EXPLANATION_FAILED: {
    "zh-TW": "路線說明生成失敗，請稍後再試",
    en: "The route explanation could not be generated. Please try again later.",
    legacy: "路線說明生成失敗，請稍後再試",
  },
  AI_INTENT_UNRESOLVED: {
    "zh-TW": "無法解析您的查詢，請改用『從 A 到 B』的描述方式",
    en: "Your request could not be understood. Please specify an origin and destination.",
    legacy: "無法解析您的查詢，請改用『從 A 到 B』的描述方式",
  },
} as const;

export type ApiErrorReason = keyof typeof API_ERROR_COPY;
export interface ApiErrorData {
  reason: ApiErrorReason;
}

/** Omitted language preserves legacy fallback; never return an upstream exception. */
export function apiErrorMessage(
  reason: ApiErrorReason,
  language?: SupportedLang,
): string {
  return API_ERROR_COPY[reason][language ?? "legacy"];
}
