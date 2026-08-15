import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import {
  findBoundContacts,
  findSosHistory,
  renameBoundContact,
} from "./line-menu.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("line-menu repository with real MongoDB", () => {
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

  it("renames and reads bound contacts and projects SOS history", async () => {
    const contact = await EmergencyContact.create({
      userId: "owner-line-menu",
      name: "Old name",
      lineUserId: "line-menu-user",
      bindStatus: "bound",
    });
    await SosSession.create({
      userId: "owner-line-menu",
      type: "body",
      status: "resolved",
      handlingStatus: "resolved",
      lat: 25.033,
      lng: 121.565,
      address: "Taipei",
      shareToken: "line-menu-share-token",
      locationUpdatedAt: new Date(),
      resolvedAt: new Date(),
      acknowledgements: [],
      timeline: [],
    });

    await expect(
      renameBoundContact(String(contact._id), "line-menu-user", "New name"),
    ).resolves.toBe(true);
    const bound = await findBoundContacts("line-menu-user");
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      _id: contact._id,
      userId: "owner-line-menu",
      name: "New name",
    });

    const history = await findSosHistory(
      "owner-line-menu",
      ["owner-line-menu"],
      10,
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      userId: "owner-line-menu",
      type: "body",
      status: "resolved",
      handlingStatus: "resolved",
    });
  });
});
