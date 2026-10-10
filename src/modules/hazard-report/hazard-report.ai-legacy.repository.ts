import { queueReviewNotificationStage } from "./hazard-report.notification-stages";
import HazardReport from "../../model/hazard-report.model";
import { HAZARD_AI } from "../../config/hazard-ai";
import type { IHazardReport } from "../../types";

/** Historical v1 harness only: cannot write to a v2/manual/stale/scrubbed row. */
export async function persistLegacyAiResult(
  reportId: string,
  result: IHazardReport["aiVerification"],
): Promise<void> {
  const status =
    result.verdict === "verified"
      ? "verified"
      : result.verdict === "rejected"
        ? "rejected"
        : undefined;
  await HazardReport.updateOne(
    {
      _id: reportId,
      status: "pending",
      expiredAt: { $gt: new Date() },
      contentScrubbedAt: { $exists: false },
      aiReview: { $exists: false },
      photoIntake: { $exists: false },
      "manualReview.reviewedAt": { $exists: false },
    },
    [
      // A technical retry may replace a previous suspicious legacy result.
      // Revoke that notice without creating a notification for skipped work.
      ...(result.verdict === "skipped"
        ? [
            {
              $set: {
                reviewNotification: {
                  $cond: [
                    { $eq: [{ $type: "$reviewNotification" }, "object"] },
                    {
                      $mergeObjects: [
                        "$reviewNotification",
                        { state: "skipped", delivered: [] },
                      ],
                    },
                    "$$REMOVE",
                  ],
                },
              },
            },
            {
              $unset: [
                "reviewNotification.leaseToken",
                "reviewNotification.leaseExpiresAt",
              ],
            },
          ]
        : [
            queueReviewNotificationStage(
              `legacy_${result.verdict}`,
              new Date(),
              { $ne: ["$aiVerification.verdict", result.verdict] },
            ),
          ]),
      {
        $set: {
          aiVerification: { $literal: result },
          ...(status ? { status } : {}),
          ...(status === "rejected"
            ? { closedAt: { $ifNull: ["$closedAt", "$$NOW"] } }
            : {}),
        },
      },
    ],
    { updatePipeline: true, maxTimeMS: HAZARD_AI.dbTimeoutMs },
  );
}
