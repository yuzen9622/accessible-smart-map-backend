import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import HazardReport from "../../model/hazard-report.model";
import {
  processAiJob,
  startHazardAiWorker,
  type AiWorkerDeps,
} from "./hazard-report.ai-worker";
import { claimNextAiJob } from "./hazard-report.ai-job.repository";
import {
  abandonIntake,
  insertPrivateIntake,
} from "./hazard-report.intake.repository";
import {
  decision,
  newId,
  readDoc,
  seedQueued,
} from "../../../tests/helpers/hazard-report-fixtures";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const BYTES = Buffer.from("normalised-jpeg-bytes");
const HASH = createHash("sha256").update(BYTES).digest("hex");

class FakeAiError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public circuitBreak = false,
  ) {
    super(code);
  }
}

function deps(over: Partial<AiWorkerDeps> = {}): AiWorkerDeps {
  return {
    readPhoto: vi.fn(async () => BYTES),
    analyze: vi.fn(async () => decision()),
    deletePhoto: vi.fn(async () => undefined),
    now: () => new Date(),
    random: () => 0,
    ...over,
  };
}

async function claimed(jobOver: Record<string, unknown> = {}) {
  const id = await seedQueued({}, { imageHash: HASH, ...jobOver });
  const job = (await claimNextAiJob(new Date(), "lease-x"))!;
  return { id, job };
}

const live = new AbortController().signal;

async function waitFor(check: () => Promise<boolean>, ms = 6_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not reached in time");
}

describe("hazard AI worker with real MongoDB and faked external I/O", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await stopMongoTest(mongo);
  });

  it("reads by the stored path with a byte cap, analyses with the frozen model and commits", async () => {
    const { id, job } = await claimed();
    const d = deps();
    await processAiJob(job, d, live);
    expect(d.readPhoto).toHaveBeenCalledWith(
      job.storagePath,
      expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
    );
    expect(d.analyze).toHaveBeenCalledWith(
      BYTES,
      "image/jpeg",
      "obstacle",
      "free text from the reporter",
      expect.objectContaining({
        model: "test-model",
        policyVersion: "hazard-photo-v2",
      }),
    );
    expect(await readDoc(id)).toMatchObject({
      status: "verified",
      aiReview: { state: "completed", decision: "supported" },
    });
  });

  it("clamps even the first attempt to the absolute deadline, dropping ignored-abort results", async () => {
    const { id, job } = await claimed();
    job.deadlineAt = new Date(Date.now() + 150);
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.deadlineAt": job.deadlineAt } },
    );
    let resolve!: (value: ReturnType<typeof decision>) => void;
    const analyze = vi.fn(
      () =>
        new Promise<ReturnType<typeof decision>>((r) => {
          resolve = r;
        }),
    );
    const result = await processAiJob(job, deps({ analyze }), live);
    expect(result.outcome).toBe("failed");
    expect((await readDoc(id))?.aiReview?.state).toBe("failed");
    resolve(decision());
    await new Promise((r) => setTimeout(r, 10));
    expect((await readDoc(id))?.status).toBe("pending");
  });

  it("converges deadlines independently of a stalled GCS cleanup while AI is paused", async () => {
    const id = await seedQueued({}, { imageHash: HASH });
    const intakeId = newId();
    const now = new Date();
    await insertPrivateIntake({
      _id: intakeId,
      reporterId: "r",
      reportedLocation: { type: "Point", coordinates: [121.565, 25.033] },
      hazardType: "obstacle",
      severity: "blocking",
      expectedUntil: null,
      exifValidation: {
        timestampFresh: true,
        gpsPresent: false,
        gpsMatchesClaimed: false,
      },
      expiredAt: new Date(now.getTime() + 3600000),
      uploadToken: "tok",
      storagePath: `reports/${intakeId}.jpg`,
      deadlineAt: now,
    });
    await abandonIntake(intakeId, "tok", now, "deidentified:r");
    let release!: () => void;
    const deletePhoto = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const worker = startHazardAiWorker(deps({ deletePhoto }), {
      enabled: false,
    });
    try {
      await waitFor(async () => deletePhoto.mock.calls.length === 1);
      await HazardReport.updateOne(
        { _id: id },
        { $set: { "aiReviewJob.deadlineAt": new Date(0) } },
      );
      await waitFor(
        async () => (await readDoc(id))?.aiReview?.state === "failed",
      );
      expect(deletePhoto).toHaveBeenCalledTimes(1);
      expect(worker.getHealth().lastConvergenceAt).not.toBeNull();
    } finally {
      release?.();
      await worker.stop();
    }
  }, 8_000); // Real five-second scheduler tick, not a mocked maintenance call.

  it("fails an image whose hash differs from the pinned one without calling the model", async () => {
    const { id, job } = await claimed({ imageHash: "0".repeat(64) });
    const d = deps();
    await processAiJob(job, d, live);
    expect(d.analyze).not.toHaveBeenCalled();
    const doc = await readDoc(id);
    expect(doc?.aiReview?.state).toBe("failed");
    expect(doc?.aiReview?.reasonCode).toBe("IMAGE_HASH_MISMATCH");
    expect(doc?.status).toBe("pending");
  });

  it("fails jobs pinned to a policy this build cannot run", async () => {
    const { id, job } = await claimed({ policyVersion: "hazard-photo-v1" });
    const d = deps();
    await processAiJob(job, d, live);
    expect(d.readPhoto).not.toHaveBeenCalled();
    expect((await readDoc(id))?.aiReview?.reasonCode).toBe(
      "POLICY_UNSUPPORTED",
    );
  });

  it("requeues a retryable failure with 15s backoff and fails once attempts are used up", async () => {
    const analyze = vi.fn(async () => {
      throw new FakeAiError("AI_TIMEOUT", true);
    });
    const { id, job } = await claimed();
    const before = Date.now();
    await processAiJob(job, deps({ analyze }), live);
    let doc = await readDoc(id);
    expect(doc?.aiReview?.state).toBe("queued");
    expect(doc?.aiReviewJob?.errorCode).toBe("AI_TIMEOUT");
    expect(doc!.aiReviewJob!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 15_000,
    );

    // Attempts 2 and 3: backoff 30s, then the budget is spent.
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.nextAttemptAt": new Date(0) } },
    );
    const second = (await claimNextAiJob(new Date(), "l2"))!;
    await processAiJob(second, deps({ analyze }), live);
    doc = await readDoc(id);
    expect(doc!.aiReviewJob!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      Date.now() + 25_000,
    );
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.nextAttemptAt": new Date(0) } },
    );
    const third = (await claimNextAiJob(new Date(), "l3"))!;
    expect(third.attempts).toBe(3);
    await processAiJob(third, deps({ analyze }), live);
    doc = await readDoc(id);
    expect(doc?.aiReview?.state).toBe("failed");
    expect(doc?.aiReview?.reasonCode).toBe("AI_TIMEOUT");
    expect(
      await claimNextAiJob(new Date(Date.now() + 10 * 60_000), "l4"),
    ).toBeNull();
  });

  it("asks the model again at most once after MODEL_OUTPUT_INVALID", async () => {
    const analyze = vi.fn(async () => {
      throw new FakeAiError("MODEL_OUTPUT_INVALID", true);
    });
    const { id, job } = await claimed();
    await processAiJob(job, deps({ analyze }), live);
    expect((await readDoc(id))?.aiReviewJob).toMatchObject({
      invalidOutputAttempts: 1,
    });
    expect((await readDoc(id))?.aiReview?.state).toBe("queued");
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.nextAttemptAt": new Date(0) } },
    );
    const again = (await claimNextAiJob(new Date(), "l2"))!;
    await processAiJob(again, deps({ analyze }), live);
    const doc = await readDoc(id);
    expect(doc?.aiReview?.state).toBe("failed");
    expect(doc?.aiReview?.reasonCode).toBe("MODEL_OUTPUT_INVALID");
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("fails non-retryable provider errors and GCS 404 / permission errors without retry", async () => {
    const cases: [Partial<AiWorkerDeps>, string][] = [
      [
        {
          analyze: async () => {
            throw new FakeAiError("PROVIDER_BAD_REQUEST", false);
          },
        },
        "PROVIDER_BAD_REQUEST",
      ],
      [
        {
          readPhoto: async () => {
            throw Object.assign(new Error("raw message"), { code: 404 });
          },
        },
        "PHOTO_NOT_FOUND",
      ],
      [
        {
          readPhoto: async () => {
            throw Object.assign(new Error("raw message"), { code: 403 });
          },
        },
        "PHOTO_ACCESS_DENIED",
      ],
    ];
    for (const [over, code] of cases) {
      const { id, job } = await claimed();
      await processAiJob(job, deps(over), live);
      const doc = await readDoc(id);
      expect(doc?.aiReview?.state, code).toBe("failed");
      expect(doc?.aiReview?.reasonCode, code).toBe(code);
      expect(JSON.stringify(doc?.aiReview), code).not.toContain("raw message");
      await HazardReport.deleteMany({});
    }
  });

  it("retries a transient GCS read error", async () => {
    const { id, job } = await claimed();
    await processAiJob(
      job,
      deps({
        readPhoto: async () => {
          throw Object.assign(new Error("x"), { code: 503 });
        },
      }),
      live,
    );
    expect((await readDoc(id))?.aiReview?.state).toBe("queued");
    expect((await readDoc(id))?.aiReviewJob?.errorCode).toBe(
      "PHOTO_READ_FAILED",
    );
  });

  it("reports a credential failure so claiming can pause", async () => {
    const { job } = await claimed();
    const outcome = await processAiJob(
      job,
      deps({
        analyze: async () => {
          throw new FakeAiError("PROVIDER_AUTH", false, true);
        },
      }),
      live,
    );
    expect(outcome.circuitBreak).toBe(true);
  });

  it("drops the result when manual review, expiry or a newer lease intervened mid-analysis", async () => {
    const { id, job } = await claimed();
    const d = deps({
      analyze: async () => {
        await HazardReport.updateOne(
          { _id: id },
          {
            $set: {
              manualReview: {
                reviewerId: "admin",
                decision: "rejected",
                reviewedAt: new Date(),
              },
              status: "rejected",
            },
          },
        );
        return decision();
      },
    });
    await processAiJob(job, d, live);
    const doc = await readDoc(id);
    expect(doc?.status).toBe("rejected");
    expect(doc?.aiReview?.state).toBe("processing");
    expect(doc?.aiVerification?.verdict).toBe("skipped");
  });

  it("does not write anything when shutdown aborts the attempt", async () => {
    const { id, job } = await claimed();
    const stop = new AbortController();
    const d = deps({
      analyze: async () => {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    await processAiJob(job, d, stop.signal);
    const doc = await readDoc(id);
    expect(doc?.aiReview?.state).toBe("processing");
    // The lease expires and another worker recovers it.
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.leaseExpiresAt": new Date(0) } },
    );
    expect((await claimNextAiJob(new Date(), "recover"))?.attempts).toBe(2);
  });

  it("polls with concurrency 2 and finishes every queued job", async () => {
    let running = 0;
    let peak = 0;
    const analyze = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 200));
      running--;
      return decision();
    });
    const ids = [
      await seedQueued({}, { imageHash: HASH }),
      await seedQueued({}, { imageHash: HASH }),
      await seedQueued({}, { imageHash: HASH }),
    ];
    const worker = startHazardAiWorker(deps({ analyze }));
    try {
      await waitFor(
        async () =>
          (await HazardReport.countDocuments({
            _id: { $in: ids },
            status: "verified",
          })) === 3,
      );
      expect(peak).toBe(2);
    } finally {
      await worker.stop();
    }
  });

  it("pauses claiming after a credential failure instead of burning the backlog", async () => {
    const analyze = vi.fn(async () => {
      throw new FakeAiError("PROVIDER_AUTH", false, true);
    });
    await seedQueued({}, { imageHash: HASH });
    await seedQueued({}, { imageHash: HASH });
    await seedQueued({}, { imageHash: HASH });
    const worker = startHazardAiWorker(deps({ analyze }));
    try {
      await waitFor(async () => analyze.mock.calls.length >= 1);
      await new Promise((r) => setTimeout(r, 2_500));
      // Two ran concurrently before the pause took effect; the third never starts.
      expect(analyze.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      await worker.stop();
    }
  });

  it("maintenance converges stuck jobs and deletes known intake paths on its first run", async () => {
    const stuck = await seedQueued(
      {},
      { deadlineAt: new Date(Date.now() - 1) },
    );
    const orphan = newId();
    await insertPrivateIntake({
      _id: orphan,
      reporterId: "r",
      reportedLocation: { type: "Point", coordinates: [121.5, 25] },
      hazardType: "obstacle",
      severity: "minor",
      expectedUntil: null,
      exifValidation: {
        timestampFresh: true,
        gpsPresent: false,
        gpsMatchesClaimed: false,
      },
      expiredAt: new Date(Date.now() + 3_600_000),
      uploadToken: "t",
      storagePath: `reports/${orphan}.jpg`,
      deadlineAt: new Date(Date.now() - 1),
    });
    const abandoned = newId();
    await insertPrivateIntake({
      _id: abandoned,
      reporterId: "r",
      reportedLocation: { type: "Point", coordinates: [121.5, 25] },
      hazardType: "obstacle",
      severity: "minor",
      expectedUntil: null,
      exifValidation: {
        timestampFresh: true,
        gpsPresent: false,
        gpsMatchesClaimed: false,
      },
      expiredAt: new Date(Date.now() + 3_600_000),
      uploadToken: "t2",
      storagePath: `reports/${abandoned}.jpg`,
      deadlineAt: new Date(Date.now() + 300_000),
    });
    await abandonIntake(abandoned, "t2", new Date(), "deidentified:q");

    const deletePhoto = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("gcs down"))
      .mockResolvedValue(undefined);
    const worker = startHazardAiWorker(deps({ deletePhoto }));
    try {
      await waitFor(
        async () => (await readDoc(stuck))?.aiReview?.state === "failed",
      );
      await waitFor(async () => deletePhoto.mock.calls.length >= 2);
      expect(deletePhoto.mock.calls.map((c) => c[0]).sort()).toEqual(
        [`reports/${abandoned}.jpg`, `reports/${orphan}.jpg`].sort(),
      );
      // The failed delete keeps its tombstone for a later retry.
      const kept = await readDoc(
        deletePhoto.mock.calls[0][0].includes(orphan) ? orphan : abandoned,
      );
      expect(kept?.photoIntake?.state).toBe("cleanup");
    } finally {
      await worker.stop();
    }
  });

  it("a dependency that ignores the signal is cut at the hard deadline and its late success never commits", async () => {
    const { id, job } = await claimed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const d = deps({
      // Ignores the AbortSignal entirely and answers only after the deadline.
      analyze: async () => {
        await gate;
        return decision();
      },
    });
    const outcome = await processAiJob(job, d, live, 60);
    expect(outcome.outcome).toBe("retried");
    expect((await readDoc(id))?.aiReviewJob?.errorCode).toBe(
      "AI_ATTEMPT_TIMEOUT",
    );
    expect((await readDoc(id))?.aiReview?.state).toBe("queued");

    release();
    await new Promise((r) => setTimeout(r, 100));
    const doc = await readDoc(id);
    expect(doc?.status).toBe("pending");
    expect(doc?.aiReview?.state).toBe("queued");
    expect(doc?.aiVerification?.verdict).toBe("skipped");
  });

  it("the deadline on the last attempt ends as failed, and a signal-ignoring reader is cut too", async () => {
    const { id, job } = await claimed({ attempts: 2 });
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.attempts": 3 } },
    );
    const never = new Promise<Buffer>(() => undefined);
    const outcome = await processAiJob(
      { ...job, attempts: 3 },
      deps({ readPhoto: () => never }),
      live,
      50,
    );
    expect(outcome.outcome).toBe("failed");
    expect((await readDoc(id))?.aiReview?.reasonCode).toBe(
      "AI_ATTEMPT_TIMEOUT",
    );
  });

  it("an already-stopped worker sends no I/O and writes nothing", async () => {
    const { id, job } = await claimed();
    const stop = new AbortController();
    stop.abort();
    const d = deps();
    expect((await processAiJob(job, d, stop.signal)).outcome).toBe("aborted");
    expect(d.readPhoto).not.toHaveBeenCalled();
    expect((await readDoc(id))?.aiReview?.state).toBe("processing");
  });

  it("a result that lands after shutdown is not committed", async () => {
    const { id, job } = await claimed();
    const stop = new AbortController();
    const d = deps({
      analyze: async () => {
        stop.abort();
        return decision();
      },
    });
    expect((await processAiJob(job, d, stop.signal)).outcome).toBe("aborted");
    expect((await readDoc(id))?.status).toBe("pending");
  });

  it("does not dispatch a job claimed while shutdown was in progress", async () => {
    await seedQueued({}, { imageHash: HASH });
    const analyze = vi.fn(async () => decision());
    const worker = startHazardAiWorker(deps({ analyze }));
    await worker.stop();
    await new Promise((r) => setTimeout(r, 1_300));
    expect(analyze).not.toHaveBeenCalled();
  });

  it("a paused worker claims no AI work but still cleans intakes and converges deadlines", async () => {
    const queued = await seedQueued({}, { imageHash: HASH });
    const stuck = await seedQueued(
      {},
      { deadlineAt: new Date(Date.now() - 1) },
    );
    const analyze = vi.fn(async () => decision());
    const worker = startHazardAiWorker(deps({ analyze }), { enabled: false });
    try {
      expect(worker.getHealth()).toMatchObject({ paused: true, running: true });
      await waitFor(
        async () => (await readDoc(stuck))?.aiReview?.state === "failed",
      );
      await new Promise((r) => setTimeout(r, 1_300));
      expect(analyze).not.toHaveBeenCalled();
      expect((await readDoc(queued))?.aiReview?.state).toBe("queued");
    } finally {
      await worker.stop();
    }
  });

  it("anonymizes newly expired intakes on the next sweep even while deletion is stalled", async () => {
    let now = new Date();
    const orphan = newId();
    const newlyDue = newId();
    for (const id of [orphan, newlyDue]) {
      await insertPrivateIntake({
        _id: id,
        reporterId: "private-owner",
        reportedLocation: { type: "Point", coordinates: [121.5, 25] },
        hazardType: "obstacle",
        severity: "minor",
        description: "private description",
        expectedUntil: null,
        exifValidation: {
          timestampFresh: true,
          gpsPresent: true,
          gpsMatchesClaimed: true,
          rawExifTime: "private timestamp",
          rawExifLat: 25,
          rawExifLng: 121.5,
        },
        expiredAt: new Date(now.getTime() + 3_600_000),
        uploadToken: id,
        storagePath: `reports/${id}.jpg`,
        deadlineAt: new Date(now.getTime() + 1_000),
      });
    }
    await abandonIntake(orphan, orphan, now, "deidentified:orphan");
    let release!: () => void;
    const deletePhoto = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const worker = startHazardAiWorker(deps({ deletePhoto, now: () => now }), {
      enabled: false,
    });
    try {
      await waitFor(async () => deletePhoto.mock.calls.length === 1);
      expect((await readDoc(newlyDue))?.photoIntake?.state).toBe("uploading");
      now = new Date(now.getTime() + 30_000);
      vi.advanceTimersByTime(30_000);
      await waitFor(
        async () => (await readDoc(newlyDue))?.photoIntake?.state === "cleanup",
      );
      const scrubbed = await readDoc(newlyDue);
      expect(scrubbed?.reporterId).toMatch(/^deidentified:/);
      expect(scrubbed?.description).toBeUndefined();
      expect(scrubbed?.exifValidation?.rawExifTime).toBeUndefined();
      expect(scrubbed?.exifValidation?.rawExifLat).toBeUndefined();
      expect(scrubbed?.exifValidation?.rawExifLng).toBeUndefined();
      expect(scrubbed?.reportedLocation.coordinates).toEqual([0, 0]);
      expect(deletePhoto).toHaveBeenCalledTimes(1);
      expect(worker.getHealth().lastCleanupAt).toBeNull();
      expect(worker.getHealth().lastMaintenanceAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
      const stopping = worker.stop();
      release?.();
      await stopping;
    }
  });

  it("does not overlap maintenance runs while one is still in flight", async () => {
    const orphan = newId();
    await insertPrivateIntake({
      _id: orphan,
      reporterId: "r",
      reportedLocation: { type: "Point", coordinates: [121.5, 25] },
      hazardType: "obstacle",
      severity: "minor",
      expectedUntil: null,
      exifValidation: {
        timestampFresh: true,
        gpsPresent: false,
        gpsMatchesClaimed: false,
      },
      expiredAt: new Date(Date.now() + 3_600_000),
      uploadToken: "t",
      storagePath: `reports/${orphan}.jpg`,
      deadlineAt: new Date(Date.now() - 1),
    });
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deletePhoto = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
    });
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const worker = startHazardAiWorker(deps({ deletePhoto }), {
      enabled: false,
    });
    try {
      await vi.waitFor(() => expect(deletePhoto).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
        interval: 20,
      });
      // Three maintenance ticks fire while the first run is stuck on delete.
      vi.advanceTimersByTime(90_000);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 200));
      expect(peak).toBe(1);
      const stopping = worker.stop();
      release();
      await stopping;
    } finally {
      vi.useRealTimers();
      release();
    }
  });

  it("stop waits for maintenance and issues no new cleanups afterwards", async () => {
    const tombstones: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = newId();
      tombstones.push(id);
      await insertPrivateIntake({
        _id: id,
        reporterId: "r",
        reportedLocation: { type: "Point", coordinates: [121.5, 25] },
        hazardType: "obstacle",
        severity: "minor",
        expectedUntil: null,
        exifValidation: {
          timestampFresh: true,
          gpsPresent: false,
          gpsMatchesClaimed: false,
        },
        expiredAt: new Date(Date.now() + 3_600_000),
        uploadToken: `t${i}`,
        storagePath: `reports/${id}.jpg`,
        deadlineAt: new Date(Date.now() + 300_000),
      });
      await abandonIntake(id, `t${i}`, new Date(), "deidentified:q");
    }
    const holder: { worker?: ReturnType<typeof startHazardAiWorker> } = {};
    const deletePhoto = vi.fn(async () => {
      // Shutdown arrives during the first delete.
      void holder.worker?.stop();
      await new Promise((r) => setTimeout(r, 50));
    });
    const worker = startHazardAiWorker(deps({ deletePhoto }), {
      enabled: false,
    });
    holder.worker = worker;
    await waitFor(async () => deletePhoto.mock.calls.length >= 1);
    await worker.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(deletePhoto).toHaveBeenCalledTimes(1);
  });

  it("exposes health counters and aggregate queue metrics without payload", async () => {
    await seedQueued({}, { imageHash: HASH });
    const old = await seedQueued(
      {},
      { imageHash: HASH, nextAttemptAt: new Date(Date.now() + 3_600_000) },
    );
    await HazardReport.updateOne(
      { _id: old },
      { $set: { "aiReview.queuedAt": new Date(Date.now() - 120_000) } },
    );
    const worker = startHazardAiWorker(deps(), { enabled: false });
    try {
      await waitFor(async () => worker.getHealth().lastMaintenanceAt !== null);
      const metrics = await worker.getMetrics();
      expect(metrics.queue).toMatchObject({
        queued: 2,
        processing: 0,
        expiredLease: 0,
      });
      expect(metrics.queue.oldestQueuedAgeMs).toBeGreaterThanOrEqual(119_000);
      expect(metrics.intake).toEqual({
        uploading: 0,
        cleanupPending: 0,
        cleanupOverdue: 0,
      });
      expect(metrics.health.counters).toEqual({
        claimed: 0,
        completed: 0,
        retried: 0,
        failed: 0,
        dropped: 0,
        aborted: 0,
      });
      expect(JSON.stringify(metrics)).not.toMatch(/reports\/|free text|lease/);
    } finally {
      await worker.stop();
    }
    expect(worker.getHealth().running).toBe(false);
  });

  it("stop() is bounded and halts further claims", async () => {
    const worker = startHazardAiWorker(deps());
    await worker.stop();
    const analyze = vi.fn(async () => decision());
    await seedQueued({}, { imageHash: HASH });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(analyze).not.toHaveBeenCalled();
    expect(
      await HazardReport.countDocuments({ "aiReview.state": "queued" }),
    ).toBe(1);
  });
});
