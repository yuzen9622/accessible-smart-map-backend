import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  findActiveSessionById,
  findActiveSessionsByUserId,
  findSessionById,
  revokeAllSessionsByUserId,
  revokeSession,
  rotateSession,
} from "./user.auth-session.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("user auth session repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  }, 120_000);

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

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("creates a session and retrieves it by id and active status", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-init-1",
      expiresAt,
    });

    expect(session).toBeDefined();
    expect(session._id).toBeDefined();
    expect(String(session.userId)).toBe(userId);
    expect(session.currentRefreshJti).toBe("jti-init-1");
    expect(session.previousRefreshJti).toBeNull();
    expect(session.revokedAt).toBeNull();

    const byId = await findSessionById(session._id);
    expect(byId).toMatchObject({
      _id: session._id,
      currentRefreshJti: "jti-init-1",
    });

    const active = await findActiveSessionById(session._id);
    expect(active).toMatchObject({
      _id: session._id,
      revokedAt: null,
    });
  });

  it("atomically rotates refresh token on CAS match (happy path)", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-v1",
      expiresAt,
    });

    const newExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const rotateResult = await rotateSession({
      sid: session._id,
      userId,
      oldJti: "jti-v1",
      newJti: "jti-v2",
      newExpiresAt,
    });

    expect(rotateResult.status).toBe("SUCCESS");
    if (rotateResult.status === "SUCCESS") {
      expect(rotateResult.session.currentRefreshJti).toBe("jti-v2");
      expect(rotateResult.session.previousRefreshJti).toBe("jti-v1");
      expect(rotateResult.session.recentRefreshJtis).toHaveLength(1);
      expect(rotateResult.session.recentRefreshJtis?.[0].jti).toBe("jti-v1");
    }
  });

  it("handles barrier-controlled concurrent R1/R1 race: winner rotates, loser enters grace period without revocation", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-common-0",
      expiresAt,
    });

    const barrier = createBarrier(2);

    const [res1, res2] = await Promise.all([
      (async () => {
        await barrier();
        return rotateSession({
          sid: session._id,
          userId,
          oldJti: "jti-common-0",
          newJti: "jti-winner-1",
          newExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          graceWindowMs: 30_000,
        });
      })(),
      (async () => {
        await barrier();
        return rotateSession({
          sid: session._id,
          userId,
          oldJti: "jti-common-0",
          newJti: "jti-loser-1",
          newExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          graceWindowMs: 30_000,
        });
      })(),
    ]);

    const results = [res1, res2];
    const successes = results.filter((r) => r.status === "SUCCESS");
    const graces = results.filter((r) => r.status === "GRACE_PERIOD");

    expect(successes).toHaveLength(1);
    expect(graces).toHaveLength(1);

    const winnerResult = successes[0];
    const loserResult = graces[0];

    expect(winnerResult.status).toBe("SUCCESS");
    expect(loserResult.status).toBe("GRACE_PERIOD");
    if (loserResult.status === "GRACE_PERIOD") {
      // Must NOT revoke the session!
      expect(loserResult.session.revokedAt).toBeNull();
    }

    // Verify session remains active in DB
    const active = await findActiveSessionById(session._id);
    expect(active).not.toBeNull();
    expect(active?.revokedAt).toBeNull();
  });

  it("handles barrier-controlled three-way R1/R1/R2 race without falsely revoking the legitimate session", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-0",
      expiresAt,
    });

    // 1. Two R1 concurrent requests race on J0 with a barrier
    const barrierR1 = createBarrier(2);
    const [r1a, r1b] = await Promise.all([
      (async () => {
        await barrierR1();
        return rotateSession({
          sid: session._id,
          userId,
          oldJti: "jti-0",
          newJti: "jti-1a",
          newExpiresAt: expiresAt,
          graceWindowMs: 30_000,
        });
      })(),
      (async () => {
        await barrierR1();
        return rotateSession({
          sid: session._id,
          userId,
          oldJti: "jti-0",
          newJti: "jti-1b",
          newExpiresAt: expiresAt,
          graceWindowMs: 30_000,
        });
      })(),
    ]);

    const r1Winner = r1a.status === "SUCCESS" ? r1a : r1b;
    const r1Loser = r1a.status === "SUCCESS" ? r1b : r1a;

    expect(r1Winner.status).toBe("SUCCESS");
    expect(r1Loser.status).toBe("GRACE_PERIOD");
    const winnerJti =
      r1Winner.status === "SUCCESS"
        ? r1Winner.session.currentRefreshJti
        : "jti-1a";

    // 2. R2 winner arrives immediately with winner's JTI and rotates it to J2
    // This overwrites previousRefreshJti. J0 is now ONLY in recentRefreshJtis!
    const r2Winner = await rotateSession({
      sid: session._id,
      userId,
      oldJti: winnerJti,
      newJti: "jti-2",
      newExpiresAt: expiresAt,
      graceWindowMs: 30_000,
    });
    expect(r2Winner.status).toBe("SUCCESS");

    // Verify DB state: current = J2, previous = winnerJti, recent has [J0, winnerJti]
    const currentDb = await findSessionById(session._id);
    expect(currentDb?.currentRefreshJti).toBe("jti-2");
    expect(currentDb?.previousRefreshJti).toBe(winnerJti);

    // 3. Another late R1 loser runs CAS with J0
    // If only previousRefreshJti was checked, this would fail and falsely revoke!
    // With recentRefreshJtis bounded grace history, J0 is recognized as a recent rotation.
    const lateR1 = await rotateSession({
      sid: session._id,
      userId,
      oldJti: "jti-0",
      newJti: "jti-loser-duplicate",
      newExpiresAt: expiresAt,
      graceWindowMs: 30_000,
    });

    expect(lateR1.status).toBe("GRACE_PERIOD");
    if (lateR1.status === "GRACE_PERIOD") {
      expect(lateR1.session.revokedAt).toBeNull();
    }

    // Verify session was NOT revoked in DB
    const activeSession = await findActiveSessionById(session._id);
    expect(activeSession).not.toBeNull();
    expect(activeSession?.revokedAt).toBeNull();
    expect(activeSession?.currentRefreshJti).toBe("jti-2");
  });

  it("detects truly stale token replay and conditionally revokes ONLY that active session", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-current",
      expiresAt,
    });

    // Replay with an unknown/stale JTI that is NOT in grace window
    const replayResult = await rotateSession({
      sid: session._id,
      userId,
      oldJti: "jti-stale-attacker-replay",
      newJti: "jti-new",
      newExpiresAt: expiresAt,
      graceWindowMs: 30_000,
    });

    expect(replayResult.status).toBe("REUSE_DETECTED");
    if (replayResult.status === "REUSE_DETECTED") {
      expect(replayResult.session.revokedAt).not.toBeNull();
      expect(replayResult.session.revokedReason).toBe("token_reuse_detected");
    }

    // Verify session is now revoked in DB
    const activeSession = await findActiveSessionById(session._id);
    expect(activeSession).toBeNull();

    // Subsequent rotation on revoked session returns REVOKED
    const subsequent = await rotateSession({
      sid: session._id,
      userId,
      oldJti: "jti-current",
      newJti: "jti-another",
      newExpiresAt: expiresAt,
    });
    expect(subsequent.status).toBe("REVOKED");
  });

  it("regression: more than 10 rapid rotations within 30s grace window retains all history and does not falsely revoke on early loser", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-rapid-0",
      expiresAt,
    });

    // Perform 15 consecutive rapid rotations within grace window (e.g. jti-0 -> jti-1 -> ... -> jti-15)
    // With previous $slice: -10, jti-rapid-0 through jti-rapid-4 were dropped, causing false revocation!
    for (let i = 0; i < 15; i++) {
      const rotate = await rotateSession({
        sid: session._id,
        userId,
        oldJti: `jti-rapid-${i}`,
        newJti: `jti-rapid-${i + 1}`,
        newExpiresAt: expiresAt,
        graceWindowMs: 30_000,
      });
      expect(rotate.status).toBe("SUCCESS");
    }

    // Now an early loser request presenting jti-rapid-0 (15 rotations ago, but within 30s) arrives:
    const earlyLoserResult = await rotateSession({
      sid: session._id,
      userId,
      oldJti: "jti-rapid-0",
      newJti: "jti-rapid-loser-retry",
      newExpiresAt: expiresAt,
      graceWindowMs: 30_000,
    });

    expect(earlyLoserResult.status).toBe("GRACE_PERIOD");
    if (earlyLoserResult.status === "GRACE_PERIOD") {
      expect(earlyLoserResult.session.revokedAt).toBeNull();
    }

    // Session MUST NOT be revoked
    const active = await findActiveSessionById(session._id);
    expect(active).not.toBeNull();
    expect(active?.revokedAt).toBeNull();
    expect(active?.currentRefreshJti).toBe("jti-rapid-15");
  });

  it("rejects rotation on expired session without mutating", async () => {
    const userId = new Types.ObjectId().toString();
    const expiredAt = new Date(Date.now() - 5_000);
    const session = await createSession({
      userId,
      currentRefreshJti: "jti-expired",
      expiresAt: expiredAt,
    });

    const result = await rotateSession({
      sid: session._id,
      userId,
      oldJti: "jti-expired",
      newJti: "jti-new",
      newExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(result.status).toBe("EXPIRED");
  });

  it("revokes a single session and leaves other user sessions active", async () => {
    const userId = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const session1 = await createSession({
      userId,
      currentRefreshJti: "jti-s1",
      expiresAt,
    });
    const session2 = await createSession({
      userId,
      currentRefreshJti: "jti-s2",
      expiresAt,
    });

    const revoked = await revokeSession(session1._id, userId, "user_logout");
    expect(revoked).toBe(true);

    expect(await findActiveSessionById(session1._id)).toBeNull();
    expect(await findActiveSessionById(session2._id)).not.toBeNull();

    // Revoking an already revoked session is idempotent / returns false (conditional revoke)
    const revokedAgain = await revokeSession(session1._id, userId, "repeat");
    expect(revokedAgain).toBe(false);
  });

  it("revokes all active sessions for a specific user without affecting other users", async () => {
    const userA = new Types.ObjectId().toString();
    const userB = new Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const sA1 = await createSession({
      userId: userA,
      currentRefreshJti: "a1",
      expiresAt,
    });
    const sA2 = await createSession({
      userId: userA,
      currentRefreshJti: "a2",
      expiresAt,
    });
    const sB1 = await createSession({
      userId: userB,
      currentRefreshJti: "b1",
      expiresAt,
    });

    const count = await revokeAllSessionsByUserId(userA, "password_reset");
    expect(count).toBe(2);

    expect(await findActiveSessionById(sA1._id)).toBeNull();
    expect(await findActiveSessionById(sA2._id)).toBeNull();
    expect(await findActiveSessionById(sB1._id)).not.toBeNull();

    const activeA = await findActiveSessionsByUserId(userA);
    expect(activeA).toHaveLength(0);

    const activeB = await findActiveSessionsByUserId(userB);
    expect(activeB).toHaveLength(1);
  });

  it("safely handles invalid object ids without throwing", async () => {
    expect(await findSessionById("invalid-id")).toBeNull();
    expect(await findActiveSessionById("invalid-id")).toBeNull();
    expect(await revokeSession("invalid-sid", "invalid-uid")).toBe(false);
    expect(await revokeAllSessionsByUserId("invalid-uid")).toBe(0);
    expect(await findActiveSessionsByUserId("invalid-uid")).toEqual([]);

    const rotateResult = await rotateSession({
      sid: "not-an-objectid",
      userId: "also-not",
      oldJti: "jti",
      newJti: "jti-new",
      newExpiresAt: new Date(),
    });
    expect(rotateResult.status).toBe("NOT_FOUND");
  });
});
