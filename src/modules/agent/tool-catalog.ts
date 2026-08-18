import type OpenAI from "openai";
import type { Tool, FunctionDeclaration } from "@google/genai";
import type { InteractionFunctionTool } from "../../types/agent";
import { openAiChatTools, memoryTools } from "../../config/ai/tool";

/**
 * Select and filter the OpenAI tool specs backing both catalogue builders, so
 * the Live (voice) and Interactions (text) surfaces can never drift on which
 * tools exist.
 */
function selectSpecs(
  userId?: string,
  memoryEnabled = false,
  extraTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
  allowList?: string[],
) {
  const specs =
    userId && memoryEnabled
      ? [...openAiChatTools, ...memoryTools, ...extraTools]
      : [...openAiChatTools, ...extraTools];
  return specs
    .filter(
      (
        t,
      ): t is Extract<
        OpenAI.Chat.Completions.ChatCompletionTool,
        { type: "function" }
      > => t.type === "function",
    )
    .filter(
      (t) => allowList === undefined || allowList.includes(t.function.name),
    );
}

/**
 * Build Gemini `Tool[]` function declarations. Still required by the voice Live
 * API bridge, which is a separate WebSocket surface and stays on the legacy
 * shape; the text agent uses `buildInteractionTools` instead.
 *
 * @param userId Authenticated user id.
 * @param memoryEnabled When true, memory tools are appended to the catalogue.
 * @param extraTools Additional OpenAI tool specs to append.
 * @param allowList Declaration filter; `undefined` declares every tool.
 * @returns A single-entry Tool list holding every function declaration
 */
export function buildGeminiTools(
  userId?: string,
  memoryEnabled = false,
  extraTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
  allowList?: string[],
): Tool[] {
  const functionDeclarations: FunctionDeclaration[] = selectSpecs(
    userId,
    memoryEnabled,
    extraTools,
    allowList,
  ).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parametersJsonSchema: t.function.parameters,
  }));
  return [{ functionDeclarations }];
}

/**
 * Build Interactions API function tools from the existing OpenAI tool specs by
 * passing their JSON Schema straight through, so the tool catalogue stays
 * defined in one place.
 *
 * @param userId Authenticated user id.
 * @param memoryEnabled When true, memory tools are appended to the catalogue.
 * @param extraTools Additional OpenAI tool specs to append (e.g. LINE family).
 * @param allowList Declaration filter. `undefined` declares every tool; any
 *   array (including `[]` → zero tools) is a membership filter.
 * @returns One `{ type: "function" }` tool per declaration
 */
export function buildInteractionTools(
  userId?: string,
  memoryEnabled = false,
  extraTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
  allowList?: string[],
): InteractionFunctionTool[] {
  return selectSpecs(userId, memoryEnabled, extraTools, allowList).map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}
