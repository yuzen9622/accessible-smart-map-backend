import { createHash } from "node:crypto";
import {
  findDeliveryTokens,
  isPushDeliveryActive,
  PUSH_DELIVERY_DB_OPTIONS,
} from "./user.push-delivery.repository";
import {
  deletePushTokenForUser,
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
  PUSH_DEFAULT_LOCALE,
} from "../../constants/push";
import type { PushPlatform } from "../../types";

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

    const messages: ExpoPushMessage[] = live.map((t) => ({
      to: t.token,
      ...build(t.locale),
      data,
      sound: "default",
      priority: "high",
    }));
    const tickets = await sendExpoPushMessages(messages);

    const unregistered: typeof live = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === "ok") {
        result.sent += 1;
        return;
      }
      if (ticket.details?.error === EXPO_DEVICE_NOT_REGISTERED) {
        unregistered.push(live[i]);
        return;
      }
      console.warn(
        "[user.push] Expo rejected a push message",
        ticket.details?.error ?? ticket.message,
      );
    });
    result.removed += await deletePushTokens(unregistered);
  } catch (err) {
    console.error(
      "[user.push] sendPushToUser failed",
      err instanceof Error ? err.message : err,
    );
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
  for (const token of await findDeliveryTokens(userId)) {
    const digest = createHash("sha256").update(token.token).digest("hex");
    if (delivered.has(digest)) continue;
    if (!(await isPushDeliveryActive(token))) continue;
    if (!(await delivery.beforeSend())) {
      result.cancelled = true;
      return result;
    }
    const ttl = Math.floor((delivery.expiresAt.getTime() - Date.now()) / 1000);
    if (ttl <= 0) {
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
    if (ticket?.status === "ok") {
      result.sent += 1;
      if (!(await delivery.onAccepted(digest))) {
        result.cancelled = true;
        return result;
      }
      delivered.add(digest);
    } else if (ticket?.details?.error === EXPO_DEVICE_NOT_REGISTERED) {
      result.removed += await deletePushTokens(
        [token],
        PUSH_DELIVERY_DB_OPTIONS,
      );
    } else {
      result.retryable = true;
    }
  }
  return result;
}
