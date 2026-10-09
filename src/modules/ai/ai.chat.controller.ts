import type {
  RouteContextInput,
  RoutingPreferences,
} from "../../types/agent-route";
import type { Request, Response } from "express";
import { model } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import {
  runChatAgent,
  toInteractionInput,
  type OAIMessage,
} from "./ai-chat.service";
import { getMemorySettings, searchMemoriesForPrompt } from "./memory.service";
import {
  formatPriorToolContext,
  summarizeToolResult,
  type ToolSummary,
} from "../agent/conversation-context";
import {
  CHAT_SYSTEM_PROMPT,
  withUserLocation,
  withCurrentDate,
} from "../../config/ai/chat-prompt";
import type { IUser } from "../../types";
import type { AgentLanguage } from "../../types/agent";
import { AgentRateLimitError } from "../agent/agent-manager.service";

function sendSse(res: Response, event: string, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Reads the caller injected by the optionalAuth middleware.
 *
 * The middleware already rejected expired and invalid tokens, so reaching this
 * point without `req.auth` means the caller is genuinely anonymous.
 *
 * @param req Incoming request.
 * @returns The authenticated user, or null for an anonymous caller.
 */
function resolveAuthUser(req: Request): IUser | null {
  return req.auth?.user ?? null;
}

const CATEGORY_LABELS: Record<string, string> = {
  preference: "偏好",
  place: "地點",
  habit: "習慣",
  context: "情境",
};

function latestUserText(messages: OAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/**
 * Tool summaries the client attached to earlier assistant turns (taken from
 * the `summary` of each `tool_result` event), in chronological order.
 */
function priorToolSummaries(messages: OAIMessage[]): ToolSummary[] {
  const out: ToolSummary[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const summaries = (message as { tool_summaries?: ToolSummary[] })
      .tool_summaries;
    if (Array.isArray(summaries)) out.push(...summaries);
  }
  return out;
}

function isExplicitMemoryRequest(text: string): boolean {
  if (/(忘記|刪除|不要記|別記|不必記)/.test(text)) return false;
  return /(記住|記得|幫我記|幫我記住|請記住|remember this|remember that)/i.test(
    text,
  );
}

function isMemoryDeletionRequest(text: string): boolean {
  return /(忘記|刪除|不要記|別記|不必記|forget|delete.*memory)/i.test(text);
}

export async function aiChat(req: Request, res: Response): Promise<void> {
  const {
    messages: rawMessages,
    language,
    stream,
    userLocation,
    routeContext,
    routingPreferences,
  } = req.body as {
    model?: string;
    messages: OAIMessage[];
    language?: AgentLanguage;
    stream?: boolean;
    temperature?: number;
    userLocation?: { latitude: number; longitude: number };
    routeContext?: RouteContextInput;
    routingPreferences?: RoutingPreferences;
  };

  const cancellation = new AbortController();
  res.once("close", () => cancellation.abort());
  const authUser = resolveAuthUser(req);
  const userId = authUser ? String(authUser._id) : undefined;
  const latestText = latestUserText(rawMessages);

  let systemPrompt = withCurrentDate(
    withUserLocation(CHAT_SYSTEM_PROMPT, userLocation),
  );
  let memoryEnabled = false;
  let memoryToolsEnabled = false;
  let allowMemoryWrite = false;
  const explicitMemoryRequest = isExplicitMemoryRequest(latestText);
  const memoryDeletionRequest = isMemoryDeletionRequest(latestText);
  if (userId) {
    try {
      memoryEnabled = (await getMemorySettings(userId)).memoryEnabled;
      allowMemoryWrite = memoryEnabled || explicitMemoryRequest;
      memoryToolsEnabled = allowMemoryWrite || memoryDeletionRequest;

      const memories = await searchMemoriesForPrompt(userId, latestText);
      if (memories.length) {
        systemPrompt += `\n\n【使用者記憶】以下是與本次問題相關、使用者可管理的記憶，請只在確實相關時自然運用：`;
        for (const m of memories) {
          const label = CATEGORY_LABELS[m.category] ?? m.category;
          systemPrompt += `\n- [${label}] ${m.promptText ?? m.content} (id:${m._id})`;
        }
        systemPrompt += `\n\n不要暴露完整記憶資料；若使用者要求忘記，使用上方 id 呼叫 deleteMemory。`;
      }
    } catch (err) {
      console.error("[ai/chat] loadMemories failed:", err);
    }
  }

  systemPrompt += formatPriorToolContext(priorToolSummaries(rawMessages));

  const messages: OAIMessage[] = [{ role: "system", content: systemPrompt }];
  messages.push(...rawMessages.filter((m) => m.role !== "system"));

  const { systemInstruction, input } = toInteractionInput(messages);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      // Stream the answer as it is generated. `streamedChars` tracks whether
      // anything reached the client, so the empty-answer guard below does not
      // re-send text the client already has.
      let streamedChars = 0;
      const loopResult = await runChatAgent({
        language,
        input,
        systemInstruction,
        model,
        userLocation,
        routeContext,
        routingPreferences,
        signal: cancellation.signal,
        onToolCall: (name, args, callId) =>
          sendSse(res, "tool_call", { name, args, callId }),
        onToolResult: (name, result, callId) =>
          sendSse(res, "tool_result", {
            name,
            callId,
            result,
            summary: summarizeToolResult(result),
          }),
        onTextDelta: (text) => {
          streamedChars += text.length;
          sendSse(res, "token", { text });
        },
        userId,
        memoryToolsEnabled,
        allowMemoryWrite,
        explicitMemoryRequest,
      });

      const streamText = loopResult.text ?? "";
      if (streamedChars > 0) {
        // Already delivered incrementally; nothing more to send.
      } else if (streamText) {
        // The agent produced text without streaming it (e.g. the empty-answer
        // fallback string), so deliver it in one chunk.
        sendSse(res, "token", { text: streamText });
      } else {
        // Never emit an empty token as if it were a successful answer: that is
        // indistinguishable from a broken client. Surface it as an error.
        console.error("[ai/chat stream] empty answer from agent");
        sendSse(res, "error", {
          code: ResponseCode.INTERNAL_ERROR,
          message: ERROR_MESSAGE.INTERNAL,
        });
      }
      if (cancellation.signal.aborted) return;
      res.write("event: done\ndata: done\n\n");
      res.end();
    } catch (error: any) {
      if (cancellation.signal.aborted) return;
      console.error("[ai/chat stream]", error);
      sendSse(res, "error", {
        code:
          error instanceof AgentRateLimitError
            ? ResponseCode.TOO_MANY_REQUESTS
            : ResponseCode.INTERNAL_ERROR,
        message: error?.message ?? ERROR_MESSAGE.INTERNAL,
      });
      if (cancellation.signal.aborted) return;
      res.write("event: done\ndata: done\n\n");
      res.end();
    }
    return;
  }

  try {
    const loopResult = await runChatAgent({
      language,
      input,
      systemInstruction,
      model,
      userLocation,
      routeContext,
      routingPreferences,
      signal: cancellation.signal,
      userId,
      memoryToolsEnabled,
      allowMemoryWrite,
      explicitMemoryRequest,
    });

    if (cancellation.signal.aborted) return;
    const text = loopResult.text ?? "";
    if (!text) {
      console.error("[ai/chat] empty answer from agent");
      sendResponse(
        res,
        false,
        "error",
        ResponseCode.INTERNAL_ERROR,
        ERROR_MESSAGE.INTERNAL,
      );
      return;
    }
    sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error: any) {
    if (cancellation.signal.aborted) return;
    console.error("[ai/chat]", error);
    sendResponse(
      res,
      false,
      "error",
      error instanceof AgentRateLimitError
        ? ResponseCode.TOO_MANY_REQUESTS
        : ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL,
    );
  }
}
