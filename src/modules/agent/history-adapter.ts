import type { InteractionInputStep } from "../../types/agent";
import type { OAIMessage } from "../../types/openai-chat";

/**
 * Convert an OpenAI-format chat history into the Interactions API request
 * shape. System messages collapse into `system_instruction`; the remaining
 * turns become `input` steps — user turns are `user_input`, assistant text is
 * `model_output`, assistant `tool_calls` are `function_call` steps and tool
 * results are `function_result` steps matched back by `call_id`.
 *
 * @param messages OpenAI chat messages (system prompt already prepended)
 * @returns The `system_instruction` text and the `input` step array
 */
export function toInteractionInput(messages: OAIMessage[]): {
  systemInstruction?: string;
  input: InteractionInputStep[];
} {
  let systemInstruction: string | undefined;
  const input: InteractionInputStep[] = [];
  const idToName = new Map<string, string>();

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      systemInstruction = systemInstruction
        ? `${systemInstruction}\n\n${text}`
        : text;
    } else if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      input.push({ type: "user_input", content: [{ type: "text", text }] });
    } else if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content) {
        input.push({
          type: "model_output",
          content: [{ type: "text", text: m.content }],
        });
      }
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          /* keep {} */
        }
        idToName.set(tc.id, tc.function.name);
        input.push({
          type: "function_call",
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
      }
    } else if (m.role === "tool") {
      const raw = typeof m.content === "string" ? m.content : "";
      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        result = { result: raw };
      }
      input.push({
        type: "function_result",
        call_id: m.tool_call_id,
        name: idToName.get(m.tool_call_id) ?? "unknown",
        result,
      });
    }
  }

  return { systemInstruction, input };
}
