import crypto from "crypto";
import SosSession from "../../model/sos-session.model";
import { pushSosResolved } from "../../adapters/line.adapter";
import { RETENTION_DAY_MS, retentionCutoff } from "../../config/retention";
import {
  autoResolveStalestSession,
  claimDueResolvedNotice,
  deleteResolvedSessionsBefore,
  failExhaustedResolvedNotices,
  findBoundLineUserIds,
  findOldestResolvedAt,
  findUserName,
  markResolvedNoticeAttemptFailed,
  markResolvedNoticeSent,
} from "./sos.repository";
import { buildSosSnapshot, emitSosUpdate } from "./sos-events";
import type { ISosSession } from "../../types";
import type { RetentionContext, RetentionTask } from "../../types/retention";

const HOUR_MS = 60 * 60 * 1000;

function staleCutoff(ctx: RetentionContext): Date {
  return new Date(
    ctx.now.getTime() - ctx.config.sosStaleAutoResolveHours * HOUR_MS,
  );
}

/**
 * Closes active sessions whose location stopped updating, so a forgotten SOS
 * does not keep a live location forever. Contacts are told through the
 * notice task below.
 */
export const sosAutoResolveTask: RetentionTask = {
  name: "sos.auto-resolve",
  async runBatch(ctx) {
    if (ctx.dryRun) {
      return SosSession.countDocuments({
        status: "active",
        locationUpdatedAt: { $lte: staleCutoff(ctx) },
      }).limit(ctx.config.batchSize);
    }
    let resolved = 0;
    while (resolved < ctx.config.batchSize) {
      const session = await autoResolveStalestSession(
        staleCutoff(ctx),
        ctx.now,
        crypto.randomUUID(),
      );
      if (!session) break;
      resolved++;
      emitSosUpdate(
        String(session._id),
        buildSosSnapshot(session as unknown as ISosSession),
      );
    }
    return resolved;
  },
};

/**
 * Delivers the "SOS ended" notice for auto-resolved sessions, retrying until
 * LINE accepts it or the attempt limit is reached.
 */
export const sosResolvedNoticeTask: RetentionTask = {
  name: "sos.resolved-notice",
  async runBatch(ctx) {
    const { config } = ctx;
    if (ctx.dryRun) {
      return SosSession.countDocuments({
        "resolvedNotice.status": "pending",
        "resolvedNotice.nextAttemptAt": { $lte: ctx.now },
      }).limit(config.batchSize);
    }

    const exhausted = await failExhaustedResolvedNotices(
      ctx.now,
      config.sosNoticeMaxAttempts,
      config.batchSize,
    );
    for (const id of exhausted) {
      console.error(
        "[retention] SOS auto-resolve notice gave up after max attempts",
        JSON.stringify({ sessionId: id }),
      );
    }

    let handled = exhausted.length;
    while (handled < config.batchSize) {
      const claimId = crypto.randomUUID();
      const session = await claimDueResolvedNotice(
        ctx.now,
        config.sosNoticeLeaseMs,
        config.sosNoticeMaxAttempts,
        claimId,
      );
      if (!session?.resolvedNotice) break;
      handled++;
      const sessionId = String(session._id);
      try {
        const lineUserIds = await findBoundLineUserIds(session.userId);
        const userName = await findUserName(session.userId).catch(
          () => undefined,
        );
        await pushSosResolved(
          lineUserIds,
          session.resolvedNotice.retryKey,
          config.sosNoticeSendTimeoutMs,
          userName,
        );
        await markResolvedNoticeSent(sessionId, claimId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          "[retention] SOS auto-resolve notice attempt failed",
          JSON.stringify({
            sessionId,
            attempt: session.resolvedNotice.attempts,
          }),
          message,
        );
        await markResolvedNoticeAttemptFailed(sessionId, claimId, message);
      }
    }
    return handled;
  },
};

/** Deletes sessions once their resolution is older than the policy allows. */
export const sosResolvedDeletionTask: RetentionTask = {
  name: "sos.resolved-deletion",
  async runBatch(ctx) {
    const cutoff = retentionCutoff(
      ctx.now,
      ctx.config.sosResolvedDeadlineDays * RETENTION_DAY_MS,
      ctx.config,
    );
    if (ctx.dryRun) {
      return SosSession.countDocuments({
        status: "resolved",
        resolvedAt: { $lte: cutoff },
      }).limit(ctx.config.batchSize);
    }
    return deleteResolvedSessionsBefore(cutoff, ctx.config.batchSize);
  },
  async oldestOverdue(ctx) {
    const oldest = await findOldestResolvedAt();
    const deadline =
      ctx.now.getTime() - ctx.config.sosResolvedDeadlineDays * RETENTION_DAY_MS;
    return oldest && oldest.getTime() <= deadline ? oldest : null;
  },
};
