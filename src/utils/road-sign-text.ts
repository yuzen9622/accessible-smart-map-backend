import type { RoadSigns } from "../types/road-guidance";
import type { AgentLanguage } from "../types/agent";

/** The "（原始路牌：…）" suffix for these signs, or "" when there is none. */
export function roadSignSuffix(
  signs: RoadSigns | undefined,
  language: AgentLanguage = "zh-TW",
): string {
  if (!signs) return "";
  const separator = language === "en" ? " / " : "、";
  const parts = [
    signs.exitNumbers.length
      ? `${language === "en" ? "Exit" : "出口"} ${signs.exitNumbers.join(separator)}`
      : "",
    signs.branches.join(separator),
    signs.destinations.join(separator),
    signs.exitNames.join(separator),
  ].filter(Boolean);
  if (!parts.length) return "";
  return language === "en"
    ? ` (Signs: ${parts.join("; ")})`
    : `（原始路牌：${parts.join("；")}）`;
}

export function withRoadSignText(
  instruction: string,
  signs: RoadSigns | undefined,
  language: AgentLanguage = "zh-TW",
): string {
  const suffix = roadSignSuffix(signs, language);
  return instruction.endsWith(suffix) ? instruction : instruction + suffix;
}
