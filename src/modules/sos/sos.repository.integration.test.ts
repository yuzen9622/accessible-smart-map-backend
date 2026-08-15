import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyHandlingUpdate,
  findActiveSessionByUser,
  findSessionById,
  insertSession,
  promoteToAcknowledged,
  pushAcknowledgement,
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
});
