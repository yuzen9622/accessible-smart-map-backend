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
      {
        $set: {
          aiVerification: result,
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
