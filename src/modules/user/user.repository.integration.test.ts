import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Config from "../../model/config.model";
import LineLinkCode from "../../model/line-link-code.model";
import User from "../../model/user.model";
import {
  findConfigByUserId,
  findUserById,
  lineLinkCodeExists,
  updateConfigByUserId,
  upsertConfigByUserId,
  upsertLineLinkCode,
} from "./user.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("user repository with real MongoDB", () => {
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

  it("upserts a config and link code, then reads both mutations back", async () => {
    const userId = new Types.ObjectId().toString();
    await User.create({
      _id: userId,
      name: "Repository User",
      email: "repository-user@example.com",
      authProviders: ["local"],
      emailVerified: true,
    });

    const found = await findUserById(userId);
    expect(found).toMatchObject({ email: "repository-user@example.com" });
    expect(String(found?._id)).toBe(userId);
    const config = await upsertConfigByUserId(userId, {
      language: "en-US",
      fontSize: "large",
    });
    expect(config).toMatchObject({ language: "en-US", fontSize: "large" });
    await expect(findConfigByUserId(userId)).resolves.toMatchObject({
      language: "en-US",
      fontSize: "large",
    });

    await expect(
      updateConfigByUserId(userId, { language: "zh-TW" }),
    ).resolves.toMatchObject({ language: "zh-TW", fontSize: "large" });
    await expect(
      Config.findOne({ user_id: userId }).lean(),
    ).resolves.toMatchObject({
      language: "zh-TW",
      fontSize: "large",
    });

    const expiresAt = new Date(Date.now() + 60_000);
    await upsertLineLinkCode(userId, "line-code-1", expiresAt);
    await expect(lineLinkCodeExists("line-code-1")).resolves.toBe(true);
    await expect(
      LineLinkCode.findOne({ userId }).lean(),
    ).resolves.toMatchObject({
      userId,
      code: "line-code-1",
      expiresAt,
    });
  });
});
