import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import AuthToken from "../../model/auth-token.model";
import Config from "../../model/config.model";
import User from "../../model/user.model";
import {
  atomicAppleTakeover,
  atomicLinkApple,
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

  describe("apple auth repository operations", () => {
    it("allows multiple users with null appleUserId but enforces unique string appleUserId", async () => {
      await User.syncIndexes();

      const user1 = await insertUser({
        name: "Null Apple 1",
        email: "null1@example.com",
        appleUserId: null,
      });
      const user2 = await insertUser({
        name: "Null Apple 2",
        email: "null2@example.com",
        appleUserId: null,
      });

      expect(user1._id).toBeTruthy();
      expect(user2._id).toBeTruthy();

      await insertUser({
        name: "Apple User A",
        email: "apple-a@example.com",
        appleUserId: "shared-apple-sub",
      });

      await expect(
        insertUser({
          name: "Apple User B",
          email: "apple-b@example.com",
          appleUserId: "shared-apple-sub",
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it("atomicLinkApple preserves client_id and adds apple provider alongside google", async () => {
      await User.syncIndexes();

      const user = await insertUser({
        name: "Google and Apple User",
        email: "both@example.com",
        client_id: "google-sub-xyz",
        authProviders: ["google"],
        emailVerified: true,
        tokenVersion: 1,
      });
      const userId = String(user._id);

      const linked = await atomicLinkApple({
        userId,
        expectedTokenVersion: 1,
        appleUserId: "apple-sub-xyz",
      });

      expect(linked).toBeTruthy();
      expect(linked?.appleUserId).toBe("apple-sub-xyz");
      expect(linked?.client_id).toBe("google-sub-xyz");
      expect(linked?.authProviders).toContain("google");
      expect(linked?.authProviders).toContain("apple");

      const unselected = await User.findById(userId).lean();
      expect(unselected).not.toHaveProperty("appleUserId");

      const refreshed = await User.findById(userId)
        .select("+appleUserId")
        .lean();
      expect(refreshed?.client_id).toBe("google-sub-xyz");
      expect(refreshed?.appleUserId).toBe("apple-sub-xyz");
      expect(refreshed?.authProviders).toEqual(
        expect.arrayContaining(["google", "apple"]),
      );
    });

    it("atomicLinkApple returns null and preserves document when user is already bound to another appleUserId", async () => {
      await User.syncIndexes();

      const user = await insertUser({
        name: "Already Bound",
        email: "bound-apple@example.com",
        appleUserId: "original-apple-sub",
        authProviders: ["apple"],
        emailVerified: true,
        tokenVersion: 2,
      });
      const userId = String(user._id);

      const result = await atomicLinkApple({
        userId,
        expectedTokenVersion: 2,
        appleUserId: "attacker-apple-sub",
      });

      expect(result).toBeNull();
      const unchanged = await User.findById(userId)
        .select("+appleUserId")
        .lean();
      expect(unchanged?.appleUserId).toBe("original-apple-sub");
    });

    it("atomicAppleTakeover removes passwordHash and increments tokenVersion on success, returns null on tokenVersion mismatch", async () => {
      await User.syncIndexes();

      const user = await insertUser({
        name: "Takeover Candidate",
        email: "takeover-apple@example.com",
        passwordHash: "unverified-hash",
        emailVerified: false,
        tokenVersion: 3,
        authProviders: ["local"],
      });
      const userId = String(user._id);

      // Loser on wrong tokenVersion
      const loser = await atomicAppleTakeover({
        userId,
        expectedTokenVersion: 999,
        expectedPasswordHash: "unverified-hash",
        appleUserId: "apple-sub-win",
        authProviders: ["apple"],
      });
      expect(loser).toBeNull();

      // Winner on matching tokenVersion and credentials
      const winner = await atomicAppleTakeover({
        userId,
        expectedTokenVersion: 3,
        expectedPasswordHash: "unverified-hash",
        appleUserId: "apple-sub-win",
        authProviders: ["apple"],
      });
      expect(winner).toBeTruthy();
      expect(winner?.tokenVersion).toBe(4);
      expect(winner?.emailVerified).toBe(true);
      expect(winner?.appleUserId).toBe("apple-sub-win");
      expect(winner?.authProviders).toEqual(["apple"]);

      const persisted = await User.findById(userId)
        .select("+passwordHash")
        .lean();
      expect(persisted).not.toHaveProperty("passwordHash");
      expect(persisted?.tokenVersion).toBe(4);
    });
  });
});
