import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../model/sos-session.model", () => ({
  default: {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    updateOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));
vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
  },
}));
vi.mock("../../model/user.model", () => ({
  default: {
    findById: vi.fn(),
  },
}));
vi.mock("../../adapters/line.adapter", () => ({
  sendSosNotification: vi.fn(),
  sendSosResolved: vi.fn(),
}));
vi.mock("../user/user.push.service", async (importActual) => ({
  ...(await importActual<typeof import("../user/user.push.service")>()),
  sendPushToUser: vi.fn(),
}));
vi.mock("./sos-events", () => ({
  emitSosUpdate: vi.fn(),
  buildSosSnapshot: vi.fn(() => ({ snapshot: true })),
}));

import SosSession from "../../model/sos-session.model";
import EmergencyContact from "../../model/emergency-contact.model";
import User from "../../model/user.model";
import { sendSosResolved } from "../../adapters/line.adapter";
import { emitSosUpdate, buildSosSnapshot } from "./sos-events";
import { sendPushToUser } from "../user/user.push.service";
import {
  acknowledgeSession,
  claimSession,
  updateHandlingStatus,
  resolveSession,
  getSessionForOwner,
} from "./sos.service";
import { ResponseCode } from "../../types/code";
import { SOS_MSG, SOS_REASON } from "../../constants/messages";

const SESSION_ID = "6a4e797394fbb1b1721c8b81";
const OWNER_ID = "u1";
const FAM_LINE = "Lfam";

/** Chainable stub for Mongoose `.select(...).lean()` / `.lean()` query heads. */
function lean(value: unknown): unknown {
  return {
    select: () => lean(value),
    lean: () => Promise.resolve(value),
  };
}

/**
 * Programs the model calls that back `getAuthorizedSessionForLineUser` and
 * `resolveActingContact` for an authorized bound contact of `OWNER_ID`.
 * Does NOT set `SosSession.findById` — tests queue those per call because the
 * ordering (auth lookup first, then any post-write reload) is deterministic.
 */
function setupAuthorized({
  boundIds = ["L1", FAM_LINE],
}: { boundIds?: string[] } = {}): void {
  vi.mocked(EmergencyContact.find).mockImplementation((() => ({
    select: (fields: string) => ({
      lean: () =>
        Promise.resolve(
          fields === "lineUserId"
            ? boundIds.map((id) => ({ lineUserId: id }))
            : [{ userId: OWNER_ID, name: "媽媽" }],
        ),
    }),
  })) as never);
  vi.mocked(EmergencyContact.findOne).mockReturnValue(
    lean({ _id: "c1", name: "媽媽" }) as never,
  );
  vi.mocked(User.findById).mockReturnValue(lean({ name: "小明" }) as never);
}

/** Programs an unauthorized LINE user: no bound contacts → auth resolves null. */
function setupUnauthorized(): void {
  vi.mocked(EmergencyContact.find).mockImplementation((() => ({
    select: () => ({ lean: () => Promise.resolve([]) }),
  })) as never);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("acknowledgeSession — idempotency (F1)", () => {
  it("first call emits once and returns ACKNOWLEDGED", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "active",
          handlingStatus: "acknowledged",
        }) as never,
      );
    vi.mocked(SosSession.updateOne)
      .mockResolvedValueOnce({ modifiedCount: 1 } as never)
      .mockResolvedValueOnce({} as never);

    const res = await acknowledgeSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.ACKNOWLEDGED);
    expect(emitSosUpdate).toHaveBeenCalledTimes(1);
  });

  it("second call (modifiedCount 0, still active) does NOT emit again but stays ok ACKNOWLEDGED", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({ status: "active", handlingStatus: "acknowledged" }) as never,
      );
    vi.mocked(SosSession.updateOne).mockResolvedValueOnce({
      modifiedCount: 0,
    } as never);

    const res = await acknowledgeSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.ACKNOWLEDGED);
    expect(emitSosUpdate).not.toHaveBeenCalled();
  });

  it("modifiedCount 0 on an already-resolved session returns ALREADY_RESOLVED", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({ status: "resolved", handlingStatus: "resolved" }) as never,
      );
    vi.mocked(SosSession.updateOne).mockResolvedValueOnce({
      modifiedCount: 0,
    } as never);

    const res = await acknowledgeSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.ALREADY_RESOLVED);
    expect(emitSosUpdate).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN NOT_AUTHORIZED_CONTACT for an unauthorized LINE user", async () => {
    setupUnauthorized();
    const res = await acknowledgeSession({
      sessionId: SESSION_ID,
      lineUserId: "stranger",
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.FORBIDDEN);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.NOT_AUTHORIZED_CONTACT,
    );
  });
});

describe("claimSession — atomicity / conflict", () => {
  it("winner (findOneAndUpdate returns prev doc) returns CLAIMED and emits", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "active",
          claimedBy: FAM_LINE,
        }) as never,
      );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValueOnce({
      _id: SESSION_ID,
    } as never);

    const res = await claimSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.CLAIMED);
    expect(emitSosUpdate).toHaveBeenCalledTimes(1);
  });

  it("idempotent claim (null prev, claimedBy === self) returns CLAIMED with NO emit", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          status: "active",
          claimedBy: FAM_LINE,
          claimedByName: "媽媽",
        }) as never,
      );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValueOnce(null as never);

    const res = await claimSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.CLAIMED);
    expect(emitSosUpdate).not.toHaveBeenCalled();
  });

  it("conflict (null prev, claimed by someone else) returns ok:false 200 ALREADY_CLAIMED, no emit/notify", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          status: "active",
          claimedBy: "Lother",
          claimedByName: "哥哥",
        }) as never,
      );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValueOnce(null as never);

    const res = await claimSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.OK);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.ALREADY_CLAIMED,
    );
    expect(emitSosUpdate).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN NOT_AUTHORIZED_CONTACT for an unauthorized LINE user", async () => {
    setupUnauthorized();
    const res = await claimSession({
      sessionId: SESSION_ID,
      lineUserId: "stranger",
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.FORBIDDEN);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.NOT_AUTHORIZED_CONTACT,
    );
  });
});

describe("updateHandlingStatus", () => {
  it("active session → STATUS_UPDATED and emits", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById).mockReturnValueOnce(
      lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
    );
    vi.mocked(SosSession.findOneAndUpdate).mockReturnValueOnce(
      lean({ userId: OWNER_ID, handlingStatus: "en_route" }) as never,
    );

    const res = await updateHandlingStatus({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
      handlingStatus: "en_route",
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.STATUS_UPDATED);
    expect(emitSosUpdate).toHaveBeenCalledTimes(1);
  });

  it("non-active session (findOneAndUpdate null) → SESSION_NOT_ACTIVE", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById).mockReturnValueOnce(
      lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
    );
    vi.mocked(SosSession.findOneAndUpdate).mockReturnValueOnce(
      lean(null) as never,
    );

    const res = await updateHandlingStatus({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
      note: "hi",
    });

    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.INVALID_INPUT);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.SESSION_NOT_ACTIVE,
    );
    expect(emitSosUpdate).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN NOT_AUTHORIZED_CONTACT for an unauthorized LINE user", async () => {
    setupUnauthorized();
    const res = await updateHandlingStatus({
      sessionId: SESSION_ID,
      lineUserId: "stranger",
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.FORBIDDEN);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.NOT_AUTHORIZED_CONTACT,
    );
  });
});

describe("resolveSession — idempotency (F2)", () => {
  it("winner (findOneAndUpdate returns prev) calls sendSosResolved once and emits", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "resolved",
        }) as never,
      );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValueOnce({
      _id: SESSION_ID,
    } as never);
    vi.mocked(sendSosResolved).mockResolvedValue(undefined as never);

    const res = await resolveSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.RESOLVED);
    expect(sendSosResolved).toHaveBeenCalledTimes(1);
    expect(emitSosUpdate).toHaveBeenCalledTimes(1);
  });

  it("already resolved (findOneAndUpdate null) does NOT notify but still returns RESOLVED", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById).mockReturnValueOnce(
      lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
    );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValueOnce(null as never);

    const res = await resolveSession({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
    });

    expect(res.ok).toBe(true);
    expect(res.message).toBe(SOS_MSG.RESOLVED);
    expect(sendSosResolved).not.toHaveBeenCalled();
    expect(emitSosUpdate).not.toHaveBeenCalled();
  });

  it("owner path with mismatched userId → FORBIDDEN NOT_SESSION_OWNER", async () => {
    vi.mocked(SosSession.findById).mockReturnValueOnce(
      lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
    );
    const res = await resolveSession({
      sessionId: SESSION_ID,
      userId: "someone-else",
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.FORBIDDEN);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.NOT_SESSION_OWNER,
    );
  });

  it("family path unauthorized → FORBIDDEN NOT_AUTHORIZED_CONTACT", async () => {
    setupUnauthorized();
    const res = await resolveSession({
      sessionId: SESSION_ID,
      lineUserId: "stranger",
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.FORBIDDEN);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.NOT_AUTHORIZED_CONTACT,
    );
  });
});

describe("getSessionForOwner", () => {
  it("unknown id → NOT_FOUND", async () => {
    vi.mocked(SosSession.findById).mockReturnValueOnce(lean(null) as never);
    const res = await getSessionForOwner({
      userId: OWNER_ID,
      sessionId: SESSION_ID,
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.NOT_FOUND);
  });

  it("wrong owner → FORBIDDEN", async () => {
    vi.mocked(SosSession.findById).mockReturnValueOnce(
      lean({ _id: SESSION_ID, userId: OWNER_ID }) as never,
    );
    const res = await getSessionForOwner({
      userId: "someone-else",
      sessionId: SESSION_ID,
    });
    expect(res.ok).toBe(false);
    expect(res.httpCode).toBe(ResponseCode.FORBIDDEN);
    expect((res.data as { reason: string }).reason).toBe(
      SOS_REASON.NOT_SESSION_OWNER,
    );
  });

  it("owner match → ok with the buildSosSnapshot result as data", async () => {
    vi.mocked(SosSession.findById).mockReturnValueOnce(
      lean({ _id: SESSION_ID, userId: OWNER_ID }) as never,
    );
    const res = await getSessionForOwner({
      userId: OWNER_ID,
      sessionId: SESSION_ID,
    });
    expect(res.ok).toBe(true);
    expect(res.httpCode).toBe(ResponseCode.OK);
    expect(res.data).toEqual({ snapshot: true });
    expect(buildSosSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe("owner push notifications", () => {
  /** Returns the push call's copy builder and payload. */
  function pushCall(): {
    build: (locale: string) => { title: string; body: string };
    data: Record<string, unknown>;
  } {
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [userId, build, data] = vi.mocked(sendPushToUser).mock.calls[0];
    expect(userId).toBe(OWNER_ID);
    return { build, data };
  }

  it("pushes the owner when a contact first acknowledges, localized per device", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "active",
          handlingStatus: "acknowledged",
        }) as never,
      );
    vi.mocked(SosSession.updateOne)
      .mockResolvedValueOnce({ modifiedCount: 1 } as never)
      .mockResolvedValueOnce({} as never);

    await acknowledgeSession({ sessionId: SESSION_ID, lineUserId: FAM_LINE });

    const { build, data } = pushCall();
    expect(data).toEqual({
      type: "sos_update",
      event: "acknowledged",
      sessionId: SESSION_ID,
      status: "active",
      handlingStatus: "acknowledged",
    });
    expect(build("zh-TW").body).toBe("媽媽已收到你的求救通知");
    expect(build("en-US").body).toBe("媽媽 received your SOS alert");
    expect(build("ja").title).toBe("SOS 求救狀態更新");
  });

  it("does not push again on a repeated acknowledgement", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({ status: "active", handlingStatus: "acknowledged" }) as never,
      );
    vi.mocked(SosSession.updateOne).mockResolvedValueOnce({
      modifiedCount: 0,
    } as never);

    await acknowledgeSession({ sessionId: SESSION_ID, lineUserId: FAM_LINE });

    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("pushes the owner when a contact wins the claim", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById)
      .mockReturnValueOnce(
        lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
      )
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "active",
          handlingStatus: "claimed",
        }) as never,
      );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValueOnce({
      _id: SESSION_ID,
    } as never);

    await claimSession({ sessionId: SESSION_ID, lineUserId: FAM_LINE });

    const { build, data } = pushCall();
    expect(data.event).toBe("claimed");
    expect(build("zh-TW").body).toBe("媽媽已承接你的求救，正在處理");
  });

  it("describes the new handling status, or the note when no status is set", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById).mockReturnValue(
      lean({ _id: SESSION_ID, userId: OWNER_ID, status: "active" }) as never,
    );
    vi.mocked(SosSession.findOneAndUpdate)
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "active",
          handlingStatus: "en_route",
        }) as never,
      )
      .mockReturnValueOnce(
        lean({
          _id: SESSION_ID,
          userId: OWNER_ID,
          status: "active",
          handlingStatus: "en_route",
        }) as never,
      );

    await updateHandlingStatus({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
      handlingStatus: "en_route",
    });
    await updateHandlingStatus({
      sessionId: SESSION_ID,
      lineUserId: FAM_LINE,
      note: "五分鐘到",
    });

    const [first, second] = vi.mocked(sendPushToUser).mock.calls;
    expect(first[2].handlingStatus).toBe("en_route");
    expect(first[1]("zh-TW").body).toBe("媽媽正在前往你的位置");
    expect(second[1]("zh-TW").body).toBe("媽媽：五分鐘到");
  });

  it("pushes the owner when a contact resolves, but not when the owner resolves", async () => {
    setupAuthorized();
    vi.mocked(SosSession.findById).mockReturnValue(
      lean({
        _id: SESSION_ID,
        userId: OWNER_ID,
        status: "resolved",
        handlingStatus: "resolved",
      }) as never,
    );
    vi.mocked(SosSession.findOneAndUpdate).mockResolvedValue({
      _id: SESSION_ID,
    } as never);
    vi.mocked(sendSosResolved).mockResolvedValue(undefined as never);

    await resolveSession({ sessionId: SESSION_ID, userId: OWNER_ID });
    expect(sendPushToUser).not.toHaveBeenCalled();

    await resolveSession({ sessionId: SESSION_ID, lineUserId: FAM_LINE });
    const { build, data } = pushCall();
    expect(data).toMatchObject({ event: "resolved", status: "resolved" });
    expect(build("zh-TW").body).toBe("媽媽已解除這次求救");
  });
});
