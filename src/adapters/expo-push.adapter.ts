import {
  EXPO_PUSH_CHUNK_SIZE,
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_RECEIPT_CHUNK_SIZE,
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
  ttl?: number;
}

export type ExpoPushTicket =
  | { status: "ok"; id: string | null }
  | {
      status: "error";
      message: string;
      details?: { error?: string; [key: string]: unknown };
    };

interface ExpoPushSendResponse {
  data?: unknown[];
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
  // Validate independently: one malformed ticket must not discard other
  // accepted tickets and accidentally cause their caller to resend them.
  return payload.data.map((raw): ExpoPushTicket => {
    if (isRecord(raw)) {
      if (raw.status === "ok") {
        // Acceptance and receipt trackability are independent. A missing ID
        // must not turn an accepted notification into a resendable failure.
        return {
          status: "ok",
          id:
            typeof raw.id === "string" && raw.id.trim().length > 0
              ? raw.id
              : null,
        };
      }
      if (
        raw.status === "error" &&
        (raw.message === undefined || typeof raw.message === "string") &&
        (raw.details === undefined ||
          (isRecord(raw.details) &&
            (raw.details.error === undefined ||
              typeof raw.details.error === "string")))
      ) {
        return {
          status: "error",
          message:
            typeof raw.message === "string"
              ? raw.message
              : "Expo push rejected",
          ...(isRecord(raw.details) && typeof raw.details.error === "string"
            ? { details: { error: raw.details.error } }
            : {}),
        };
      }
    }
    return { status: "error", message: "Invalid Expo push ticket response" };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export type ExpoPushReceipt =
  { status: "ok" } | { status: "error"; errorCode?: string };

/** Fetches one chunk; throws on HTTP failure, timeout or a malformed envelope. */
async function getReceiptChunk(
  ids: string[],
): Promise<Map<string, ExpoPushReceipt>> {
  const res = await fetch(EXPO_PUSH_RECEIPTS_URL, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
  });
  const payload = (await res.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  const data = payload?.data;
  if (
    !res.ok ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data)
  ) {
    throw new Error(`Expo receipt lookup failed with HTTP ${res.status}`);
  }
  const wanted = new Set(ids);
  const receipts = new Map<string, ExpoPushReceipt>();
  for (const [id, raw] of Object.entries(data)) {
    // Unrequested ids and malformed entries are ignored: the id stays unresolved.
    if (!wanted.has(id) || !isRecord(raw)) continue;
    const { status, details, message } = raw;
    if (
      (message !== undefined && typeof message !== "string") ||
      (details !== undefined &&
        (!isRecord(details) ||
          (details.error !== undefined && typeof details.error !== "string")))
    )
      continue;
    if (status === "ok") receipts.set(id, { status: "ok" });
    else if (status === "error") {
      const code = isRecord(details) ? details.error : undefined;
      receipts.set(id, {
        status: "error",
        ...(typeof code === "string" ? { errorCode: code } : {}),
      });
    }
  }
  return receipts;
}

/**
 * Looks up Expo push receipts, batching at the service's per-request limit.
 * Ids Expo has not resolved (or whose entry is malformed) are absent from the
 * result. Never sends a notification.
 *
 * @param ids Ticket ids returned by the send API
 * @returns Resolved receipts by ticket id; chunks that failed are reported in `failedIds`
 */
export async function getExpoPushReceipts(ids: string[]): Promise<{
  receipts: Map<string, ExpoPushReceipt>;
  failedIds: Set<string>;
}> {
  const receipts = new Map<string, ExpoPushReceipt>();
  const failedIds = new Set<string>();
  for (let i = 0; i < ids.length; i += EXPO_RECEIPT_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + EXPO_RECEIPT_CHUNK_SIZE);
    try {
      for (const [id, r] of await getReceiptChunk(chunk)) receipts.set(id, r);
    } catch {
      chunk.forEach((id) => failedIds.add(id));
    }
  }
  return { receipts, failedIds };
}
