import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import {
  findActiveSessionByShareToken,
  findLatestLocatedContact,
  releaseContactsForLineUser,
  updateBoundContactLocations,
} from "./line.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("line repository with real MongoDB", () => {
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

  it("writes shared contact locations and reads the latest one back", async () => {
    await EmergencyContact.create({
      userId: "line-owner",
      name: "Bound contact",
      lineUserId: "line-sharer",
      bindStatus: "bound",
      bindCode: "bound-code",
    });
    await EmergencyContact.create({
      userId: "line-owner",
      name: "Pending contact",
      lineUserId: "line-sharer",
      bindStatus: "pending",
      bindCode: "pending-code",
    });

    await updateBoundContactLocations("line-sharer", 25.034, 121.566);
    await expect(findLatestLocatedContact("line-owner")).resolves.toMatchObject(
      {
        lastLineLat: 25.034,
        lastLineLng: 121.566,
      },
    );

    await releaseContactsForLineUser("line-sharer");
    const contacts = await EmergencyContact.find({ userId: "line-owner" })
      .sort({ name: 1 })
      .lean();
    expect(contacts).toHaveLength(2);
    expect(contacts.every((contact) => contact.bindStatus === "pending")).toBe(
      true,
    );
  });

  it("reads an active session by its public share token", async () => {
    await SosSession.create({
      userId: "line-owner",
      type: "share_location",
      status: "active",
      handlingStatus: "notified",
      lat: 25.033,
      lng: 121.565,
      shareToken: "line-public-share-token",
      locationUpdatedAt: new Date(),
      acknowledgements: [],
      timeline: [],
    });

    await expect(
      findActiveSessionByShareToken("line-public-share-token"),
    ).resolves.toMatchObject({
      userId: "line-owner",
      status: "active",
    });
  });
});
