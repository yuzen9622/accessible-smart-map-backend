import bcrypt from "bcryptjs";
import crypto from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import User from "../../model/user.model";
import {
  atomicGoogleTakeover,
  atomicLinkGoogle,
  consumePasswordResetToken,
} from "./user.auth.repository";
import {
  createSession,
  findActiveSessionById,
  revokeAllSessionsByUserId,
} from "./user.auth-session.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function createBarrier(parties: number) {
  let count = 0;
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async function wait() {
    count++;
    if (count >= parties) {
      release();
    }
    await promise;
  };
}

describe("Google takeover vs Password Reset race in real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  }, 120_000);

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("handles barrier-controlled atomic race between Google takeover and Password Reset", async () => {
    const initialPasswordHash = await bcrypt.hash("OldPassword123", 10);
    const resetRawToken = "valid-reset-token-secret-12345";
    const resetTokenHash = hashToken(resetRawToken);

    // 1. Create an unverified local user in real MongoDB
    const user = await User.create({
      name: "Unverified Local User",
      email: "local-user@example.com",
      passwordHash: initialPasswordHash,
      authProviders: ["local"],
      emailVerified: false,
      tokenVersion: 0,
      passwordResetTokens: [
        {
          jobId: "job-1",
          tokenHash: resetTokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });

    const userId = String(user._id);

    // Create an existing session for this user
    const oldSession = await createSession({
      userId,
      currentRefreshJti: "old-session-jti",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const newPasswordHash = await bcrypt.hash("NewPasswordAfterReset456", 10);
    const barrier = createBarrier(2);

    // 2. Race Google takeover CAS vs Password Reset token consumption
    const [takeoverResult, resetResult] = await Promise.all([
      (async () => {
        await barrier();
        return atomicGoogleTakeover({
          userId,
          expectedTokenVersion: 0,
          expectedPasswordHash: initialPasswordHash,
          clientId: "google-sub-race-123",
          authProviders: ["google"],
        });
      })(),
      (async () => {
        await barrier();
        return consumePasswordResetToken(
          resetTokenHash,
          newPasswordHash,
          new Date(),
        );
      })(),
    ]);

    // Exactly one operation must win the atomic User document mutation
    const takeoverWon = takeoverResult !== null;
    const resetWon = resetResult !== null;

    expect(takeoverWon !== resetWon).toBe(true);

    if (resetWon) {
      // RESET WON THE RACE:
      // Verify resetResult has emailVerified: true and updated tokenVersion
      expect(resetResult?.emailVerified).toBe(true);
      expect(resetResult?.tokenVersion).toBe(1);

      // Google takeover CAS lost!
      expect(takeoverResult).toBeNull();

      // CAS loser re-read step:
      const recheck = await User.findById(userId).select("+passwordHash");
      expect(recheck).not.toBeNull();
      expect(recheck?.emailVerified).toBe(true);
      expect(recheck?.passwordHash).toBe(newPasswordHash);

      // Because emailVerified is true, Google must NOT drop passwordHash or overwrite reset password!
      // Instead, it safely links Google:
      const linkResult = await atomicLinkGoogle({
        userId,
        expectedTokenVersion: Number(recheck?.tokenVersion ?? 1),
        clientId: "google-sub-race-123",
      });
      expect(linkResult).not.toBeNull();

      // Verify the final user state in DB:
      const finalUser = await User.findById(userId).select("+passwordHash");
      expect(finalUser?.passwordHash).toBe(newPasswordHash); // Reset password preserved!
      expect(finalUser?.client_id).toBe("google-sub-race-123");
      expect(finalUser?.authProviders).toContain("local");
      expect(finalUser?.authProviders).toContain("google");
    } else {
      // GOOGLE TAKEOVER WON THE RACE:
      expect(takeoverResult?.emailVerified).toBe(true);
      expect(takeoverResult?.tokenVersion).toBe(1);
      expect(takeoverResult?.passwordHash).toBeUndefined(); // Dropped!
      expect(takeoverResult?.client_id).toBe("google-sub-race-123");

      // Password reset lost because local provider is gone:
      expect(resetResult).toBeNull();

      // Revoke all old sessions
      await revokeAllSessionsByUserId(userId, "google_takeover");
      const activeOld = await findActiveSessionById(oldSession._id);
      expect(activeOld).toBeNull(); // Old session revoked!
    }
  });
});
