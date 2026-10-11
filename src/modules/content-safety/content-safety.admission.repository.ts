import type { ClientSession } from "mongoose";
import { safetyTransaction } from "./content-safety.transaction";
import ContentReport, {
  type ContentReportRecord,
} from "../../model/content-report.model";
import ContentSafetyQuota from "../../model/content-safety-quota.model";

const HOUR_MS = 3600000;
const MAX_HISTORY = 96; // 48 hourly attempts, each with pending and terminal evidence.

/** Mail claims accept legacy documents or explicitly admitted cases only. */
export const admittedCaseFilter: Record<string, unknown> = {
  $or: [{ admission: { $exists: false } }, { "admission.state": "admitted" }],
};

export async function reconcileAdmission(
  id: string,
  clock: () => Date = () => new Date(),
) {
  return safetyTransaction((session) =>
    reconcileAdmissionInSession(id, clock, session),
  );
}

async function reconcileAdmissionInSession(
  id: string,
  clock: () => Date,
  session: ClientSession,
) {
  const now = clock();
  const report = await ContentReport.findOne({
    _id: id,
    purgeAt: { $gt: now },
  })
    .session(session)
    .lean();
  if (!report) return null;
  const admission = report.admission;
  if (!admission || admission.state !== "pending") return report;
  const { hour } = admission;
  const quotaId = `${report.reporterId}:${hour}`;
  let granted = false;
  let reason = "RESERVATION_EXPIRED";
  if (clock().getTime() < (hour + 2) * HOUR_MS) {
    await ContentSafetyQuota.updateOne(
      { _id: quotaId },
      {
        $setOnInsert: {
          count: 0,
          caseIds: [],
          expiresAt: new Date((hour + 2) * HOUR_MS),
        },
      },
      { upsert: true, session },
    );
    // Reservation and accounting are one write; repeated workers cannot double-charge.
    await ContentSafetyQuota.updateOne(
      {
        _id: quotaId,
        count: { $lt: 20 },
        caseIds: { $ne: id },
        expiresAt: { $gt: clock() },
        $expr: { $gt: ["$expiresAt", "$$NOW"] },
      },
      {
        $inc: { count: 1 },
        $addToSet: { caseIds: id },
      },
      { session },
    );
    granted = Boolean(
      await ContentSafetyQuota.exists({
        _id: quotaId,
        caseIds: id,
        expiresAt: { $gt: clock() },
      }).session(session),
    );
    reason = granted ? "QUOTA_RESERVED" : "RATE_LIMITED";
  }
  const settledAt = clock();
  if (settledAt.getTime() >= (hour + 2) * HOUR_MS) {
    granted = false;
    reason = "RESERVATION_EXPIRED";
  }
  const state = granted ? "admitted" : "rejected";
  const settled = await ContentReport.findOneAndUpdate(
    {
      _id: id,
      purgeAt: { $gt: settledAt },
      ...(granted
        ? {
            $expr: {
              $gt: [{ $literal: new Date((hour + 2) * HOUR_MS) }, "$$NOW"],
            },
          }
        : {}),
      "admission.state": "pending",
      "admission.hour": hour,
    },
    {
      $set: {
        "admission.state": state,
        "admission.reason": reason,
        purgeAt: new Date(
          report.createdAt.getTime() + (granted ? 365 : 7) * 86400000,
        ),
      },
      $push: { "admission.history": { state, hour, at: settledAt, reason } },
    },
    { returnDocument: "after", session },
  ).lean();
  if (!settled) throw new Error("ADMISSION_COMMIT_CONFLICT");
  return settled;
}

export async function insertContentReport(
  doc: Omit<ContentReportRecord, "_id">,
) {
  return safetyTransaction((session) => insertInSession(doc, session));
}

async function insertInSession(
  doc: Omit<ContentReportRecord, "_id">,
  session: ClientSession,
) {
  const now = new Date();
  const hour = Math.floor(now.getTime() / HOUR_MS);
  const key = {
    reporterId: doc.reporterId,
    targetType: doc.targetType,
    targetId: doc.targetId,
    targetVersion: doc.targetVersion,
  };
  let report = await ContentReport.findOne(key).session(session).lean();
  const duplicate = Boolean(report);
  if (!report) {
    const [created] = await ContentReport.create(
      [
        {
          ...doc,
          purgeAt: new Date(now.getTime() + 7 * 86400000),
          admission: {
            state: "pending",
            hour,
            history: [{ state: "pending", hour, at: now }],
          },
        },
      ],
      { session },
    );
    report = created.toObject();
  }

  if (report.admission?.state === "rejected" && report.admission.hour < hour) {
    // A prior attempt is evidence, not a permanent ban on reporting this version.
    if (report.admission.history.length >= MAX_HISTORY)
      throw new Error("ADMISSION_REVIEW_REQUIRED");
    const retried = await ContentReport.findOneAndUpdate(
      {
        _id: report._id,
        purgeAt: { $gt: now },
        "admission.state": "rejected",
        "admission.hour": report.admission.hour,
      },
      {
        $set: { "admission.state": "pending", "admission.hour": hour },
        $unset: { "admission.reason": 1 },
        $push: { "admission.history": { state: "pending", hour, at: now } },
      },
      { returnDocument: "after", session },
    ).lean();
    if (retried) report = retried;
  }
  const settled = await reconcileAdmissionInSession(
    String(report._id),
    () => new Date(),
    session,
  );
  if (!settled) throw new Error("CASE_UNAVAILABLE");
  if (settled.admission?.state === "rejected") return null;
  if (settled.admission?.state === "pending")
    throw new Error("ADMISSION_PENDING");
  return { doc: settled, duplicate };
}
