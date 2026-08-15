import type OpenAI from "openai";
import type { Content, GenerateContentResponse } from "@google/genai";

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
  },
) => Promise<string>;

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
  raw: GenerateContentResponse;
}

/**
 * The named-field input contract for the Agent Manager façade (`runAgent`),
 * making the Input layer explicit and shared across the ai/agent/line surfaces.
 */
export interface AgentInput {
  contents: Content[];
  systemInstruction: string | undefined;
  model: string;
  execTool: AgentToolExecutor;
  userLocation?: { latitude: number; longitude: number };
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
  userId?: string;
  memoryToolsEnabled?: boolean;
  allowMemoryWrite?: boolean;
  explicitMemoryRequest?: boolean;
  extraTools?: OpenAI.Chat.Completions.ChatCompletionTool[];
}
