import * as repository from "./content-safety.repository";
import type {
  DecisionInput,
  ReportInput,
  TargetInput,
} from "./content-safety.schema";

function ok(data: unknown) {
  return { ok: true, httpCode: 200, message: "OK", data };
}
function fail(httpCode: number, reason: string) {
  return { ok: false, httpCode, message: reason, data: { reason } };
}

export async function reportContent(userId: string, input: ReportInput) {
  const [target, user] = await Promise.all([
    repository.findSafetyTarget(input),
    repository.safetyUser(userId),
  ]);
  if (!target || !user) return fail(404, "CONTENT_UNAVAILABLE");
  if (target.authorId === userId) return fail(400, "SELF_REPORT");
  if ((await repository.blockedAuthorIds(userId)).includes(target.authorId))
    return fail(404, "CONTENT_UNAVAILABLE");
  const now = new Date();
  const email = user.emailVerified ? user.email : undefined;
  let inserted: Awaited<ReturnType<typeof repository.insertContentReport>>;
  try {
    inserted = await repository.insertContentReport({
      reporterId: userId,
      reporterEmail: email,
      targetType: input.targetType,
      targetId: input.targetId,
      targetVersion: target.version,
      authorId: target.authorId,
      reason: input.reason,
      details: input.details,
      language: input.language,
      snapshot: target.snapshot,
      status: "open",
      createdAt: now,
      purgeAt: new Date(now.getTime() + 365 * 86400000),
      decisions: [],
      mails: {
        team: { state: "pending", attempts: 0, nextAttemptAt: now },
        reporter: {
          state: email ? "pending" : "cancelled",
          attempts: 0,
          nextAttemptAt: now,
        },
      },
    });
  } catch {
    return fail(503, "REPORT_RETRY_REQUIRED");
  }
  if (!inserted) return fail(429, "RATE_LIMITED");
  const { doc, duplicate } = inserted;
  return ok({
    caseNumber: String(doc._id),
    receivedAt: doc.createdAt,
    confirmationEmail: doc.reporterEmail ? "queued" : "unavailable",
    duplicate,
  });
}
export async function blockContentAuthor(
  userId: string,
  targetInput: TargetInput,
) {
  const target = await repository.findSafetyTarget(targetInput);
  if (!target) return fail(404, "CONTENT_UNAVAILABLE");
  if (target.authorId === userId) return fail(400, "SELF_BLOCK");
  if (!(await repository.safetyUser(target.authorId)))
    return fail(400, "AUTHOR_UNAVAILABLE");
  await repository.putBlock(userId, target.authorId, targetInput.targetType);
  return ok(null);
}
export async function getBlocks(userId: string) {
  return ok({ items: await repository.listBlocks(userId) });
}
export async function unblock(userId: string, blockId: string) {
  await repository.removeBlock(userId, blockId);
  return ok(null);
}
export async function getCase(id: string) {
  const doc = await repository.findCase(id);
  if (!doc) return fail(404, "CASE_NOT_FOUND");
  return ok({
    caseNumber: String(doc._id),
    targetType: doc.targetType,
    targetId: doc.targetId,
    reason: doc.reason,
    details: doc.details,
    snapshot: doc.snapshot,
    status: doc.status,
    receivedAt: doc.createdAt,
    admission: doc.admission,
    decisions: doc.decisions,
    delivery: {
      team: doc.mails.team.state,
      reporter: doc.mails.reporter.state,
    },
  });
}
export async function decide(
  id: string,
  actorId: string,
  input: DecisionInput,
) {
  const result = await repository
    .decideCase(id, actorId, input)
    .catch(() => "pending" as const);
  return result === "ok"
    ? ok(null)
    : fail(
        result === "forbidden"
          ? 403
          : result === "conflict" || result === "superseded"
            ? 400
            : result === "pending" || result === "capacity"
              ? 503
              : 404,
        result.toUpperCase(),
      );
}
export { blockedAuthorIds } from "./content-safety.repository";
export async function mayContribute(userId: string): Promise<boolean> {
  const user = await repository.safetyUser(userId);
  return Boolean(user && !user.contentRestrictedAt);
}

export async function listCases(cursor?: string) {
  return ok(await repository.listCases(cursor));
}
