import type OpenAI from "openai";
import type { Content, Part, Tool, GenerateContentConfig } from "@google/genai";
import { FunctionCallingConfigMode } from "@google/genai";
import { googleGenAi, model } from "../../config/ai";
import { AGENT_TEMPERATURE } from "../../config/ai/config";
import { buildGeminiTools } from "./tool-catalog";
import type {
  AgentInput,
  AgentResult,
  AgentToolExecutor,
  RouteOnceResult,
  RunToolLoopResult,
} from "../../types/agent";

export type { AgentInput, AgentResult, RouteOnceResult, RunToolLoopResult };

/**
 * The routing-round generate config, shared by `runToolLoop` and `routeOnce`
 * so the offline eval can never drift from the production routing decision.
 *
 * @param systemInstruction System prompt for this round
 * @param tools The Gemini tool catalogue
 * @returns The GenerateContentConfig used for every tool-selection round
 */
function buildRoutingConfig(
  systemInstruction: string | undefined,
  tools: Tool[],
  forcing?: { allowedFunctionNames?: string[] },
): GenerateContentConfig {
  const functionCallingConfig =
    forcing?.allowedFunctionNames && forcing.allowedFunctionNames.length
      ? {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: forcing.allowedFunctionNames,
        }
      : { mode: FunctionCallingConfigMode.AUTO };
  return {
    systemInstruction,
    tools,
    toolConfig: { functionCallingConfig },
    temperature: AGENT_TEMPERATURE,
  };
}

/**
 * The final-answer generate config. Identical to `buildRoutingConfig` except
 * function calling is disabled (`mode: NONE`), so the model must emit text. The
 * tool catalogue is still declared so the model's thought signatures round-trip
 * exactly as they did on the routing rounds — the same reason `runToolLoop`
 * pushes the model's content back verbatim.
 *
 * @param systemInstruction System prompt for the final round
 * @param tools The Gemini tool catalogue (declared but not callable)
 * @returns The GenerateContentConfig used to force the final text answer
 */
function buildFinalConfig(
  systemInstruction: string | undefined,
  tools: Tool[],
): GenerateContentConfig {
  return {
    systemInstruction,
    tools,
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
    },
    temperature: AGENT_TEMPERATURE,
  };
}

function stableCacheKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((o, k) => {
      o[k] = args[k];
      return o;
    }, {});
  return name + "\0" + JSON.stringify(sorted);
}

function isSuccessResult(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    if (parsed.error) return false;
    if (parsed.ok === false) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the Gemini tool-calling loop (max 5 rounds) over `contents`, executing
 * local tools and appending the model's function-call turns and our function
 * responses in place. The model's returned content is pushed back verbatim so
 * thought signatures round-trip across rounds. Leaves `contents` ready for the
 * final tool-free completion.
 *
 * @param contents Gemini conversation contents, mutated in place
 * @param systemInstruction System prompt passed on every round
 * @param useModel Model name to call
 * @param userLocation Optional user coordinates passed to tools
 * @param onToolCall Hook invoked when a tool call starts
 * @param onToolResult Hook invoked with a tool's parsed result
 * @param userId Authenticated user id.
 * @param memoryToolsEnabled Enables memory tools when userId is present.
 * @param allowMemoryWrite Passed through to the executor's memory options.
 * @param explicitMemoryRequest Passed through to the executor's memory options.
 * @param execTool Tool executor, injected by the caller (dependency inversion:
 *   the agent core never imports a concrete executor).
 * @param options extraTools appends caller-specific tool specs to the catalogue.
 * @returns The model's final text answer plus parsed tool results. Always
 *   resolves with a `text` field (possibly empty); never returns without one,
 *   so callers never need a divergent fallback generation.
 */
export async function runToolLoop(
  contents: Content[],
  systemInstruction: string | undefined,
  useModel: string,
  userLocation: { latitude: number; longitude: number } | undefined,
  onToolCall:
    ((name: string, args: Record<string, unknown>) => void) | undefined,
  onToolResult: ((name: string, result: unknown) => void) | undefined,
  userId: string | undefined,
  memoryToolsEnabled: boolean,
  allowMemoryWrite: boolean,
  explicitMemoryRequest: boolean,
  execTool: AgentToolExecutor,
  options: {
    extraTools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    toolAllowList?: string[];
    allowedFunctionNames?: string[];
    seedParts?: string[];
  } = {},
): Promise<RunToolLoopResult> {
  const MAX_ROUNDS = 5;
  const toolCache = new Map<string, string>();
  const extraTools = options.extraTools ?? [];
  const tools = buildGeminiTools(
    userId,
    memoryToolsEnabled,
    extraTools,
    options.toolAllowList,
  );
  const toolResults: RunToolLoopResult["toolResults"] = [];

  if (options.seedParts?.length) {
    contents.push({
      role: "user",
      parts: options.seedParts.map((text) => ({ text })),
    });
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await googleGenAi.models.generateContent({
      model: useModel,
      contents,
      config: buildRoutingConfig(
        systemInstruction,
        tools,
        round === 0
          ? { allowedFunctionNames: options.allowedFunctionNames }
          : undefined,
      ),
    });

    const calls = response.functionCalls;
    if (!calls?.length) {
      const text = response.text ?? "";
      if (text) return { text, toolResults };
      break;
    }

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const responseParts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const args = (call.args ?? {}) as Record<string, unknown>;

      onToolCall?.(name, args);

      // Execution-layer authorization boundary. `undefined` keeps the legacy
      // AUTO path (no interception); any array (including `[]` = deny-all) is a
      // membership check — an unauthorized tool is never executed.
      if (
        options.toolAllowList !== undefined &&
        !options.toolAllowList.includes(name)
      ) {
        console.warn(`[agent-manager] blocked unauthorized tool: ${name}`);
        const blocked = { error: "tool_not_allowed" };
        onToolResult?.(name, blocked);
        toolResults.push({ name, args, result: blocked });
        responseParts.push({ functionResponse: { name, response: blocked } });
        continue;
      }

      const cacheKey = stableCacheKey(name, args);
      let resultStr: string;
      if (toolCache.has(cacheKey)) {
        resultStr = toolCache.get(cacheKey)!;
      } else {
        resultStr = await execTool(name, args, userLocation, userId, {
          allowMemoryWrite,
          explicitMemoryRequest,
        });
        if (isSuccessResult(resultStr)) {
          toolCache.set(cacheKey, resultStr);
        }
      }

      let parsedResult: unknown;
      try {
        parsedResult = JSON.parse(resultStr);
      } catch {
        parsedResult = { result: resultStr };
      }

      onToolResult?.(name, parsedResult);
      toolResults.push({ name, args, result: parsedResult });

      const responseObj =
        parsedResult && typeof parsedResult === "object"
          ? (parsedResult as Record<string, unknown>)
          : { result: parsedResult };
      responseParts.push({ functionResponse: { name, response: responseObj } });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  const finalResp = await googleGenAi.models.generateContent({
    model: useModel,
    contents,
    config: buildFinalConfig(systemInstruction, tools),
  });
  return { text: finalResp.text ?? "", toolResults };
}

/**
 * NONE/text-only completion: append optional seed parts (e.g. serialized tool
 * results) as a user turn, then run a single `generateContent` with function
 * calling disabled so the model can ONLY emit text. Calls no tools and has no
 * side effects — used by the LINE deterministic path to summarize after the
 * executor has already run every step.
 *
 * @param params contents/systemInstruction/model plus optional seedParts.
 * @returns The model's text answer (possibly empty).
 */
export async function summarizeWithContext(params: {
  contents: Content[];
  systemInstruction: string | undefined;
  model: string;
  seedParts?: string[];
}): Promise<string> {
  const contents = params.seedParts?.length
    ? [
        ...params.contents,
        {
          role: "user" as const,
          parts: params.seedParts.map((text) => ({ text })),
        },
      ]
    : params.contents;
  const response = await googleGenAi.models.generateContent({
    model: params.model,
    contents,
    config: buildFinalConfig(params.systemInstruction, []),
  });
  return response.text ?? "";
}

/**
 * The Agent Manager façade: a named-field entry point wrapping `runToolLoop`'s
 * positional parameters (Input → Manager/Loop → Response). Delegates verbatim;
 * every surface (ai chat, LINE family) injects its own tool executor.
 *
 * @param input The agent input contract (see AgentInput).
 * @returns The final text answer plus parsed tool results.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  return runToolLoop(
    input.contents,
    input.systemInstruction,
    input.model,
    input.userLocation,
    input.onToolCall,
    input.onToolResult,
    input.userId,
    input.memoryToolsEnabled ?? false,
    input.allowMemoryWrite ?? false,
    input.explicitMemoryRequest ?? false,
    input.execTool,
    { extraTools: input.extraTools },
  );
}

/**
 * Run EXACTLY ONE routing round against the real tool catalogue and routing
 * config, reporting which tools the model chose. Does NOT execute any tool and
 * never touches MongoDB or external APIs — for the offline tool-selection eval
 * only. Mirrors the first round of `runToolLoop` via the shared
 * `buildRoutingConfig`.
 *
 * @param userMessage The single user query to route
 * @param systemInstruction System prompt (assemble via withUserLocation upstream)
 * @param opts userLocation is unused here (location belongs in systemInstruction);
 *   memoryEnabled toggles memory tools into the catalogue when userId is present;
 *   model overrides the default
 * @returns The called tool names (in order), any emitted text, and the raw response
 */
export async function routeOnce(
  userMessage: string,
  systemInstruction: string | undefined,
  opts: {
    userLocation?: { latitude: number; longitude: number };
    userId?: string;
    memoryEnabled?: boolean;
    model?: string;
  } = {},
): Promise<RouteOnceResult> {
  const useModel = opts.model ?? model;
  const tools = buildGeminiTools(
    opts.userId,
    opts.memoryEnabled ?? Boolean(opts.userId),
  );
  const contents: Content[] = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const response = await googleGenAi.models.generateContent({
    model: useModel,
    contents,
    config: buildRoutingConfig(systemInstruction, tools),
  });

  const calledTools = (response.functionCalls ?? [])
    .map((c) => c.name ?? "")
    .filter(Boolean);

  // Only read `.text` when no tool fired — the SDK warns when `.text` is
  // accessed on a response that also has functionCall parts.
  const text = calledTools.length ? "" : (response.text ?? "");

  return { calledTools, text, raw: response };
}
