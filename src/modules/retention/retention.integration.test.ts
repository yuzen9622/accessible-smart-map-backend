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

// In-memory Chroma: id → metadata. `failDeletes` simulates an outage.
const chroma = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  failDeletes: false,
}));
const gcs = vi.hoisted(() => ({ fail: false, deleted: [] as string[] }));
const line = vi.hoisted(() => ({
  impl: (async () => {}) as (...args: unknown[]) => Promise<void>,
}));

vi.mock("../../adapters/chroma.adapter", () => ({
  getOrCreateCollection: vi.fn(async () => ({})),
  upsertDocuments: vi.fn(
    async (
      _c: unknown,
      docs: { id: string; metadata: Record<string, unknown> }[],
    ) => {
      for (const doc of docs) chroma.docs.set(doc.id, doc.metadata);
    },
  ),
  upsertDocumentsWithin: vi.fn(
    async (
      _name: string,
      docs: { id: string; metadata: Record<string, unknown> }[],
    ) => {
      for (const doc of docs) chroma.docs.set(doc.id, doc.metadata);
    },
  ),
  deleteDocuments: vi.fn(async (_c: unknown, ids: string[]) => {
    if (chroma.failDeletes) throw new Error("chroma down");
    for (const id of ids) chroma.docs.delete(id);
  }),
  deleteDocumentsWhere: vi.fn(
    async (_c: unknown, where: { userId: string }) => {
      if (chroma.failDeletes) throw new Error("chroma down");
      for (const [id, meta] of chroma.docs) {
        if (meta.userId === where.userId) chroma.docs.delete(id);
      }
    },
  ),
  getDocumentsWhere: vi.fn(async (_c: unknown, where: { userId: string }) =>
    [...chroma.docs]
      .filter(([, meta]) => meta.userId === where.userId)
      .map(([id, metadata]) => ({ id, metadata })),
  ),
  queryDocuments: vi.fn(async () => []),
}));
vi.mock("../../adapters/embedding.adapter", () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
}));
vi.mock("../../adapters/gcs.adapter", () => ({
  deleteHazardPhoto: vi.fn(async (path: string) => {
    if (gcs.fail) throw new Error("gcs down");
    gcs.deleted.push(path);
  }),
}));
vi.mock("../../adapters/line.adapter", () => ({
  pushSosResolved: vi.fn((...args: unknown[]) => line.impl(...args)),
}));
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => {}),
  redisDel: vi.fn(async () => {}),
}));

import { Types } from "mongoose";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import { getRetentionConfig, RETENTION_DAY_MS } from "../../config/retention";
import SosSession from "../../model/sos-session.model";
import EmergencyContact from "../../model/emergency-contact.model";
import UserMemory from "../../model/user-memory.model";
import HazardReport from "../../model/hazard-report.model";
import User from "../../model/user.model";
import Review from "../../model/review.model";
import AuthSession from "../../model/auth-session.model";
import DeletedAccount from "../../model/deleted-account.model";
import {
  claimDueResolvedNotice,
  markResolvedNoticeAttemptFailed,
  markResolvedNoticeSent,
  updateActiveSessionLocation,
} from "../sos/sos.repository";
import {
  sosAutoResolveTask,
  sosResolvedDeletionTask,
  sosResolvedNoticeTask,
} from "../sos/sos.retention";
import { contactLocationTask } from "../line/line.retention";
import {
  memoryDueTask,
  memoryLegacyTombstoneTask,
  memoryTombstonePurgeTask,
  memoryVectorReconcileTask,
  resetMemoryReconcileCursor,
} from "../ai/memory.retention";
import { saveMemory, updateMemory } from "../ai/memory.service";
import {
  hazardContentScrubTask,
  hazardPhotoDeleteTask,
} from "../hazard-report/hazard-report.retention";
import {
  addConfirmation,
  findReportsByReporter,
  setManualReview,
} from "../hazard-report/hazard-report.repository";
import { deletedAccountSweepTask } from "../user/user.account.retention";
import { registerAccountDeletion } from "../user/user.account.repository";
import { runRetention } from "./retention.orchestration";
import type { RetentionContext, RetentionTask } from "../../types/retention";

const DAY = RETENTION_DAY_MS;
const HOUR = 60 * 60 * 1000;
const config = getRetentionConfig();
const now = new Date("2026-10-08T00:00:00Z");
const ctx: RetentionContext = { now, config, dryRun: false };
const ago = (ms: number) => new Date(now.getTime() - ms);

let mongo: MongoTestContext | undefined;

beforeAll(async () => {
  mongo = await startMongoTest();
});

beforeEach(() => {
  chroma.docs.clear();
  chroma.failDeletes = false;
  gcs.fail = false;
  gcs.deleted = [];
  line.impl = async () => {};
  resetMemoryReconcileCursor();
});

afterEach(async () => {
  vi.useRealTimers();
  await clearMongoTestDatabase();
});

afterAll(async () => {
  await stopMongoTest(mongo);
});

function sosDoc(over: Record<string, unknown> = {}) {
  return {
    userId: new Types.ObjectId().toString(),
    type: "body",
    status: "active",
    lat: 25.04,
    lng: 121.51,
    shareToken: new Types.ObjectId().toString(),
    locationUpdatedAt: ago(30 * HOUR),
    ...over,
  };
}

describe("SOS retention", () => {
  it("auto-resolves a stale session and queues the contact notice", async () => {
    const stale = await SosSession.create(sosDoc());
    const fresh = await SosSession.create(
      sosDoc({ locationUpdatedAt: ago(HOUR) }),
    );

    await expect(sosAutoResolveTask.runBatch(ctx)).resolves.toBe(1);

    const resolved = await SosSession.findById(stale._id).lean();
    expect(resolved).toMatchObject({
      status: "resolved",
      autoResolved: true,
      resolvedNotice: { status: "pending", attempts: 0 },
    });
    expect(resolved?.timeline.at(-1)).toMatchObject({
      type: "resolved",
      actorType: "system",
    });
    expect((await SosSession.findById(fresh._id).lean())?.status).toBe(
      "active",
    );
  });

  it("does not resolve a session whose location moved after the scan read it", async () => {
    const session = await SosSession.create(sosDoc());
    // The phone reports in before the atomic update runs.
    await updateActiveSessionLocation(String(session._id), 25.05, 121.52);
    await expect(sosAutoResolveTask.runBatch(ctx)).resolves.toBe(0);
    expect((await SosSession.findById(session._id).lean())?.status).toBe(
      "active",
    );
  });

  it("fences notice results by claim, so a late worker cannot overwrite", async () => {
    await SosSession.create(sosDoc());
    await sosAutoResolveTask.runBatch(ctx);

    const a = await claimDueResolvedNotice(now, 1000, 10, "claim-a");
    expect(a).not.toBeNull();
    // A's lease runs out; B claims and delivers.
    const later = new Date(now.getTime() + 2000);
    const b = await claimDueResolvedNotice(later, 1000, 10, "claim-b");
    expect(b).not.toBeNull();
    await expect(
      markResolvedNoticeSent(String(b!._id), "claim-b"),
    ).resolves.toBe(true);
    // A's failure lands afterwards and must be ignored.
    await expect(
      markResolvedNoticeAttemptFailed(String(a!._id), "claim-a", "timeout"),
    ).resolves.toBe(false);
    const doc = await SosSession.findById(a!._id).lean();
    expect(doc?.resolvedNotice).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("retries a failing notice and gives up after the attempt limit", async () => {
    await SosSession.create(sosDoc());
    await sosAutoResolveTask.runBatch(ctx);
    line.impl = async () => {
      throw new Error("LINE 500");
    };
    const limited = {
      ...config,
      sosNoticeMaxAttempts: 2,
      sosNoticeLeaseMs: 1000,
    };
    let t = now.getTime();
    for (let i = 0; i < 3; i++) {
      await sosResolvedNoticeTask.runBatch({
        ...ctx,
        now: new Date(t),
        config: limited,
      });
      t += 2000;
    }
    const doc = await SosSession.findOne({ autoResolved: true }).lean();
    expect(doc?.resolvedNotice).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "LINE 500",
    });
  });

  it("delivers the notice and marks it sent", async () => {
    await SosSession.create(sosDoc());
    await sosAutoResolveTask.runBatch(ctx);
    await sosResolvedNoticeTask.runBatch(ctx);
    const doc = await SosSession.findOne({ autoResolved: true }).lean();
    expect(doc?.resolvedNotice?.status).toBe("sent");
  });

  it("deletes resolved sessions only once past the cutoff", async () => {
    const old = await SosSession.create(
      sosDoc({ status: "resolved", resolvedAt: ago(29.5 * DAY) }),
    );
    const recent = await SosSession.create(
      sosDoc({ status: "resolved", resolvedAt: ago(28 * DAY) }),
    );
    const active = await SosSession.create(sosDoc({ resolvedAt: null }));

    await expect(sosResolvedDeletionTask.runBatch(ctx)).resolves.toBe(1);
    expect(await SosSession.exists({ _id: old._id })).toBeNull();
    expect(await SosSession.exists({ _id: recent._id })).not.toBeNull();
    expect(await SosSession.exists({ _id: active._id })).not.toBeNull();
  });
});

describe("contact location retention", () => {
  it("clears LINE-shared locations older than the cutoff", async () => {
    const base = {
      userId: "u1",
      name: "媽媽",
      bindStatus: "bound",
      lastLineLat: 25,
      lastLineLng: 121,
    };
    const old = await EmergencyContact.create({
      ...base,
      lastLineLocationUpdatedAt: ago(29.5 * DAY),
    });
    const recent = await EmergencyContact.create({
      ...base,
      lastLineLocationUpdatedAt: ago(DAY),
    });

    await expect(contactLocationTask.runBatch(ctx)).resolves.toBe(1);
    expect(await EmergencyContact.findById(old._id).lean()).toMatchObject({
      lastLineLat: null,
      lastLineLng: null,
      lastLineLocationUpdatedAt: null,
    });
    expect(
      (await EmergencyContact.findById(recent._id).lean())?.lastLineLat,
    ).toBe(25);
  });
});

describe("AI memory retention", () => {
  async function memory(over: Record<string, unknown>) {
    const id = new Types.ObjectId().toString();
    await UserMemory.collection.insertOne({
      _id: new Types.ObjectId(id),
      userId: "u1",
      content: "c",
      promptText: "p",
      retrievalText: "r",
      category: "preference",
      sensitivity: "low",
      source: "explicit_user",
      embeddingId: id,
      deletedAt: null,
      createdAt: ago(400 * DAY),
      updatedAt: ago(400 * DAY),
      ...over,
    });
    chroma.docs.set(id, { userId: "u1", indexedAt: ago(400 * DAY).getTime() });
    return id;
  }

  it("tombstones unused or expired memories and keeps active ones", async () => {
    const unused = await memory({});
    const recentlyEdited = await memory({ updatedAt: ago(10 * DAY) });
    const recentlyUsed = await memory({ lastUsedAt: ago(10 * DAY) });
    const expired = await memory({
      updatedAt: ago(DAY),
      expiresAt: ago(HOUR),
    });

    await expect(memoryDueTask.runBatch(ctx)).resolves.toBe(2);

    const byId = async (id: string) => UserMemory.findById(id).lean();
    for (const id of [unused, expired]) {
      const doc = await byId(id);
      expect(doc?.deletedAt).toBeInstanceOf(Date);
      expect(chroma.docs.has(id)).toBe(false);
      // A tombstone keeps only what reconciliation needs.
      expect(
        Object.keys(doc ?? {})
          .filter((key) => key !== "__v")
          .sort(),
      ).toEqual([
        "_id",
        "createdAt",
        "deletedAt",
        "embeddingId",
        "updatedAt",
        "userId",
      ]);
    }
    for (const id of [recentlyEdited, recentlyUsed]) {
      expect((await byId(id))?.deletedAt).toBeNull();
      expect(chroma.docs.has(id)).toBe(true);
    }
  });

  it("refuses to write content back into a tombstone", async () => {
    const id = await memory({ updatedAt: ago(DAY) });
    await UserMemory.updateOne(
      { _id: id },
      { $set: { deletedAt: new Date() }, $unset: { content: "" } },
    );
    await expect(
      updateMemory("u1", id, { content: "back again" }),
    ).resolves.toBeNull();
    expect((await UserMemory.findById(id).lean())?.content).toBeUndefined();
  });

  it("scrubs content from legacy soft-deleted memories", async () => {
    const id = await memory({ deletedAt: ago(DAY) });
    await expect(memoryLegacyTombstoneTask.runBatch(ctx)).resolves.toBe(1);
    const doc = await UserMemory.findById(id).lean();
    expect(doc?.content).toBeUndefined();
    expect(doc?.retrievalText).toBeUndefined();
  });

  it("purges old tombstones only after their vectors are confirmed gone", async () => {
    const id = await memory({ deletedAt: ago(31 * DAY) });
    chroma.failDeletes = true;
    await expect(memoryTombstonePurgeTask.runBatch(ctx)).resolves.toBe(0);
    expect(await UserMemory.exists({ _id: id })).not.toBeNull();

    chroma.failDeletes = false;
    await expect(memoryTombstonePurgeTask.runBatch(ctx)).resolves.toBe(1);
    expect(await UserMemory.exists({ _id: id })).toBeNull();
    expect(chroma.docs.has(id)).toBe(false);
  });

  it("reconciles orphan vectors per owner, sparing live, fresh and legacy-live ones", async () => {
    const live = await memory({ updatedAt: ago(DAY) });
    await memory({ deletedAt: ago(DAY) }); // gives u1 a tombstone
    chroma.docs.set("orphan-old", {
      userId: "u1",
      indexedAt: ago(HOUR).getTime(),
    });
    chroma.docs.set("orphan-legacy", { userId: "u1" });
    chroma.docs.set("orphan-fresh", {
      userId: "u1",
      indexedAt: ago(60_000).getTime(),
    });
    const legacyLive = await memory({ updatedAt: ago(DAY) });
    chroma.docs.set(legacyLive, { userId: "u1" }); // no indexedAt

    await memoryVectorReconcileTask.runBatch(ctx);

    expect(chroma.docs.has("orphan-old")).toBe(false);
    expect(chroma.docs.has("orphan-legacy")).toBe(false);
    expect(chroma.docs.has("orphan-fresh")).toBe(true);
    expect(chroma.docs.has(live)).toBe(true);
    expect(chroma.docs.has(legacyLive)).toBe(true);
  });

  it("reconciles a deleted account's vectors even without tombstones", async () => {
    const userId = new Types.ObjectId().toString();
    await DeletedAccount.create({ userId, state: "user_deleted" });
    chroma.docs.set("stranded", { userId, indexedAt: ago(DAY).getTime() });

    await memoryVectorReconcileTask.runBatch(ctx);
    expect(chroma.docs.has("stranded")).toBe(false);
  });

  it("cleans up a vector stranded by a late upsert whose compensation failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ago(HOUR));
    const saved = await saveMemory("u1", "家住板橋", "place");
    const vectorId = String(saved._id);
    expect(chroma.docs.has(vectorId)).toBe(true);
    // The memory is deleted and its tombstone kept, but the vector delete fails.
    chroma.failDeletes = true;
    await UserMemory.updateOne(
      { _id: vectorId },
      { $set: { deletedAt: new Date() }, $unset: { content: "" } },
    );
    vi.useRealTimers();
    chroma.failDeletes = false;

    await memoryVectorReconcileTask.runBatch(ctx);
    expect(chroma.docs.has(vectorId)).toBe(false);
  });
});

describe("hazard report retention", () => {
  async function report(over: Record<string, unknown>) {
    return HazardReport.create({
      reporterId: "user-1",
      reportedLocation: { type: "Point", coordinates: [121.5, 25.04] },
      hazardType: "obstacle",
      description: "門口有機車擋住",
      photoUrl: "https://example.test/reports/x.jpg",
      photoStoragePath: "reports/x.jpg",
      exifValidation: {
        timestampFresh: true,
        gpsPresent: true,
        gpsMatchesClaimed: true,
        rawExifLat: 25.04,
        rawExifLng: 121.5,
      },
      aiVerification: {
        verdict: "verified",
        confidence: 0.9,
        reason: "照片中可見機車",
        prefilter: { passed: true, detectedLabels: ["motorcycle"] },
      },
      status: "expired",
      confirmedBy: ["user-2", "ip:abc"],
      deniedBy: ["user-3"],
      confirmCount: 2,
      denyCount: 1,
      expiredAt: ago(95 * DAY),
      ...over,
    });
  }

  it("scrubs identity and free text in phase A, keeping the hazard itself", async () => {
    const r = await report({});
    await expect(hazardContentScrubTask.runBatch(ctx)).resolves.toBe(1);

    const doc = await HazardReport.findById(r._id).lean();
    expect(doc?.reporterId).toMatch(/^deidentified:/);
    expect(doc?.confirmedBy).toEqual([]);
    expect(doc?.deniedBy).toEqual([]);
    expect(doc?.description).toBeUndefined();
    expect(doc?.exifValidation.rawExifLat).toBeUndefined();
    expect(doc?.aiVerification.reason).toBe("[redacted]");
    expect(doc?.aiVerification.prefilter?.detectedLabels).toBeUndefined();
    expect(doc?.manualReview).toBeUndefined();
    expect(doc?.contentScrubbedAt).toBeInstanceOf(Date);
    expect(doc).toMatchObject({
      hazardType: "obstacle",
      status: "expired",
      confirmCount: 2,
      denyCount: 1,
    });
    // Phase A drops it from the reporter's own list.
    expect(await findReportsByReporter("user-1", {}, 10)).toEqual([]);
  });

  it("scrubs a report even when it has no photo path", async () => {
    const r = await report({
      photoStoragePath: undefined,
      photoUrl: undefined,
    });
    await hazardContentScrubTask.runBatch(ctx);
    expect(
      (await HazardReport.findById(r._id).lean())?.description,
    ).toBeUndefined();
  });

  it("pseudonymises an existing reviewer without inventing reviews", async () => {
    const reviewed = await report({
      manualReview: {
        reviewerId: "admin-1",
        decision: "rejected",
        note: "看不清楚",
        reviewedAt: ago(95 * DAY),
      },
    });
    await hazardContentScrubTask.runBatch(ctx);
    const doc = await HazardReport.findById(reviewed._id).lean();
    expect(doc?.manualReview?.reviewerId).toMatch(/^deidentified:/);
    expect(doc?.manualReview?.note).toBeUndefined();
    expect(doc?.manualReview?.decision).toBe("rejected");
  });

  it("uses closedAt for rejected reports and leaves open ones alone", async () => {
    const rejected = await report({
      status: "rejected",
      expiredAt: new Date(now.getTime() + DAY),
      closedAt: ago(95 * DAY),
    });
    const open = await report({
      status: "verified",
      expiredAt: new Date(now.getTime() + DAY),
    });
    await hazardContentScrubTask.runBatch(ctx);
    expect(
      (await HazardReport.findById(rejected._id).lean())?.contentScrubbedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await HazardReport.findById(open._id).lean())?.contentScrubbedAt,
    ).toBeUndefined();
  });

  it("restarts the clock when a review reopens a rejected report", async () => {
    const r = await report({ status: "rejected", closedAt: ago(DAY) });
    await setManualReview(String(r._id), {
      reviewerId: "admin-1",
      decision: "verified",
      reviewedAt: now,
    });
    expect(
      (await HazardReport.findById(r._id).lean())?.closedAt,
    ).toBeUndefined();
  });

  it("blocks votes and reviews once scrubbed", async () => {
    const r = await report({});
    await hazardContentScrubTask.runBatch(ctx);
    await expect(addConfirmation(String(r._id), "user-9")).resolves.toBeNull();
    await expect(
      setManualReview(String(r._id), {
        reviewerId: "admin-1",
        decision: "verified",
        reviewedAt: now,
      }),
    ).resolves.toBeNull();
    const doc = await HazardReport.findById(r._id).lean();
    expect(doc?.confirmedBy).toEqual([]);
    expect(doc?.manualReview).toBeUndefined();
  });

  it("deletes the photo in phase B and backs off when storage fails", async () => {
    const r = await report({});
    await hazardContentScrubTask.runBatch(ctx);

    gcs.fail = true;
    await hazardPhotoDeleteTask.runBatch(ctx);
    let doc = await HazardReport.findById(r._id).lean();
    expect(doc?.deidentifiedAt).toBeUndefined();
    expect(doc?.photoDelete?.attempts).toBe(1);
    expect(doc?.photoDelete?.nextAttemptAt?.getTime()).toBe(
      now.getTime() + 15 * 60 * 1000,
    );
    // Not due again until the backoff elapses.
    await expect(hazardPhotoDeleteTask.runBatch(ctx)).resolves.toBe(0);

    gcs.fail = false;
    const later = { ...ctx, now: new Date(now.getTime() + HOUR) };
    await hazardPhotoDeleteTask.runBatch(later);
    doc = await HazardReport.findById(r._id).lean();
    expect(doc?.deidentifiedAt).toBeInstanceOf(Date);
    expect(doc?.photoUrl).toBeUndefined();
    expect(doc?.photoStoragePath).toBeUndefined();
    expect(gcs.deleted).toEqual(["reports/x.jpg"]);
  });
});

describe("deleted-account sweep", () => {
  it("removes data written after the account was deleted, sparing ip: identities", async () => {
    const userId = new Types.ObjectId().toString();
    await registerAccountDeletion(userId);
    await DeletedAccount.updateOne(
      { userId },
      { $set: { state: "user_deleted", userDeletedAt: ago(HOUR) } },
    );
    // Writes that raced in after the deletion.
    const late = await saveMemory(userId, "晚到的記憶", "context");
    await Review.create({
      placeId: "p1",
      placeType: "osm",
      userId,
      rating: 5,
      passageWidthRating: 5,
      toiletRating: 5,
      elevatorRating: 5,
      serviceRating: 5,
    });
    await AuthSession.create({
      userId,
      currentRefreshJti: "jti",
      expiresAt: new Date(Date.now() + DAY),
    });
    const hazard = await HazardReport.create({
      reporterId: "ip:abc",
      reportedLocation: { type: "Point", coordinates: [121.5, 25.04] },
      hazardType: "obstacle",
      photoUrl: "u",
      photoStoragePath: "p",
      exifValidation: {
        timestampFresh: true,
        gpsPresent: true,
        gpsMatchesClaimed: true,
      },
      aiVerification: { verdict: "verified", confidence: 1, reason: "ok" },
      confirmedBy: [userId, "ip:def"],
      expiredAt: new Date(Date.now() + DAY),
    });

    await deletedAccountSweepTask.runBatch(ctx);

    expect(await Review.countDocuments({ userId })).toBe(0);
    expect(await AuthSession.countDocuments({ userId })).toBe(0);
    const mem = await UserMemory.findById(late._id).lean();
    expect(mem?.deletedAt).toBeInstanceOf(Date);
    expect(mem?.content).toBeUndefined();
    expect(chroma.docs.has(String(late._id))).toBe(false);
    const h = await HazardReport.findById(hazard._id).lean();
    expect(h?.reporterId).toBe("ip:abc");
    expect(h?.confirmedBy[0]).toMatch(/^deleted:/);
    expect(h?.confirmedBy[1]).toBe("ip:def");
  });

  it("leaves a live account alone when its deletion never completed", async () => {
    const user = await User.create({ name: "Live", email: "live@example.com" });
    const userId = String(user._id);
    await registerAccountDeletion(userId);
    await Review.create({
      placeId: "p1",
      placeType: "osm",
      userId,
      rating: 4,
      passageWidthRating: 4,
      toiletRating: 4,
      elevatorRating: 4,
      serviceRating: 4,
    });

    await deletedAccountSweepTask.runBatch(ctx);
    expect(await Review.countDocuments({ userId })).toBe(1);
  });

  it("keeps the entry while Chroma cannot confirm the vector delete", async () => {
    const userId = new Types.ObjectId().toString();
    await DeletedAccount.create({
      userId,
      state: "user_deleted",
      userDeletedAt: ago(2 * DAY),
    });
    chroma.failDeletes = true;
    await deletedAccountSweepTask.runBatch(ctx);
    expect(await DeletedAccount.exists({ userId })).not.toBeNull();
  });

  it("drops the entry after a quiet period with nothing found", async () => {
    const userId = new Types.ObjectId().toString();
    await DeletedAccount.create({
      userId,
      state: "user_deleted",
      userDeletedAt: ago(2 * DAY),
    });
    await deletedAccountSweepTask.runBatch(ctx);
    expect(await DeletedAccount.exists({ userId })).toBeNull();
  });
});

describe("candidate queries use indexes", () => {
  async function plan(model: { collection: unknown }, filter: object) {
    const explained = await (
      model.collection as {
        find(f: object): { explain(): Promise<{ queryPlanner: unknown }> };
      }
    )
      .find(filter)
      .explain();
    return JSON.stringify(explained.queryPlanner);
  }

  it.each([
    [
      "sos resolved",
      SosSession,
      { status: "resolved", resolvedAt: { $lte: now } },
    ],
    [
      "contact location",
      EmergencyContact,
      { lastLineLocationUpdatedAt: { $lte: now } },
    ],
    ["memory tombstones", UserMemory, { deletedAt: { $lte: now } }],
    [
      "hazard scrub by close",
      HazardReport,
      { contentScrubbedAt: { $exists: false }, closedAt: { $lte: now } },
    ],
  ])("%s", async (_name, model, filter) => {
    await (model as typeof SosSession).init();
    expect(await plan(model, filter)).toContain("IXSCAN");
  });
});

describe("runRetention", () => {
  function fakeTask(
    name: string,
    batches: number[],
    fail = false,
  ): RetentionTask {
    let i = 0;
    return {
      name,
      async runBatch() {
        if (fail) throw new Error("boom");
        return batches[i++] ?? 0;
      },
    };
  }

  it("round-robins until drained and isolates failures", async () => {
    const small = { ...config, batchSize: 2 };
    const order: string[] = [];
    const wrap = (task: RetentionTask): RetentionTask => ({
      ...task,
      async runBatch(c) {
        order.push(task.name);
        return task.runBatch(c);
      },
    });
    const result = await runRetention(
      [
        wrap(fakeTask("a", [2, 2, 1])),
        wrap(fakeTask("b", [2, 0])),
        wrap(fakeTask("c", [], true)),
      ],
      small,
      { now },
    );
    expect(order).toEqual(["a", "b", "c", "a", "b", "a"]);
    expect(result.tasks).toEqual([
      { name: "a", processed: 5, drained: true, failed: false },
      { name: "b", processed: 2, drained: true, failed: false },
      { name: "c", processed: 0, drained: false, failed: true },
    ]);
    expect(result.backlog).toBe(false);
  });
});
