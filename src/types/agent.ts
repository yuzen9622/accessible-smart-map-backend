import type OpenAI from "openai";
import type { ProjectedToolResult } from "./agent-route";
import type { RouteContextInput, RoutingPreferences } from "./agent-route";
import type { z } from "zod";
import type { AgentLanguageSchema } from "../schemas/agent-language.schema";

export type AgentLanguage = z.infer<typeof AgentLanguageSchema>;

/**
 * One `{ type: "function" }` entry of the Interactions API `tools` array. Kept
 * as a local structural type (rather than importing the SDK's internal
 * `FunctionT`) because that name is not exported from `@google/genai`.
 */
export interface InteractionFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * One step of an Interactions API `input`. Only the step kinds this backend
 * actually sends are modelled: the user's turns, the model's own steps echoed
 * back verbatim (so `thought` signatures round-trip), and our tool results.
 */
export type InteractionInputStep =
  | { type: "user_input"; content: Array<{ type: "text"; text: string }> }
  | {
      type: "function_result";
      call_id: string;
      name?: string;
      result: unknown;
      is_error?: boolean;
    }
  | Record<string, unknown>;

/**
 * The tool executor contract injected into the agent loop. Defined as a
 * standalone signature (not `typeof executeLocalTool`) so the agent core never
 * takes a reverse type dependency on the ai module; concrete executors conform
 * structurally at the injection site.
 */
export type AgentToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  userLocation?: { latitude: number; longitude: number },
  userId?: string,
  memoryOptions?: {
    allowMemoryWrite?: boolean;
    explicitMemoryRequest?: boolean;
    routeToken?: string;
    isCurrent?: () => boolean;
  },
) => Promise<string | ProjectedToolResult>;

export interface RunToolLoopResult {
  text?: string;
  toolResults: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
}

export type AgentResult = RunToolLoopResult;

export interface RouteOnceResult {
  calledTools: string[];
  text: string;
  raw: unknown;
}

/**
 * The named-field input contract for the Agent Manager façade (`runAgent`),
 * making the Input layer explicit and shared across the ai/agent/line surfaces.
 */
export interface AgentInput {
  /** Current frontend language preference; omission preserves language inference. */
  language?: AgentLanguage;
  input: InteractionInputStep[];
  systemInstruction: string | undefined;
  model: string;
  execTool: AgentToolExecutor;
  userLocation?: { latitude: number; longitude: number };
  onToolCall?: (
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ) => void;
  onToolResult?: (name: string, result: unknown, callId?: string) => void;
  routeContext?: RouteContextInput;
  routingPreferences?: RoutingPreferences;
  signal?: AbortSignal;
  userId?: string;
  memoryToolsEnabled?: boolean;
  allowMemoryWrite?: boolean;
  explicitMemoryRequest?: boolean;
  extraTools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolAllowList?: string[];
  allowedFunctionNames?: string[];
  seedParts?: string[];
  /** Streams the answer's text chunks as they are generated. */
  onTextDelta?: (text: string) => void;
}
