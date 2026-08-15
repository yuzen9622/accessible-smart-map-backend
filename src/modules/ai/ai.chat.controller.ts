import type { Request, Response } from "express";
import { model } from "../../config/ai";
import { sendResponse } from "../../config/lib";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { authenticateToken } from "../../config/auth";
import {
  runChatAgent,
  toGeminiHistory,
  type OAIMessage,
} from "./ai-chat.service";
import { getMemorySettings, searchMemoriesForPrompt } from "./memory.service";
import {
  CHAT_SYSTEM_PROMPT,
  withUserLocation,
  withCurrentDate,
} from "../../config/ai/chat-prompt";
import type { IUser } from "../../types";

function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function resolveAuthUser(
  req: Request,
): Promise<{ user: IUser | null; expired: boolean; invalid: boolean }> {
  const authHeader = req.headers.authorization;
  if (!authHeader) return { user: null, expired: false, invalid: false };
  const token = authHeader.split(" ")[1];
  if (!token) return { user: null, expired: false, invalid: false };
  const result = await authenticateToken(token);
  if (!result.ok) {
    return { user: null, expired: result.expired, invalid: !result.expired };
  }
  return { user: result.user, expired: false, invalid: false };
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
    stream,
    userLocation,
  } = req.body as {
    model?: string;
    messages: OAIMessage[];
    stream?: boolean;
    temperature?: number;
    userLocation?: { latitude: number; longitude: number };
  };

  const authResult = await resolveAuthUser(req);
  if (authResult.expired) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED,
    );
  }
  if (authResult.invalid) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.FORBIDDEN,
      ResponseMessage.FORBIDDEN,
    );
  }
  const authUser = authResult.user;
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

  const messages: OAIMessage[] = [{ role: "system", content: systemPrompt }];
  messages.push(...rawMessages.filter((m) => m.role !== "system"));

  const { systemInstruction, contents } = toGeminiHistory(messages);

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const loopResult = await runChatAgent({
        contents,
        systemInstruction,
        model,
        userLocation,
        onToolCall: (name, args) => sendSse(res, "tool_call", { name, args }),
        onToolResult: (name, result) =>
          sendSse(res, "tool_result", { name, result }),
        userId,
        memoryToolsEnabled,
        allowMemoryWrite,
        explicitMemoryRequest,
      });

      sendSse(res, "token", { text: loopResult.text ?? "" });
      res.write("event: done\ndata: done\n\n");
      res.end();
    } catch (error: any) {
      console.error("[ai/chat stream]", error);
      sendSse(res, "error", {
        code: ResponseCode.INTERNAL_ERROR,
        message: error?.message ?? ERROR_MESSAGE.INTERNAL,
      });
      res.write("event: done\ndata: done\n\n");
      res.end();
    }
    return;
  }

  try {
    const loopResult = await runChatAgent({
      contents,
      systemInstruction,
      model,
      userLocation,
      userId,
      memoryToolsEnabled,
      allowMemoryWrite,
      explicitMemoryRequest,
    });

    const text = loopResult.text ?? "";
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
    console.error("[ai/chat]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL,
    );
  }
}
