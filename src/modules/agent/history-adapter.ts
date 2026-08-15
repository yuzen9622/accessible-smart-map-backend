import type { Content, Part } from "@google/genai";
import type { OAIMessage } from "../../types/openai-chat";

/**
 * Convert an OpenAI-format chat history into the Gemini request shape. System
 * messages collapse into `systemInstruction`; user/assistant/tool turns become
 * `contents`. Assistant `tool_calls` map to `functionCall` parts and `tool`
 * results map to `functionResponse` parts (name resolved via the preceding
 * tool_call id).
 *
 * @param messages OpenAI chat messages (system prompt already prepended)
 * @returns The Gemini `systemInstruction` text and `contents` array
 */
export function toGeminiHistory(messages: OAIMessage[]): {
  systemInstruction?: string;
  contents: Content[];
} {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];
  const idToName = new Map<string, string>();

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      systemInstruction = systemInstruction
        ? `${systemInstruction}\n\n${text}`
        : text;
    } else if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      contents.push({ role: "user", parts: [{ text }] });
    } else if (m.role === "assistant") {
      const parts: Part[] = [];
      if (typeof m.content === "string" && m.content)
        parts.push({ text: m.content });
      const toolCalls = m.tool_calls;
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            /* keep {} */
          }
          idToName.set(tc.id, tc.function.name);
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const name = idToName.get(m.tool_call_id) ?? "unknown";
      const raw = typeof m.content === "string" ? m.content : "";
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        response =
          parsed && typeof parsed === "object" ? parsed : { result: parsed };
      } catch {
        response = { result: raw };
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response } }],
      });
    }
  }

  return { systemInstruction, contents };
}
