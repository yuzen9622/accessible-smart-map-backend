import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import UserMemory from "../../model/user-memory.model";
import User from "../../model/user.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import {
  countActiveMemories,
  findActiveMemories,
  findActiveMemoryById,
  findMemoryEnabled,
  insertMemory,
  setMemoryEnabled,
  softDeleteActiveMemory,
} from "./memory.repository";

describe("memory repository with real MongoDB", () => {
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

  it("round-trips the opt-in flag and soft-deletes a memory", async () => {
    const userId = new Types.ObjectId().toString();
    await User.create({
      _id: userId,
      name: "Memory User",
      email: "memory@example.com",
      authProviders: ["local"],
      emailVerified: true,
    });

    await expect(findMemoryEnabled(userId)).resolves.toBe(false);
    await expect(setMemoryEnabled(userId, true)).resolves.toBe(true);
    await expect(findMemoryEnabled(userId)).resolves.toBe(true);

    const memoryId = await insertMemory({
      userId,
      content: "wheelchair route preference",
      promptText: "The user prefers a step-free route.",
      retrievalText: "step-free route",
      category: "preference",
      sensitivity: "low",
      source: "explicit_user",
    });

    const active = await findActiveMemories(userId, 10);
    expect(active).toHaveLength(1);
    expect(active[0]?.retrievalText).toBe("step-free route");
    await expect(findActiveMemoryById(userId, memoryId)).resolves.toMatchObject(
      {
        _id: expect.anything(),
        userId,
      },
    );
    await expect(countActiveMemories(userId)).resolves.toBe(1);

    await expect(softDeleteActiveMemory(userId, memoryId)).resolves.toBe(true);
    await expect(findActiveMemoryById(userId, memoryId)).resolves.toBeNull();
    await expect(countActiveMemories(userId)).resolves.toBe(0);

    const persisted = await UserMemory.findById(memoryId).lean();
    expect(persisted?.deletedAt).toBeInstanceOf(Date);
  });
});
