import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import AuthToken from "../../model/auth-token.model";
import Config from "../../model/config.model";
import User from "../../model/user.model";
import {
  consumeAuthTokenRecord,
  ensureConfigForUser,
  emailExists,
  findUserByEmail,
  insertUser,
  updateUserById,
  upsertAuthToken,
} from "./user.auth.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("user auth repository with real MongoDB", () => {
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

  it("upserts and consumes a one-time token, then persists user/config mutations", async () => {
    const user = await insertUser({
      _id: new Types.ObjectId().toString(),
      name: "Auth User",
      email: "auth-repository@example.com",
      passwordHash: "old-hash",
      authProviders: ["local"],
      emailVerified: false,
      tokenVersion: 0,
    });
    const userId = String(user._id);
    const expiresAt = new Date(Date.now() + 60_000);

    await upsertAuthToken(userId, "email_verify", "auth-token-hash", expiresAt);
    await expect(
      AuthToken.findOne({ userId, type: "email_verify" }).lean(),
    ).resolves.toMatchObject({
      userId,
      tokenHash: "auth-token-hash",
      usedAt: null,
    });
    await expect(
      consumeAuthTokenRecord("auth-token-hash", "email_verify"),
    ).resolves.toEqual({ userId });
    await expect(
      consumeAuthTokenRecord("auth-token-hash", "email_verify"),
    ).resolves.toBeNull();

    const config = await ensureConfigForUser(userId);
    expect(config).toBeTruthy();
    await expect(
      Config.findOne({ user_id: userId }).lean(),
    ).resolves.toMatchObject({
      user_id: expect.anything(),
      language: "zh-TW",
    });

    await expect(emailExists("auth-repository@example.com")).resolves.toBe(
      true,
    );
    await expect(
      findUserByEmail("auth-repository@example.com"),
    ).resolves.toMatchObject({
      name: "Auth User",
    });

    await expect(
      updateUserById(userId, { name: "Updated Auth User" }, ["passwordHash"]),
    ).resolves.toMatchObject({ name: "Updated Auth User" });
    await expect(User.findById(userId).lean()).resolves.toMatchObject({
      name: "Updated Auth User",
    });
    const persisted = await User.findById(userId)
      .select("+passwordHash")
      .lean();
    expect(persisted).not.toHaveProperty("passwordHash");
  });
});
