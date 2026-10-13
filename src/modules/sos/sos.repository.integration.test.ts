import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyHandlingUpdate,
  findActiveSessionByUser,
  findSessionById,
  insertSession,
  promoteToAcknowledged,
  pushAcknowledgement,
  recordSessionViewer,
  replaceShareToken,
  resolveActiveSession,
} from "./sos.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("sos repository with real MongoDB", () => {
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

  it("records an acknowledgement once, updates handling state and resolves the session", async () => {
    const created = await insertSession({
      userId: "sos-owner",
      type: "body",
      status: "active",
      handlingStatus: "notified",
      lat: 25.033,
      lng: 121.565,
      shareToken: "sos-share-token",
      locationUpdatedAt: new Date(),
      acknowledgements: [],
      timeline: [],
    });
    const sessionId = String(created._id);
    const acknowledgedAt = new Date();

    const acknowledgement = {
      lineUserId: "line-contact",
      name: "Contact",
      at: acknowledgedAt,
    };
    const timelineEntry = {
      type: "acknowledged",
      actorType: "contact",
      actorLineUserId: "line-contact",
      actorName: "Contact",
      at: acknowledgedAt,
    };
    await expect(
      pushAcknowledgement(
        sessionId,
        "line-contact",
        acknowledgement,
        timelineEntry,
      ),
    ).resolves.toBe(true);
    await expect(
      pushAcknowledgement(
        sessionId,
        "line-contact",
        acknowledgement,
        timelineEntry,
      ),
    ).resolves.toBe(false);

    await promoteToAcknowledged(sessionId);
    await expect(
      applyHandlingUpdate(sessionId, {
        $set: { handlingStatus: "en_route", claimedBy: "responder-1" },
        $push: {
          timeline: {
            type: "status_update",
            actorType: "system",
            note: "Responder dispatched",
            at: new Date(),
          },
        },
      }),
    ).resolves.toMatchObject({ handlingStatus: "en_route" });

    await expect(
      resolveActiveSession(
        sessionId,
        {
          status: "resolved",
          resolvedAt: new Date(),
          handlingStatus: "resolved",
        },
        { type: "resolved", actorType: "system", at: new Date() },
      ),
    ).resolves.toBe(true);
    await expect(resolveActiveSession(sessionId, {}, {})).resolves.toBe(false);

    await expect(findActiveSessionByUser("sos-owner")).resolves.toBeNull();
    const persisted = await findSessionById(sessionId);
    expect(persisted).toMatchObject({
      userId: "sos-owner",
      status: "resolved",
      handlingStatus: "resolved",
      acknowledgements: [{ lineUserId: "line-contact" }],
    });
    expect(persisted?.timeline).toHaveLength(3);
  });

  async function activeSession(extra: Record<string, unknown> = {}) {
    const created = await insertSession({
      userId: "sos-owner",
      type: "share_location",
      status: "active",
      handlingStatus: "notified",
      lat: 25.033,
      lng: 121.565,
      shareToken: "a".repeat(32),
      locationUpdatedAt: new Date(),
      acknowledgements: [],
      timeline: [],
      ...extra,
    });
    return String(created._id);
  }

  it("adds each reader once and refreshes only after the interval", async () => {
    const sessionId = await activeSession();
    const opts = { refreshMs: 60_000, maxEntries: 3 };
    const t0 = new Date("2026-10-13T00:00:00Z");
    const reader = "k1";

    expect(await recordSessionViewer(sessionId, reader, t0, opts)).toBe(true);
    const soon = new Date(t0.getTime() + 10_000);
    expect(await recordSessionViewer(sessionId, reader, soon, opts)).toBe(
      false,
    );
    const later = new Date(t0.getTime() + 61_000);
    expect(await recordSessionViewer(sessionId, reader, later, opts)).toBe(
      true,
    );

    const stored = await findSessionById(sessionId);
    expect(stored?.viewers).toHaveLength(1);
    expect(stored?.viewers?.[0]).toMatchObject({
      key: "k1",
      firstSeenAt: t0,
      lastSeenAt: later,
    });
  });

  it("stops adding devices at the cap and ignores resolved sessions", async () => {
    const sessionId = await activeSession();
    const opts = { refreshMs: 60_000, maxEntries: 3 };
    for (const key of ["k1", "k2", "k3", "k4"]) {
      await recordSessionViewer(sessionId, key, new Date(), opts);
    }
    const capped = await findSessionById(sessionId);
    // Nothing is evicted; the fourth device is simply not recorded.
    expect(capped?.viewers?.map((v) => v.key)).toEqual(["k1", "k2", "k3"]);

    await resolveActiveSession(
      sessionId,
      { status: "resolved", resolvedAt: new Date() },
      { type: "resolved", actorType: "victim", at: new Date() },
    );
    expect(await recordSessionViewer(sessionId, "k9", new Date(), opts)).toBe(
      false,
    );
  });

  it("rotating the share token clears recorded viewers", async () => {
    const now = new Date();
    const sessionId = await activeSession({
      viewers: [{ key: "k1", firstSeenAt: now, lastSeenAt: now }],
      initialNotice: {
        status: "queued",
        recipients: ["U1"],
        payload: { type: "share_location", trackingUrl: "old-url" },
        retryKey: "rk",
        attempts: 0,
        nextAttemptAt: now,
        retryUntil: new Date(now.getTime() + 60_000),
        notifiedCount: 0,
      },
    });

    const updated = await replaceShareToken(
      sessionId,
      "b".repeat(32),
      "new-url",
    );

    expect(updated?.shareToken).toBe("b".repeat(32));
    expect(updated?.viewers).toEqual([]);
    const stored = await findSessionById(sessionId);
    expect(stored?.initialNotice?.payload.trackingUrl).toBe("new-url");
  });

  it("does not rotate a resolved session", async () => {
    const sessionId = await activeSession({
      status: "resolved",
      resolvedAt: new Date(),
    });
    expect(
      await replaceShareToken(sessionId, "b".repeat(32), "new-url"),
    ).toBeNull();
    const stored = await findSessionById(sessionId);
    expect(stored?.shareToken).toBe("a".repeat(32));
  });
});
