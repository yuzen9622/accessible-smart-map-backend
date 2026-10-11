import { Types, type ClientSession } from "mongoose";
import { safetyTransaction } from "./content-safety.transaction";
import ContentReport, {
  type ContentReportRecord,
  type ReportDecision,
} from "../../model/content-report.model";
import User from "../../model/user.model";
import Review from "../../model/review.model";
import HazardReport from "../../model/hazard-report.model";
import type { ContentModeration } from "../../model/content-moderation.schema";
import type { DecisionInput } from "./content-safety.schema";
import { admittedCaseFilter } from "./content-safety.admission.repository";

type Subject = { kind: "user" | "review" | "hazard_report"; id: string };
const MAX_DECISIONS = 200;
const MAX_RECEIPTS = 100;
const subjectFor = (report: ContentReportRecord, action: string): Subject =>
  action === "restrict_author" || action === "unrestrict_author"
    ? { kind: "user", id: report.authorId }
    : { kind: report.targetType, id: report.targetId };
const collectionFor = (subject: Subject) =>
  subject.kind === "user"
    ? User.collection
    : subject.kind === "review"
      ? Review.collection
      : HazardReport.collection;
async function readSubject(subject: Subject, session?: ClientSession) {
  if (!Types.ObjectId.isValid(subject.id)) return null;
  const doc = await collectionFor(subject).findOne(
    { _id: new Types.ObjectId(subject.id) },
    { projection: { contentModeration: 1 }, session },
  );
  return doc
    ? { moderation: doc.contentModeration as ContentModeration | undefined }
    : null;
}
const receiptKey = (id: string, requestId: string) => `${id}/${requestId}`;
const outcome = (d: ReportDecision) =>
  !d.state || d.state === "applied"
    ? ("ok" as const)
    : d.state === "superseded"
      ? ("superseded" as const)
      : d.state === "failed"
        ? d.reason === "ACTOR_REVOKED"
          ? ("forbidden" as const)
          : ("missing" as const)
        : ("pending" as const);

/** Remove only receipts whose durable case no longer needs recovery. Never lower version. */
async function pruneReceipts(
  subject: Subject,
  moderation: ContentModeration | undefined,
  session: ClientSession,
) {
  const receipts = moderation?.receipts ?? [];
  if (!receipts.length) return;
  const cases = await ContentReport.find({
    _id: { $in: receipts.map((r) => r.caseId) },
    purgeAt: { $gt: new Date() },
  })
    .select("decisions")
    .session(session)
    .lean();
  const pending = new Set(
    cases.flatMap((c) =>
      c.decisions
        .filter((d) => d.state === "pending")
        .map((d) => receiptKey(String(c._id), d.requestId)),
    ),
  );
  const removable = receipts
    .filter((r) => !pending.has(r.key))
    .map((r) => r.key);
  if (removable.length)
    await collectionFor(subject).updateOne(
      { _id: new Types.ObjectId(subject.id) },
      [
        {
          $set: {
            "contentModeration.receipts": {
              $filter: {
                input: { $ifNull: ["$contentModeration.receipts", []] },
                as: "receipt",
                cond: {
                  $not: [{ $in: ["$$receipt.key", { $literal: removable }] }],
                },
              },
            },
          },
        },
      ],
      { session },
    );
}

async function finishDecision(
  id: string,
  decision: ReportDecision,
  state: "applied" | "superseded" | "failed",
  reason: string,
  createdAt: Date,
  session: ClientSession,
) {
  const now = new Date();
  const update = {
    "decisions.$.state": state,
    "decisions.$.reason": reason,
    "decisions.$.completedAt": now,
    "decisions.$.receiptCleanupPending": decision.action !== "dismiss",
    ...(state === "applied"
      ? {
          status: "closed",
          purgeAt: new Date(
            Math.min(
              createdAt.getTime() + 365 * 86400000,
              now.getTime() + 90 * 86400000,
            ),
          ),
        }
      : {}),
  };
  const result = await ContentReport.updateOne(
    {
      _id: id,
      purgeAt: { $gt: now },
      decisions: {
        $elemMatch: { requestId: decision.requestId, state: "pending" },
      },
    },
    { $set: update },
    { session },
  );
  if (result.matchedCount !== 1) throw new Error("DECISION_AUDIT_CONFLICT");
}

export async function cleanupDecisionReceipt(
  report: ContentReportRecord,
  decision: ReportDecision,
) {
  if (!decision.receiptCleanupPending || decision.state === "pending") return;
  const subject = subjectFor(report, decision.action);
  if (Types.ObjectId.isValid(subject.id))
    await collectionFor(subject).updateOne(
      { _id: new Types.ObjectId(subject.id) },
      [
        {
          $set: {
            "contentModeration.receipts": {
              $filter: {
                input: { $ifNull: ["$contentModeration.receipts", []] },
                as: "receipt",
                cond: {
                  $ne: [
                    "$$receipt.key",
                    {
                      $literal: receiptKey(
                        String(report._id),
                        decision.requestId,
                      ),
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    );
  await ContentReport.updateOne(
    {
      _id: report._id,
      decisions: {
        $elemMatch: {
          requestId: decision.requestId,
          state: { $ne: "pending" },
        },
      },
    },
    { $set: { "decisions.$.receiptCleanupPending": false } },
  );
}

/** Pending intent precedes every effect; target CAS atomically writes effect + recovery receipt.
 * Authorization belongs to intent acceptance. Revocation prevents new commands;
 * accepted commands still finish, avoiding cancellation racing with an in-flight effect.
 */
export async function reconcileDecision(id: string, requestId: string) {
  try {
    const result = await safetyTransaction((session) =>
      reconcileDecisionInSession(id, requestId, session),
    );
    const settled = await ContentReport.findById(id).lean();
    const decision = settled?.decisions.find((d) => d.requestId === requestId);
    if (settled && decision) await cleanupDecisionReceipt(settled, decision);
    return result;
  } catch {
    // Persist retry state, retaining immutable intent even after unknown write outcomes.
    await ContentReport.updateOne(
      { _id: id, decisions: { $elemMatch: { requestId, state: "pending" } } },
      {
        $inc: { "decisions.$.attempts": 1 },
        $set: {
          "decisions.$.nextAttemptAt": new Date(Date.now() + 30000),
          "decisions.$.reason": "RETRY_REQUIRED",
        },
      },
    );
    return "pending" as const;
  }
}

async function reconcileDecisionInSession(
  id: string,
  requestId: string,
  session: ClientSession,
) {
  const report = await ContentReport.findOne({
    _id: id,
    purgeAt: { $gt: new Date() },
    $and: [admittedCaseFilter],
  })
    .session(session)
    .lean();
  const decision = report?.decisions.find((d) => d.requestId === requestId);
  if (!report || !decision) return "missing" as const;
  if (decision.state !== "pending") {
    return outcome(decision);
  }
  const subject = subjectFor(report, decision.action);
  const key = receiptKey(id, requestId);
  const before =
    decision.action === "dismiss" ? null : await readSubject(subject, session);
  // A prior write may have succeeded even if its acknowledgement/audit update failed.
  if (before?.moderation?.receipts.some((r) => r.key === key)) {
    await finishDecision(
      id,
      decision,
      "applied",
      "RECOVERED_TARGET_RECEIPT",
      report.createdAt,
      session,
    );
  } else if (decision.action === "dismiss") {
    await finishDecision(
      id,
      decision,
      "applied",
      "DISMISSED",
      report.createdAt,
      session,
    );
  } else if (!before) {
    await finishDecision(
      id,
      decision,
      "failed",
      "TARGET_MISSING",
      report.createdAt,
      session,
    );
  } else if ((before.moderation?.version ?? 0) !== decision.expectedVersion) {
    await finishDecision(
      id,
      decision,
      "superseded",
      "TARGET_VERSION_CHANGED",
      report.createdAt,
      session,
    );
  } else {
    await pruneReceipts(subject, before.moderation, session);
    // Recheck case expiry/deletion after reads, immediately before the target operation.
    if (
      !(await ContentReport.exists({
        _id: id,
        purgeAt: { $gt: new Date() },
        decisions: { $elemMatch: { requestId, state: "pending" } },
      }).session(session))
    )
      return "missing" as const;
    const now = new Date();
    const field =
      subject.kind === "user" ? "contentRestrictedAt" : "moderationHiddenAt";
    const set =
      decision.action === "hide" || decision.action === "restrict_author";
    const version = decision.expectedVersion ?? 0;
    const result = await collectionFor(subject).updateOne(
      {
        _id: new Types.ObjectId(subject.id),
        $expr: { $gt: [{ $literal: report.purgeAt }, "$$NOW"] },
        ...(version === 0
          ? {
              $or: [
                { "contentModeration.version": 0 },
                { "contentModeration.version": { $exists: false } },
              ],
            }
          : { "contentModeration.version": version }),
        [`contentModeration.receipts.${MAX_RECEIPTS - 1}`]: {
          $exists: false,
        },
      },
      [
        {
          $set: {
            "contentModeration.version": version + 1,
            [field]: set ? now : "$$REMOVE",
            "contentModeration.receipts": {
              $concatArrays: [
                { $ifNull: ["$contentModeration.receipts", []] },
                { $literal: [{ key, caseId: id, at: now }] },
              ],
            },
          },
        },
      ],
      { session },
    );
    if (result.matchedCount) {
      await finishDecision(
        id,
        decision,
        "applied",
        "TARGET_UPDATED",
        report.createdAt,
        session,
      );
    } else {
      const after = await readSubject(subject, session);
      if (after?.moderation?.receipts.some((r) => r.key === key))
        await finishDecision(
          id,
          decision,
          "applied",
          "RECOVERED_TARGET_RECEIPT",
          report.createdAt,
          session,
        );
      else if (!after)
        await finishDecision(
          id,
          decision,
          "failed",
          "TARGET_MISSING",
          report.createdAt,
          session,
        );
      else if ((after.moderation?.version ?? 0) !== version)
        await finishDecision(
          id,
          decision,
          "superseded",
          "TARGET_VERSION_CHANGED",
          report.createdAt,
          session,
        );
      else throw new Error("RECEIPT_CAPACITY");
    }
  }
  const settled = await ContentReport.findById(id).session(session).lean();
  const terminal = settled?.decisions.find((d) => d.requestId === requestId);
  if (!settled || !terminal) return "missing" as const;
  return outcome(terminal);
}

export async function decideCase(
  id: string,
  actorId: string,
  input: DecisionInput,
) {
  if (!(await User.exists({ _id: actorId, role: "admin" })))
    return "forbidden" as const;
  const report = await ContentReport.findOne({
    _id: id,
    purgeAt: { $gt: new Date() },
    $and: [admittedCaseFilter],
  }).lean();
  if (!report) return "missing" as const;
  const previous = report.decisions.find(
    (d) => d.requestId === input.requestId,
  );
  if (previous)
    return previous.action === input.action && previous.note === input.note
      ? reconcileDecision(id, input.requestId)
      : ("conflict" as const);
  if (report.decisions.length >= MAX_DECISIONS) return "capacity" as const;
  const subject = subjectFor(report, input.action);
  const target = input.action === "dismiss" ? null : await readSubject(subject);
  if (input.action !== "dismiss" && !target) return "missing" as const;
  const now = new Date();
  const decision: ReportDecision = {
    ...input,
    actorId,
    at: now,
    state: "pending",
    expectedVersion: target?.moderation?.version ?? 0,
    attempts: 0,
    nextAttemptAt: now,
  };
  // Both the uniqueness check and durable intent insertion happen on one document.
  await ContentReport.updateOne(
    {
      _id: id,
      purgeAt: { $gt: now },
      $and: [admittedCaseFilter],
      "decisions.requestId": { $ne: input.requestId },
      [`decisions.${MAX_DECISIONS - 1}`]: { $exists: false },
    },
    { $push: { decisions: decision } },
  );
  const saved = await ContentReport.findById(id).lean();
  const intent = saved?.decisions.find((d) => d.requestId === input.requestId);
  if (!intent) return "capacity" as const;
  if (intent.action !== input.action || intent.note !== input.note)
    return "conflict" as const;
  return reconcileDecision(id, input.requestId);
}
