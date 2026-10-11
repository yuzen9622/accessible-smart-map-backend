import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  deletePushTokenForUser,
  deletePushTokens,
  ensureRegistrationVersion,
  findPushTokensByUserId,
  upsertPushToken,
} from "./user.push-token.repository";
import PushToken from "../../model/push-token.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const TOKEN = "ExponentPushToken[device-1]";

describe("push token repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
    await PushToken.init();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("moves a device's token to whoever registered it last", async () => {
    await upsertPushToken({
      token: TOKEN,
      userId: "alice",
      authSessionId: "s-alice",
      platform: "ios",
      locale: "zh-TW",
    });
    const stored = await upsertPushToken({
      token: TOKEN,
      userId: "bob",
      authSessionId: "s-bob",
      platform: "ios",
      locale: "en",
    });

    expect(stored).toMatchObject({ userId: "bob", locale: "en" });
    expect(await findPushTokensByUserId("alice")).toHaveLength(0);
    expect(await findPushTokensByUserId("bob")).toHaveLength(1);
  });

  it("survives concurrent first registrations of the same token", async () => {
    const fields = {
      token: TOKEN,
      userId: "alice",
      authSessionId: "s-alice",
      platform: "android" as const,
      locale: "zh-TW",
    };

    await Promise.all([upsertPushToken(fields), upsertPushToken(fields)]);

    expect(await PushToken.countDocuments({ token: TOKEN })).toBe(1);
  });

  it("only lets the owner delete a token, and bulk-deletes by value", async () => {
    await upsertPushToken({
      token: TOKEN,
      userId: "alice",
      authSessionId: "s-alice",
      platform: "ios",
      locale: "zh-TW",
    });

    expect(await deletePushTokenForUser("mallory", TOKEN)).toBe(false);
    expect(await deletePushTokenForUser("alice", TOKEN)).toBe(true);
    expect(await deletePushTokenForUser("alice", TOKEN)).toBe(false);

    await upsertPushToken({
      token: TOKEN,
      userId: "alice",
      authSessionId: "s-alice",
      platform: "ios",
      locale: "zh-TW",
    });
    const [current] = await findPushTokensByUserId("alice");
    expect(
      await deletePushTokens([
        current,
        { token: "ExponentPushToken[none]", authSessionId: "s-alice" },
      ]),
    ).toBe(1);
    expect(await deletePushTokens([])).toBe(0);
  });

  it("keeps a token that was re-registered under a new session before cleanup", async () => {
    await upsertPushToken({
      token: TOKEN,
      userId: "bob",
      authSessionId: "s-new",
      platform: "ios",
      locale: "zh-TW",
    });

    expect(
      await deletePushTokens([{ token: TOKEN, authSessionId: "s-old" }]),
    ).toBe(0);
    expect(await findPushTokensByUserId("bob")).toHaveLength(1);
  });

  it("a stale snapshot cannot delete a re-registration, with or without a version", async () => {
    const fields = {
      token: TOKEN,
      userId: "alice",
      authSessionId: "s-alice",
      platform: "ios" as const,
      locale: "zh-TW",
    };
    const first = await upsertPushToken(fields);
    const second = await upsertPushToken(fields);
    expect(second.registrationVersion).not.toBe(first.registrationVersion);
    expect(await deletePushTokens([first])).toBe(0);

    // Legacy snapshot (no version) vs. a fresh registration that has one.
    const legacySnapshot = { token: TOKEN, authSessionId: "s-alice" };
    expect(await deletePushTokens([legacySnapshot])).toBe(0);
    expect(await deletePushTokens([second])).toBe(1);

    // A genuinely unversioned row is deleted by its unversioned snapshot.
    await upsertPushToken(fields);
    await PushToken.collection.updateOne(
      { token: TOKEN },
      { $unset: { registrationVersion: "" } },
    );
    expect(await deletePushTokens([legacySnapshot])).toBe(1);
  });

  it("legacy version assignment never adopts a concurrent different generation", async () => {
    const fields = {
      token: TOKEN,
      userId: "alice",
      authSessionId: "s-alice",
      platform: "ios" as const,
      locale: "zh-TW",
    };
    const stored = await upsertPushToken(fields);
    await PushToken.collection.updateOne(
      { token: TOKEN },
      { $unset: { registrationVersion: "" } },
    );
    const snapshot = { ...stored, registrationVersion: undefined };
    // Rebind to another owner/session before the stale snapshot is fenced.
    await upsertPushToken({ ...fields, userId: "bob", authSessionId: "s-bob" });
    expect(await ensureRegistrationVersion(snapshot)).toBeNull();
    // The unchanged legacy row does receive a stable version.
    await PushToken.collection.updateOne(
      { token: TOKEN },
      { $unset: { registrationVersion: "" } },
    );
    const bob = (await PushToken.findOne({ token: TOKEN }).lean())!;
    const version = await ensureRegistrationVersion({
      ...bob,
      registrationVersion: undefined,
    });
    expect(version).toBeTruthy();
    expect(
      await ensureRegistrationVersion({
        ...bob,
        registrationVersion: undefined,
      }),
    ).toBe(version);
  });
});
