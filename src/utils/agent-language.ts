import type { AgentLanguage } from "../types/agent";

const LANGUAGE_INSTRUCTIONS: Record<AgentLanguage, string> = {
  "zh-TW": "請使用臺灣繁體中文回覆，採用臺灣慣用詞彙，不要使用簡體中文。",
  en: "Respond in English, including spoken replies and explanations of tool results.",
};

/** Append the current UI preference after history/memories, without changing legacy callers. */
export function withResponseLanguage(
  prompt: string,
  language?: AgentLanguage,
): string {
  if (!language) return prompt;
  return `${prompt}\n\n【目前介面語言偏好：${language}】\n${LANGUAGE_INSTRUCTIONS[language]}\n此偏好優先於對話歷史、記憶、工具結果與範例所使用的語言；不要僅因輸入或地名是另一種語言就改變回覆語言。只有使用者本輪明確要求另一種語言或翻譯時，才依該要求回答。保留地名、路線號碼、方向、距離與時間的原意，不得杜撰翻譯。`;
}
