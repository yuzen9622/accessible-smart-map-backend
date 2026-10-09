import { toReportView } from "./hazard-report.view";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import HazardReport from "../../model/hazard-report.model";
import {
  addConfirmation,
  countActiveVerifiedWithin,
  findActiveDuplicate,
  findActiveVerifiedWithin,
  findConfirmedWithin,
  findNearbyReports,
  findPublicReportById,
  findReportById,
  findReportsByReporter,
  findReviewQueueReports,
} from "./hazard-report.repository";
import {
  seedQueued,
  seedReport,
} from "../../../tests/helpers/hazard-report-fixtures";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const CENTER = { lat: 25.033, lng: 121.565 };
const intake = (state: "uploading" | "cleanup") => ({
  photoIntake: {
    state,
    uploadToken: "t",
    deadlineAt: new Date(Date.now() + 60_000),
    storagePath: "reports/p.jpg",
  },
});
const supported = { "aiReview.decision": "supported" };

async function seedV2Verified(over: Record<string, unknown> = {}) {
  const id = await seedQueued({ status: "verified", ...over });
  await HazardReport.updateOne(
    { _id: id },
    {
      $set: { "aiReview.state": "completed", "aiReview.decision": "supported" },
    },
  );
  return id;
}

describe("hazard-report visibility predicates with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  beforeEach(async () => {
    // dropDatabase in afterEach also drops the 2dsphere index $near needs.
    await HazardReport.createIndexes();
  });
  afterEach(async () => {
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  const near = (
    statuses: ("pending" | "verified" | "rejected" | "expired")[],
  ) =>
    findNearbyReports(
      CENTER.lat,
      CENTER.lng,
      500,
      statuses,
      undefined,
      50,
      new Date(),
    );

  it("private intakes and tombstones are invisible to every query", async () => {
    const hidden = [
      await seedReport(intake("uploading")),
      await seedReport({ status: "pending", ...intake("uploading") }),
      await seedReport({ status: "verified", ...intake("cleanup") }),
    ];
    const now = new Date();
    for (const id of hidden) {
      expect(await findPublicReportById(id)).toBeNull();
      expect(await findReportById(id)).toBeNull();
      expect(await addConfirmation(id, "voter")).toBeNull();
    }
    expect(await near(["pending", "verified", "expired"])).toHaveLength(0);
    expect(await countActiveVerifiedWithin(CENTER, 500, now)).toBe(0);
    expect(
      await findActiveVerifiedWithin(CENTER, 500, 10, undefined, now),
    ).toHaveLength(0);
    expect(await findConfirmedWithin(CENTER, 500, 10, now)).toHaveLength(0);
    expect(
      await findActiveDuplicate(
        CENTER.lat,
        CENTER.lng,
        50,
        "obstacle",
        now,
        new Date(0),
      ),
    ).toBeNull();
    expect(await findReportsByReporter("reporter-1", {}, 10)).toHaveLength(0);
    expect(
      await findReviewQueueReports(new Date(), undefined, 10),
    ).toHaveLength(0);
  });

  it("a ready intake is visible like a normal report", async () => {
    const id = await seedV2Verified();
    expect(await findPublicReportById(id)).not.toBeNull();
    expect((await near(["verified"])).map((r) => String(r._id))).toEqual([id]);
  });

  it("default active set excludes queued, needs_evidence, failed, cancelled, expired and scrubbed", async () => {
    const good = await seedV2Verified();
    const legacy = await seedReport();
    await seedQueued();
    await seedQueued({ status: "pending" }, {});
    const needs = await seedQueued();
    await HazardReport.updateOne(
      { _id: needs },
      {
        $set: {
          "aiReview.state": "completed",
          "aiReview.decision": "needs_evidence",
        },
      },
    );
    // A v2 record that carries a stale legacy verified status but no support.
    await seedQueued({ status: "verified" });
    await seedV2Verified({ expiredAt: new Date(Date.now() - 1) });
    await seedV2Verified({ contentScrubbedAt: new Date() });

    const ids = (await near(["verified"])).map((r) => String(r._id)).sort();
    expect(ids).toEqual([good, legacy].sort());
    expect(await countActiveVerifiedWithin(CENTER, 500, new Date())).toBe(2);
  });

  it("human verification qualifies a v2 report that the AI did not support", async () => {
    const id = await seedQueued({ status: "verified" });
    await HazardReport.updateOne(
      { _id: id },
      {
        $set: {
          "aiReview.state": "completed",
          "aiReview.decision": "needs_evidence",
          manualReview: {
            reviewerId: "a",
            decision: "verified",
            reviewedAt: new Date(),
          },
        },
      },
    );
    expect((await near(["verified"])).map((r) => String(r._id))).toEqual([id]);
  });

  it("explicit pending query returns unexpired pending rows with their aiReview, never internals", async () => {
    const queued = await seedQueued();
    await seedQueued({ expiredAt: new Date(Date.now() - 1) });
    const rows = await near(["pending"]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(queued);
    expect(rows[0].aiReview).toMatchObject({ state: "queued" });
    expect(rows[0]).not.toHaveProperty("photoIntake");
    expect(toReportView(rows[0], false)).not.toHaveProperty("photoStoragePath");
  });

  it("route eligibility keeps legacy unchanged and requires support for v2", async () => {
    const voters = { confirmedBy: ["other"], confirmCount: 1 };
    const legacy = await seedReport(voters);
    const v2 = await seedV2Verified(voters);
    await seedQueued({ status: "verified", ...voters });
    const ids = (await findConfirmedWithin(CENTER, 500, 10, new Date()))
      .map((r) => String(r._id))
      .sort();
    expect(ids).toEqual([legacy, v2].sort());
  });

  it("a stale supported decision on a processing, failed or cancelled v2 record is never active or mergeable", async () => {
    const now = new Date();
    const find = () =>
      findActiveDuplicate(
        CENTER.lat,
        CENTER.lng,
        50,
        "obstacle",
        now,
        new Date(0),
      );
    for (const state of ["processing", "failed", "cancelled", "queued"]) {
      const id = await seedQueued({
        status: "verified",
        confirmedBy: ["other"],
        confirmCount: 1,
      });
      await HazardReport.updateOne(
        { _id: id },
        { $set: { "aiReview.state": state, "aiReview.decision": "supported" } },
      );
      expect(await near(["verified"]), state).toHaveLength(0);
      expect(await countActiveVerifiedWithin(CENTER, 500, now), state).toBe(0);
      expect(
        await findConfirmedWithin(CENTER, 500, 10, now),
        state,
      ).toHaveLength(0);
      expect(
        await findActiveVerifiedWithin(CENTER, 500, 10, undefined, now),
        state,
      ).toHaveLength(0);
      // Raw status=verified must not soak up a re-shot as a vote either.
      expect(await find(), state).toBeNull();
      await HazardReport.deleteOne({ _id: id });
    }
  });

  it("dedup merges verified and live pending, but not settled or stalled reports", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 600_000);
    const find = () =>
      findActiveDuplicate(CENTER.lat, CENTER.lng, 50, "obstacle", now, stale);

    const needs = await seedQueued();
    await HazardReport.updateOne(
      { _id: needs },
      {
        $set: {
          "aiReview.state": "completed",
          "aiReview.decision": "needs_evidence",
        },
      },
    );
    const failed = await seedQueued();
    await HazardReport.updateOne(
      { _id: failed },
      { $set: { "aiReview.state": "failed" } },
    );
    const cancelled = await seedQueued();
    await HazardReport.updateOne(
      { _id: cancelled },
      { $set: { "aiReview.state": "cancelled" } },
    );
    await seedQueued({}, { deadlineAt: new Date(now.getTime() - 1) });
    await seedReport({
      status: "pending",
      aiVerification: { verdict: "skipped", confidence: 0, reason: "stalled" },
      createdAt: new Date(now.getTime() - 3_600_000),
    });
    // The legacy UI also offers re-shoot for suspicious evidence: don't swallow it.
    await seedReport({
      status: "pending",
      aiVerification: {
        verdict: "suspicious",
        confidence: 0.95,
        reason: "needs clearer evidence",
      },
    });
    expect(await find()).toBeNull();

    const processing = await seedQueued();
    expect(String((await find())?._id)).toBe(processing);
    await HazardReport.deleteOne({ _id: processing });

    const fresh = await seedReport({
      status: "pending",
      aiVerification: { verdict: "skipped", confidence: 0, reason: "fresh" },
    });
    expect(String((await find())?._id)).toBe(fresh);
    await HazardReport.deleteOne({ _id: fresh });

    const verified = await seedV2Verified();
    expect(String((await find())?._id)).toBe(verified);
  });

  it("admin queue only holds legacy suspicious or stale-skipped reports", async () => {
    const cutoff = new Date(Date.now() - 600_000);
    const old = new Date(Date.now() - 3_600_000);
    const legacySuspicious = await seedReport({
      status: "pending",
      aiVerification: { verdict: "suspicious", confidence: 0.5, reason: "x" },
    });
    const legacyStale = await seedReport({
      status: "pending",
      createdAt: old,
      aiVerification: { verdict: "skipped", confidence: 0, reason: "x" },
    });
    // v2 records project to the same legacy enums but must not be queued.
    const staleQueued = await seedQueued({ createdAt: old });
    const needs = await seedQueued();
    await HazardReport.updateOne(
      { _id: needs },
      {
        $set: {
          "aiReview.state": "completed",
          "aiReview.decision": "needs_evidence",
          "aiVerification.verdict": "suspicious",
        },
      },
    );
    const failed = await seedQueued({ createdAt: old });
    await HazardReport.updateOne(
      { _id: failed },
      { $set: { "aiReview.state": "failed" } },
    );

    const rows = await findReviewQueueReports(cutoff, undefined, 20);
    expect(rows.map((r) => String(r._id)).sort()).toEqual(
      [legacySuspicious, legacyStale].sort(),
    );
    expect([staleQueued, needs, failed]).toHaveLength(3);
    expect(supported).toBeDefined();
  });
});
