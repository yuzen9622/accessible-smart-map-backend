import { randomUUID } from "crypto";
import { sendSosNotification } from "../../adapters/line.adapter";
import { SOS_NOTICE } from "../../constants/sos";
import type { ISosInitialNotice } from "../../types";
import {
  acceptInitialNotice,
  claimInitialNotice,
  expireInitialNotices,
  failInitialNotice,
  findBoundLineUserIds,
  findSessionById,
  findUserName,
} from "./sos.repository";
import { buildSosSnapshot, emitSosUpdate } from "./sos-events";

/** Freeze the audience and payload before the first network attempt. */
export async function makeInitialNotice(
  userId: string,
  payload: ISosInitialNotice["payload"],
): Promise<ISosInitialNotice> {
  const recipients = [...new Set(await findBoundLineUserIds(userId))];
  const userName = await findUserName(userId).catch(() => undefined);
  return {
    status: recipients.length ? "queued" : "skipped",
    recipients,
    payload: { ...payload, userName },
    retryKey: randomUUID(),
    attempts: 0,
    nextAttemptAt: new Date(),
    retryUntil: new Date(Date.now() + SOS_NOTICE.retryWindowMs),
    notifiedCount: 0,
  };
}

/** HTTP and background consumers use the same durable, fenced attempt. */
export async function deliverInitialNotice(
  sessionId?: string,
): Promise<boolean> {
  const claimId = randomUUID();
  const session = await claimInitialNotice(new Date(), claimId, sessionId);
  if (!session?.initialNotice) return false;
  const notice = session.initialNotice;
  const id = String(session._id);
  try {
    const count = await sendSosNotification(
      notice.recipients,
      notice.payload,
      notice.retryKey,
      SOS_NOTICE.timeoutMs,
    );
    await acceptInitialNotice(id, claimId, count);
  } catch (error) {
    console.warn("[sos] initial notification attempt failed", {
      sessionId: id,
      attempt: notice.attempts,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    // A failed result write is retried with the same LINE key as well.
    await failInitialNotice(id, claimId, notice.attempts);
  }
  const current = await findSessionById(id);
  if (current) emitSosUpdate(id, buildSosSnapshot(current));
  return true;
}

/** Recover queued notifications after process restarts; bounded per tick. */
export async function drainInitialNotices(): Promise<number> {
  await expireInitialNotices(new Date());
  let handled = 0;
  while (handled < SOS_NOTICE.batchSize && (await deliverInitialNotice()))
    handled++;
  return handled;
}
