import { runToolLoop } from "../agent/agent-manager.service";
import { toInteractionInput } from "../agent/history-adapter";
import { executeLocalTool } from "../ai/agent-tools";
import {
  RouteConversationContext,
  createRouteAwareExecutor,
} from "../ai/route-context.service";
import { LINE_FAMILY_SYSTEM_PROMPT } from "../../config/ai/line-family-prompt";
import { withCurrentDate, withUserLocation } from "../../config/ai/chat-prompt";
import { lineFamilyTools, openAiChatTools } from "../../config/ai/tool";
import { model } from "../../config/ai";
import type { AgentResult, AgentToolExecutor } from "../../types/agent";
import type { OAIMessage } from "../../types/openai-chat";
import {
  clearLineLastRouteToken,
  getLineLastRouteToken,
  setLineLastRouteToken,
} from "./line-memory";

/** Shared-catalogue tools LINE does not offer; indoor venue lookups stay app-only. */
export const LINE_EXCLUDED_TOOLS = new Set(["inspectVenue", "planIndoorRoute"]);

/**
 * Tool names a family LINE user may execute: the general read-only query tools
 * plus the SOS read, SOS lifecycle, and account-binding tools. Memory-write
 * tools are excluded by construction (they live in a separate catalogue group).
 */
export const LINE_TOOL_ALLOWLIST: string[] = [
  ...openAiChatTools,
  ...lineFamilyTools,
].flatMap((tool) =>
  tool.type === "function" && !LINE_EXCLUDED_TOOLS.has(tool.function.name)
    ? [tool.function.name]
    : [],
);

/**
 * Tools that change state (bindings, SOS lifecycle). Excluded for turns whose
 * text is a speech-to-text guess, so a mis-hearing can never bind an account or
 * claim / resolve an SOS — those need typed text or a button.
 */
export const LINE_WRITE_TOOLS = new Set([
  "bindEmergencyContactCode",
  "bindLineAccountCode",
  "confirmSosReceived",
  "claimSosEvent",
  "updateSosHandlingStatus",
  "resolveSosEvent",
]);

export interface RunLineAgentParams {
  lineUserId: string;
  messages: OAIMessage[];
  userLocation?: { latitude: number; longitude: number };
  /** Read-only tool set (voice transcripts). */
  readOnly?: boolean;
}

/**
 * Runs the family LINE assistant through the shared agent tool-loop. The system
 * prompt, tool allow-list, and an executor that threads the caller's LINE user
 * id into every tool call are wired here so callers only pass the conversation.
 *
 * @param params The caller's LINE user id, conversation messages, and optional location.
 * @returns The agent result (final text plus collected tool results).
 */
export async function runLineAgent(
  params: RunLineAgentParams,
): Promise<AgentResult> {
  const context = new RouteConversationContext();
  const previousToken = params.lineUserId
    ? await getLineLastRouteToken(params.lineUserId)
    : undefined;
  if (previousToken) {
    const restored = await context.set({ routeToken: previousToken });
    if (!restored.ok) await clearLineLastRouteToken(params.lineUserId);
  }
  const initialRevision = context.revision;
  let systemPrompt =
    withCurrentDate(LINE_FAMILY_SYSTEM_PROMPT) + context.prompt;
  if (params.userLocation) {
    systemPrompt = withUserLocation(systemPrompt, params.userLocation);
  }
  const { systemInstruction, input } = toInteractionInput([
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

  const result = await runToolLoop(
    input,
    systemInstruction,
    model,
    params.userLocation,
    undefined,
    undefined,
    undefined,
    false,
    false,
    false,
    createRouteAwareExecutor(context, execTool),
    {
      extraTools: lineFamilyTools,
      toolAllowList: params.readOnly
        ? LINE_TOOL_ALLOWLIST.filter((name) => !LINE_WRITE_TOOLS.has(name))
        : LINE_TOOL_ALLOWLIST,
    },
  );
  if (params.lineUserId && context.revision !== initialRevision) {
    if (context.token)
      await setLineLastRouteToken(params.lineUserId, context.token);
    else await clearLineLastRouteToken(params.lineUserId);
  }
  return result;
}
