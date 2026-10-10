import { HAZARD_REVIEW_PUSH } from "../../constants/hazard-review-notification";
import type { HazardReviewNoticeResult } from "../../types/hazard-review-notification";

/** Execute BEFORE changing review fields, in the very same Mongo update.
 * Latest-result wins: overwrites revoke an old lease and erase its device ledger.
 * No sweeper synthesizes events from historical results. */
export function queueReviewNotificationStage(
  result: HazardReviewNoticeResult,
  now: Date,
  changed: unknown = true,
): Record<string, unknown> {
  return {
    $set: {
      reviewNotification: {
        $cond: [
          {
            $and: [
              changed,
              {
                $regexMatch: {
                  input: { $ifNull: ["$reporterId", ""] },
                  regex: "^[a-fA-F0-9]{24}$",
                },
              },
              { $gt: ["$expiredAt", now] },
            ],
          },
          {
            revision: {
              $add: [{ $ifNull: ["$reviewNotification.revision", 0] }, 1],
            },
            result,
            state: "pending",
            createdAt: now,
            deadlineAt: {
              $min: [
                "$expiredAt",
                new Date(now.getTime() + HAZARD_REVIEW_PUSH.lifetimeMs),
              ],
            },
            nextAttemptAt: now,
            attempts: 0,
            delivered: [],
          },
          "$reviewNotification",
        ],
      },
    },
  };
}
