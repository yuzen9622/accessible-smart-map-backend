import HazardReport from "../../model/hazard-report.model";
import { HAZARD_AI } from "../../config/hazard-ai";
import { HAZARD_REVIEW_PUSH } from "../../constants/hazard-review-notification";
import type { HazardReviewNotification } from "../../types/hazard-review-notification";
import { DB_OPTIONS } from "./hazard-report.db";
import { INTAKE_COMPLETE } from "./hazard-report.predicates";

const OPTIONS = { ...DB_OPTIONS, maxTimeMS: HAZARD_AI.dbTimeoutMs };
export interface ClaimedReviewNotification {
  reportId: string;
  reporterId: string;
  notification: HazardReviewNotification;
}
function eligible(now: Date): Record<string, unknown> {
  return {
    ...INTAKE_COMPLETE,
    contentScrubbedAt: { $exists: false },
    reporterId: { $regex: /^[a-fA-F0-9]{24}$/ },
    status: { $ne: "expired" },
    expiredAt: { $gt: now },
    "reviewNotification.deadlineAt": { $gt: now },
  };
}
function fence(
  job: ClaimedReviewNotification,
  now: Date,
): Record<string, unknown> {
  return {
    ...eligible(now),
    _id: job.reportId,
    reporterId: job.reporterId,
    "reviewNotification.revision": job.notification.revision,
    "reviewNotification.result": job.notification.result,
    "reviewNotification.state": "processing",
    "reviewNotification.leaseToken": job.notification.leaseToken,
    "reviewNotification.leaseExpiresAt": { $gt: now },
  };
}

/** Single-document CAS: concurrent workers cannot own the same event. */
export async function claimReviewNotification(
  now: Date,
  leaseToken: string,
): Promise<ClaimedReviewNotification | null> {
  const doc = await HazardReport.findOneAndUpdate(
    {
      ...eligible(now),
      $or: [
        {
          "reviewNotification.state": "pending",
          "reviewNotification.nextAttemptAt": { $lte: now },
        },
        {
          "reviewNotification.state": "processing",
          "reviewNotification.leaseExpiresAt": { $lte: now },
        },
      ],
    },
    {
      $set: {
        "reviewNotification.state": "processing",
        "reviewNotification.leaseToken": leaseToken,
        "reviewNotification.leaseExpiresAt": new Date(
          now.getTime() + HAZARD_REVIEW_PUSH.leaseMs,
        ),
      },
      $inc: { "reviewNotification.attempts": 1 },
    },
    {
      ...OPTIONS,
      returnDocument: "after",
      sort: { "reviewNotification.nextAttemptAt": 1 },
    },
  )
    .select("reporterId +reviewNotification")
    .lean<{
      _id: unknown;
      reporterId: string;
      reviewNotification: HazardReviewNotification;
    } | null>();
  return doc
    ? {
        reportId: String(doc._id),
        reporterId: doc.reporterId,
        notification: doc.reviewNotification,
      }
    : null;
}

/** Revalidate result/reporter/privacy and renew immediately before EACH device send. */
export async function renewReviewNotification(
  job: ClaimedReviewNotification,
  now: Date,
): Promise<boolean> {
  const result = await HazardReport.updateOne(
    fence(job, now),
    {
      $set: {
        "reviewNotification.leaseExpiresAt": new Date(
          now.getTime() + HAZARD_REVIEW_PUSH.leaseMs,
        ),
      },
    },
    OPTIONS,
  );
  return result.matchedCount === 1;
}

/** Persist each accepted device before attempting another one. */
export async function recordReviewNotificationDevice(
  job: ClaimedReviewNotification,
  digest: string,
  now: Date,
): Promise<boolean> {
  const result = await HazardReport.updateOne(
    fence(job, now),
    {
      $addToSet: { "reviewNotification.delivered": digest },
    },
    OPTIONS,
  );
  return result.matchedCount === 1;
}

export async function finishReviewNotification(
  job: ClaimedReviewNotification,
  state: "sent" | "skipped" | "pending",
  now: Date,
): Promise<boolean> {
  const delay = Math.min(
    HAZARD_REVIEW_PUSH.retryCapMs,
    HAZARD_REVIEW_PUSH.retryBaseMs *
      2 ** Math.min(job.notification.attempts - 1, 10),
  );
  const result = await HazardReport.updateOne(
    fence(job, now),
    {
      $set: {
        "reviewNotification.state": state,
        "reviewNotification.nextAttemptAt": new Date(now.getTime() + delay),
      },
      $unset: {
        "reviewNotification.leaseToken": "",
        "reviewNotification.leaseExpiresAt": "",
      },
    },
    OPTIONS,
  );
  return result.matchedCount === 1;
}

/** Expired/ineligible events are terminal; only the current embedded event is touched. */
export async function expireReviewNotifications(now: Date): Promise<void> {
  await HazardReport.updateMany(
    {
      "reviewNotification.state": { $in: ["pending", "processing"] },
      $or: [
        { "reviewNotification.deadlineAt": { $lte: now } },
        { expiredAt: { $lte: now } },
        { status: "expired" },
        { contentScrubbedAt: { $exists: true } },
        { reporterId: { $not: /^[a-fA-F0-9]{24}$/ } },
      ],
    },
    {
      $set: { "reviewNotification.state": "expired" },
      $unset: {
        "reviewNotification.leaseToken": "",
        "reviewNotification.leaseExpiresAt": "",
        "reviewNotification.delivered": "",
      },
    },
    OPTIONS,
  );
}
