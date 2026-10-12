import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import User from "../../model/user.model";
import LineLinkCode from "../../model/line-link-code.model";
import * as service from "./user.service";
import { LINE_MSG } from "../../constants/messages";
import * as repository from "./user.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

vi.mock("../../adapters/line.adapter", () => ({
  buildBindUrl: () => "https://example.test/bind",
}));

describe("LINE account code binding with real standalone MongoDB", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  beforeEach(async () => {
    await Promise.all([User.createIndexes(), LineLinkCode.createIndexes()]);
    const indexes = await User.collection.indexes();
    expect(indexes.find((i) => i.key.lineUserId === 1)).toMatchObject({
      unique: true,
      partialFilterExpression: { lineUserId: { $type: "string" } },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });
  async function issue(code = "ABC123", lineUserId?: string) {
    const user = await User.create({
      name: code,
      email: `${code}@example.test`,
      ...(lineUserId ? { lineUserId } : {}),
    });
    await LineLinkCode.create({
      userId: String(user._id),
      code,
      expiresAt: new Date(Date.now() + 60000),
    });
    return user;
  }

  it("normalizes and redeems once, preserving the legacy success fields", async () => {
    const user = await issue();
    expect(await service.hasUsableLineAccountCode(" abc123 ")).toBe(true);
    expect(await service.bindLineAccountCode(" abc123 ", "line-a")).toEqual({
      ok: true,
      bound: true,
      userId: String(user._id),
      userName: "ABC123",
      bindUrl: "https://example.test/bind",
    });
    expect((await User.findById(user._id))?.lineUserId).toBe("line-a");
    expect(await LineLinkCode.countDocuments()).toBe(0);
    expect(await service.hasUsableLineAccountCode("ABC123")).toBe(false);
    expect(await service.bindLineAccountCode("ABC123", "line-b")).toEqual({
      ok: false,
      errorCode: "NO_LINE_BIND_CODE",
      error: "找不到可用的 LINE 帳號綁定碼",
    });
  });

  it("allows only one different LINE user to redeem the same code", async () => {
    const user = await issue();
    const results = await Promise.all([
      service.bindLineAccountCode("ABC123", "line-a"),
      service.bindLineAccountCode("ABC123", "line-b"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await User.findById(user._id))?.lineUserId).toBe(
      results[0].ok ? "line-a" : "line-b",
    );
  });

  it("does not doublebind the same LINE to different users under concurrent redemption", async () => {
    await issue("ABC123");
    await issue("DEF456");
    const real = repository.bindUserToLineConditionally;
    let arrivals = 0;
    let release!: () => void;
    const bothConsumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(repository, "bindUserToLineConditionally").mockImplementation(
      async (...args) => {
        if (++arrivals === 2) release();
        await bothConsumed;
        return real(...args);
      },
    );
    const results = await Promise.all([
      service.bindLineAccountCode("ABC123", "line-a"),
      service.bindLineAccountCode("DEF456", "line-a"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      error: "這個 LINE 帳號已綁定其他使用者",
    });
    expect(await User.countDocuments({ lineUserId: "line-a" })).toBe(1);
    expect(arrivals).toBe(2);
    expect(await LineLinkCode.countDocuments()).toBe(0);
  });

  it("preserves existing bindings, returns both conflict errors and permits the same binding", async () => {
    const user = await issue("ABC123", "original");
    expect(await service.bindLineAccountCode("ABC123", "line-a")).toEqual({
      ok: false,
      error: "這個使用者已綁定其他 LINE 帳號",
    });
    expect(await LineLinkCode.countDocuments({ code: "ABC123" })).toBe(1);
    expect((await User.findById(user._id))?.lineUserId).toBe("original");
    await issue("DEF456");
    expect(await service.bindLineAccountCode("DEF456", "original")).toEqual({
      ok: false,
      error: "這個 LINE 帳號已綁定其他使用者",
    });
    expect((await service.bindLineAccountCode("ABC123", "original")).ok).toBe(
      true,
    );
  });

  it("rejects expired, invalid, unknown codes, missing identity and missing users", async () => {
    const user = await issue();
    await LineLinkCode.updateOne(
      { code: "ABC123" },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    for (const code of ["ABC123", "ZZZ999", "bad!"]) {
      expect(await service.hasUsableLineAccountCode(code)).toBe(false);
      expect((await service.bindLineAccountCode(code, "line-a")).ok).toBe(
        false,
      );
    }
    expect(await service.bindLineAccountCode("ABC123")).toEqual({
      ok: false,
      error: "缺少 LINE 使用者資訊",
    });
    expect((await User.findById(user._id))?.lineUserId).toBeNull();
    await LineLinkCode.updateOne(
      { code: "ABC123" },
      { $set: { expiresAt: new Date(Date.now() + 60000) } },
    );
    await User.deleteOne({ _id: user._id });
    expect(await service.bindLineAccountCode("ABC123", "line-a")).toEqual({
      ok: false,
      error: "找不到對應的使用者",
    });
  });

  it("does not consume a code reissued after the initial read", async () => {
    const user = await issue();
    const real = repository.consumeLineAccountCode;
    vi.spyOn(repository, "consumeLineAccountCode").mockImplementationOnce(
      async (...args) => {
        await repository.upsertLineLinkCode(
          String(user._id),
          "NEW123",
          new Date(Date.now() + 60000),
        );
        return real(...args);
      },
    );
    expect(await service.bindLineAccountCode("ABC123", "line-a")).toEqual({
      ok: false,
      errorCode: "NO_LINE_BIND_CODE",
      error: "找不到可用的 LINE 帳號綁定碼",
    });
    expect(
      await LineLinkCode.findOne({ userId: String(user._id) }).lean(),
    ).toMatchObject({ code: "NEW123" });
    expect((await User.findById(user._id))?.lineUserId).toBeNull();
  });

  it("guards a user binding changed between precheck and conditional write", async () => {
    const user = await issue();
    const real = repository.bindUserToLineConditionally;
    vi.spyOn(repository, "bindUserToLineConditionally").mockImplementationOnce(
      async (...args) => {
        await User.updateOne(
          { _id: user._id },
          { $set: { lineUserId: "concurrent-other" } },
        );
        return real(...args);
      },
    );
    expect(await service.bindLineAccountCode("ABC123", "line-a")).toEqual({
      ok: false,
      error: "這個使用者已綁定其他 LINE 帳號",
    });
    expect((await User.findById(user._id))?.lineUserId).toBe(
      "concurrent-other",
    );
    expect(await LineLinkCode.countDocuments()).toBe(0);
  });

  it("propagates query errors and does not restore consumed codes over concurrently reissued codes", async () => {
    vi.spyOn(repository, "usableLineAccountCodeExists").mockRejectedValueOnce(
      new Error("lookup unavailable"),
    );
    await expect(service.hasUsableLineAccountCode("ABC123")).rejects.toThrow(
      "lookup unavailable",
    );
    const user = await issue();
    vi.spyOn(repository, "bindUserToLineConditionally").mockImplementationOnce(
      async () => {
        await repository.upsertLineLinkCode(
          String(user._id),
          "NEW123",
          new Date(Date.now() + 60000),
        );
        throw new Error("write unavailable");
      },
    );
    expect(await service.bindLineAccountCode("ABC123", "line-a")).toEqual({
      ok: false,
      errorCode: "BIND_OUTCOME_UNCONFIRMED",
      error: LINE_MSG.BIND_UNCONFIRMED,
    });
    expect(
      await LineLinkCode.findOne({ userId: String(user._id) }).lean(),
    ).toMatchObject({ code: "NEW123" });
    expect((await User.findById(user._id))?.lineUserId).toBeNull();
  });

  it("does not misreport success or claim no write when the user update response is lost", async () => {
    const user = await issue();
    const real = repository.bindUserToLineConditionally;
    vi.spyOn(repository, "bindUserToLineConditionally").mockImplementationOnce(
      async (...args) => {
        await real(...args);
        throw new Error("response lost");
      },
    );
    expect(await service.bindLineAccountCode("ABC123", "line-a")).toEqual({
      ok: false,
      errorCode: "BIND_OUTCOME_UNCONFIRMED",
      error: LINE_MSG.BIND_UNCONFIRMED,
    });
    expect((await User.findById(user._id))?.lineUserId).toBe("line-a");
    expect(await LineLinkCode.countDocuments()).toBe(0);
  });
});
