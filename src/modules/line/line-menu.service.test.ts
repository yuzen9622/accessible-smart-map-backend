import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock("../../model/sos-session.model", () => ({
  default: {
    find: vi.fn(),
  },
}));

vi.mock("../../model/user.model", () => ({
  default: {
    find: vi.fn(),
  },
}));

import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import {
  listBoundContacts,
  listSosHistory,
  renameBoundContact,
  unbindContact,
} from "./line-menu.service";
import { LINE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";

const contactModel = EmergencyContact as unknown as {
  find: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  updateOne: ReturnType<typeof vi.fn>;
};
const sosSessionModel = SosSession as unknown as {
  find: ReturnType<typeof vi.fn>;
};
const userModel = User as unknown as { find: ReturnType<typeof vi.fn> };

const CONTACT_ID = "68f0000000000000000000aa";
const OTHER_CONTACT_ID = "68f0000000000000000000bb";

function mockBoundContacts(
  docs: Array<{ _id: string; name: string; userId: string; updatedAt?: Date }>,
): void {
  contactModel.find.mockReturnValue({
    sort: () => ({ select: () => ({ lean: () => Promise.resolve(docs) }) }),
  });
}

function mockOwners(docs: Array<{ _id: string; name?: string }>): void {
  userModel.find.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(docs) }),
  });
}

function mockSessions(docs: unknown[]): void {
  sosSessionModel.find.mockReturnValue({
    sort: () => ({
      limit: () => ({ select: () => ({ lean: () => Promise.resolve(docs) }) }),
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockBoundContacts([]);
  mockOwners([]);
  mockSessions([]);
});

describe("line-menu.service — listBoundContacts", () => {
  it("scopes the query to bound records of the caller", async () => {
    await listBoundContacts("U1");

    expect(contactModel.find).toHaveBeenCalledWith({
      lineUserId: "U1",
      bindStatus: "bound",
    });
  });

  it("joins the owner display name", async () => {
    const updatedAt = new Date("2026-07-01T00:00:00Z");
    mockBoundContacts([
      { _id: CONTACT_ID, name: "小明", userId: "u1", updatedAt },
    ]);
    mockOwners([{ _id: "u1", name: "王小明" }]);

    const result = await listBoundContacts("U1");

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        contactId: CONTACT_ID,
        contactName: "小明",
        ownerId: "u1",
        ownerName: "王小明",
        updatedAt,
      },
    ]);
  });

  it("skips contacts whose owner account no longer exists", async () => {
    mockBoundContacts([
      { _id: CONTACT_ID, name: "小明", userId: "u1" },
      { _id: OTHER_CONTACT_ID, name: "小華", userId: "gone" },
    ]);
    mockOwners([{ _id: "u1", name: "王小明" }]);

    const result = await listBoundContacts("U1");

    expect(result.data).toHaveLength(1);
    expect(result.data?.[0].ownerId).toBe("u1");
  });

  it("rejects an empty LINE user id without querying", async () => {
    const result = await listBoundContacts("");

    expect(result.ok).toBe(false);
    expect(contactModel.find).not.toHaveBeenCalled();
  });
});

describe("line-menu.service — renameBoundContact", () => {
  it("updates only a bound record owned by the caller", async () => {
    contactModel.updateOne.mockResolvedValue({ matchedCount: 1 });

    const result = await renameBoundContact({
      lineUserId: "U1",
      contactId: CONTACT_ID,
      name: " 阿明 ",
    });

    expect(contactModel.updateOne).toHaveBeenCalledWith(
      { _id: CONTACT_ID, lineUserId: "U1", bindStatus: "bound" },
      { $set: { name: "阿明" } },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ name: "阿明" });
  });

  it("reports not-found when the filter matches nothing", async () => {
    contactModel.updateOne.mockResolvedValue({ matchedCount: 0 });

    const result = await renameBoundContact({
      lineUserId: "U1",
      contactId: CONTACT_ID,
      name: "阿明",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(LINE_MSG.SOS_CONTACT_NOT_FOUND);
  });

  it("rejects an empty or over-long name without touching the database", async () => {
    const empty = await renameBoundContact({
      lineUserId: "U1",
      contactId: CONTACT_ID,
      name: "   ",
    });
    const tooLong = await renameBoundContact({
      lineUserId: "U1",
      contactId: CONTACT_ID,
      name: "x".repeat(51),
    });

    expect(empty.httpCode).toBe(ResponseCode.INVALID_INPUT);
    expect(tooLong.httpCode).toBe(ResponseCode.INVALID_INPUT);
    expect(contactModel.updateOne).not.toHaveBeenCalled();
  });

  it("rejects a malformed contact id", async () => {
    const result = await renameBoundContact({
      lineUserId: "U1",
      contactId: "not-an-id",
      name: "阿明",
    });

    expect(result.ok).toBe(false);
    expect(contactModel.updateOne).not.toHaveBeenCalled();
  });
});

describe("line-menu.service — unbindContact", () => {
  beforeEach(() => {
    contactModel.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ userId: "u1" }) }),
    });
    contactModel.updateOne.mockResolvedValue({ matchedCount: 1 });
    mockOwners([{ _id: "u1", name: "王小明" }]);
  });

  it("returns the slot to pending and unsets the bind code", async () => {
    const result = await unbindContact({
      lineUserId: "U1",
      contactId: CONTACT_ID,
    });

    expect(contactModel.updateOne).toHaveBeenCalledWith(
      { _id: CONTACT_ID, lineUserId: "U1", bindStatus: "bound" },
      {
        $set: {
          bindStatus: "pending",
          lineUserId: null,
          lastLineLat: null,
          lastLineLng: null,
          lastLineLocationUpdatedAt: null,
        },
        $unset: { bindCode: "", bindCodeExpiresAt: "" },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ownerName: "王小明" });
  });

  it("never writes an explicit null bind code (unique+sparse index would collide)", async () => {
    await unbindContact({ lineUserId: "U1", contactId: CONTACT_ID });

    const update = contactModel.updateOne.mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set).not.toHaveProperty("bindCode");
    expect(update.$set).not.toHaveProperty("bindCodeExpiresAt");
  });

  it("reports not-found for a binding that is not the caller's", async () => {
    contactModel.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    });

    const result = await unbindContact({
      lineUserId: "U1",
      contactId: CONTACT_ID,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(LINE_MSG.SOS_CONTACT_NOT_FOUND);
    expect(contactModel.updateOne).not.toHaveBeenCalled();
  });
});

describe("line-menu.service — listSosHistory", () => {
  beforeEach(() => {
    mockBoundContacts([
      { _id: CONTACT_ID, name: "小明", userId: "u1" },
      { _id: OTHER_CONTACT_ID, name: "小明", userId: "u2" },
    ]);
    mockOwners([
      { _id: "u1", name: "王小明" },
      { _id: "u2", name: "李小華" },
    ]);
  });

  it("queries every bound owner and returns the owner filter list", async () => {
    mockSessions([
      {
        _id: "s1",
        userId: "u2",
        type: "body",
        status: "resolved",
        handlingStatus: "resolved",
        address: "台北車站",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        resolvedAt: new Date("2026-07-01T00:30:00Z"),
        claimedByName: "小明",
      },
    ]);

    const result = await listSosHistory({ lineUserId: "U1" });

    expect(sosSessionModel.find).toHaveBeenCalledWith({
      userId: { $in: ["u1", "u2"] },
    });
    expect(result.data?.entries[0]).toMatchObject({
      sessionId: "s1",
      ownerId: "u2",
      ownerName: "李小華",
      type: "body",
      status: "resolved",
    });
    expect(result.data?.owners).toEqual([
      { ownerId: "u1", ownerName: "王小明" },
      { ownerId: "u2", ownerName: "李小華" },
    ]);
  });

  it("honours an owner filter that is bound to the caller", async () => {
    await listSosHistory({ lineUserId: "U1", ownerId: "u2" });

    expect(sosSessionModel.find).toHaveBeenCalledWith({ userId: "u2" });
  });

  it("refuses an owner filter that is not bound to the caller", async () => {
    const result = await listSosHistory({ lineUserId: "U1", ownerId: "u9" });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(LINE_MSG.SOS_CONTACT_NOT_FOUND);
    expect(sosSessionModel.find).not.toHaveBeenCalled();
  });

  it("reports the no-contacts state when nothing is bound", async () => {
    mockBoundContacts([]);
    mockOwners([]);

    const result = await listSosHistory({ lineUserId: "U1" });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(LINE_MSG.SOS_NO_CONTACTS);
    expect(sosSessionModel.find).not.toHaveBeenCalled();
  });
});
