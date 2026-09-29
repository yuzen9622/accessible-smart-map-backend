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

vi.mock("../../adapters/chroma.adapter", () => ({
  getOrCreateCollection: vi.fn(async () => ({})),
  deleteDocumentsWhere: vi.fn(async () => {}),
}));

vi.mock("../../adapters/apple-auth.adapter", async (importActual) => ({
  ...(await importActual<typeof import("../../adapters/apple-auth.adapter")>()),
  exchangeAppleAuthorizationCode: vi.fn(),
  revokeAppleRefreshToken: vi.fn(),
}));

import crypto from "crypto";
import {
  ACCOUNT_DELETION_REAUTH_WINDOW_MS,
  deleteAccount,
} from "./user.account.service";
import { deleteDocumentsWhere } from "../../adapters/chroma.adapter";
import {
  AppleTokenRequestError,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from "../../adapters/apple-auth.adapter";
import { authenticateToken } from "../../config/auth";
import { createAccessToken, toPublicUser } from "../../config/jwt";
import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthSession from "../../model/auth-session.model";
import AuthToken from "../../model/auth-token.model";
import PasswordAssistanceJob from "../../model/password-assistance-job.model";
import LineLinkCode from "../../model/line-link-code.model";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import PushToken from "../../model/push-token.model";
import UserMemory from "../../model/user-memory.model";
import Review from "../../model/review.model";
import HazardReport from "../../model/hazard-report.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

async function seedAccount(email: string, extra: Record<string, unknown> = {}) {
  const user = await User.create({ name: email, email, ...extra });
  const userId = String(user._id);
  const session = await AuthSession.create({
    userId,
    currentRefreshJti: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const sessionId = String(session._id);

  await Config.create({ user_id: user._id });
  await AuthToken.create({
    userId,
    type: "email_verify",
    tokenHash: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await PasswordAssistanceJob.create({
    email,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await LineLinkCode.create({
    userId,
    code: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await EmergencyContact.create({
    userId,
    name: "Mom",
    bindCode: crypto.randomUUID(),
  });
  await SosSession.create({
    userId,
    type: "body",
    lat: 25,
    lng: 121,
    shareToken: crypto.randomUUID(),
    locationUpdatedAt: new Date(),
  });
  await PushToken.create({
    token: `ExponentPushToken[${crypto.randomUUID()}]`,
    userId,
    authSessionId: sessionId,
    platform: "ios",
    locale: "zh-TW",
  });
  await UserMemory.create({
    userId,
    content: "c",
    promptText: "p",
    retrievalText: "r",
    category: "preference",
  });
  await Review.create({
    placeId: "place-1",
    placeType: "osm",
    userId,
    rating: 5,
    passageWidthRating: 5,
    toiletRating: 5,
    elevatorRating: 5,
    serviceRating: 5,
  });

  const accessToken = createAccessToken(toPublicUser(user), sessionId);
  return { userId, sessionId, accessToken };
}

function hazardReport(reporterId: string, votes: Record<string, string[]>) {
  return HazardReport.create({
    reporterId,
    reportedLocation: { type: "Point", coordinates: [121, 25] },
    hazardType: "obstacle",
    photoUrl: "https://example.com/p.jpg",
    photoStoragePath: "p.jpg",
    exifValidation: {
      timestampFresh: true,
      gpsPresent: true,
      gpsMatchesClaimed: true,
    },
    aiVerification: { verdict: "verified", confidence: 1, reason: "ok" },
    confirmCount: votes.confirmedBy?.length ?? 0,
    denyCount: votes.deniedBy?.length ?? 0,
    expiredAt: new Date(Date.now() + 60_000),
    ...votes,
  });
}

const OWNED_MODELS = [
  AuthToken,
  LineLinkCode,
  EmergencyContact,
  SosSession,
  PushToken,
  UserMemory,
  Review,
  AuthSession,
] as const;

describe("deleteAccount with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
    await Promise.all(
      [User, HazardReport, SosSession, ...OWNED_MODELS].map((m) => m.init()),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("removes owned data, anonymizes hazard reports and spares other accounts", async () => {
    const alice = await seedAccount("alice@example.com");
    const bob = await seedAccount("bob@example.com");
    const aliceReport = await hazardReport(alice.userId, {
      confirmedBy: [bob.userId],
    });
    const bobReport = await hazardReport(bob.userId, {
      confirmedBy: [alice.userId, "carol"],
      deniedBy: [],
    });
    const deniedReport = await hazardReport(bob.userId, {
      deniedBy: [alice.userId],
    });
    const reviewedReport = await hazardReport(bob.userId, {});
    await HazardReport.updateOne(
      { _id: reviewedReport._id },
      {
        $set: {
          manualReview: { reviewerId: alice.userId, decision: "verified" },
        },
      },
    );

    expect((await authenticateToken(alice.accessToken)).ok).toBe(true);

    const result = await deleteAccount({
      userId: alice.userId,
      sessionId: alice.sessionId,
    });
    expect(result).toEqual({ ok: true });

    expect(await User.exists({ _id: alice.userId })).toBeNull();
    expect(await Config.countDocuments({ user_id: alice.userId })).toBe(0);
    for (const model of OWNED_MODELS) {
      expect(
        await (model as typeof AuthToken).countDocuments({
          userId: alice.userId,
        }),
      ).toBe(0);
    }
    expect(
      await PasswordAssistanceJob.countDocuments({
        email: "alice@example.com",
      }),
    ).toBe(0);
    expect(deleteDocumentsWhere).toHaveBeenCalledWith(expect.anything(), {
      userId: alice.userId,
    });

    const [a, b, d] = await Promise.all(
      [aliceReport, bobReport, deniedReport].map((r) =>
        HazardReport.findById(r._id).lean(),
      ),
    );
    expect(a?.reporterId).toMatch(/^deleted:/);
    expect(a?.confirmedBy).toEqual([bob.userId]);
    expect(b?.confirmedBy).toEqual([a?.reporterId, "carol"]);
    expect(b?.confirmCount).toBe(2);
    expect(d?.deniedBy).toEqual([a?.reporterId]);
    expect(d?.denyCount).toBe(1);
    const reviewed = await HazardReport.findById(reviewedReport._id).lean();
    expect(reviewed?.manualReview?.reviewerId).toBe(a?.reporterId);

    expect(await authenticateToken(alice.accessToken)).toEqual({
      ok: false,
      expired: false,
    });

    expect(await User.exists({ _id: bob.userId })).not.toBeNull();
    expect((await authenticateToken(bob.accessToken)).ok).toBe(true);
    for (const model of OWNED_MODELS) {
      expect(
        await (model as typeof AuthToken).countDocuments({
          userId: bob.userId,
        }),
      ).toBeGreaterThan(0);
    }
  });

  it("refuses a session that signed in outside the re-auth window", async () => {
    const alice = await seedAccount("alice@example.com");
    vi.useFakeTimers({
      now: Date.now() + ACCOUNT_DELETION_REAUTH_WINDOW_MS + 1000,
    });

    const result = await deleteAccount({
      userId: alice.userId,
      sessionId: alice.sessionId,
    });

    expect(result).toEqual({ ok: false, reason: "REAUTH_REQUIRED" });
    expect(await User.exists({ _id: alice.userId })).not.toBeNull();
    expect(await AuthSession.countDocuments({ userId: alice.userId })).toBe(1);
    expect(await Review.countDocuments({ userId: alice.userId })).toBe(1);
  });

  it("refuses a session owned by someone else", async () => {
    const alice = await seedAccount("alice@example.com");
    const bob = await seedAccount("bob@example.com");

    const result = await deleteAccount({
      userId: alice.userId,
      sessionId: bob.sessionId,
    });

    expect(result).toEqual({ ok: false, reason: "REAUTH_REQUIRED" });
    expect(await User.exists({ _id: alice.userId })).not.toBeNull();
  });

  describe("Sign in with Apple accounts", () => {
    const exchange = vi.mocked(exchangeAppleAuthorizationCode);
    const revoke = vi.mocked(revokeAppleRefreshToken);
    const APPLE_ENV = {
      APPLE_TEAM_ID: "TEAM123456",
      APPLE_KEY_ID: "KEY1234567",
      APPLE_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----",
    };

    beforeEach(() => {
      for (const [k, v] of Object.entries(APPLE_ENV)) vi.stubEnv(k, v);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function seedAppleAccount() {
      return seedAccount("apple@example.com", {
        appleUserId: "apple-sub",
        authProviders: ["apple"],
      });
    }

    async function expectUntouched(userId: string) {
      expect(await User.exists({ _id: userId })).not.toBeNull();
      expect(
        await AuthSession.countDocuments({ userId, revokedAt: null }),
      ).toBe(1);
      expect(await Review.countDocuments({ userId })).toBe(1);
    }

    it("revokes the Apple authorization before deleting", async () => {
      const apple = await seedAppleAccount();
      exchange.mockResolvedValue({ refreshToken: "rt", sub: "apple-sub" });
      revoke.mockResolvedValue();

      const result = await deleteAccount({
        userId: apple.userId,
        sessionId: apple.sessionId,
        appleAuthorizationCode: "fresh-code",
      });

      expect(result).toEqual({ ok: true });
      expect(exchange).toHaveBeenCalledWith(
        "fresh-code",
        expect.objectContaining({ teamId: "TEAM123456" }),
      );
      expect(revoke).toHaveBeenCalledWith("rt", expect.anything());
      expect(await User.exists({ _id: apple.userId })).toBeNull();
    });

    it("requires an authorization code", async () => {
      const apple = await seedAppleAccount();

      const result = await deleteAccount({
        userId: apple.userId,
        sessionId: apple.sessionId,
      });

      expect(result).toEqual({
        ok: false,
        reason: "APPLE_AUTHORIZATION_REQUIRED",
      });
      expect(exchange).not.toHaveBeenCalled();
      await expectUntouched(apple.userId);
    });

    it("refuses a code issued for a different Apple ID", async () => {
      const apple = await seedAppleAccount();
      exchange.mockResolvedValue({ refreshToken: "rt", sub: "someone-else" });

      const result = await deleteAccount({
        userId: apple.userId,
        sessionId: apple.sessionId,
        appleAuthorizationCode: "their-code",
      });

      expect(result).toEqual({
        ok: false,
        reason: "APPLE_AUTHORIZATION_INVALID",
      });
      expect(revoke).not.toHaveBeenCalled();
      await expectUntouched(apple.userId);
    });

    it.each([
      [
        "a code Apple rejects",
        "rejected" as const,
        "APPLE_AUTHORIZATION_INVALID",
      ],
      ["an Apple outage", "unavailable" as const, "APPLE_REVOKE_UNAVAILABLE"],
    ])("deletes nothing on %s", async (_label, kind, reason) => {
      const apple = await seedAppleAccount();
      exchange.mockRejectedValue(new AppleTokenRequestError(kind, "x"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await deleteAccount({
        userId: apple.userId,
        sessionId: apple.sessionId,
        appleAuthorizationCode: "code",
      });

      expect(result).toEqual({ ok: false, reason });
      await expectUntouched(apple.userId);
    });

    it("deletes nothing when the revoke call fails", async () => {
      const apple = await seedAppleAccount();
      exchange.mockResolvedValue({ refreshToken: "rt", sub: "apple-sub" });
      revoke.mockRejectedValue(new AppleTokenRequestError("unavailable", "x"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await deleteAccount({
        userId: apple.userId,
        sessionId: apple.sessionId,
        appleAuthorizationCode: "code",
      });

      expect(result).toEqual({ ok: false, reason: "APPLE_REVOKE_UNAVAILABLE" });
      await expectUntouched(apple.userId);
    });

    it("still deletes when the Apple signing key is not configured", async () => {
      vi.stubEnv("APPLE_PRIVATE_KEY", "");
      const apple = await seedAppleAccount();
      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await deleteAccount({
        userId: apple.userId,
        sessionId: apple.sessionId,
      });

      expect(result).toEqual({ ok: true });
      expect(exchange).not.toHaveBeenCalled();
    });

    it("ignores Apple entirely for accounts without an Apple ID", async () => {
      const plain = await seedAccount("plain@example.com");

      const result = await deleteAccount({
        userId: plain.userId,
        sessionId: plain.sessionId,
      });

      expect(result).toEqual({ ok: true });
      expect(exchange).not.toHaveBeenCalled();
    });
  });
});
