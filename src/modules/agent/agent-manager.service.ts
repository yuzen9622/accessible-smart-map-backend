import { randomUUID } from "crypto";
import { projectToolResult } from "../../utils/agent-route-projection";
import type OpenAI from "openai";
import { googleGenAi, model } from "../../config/ai";
import { AGENT_THINKING_LEVEL } from "../../config/ai/config";
import { buildInteractionTools } from "./tool-catalog";
import {
  assertToolDecision,
  FINISH_TOOL_PHASE_NAME,
  FINISH_TOOL_PHASE_TOOL,
  TOOL_DECISION_INSTRUCTION,
} from "./tool-phase";
import type {
  AgentInput,
  AgentLanguage,
  AgentResult,
  AgentToolExecutor,
  InteractionInputStep,
  RouteOnceResult,
  RunToolLoopResult,
} from "../../types/agent";

export type { AgentInput, AgentResult, RouteOnceResult, RunToolLoopResult };

/**
 * Rounds of tool calling allowed before the loop is forced to answer. Sized for
 * genuinely multi-hop questions: resolving both ends of a trip and then reading
 * a timetable per candidate route costs ~10-20 calls, and the loop must not cut
 * the model off mid-plan. Affordable because stateful interactions send only
 * the new tool results each round rather than the whole growing history.
 */
export const MAX_ROUNDS = 18;

/**
 * The generation config for one round. `tool_choice` is the only knob that
 * differs between routing rounds and the final answer round, so both paths go
 * through here and can never drift.
 *
 * Note there is deliberately no `temperature` / `top_p` / `top_k`: the
 * Interactions API dropped them (deprecated 2026-07-21) in favour of
 * `thinking_level`.
 *
 * @param mode "route" preserves legacy auto selection; "decision" requires a
 *   tool/control call; "final" forbids tools; "forced" selects a named subset.
 * @param allowedFunctionNames Tool names to force, for mode "forced"
 * @returns The `generation_config` for `interactions.create`
 */
function buildGenerationConfig(
  mode: "route" | "decision" | "final" | "forced",
  allowedFunctionNames?: string[],
) {
  const tool_choice =
    mode === "final"
      ? ("none" as const)
      : mode === "forced" && allowedFunctionNames?.length
        ? {
            allowed_tools: {
              mode: "any" as const,
              tools: allowedFunctionNames,
            },
          }
        : mode === "decision"
          ? ("any" as const)
          : ("auto" as const);
  // The Interactions API has no temperature/top_p/top_k (dropped 2026-07-21), so
  // the old `temperature: 0` greedy decoding is gone and cannot be restored. A
  // fixed `seed` was tried and measurably changed nothing, so tool-selection
  // stability has to come from the prompts stating their intent boundaries
  // explicitly rather than from decoding settings.
  return { thinking_level: AGENT_THINKING_LEVEL, tool_choice };
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

type InteractionStep = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
};

type InteractionLike = {
  id: string;
  status?: string;
  steps?: InteractionStep[];
  output_text?: string;
  usage?: Record<string, unknown>;
  errors?: Array<Record<string, unknown>>;
};

type InteractionStreamEvent = {
  event_type: string;
  index?: number;
  step?: InteractionStep;
  delta?: { type?: string; text?: string };
  interaction?: Partial<InteractionLike>;
};

/**
 * Interaction statuses that mean "the model stopped before finishing". They are
 * the silent causes of an empty answer, so they are logged loudly rather than
 * being allowed to look like a normal turn that simply had nothing to say.
 */
const INCOMPLETE_STATUSES = [
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
];

/**
 * Consume an answer-only interaction. Publish only model_output text, never
 * thought steps or tool requests, and require an explicit successful completion.
 * Routing/tool decisions use non-streaming interactions and never enter here.
 *
 * @param stream The SSE event stream from `interactions.create({stream:true})`
 * @param onTextDelta Called with each incremental text chunk
 * @returns The reconstructed interaction
 */
async function collectStream(
  stream: AsyncIterable<InteractionStreamEvent>,
  onTextDelta: (text: string) => void,
): Promise<InteractionLike> {
  const outputSteps = new Set<number>();
  let completed = false;
  let text = "";
  let id = "";
  let status: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let errors: Array<Record<string, unknown>> | undefined;

  for await (const event of stream) {
    switch (event.event_type) {
      case "interaction.created":
      case "interaction.status_update":
      case "interaction.completed": {
        const it = event.interaction ?? {};
        if (it.id) id = it.id;
        if (it.status) status = it.status;
        if (it.usage) usage = it.usage;
        if (it.errors) errors = it.errors;
        if (event.event_type === "interaction.completed") completed = true;
        break;
      }
      case "step.start": {
        if (event.step?.type === "function_call") {
          throw new Error("Unexpected tool call in answer-only interaction");
        }
        if (
          event.step?.type === "model_output" &&
          typeof event.index === "number"
        ) {
          outputSteps.add(event.index);
        }
        break;
      }
      case "step.stop": {
        if (typeof event.index === "number") outputSteps.delete(event.index);
        break;
      }
      case "step.delta": {
        const delta = event.delta ?? {};
        if (
          typeof event.index === "number" &&
          outputSteps.has(event.index) &&
          delta.type === "text" &&
          typeof delta.text === "string" &&
          delta.text.length > 0
        ) {
          text += delta.text;
          onTextDelta(delta.text);
        }
        break;
      }
    }
  }

  if (!completed || status !== "completed") {
    throw new Error(
      `Answer stream did not complete successfully (${status ?? "missing status"})`,
    );
  }
  const steps: InteractionStep[] = [];
  if (text) {
    steps.push({ type: "model_output", content: [{ type: "text", text }] });
  }

  return { id, status, usage, errors, steps, output_text: text };
}

/**
 * Text returned when the model produces no answer at all, even after the forced
 * text round and one retry. Never return an empty string to a caller: a blank
 * "success" is indistinguishable from a broken client, which is exactly the bug
 * this guards.
 */
export const EMPTY_ANSWER_FALLBACK =
  "抱歉，我這次沒能整理出回答。請再說一次，或換個問法試試。";

const EMPTY_ANSWER_FALLBACK_EN =
  "Sorry, I couldn't put together an answer this time. Please try again or rephrase your question.";

const RETRYABLE_STATUS = [429, 500, 502, 503, 504];
const MAX_TRANSIENT_RETRIES = 2;

/**
 * Classify an SDK/HTTP error so transient failures can be retried and permanent
 * ones surface immediately. Reads whichever shape the SDK happens to throw.
 *
 * @param err The thrown error
 * @returns The HTTP-ish status when one can be found
 */
function errorStatus(err: unknown): number | undefined {
  const e = err as
    | {
        status?: unknown;
        code?: unknown;
        response?: { status?: unknown };
      }
    | undefined;
  const raw = e?.status ?? e?.code ?? e?.response?.status;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function isTransient(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== undefined && RETRYABLE_STATUS.includes(status)) return true;
  const msg = String((err as Error)?.message ?? "");
  return /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(msg);
}

/**
 * Marks an error as caused by the upstream model provider being rate limited,
 * so the HTTP layer can answer 429 instead of a blanket 500.
 */
export class AgentRateLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = "AgentRateLimitError";
  }
}

/**
 * Call the Interactions API with bounded exponential backoff on transient
 * failures, logging one structured line per round so a bad run can be diagnosed
 * after the fact (which round, what the model finished with, what it cost).
 *
 * @param params The `interactions.create` params
 * @param label Round label for the log line
 * @returns The completed interaction
 */
async function createInteraction(
  params: Record<string, unknown>,
  label: string,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<InteractionLike> {
  let lastErr: unknown;
  let publishedText = false;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      // SAFETY: the Interactions endpoint uses the steps schema. Its SDK
      // overloads do not describe our dynamic params; consume only the fields
      // in InteractionLike/InteractionStreamEvent and validate streamed output.
      const interaction = onTextDelta
        ? await collectStream(
            (await (googleGenAi.interactions.create as any)({
              ...params,
              stream: true,
            })) as AsyncIterable<InteractionStreamEvent>,
            (text) => {
              signal?.throwIfAborted();
              // Once text is public, replaying the request would duplicate an
              // already-delivered prefix. Surface failures instead of retrying.
              publishedText = true;
              onTextDelta(text);
            },
          )
        : ((await (googleGenAi.interactions.create as any)(
            params,
          )) as InteractionLike);
      signal?.throwIfAborted();
      const stepTypes = (interaction.steps ?? []).map((s) => s.type);
      const incomplete =
        interaction.status !== undefined &&
        INCOMPLETE_STATUSES.includes(interaction.status);
      const line = JSON.stringify({
        round: label,
        ms: Date.now() - startedAt,
        status: interaction.status,
        steps: stepTypes,
        textLength: (interaction.output_text ?? "").length,
        usage: interaction.usage ?? null,
        errors: interaction.errors ?? null,
        streamed: Boolean(onTextDelta),
        attempt,
      });
      if (incomplete) console.error("[agent-manager]", line);
      else console.info("[agent-manager]", line);
      return interaction;
    } catch (err) {
      lastErr = err;
      const status = errorStatus(err);
      console.error(
        "[agent-manager]",
        JSON.stringify({
          round: label,
          ms: Date.now() - startedAt,
          attempt,
          status: status ?? null,
          transient: isTransient(err),
          message: String((err as Error)?.message ?? err).slice(0, 300),
        }),
      );
      if (
        publishedText ||
        signal?.aborted ||
        attempt === MAX_TRANSIENT_RETRIES ||
        !isTransient(err)
      )
        break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  if (errorStatus(lastErr) === 429) {
    throw new AgentRateLimitError("AI 服務目前忙線（配額不足），請稍後再試。");
  }
  throw lastErr;
}

/**
 * The text the user should see. Prefers the SDK's `output_text` helper and
 * falls back to concatenating the text content of trailing `model_output`
 * steps, so a missing helper never silently becomes an empty answer.
 *
 * @param interaction The completed interaction
 * @returns The model's text, or "" when it produced none
 */
function outputTextOf(interaction: InteractionLike): string {
  if (interaction.output_text) return interaction.output_text;
  const texts: string[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const c of step.content ?? []) {
      if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
    }
  }
  return texts.join("");
}

function functionCallsOf(
  interaction: InteractionLike,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  return (interaction.steps ?? [])
    .filter((s) => s.type === "function_call")
    .map((s) => ({
      id: String(s.id ?? ""),
      name: String(s.name ?? ""),
      arguments: (s.arguments ?? {}) as Record<string, unknown>,
    }));
}

function userInputStep(text: string): InteractionInputStep {
  return { type: "user_input", content: [{ type: "text", text }] };
}

/**
 * Run the Interactions API tool-calling loop, executing local tools and feeding
 * their results back until the model answers or the round budget runs out.
 *
 * Stateful: only the first request carries the conversation history. Every
 * later round sends just the new `function_result` steps plus
 * `previous_interaction_id`, so the model's own `thought` signatures and tool
 * context stay server-side instead of being resent. Tool declarations and the
 * decision-only instruction are re-sent on decision rounds; the answer round
 * receives the original system instruction and disables tools entirely.
 *
 * @param initialInput The conversation so far, as Interactions input steps
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
 * @param options extraTools appends caller-specific tool specs; toolAllowList
 *   is the execution-layer authorization boundary; allowedFunctionNames forces
 *   the first round's tool choice; seedParts appends extra user turns up front;
 *   toolPhaseMode="explicit" requires tool-or-finish decisions, followed by one
 *   answer-only generation. onTextDelta streams that answer as it is generated.
 *   Legacy callers retain auto routing and the non-streaming answer shortcut.
 * @returns The model's final text answer plus parsed tool results. Always
 *   resolves with a `text` field (possibly empty).
 */
export async function runToolLoop(
  initialInput: InteractionInputStep[],
  systemInstruction: string | undefined,
  useModel: string,
  userLocation: { latitude: number; longitude: number } | undefined,
  onToolCall:
    | ((name: string, args: Record<string, unknown>, callId?: string) => void)
    | undefined,
  onToolResult:
    ((name: string, result: unknown, callId?: string) => void) | undefined,
  userId: string | undefined,
  memoryToolsEnabled: boolean,
  allowMemoryWrite: boolean,
  explicitMemoryRequest: boolean,
  execTool: AgentToolExecutor,
  options: {
    language?: AgentLanguage;
    extraTools?: OpenAI.Chat.Completions.ChatCompletionTool[];
    toolAllowList?: string[];
    allowedFunctionNames?: string[];
    seedParts?: string[];
    onTextDelta?: (text: string) => void;
    signal?: AbortSignal;
    toolPhaseMode?: "explicit";
  } = {},
): Promise<RunToolLoopResult> {
  const toolCache = new Map<string, Awaited<ReturnType<AgentToolExecutor>>>();
  // Failed calls get ONE genuine retry (upstream 429/timeouts are transient),
  // then the failure is served from cache: without this a model that keeps
  // retrying the same broken call burns the entire round budget.
  const failureCounts = new Map<string, number>();
  const FAILURE_RETRY_ALLOWANCE = 1;
  const tools = buildInteractionTools(
    userId,
    memoryToolsEnabled,
    options.extraTools ?? [],
    options.toolAllowList,
  );
  const explicitToolPhase = options.toolPhaseMode === "explicit";
  const businessToolNames = new Set(tools.map((tool) => tool.name));
  if (explicitToolPhase) {
    if (businessToolNames.has(FINISH_TOOL_PHASE_NAME)) {
      throw new Error("Reserved finish control name collision");
    }
    if (
      options.allowedFunctionNames?.some((name) => !businessToolNames.has(name))
    ) {
      throw new Error(
        "Invalid forced first-tool selection: tool is not declared",
      );
    }
  }
  const decisionTools = explicitToolPhase
    ? [...tools, FINISH_TOOL_PHASE_TOOL]
    : tools;
  const decisionInstruction = explicitToolPhase
    ? [systemInstruction, TOOL_DECISION_INSTRUCTION]
        .filter(Boolean)
        .join("\n\n")
    : systemInstruction;
  const toolResults: RunToolLoopResult["toolResults"] = [];

  const pending: InteractionInputStep[] = [
    ...initialInput,
    ...(options.seedParts ?? []).map(userInputStep),
  ];
  let previousInteractionId: string | undefined;
  // With no available business tools, answer the original input directly.
  let toolPhaseFinished = explicitToolPhase && tools.length === 0;

  for (let round = 0; round < MAX_ROUNDS && !toolPhaseFinished; round++) {
    options.signal?.throwIfAborted();
    const interaction = await createInteraction(
      {
        model: useModel,
        input: pending.splice(0, pending.length),
        ...(previousInteractionId
          ? { previous_interaction_id: previousInteractionId }
          : {}),
        system_instruction: decisionInstruction,
        tools: decisionTools,
        generation_config: buildGenerationConfig(
          round === 0 && options.allowedFunctionNames?.length
            ? "forced"
            : explicitToolPhase
              ? "decision"
              : "route",
          options.allowedFunctionNames,
        ),
      },
      `route-${round}`,
      undefined,
      options.signal,
    );

    options.signal?.throwIfAborted();
    previousInteractionId = interaction.id;

    const calls = functionCallsOf(interaction);
    if (explicitToolPhase) {
      assertToolDecision(
        interaction,
        calls,
        round === 0 ? options.allowedFunctionNames : undefined,
      );
    }
    if (!calls.length) {
      const text = outputTextOf(interaction);
      if (text && !options.onTextDelta) return { text, toolResults };
      // The model has finished choosing tools. Streaming callers must generate
      // an answer in a separate tool-disabled round: only there is it safe to
      // publish text before knowing how the interaction ends.
      break;
    }

    const hasBusinessCalls = calls.some(
      (call) => call.name !== FINISH_TOOL_PHASE_NAME,
    );
    for (const call of calls) {
      options.signal?.throwIfAborted();
      const { name, arguments: args } = call;
      if (explicitToolPhase && name === FINISH_TOOL_PHASE_NAME) {
        // A same-round lookup can change what else needs checking. Acknowledge
        // every call ID, but only a finish-only decision may end the phase.
        const ready = !hasBusinessCalls;
        pending.push({
          type: "function_result",
          call_id: call.id,
          name,
          result: ready
            ? { ready: true }
            : {
                ready: false,
                error: "finish_must_be_requested_alone_after_tool_results",
              },
          is_error: !ready,
        });
        toolPhaseFinished = ready;
        continue;
      }
      const callId = call.id || randomUUID();
      onToolCall?.(name, args, callId);

      // Execution-layer authorization boundary. `undefined` declares every tool
      // (no interception); any array (including `[]` = deny-all) is a
      // membership check — an unauthorized tool is never executed.
      if (
        (explicitToolPhase && !businessToolNames.has(name)) ||
        (options.toolAllowList !== undefined &&
          !options.toolAllowList.includes(name))
      ) {
        console.warn(`[agent-manager] blocked unauthorized tool: ${name}`);
        const blocked = { error: "tool_not_allowed" };
        onToolResult?.(name, blocked, callId);
        toolResults.push({ name, args, result: blocked });
        pending.push({
          type: "function_result",
          call_id: call.id,
          name,
          result: blocked,
          is_error: true,
        });
        continue;
      }

      const cacheKey = stableCacheKey(name, args);
      let resultStr: Awaited<ReturnType<AgentToolExecutor>>;
      if (toolCache.has(cacheKey)) {
        resultStr = toolCache.get(cacheKey)!;
      } else {
        resultStr = await execTool(name, args, userLocation, userId, {
          language: options.language,
          allowMemoryWrite,
          explicitMemoryRequest,
          ...(options.signal
            ? { isCurrent: () => !options.signal!.aborted }
            : {}),
        });
        if (
          isSuccessResult(
            typeof resultStr === "string"
              ? resultStr
              : JSON.stringify(resultStr.clientResult),
          )
        ) {
          // A different plan invalidates cached instructions and older plans.
          if (name === "planAccessibleRoute") {
            for (const key of toolCache.keys()) {
              if (
                key.startsWith("planAccessibleRoute\0") ||
                key.startsWith("getNavInstructions\0")
              )
                toolCache.delete(key);
            }
          }
          toolCache.set(cacheKey, resultStr);
          failureCounts.delete(cacheKey);
        } else {
          const failures = (failureCounts.get(cacheKey) ?? 0) + 1;
          failureCounts.set(cacheKey, failures);
          if (failures > FAILURE_RETRY_ALLOWANCE) {
            toolCache.set(cacheKey, resultStr);
          }
        }
      }

      let parsedResult: unknown;
      try {
        parsedResult =
          typeof resultStr === "string"
            ? JSON.parse(resultStr)
            : resultStr.clientResult;
      } catch {
        parsedResult = { result: resultStr };
      }

      options.signal?.throwIfAborted();
      const modelResult =
        typeof resultStr === "string"
          ? projectToolResult(parsedResult).modelResult
          : resultStr.modelResult;
      onToolResult?.(name, parsedResult, callId);
      toolResults.push({ name, args, result: parsedResult });

      pending.push({
        type: "function_result",
        call_id: call.id,
        name,
        result:
          modelResult && typeof modelResult === "object"
            ? modelResult
            : { result: modelResult },
        is_error: !isSuccessResult(
          typeof resultStr === "string"
            ? resultStr
            : JSON.stringify(resultStr.clientResult),
        ),
      });
    }
  }

  if (explicitToolPhase && !toolPhaseFinished) {
    // Reaching the round limit is a backend stop, not evidence that the model
    // finished all lookups. Preserve the pending results and disclose limits.
    pending.push(
      userInputStep(
        "工具查詢已達回合上限。請只根據已取得的資訊回答，說明查詢限制與尚未確認之處；不要宣稱所有查詢已成功完成。",
      ),
    );
  }

  // Generate the user-facing answer once, after the explicit finish/control
  // result (or a bounded backend stop). Legacy empty turns get a text nudge.
  const finalInput: InteractionInputStep[] = pending.length
    ? pending
    : [
        userInputStep(
          "請根據目前已取得的資訊直接回答使用者，不要再呼叫工具。若資訊不足，說明已查到什麼、還缺什麼。",
        ),
      ];

  options.signal?.throwIfAborted();
  const finalInteraction = await createInteraction(
    {
      model: useModel,
      input: finalInput,
      ...(previousInteractionId
        ? { previous_interaction_id: previousInteractionId }
        : {}),
      system_instruction: systemInstruction,
      generation_config: buildGenerationConfig("final"),
    },
    "final",
    options.onTextDelta,
    options.signal,
  );

  options.signal?.throwIfAborted();
  const finalText = outputTextOf(finalInteraction);
  if (finalText) return { text: finalText, toolResults };

  // The forced-text round produced nothing. Retry once WITHOUT the accumulated
  // interaction chain: a poisoned or over-long context is the likeliest cause,
  // so re-ask from a clean slate carrying only what the tools found.
  const retry = await createInteraction(
    {
      model: useModel,
      input: [
        userInputStep(
          [
            "請依系統指示中的語言偏好回答使用者的問題；未指定偏好時沿用使用者的語言。",
            toolResults.length
              ? `已取得的工具結果（JSON）：\n${JSON.stringify(toolResults.map((item) => ({ ...item, result: projectToolResult(item.result).modelResult }))).slice(0, 12000)}`
              : "目前沒有可用的工具結果。",
          ].join("\n\n"),
        ),
      ],
      system_instruction: systemInstruction,
      generation_config: buildGenerationConfig("final"),
    },
    "final-retry",
    options.onTextDelta,
    options.signal,
  );

  options.signal?.throwIfAborted();
  const retryText = outputTextOf(retry);
  if (retryText) return { text: retryText, toolResults };

  console.error(
    "[agent-manager]",
    JSON.stringify({
      round: "final-retry",
      event: "empty_answer_fallback",
      toolResultCount: toolResults.length,
    }),
  );
  return {
    text:
      options.language === "en"
        ? EMPTY_ANSWER_FALLBACK_EN
        : EMPTY_ANSWER_FALLBACK,
    toolResults,
  };
}

/**
 * Text-only completion: append optional seed parts (e.g. serialized tool
 * results) as user turns, then run a single interaction with tool calling
 * disabled so the model can ONLY emit text. Calls no tools and has no side
 * effects — used by the LINE deterministic path to summarize after the executor
 * has already run every step.
 *
 * @param params input/systemInstruction/model plus optional seedParts.
 * @returns The model's text answer (possibly empty).
 */
export async function summarizeWithContext(params: {
  input: InteractionInputStep[];
  systemInstruction: string | undefined;
  model: string;
  seedParts?: string[];
}): Promise<string> {
  const input = [
    ...params.input,
    ...(params.seedParts ?? []).map(userInputStep),
  ];
  const interaction = await createInteraction(
    {
      model: params.model,
      input,
      system_instruction: params.systemInstruction,
      generation_config: buildGenerationConfig("final"),
    },
    "summarize",
  );
  return outputTextOf(interaction);
}

/**
 * The Agent Manager façade: a named-field entry point wrapping `runToolLoop`'s
 * positional parameters (Input → Manager/Loop → Response).
 *
 * @param input The agent input contract (see AgentInput).
 * @returns The final text answer plus parsed tool results.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  return runToolLoop(
    input.input,
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
    {
      language: input.language,
      extraTools: input.extraTools,
      toolAllowList: input.toolAllowList,
      allowedFunctionNames: input.allowedFunctionNames,
      seedParts: input.seedParts,
      onTextDelta: input.onTextDelta,
      signal: input.signal,
      toolPhaseMode: input.toolPhaseMode,
    },
  );
}

/**
 * Run EXACTLY ONE routing round against the real tool catalogue and routing
 * config, reporting which tools the model chose. Does NOT execute any tool and
 * never touches MongoDB or external APIs — for the offline tool-selection eval
 * only. Mirrors the first round of `runToolLoop` via the shared
 * `buildGenerationConfig`.
 *
 * @param userMessage The single user query to route
 * @param systemInstruction System prompt (assemble via withUserLocation upstream)
 * @param opts memoryEnabled toggles memory tools into the catalogue when userId
 *   is present; model overrides the default
 * @returns The called tool names (in order), any emitted text, and the raw
 *   interaction
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
  // Defaults to enabled when a userId is present: callers that authenticate a
  // user (including the offline eval) expect the memory tools in the catalogue
  // without having to opt in twice.
  const tools = buildInteractionTools(
    opts.userId,
    opts.memoryEnabled ?? Boolean(opts.userId),
  );
  const interaction = await createInteraction(
    {
      model: opts.model ?? model,
      input: [userInputStep(userMessage)],
      system_instruction: systemInstruction,
      tools,
      generation_config: buildGenerationConfig("route"),
    },
    "route-once",
  );

  return {
    calledTools: functionCallsOf(interaction).map((c) => c.name),
    text: outputTextOf(interaction),
    raw: interaction,
  };
}
