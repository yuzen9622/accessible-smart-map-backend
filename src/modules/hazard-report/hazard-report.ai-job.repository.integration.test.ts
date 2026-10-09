import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import HazardReport from "../../model/hazard-report.model";
import {
  claimNextAiJob,
  convergeStuckAiJobs,
  failAiJob,
  finalizeAiReview,
  requeueAiJob,
} from "./hazard-report.ai-job.repository";
import { expireStaleReports } from "./hazard-report.expire";
import {
  scrubReportContent,
  setManualReview,
} from "./hazard-report.repository";
import {
  decision,
  readDoc,
  seedQueued,
  seedReport,
} from "../../../tests/helpers/hazard-report-fixtures";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const fence = (claim: {
  reportId: string;
  generation: number;
  leaseToken: string;
}) => ({
  reportId: claim.reportId,
  generation: claim.generation,
  leaseToken: claim.leaseToken,
});

describe("hazard AI job repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  afterEach(async () => {
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("claims a due queued job once and consumes an attempt", async () => {
    const id = await seedQueued();
    const first = await claimNextAiJob(new Date(), "lease-1");
    expect(first).toMatchObject({
      reportId: id,
      attempts: 1,
      generation: 1,
      leaseToken: "lease-1",
      hazardType: "obstacle",
      model: "test-model",
    });
    expect(await claimNextAiJob(new Date(), "lease-2")).toBeNull();
    const doc = await readDoc(id);
    expect(doc?.aiReview.state).toBe("processing");
  });

  it("lets exactly one of two concurrent workers claim the same job", async () => {
    await seedQueued();
    const results = await Promise.all([
      claimNextAiJob(new Date(), "worker-a"),
      claimNextAiJob(new Date(), "worker-b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("never claims jobs that are not eligible", async () => {
    const future = new Date(Date.now() + 60_000);
    await seedQueued({}, { nextAttemptAt: future });
    await seedQueued({}, { deadlineAt: new Date(Date.now() - 1) });
    await seedQueued({}, { attempts: 3 });
    await seedQueued({ expiredAt: new Date(Date.now() - 1) });
    await seedQueued({ contentScrubbedAt: new Date() });
    await seedQueued({
      manualReview: {
        reviewerId: "a",
        decision: "verified",
        reviewedAt: new Date(),
      },
    });
    await seedQueued({
      photoIntake: {
        state: "uploading",
        uploadToken: "t",
        deadlineAt: future,
        storagePath: "reports/p.jpg",
      },
    });
    await seedQueued({ photoStoragePath: undefined });
    expect(await claimNextAiJob(new Date(), "lease")).toBeNull();
  });

  it("reclaims an expired lease and fences out the old token", async () => {
    const id = await seedQueued();
    const old = (await claimNextAiJob(new Date(), "old-token"))!;
    // A live lease is not stolen.
    expect(await claimNextAiJob(new Date(), "thief")).toBeNull();
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.leaseExpiresAt": new Date(Date.now() - 1) } },
    );
    const fresh = (await claimNextAiJob(new Date(), "new-token"))!;
    expect(fresh.attempts).toBe(2);

    // The old worker answers late: it cannot commit nor overwrite.
    expect(await finalizeAiReview(fence(old), decision(), new Date())).toBe(
      false,
    );
    expect(await failAiJob(fence(old), "X", new Date())).toBe(false);
    expect(await requeueAiJob(fence(old), "X", new Date(), 0, new Date())).toBe(
      false,
    );
    expect((await readDoc(id))?.status).toBe("pending");

    expect(await finalizeAiReview(fence(fresh), decision(), new Date())).toBe(
      true,
    );
    const doc = await readDoc(id);
    expect(doc).toMatchObject({
      status: "verified",
      aiVerification: { verdict: "verified" },
      aiReview: { state: "completed", decision: "supported" },
    });
    expect(doc?.aiReviewJob.leaseToken).toBeUndefined();
    expect(doc?.aiReview.queuedAt).toBeInstanceOf(Date);
  });

  it("projects needs_evidence to pending/suspicious and unsupported to a closed rejection", async () => {
    const a = await seedQueued();
    const claimA = (await claimNextAiJob(new Date(), "a"))!;
    await finalizeAiReview(
      fence(claimA),
      decision({
        decision: "needs_evidence",
        reasonCode: "IMAGE_EVIDENCE_INSUFFICIENT",
      }),
      new Date(),
    );
    expect(await readDoc(a)).toMatchObject({
      status: "pending",
      aiVerification: { verdict: "suspicious" },
      aiReview: { state: "completed", decision: "needs_evidence" },
    });

    const b = await seedQueued();
    const claimB = (await claimNextAiJob(new Date(), "b"))!;
    await finalizeAiReview(
      fence(claimB),
      decision({ decision: "unsupported" }),
      new Date(),
    );
    const rejected = await readDoc(b);
    expect(rejected).toMatchObject({
      status: "rejected",
      aiVerification: { verdict: "rejected" },
    });
    expect(rejected?.closedAt).toBeInstanceOf(Date);
  });

  it("refuses to finalize after the deadline, expiry, manual review or scrub", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      deadline: { "aiReviewJob.deadlineAt": new Date(Date.now() - 1) },
      expiry: { expiredAt: new Date(Date.now() - 1) },
      manual: {
        manualReview: {
          reviewerId: "a",
          decision: "rejected",
          reviewedAt: new Date(),
        },
      },
      scrub: { contentScrubbedAt: new Date() },
      "lease expiry": {
        "aiReviewJob.leaseExpiresAt": new Date(Date.now() - 1),
      },
    };
    for (const [name, patch] of Object.entries(cases)) {
      const id = await seedQueued();
      const claim = (await claimNextAiJob(new Date(), `l-${name}`))!;
      await HazardReport.updateOne({ _id: id }, { $set: patch });
      expect(
        await finalizeAiReview(fence(claim), decision(), new Date()),
        name,
      ).toBe(false);
      expect((await readDoc(id))?.aiReview.state, name).toBe("processing");
    }
  });

  it("requeues with backoff and an invalid-output counter", async () => {
    const id = await seedQueued();
    const claim = (await claimNextAiJob(new Date(), "l"))!;
    const later = new Date(Date.now() + 15_000);
    expect(
      await requeueAiJob(fence(claim), "AI_TIMEOUT", later, 1, new Date()),
    ).toBe(true);
    const doc = await readDoc(id);
    expect(doc?.aiReview.state).toBe("queued");
    expect(doc?.aiReviewJob).toMatchObject({
      errorCode: "AI_TIMEOUT",
      invalidOutputAttempts: 1,
    });
    expect(await claimNextAiJob(new Date(), "early")).toBeNull();
    const retry = await claimNextAiJob(new Date(Date.now() + 16_000), "again");
    expect(retry).toMatchObject({ attempts: 2, invalidOutputAttempts: 1 });
  });

  it("protects an unelapsed live lease when only the attempt budget is exhausted", async () => {
    const now = new Date();
    const pastDeadline = await seedQueued(
      {},
      { deadlineAt: new Date(now.getTime() - 1) },
    );
    const exhausted = await seedQueued({}, { attempts: 3 });
    const expiredLeaseExhausted = await seedQueued(
      {},
      {
        attempts: 3,
        leaseToken: "dead",
        leaseExpiresAt: new Date(now.getTime() - 1),
      },
    );
    await HazardReport.updateOne(
      { _id: expiredLeaseExhausted },
      { $set: { "aiReview.state": "processing" } },
    );
    const liveLease = await seedQueued(
      {},
      {
        attempts: 3,
        leaseToken: "live",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        deadlineAt: new Date(now.getTime() + 60_000),
      },
    );
    await HazardReport.updateOne(
      { _id: liveLease },
      { $set: { "aiReview.state": "processing" } },
    );
    const reportExpired = await seedQueued({
      expiredAt: new Date(now.getTime() - 1),
    });
    const healthy = await seedQueued();
    const completed = await seedQueued();
    await HazardReport.updateOne(
      { _id: completed },
      {
        $set: {
          "aiReview.state": "completed",
          "aiReview.decision": "needs_evidence",
        },
      },
    );

    const outcome = await convergeStuckAiJobs(now);
    expect(outcome).toEqual({ failed: 3, cancelled: 1 });
    for (const id of [pastDeadline, exhausted, expiredLeaseExhausted]) {
      const doc = await readDoc(id);
      expect(doc?.aiReview.state).toBe("failed");
      expect(doc?.aiReviewJob.generation).toBe(2);
      expect(doc?.aiVerification.verdict).toBe("skipped");
      expect(doc?.status).toBe("pending");
    }
    expect((await readDoc(reportExpired))?.aiReview.state).toBe("cancelled");
    expect((await readDoc(liveLease))?.aiReview.state).toBe("processing");
    expect((await readDoc(healthy))?.aiReview.state).toBe("queued");
    expect((await readDoc(completed))?.aiReview.decision).toBe(
      "needs_evidence",
    );
  });

  it("revokes a still-live lease at the absolute job deadline and fences its late result", async () => {
    const now = new Date();
    const id = await seedQueued(
      {},
      {
        deadlineAt: new Date(now.getTime() - 1),
        leaseToken: "late",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    );
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReview.state": "processing" } },
    );
    expect(await convergeStuckAiJobs(now)).toEqual({ failed: 1, cancelled: 0 });
    expect(
      await finalizeAiReview(
        { reportId: id, generation: 1, leaseToken: "late" },
        decision(),
        now,
      ),
    ).toBe(false);
    expect(await readDoc(id)).toMatchObject({
      status: "pending",
      aiReview: { state: "failed" },
      aiReviewJob: { generation: 2 },
    });
  });

  it("expiry cancels an active job and bumps the generation but keeps completed history", async () => {
    const active = await seedQueued({ expiredAt: new Date(Date.now() - 1) });
    const claimable = await seedQueued();
    const claim = (await claimNextAiJob(new Date(), "l"))!;
    expect(claim.reportId).toBe(active === claim.reportId ? active : claimable);
    await HazardReport.updateMany(
      {},
      { $set: { expiredAt: new Date(Date.now() - 1) } },
    );
    const done = await seedQueued({ expiredAt: new Date(Date.now() - 1) });
    await HazardReport.updateOne(
      { _id: done },
      {
        $set: {
          "aiReview.state": "completed",
          "aiReview.decision": "supported",
          status: "verified",
        },
      },
    );

    expect(await expireStaleReports()).toBe(3);
    const cancelled = await readDoc(claim.reportId);
    expect(cancelled).toMatchObject({
      status: "expired",
      aiReview: { state: "cancelled" },
    });
    expect(cancelled?.aiReviewJob.generation).toBe(2);
    expect(cancelled?.closedAt).toBeInstanceOf(Date);
    // A late result from the revoked lease cannot resurrect it.
    expect(await finalizeAiReview(fence(claim), decision(), new Date())).toBe(
      false,
    );
    expect(await readDoc(done)).toMatchObject({
      status: "expired",
      aiReview: { state: "completed", decision: "supported" },
    });
  });

  it("a manual decision cancels the job atomically and blocks a late AI result", async () => {
    const id = await seedQueued();
    const claim = (await claimNextAiJob(new Date(), "l"))!;
    const updated = await setManualReview(id, {
      reviewerId: "admin-1",
      decision: "rejected",
      note: "$set is only text",
      reviewedAt: new Date(),
    });
    expect(updated).toMatchObject({
      status: "rejected",
      manualReview: { decision: "rejected", note: "$set is only text" },
      aiReview: { state: "cancelled" },
    });
    expect(updated?.closedAt).toBeInstanceOf(Date);
    expect(await finalizeAiReview(fence(claim), decision(), new Date())).toBe(
      false,
    );
    const doc = await readDoc(id);
    expect(doc?.status).toBe("rejected");
    expect(doc?.manualReview.reviewerId).toBe("admin-1");

    // Verifying reopens: closedAt is cleared.
    const reopened = await setManualReview(id, {
      reviewerId: "admin-1",
      decision: "verified",
      reviewedAt: new Date(),
    });
    expect(reopened?.status).toBe("verified");
    expect(reopened?.closedAt).toBeUndefined();
  });

  it("retention scrub removes new free text, job metadata and hash and cancels the job", async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const active = await seedQueued();
    const claim = (await claimNextAiJob(new Date(), "l"))!;
    const done = await seedQueued();
    const doneClaim = (await claimNextAiJob(new Date(), "l2"))!;
    expect(
      await finalizeAiReview(fence(doneClaim), decision(), new Date()),
    ).toBe(true);
    // Both now fall past the retention cutoff.
    await HazardReport.updateMany({}, { $set: { expiredAt: old } });

    const cutoff = new Date();
    for (const target of [active, done]) {
      expect(await scrubReportContent(target, cutoff, "deidentified:z")).toBe(
        true,
      );
    }
    const scrubbed = await readDoc(active);
    expect(scrubbed?.aiReviewJob).toBeUndefined();
    expect(scrubbed?.aiReview?.state).toBe("cancelled");
    expect(scrubbed?.aiReview?.reason).toBe("[redacted]");
    expect(scrubbed?.description).toBeUndefined();
    const doneDoc = await readDoc(done);
    expect(doneDoc?.aiReview?.state).toBe("completed");
    expect(doneDoc?.aiReview?.observations).toBeUndefined();
    expect(doneDoc?.aiReview?.limitations).toBeUndefined();
    expect(doneDoc?.aiReview?.reason).toBe("[redacted]");
    expect(doneDoc?.aiReviewJob).toBeUndefined();
    // A late result cannot restore anything.
    expect(await finalizeAiReview(fence(claim), decision(), new Date())).toBe(
      false,
    );
    expect((await readDoc(active))?.aiReview?.observations).toBeUndefined();
  });

  it("an account-anonymised reporter survives a worker commit", async () => {
    const id = await seedQueued();
    const claim = (await claimNextAiJob(new Date(), "l"))!;
    await HazardReport.updateOne(
      { _id: id },
      { $set: { reporterId: "deleted-user:abc", confirmedBy: [] } },
    );
    expect(await finalizeAiReview(fence(claim), decision(), new Date())).toBe(
      true,
    );
    expect((await readDoc(id))?.reporterId).toBe("deleted-user:abc");
  });

  it("legacy reports without v2 fields are untouched by claims and convergence", async () => {
    const id = await seedReport({
      status: "pending",
      aiVerification: { verdict: "skipped", confidence: 0, reason: "old" },
    });
    expect(await claimNextAiJob(new Date(), "l")).toBeNull();
    expect(await convergeStuckAiJobs(new Date())).toEqual({
      failed: 0,
      cancelled: 0,
    });
    expect((await readDoc(id))?.aiReview).toBeUndefined();
  });
});
