import { createHash } from "node:crypto";
import {
  findDeliveryTokens,
  isPushDeliveryActive,
  PUSH_DELIVERY_DB_OPTIONS,
} from "./user.push-delivery.repository";
import {
  attachReceiptTicket,
  discardReceiptAttempt,
  failReceiptAttempt,
  finishImmediateReceiptCleanup,
  reserveReceiptAttempt,
} from "./user.push-receipt.repository";
import { normalizeReceiptErrorCode } from "../../utils/push-error-code";
import {
  deletePushTokenForUser,
  ensureRegistrationVersion,
  deletePushTokens,
  findPushTokensByUserId,
  upsertPushToken,
} from "./user.push-token.repository";
import { findActiveSessionsByUserId } from "./user.auth-session.repository";
import {
  sendExpoPushMessages,
  type ExpoPushMessage,
} from "../../adapters/expo-push.adapter";
import {
  EXPO_DEVICE_NOT_REGISTERED,
  EXPO_PUSH_CHUNK_SIZE,
  PUSH_DEFAULT_LOCALE,
} from "../../constants/push";
import type { IPushToken, PushPlatform } from "../../types";
import type { ExpoPushTicket } from "../../adapters/expo-push.adapter";

type VersionedToken = IPushToken & { registrationVersion: string };

/** Fences legacy rows with a version; null when the registration vanished. */
async function withVersion(token: IPushToken): Promise<VersionedToken | null> {
  const registrationVersion = await ensureRegistrationVersion(token);
  return registrationVersion ? { ...token, registrationVersion } : null;
}

/**
 * Records the outcome of a send on its pre-reserved attempt. Tracking trouble
 * is logged with a controlled message and never alters acceptance handling or
 * triggers another send.
 */
async function recordTicket(
  attemptId: string,
  ticket: ExpoPushTicket | undefined,
): Promise<void> {
  try {
    if (ticket?.status === "ok") {
      if (ticket.id === null) {
        await failReceiptAttempt(
          attemptId,
          "accepted_ticket_untrackable",
          "unknown",
        );
      } else if (!(await attachReceiptTicket(attemptId, ticket.id))) {
        console.warn("[user.push] receipt tracking skipped for a ticket");
      }
    } else {
      const providerCode = ticket?.details?.error;
      if (providerCode) {
        await failReceiptAttempt(
          attemptId,
          normalizeReceiptErrorCode(providerCode),
          providerCode === EXPO_DEVICE_NOT_REGISTERED
            ? "cleanup_pending"
            : "failed",
        );
      } else {
        await failReceiptAttempt(attemptId, "send_ambiguous", "unknown");
      }
    }
  } catch {
    console.warn("[user.push] receipt tracking failed; ticket left untracked");
  }
}

/** Immediate rejection cleanup is recoverable independently of notification sends. */
async function cleanupRejectedDevices(
  devices: { token: VersionedToken; attemptId: string }[],
): Promise<number> {
  if (!devices.length) return 0;
  let removed: number;
  try {
    removed = await deletePushTokens(
      devices.map((d) => d.token),
      PUSH_DELIVERY_DB_OPTIONS,
    );
  } catch {
    console.warn("[user.push] registration cleanup deferred to receipt worker");
    return 0;
  }
  await Promise.all(
    devices.map(async ({ attemptId }) => {
      try {
        await finishImmediateReceiptCleanup(attemptId);
      } catch {
        // A repeated conditional delete is harmless; the worker finishes the row.
        console.warn(
          "[user.push] registration cleanup acknowledgement deferred",
        );
      }
    }),
  );
  return removed;
}

/** Best-effort cleanup of a placeholder whose send never reached Expo. */
async function discardQuietly(attemptId: string): Promise<void> {
  try {
    await discardReceiptAttempt(attemptId);
  } catch {
    // Left to the awaiting-ticket expiry; never blocks delivery.
  }
}

/**
 * Reserves tracking and then re-verifies the registration is still current
 * (account, session, id + generation) so a revoked or re-registered device is
 * not sent to. Returns null when the device must be skipped.
 */
async function prepareDevice(
  stored: IPushToken,
): Promise<{ token: VersionedToken; attemptId: string } | null> {
  const token = await withVersion(stored);
  if (!token) return null;
  const attemptId = await reserveReceiptAttempt(token);
  if (!attemptId) return null;
  try {
    if (await isPushDeliveryActive(token)) return { token, attemptId };
  } catch {
    await discardQuietly(attemptId);
    throw new Error("delivery guard failed");
  }
  await discardQuietly(attemptId);
  return null;
}

export interface RegisterPushTokenInput {
  userId: string;
  authSessionId: string;
  token: string;
  platform: PushPlatform;
  locale: string;
}

export interface PushContent {
  title: string;
  body: string;
}

/** Optional durable delivery contract; existing callers keep best-effort behavior. */
export interface DurablePushDelivery {
  delivered: readonly string[];
  expiresAt: Date;
  beforeSend: () => Promise<boolean>;
  onAccepted: (deviceDigest: string) => Promise<boolean>;
}
export interface DurablePushDeliveryResult extends PushDeliveryResult {
  retryable: boolean;
  cancelled: boolean;
}

export interface PushDeliveryResult {
  sent: number;
  removed: number;
}

/**
 * Registers the caller's device for push, binding the token to the current
 * login session so a logout or revocation silences it.
 *
 * @param input Owner, session and device fields
 * @returns The stored registration
 */
export async function registerPushToken(
  input: RegisterPushTokenInput,
): Promise<{ token: string; platform: PushPlatform; locale: string }> {
  const stored = await upsertPushToken(input);
  return {
    token: stored.token,
    platform: stored.platform,
    locale: stored.locale,
  };
}

/**
 * Unregisters one of the caller's devices. Idempotent: an unknown token, or one
 * owned by another account, is simply not removed.
 *
 * @param userId The caller's user id
 * @param token The Expo push token to remove
 * @returns Whether a token was removed
 */
export async function unregisterPushToken(
  userId: string,
  token: string,
): Promise<boolean> {
  return deletePushTokenForUser(userId, token);
}

/**
 * Picks the entry for a locale from a per-locale table, falling back to the
 * language prefix and then to the default locale.
 *
 * @param table Entries keyed by locale; must contain the default locale
 * @param locale Requested locale, e.g. `en-US`
 * @returns The best matching entry
 */
export function pickLocale<T>(table: Record<string, T>, locale: string): T {
  if (table[locale]) return table[locale];
  const language = locale.split("-")[0].toLowerCase();
  const byLanguage = Object.keys(table).find(
    (key) => key.split("-")[0].toLowerCase() === language,
  );
  return byLanguage ? table[byLanguage] : table[PUSH_DEFAULT_LOCALE];
}

/**
 * Pushes a notification to every device of a user whose login session is still
 * active. Tokens of ended sessions and tokens Expo reports unregistered are
 * removed. Without delivery hooks this remains best-effort (never throws).
 * Durable callers receive retryable/cancelled flags and storage errors propagate.
 *
 * @param userId The recipient's user id
 * @param build Builds the title and body for a device's locale
 * @param data Payload the app receives with the notification
 * @returns How many messages were accepted by Expo and how many tokens were removed
 */
export function sendPushToUser(
  userId: string,
  build: (locale: string) => PushContent,
  data: Record<string, unknown>,
  delivery: DurablePushDelivery,
): Promise<DurablePushDeliveryResult>;
export function sendPushToUser(
  userId: string,
  build: (locale: string) => PushContent,
  data: Record<string, unknown>,
): Promise<PushDeliveryResult>;
export async function sendPushToUser(
  userId: string,
  build: (locale: string) => PushContent,
  data: Record<string, unknown>,
  delivery?: DurablePushDelivery,
): Promise<PushDeliveryResult | DurablePushDeliveryResult> {
  if (delivery) return sendDurablePushToUser(userId, build, data, delivery);
  const result: PushDeliveryResult = { sent: 0, removed: 0 };
  try {
    const [tokens, sessions] = await Promise.all([
      findPushTokensByUserId(userId),
      findActiveSessionsByUserId(userId),
    ]);
    if (!tokens.length) return result;

    const activeSessionIds = new Set(sessions.map((s) => String(s._id)));
    const live = tokens.filter((t) => activeSessionIds.has(t.authSessionId));
    const stale = tokens.filter((t) => !activeSessionIds.has(t.authSessionId));
    result.removed += await deletePushTokens(stale);
    if (!live.length) return result;

    // Bounded chunks: reserve + final guard immediately before each chunk's
    // HTTP request, so later chunks cannot outlive their placeholders or send to
    // devices revoked meanwhile. A device that fails preparation is skipped.
    for (let i = 0; i < live.length; i += EXPO_PUSH_CHUNK_SIZE) {
      const prepared = (
        await Promise.all(
          live.slice(i, i + EXPO_PUSH_CHUNK_SIZE).map(async (t) => {
            try {
              return await prepareDevice(t);
            } catch {
              console.warn("[user.push] device preparation failed; not sent");
              return null;
            }
          }),
        )
      ).filter((r): r is NonNullable<typeof r> => r !== null);
      if (!prepared.length) continue;
      const targets = prepared.map((r) => r.token);
      const tickets = await sendExpoPushMessages(
        targets.map((t): ExpoPushMessage => ({
          to: t.token,
          ...build(t.locale),
          data,
          sound: "default",
          priority: "high",
        })),
      );
      await Promise.all(
        prepared.map((r, k) => recordTicket(r.attemptId, tickets[k])),
      );

      const unregistered: typeof prepared = [];
      tickets.forEach((ticket, k) => {
        if (ticket.status === "ok") {
          result.sent += 1;
        } else if (ticket.details?.error === EXPO_DEVICE_NOT_REGISTERED) {
          unregistered.push(prepared[k]);
        } else {
          console.warn(
            "[user.push] Expo rejected a push message",
            normalizeReceiptErrorCode(ticket.details?.error),
          );
        }
      });
      result.removed += await cleanupRejectedDevices(unregistered);
    }
  } catch {
    // Storage/provider error text may carry private data: log a fixed message.
    console.error("[user.push] sendPushToUser failed");
  }
  return result;
}

/** Same Expo entrypoint, but with per-device durable acknowledgement and visible errors.
 * Sequential sends keep accepted devices checkpointed even if a later device fails. */
async function sendDurablePushToUser(
  userId: string,
  build: (locale: string) => PushContent,
  data: Record<string, unknown>,
  delivery: DurablePushDelivery,
): Promise<DurablePushDeliveryResult> {
  const result: DurablePushDeliveryResult = {
    sent: 0,
    removed: 0,
    retryable: false,
    cancelled: false,
  };
  const delivered = new Set(delivery.delivered);
  for (const stored of await findDeliveryTokens(userId)) {
    const digest = createHash("sha256").update(stored.token).digest("hex");
    if (delivered.has(digest)) continue;
    const token = await withVersion(stored);
    if (!token) continue;
    // Storage errors propagate (before any send) under the durable retry policy.
    const attemptId = await reserveReceiptAttempt(token);
    if (!attemptId) continue;
    // Final guard AFTER the reservation latency, then the caller's guard and the
    // TTL immediately before the HTTP request.
    if (!(await isPushDeliveryActive(token))) {
      await discardQuietly(attemptId);
      continue;
    }
    if (!(await delivery.beforeSend())) {
      await discardQuietly(attemptId);
      result.cancelled = true;
      return result;
    }
    const ttl = Math.floor((delivery.expiresAt.getTime() - Date.now()) / 1000);
    if (ttl <= 0) {
      await discardQuietly(attemptId);
      result.cancelled = true;
      return result;
    }
    const [ticket] = await sendExpoPushMessages([
      {
        to: token.token,
        ...build(token.locale),
        data,
        sound: "default",
        priority: "high",
        ttl,
      },
    ]);
    await recordTicket(attemptId, ticket);
    if (ticket?.status === "ok") {
      result.sent += 1;
      if (!(await delivery.onAccepted(digest))) {
        result.cancelled = true;
        return result;
      }
      delivered.add(digest);
    } else if (ticket?.details?.error === EXPO_DEVICE_NOT_REGISTERED) {
      result.removed += await cleanupRejectedDevices([{ token, attemptId }]);
    } else {
      result.retryable = true;
    }
  }
  return result;
}
