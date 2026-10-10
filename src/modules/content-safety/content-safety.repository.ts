import { admittedCaseFilter } from "./content-safety.admission.repository";
export { insertContentReport } from "./content-safety.admission.repository";
export { decideCase } from "./content-safety.decision.repository";
import { Types } from "mongoose";
import { createHash, randomUUID } from "node:crypto";
import ContentReport, {
  type MailRole,
  type ReportMail,
} from "../../model/content-report.model";
import UserBlock from "../../model/user-block.model";
import User from "../../model/user.model";
import Review from "../../model/review.model";
import HazardReport from "../../model/hazard-report.model";
import type { TargetInput } from "./content-safety.schema";

export async function findSafetyTarget(target: TargetInput) {
  if (target.targetType === "review") {
    const doc = await Review.findOne({
      _id: target.targetId,
      status: "active",
      moderationHiddenAt: null,
    }).lean();
    if (!doc) return null;
    return {
      authorId: doc.userId,
      snapshot: doc.comment ?? "",
      version: String(doc.updatedAt?.getTime() ?? 0),
    };
  }
  const doc = await HazardReport.findOne({
    _id: target.targetId,
    moderationHiddenAt: null,
    contentScrubbedAt: { $exists: false },
    deidentifiedAt: { $exists: false },
    "photoIntake.state": { $nin: ["uploading", "cleanup"] },
  }).lean();
  if (!doc) return null;
  // Votes and AI job updates are not a new version of the submitted UGC.
  const version = createHash("sha256")
    .update(
      JSON.stringify([doc.description, doc.hazardType, doc.photoStoragePath]),
    )
    .digest("hex");
  return { authorId: doc.reporterId, snapshot: doc.description ?? "", version };
}
export async function safetyUser(userId: string) {
  if (!Types.ObjectId.isValid(userId)) return null;
  return User.findById(userId)
    .select("email emailVerified role contentRestrictedAt")
    .lean();
}
export async function blockedAuthorIds(ownerId?: string): Promise<string[]> {
  if (!ownerId) return [];
  const rows = await UserBlock.find({ ownerId }).select("blockedUserId").lean();
  return rows.map((row) => row.blockedUserId);
}
export async function putBlock(
  ownerId: string,
  blockedUserId: string,
  sourceType: TargetInput["targetType"],
) {
  try {
    await UserBlock.updateOne(
      { ownerId, blockedUserId },
      {
        $setOnInsert: {
          ownerId,
          blockedUserId,
          sourceType,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}
export async function listBlocks(ownerId: string) {
  const rows = await UserBlock.find({ ownerId }).sort({ createdAt: -1 }).lean();
  return rows.map((row) => ({
    blockId: String(row._id),
    label: row.sourceType === "review" ? "review" : "hazard_report",
    createdAt: row.createdAt,
  }));
}
export async function removeBlock(ownerId: string, id: string) {
  await UserBlock.deleteOne({ _id: id, ownerId });
}
export async function findCase(id: string) {
  return ContentReport.findOne({
    _id: id,
    purgeAt: { $gt: new Date() },
  }).lean();
}

export async function claimMail(role: MailRole, now: Date) {
  const prefix = `mails.${role}`;
  return ContentReport.findOneAndUpdate(
    {
      purgeAt: { $gt: now },
      $and: [admittedCaseFilter],
      $or: [
        {
          [`${prefix}.state`]: "pending",
          [`${prefix}.nextAttemptAt`]: { $lte: now },
        },
        {
          [`${prefix}.state`]: "sending",
          [`${prefix}.leaseUntil`]: { $lte: now },
        },
      ],
    },
    {
      $set: {
        [`${prefix}.state`]: "sending",
        [`${prefix}.leaseToken`]: randomUUID(),
        [`${prefix}.leaseUntil`]: new Date(now.getTime() + 120000),
      },
      $inc: { [`${prefix}.attempts`]: 1 },
    },
    { returnDocument: "after", sort: { createdAt: 1 } },
  ).lean();
}
export async function updateMail(
  id: string,
  role: MailRole,
  leaseToken: string,
  fields: Partial<ReportMail>,
  now = new Date(),
) {
  const prefix = `mails.${role}`;
  const result = await ContentReport.updateOne(
    {
      _id: id,
      purgeAt: { $gt: now },
      $and: [admittedCaseFilter],
      [`${prefix}.state`]: "sending",
      [`${prefix}.leaseToken`]: leaseToken,
      [`${prefix}.leaseUntil`]: { $gt: now },
    },
    {
      $set: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          `${prefix}.${key}`,
          value,
        ]),
      ),
    },
  );
  return result.matchedCount === 1;
}

export async function listCases(cursor?: string) {
  const rows = await ContentReport.find({
    purgeAt: { $gt: new Date() },
    ...(cursor ? { _id: { $lt: cursor } } : {}),
  })
    .sort({ _id: -1 })
    .limit(50)
    .lean();
  return {
    items: rows.map((row) => ({
      caseNumber: String(row._id),
      status: row.status,
      reason: row.reason,
      receivedAt: row.createdAt,
      admission: row.admission,
      pendingDecisions: row.decisions.filter((d) => d.state === "pending")
        .length,
      delivery: {
        team: row.mails.team.state,
        reporter: row.mails.reporter.state,
      },
    })),
    nextCursor: rows.length === 50 ? String(rows[49]._id) : null,
  };
}

export async function findRecoverableCases(now: Date) {
  return ContentReport.find({
    purgeAt: { $gt: now },
    $and: [
      {
        $or: [
          { recoveryAt: { $exists: false } },
          { recoveryAt: { $lte: now } },
        ],
      },
      {
        $or: [
          { "admission.state": "pending" },
          {
            decisions: {
              $elemMatch: { state: "pending", nextAttemptAt: { $lte: now } },
            },
          },
          { "decisions.receiptCleanupPending": true },
        ],
      },
    ],
  })
    .sort({ recoveryAt: 1, createdAt: 1 })
    .limit(20)
    .lean();
}
export async function deferCaseRecovery(id: string, now: Date) {
  await ContentReport.updateOne(
    { _id: id },
    { $set: { recoveryAt: new Date(now.getTime() + 30000) } },
  );
}
