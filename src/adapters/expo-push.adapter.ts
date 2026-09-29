import {
  EXPO_PUSH_CHUNK_SIZE,
  EXPO_PUSH_SEND_URL,
  EXPO_PUSH_TIMEOUT_MS,
} from "../constants/push";

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
  channelId?: string;
}

export type ExpoPushTicket =
  | { status: "ok"; id: string }
  | {
      status: "error";
      message: string;
      details?: { error?: string; [key: string]: unknown };
    };

interface ExpoPushSendResponse {
  data?: ExpoPushTicket[];
  errors?: Array<{ code?: string; message?: string }>;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/json",
  };
  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

async function sendChunk(
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> {
  const res = await fetch(EXPO_PUSH_SEND_URL, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
  });
  const payload = (await res
    .json()
    .catch(() => null)) as ExpoPushSendResponse | null;
  if (!res.ok || !Array.isArray(payload?.data)) {
    const detail = payload?.errors?.map((e) => e.code ?? e.message).join(",");
    throw new Error(
      `Expo push send failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (payload.data.length !== messages.length) {
    throw new Error(
      `Expo push returned ${payload.data.length} tickets for ${messages.length} messages`,
    );
  }
  return payload.data;
}

/**
 * Sends push messages through the Expo Push Service, batching at the service's
 * per-request limit. Tickets are returned in the same order as `messages`, so
 * `tickets[i]` belongs to `messages[i]`. A batch that fails as a whole yields an
 * error ticket per message instead of discarding the other batches' results.
 *
 * @param messages Messages to deliver; each targets one Expo push token.
 * @returns One ticket per message.
 */
export async function sendExpoPushMessages(
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> {
  const tickets: ExpoPushTicket[] = [];
  for (let i = 0; i < messages.length; i += EXPO_PUSH_CHUNK_SIZE) {
    const chunk = messages.slice(i, i + EXPO_PUSH_CHUNK_SIZE);
    try {
      tickets.push(...(await sendChunk(chunk)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tickets.push(
        ...chunk.map((): ExpoPushTicket => ({ status: "error", message })),
      );
    }
  }
  return tickets;
}
