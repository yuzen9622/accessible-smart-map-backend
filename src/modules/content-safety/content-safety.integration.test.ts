import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("../../adapters/email.adapter", () => ({
  sendEmail: vi.fn(async () => {}),
}));
import { sendEmail } from "../../adapters/email.adapter";
import User from "../../model/user.model";
import AuthSession from "../../model/auth-session.model";
import Review from "../../model/review.model";
import ContentReport from "../../model/content-report.model";
import UserBlock from "../../model/user-block.model";
import { createAccessToken } from "../../config/jwt";
import authenticate from "../../middleware/middleware";
import { requireContributor } from "./content-safety.middleware";
import { findSafetyReports } from "../hazard-report/hazard-report.service";
import { generateOpenAPIDocument } from "../../openapi/document";
import ContentSafetyQuota from "../../model/content-safety-quota.model";
import { createContentSafetyRouter } from "./content-safety.router";
import {
  reportContent,
  blockContentAuthor,
  getBlocks,
  unblock,
  mayContribute,
} from "./content-safety.service";
import * as safetyRepository from "./content-safety.repository";
import { claimMail, updateMail, decideCase } from "./content-safety.repository";
import { reconcileAdmission } from "./content-safety.admission.repository";
import { reconcileDecision } from "./content-safety.decision.repository";
import {
  drainContentSafetyRecovery,
  drainContentReportMail,
} from "./content-safety.worker";
import {
  findReviewPage,
  averageRating,
  findRatingsForSummary,
} from "../review/review.repository";
import {
  findNearbyReports,
  findPublicReportById,
  findConfirmedWithin,
} from "../hazard-report/hazard-report.repository";
import { seedReport } from "../../../tests/helpers/hazard-report-fixtures";
import { deleteOwnedRecords } from "../user/user.account.repository";
import { ReportSchema } from "./content-safety.schema";

function required<T>(value: T): NonNullable<T> {
  if (value == null) throw new Error("Required test fixture missing");
  return value as NonNullable<T>;
}
let mongo: MongoMemoryServer;
let author: string;
let reporter: string;
let admin: string;
let reviewId: string;
const app = express();
app.use(express.json());
app.use("/api/v1", createContentSafetyRouter());
app.post("/contribute", authenticate, requireContributor, (_req, res) =>
  res.json({ ok: true }),
);
const input = () => ({
  targetType: "review" as const,
  targetId: reviewId,
  reason: "spam" as const,
  details: "<img src=x onerror=alert(1)>",
  language: "zh-TW" as const,
});
async function createCase() {
  await reportContent(reporter, input());
  return required(await ContentReport.findOne().lean());
}
async function auth(id: string) {
  const user = required(await User.findById(id));
  const session = await AuthSession.create({
    userId: id,
    currentRefreshJti: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000),
  });
  return `Bearer ${createAccessToken(user, String(session._id))}`;
}
beforeAll(async () => {
  process.env.MONGOMS_DOWNLOAD_DIR ??= join(
    tmpdir(),
    "accessible-smart-map-mongodb-binaries",
  );
  mongo = await MongoMemoryServer.create({
    instance: { args: ["--setParameter", "enableTestCommands=1"] },
  });
  await mongoose.connect(mongo.getUri(), {
    dbName: `content_safety_${randomUUID().replace(/-/g, "")}`,
  });
  expect(
    (await mongoose.connection.db?.admin().command({ hello: 1 }))?.setName,
  ).toBeUndefined();
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({}),
    ),
  );
  vi.mocked(sendEmail).mockReset().mockResolvedValue();
  vi.stubEnv("RESEND_API_KEY", "fixture-only");
  vi.stubEnv("RESEND_FROM", "sender@example.test");
  vi.stubEnv("CONTENT_REPORT_TEAM_EMAIL", "team@example.test");
  author = String(
    (await User.create({ name: "author", email: "author@example.test" }))._id,
  );
  reporter = String(
    (
      await User.create({
        name: "reporter",
        email: "reporter@example.test",
        emailVerified: true,
      })
    )._id,
  );
  admin = String(
    (
      await User.create({
        name: "admin",
        email: "admin@example.test",
        role: "admin",
      })
    )._id,
  );
  reviewId = String(
    (
      await Review.create({
        placeId: "node/1",
        placeType: "osm",
        userId: author,
        rating: 1,
        passageWidthRating: 1,
        toiletRating: 1,
        elevatorRating: 1,
        serviceRating: 1,
        comment: "unsafe <script>",
      })
    )._id,
  );
});
describe("content safety with real MongoDB and fake outbound email only", () => {
  it("atomically coalesces simultaneous reports and saves two independent mail jobs", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reportContent(reporter, input())),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await ContentReport.countDocuments()).toBe(1);
    expect((await ContentSafetyQuota.findOne().lean())?.count).toBe(1);
    const row = required(await ContentReport.findOne().lean());
    expect(row.mails.team.state).toBe("pending");
    expect(row.mails.reporter.state).toBe("pending");
    await Review.updateOne(
      { _id: reviewId },
      { $set: { comment: "new violation" } },
    );
    await reportContent(reporter, input());
    expect(await ContentReport.countDocuments()).toBe(2);
  });
  it("coalesces concurrent duplicates at the quota boundary without spending extra slots", async () => {
    const hour = Math.floor(Date.now() / 3600000);
    await ContentSafetyQuota.create({
      _id: `${reporter}:${hour}`,
      count: 19,
      expiresAt: new Date((hour + 2) * 3600000),
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reportContent(reporter, input())),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await ContentReport.countDocuments()).toBe(1);
    expect((await ContentSafetyQuota.findOne().lean())?.count).toBe(20);
    expect((await reportContent(reporter, input())).ok).toBe(true);
    await Review.updateOne(
      { _id: reviewId },
      { $set: { comment: "new version at limit" } },
    );
    expect((await reportContent(reporter, input())).ok).toBe(false);
    expect(
      await ContentReport.countDocuments({ "admission.state": "admitted" }),
    ).toBe(1);
    expect(
      await ContentReport.countDocuments({ "admission.state": "rejected" }),
    ).toBe(1);
  });
  it("uses fresh claim and completion times after a batch spans the lease duration", async () => {
    const row = await createCase();
    let time = Date.now();
    vi.mocked(sendEmail).mockImplementationOnce(async () => {
      time += 121000;
    });
    await drainContentReportMail(() => new Date(time));
    const stored = required(await ContentReport.findById(row._id).lean());
    // Team's expired first attempt is recovered with the same provider key.
    expect(stored.mails.team.state).toBe("accepted");
    expect(stored.mails.reporter.state).toBe("accepted");
    expect(stored.mails.reporter.acceptedAt?.getTime()).toBe(time);
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toEqual(
      vi.mocked(sendEmail).mock.calls[1][0],
    );
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });
  it("does not dispatch if the database CAS response arrives after lease expiry", async () => {
    await createCase();
    let time = Date.now();
    const realUpdate = safetyRepository.updateMail;
    const delayed = vi
      .spyOn(safetyRepository, "updateMail")
      .mockImplementation(async (...args) => {
        const result = await realUpdate(...args);
        time += 121000;
        return result;
      });
    try {
      await drainContentReportMail(() => new Date(time));
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      delayed.mockRestore();
    }
  });
  it("sends a private localized receipt and retries only the failed recipient with frozen payload", async () => {
    const row = await createCase();
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("temporary"));
    await drainContentReportMail();
    let stored = required(await ContentReport.findById(row._id).lean());
    expect(stored.mails.team.state).toBe("pending");
    expect(stored.mails.reporter.state).toBe("accepted");
    const receipt = vi.mocked(sendEmail).mock.calls[1][0];
    expect(receipt.to).toBe("reporter@example.test");
    expect(receipt.text).toContain("我們已收到");
    expect(receipt.text).not.toContain("unsafe");
    expect(receipt.text).not.toContain(author);
    const first = vi.mocked(sendEmail).mock.calls[0][0];
    expect(first.html).not.toContain("<img");
    expect(first.html).toContain("&lt;img");
    vi.stubEnv("CONTENT_REPORT_TEAM_EMAIL", "changed@example.test");
    vi.stubEnv("RESEND_FROM", "changed-from@example.test");
    await ContentReport.updateOne(
      { _id: row._id },
      { $set: { "mails.team.nextAttemptAt": new Date(0) } },
    );
    await drainContentReportMail();
    expect(vi.mocked(sendEmail).mock.calls[2][0]).toEqual(first);
    stored = required(await ContentReport.findById(row._id).lean());
    expect(stored.mails.team.state).toBe("accepted");
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });
  it("requires configured team email with no fallback and leaves the reporter delivery independent", async () => {
    await createCase();
    vi.stubEnv("CONTENT_REPORT_TEAM_EMAIL", "");
    await drainContentReportMail();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0].to).toBe(
      "reporter@example.test",
    );
    expect((await ContentReport.findOne().lean())?.mails.team.state).toBe(
      "pending",
    );
  });
  it("accepts unverified accounts without mailing them; cancels mail after verified address changes", async () => {
    await User.updateOne({ _id: reporter }, { emailVerified: false });
    const result = await reportContent(reporter, input());
    expect(result.data).toMatchObject({ confirmationEmail: "unavailable" });
    await drainContentReportMail();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await ContentReport.deleteMany({});
    vi.mocked(sendEmail).mockClear();
    await User.updateOne({ _id: reporter }, { emailVerified: true });
    await createCase();
    await User.updateOne({ _id: reporter }, { email: "new@example.test" });
    await drainContentReportMail();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await ContentReport.findOne().lean())?.mails.reporter.state).toBe(
      "cancelled",
    );
  });
  it("fences expired leases and does not auto-resend outside the provider dedup window", async () => {
    const row = await createCase();
    const now = new Date();
    const a = required(await claimMail("team", now));
    const later = new Date(now.getTime() + 121000);
    const b = required(await claimMail("team", later));
    expect(a.mails.team.leaseToken).not.toBe(b.mails.team.leaseToken);
    expect(
      await updateMail(
        String(row._id),
        "team",
        required(a.mails.team.leaseToken),
        { state: "accepted" },
        later,
      ),
    ).toBe(false);
    await ContentReport.updateOne(
      { _id: row._id },
      {
        $set: {
          "mails.team.state": "pending",
          "mails.team.nextAttemptAt": new Date(0),
          "mails.team.firstAttemptAt": new Date(Date.now() - 24 * 3600000),
        },
      },
    );
    await drainContentReportMail();
    expect(
      (await ContentReport.findById(row._id).lean())?.mails.team.state,
    ).toBe("manual_review");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
  it("returns opaque block ids and filters list/statistics/summary without changing anonymous readers", async () => {
    expect((await blockContentAuthor(reporter, input())).ok).toBe(true);
    await blockContentAuthor(reporter, input());
    expect(await UserBlock.countDocuments()).toBe(1);
    const list = await getBlocks(reporter);
    expect(JSON.stringify(list)).not.toContain(author);
    expect(JSON.stringify(list)).not.toContain("author@example");
    const filter = {
      placeId: "node/1",
      placeType: "osm" as const,
      excludedAuthorIds: [author],
    };
    expect((await findReviewPage(filter, 1, 10)).items).toEqual([]);
    expect(await averageRating(filter)).toBeNull();
    expect(
      (await findRatingsForSummary("node/1", "osm", 50, [author])).reviews,
    ).toEqual([]);
    expect(
      (await findReviewPage({ ...filter, excludedAuthorIds: [] }, 1, 10)).items,
    ).toHaveLength(1);
    const block = required(await UserBlock.findOne());
    await unblock(author, String(block._id));
    expect(await UserBlock.countDocuments()).toBe(1);
    await unblock(reporter, String(block._id));
    expect(await UserBlock.countDocuments()).toBe(0);
  });
  it("keeps private intakes inaccessible and hides moderated hazards from public and routing reads", async () => {
    const privateId = await seedReport({
      reporterId: author,
      photoIntake: {
        state: "uploading",
        storagePath: "reports/test.jpg",
        uploadToken: "fixture",
        deadlineAt: new Date(Date.now() + 60000),
      },
    });
    expect(
      (
        await reportContent(reporter, {
          ...input(),
          targetType: "hazard_report",
          targetId: privateId,
        })
      ).httpCode,
    ).toBe(404);
    const hazard = await seedReport({
      reporterId: author,
      confirmedBy: [reporter],
    });
    await reportContent(reporter, {
      ...input(),
      targetType: "hazard_report",
      targetId: hazard,
    });
    const row = required(await ContentReport.findOne().lean());
    const view = await findPublicReportById(hazard);
    expect(view).not.toHaveProperty("reporterId");
    expect(view?.canBlockAuthor).toBe(true);
    expect(await findPublicReportById(hazard, [author])).toBeNull();
    expect(
      await decideCase(String(row._id), admin, {
        action: "hide",
        note: "violation",
        requestId: randomUUID(),
      }),
    ).toBe("ok");
    expect(await findPublicReportById(hazard)).toBeNull();
    expect(
      await findNearbyReports(
        25.033,
        121.565,
        1000,
        ["verified"],
        undefined,
        20,
        new Date(),
      ),
    ).toEqual([]);
    expect(
      await findConfirmedWithin(
        { lat: 25.033, lng: 121.565 },
        1000,
        20,
        new Date(),
      ),
    ).toEqual([]);
  });
  it("atomically applies audited decisions, deduplicates commands, and preserves deleted content on restore", async () => {
    const row = await createCase();
    const action = {
      action: "hide" as const,
      note: "violation",
      requestId: randomUUID(),
    };
    expect(await decideCase(String(row._id), reporter, action)).toBe(
      "forbidden",
    );
    await Promise.all([
      decideCase(String(row._id), admin, action),
      decideCase(String(row._id), admin, action),
    ]);
    expect(
      (await ContentReport.findById(row._id).lean())?.decisions,
    ).toHaveLength(1);
    expect(
      (await findReviewPage({ placeId: "node/1", placeType: "osm" }, 1, 10))
        .items,
    ).toHaveLength(0);
    await Review.updateOne({ _id: reviewId }, { status: "deleted" });
    await decideCase(String(row._id), admin, {
      action: "restore",
      note: "appeal",
      requestId: randomUUID(),
    });
    expect(
      (await findReviewPage({ placeId: "node/1", placeType: "osm" }, 1, 10))
        .items,
    ).toHaveLength(0);
    await decideCase(String(row._id), admin, {
      action: "restrict_author",
      note: "repeated abuse",
      requestId: randomUUID(),
    });
    expect(await mayContribute(author)).toBe(false);
  });
  it("does not apply a sanction when durable intent cannot be written", async () => {
    const row = await createCase();
    const write = vi
      .spyOn(ContentReport, "updateOne")
      .mockImplementationOnce(() => {
        throw new Error("intent unavailable");
      });
    try {
      await expect(
        decideCase(String(row._id), admin, {
          action: "hide",
          note: "violation",
          requestId: randomUUID(),
        }),
      ).rejects.toThrow("intent unavailable");
    } finally {
      write.mockRestore();
    }
    expect(
      (await Review.findById(reviewId).lean())?.moderationHiddenAt,
    ).toBeUndefined();
    expect(
      (await ContentReport.findById(row._id).lean())?.decisions,
    ).toHaveLength(0);
  });
  it("cleans cases and blocks in account deletion and cancels mail when the account vanishes", async () => {
    await createCase();
    await blockContentAuthor(reporter, input());
    await deleteOwnedRecords(reporter);
    expect(await ContentReport.countDocuments()).toBe(0);
    expect(await UserBlock.countDocuments()).toBe(0);
    await createCase();
    await User.deleteOne({ _id: reporter });
    await drainContentReportMail();
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("validates HTTP requests, authenticates sessions, and protects case evidence", async () => {
    expect(
      ReportSchema.safeParse({ ...input(), reason: "other", details: " " })
        .success,
    ).toBe(false);
    expect(
      (await request(app).post("/api/v1/content-reports").send(input())).status,
    ).toBe(403);
    const token = await auth(reporter);
    expect(
      (
        await request(app)
          .post("/api/v1/content-reports")
          .set("Authorization", token)
          .send({ ...input(), authorId: admin, email: "attacker@example.test" })
      ).status,
    ).toBe(400);
    const res = await request(app)
      .post("/api/v1/content-reports")
      .set("Authorization", token)
      .send(input());
    expect(res.status).toBe(200);
    expect(res.body.data.caseNumber).toMatch(/^[a-f\d]{24}$/);
    const id = res.body.data.caseNumber;
    expect(
      (
        await request(app)
          .get(`/api/v1/content-reports/${id}`)
          .set("Authorization", token)
      ).status,
    ).toBe(403);
    const evidence = await request(app)
      .get(`/api/v1/content-reports/${id}`)
      .set("Authorization", await auth(admin));
    expect(evidence.status).toBe(200);
    expect(evidence.body.data.snapshot).toContain("unsafe");
    expect(JSON.stringify(evidence.body)).not.toContain(
      "reporter@example.test",
    );
    expect((await reportContent(author, input())).httpCode).toBe(400);
    expect((await blockContentAuthor(author, input())).httpCode).toBe(400);
  });
});

describe("safety contract boundaries", () => {
  it("rejects invalid receipt fields and documents each new route", () => {
    const doc = generateOpenAPIDocument();
    expect(doc.servers?.[0].url).toBe("/api/v1");
    for (const path of [
      "/content-reports",
      "/content-reports/{id}",
      "/content-reports/{id}/decision",
      "/user/blocks",
      "/user/blocks/{id}",
      "/a11y/reports/safety",
    ])
      expect(doc.paths[path]).toBeDefined();
    expect(
      ReportSchema.safeParse({ ...input(), details: "x".repeat(1001) }).success,
    ).toBe(false);
  });
  it("holds concurrent dispatches to one accepted call per recipient", async () => {
    await createCase();
    await Promise.all([
      drainContentReportMail(),
      drainContentReportMail(),
      drainContentReportMail(),
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        vi.mocked(sendEmail).mock.calls.map(([args]) => args.idempotencyKey),
      ).size,
    ).toBe(2);
  });
  it("enforces shared account quotas but still allows retrieving a prior receipt", async () => {
    await createCase();
    const hour = Math.floor(Date.now() / 3600000);
    await ContentSafetyQuota.updateOne(
      { _id: `${reporter}:${hour}` },
      { count: 20 },
    );
    expect((await reportContent(reporter, input())).ok).toBe(true);
    await Review.updateOne({ _id: reviewId }, { comment: "new version" });
    expect((await reportContent(reporter, input())).httpCode).toBe(429);
    expect(
      await ContentReport.countDocuments({ "admission.state": "admitted" }),
    ).toBe(1);
    expect(
      await ContentReport.countDocuments({ "admission.state": "rejected" }),
    ).toBe(1);
  });
  it("retains sanitized safety facts after personal blocking but excludes platform hidden hazards", async () => {
    const id = await seedReport({
      reporterId: author,
      description: "private user wording",
    });
    await blockContentAuthor(reporter, {
      targetType: "hazard_report",
      targetId: id,
    });
    const facts = await findSafetyReports({ lat: 25.033, lng: 121.565 });
    expect(facts.data).toMatchObject({ total: 1 });
    expect(JSON.stringify(facts)).not.toContain("private user wording");
    expect(JSON.stringify(facts)).not.toContain(author);
    expect(JSON.stringify(facts)).not.toContain("photo");
    expect(
      await findNearbyReports(
        25.033,
        121.565,
        1000,
        ["verified"],
        undefined,
        20,
        new Date(),
        [author],
      ),
    ).toHaveLength(0);
  });
  it("checks current restriction even using a token issued before the sanction", async () => {
    const token = await auth(author);
    const row = await createCase();
    expect(
      (await request(app).post("/contribute").set("Authorization", token))
        .status,
    ).toBe(200);
    await decideCase(String(row._id), admin, {
      action: "restrict_author",
      note: "repeated abuse",
      requestId: randomUUID(),
    });
    const denied = await request(app)
      .post("/contribute")
      .set("Authorization", token);
    expect(denied.status).toBe(400);
    expect(denied.body.data.reason).toBe("CONTENT_RESTRICTED");
    expect(
      (
        await request(app)
          .get("/api/v1/user/blocks")
          .set("Authorization", token)
      ).status,
    ).toBe(200);
    await decideCase(String(row._id), admin, {
      action: "unrestrict_author",
      note: "appeal",
      requestId: randomUUID(),
    });
    expect(
      (await request(app).post("/contribute").set("Authorization", token))
        .status,
    ).toBe(200);
  });
  it("renders English confirmation without copying the report explanation", async () => {
    await reportContent(reporter, { ...input(), language: "en" });
    await drainContentReportMail();
    const receipt = vi
      .mocked(sendEmail)
      .mock.calls.find(([args]) => args.to === "reporter@example.test")?.[0];
    expect(receipt?.subject).toContain("We received");
    expect(receipt?.text).not.toContain(input().details);
  });
});

describe("standalone recovery and concurrency", () => {
  it("recovers a quota reservation whose database acknowledgement was lost", async () => {
    const realUpdate = ContentSafetyQuota.updateOne.bind(ContentSafetyQuota);
    let injected = false;
    const fault = vi
      .spyOn(ContentSafetyQuota, "updateOne")
      .mockImplementation((...args) => {
        const query = realUpdate(...args);
        if (!injected && args[1] && "$inc" in args[1]) {
          injected = true;
          return query.transform(() => {
            throw new Error("quota ack lost");
          });
        }
        return query;
      });
    try {
      expect((await reportContent(reporter, input())).httpCode).toBe(503);
    } finally {
      fault.mockRestore();
    }
    const pending = required(await ContentReport.findOne().lean());
    expect(pending.admission?.state).toBe("pending");
    expect(pending.mails.team.state).toBe("pending");
    expect(pending.mails.reporter.state).toBe("pending");
    expect((await ContentSafetyQuota.findOne().lean())?.count).toBe(1);
    await drainContentReportMail();
    expect(sendEmail).not.toHaveBeenCalled();
    await drainContentSafetyRecovery();
    expect((await ContentReport.findOne().lean())?.admission?.state).toBe(
      "admitted",
    );
    expect((await ContentSafetyQuota.findOne().lean())?.count).toBe(1);
    await drainContentReportMail();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect((await reportContent(reporter, input())).data).toMatchObject({
      duplicate: true,
    });
  });
  it("recovers after the quota succeeds but the admission write fails", async () => {
    const fault = vi
      .spyOn(ContentReport, "findOneAndUpdate")
      .mockImplementationOnce(() => {
        throw new Error("admission unavailable");
      });
    try {
      expect((await reportContent(reporter, input())).httpCode).toBe(503);
    } finally {
      fault.mockRestore();
    }
    expect((await ContentReport.findOne().lean())?.admission?.state).toBe(
      "pending",
    );
    await Promise.all([
      drainContentSafetyRecovery(),
      drainContentSafetyRecovery(),
    ]);
    const row = required(await ContentReport.findOne().lean());
    expect(row.admission?.state).toBe("admitted");
    expect(row.admission?.history).toHaveLength(2);
    expect((await ContentSafetyQuota.findOne().lean())?.count).toBe(1);
  });
  it("enforces a shared ceiling for different concurrent cases and retains rejected evidence", async () => {
    const template = required(await Review.findById(reviewId).lean());
    const reviews = await Review.create(
      Array.from({ length: 25 }, (_, i) => ({
        ...template,
        _id: undefined,
        placeId: `node/concurrent-${i}`,
      })),
    );
    const results = await Promise.all(
      reviews.map((r) =>
        reportContent(reporter, { ...input(), targetId: String(r._id) }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect(results.filter((r) => r.httpCode === 429)).toHaveLength(5);
    const bucket = required(await ContentSafetyQuota.findOne().lean());
    expect(bucket.count).toBe(20);
    expect(new Set(bucket.caseIds).size).toBe(20);
    expect(
      await ContentReport.countDocuments({ "admission.state": "rejected" }),
    ).toBe(5);
  });
  it("allows a rejected case in a later hour while preserving its history", async () => {
    const hour = Math.floor(Date.now() / 3600000);
    await ContentSafetyQuota.create({
      _id: `${reporter}:${hour}`,
      count: 20,
      expiresAt: new Date((hour + 2) * 3600000),
    });
    expect((await reportContent(reporter, input())).httpCode).toBe(429);
    const rejected = required(await ContentReport.findOne().lean());
    await drainContentReportMail();
    expect(sendEmail).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date((hour + 1) * 3600000 + 100));
      expect((await reportContent(reporter, input())).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const admitted = required(await ContentReport.findOne().lean());
    expect(String(admitted._id)).toBe(String(rejected._id));
    expect(admitted.admission?.history.map((h) => h.state)).toEqual([
      "pending",
      "rejected",
      "pending",
      "admitted",
    ]);
    expect(
      (await ContentSafetyQuota.findById(`${reporter}:${hour + 1}`).lean())
        ?.count,
    ).toBe(1);
  });
  it("rejects expired pending admission without recreating its expired quota bucket", async () => {
    const row = await createCase();
    const oldHour = Math.floor(Date.now() / 3600000) - 3;
    await ContentReport.updateOne(
      { _id: row._id },
      { $set: { "admission.state": "pending", "admission.hour": oldHour } },
    );
    await reconcileAdmission(String(row._id));
    expect(
      await ContentSafetyQuota.exists({ _id: `${reporter}:${oldHour}` }),
    ).toBeNull();
    expect(
      (await ContentReport.findById(row._id).lean())?.admission,
    ).toMatchObject({ state: "rejected", reason: "RESERVATION_EXPIRED" });
    await drainContentReportMail();
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("recovers historical application after a later reverse decision has completed", async () => {
    const row = await createCase();
    const action = {
      action: "hide" as const,
      note: "violation",
      requestId: randomUUID(),
    };
    const realUpdate = ContentReport.updateOne.bind(ContentReport);
    let injected = false;
    const fault = vi
      .spyOn(ContentReport, "updateOne")
      .mockImplementation((...args) => {
        if (
          !injected &&
          JSON.stringify(args[1]).includes('"decisions.$.state":"applied"')
        ) {
          injected = true;
          throw new Error("final audit unavailable");
        }
        return realUpdate(...args);
      });
    try {
      expect(await decideCase(String(row._id), admin, action)).toBe("pending");
    } finally {
      fault.mockRestore();
    }
    expect(
      (await Review.findById(reviewId).lean())?.moderationHiddenAt,
    ).toBeInstanceOf(Date);
    expect(
      (await ContentReport.findById(row._id).lean())?.decisions[0].state,
    ).toBe("pending");
    expect(
      await decideCase(String(row._id), admin, {
        action: "restore",
        note: "appeal",
        requestId: randomUUID(),
      }),
    ).toBe("ok");
    expect(await reconcileDecision(String(row._id), action.requestId)).toBe(
      "ok",
    );
    expect(
      (await Review.findById(reviewId).lean())?.moderationHiddenAt,
    ).toBeUndefined();
    const settled = required(await ContentReport.findById(row._id).lean());
    expect(settled.decisions.map((d) => d.state)).toEqual([
      "applied",
      "applied",
    ]);
    expect(
      (await Review.findById(reviewId).select("+contentModeration").lean())
        ?.contentModeration,
    ).toMatchObject({ version: 2, receipts: [] });
  });
  it("recovers a target write with a lost acknowledgement without applying twice", async () => {
    const row = await createCase();
    const action = {
      action: "restrict_author" as const,
      note: "abuse",
      requestId: randomUUID(),
    };
    const realUpdate = User.collection.updateOne.bind(User.collection);
    const fault = vi
      .spyOn(User.collection, "updateOne")
      .mockImplementationOnce(async (...args) => {
        await realUpdate(...args);
        throw new Error("target ack lost");
      });
    try {
      expect(await decideCase(String(row._id), admin, action)).toBe("pending");
    } finally {
      fault.mockRestore();
    }
    expect(await reconcileDecision(String(row._id), action.requestId)).toBe(
      "ok",
    );
    expect(
      (await User.findById(author).select("+contentModeration").lean())
        ?.contentModeration?.version,
    ).toBe(1);
    expect(await mayContribute(author)).toBe(false);
  });
  it("does not let an older retry overwrite a newer decision across cases", async () => {
    const row = await createCase();
    const action = {
      action: "hide" as const,
      note: "old",
      requestId: randomUUID(),
    };
    const fault = vi
      .spyOn(Review.collection, "updateOne")
      .mockRejectedValueOnce(new Error("target unavailable"));
    try {
      expect(await decideCase(String(row._id), admin, action)).toBe("pending");
    } finally {
      fault.mockRestore();
    }
    // A separate case concerning the same target has a newer completed decision.
    const second = await ContentReport.create({
      ...row,
      _id: undefined,
      reporterId: admin,
      decisions: [],
    });
    expect(
      await decideCase(String(second._id), admin, {
        action: "restore",
        note: "new",
        requestId: randomUUID(),
      }),
    ).toBe("ok");
    expect(await reconcileDecision(String(row._id), action.requestId)).toBe(
      "superseded",
    );
    expect(
      (await Review.findById(reviewId).lean())?.moderationHiddenAt,
    ).toBeUndefined();
  });
  it("recovers receipt cleanup after its write fails", async () => {
    const row = await createCase();
    const action = {
      action: "hide" as const,
      note: "violation",
      requestId: randomUUID(),
    };
    const realUpdate = Review.collection.updateOne.bind(Review.collection);
    const fault = vi
      .spyOn(Review.collection, "updateOne")
      .mockImplementation((...args) => {
        if (JSON.stringify(args[1]).includes('"$filter"'))
          throw new Error("cleanup unavailable");
        return realUpdate(...args);
      });
    try {
      await decideCase(String(row._id), admin, action);
    } finally {
      fault.mockRestore();
    }
    expect(
      (await ContentReport.findById(row._id).lean())?.decisions[0],
    ).toMatchObject({ state: "applied", receiptCleanupPending: true });
    await drainContentSafetyRecovery();
    expect(
      (await Review.findById(reviewId).select("+contentModeration").lean())
        ?.contentModeration?.receipts,
    ).toEqual([]);
    expect(
      (await ContentReport.findById(row._id).lean())?.decisions[0]
        .receiptCleanupPending,
    ).toBe(false);
  });
  it("finishes already accepted intents after actor revocation but rejects new commands", async () => {
    const row = await createCase();
    const action = {
      action: "hide" as const,
      note: "old",
      requestId: randomUUID(),
    };
    const fault = vi
      .spyOn(Review.collection, "updateOne")
      .mockRejectedValueOnce(new Error("target unavailable"));
    try {
      await decideCase(String(row._id), admin, action);
    } finally {
      fault.mockRestore();
    }
    await User.updateOne({ _id: admin }, { role: "user" });
    expect(
      await decideCase(String(row._id), admin, {
        ...action,
        requestId: randomUUID(),
      }),
    ).toBe("forbidden");
    expect(await reconcileDecision(String(row._id), action.requestId)).toBe(
      "ok",
    );
    expect(
      (await Review.findById(reviewId).lean())?.moderationHiddenAt,
    ).toBeInstanceOf(Date);
    await ContentReport.updateOne({ _id: row._id }, { purgeAt: new Date(0) });
    expect(await reconcileDecision(String(row._id), action.requestId)).toBe(
      "missing",
    );
  });
  it("supports legacy cases without admission and never exposes internal target recovery data", async () => {
    const row = await createCase();
    await ContentReport.updateOne(
      { _id: row._id },
      { $unset: { admission: 1 } },
    );
    expect((await reportContent(reporter, input())).ok).toBe(true);
    await drainContentReportMail();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    await decideCase(String(row._id), admin, {
      action: "restore",
      note: "review",
      requestId: randomUUID(),
    });
    const page = await findReviewPage(
      { placeId: "node/1", placeType: "osm" },
      1,
      10,
    );
    expect(JSON.stringify(page)).not.toContain("contentModeration");
  });
});

describe("standalone fencing boundaries", () => {
  it("does not admit a quota reservation after delayed DB work passes bucket expiry", async () => {
    const row = await createCase();
    await ContentReport.updateOne(
      { _id: row._id },
      { $set: { "admission.state": "pending" } },
    );
    const hour = required(row.admission).hour;
    let time = Date.now();
    const realUpdate = ContentSafetyQuota.updateOne.bind(ContentSafetyQuota);
    const fault = vi
      .spyOn(ContentSafetyQuota, "updateOne")
      .mockImplementationOnce((...args) =>
        realUpdate(...args).transform((value) => {
          time = (hour + 2) * 3600000 + 1;
          return value;
        }),
      );
    try {
      await reconcileAdmission(String(row._id), () => new Date(time));
    } finally {
      fault.mockRestore();
    }
    expect(
      (await ContentReport.findById(row._id).lean())?.admission,
    ).toMatchObject({ state: "rejected", reason: "RESERVATION_EXPIRED" });
    await drainContentReportMail();
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("fences an old admission worker after a new-hour attempt has started", async () => {
    const row = await createCase();
    const hour = required(row.admission).hour;
    await ContentReport.updateOne(
      { _id: row._id },
      { $set: { "admission.state": "pending" } },
    );
    const realExists = ContentSafetyQuota.exists.bind(ContentSafetyQuota);
    const fault = vi
      .spyOn(ContentSafetyQuota, "exists")
      .mockImplementationOnce((...args) =>
        realExists(...args).pre(async function () {
          await ContentReport.updateOne(
            { _id: row._id },
            {
              $set: {
                "admission.hour": hour + 1,
                "admission.state": "pending",
              },
            },
          );
        }),
      );
    try {
      await reconcileAdmission(String(row._id));
    } finally {
      fault.mockRestore();
    }
    expect(
      (await ContentReport.findById(row._id).lean())?.admission,
    ).toMatchObject({ hour: hour + 1, state: "pending" });
  });
  it("allows exactly one of two simultaneous opposing commands on the same target version", async () => {
    const row = await createCase();
    const actions = [
      { action: "hide" as const, note: "one", requestId: randomUUID() },
      { action: "restore" as const, note: "two", requestId: randomUUID() },
    ];
    // Persist both durable intents against the same observed target version.
    await ContentReport.updateOne(
      { _id: row._id },
      {
        $push: {
          decisions: {
            $each: actions.map((a) => ({
              ...a,
              actorId: admin,
              at: new Date(),
              state: "pending",
              expectedVersion: 0,
              nextAttemptAt: new Date(),
            })),
          },
        },
      },
    );
    const results = await Promise.all(
      actions.map((a) => reconcileDecision(String(row._id), a.requestId)),
    );
    expect(results.sort()).toEqual(["ok", "superseded"]);
    const stored = required(await ContentReport.findById(row._id).lean());
    expect(stored.decisions.map((d) => d.state).sort()).toEqual([
      "applied",
      "superseded",
    ]);
    const target = required(
      await Review.findById(reviewId).select("+contentModeration").lean(),
    );
    expect(target.contentModeration?.version).toBe(1);
    expect(Boolean(target.moderationHiddenAt)).toBe(
      stored.decisions.find((d) => d.state === "applied")?.action === "hide",
    );
  });
  it("does not apply an expired pending command and reclaims orphaned recovery receipts", async () => {
    const row = await createCase();
    const requestId = randomUUID();
    await ContentReport.updateOne(
      { _id: row._id },
      {
        $set: { purgeAt: new Date(0) },
        $push: {
          decisions: {
            requestId,
            actorId: admin,
            action: "hide",
            note: "old",
            at: new Date(),
            state: "pending",
            expectedVersion: 0,
          },
        },
      },
    );
    expect(await reconcileDecision(String(row._id), requestId)).toBe("missing");
    expect(
      (await Review.findById(reviewId).lean())?.moderationHiddenAt,
    ).toBeUndefined();
    const second = await ContentReport.create({
      ...row,
      _id: undefined,
      reporterId: admin,
      decisions: [],
    });
    await Review.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(reviewId) },
      {
        $set: {
          contentModeration: {
            version: 0,
            receipts: Array.from({ length: 100 }, (_, i) => ({
              key: `${row._id}/${i}`,
              caseId: String(row._id),
              at: new Date(),
            })),
          },
        },
      },
    );
    expect(
      await decideCase(String(second._id), admin, {
        action: "hide",
        note: "current",
        requestId: randomUUID(),
      }),
    ).toBe("ok");
    expect(
      (await Review.findById(reviewId).select("+contentModeration").lean())
        ?.contentModeration?.receipts,
    ).toHaveLength(0);
  });
});
