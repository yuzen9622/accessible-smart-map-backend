import { runAgent } from "../agent/agent-manager.service";
import { toInteractionInput } from "../agent/history-adapter";
import { executeLocalTool } from "./agent-tools";
import type { AgentInput, AgentResult } from "../../types/agent";
import type { OAIMessage } from "../../types/openai-chat";
import { withResponseLanguage } from "../../utils/agent-language";
import {
  RouteConversationContext,
  createRouteAwareExecutor,
} from "./route-context.service";

export { toInteractionInput };
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
export async function runChatAgent(
  input: Omit<AgentInput, "execTool">,
): Promise<AgentResult> {
  const context = new RouteConversationContext(input.routingPreferences);
  if (input.routeContext !== undefined) await context.set(input.routeContext);
  return runAgent({
    ...input,
    systemInstruction: withResponseLanguage(
      (input.systemInstruction ?? "") + context.prompt,
      input.language,
    ),
    execTool: createRouteAwareExecutor(context, executeLocalTool),
  });
}
