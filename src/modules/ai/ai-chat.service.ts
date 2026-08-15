import { runAgent } from "../agent/agent-manager.service";
import { toGeminiHistory } from "../agent/history-adapter";
import { executeLocalTool } from "./agent-tools";
import type { AgentInput, AgentResult } from "../../types/agent";
import type { OAIMessage } from "../../types/openai-chat";

export { toGeminiHistory };
export type { OAIMessage, AgentResult };
export type { RunToolLoopResult, RouteOnceResult } from "../../types/agent";

/**
 * AI-module façade over the shared Agent Manager: injects this module's local
 * tool executor (`executeLocalTool`) and delegates to `runAgent`, so the chat
 * controller calls one same-module service rather than reaching across modules.
 *
 * @param input The agent input contract minus `execTool` (bound here).
 * @returns The final text answer plus parsed tool results.
 */
export function runChatAgent(
  input: Omit<AgentInput, "execTool">,
): Promise<AgentResult> {
  return runAgent({ ...input, execTool: executeLocalTool });
}
