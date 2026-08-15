import { runToolLoop } from "../agent/agent-manager.service";
import { toGeminiHistory } from "../agent/history-adapter";
import { executeLocalTool } from "../ai/agent-tools";
import { LINE_FAMILY_SYSTEM_PROMPT } from "../../config/ai/line-family-prompt";
import { withCurrentDate, withUserLocation } from "../../config/ai/chat-prompt";
import { lineFamilyTools, openAiChatTools } from "../../config/ai/tool";
import { model } from "../../config/ai";
import type { AgentResult, AgentToolExecutor } from "../../types/agent";
import type { OAIMessage } from "../../types/openai-chat";

/**
 * Tool names a family LINE user may execute: the general read-only query tools
 * plus the SOS read, SOS lifecycle, and account-binding tools. Memory-write
 * tools are excluded by construction (they live in a separate catalogue group).
 */
export const LINE_TOOL_ALLOWLIST: string[] = [
  ...openAiChatTools,
  ...lineFamilyTools,
].flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []));

export interface RunLineAgentParams {
  lineUserId: string;
  messages: OAIMessage[];
  userLocation?: { latitude: number; longitude: number };
}

/**
 * Runs the family LINE assistant through the shared agent tool-loop. The system
 * prompt, tool allow-list, and an executor that threads the caller's LINE user
 * id into every tool call are wired here so callers only pass the conversation.
 *
 * @param params The caller's LINE user id, conversation messages, and optional location.
 * @returns The agent result (final text plus collected tool results).
 */
export function runLineAgent(params: RunLineAgentParams): Promise<AgentResult> {
  let systemPrompt = withCurrentDate(LINE_FAMILY_SYSTEM_PROMPT);
  if (params.userLocation) {
    systemPrompt = withUserLocation(systemPrompt, params.userLocation);
  }
  const { systemInstruction, contents } = toGeminiHistory([
    { role: "system", content: systemPrompt },
    ...params.messages,
  ]);

  const execTool: AgentToolExecutor = (
    name,
    args,
    loc,
    userId,
    memoryOptions,
  ) =>
    executeLocalTool(name, args, loc ?? params.userLocation, userId, {
      ...(memoryOptions ?? {}),
      lineUserId: params.lineUserId,
    });

  return runToolLoop(
    contents,
    systemInstruction,
    model,
    params.userLocation,
    undefined,
    undefined,
    undefined,
    false,
    false,
    false,
    execTool,
    { extraTools: lineFamilyTools, toolAllowList: LINE_TOOL_ALLOWLIST },
  );
}
