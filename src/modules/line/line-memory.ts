import { redisClient } from "../../config/redis";

export interface LineChatMessage {
  role: "user" | "assistant";
  content: string;
}

const LINE_CHAT_TTL_SEC = 30 * 60;
const MAX_LINE_CHAT_MESSAGES = 20;
const LINE_RENAME_TTL_SEC = 5 * 60;

function lineChatKey(lineUserId: string): string {
  return `line:chat:${lineUserId}`;
}

function lineRenameKey(lineUserId: string): string {
  return `line:rename:${lineUserId}`;
}

function isLineChatMessage(value: unknown): value is LineChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

/**
 * @param lineUserId LINE user identifier used to scope the conversation.
 * @returns Up to the latest 20 valid user and assistant messages.
 */
export async function getLineChatHistory(
  lineUserId: string,
): Promise<LineChatMessage[]> {
  if (!redisClient) {
    console.error("[line-memory] Redis unavailable");
    return [];
  }

  try {
    const raw = await redisClient.get(lineChatKey(lineUserId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLineChatMessage).slice(-MAX_LINE_CHAT_MESSAGES);
  } catch (error) {
    console.error("[line-memory] failed to read chat history", error);
    return [];
  }
}

/**
 * @param lineUserId LINE user identifier used to scope the conversation.
 * @param userText User message to append.
 * @param assistantText User-facing assistant reply to append.
 * @returns Nothing; Redis failures are logged and ignored.
 */
export async function appendLineChatTurn(
  lineUserId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!redisClient) {
    console.error("[line-memory] Redis unavailable");
    return;
  }

  try {
    const history = await getLineChatHistory(lineUserId);
    const updated = [
      ...history,
      { role: "user" as const, content: userText },
      { role: "assistant" as const, content: assistantText },
    ].slice(-MAX_LINE_CHAT_MESSAGES);
    await redisClient.set(
      lineChatKey(lineUserId),
      JSON.stringify(updated),
      "EX",
      LINE_CHAT_TTL_SEC,
    );
  } catch (error) {
    console.error("[line-memory] failed to append chat turn", error);
  }
}

/**
 * Marks a bound emergency-contact record as awaiting a new display name, so the
 * user's next plain message is read as that name. One slot per LINE user, expiring
 * after 5 minutes; a Redis outage simply means the next message is treated as
 * ordinary chat.
 *
 * @param lineUserId LINE user identifier used to scope the pending edit.
 * @param contactId The emergency-contact id being renamed.
 * @returns Nothing; Redis failures are logged and ignored.
 */
export async function setPendingRename(
  lineUserId: string,
  contactId: string,
): Promise<void> {
  if (!redisClient) {
    console.error("[line-memory] Redis unavailable");
    return;
  }
  try {
    await redisClient.set(
      lineRenameKey(lineUserId),
      contactId,
      "EX",
      LINE_RENAME_TTL_SEC,
    );
  } catch (error) {
    console.error("[line-memory] failed to set pending rename", error);
  }
}

/**
 * @param lineUserId LINE user identifier used to scope the pending edit.
 * @returns The contact id awaiting a new display name, or null when none.
 */
export async function getPendingRename(
  lineUserId: string,
): Promise<string | null> {
  if (!redisClient) return null;
  try {
    return await redisClient.get(lineRenameKey(lineUserId));
  } catch (error) {
    console.error("[line-memory] failed to read pending rename", error);
    return null;
  }
}

/**
 * @param lineUserId LINE user identifier used to scope the pending edit.
 * @returns Nothing; Redis failures are logged and ignored.
 */
export async function clearPendingRename(lineUserId: string): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.del(lineRenameKey(lineUserId));
  } catch (error) {
    console.error("[line-memory] failed to clear pending rename", error);
  }
}
