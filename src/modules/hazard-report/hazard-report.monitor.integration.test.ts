import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";
import request from "supertest";

vi.mock("../../config/redis", () => ({
  redisClient: null,
  redisReady: vi.fn(async () => undefined),
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => undefined),
}));

import {
  buildAuthorizationHeader,
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import {
  buildDbUser,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import {
  decision,
  seedQueued,
} from "../../../tests/helpers/hazard-report-fixtures";
import HazardReport from "../../model/hazard-report.model";
import {
  startHazardAiWorker,
  type HazardAiWorkerHandle,
} from "./hazard-report.ai-worker";
import {
  getHazardAiDiagnostics,
  startHazardAiMonitor,
} from "./hazard-report.monitor.service";
import { HazardAiMetricsDataSchema } from "./hazard-report.schema";

const URL = "/api/v1/a11y/reports/ops/metrics";
let mongo: MongoTestContext | undefined;
let app: Awaited<ReturnType<typeof startTestServer>>;
let worker: HazardAiWorkerHandle;
let stopMonitor: (() => void) | undefined;

function auth(role = "admin") {
  stubAuthUserLookup(buildDbUser({ role }));
  return buildAuthorizationHeader();
}

function pausedWorker() {
  return startHazardAiWorker(
    {
      readPhoto: vi.fn(async () => Buffer.from("unused")),
      analyze: vi.fn(async () => decision()),
      deletePhoto: vi.fn(async () => undefined),
      now: () => new Date(Date.now()),
      random: () => 0,
    },
    { enabled: false },
  );
}

beforeAll(async () => {
  mongo = await startMongoTest({ enableTestCommands: true });
  app = await startTestServer();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongo!.server.getUri(), { dbName: mongo!.dbName });
  }
  await clearMongoTestDatabase();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  worker = pausedWorker();
  stopMonitor = startHazardAiMonitor(worker);
  await getHazardAiDiagnostics();
});

afterEach(async () => {
  stopMonitor?.();
  stopMonitor = undefined;
  await worker.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await stopTestServer(app);
  await stopMongoTest(mongo);
});

describe("hazard AI operations: real HTTP/auth/worker/Mongo, external photo I/O faked", () => {
  it("protects aggregates with the existing real JWT/admin middleware", async () => {
    const metrics = vi.spyOn(worker, "getMetrics");
    expect((await request(app).get(URL)).status).toBe(403);
    expect(
      (await request(app).get(URL).set("Authorization", auth("user"))).status,
    ).toBe(403);
    expect(
      (await request(app).get(URL).set("Authorization", "Bearer invalid"))
        .status,
    ).toBe(403);
    expect(metrics).not.toHaveBeenCalled();
  });

  it("returns strict, no-store aggregates for an admin while claims are paused", async () => {
    await seedQueued();
    const res = await request(app).get(URL).set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const data = HazardAiMetricsDataSchema.parse(res.body.data);
    expect(data.mongoAvailable).toBe(true);
    expect(data.health).toMatchObject({ running: true, paused: true });
    expect(data.queue?.queued).toBe(1);
    expect(data.alerts).toContain("AI_PAUSED");
    expect(JSON.stringify(data)).not.toMatch(
      /reporterId|leaseToken|uploadToken|storagePath|free text|reports\//,
    );
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.hazardReview).toMatchObject({
      mongo: "available",
      worker: "paused",
      degraded: false,
    });
    expect(JSON.stringify(health.body.hazardReview)).not.toMatch(
      /queued|oldest|counters|intake/,
    );
  });

  it("rejects undeclared query fields instead of using them as diagnostic filters", async () => {
    const res = await request(app)
      .get(URL)
      .query({ reportId: "private" })
      .set("Authorization", auth());
    expect(res.status).toBe(400);
  });

  it("detects queue aging and overdue cleanup without emitting a payload or key", async () => {
    const id = await seedQueued();
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReview.queuedAt": new Date(Date.now() - 301_000) } },
    );
    const tombstone = await seedQueued();
    await HazardReport.updateOne(
      { _id: tombstone },
      {
        $set: {
          "photoIntake.state": "cleanup",
          "photoIntake.cleanupUntil": new Date(0),
          "photoIntake.nextCleanupAt": new Date(Date.now() + 3_600_000),
        },
      },
    );
    const res = await request(app).get(URL).set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body.data.alerts).toEqual(
      expect.arrayContaining(["QUEUE_AGING", "INTAKE_CLEANUP_OVERDUE"]),
    );
    expect(res.body.data.queue.oldestQueuedAgeMs).toBeGreaterThanOrEqual(
      300_000,
    );
    const health = await request(app).get("/health");
    expect(health.body.status).toBe("DEGRADED");
    expect(health.body.hazardReview.degraded).toBe(true);
    expect(JSON.stringify(health.body)).not.toContain(id);
  });

  it("keeps the periodic caller active while AI is paused and emits controlled alerts", async () => {
    const id = await seedQueued();
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReview.queuedAt": new Date(Date.now() - 301_000) } },
    );
    const warn = vi.mocked(console.warn);
    vi.useFakeTimers({ toFake: ["setInterval"] });
    // Re-register only the monitoring timer under the fake clock. DB and
    // scheduler logic remain real; no repository or metric function is mocked.
    stopMonitor?.();
    stopMonitor = startHazardAiMonitor(worker);
    await getHazardAiDiagnostics();
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).toHaveBeenCalledWith(
      "[hazard-ai] monitor",
      expect.stringContaining("QUEUE_AGING"),
    );
    warn.mockClear();
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReview.queuedAt": new Date() } },
    );
    vi.advanceTimersByTime(30_000);
    await getHazardAiDiagnostics();
    expect((await request(app).get("/health")).body.hazardReview.degraded).toBe(
      false,
    );
    // Recovery is info-level; alerts were emitted on the initial aging sample.
    expect(vi.mocked(console.info)).toHaveBeenCalledWith(
      "[hazard-ai] monitor",
      expect.stringContaining("AI_PAUSED"),
    );
  });

  it("does not let an old sample or stop callback overwrite a re-registered monitor", async () => {
    const id = await seedQueued();
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReview.queuedAt": new Date(Date.now() - 301_000) } },
    );
    stopMonitor?.();
    const realMetrics = worker.getMetrics.bind(worker);
    let release!: () => void;
    let sampled = false;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(worker, "getMetrics").mockImplementationOnce(async () => {
      const metrics = await realMetrics();
      sampled = true;
      await gate;
      return metrics;
    });
    const stopOld = startHazardAiMonitor(worker);
    const oldSample = getHazardAiDiagnostics();
    try {
      await vi.waitFor(() => expect(sampled).toBe(true));
      await HazardReport.updateOne(
        { _id: id },
        { $set: { "aiReview.queuedAt": new Date() } },
      );
      stopMonitor = startHazardAiMonitor(worker);
      const fresh = await getHazardAiDiagnostics();
      expect(fresh.alerts).not.toContain("QUEUE_AGING");
      stopOld();
      release();
      await oldSample;
      const health = await request(app).get("/health");
      expect(health.body.hazardReview).toMatchObject({
        worker: "paused",
        degraded: false,
      });
    } finally {
      release?.();
      stopOld();
    }
  });

  it("alerts on real write-only sweep failures instead of advancing successful heartbeats, then recovers", async () => {
    stopMonitor?.();
    await worker.stop();
    const admin = mongoose.connection.db!.admin();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await admin.command({
      configureFailPoint: "failCommand",
      mode: { times: 2 },
      data: { failCommands: ["update", "findAndModify"], errorCode: 13 },
    });
    vi.useFakeTimers({ toFake: ["setInterval"] });
    worker = pausedWorker();
    stopMonitor = startHazardAiMonitor(worker);
    try {
      await vi.waitFor(() => {
        expect(error).toHaveBeenCalledWith(
          "[hazard-ai] intake anonymization failed:",
          "MongoServerError",
        );
        expect(error).toHaveBeenCalledWith(
          "[hazard-ai] convergence failed:",
          "MongoServerError",
        );
      });
      await getHazardAiDiagnostics();
      expect(worker.getHealth().lastMaintenanceAt).toBeNull();
      expect(worker.getHealth().lastConvergenceAt).toBeNull();
      const clock = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(clock + 61_000);
      const failed = await request(app).get(URL).set("Authorization", auth());
      expect(failed.status).toBe(200); // Mongo reads work; only writes failed.
      expect(failed.body.data.mongoAvailable).toBe(true);
      expect(failed.body.data.alerts).toEqual(
        expect.arrayContaining(["INTAKE_PRIVACY_STALE", "CONVERGENCE_STALE"]),
      );
      vi.advanceTimersByTime(30_000);
      await vi.waitFor(() => {
        expect(worker.getHealth().lastMaintenanceAt).not.toBeNull();
        expect(worker.getHealth().lastConvergenceAt).not.toBeNull();
      });
      const recovered = await request(app)
        .get(URL)
        .set("Authorization", auth());
      expect(recovered.body.data.alerts).not.toContain("INTAKE_PRIVACY_STALE");
      expect(recovered.body.data.alerts).not.toContain("CONVERGENCE_STALE");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      await admin.command({ configureFailPoint: "failCommand", mode: "off" });
    }
  });

  it("returns 503 and coarse degraded liveness when Mongo is disconnected", async () => {
    await mongoose.disconnect();
    const res = await request(app).get(URL).set("Authorization", auth());
    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({
      mongoAvailable: false,
      queue: null,
      intake: null,
    });
    expect(res.body.data.alerts).toContain("MONGO_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toMatch(/ECONN|MongoServer|reports\//);
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("DEGRADED");
    expect(health.body.hazardReview.mongo).toBe("unavailable");
  });

  it("reports an absent worker rather than silently healthy empty metrics", async () => {
    stopMonitor?.();
    const res = await request(app).get(URL).set("Authorization", auth());
    expect(res.status).toBe(503);
    expect(res.body.data.health).toBeNull();
    expect(res.body.data.alerts).toContain("WORKER_UNAVAILABLE");
  });

  it("cuts a real blocked Mongo aggregate at five seconds and does not leak its error", async () => {
    const admin = mongoose.connection.db!.admin();
    await admin.command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: {
        failCommands: ["aggregate"],
        blockConnection: true,
        blockTimeMS: 8_000,
      },
    });
    try {
      const started = Date.now();
      const res = await request(app)
        .get(URL)
        .set("Authorization", auth())
        .timeout({ response: 7_000, deadline: 7_500 });
      expect(Date.now() - started).toBeLessThan(7_000);
      expect(res.status).toBe(503);
      expect(res.body.data.alerts).toContain("MONGO_UNAVAILABLE");
      expect(res.body.data.queue).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(
        /failCommand|timed out|MongoOperation|reports\//,
      );
    } finally {
      await admin.command({ configureFailPoint: "failCommand", mode: "off" });
    }
  }, 12_000);

  it("registers the admin endpoint once in generated OpenAPI", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    const op = res.body.paths["/a11y/reports/ops/metrics"].get;
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op.responses).toHaveProperty("503");
    expect(op.responses).toHaveProperty("429");
  });
});
