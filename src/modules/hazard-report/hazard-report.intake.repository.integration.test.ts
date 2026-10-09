import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import HazardReport from "../../model/hazard-report.model";
import {
  abandonIntake,
  claimIntakeCleanup,
  commitIntakeReady,
  convertExpiredIntakes,
  insertPrivateIntake,
  readIntakeState,
  settleIntakeCleanupFailure,
  settleIntakeCleanupSuccess,
  type IntakeInsert,
} from "./hazard-report.intake.repository";
import { buildQueuedReview } from "./hazard-report.ai-job.repository";
import { findPublicReportById } from "./hazard-report.repository";
import { newId, readDoc } from "../../../tests/helpers/hazard-report-fixtures";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

function intakeDoc(over: Partial<IntakeInsert> = {}): IntakeInsert {
  const _id = over._id ?? newId();
  return {
    _id,
    reporterId: "reporter-1",
    reportedLocation: { type: "Point", coordinates: [121.565, 25.033] },
    hazardType: "obstacle",
    severity: "blocking",
    expectedUntil: null,
    description: "private words",
    exifValidation: {
      timestampFresh: true,
      gpsPresent: true,
      gpsMatchesClaimed: true,
      rawExifLat: 25.033,
      rawExifLng: 121.565,
    },
    expiredAt: new Date(Date.now() + 3_600_000),
    uploadToken: "token-1",
    storagePath: `reports/${_id}.jpg`,
    deadlineAt: new Date(Date.now() + 300_000),
    ...over,
  };
}

const queued = (now: Date) =>
  buildQueuedReview(now, new Date(now.getTime() + 3_600_000), {
    model: "m",
    policyVersion: "hazard-photo-v2",
    imageHash: "h".repeat(64),
    mimeType: "image/jpeg",
  });

describe("hazard photo intake with real MongoDB", () => {
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

  it("commits photo, queued review and job in one update and then becomes visible", async () => {
    const doc = intakeDoc();
    await insertPrivateIntake(doc);
    expect(await findPublicReportById(doc._id)).toBeNull();
    const now = new Date();
    expect(
      await commitIntakeReady(
        doc._id,
        doc.uploadToken,
        now,
        { url: "https://x/y.jpg", storagePath: doc.storagePath },
        queued(now),
      ),
    ).toBe(true);
    const stored = await readDoc(doc._id);
    expect(stored).toMatchObject({
      photoUrl: "https://x/y.jpg",
      photoStoragePath: doc.storagePath,
      aiReview: { state: "queued" },
      aiReviewJob: {
        generation: 1,
        attempts: 0,
        model: "m",
        imageHash: "h".repeat(64),
      },
      photoIntake: { state: "ready" },
    });
    expect(await readIntakeState(doc._id, doc.uploadToken)).toBe("ready");
    expect(await findPublicReportById(doc._id)).not.toBeNull();
    // A second commit with the same token cannot rewrite the ready report.
    expect(
      await commitIntakeReady(
        doc._id,
        doc.uploadToken,
        now,
        { url: "u2", storagePath: "p2" },
        queued(now),
      ),
    ).toBe(false);
    expect((await readDoc(doc._id))?.photoUrl).toBe("https://x/y.jpg");
  });

  it.each(["scrubbed", "expired-clock", "closed-status", "manual-review"])(
    "does not revive a %s report even with a matching live upload token",
    async (change) => {
      const doc = intakeDoc();
      await insertPrivateIntake(doc);
      const now = new Date();
      const update =
        change === "scrubbed"
          ? { contentScrubbedAt: now }
          : change === "expired-clock"
            ? { expiredAt: new Date(now.getTime() - 1) }
            : change === "closed-status"
              ? { status: "rejected" }
              : {
                  manualReview: {
                    reviewerId: "admin",
                    decision: "verified",
                    reviewedAt: now,
                  },
                };
      await HazardReport.updateOne({ _id: doc._id }, { $set: update });
      expect(
        await commitIntakeReady(
          doc._id,
          doc.uploadToken,
          now,
          { url: "https://x/y.jpg", storagePath: doc.storagePath },
          queued(now),
        ),
      ).toBe(false);
      const stored = await readDoc(doc._id);
      expect(stored?.aiReviewJob).toBeUndefined();
      expect(stored?.photoUrl).toBeUndefined();
      expect(stored?.photoIntake?.state).toBe("uploading");
    },
  );

  it("rejects a commit with the wrong token or after the intake deadline", async () => {
    const wrongToken = intakeDoc();
    await insertPrivateIntake(wrongToken);
    const late = intakeDoc({ deadlineAt: new Date(Date.now() - 1) });
    await insertPrivateIntake(late);
    const now = new Date();
    expect(
      await commitIntakeReady(
        wrongToken._id,
        "other",
        now,
        { url: "u", storagePath: "p" },
        queued(now),
      ),
    ).toBe(false);
    expect(
      await commitIntakeReady(
        late._id,
        late.uploadToken,
        now,
        { url: "u", storagePath: "p" },
        queued(now),
      ),
    ).toBe(false);
    expect(await readIntakeState(wrongToken._id, "other")).toBeNull();
    expect((await readDoc(late._id))?.aiReview).toBeUndefined();
  });

  it("an overdue upload becomes an anonymous tombstone and a late commit cannot revive it", async () => {
    const doc = intakeDoc({ deadlineAt: new Date(Date.now() - 1) });
    await insertPrivateIntake(doc);
    expect(
      await convertExpiredIntakes(new Date(), () => "deidentified:one"),
    ).toBe(1);
    const tomb = await readDoc(doc._id);
    expect(tomb).toMatchObject({
      reporterId: "deidentified:one",
      status: "expired",
      photoIntake: {
        state: "cleanup",
        storagePath: doc.storagePath,
        cleanupAttempts: 0,
      },
    });
    expect(tomb?.description).toBeUndefined();
    expect(tomb?.exifValidation?.rawExifLat).toBeUndefined();
    expect(tomb?.reportedLocation.coordinates).toEqual([0, 0]);
    expect(tomb?.contentScrubbedAt).toBeInstanceOf(Date);
    const now = new Date();
    expect(
      await commitIntakeReady(
        doc._id,
        doc.uploadToken,
        now,
        { url: "u", storagePath: "p" },
        queued(now),
      ),
    ).toBe(false);
    expect(
      await convertExpiredIntakes(new Date(), () => "deidentified:two"),
    ).toBe(0);
  });

  it("maintenance never converts a report that already became ready", async () => {
    const doc = intakeDoc();
    await insertPrivateIntake(doc);
    const now = new Date();
    await commitIntakeReady(
      doc._id,
      doc.uploadToken,
      now,
      { url: "u", storagePath: doc.storagePath },
      queued(now),
    );
    await HazardReport.updateOne(
      { _id: doc._id },
      { $set: { "photoIntake.deadlineAt": new Date(Date.now() - 1) } },
    );
    expect(
      await convertExpiredIntakes(new Date(), () => "deidentified:x"),
    ).toBe(0);
    expect((await readDoc(doc._id))?.photoIntake?.state).toBe("ready");
  });

  it("the producer's abandon is fenced on its token and not on a ready report", async () => {
    const doc = intakeDoc();
    await insertPrivateIntake(doc);
    expect(
      await abandonIntake(doc._id, "wrong", new Date(), "deidentified:a"),
    ).toBe(false);
    expect(
      await abandonIntake(
        doc._id,
        doc.uploadToken,
        new Date(),
        "deidentified:a",
      ),
    ).toBe(true);
    const ready = intakeDoc();
    await insertPrivateIntake(ready);
    const now = new Date();
    await commitIntakeReady(
      ready._id,
      ready.uploadToken,
      now,
      { url: "u", storagePath: ready.storagePath },
      queued(now),
    );
    expect(
      await abandonIntake(
        ready._id,
        ready.uploadToken,
        new Date(),
        "deidentified:b",
      ),
    ).toBe(false);
  });

  it("cleanup keeps tracking on failure, repeats on success, and drops it after the window", async () => {
    const doc = intakeDoc();
    await insertPrivateIntake(doc);
    await abandonIntake(doc._id, doc.uploadToken, new Date(), "deidentified:a");

    const claim = (await claimIntakeCleanup(new Date()))!;
    expect(claim).toMatchObject({
      reportId: doc._id,
      storagePath: doc.storagePath,
      attempts: 1,
    });
    // A second worker cannot take the same claim while it is in flight.
    expect(await claimIntakeCleanup(new Date())).toBeNull();

    await settleIntakeCleanupFailure(claim, new Date());
    const failed = await readDoc(doc._id);
    expect(failed?.photoIntake?.storagePath).toBe(doc.storagePath);
    expect(failed?.photoIntake?.nextCleanupAt!.getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Inside the window: success schedules another delete of the same path.
    await HazardReport.updateOne(
      { _id: doc._id },
      { $set: { "photoIntake.nextCleanupAt": new Date(Date.now() - 1) } },
    );
    const second = (await claimIntakeCleanup(new Date()))!;
    expect(second.attempts).toBe(2);
    expect(await settleIntakeCleanupSuccess(second, new Date())).toBe(false);
    expect((await readDoc(doc._id))?.photoIntake?.state).toBe("cleanup");

    // Past the late-upload window the anonymous tombstone is removed.
    await HazardReport.updateOne(
      { _id: doc._id },
      {
        $set: {
          "photoIntake.nextCleanupAt": new Date(Date.now() - 1),
          "photoIntake.cleanupUntil": new Date(Date.now() - 1),
        },
      },
    );
    const last = (await claimIntakeCleanup(new Date()))!;
    expect(await settleIntakeCleanupSuccess(last, new Date())).toBe(true);
    expect(await readDoc(doc._id)).toBeNull();
  });

  it("a failing delete past the window is retained, never silently dropped", async () => {
    const doc = intakeDoc();
    await insertPrivateIntake(doc);
    await abandonIntake(doc._id, doc.uploadToken, new Date(), "deidentified:a");
    await HazardReport.updateOne(
      { _id: doc._id },
      { $set: { "photoIntake.cleanupUntil": new Date(Date.now() - 1) } },
    );
    const claim = (await claimIntakeCleanup(new Date()))!;
    await settleIntakeCleanupFailure(claim, new Date());
    expect((await readDoc(doc._id))?.photoIntake?.state).toBe("cleanup");
  });
});
