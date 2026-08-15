import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bindCodeExists,
  countContactsByUser,
  deleteContactById,
  findContactById,
  findContactsByUser,
  insertContact,
} from "./emergency-contact.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("emergency-contact repository with real MongoDB", () => {
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

  it("inserts, lists, counts, reads back and deletes an owned contact", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const contact = await insertContact({
      userId: "owner-emergency",
      name: "Primary contact",
      bindStatus: "pending",
      bindCode: "bind-primary",
      bindCodeExpiresAt: expiresAt,
    });

    expect(contact.name).toBe("Primary contact");
    expect(await bindCodeExists("bind-primary")).toBe(true);
    expect(await countContactsByUser("owner-emergency")).toBe(1);

    const listed = await findContactsByUser("owner-emergency");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      _id: contact._id,
      name: "Primary contact",
      bindStatus: "pending",
    });

    await expect(findContactById(contact._id)).resolves.toMatchObject({
      _id: contact._id,
      userId: "owner-emergency",
    });
    await deleteContactById(contact._id);
    await expect(findContactById(contact._id)).resolves.toBeNull();
    await expect(countContactsByUser("owner-emergency")).resolves.toBe(0);
  });
});
