import mongoose from "mongoose";
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
import HazardReport from "../../model/hazard-report.model";
import User from "../../model/user.model";
import AuthSession from "../../model/auth-session.model";
import PushToken from "../../model/push-token.model";
import { EXPO_PUSH_SEND_URL } from "../../constants/push";
import type { ExpoPushMessage } from "../../adapters/expo-push.adapter";
import type { IHazardReport } from "../../types";
import {
  createSession,
  revokeAllSessionsByUserId,
} from "../user/user.auth-session.repository";
import {
  anonymizeHazardReports,
  deleteUserAndSessions,
  registerAccountDeletion,
} from "../user/user.account.repository";
import { registerPushToken } from "../user/user.push.service";
import {
  claimNextAiJob,
  convergeStuckAiJobs,
  failAiJob,
  finalizeAiReview,
} from "./hazard-report.ai-job.repository";
import { persistLegacyAiResult } from "./hazard-report.ai-legacy.repository";
import {
  scrubReportContent,
  setManualReview,
} from "./hazard-report.repository";
import {
  claimReviewNotification,
  expireReviewNotifications,
  finishReviewNotification,
  recordReviewNotificationDevice,
  renewReviewNotification,
} from "./hazard-report.notification.repository";
import {
  deliverNextReviewNotification,
  startHazardReviewNotificationWorker,
} from "./hazard-report.notification.service";
import { toReportView } from "./hazard-report.view";
import {
  decision,
  newId,
  seedQueued,
  seedReport,
} from "../../../tests/helpers/hazard-report-fixtures";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const fetchMock = vi.fn(
  async (_url: unknown, _init?: RequestInit): Promise<Response> =>
    Response.json({ data: [{ status: "ok", id: "expo-ticket" }] }),
);
const messages = (): ExpoPushMessage[] =>
  fetchMock.mock.calls.flatMap(
    ([, init]) => JSON.parse(String(init?.body)) as ExpoPushMessage[],
  );
const read = (id: string) =>
  HazardReport.findById(id).select("+reviewNotification").lean<IHazardReport>();

async function recipient(locales = ["zh-TW"]) {
  const userId = newId();
  await User.create({
    _id: userId,
    name: "test",
    email: `${userId}@example.test`,
  });
  const session = await createSession({
    userId,
    currentRefreshJti: newId(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  for (const [i, locale] of locales.entries()) {
    await registerPushToken({
      userId,
      authSessionId: session._id,
      token: `ExponentPushToken[${userId}-${i}]`,
      platform: "ios",
      locale,
    });
  }
  return { userId, sessionId: session._id };
}
async function completed(userId: string, result = decision()) {
  const id = await seedQueued({ reporterId: userId });
  const claim = (await claimNextAiJob(new Date(), newId()))!;
  expect(claim.reportId).toBe(id);
  expect(await finalizeAiReview(claim, result, new Date())).toBe(true);
  return { id, claim };
}
async function due(id: string) {
  await HazardReport.updateOne(
    { _id: id },
    { $set: { "reviewNotification.nextAttemptAt": new Date(Date.now() - 1) } },
  );
}
const manual = (value: "verified" | "rejected") => ({
  reviewerId: "admin",
  decision: value,
  reviewedAt: new Date(),
  note: "INTERNAL PRIVATE NOTE",
});

describe("hazard review durable push (real Mongo, real user push service, mocked Expo HTTP)", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest({ enableTestCommands: true });
  });
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      Response.json({ data: [{ status: "ok", id: "ticket" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("atomically commits a result and sends localized minimal payload through the existing push service", async () => {
    const { userId } = await recipient(["zh-TW", "en-GB"]);
    const { id, claim } = await completed(userId);
    expect((await read(id))?.reviewNotification).toMatchObject({
      state: "pending",
      revision: 1,
      result: "ai_supported",
    });
    expect(await finalizeAiReview(claim, decision(), new Date())).toBe(false);
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(2);
    expect(messages()[0]).toMatchObject({
      title: "危險通報審核更新",
      body: expect.stringContaining("影像可支持"),
    });
    expect(messages()[1]).toMatchObject({
      title: "Hazard report review update",
      body: expect.stringContaining("image supports"),
    });
    for (const message of messages()) {
      expect(message.data).toEqual({
        type: "hazard_review",
        reportId: id,
        notificationId: `${id}:1`,
      });
      expect(message.ttl).toBeGreaterThan(0);
      expect(message.ttl).toBeLessThanOrEqual(3600);
    }
    expect(
      fetchMock.mock.calls.every(([url]) => url === EXPO_PUSH_SEND_URL),
    ).toBe(true);
    expect((await read(id))?.reviewNotification).toMatchObject({
      state: "sent",
      attempts: 1,
      delivered: [
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ],
    });
    expect(await deliverNextReviewNotification()).toBe(false);
    expect(toReportView((await read(id))!, true)).not.toHaveProperty(
      "reviewNotification",
    );
    expect(await HazardReport.findById(id).lean()).not.toHaveProperty(
      "reviewNotification",
    );
  });

  it.each([
    ["needs_evidence", "pending", "需要更多佐證", "needs more evidence"],
    [
      "unsupported",
      "rejected",
      "目前照片未能支持",
      "current photo does not support",
    ],
  ] as const)(
    "keeps %s evidence semantics and safe copy",
    async (value, status, zh, en) => {
      const { userId } = await recipient(["zh-TW", "en"]);
      const { id } = await completed(
        userId,
        decision({ decision: value, reason: "SECRET REVIEW REASON" }),
      );
      await deliverNextReviewNotification();
      expect((await read(id))?.status).toBe(status);
      expect(messages()[0].body).toContain(zh);
      expect(messages()[1].body).toContain(en);
      expect(JSON.stringify(messages())).not.toMatch(
        /SECRET|photoUrl|storage|121\.565|25\.033|reportedLocation/,
      );
    },
  );

  it("one concurrent manual decision schedules once; a changed decision replaces the old event", async () => {
    const { userId } = await recipient();
    const id = await seedQueued({ reporterId: userId });
    await Promise.all([
      setManualReview(id, manual("verified")),
      setManualReview(id, manual("verified")),
    ]);
    expect((await read(id))?.reviewNotification?.revision).toBe(1);
    await deliverNextReviewNotification();
    await setManualReview(id, manual("verified"));
    expect(await deliverNextReviewNotification()).toBe(false);
    await setManualReview(id, manual("rejected"));
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(2);
    expect(messages()[1].body).toContain("未通過人工審核");
    expect((await read(id))?.reviewNotification?.revision).toBe(2);
    expect(JSON.stringify(messages())).not.toContain("INTERNAL");
  });

  it("fences superseded AI notices and late AI results after manual review", async () => {
    const { userId } = await recipient();
    const { id } = await completed(userId);
    const old = (await claimReviewNotification(new Date(), "old"))!;
    await setManualReview(id, manual("rejected"));
    expect(await renewReviewNotification(old, new Date())).toBe(false);
    expect(
      await recordReviewNotificationDevice(old, "digest", new Date()),
    ).toBe(false);
    expect(await finishReviewNotification(old, "sent", new Date())).toBe(false);
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(1);
    expect(messages()[0].body).toContain("人工審核");
    const queued = await seedQueued({ reporterId: userId });
    const ai = (await claimNextAiJob(new Date(), "ai"))!;
    await setManualReview(queued, manual("verified"));
    expect(await finalizeAiReview(ai, decision(), new Date())).toBe(false);
    expect((await read(queued))?.reviewNotification?.result).toBe(
      "manual_verified",
    );
  });

  it("two delivery workers send the same event once", async () => {
    const { userId } = await recipient();
    await completed(userId);
    const results = await Promise.all([
      deliverNextReviewNotification(),
      deliverNextReviewNotification(),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(messages()).toHaveLength(1);
  });

  it("recovers abandoned claims after restart, and fences the old worker", async () => {
    const { userId } = await recipient();
    const { id } = await completed(userId);
    const old = (await claimReviewNotification(new Date(), "crashed"))!;
    expect(await claimReviewNotification(new Date(), "other")).toBeNull();
    await HazardReport.updateOne(
      { _id: id },
      {
        $set: { "reviewNotification.leaseExpiresAt": new Date(Date.now() - 1) },
      },
    );
    const worker = startHazardReviewNotificationWorker();
    try {
      await vi.waitFor(async () =>
        expect((await read(id))?.reviewNotification?.state).toBe("sent"),
      );
    } finally {
      await worker.stop();
    }
    expect(await finishReviewNotification(old, "pending", new Date())).toBe(
      false,
    );
    expect(messages()).toHaveLength(1);
  });

  it("retains partial success and retries only the failed device", async () => {
    const { userId } = await recipient(["zh-TW", "en"]);
    const { id } = await completed(userId);
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ data: [{ status: "ok", id: "ok" }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { status: "error", details: { error: "MessageRateExceeded" } },
          ],
        }),
      );
    await deliverNextReviewNotification();
    const notice = (await read(id))?.reviewNotification;
    expect(notice).toMatchObject({ state: "pending", attempts: 1 });
    expect(notice?.delivered).toHaveLength(1);
    expect(notice!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await deliverNextReviewNotification()).toBe(false);
    await due(id);
    await deliverNextReviewNotification();
    expect(messages().map((m) => m.to)).toEqual([
      `ExponentPushToken[${userId}-0]`,
      `ExponentPushToken[${userId}-1]`,
      `ExponentPushToken[${userId}-1]`,
    ]);
    expect((await read(id))?.reviewNotification?.state).toBe("sent");
  });

  it("HTTP failure remains retryable and never rolls back the review", async () => {
    const { userId } = await recipient();
    const { id } = await completed(userId);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await deliverNextReviewNotification();
    expect(await read(id)).toMatchObject({
      status: "verified",
      reviewNotification: { state: "pending" },
    });
    await due(id);
    await deliverNextReviewNotification();
    expect((await read(id))?.reviewNotification?.state).toBe("sent");
  });

  it("DeviceNotRegistered removes the token and finishes without an endless retry", async () => {
    const { userId } = await recipient();
    const { id } = await completed(userId);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
      }),
    );
    await deliverNextReviewNotification();
    expect(await PushToken.countDocuments({ userId })).toBe(0);
    expect((await read(id))?.reviewNotification?.state).toBe("skipped");
  });

  it.each([
    "no-token",
    "revoked",
    "expired-session",
    "deleted-user",
    "deletion-started",
    "anonymized",
    "rebound",
  ])("does not send for %s", async (scenario) => {
    const { userId, sessionId } = await recipient();
    const { id } = await completed(userId);
    if (scenario === "no-token") await PushToken.deleteMany({ userId });
    if (scenario === "revoked") await revokeAllSessionsByUserId(userId);
    if (scenario === "expired-session")
      await AuthSession.updateOne(
        { _id: sessionId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
    if (scenario === "deleted-user") await deleteUserAndSessions(userId);
    if (scenario === "deletion-started") await registerAccountDeletion(userId);
    if (scenario === "anonymized")
      await anonymizeHazardReports(userId, "deleted:test");
    if (scenario === "rebound")
      await PushToken.updateMany({ userId }, { $set: { userId: newId() } });
    await deliverNextReviewNotification();
    await expireReviewNotifications(new Date());
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await read(id))?.reviewNotification?.state).toBe(
      scenario === "anonymized" ? "expired" : "skipped",
    );
  });

  it("rechecks revoked sessions and superseded results between devices", async () => {
    const { userId } = await recipient(["zh-TW", "en"]);
    const { id } = await completed(userId);
    fetchMock.mockImplementationOnce(async () => {
      await revokeAllSessionsByUserId(userId);
      return Response.json({ data: [{ status: "ok", id: "ok" }] });
    });
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(1);
    expect((await read(id))?.reviewNotification?.state).toBe("sent");
    const other = await recipient(["zh-TW", "en"]);
    const next = await completed(other.userId);
    fetchMock.mockImplementationOnce(async () => {
      await setManualReview(next.id, manual("rejected"));
      return Response.json({ data: [{ status: "ok", id: "old" }] });
    });
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(2);
    expect((await read(next.id))?.reviewNotification).toMatchObject({
      revision: 2,
      state: "pending",
      delivered: [],
    });
  });

  it("anonymous and historical completed reports do not generate a backlog", async () => {
    for (const reporter of [
      "anonymous:test",
      "deleted:test",
      "deidentified:test",
    ]) {
      const { id } = await completed(reporter);
      expect((await read(id))?.reviewNotification).toBeUndefined();
    }
    const { userId } = await recipient();
    await seedReport({ reporterId: userId });
    expect(await deliverNextReviewNotification()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["deadline", "report-expired", "scrubbed"])(
    "suppresses %s notifications",
    async (scenario) => {
      const { userId } = await recipient();
      const { id } = await completed(userId);
      if (scenario === "deadline")
        await HazardReport.updateOne(
          { _id: id },
          {
            $set: { "reviewNotification.deadlineAt": new Date(Date.now() - 1) },
          },
        );
      if (scenario === "report-expired")
        await HazardReport.updateOne(
          { _id: id },
          { $set: { expiredAt: new Date(Date.now() - 1) } },
        );
      if (scenario === "scrubbed") {
        await HazardReport.updateOne(
          { _id: id },
          { $set: { expiredAt: new Date(Date.now() - 1) } },
        );
        await scrubReportContent(id, new Date(), "deidentified:test");
        expect((await read(id))?.reviewNotification).toBeUndefined();
      }
      await expireReviewNotifications(new Date());
      expect(await deliverNextReviewNotification()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("explicit and maintenance AI failures atomically queue a technical-failure notice once", async () => {
    const { userId } = await recipient(["en"]);
    const a = await seedQueued({ reporterId: userId });
    const claim = (await claimNextAiJob(new Date(), "fail"))!;
    expect(await failAiJob(claim, "AI_PROVIDER_ERROR", new Date())).toBe(true);
    expect(await failAiJob(claim, "AI_PROVIDER_ERROR", new Date())).toBe(false);
    await deliverNextReviewNotification();
    expect(messages()[0].body).toContain("could not be completed");
    expect((await read(a))?.status).toBe("pending");
    const b = await seedQueued(
      { reporterId: userId },
      { deadlineAt: new Date(Date.now() - 1) },
    );
    await convergeStuckAiJobs(new Date());
    await convergeStuckAiJobs(new Date());
    expect((await read(b))?.reviewNotification).toMatchObject({
      revision: 1,
      result: "ai_failed",
    });
  });

  it("legacy verdict changes schedule safely without repeatedly notifying suspicious results", async () => {
    const { userId } = await recipient();
    const id = await seedReport({
      reporterId: userId,
      status: "pending",
      aiVerification: { verdict: "skipped", confidence: 0, reason: "legacy" },
    });
    const result = {
      verdict: "suspicious" as const,
      confidence: 0.2,
      reason: "$SECRET",
    };
    await persistLegacyAiResult(id, result);
    await persistLegacyAiResult(id, result);
    expect((await read(id))?.reviewNotification).toMatchObject({
      revision: 1,
      result: "legacy_suspicious",
    });
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(1);
    expect(messages()[0].body).toContain("進一步審核");
  });

  it("a failed Mongo result commit cannot leave a detached notification; retry commits both", async () => {
    const { userId } = await recipient();
    const id = await seedQueued({ reporterId: userId });
    const claim = (await claimNextAiJob(new Date(), "atomic"))!;
    await mongoose.connection.db!.admin().command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: { failCommands: ["update"], errorCode: 2 },
    });
    await expect(
      finalizeAiReview(claim, decision(), new Date()),
    ).rejects.toThrow();
    expect(await read(id)).toMatchObject({
      status: "pending",
      aiReview: { state: "processing" },
    });
    expect((await read(id))?.reviewNotification).toBeUndefined();
    expect(await finalizeAiReview(claim, decision(), new Date())).toBe(true);
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(1);
  });

  it("Mongo token lookup failure is retried, not mistaken for no devices", async () => {
    const { userId } = await recipient();
    const { id } = await completed(userId);
    await mongoose.connection.db!.admin().command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: { failCommands: ["find"], errorCode: 2 },
    });
    await deliverNextReviewNotification();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await read(id))?.reviewNotification?.state).toBe("pending");
    await due(id);
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(1);
  });

  it("exposes the unavoidable accepted-before-checkpoint ambiguity with a stable notification id", async () => {
    const { userId } = await recipient();
    const { id } = await completed(userId);
    fetchMock.mockImplementationOnce(async () => {
      await mongoose.connection.db!.admin().command({
        configureFailPoint: "failCommand",
        mode: { times: 1 },
        data: { failCommands: ["update"], errorCode: 2 },
      });
      return Response.json({
        data: [{ status: "ok", id: "accepted-before-db-fault" }],
      });
    });
    await deliverNextReviewNotification();
    expect((await read(id))?.reviewNotification).toMatchObject({
      state: "pending",
      delivered: [],
    });
    await due(id);
    await deliverNextReviewNotification();
    expect(messages()).toHaveLength(2);
    expect(messages()[0].data).toEqual(messages()[1].data);
    expect((await read(id))?.reviewNotification?.state).toBe("sent");
  });

  it("legacy skipped overrides revoke pending notices without reusing their revision", async () => {
    const { userId } = await recipient();
    const id = await seedReport({
      reporterId: userId,
      status: "pending",
      aiVerification: { verdict: "skipped", confidence: 0, reason: "old" },
    });
    await persistLegacyAiResult(id, {
      verdict: "suspicious",
      confidence: 0.2,
      reason: "review",
    });
    const old = (await claimReviewNotification(new Date(), "old"))!;
    await persistLegacyAiResult(id, {
      verdict: "skipped",
      confidence: 0,
      reason: "failure",
    });
    expect(await renewReviewNotification(old, new Date())).toBe(false);
    expect(await deliverNextReviewNotification()).toBe(false);
    await persistLegacyAiResult(id, {
      verdict: "suspicious",
      confidence: 0.2,
      reason: "review",
    });
    expect((await read(id))?.reviewNotification?.revision).toBe(2);
  });
});
