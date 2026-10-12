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
import EmergencyContact from "../../model/emergency-contact.model";
import * as service from "./emergency-contact.service";
import { LINE_MSG } from "../../constants/messages";
import * as repository from "./emergency-contact.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

vi.mock("../../adapters/line.adapter", () => ({
  buildBindUrl: () => "https://example.test/bind",
}));

describe("emergency contact code binding with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  beforeEach(async () => {
    await EmergencyContact.createIndexes();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });
  const pending = (code = "ABC123", expiresAt = new Date(Date.now() + 60000)) =>
    EmergencyContact.create({
      userId: "owner",
      name: "Friend",
      bindCode: code,
      bindCodeExpiresAt: expiresAt,
    });

  it("normalizes input, permits another friend binding, and atomically clears code fields", async () => {
    const old = await EmergencyContact.create({
      userId: "other-owner",
      name: "Old",
      bindStatus: "bound",
      lineUserId: "line-a",
      bindCode: "OLD123",
    });
    const contact = await pending();
    expect(await service.hasUsableEmergencyContactCode(" abc123 ")).toBe(true);
    expect(
      await service.bindEmergencyContactCode(" abc123 ", "line-a"),
    ).toEqual({
      ok: true,
      bound: true,
      contactId: String(contact._id),
      contactName: "Friend",
    });
    const stored = await EmergencyContact.findById(contact._id).lean();
    expect(stored).toMatchObject({ bindStatus: "bound", lineUserId: "line-a" });
    expect(stored).not.toHaveProperty("bindCode");
    expect(stored).not.toHaveProperty("bindCodeExpiresAt");
    expect(await EmergencyContact.findById(old._id).lean()).toMatchObject({
      lineUserId: "line-a",
      bindCode: "OLD123",
    });
    expect(await service.hasUsableEmergencyContactCode("ABC123")).toBe(false);
  });

  it("allows only one of two different LINE users to redeem the same code", async () => {
    const contact = await pending();
    const results = await Promise.all([
      service.bindEmergencyContactCode("ABC123", "line-a"),
      service.bindEmergencyContactCode("ABC123", "line-b"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      {
        ok: false,
        errorCode: "NO_EMERGENCY_BIND_CODE",
        error: "找不到可用的緊急聯絡人綁定碼",
      },
    ]);
    expect((await EmergencyContact.findById(contact._id))?.lineUserId).toBe(
      results[0].ok ? "line-a" : "line-b",
    );
  });

  it("rejects expired, bound, malformed, unknown codes and missing identity without mutations", async () => {
    const contact = await pending("ABC123", new Date(Date.now() - 1000));
    for (const code of ["ABC123", "ZZZ999", "bad!"]) {
      expect(await service.hasUsableEmergencyContactCode(code)).toBe(false);
      expect((await service.bindEmergencyContactCode(code, "line-a")).ok).toBe(
        false,
      );
    }
    expect(await service.bindEmergencyContactCode("ABC123")).toEqual({
      ok: false,
      error: "缺少 LINE 使用者資訊",
    });
    await EmergencyContact.updateOne(
      { _id: contact._id },
      {
        $set: {
          bindStatus: "bound",
          lineUserId: "original",
          bindCodeExpiresAt: new Date(Date.now() + 60000),
        },
      },
    );
    expect(await service.hasUsableEmergencyContactCode("ABC123")).toBe(false);
    expect(
      (await service.bindEmergencyContactCode("ABC123", "line-a")).ok,
    ).toBe(false);
    expect((await EmergencyContact.findById(contact._id))?.lineUserId).toBe(
      "original",
    );
  });

  it("propagates lookup errors and reports uncertain write failures without claiming no write", async () => {
    vi.spyOn(
      repository,
      "usableEmergencyContactCodeExists",
    ).mockRejectedValueOnce(new Error("lookup unavailable"));
    await expect(
      service.hasUsableEmergencyContactCode("ABC123"),
    ).rejects.toThrow("lookup unavailable");
    const real = repository.redeemEmergencyContactCode;
    await pending();
    vi.spyOn(repository, "redeemEmergencyContactCode").mockImplementationOnce(
      async (...args) => {
        await real(...args);
        throw new Error("response lost");
      },
    );
    expect(await service.bindEmergencyContactCode("ABC123", "line-a")).toEqual({
      ok: false,
      errorCode: "BIND_OUTCOME_UNCONFIRMED",
      error: LINE_MSG.BIND_UNCONFIRMED,
    });
    expect(
      (await EmergencyContact.findOne({ lineUserId: "line-a" }))?.bindStatus,
    ).toBe("bound");
  });
});
