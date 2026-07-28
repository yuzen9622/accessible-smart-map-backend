import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  replyAgentResult: vi.fn().mockResolvedValue(undefined),
  replyText: vi.fn().mockResolvedValue(undefined),
  replyMessages: vi.fn().mockResolvedValue(undefined),
  showLoadingAnimation: vi.fn().mockResolvedValue(undefined),
  buildClaimedControlsMessage: vi.fn((sessionId: string) => ({
    type: "text",
    text: "controls",
    _sid: sessionId,
  })),
  buildSosMenuMessage: vi.fn(() => ({ type: "text", text: "menu" })),
  buildBoundContactsMessage: vi.fn(() => ({ type: "flex", altText: "contacts" })),
  buildSosHistoryMessage: vi.fn(() => ({ type: "flex", altText: "history" })),
  buildUnbindConfirmMessage: vi.fn(() => ({ type: "text", text: "confirm" })),
}));

vi.mock("./line-agent.service", () => ({
  runLineAgent: vi.fn(),
}));

vi.mock("./line-memory", () => ({
  getLineChatHistory: vi.fn(),
  appendLineChatTurn: vi.fn(),
  getPendingRename: vi.fn().mockResolvedValue(null),
  setPendingRename: vi.fn().mockResolvedValue(undefined),
  clearPendingRename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./line-menu.service", () => ({
  listBoundContacts: vi.fn(),
  listSosHistory: vi.fn(),
  renameBoundContact: vi.fn(),
  unbindContact: vi.fn(),
}));

vi.mock("../sos/sos.service", () => ({
  acknowledgeSession: vi.fn(),
  claimSession: vi.fn(),
  updateHandlingStatus: vi.fn(),
  resolveSession: vi.fn(),
  getAuthorizedSessionForLineUser: vi.fn(),
}));

vi.mock("../../config/redis", () => ({
  redisSetNx: vi.fn(),
}));

vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../../model/sos-session.model", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../../model/user.model", () => ({
  default: {
    find: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));

import { getRoutePreview, handleEvents } from "./line.service";
import {
  buildBoundContactsMessage,
  buildClaimedControlsMessage,
  buildSosHistoryMessage,
  buildSosMenuMessage,
  buildUnbindConfirmMessage,
  replyAgentResult,
  replyMessages,
  replyText,
  showLoadingAnimation,
} from "../../adapters/line.adapter";
import { runLineAgent } from "./line-agent.service";
import {
  appendLineChatTurn,
  clearPendingRename,
  getLineChatHistory,
  getPendingRename,
  setPendingRename,
} from "./line-memory";
import {
  listBoundContacts,
  listSosHistory,
  renameBoundContact,
  unbindContact,
} from "./line-menu.service";
import {
  acknowledgeSession,
  claimSession,
  getAuthorizedSessionForLineUser,
  resolveSession,
  updateHandlingStatus,
} from "../sos/sos.service";
import { redisSetNx } from "../../config/redis";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { LINE_MSG, SOS_MSG, SOS_REASON } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { LineEvent } from "./line.types";

const contactModel = EmergencyContact as unknown as {
  find: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const sosSessionModel = SosSession as unknown as {
  findById: ReturnType<typeof vi.fn>;
};
const userModel = User as unknown as {
  find: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.PUBLIC_LIFF_ROUTE_BASE_URL;
  vi.mocked(replyAgentResult).mockResolvedValue(undefined);
  vi.mocked(replyText).mockResolvedValue(undefined);
  vi.mocked(replyMessages).mockResolvedValue(undefined);
  vi.mocked(showLoadingAnimation).mockResolvedValue(undefined);
  vi.mocked(getAuthorizedSessionForLineUser).mockResolvedValue({
    session: { _id: "s1", userId: "u1", status: "active" } as any,
    ownerName: "王小明",
  });
  vi.mocked(buildClaimedControlsMessage).mockReturnValue({
    type: "text",
    text: "controls",
  } as any);
  vi.mocked(getLineChatHistory).mockResolvedValue([]);
  vi.mocked(appendLineChatTurn).mockResolvedValue(undefined);
  vi.mocked(getPendingRename).mockResolvedValue(null);
  vi.mocked(setPendingRename).mockResolvedValue(undefined);
  vi.mocked(clearPendingRename).mockResolvedValue(undefined);
  vi.mocked(buildSosMenuMessage).mockReturnValue({
    type: "text",
    text: "menu",
  } as any);
  vi.mocked(buildBoundContactsMessage).mockReturnValue({
    type: "flex",
    altText: "contacts",
  } as any);
  vi.mocked(buildSosHistoryMessage).mockReturnValue({
    type: "flex",
    altText: "history",
  } as any);
  vi.mocked(buildUnbindConfirmMessage).mockReturnValue({
    type: "text",
    text: "confirm",
  } as any);
  vi.mocked(runLineAgent).mockResolvedValue({ text: "ok", toolResults: [] });
  vi.mocked(redisSetNx).mockResolvedValue(true);
  vi.mocked(acknowledgeSession).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "已確認收到通知",
  });
  vi.mocked(claimSession).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "你已承接此事件",
  });
  vi.mocked(updateHandlingStatus).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "已更新處理狀態",
  });
  vi.mocked(resolveSession).mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "已解除求救",
  });
  contactModel.find.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve([]) }),
  });
  userModel.find.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve([]) }),
  });
  vi.mocked(planAccessibleRouteFromRequest).mockResolvedValue({
    ok: true,
    data: {
      origin: { lat: 25.03, lng: 121.56 },
      destination: { lat: 25.0478, lng: 121.5171 },
      city: "Taipei",
      travelMode: "transit",
      routes: [
        { routeName: "route1", totalMinutes: 12, legs: [{ type: "WALK" }] },
      ],
    } as any,
  });
});

function textEvent(text: string, webhookEventId?: string): LineEvent {
  return {
    type: "message",
    replyToken: "r1",
    message: { type: "text", text },
    source: { type: "user", userId: "U1" },
    ...(webhookEventId ? { webhookEventId } : {}),
  } as unknown as LineEvent;
}

function locationEvent(replyToken: string): LineEvent {
  return {
    type: "message",
    replyToken,
    source: { type: "user", userId: "U1" },
    message: {
      type: "location",
      title: "現在位置",
      address: "台北車站",
      latitude: 25.0478,
      longitude: 121.5171,
    },
  } as unknown as LineEvent;
}

function postbackEvent(data: string): LineEvent {
  return {
    type: "postback",
    replyToken: "rp",
    source: { type: "user", userId: "U1" },
    postback: { data },
  } as unknown as LineEvent;
}

describe("line.service — follow", () => {
  it("replies the welcome message", async () => {
    await handleEvents([
      {
        type: "follow",
        replyToken: "rF",
        source: { type: "user", userId: "U1" },
      } as unknown as LineEvent,
    ]);
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rF", LINE_MSG.WELCOME);
  });
});

describe("line.service — text message (agent loop)", () => {
  it("runs the agent, replies the speech, and persists the turn", async () => {
    vi.mocked(runLineAgent).mockResolvedValue({
      text: "你好呀",
      toolResults: [],
    });

    await handleEvents([textEvent("你好嗎")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalledWith({
      lineUserId: "U1",
      messages: [{ role: "user", content: "你好嗎" }],
    });
    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "你好呀",
      null,
    );
    expect(vi.mocked(appendLineChatTurn)).toHaveBeenCalledWith(
      "U1",
      "你好嗎",
      "你好呀",
    );
  });

  it("prepends prior chat history to the agent messages", async () => {
    vi.mocked(getLineChatHistory).mockResolvedValue([
      { role: "user", content: "先前問題" },
      { role: "assistant", content: "先前回答" },
    ]);

    await handleEvents([textEvent("接續問題")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalledWith({
      lineUserId: "U1",
      messages: [
        { role: "user", content: "先前問題" },
        { role: "assistant", content: "先前回答" },
        { role: "user", content: "接續問題" },
      ],
    });
  });

  it("unwraps a JSON speech envelope from the agent text", async () => {
    vi.mocked(runLineAgent).mockResolvedValue({
      text: JSON.stringify({ speech: "台北目前多雲。" }),
      toolResults: [],
    });

    await handleEvents([textEvent("台北天氣")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "台北目前多雲。",
      null,
    );
  });

  it("surfaces a route card built from a plan tool result", async () => {
    process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.example.com/route";
    vi.mocked(runLineAgent).mockResolvedValue({
      text: "我幫你找到可前往的路線。",
      toolResults: [
        {
          name: "planAccessibleRoute",
          args: {},
          result: {
            ok: true,
            sessionId: "s1",
            destination: { address: "台北車站" },
            routes: [
              {
                routeName: "無障礙路線",
                totalMinutes: 12,
                legs: [{ type: "WALK" }, { type: "BUS", routeName: "307" }],
              },
            ],
          },
        },
      ],
    });

    await handleEvents([textEvent("規劃到台北車站的路線")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "我幫你找到可前往的路線。",
      {
        origin: "你的位置",
        destination: "台北車站",
        options: [
          { label: "無障礙路線", time: "約 12 分鐘", detail: "步行 → 公車 307" },
        ],
        liffUrl: "https://liff.example.com/route?sessionId=s1",
      },
    );
  });

  it("falls back to the fixed info reply when the agent throws", async () => {
    vi.mocked(runLineAgent).mockRejectedValue(new Error("boom"));

    await handleEvents([textEvent("他現在在哪")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("r1", LINE_MSG.INFO);
  });

  it("strips markdown from the agent reply before sending it to LINE", async () => {
    vi.mocked(runLineAgent).mockResolvedValue({
      text: "**台北**目前 `多雲`\n- 溫度 28 度",
      toolResults: [],
    });

    await handleEvents([textEvent("台北天氣")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith(
      "r1",
      "台北目前 多雲\n・ 溫度 28 度",
      null,
    );
  });

  it("shows the loading animation for a text message with a user id", async () => {
    await handleEvents([textEvent("你好嗎")]);

    expect(vi.mocked(showLoadingAnimation)).toHaveBeenCalledWith("U1");
  });

  it("skips the loading animation when the source has no user id", async () => {
    await handleEvents([
      {
        type: "message",
        replyToken: "r1",
        message: { type: "text", text: "你好" },
        source: { type: "group", groupId: "G1" },
      } as unknown as LineEvent,
    ]);

    expect(vi.mocked(showLoadingAnimation)).not.toHaveBeenCalled();
  });

  it("does not block the reply when the loading animation call fails", async () => {
    vi.mocked(showLoadingAnimation).mockRejectedValue(new Error("loading boom"));
    vi.mocked(runLineAgent).mockResolvedValue({ text: "你好呀", toolResults: [] });

    await handleEvents([textEvent("你好嗎")]);

    expect(vi.mocked(replyAgentResult)).toHaveBeenCalledWith("r1", "你好呀", null);
  });
});

describe("line.service — postback (deterministic SOS controls)", () => {
  it("ack delegates to acknowledgeSession and surfaces the message", async () => {
    await handleEvents([postbackEvent("action=ack&sid=s1")]);

    expect(vi.mocked(acknowledgeSession)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "已確認收到通知");
  });

  it("claim success replies the message plus the claim-controls message", async () => {
    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(claimSession)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
    });
    expect(vi.mocked(buildClaimedControlsMessage)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(replyMessages)).toHaveBeenCalledWith("rp", [
      { type: "text", text: "你已承接此事件" },
      { type: "text", text: "controls" },
    ]);
  });

  it("claim failure surfaces the service message via replyText", async () => {
    vi.mocked(claimSession).mockResolvedValue({
      ok: false,
      httpCode: 200,
      message: "此事件已由他人承接",
    } as any);

    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(replyMessages)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "此事件已由他人承接");
  });

  it("status delegates handlingStatus to updateHandlingStatus", async () => {
    await handleEvents([postbackEvent("action=status&sid=s1&v=en_route")]);

    expect(vi.mocked(updateHandlingStatus)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
      handlingStatus: "en_route",
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "已更新處理狀態");
  });

  it("rejects an invalid status value", async () => {
    await handleEvents([postbackEvent("action=status&sid=s1&v=bogus")]);

    expect(vi.mocked(updateHandlingStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });

  it("resolve delegates to resolveSession", async () => {
    await handleEvents([postbackEvent("action=resolve&sid=s1")]);

    expect(vi.mocked(resolveSession)).toHaveBeenCalledWith({
      sessionId: "s1",
      lineUserId: "U1",
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", "已解除求救");
  });

  it("replies the info message when sid or user id is missing", async () => {
    await handleEvents([postbackEvent("action=ack")]);

    expect(vi.mocked(acknowledgeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });

  it("replies INFO for an unknown action without any session lookup", async () => {
    await handleEvents([postbackEvent("action=bogus&sid=s1")]);

    expect(vi.mocked(getAuthorizedSessionForLineUser)).not.toHaveBeenCalled();
    expect(vi.mocked(acknowledgeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });

  it("replies INFO for an invalid status value without any session lookup", async () => {
    await handleEvents([postbackEvent("action=status&sid=s1&v=bogus")]);

    expect(vi.mocked(getAuthorizedSessionForLineUser)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHandlingStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });

  it("replies the unified resolved message and skips the action for a resolved session", async () => {
    vi.mocked(getAuthorizedSessionForLineUser).mockResolvedValue({
      session: { _id: "s1", userId: "u1", status: "resolved" } as any,
      ownerName: "王小明",
    });

    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(claimSession)).not.toHaveBeenCalled();
    expect(vi.mocked(showLoadingAnimation)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_ALREADY_RESOLVED,
    );
  });

  it("replies the standard permission message for an unauthorized contact", async () => {
    vi.mocked(getAuthorizedSessionForLineUser).mockResolvedValue(null as any);

    await handleEvents([postbackEvent("action=ack&sid=s1")]);

    expect(vi.mocked(acknowledgeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      SOS_MSG.NOT_AUTHORIZED_CONTACT,
    );
  });

  it("normalizes a claim that races into resolution to the unified reply (no claim controls)", async () => {
    vi.mocked(claimSession).mockResolvedValue({
      ok: false,
      httpCode: 200,
      message: "此求救已結束",
      data: { reason: SOS_REASON.SESSION_NOT_ACTIVE },
    } as any);

    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(replyMessages)).not.toHaveBeenCalled();
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_ALREADY_RESOLVED,
    );
  });

  it("normalizes an ack that races into resolution to the unified reply", async () => {
    vi.mocked(acknowledgeSession).mockResolvedValue({
      ok: true,
      httpCode: 200,
      message: "此事件已結案",
      data: { reason: SOS_REASON.ALREADY_RESOLVED },
    } as any);

    await handleEvents([postbackEvent("action=ack&sid=s1")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_ALREADY_RESOLVED,
    );
  });

  it("shows the loading animation for an active claim postback", async () => {
    await handleEvents([postbackEvent("action=claim&sid=s1")]);

    expect(vi.mocked(showLoadingAnimation)).toHaveBeenCalledWith("U1");
  });
});

describe("line.service — webhook dedup", () => {
  it("skips an event whose webhookEventId was already processed", async () => {
    vi.mocked(redisSetNx).mockResolvedValue(false);

    await handleEvents([textEvent("你好", "evt-1")]);

    expect(vi.mocked(redisSetNx)).toHaveBeenCalledWith(
      "line:evt:evt-1",
      3600,
    );
    expect(vi.mocked(runLineAgent)).not.toHaveBeenCalled();
  });

  it("processes an event when the webhookEventId is fresh", async () => {
    vi.mocked(redisSetNx).mockResolvedValue(true);

    await handleEvents([textEvent("你好", "evt-2")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalled();
  });
});

describe("line.service — location message", () => {
  it("caches the shared location on bound contacts and acknowledges", async () => {
    await handleEvents([locationEvent("r2")]);

    expect(contactModel.updateMany).toHaveBeenCalledWith(
      { lineUserId: "U1", bindStatus: "bound" },
      {
        $set: {
          lastLineLat: 25.0478,
          lastLineLng: 121.5171,
          lastLineLocationUpdatedAt: expect.any(Date),
        },
      },
    );
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r2",
      "收到您的位置！請問要查這個位置的天氣、找附近無障礙設施，還是規劃前往路線呢？",
    );
  });
});

describe("line.service — unfollow", () => {
  it("resets all contacts bound to the LINE user back to pending", async () => {
    contactModel.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await handleEvents([
      {
        type: "unfollow",
        source: { type: "user", userId: "U1" },
      } as unknown as LineEvent,
    ]);

    expect(contactModel.updateMany).toHaveBeenCalledWith(
      { lineUserId: "U1" },
      { $set: { bindStatus: "pending", lineUserId: null } },
    );
  });
});

describe("line.service — route preview", () => {
  it("plans a route from the latest bound contact location to an active SOS session", async () => {
    const sessionId = "68ef6e5b7f7f3a3b78f51291";
    sosSessionModel.findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: sessionId,
          userId: "u1",
          status: "active",
          lat: 25.0478,
          lng: 121.5171,
          address: "台北車站",
        }),
    });
    contactModel.findOne.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              lastLineLat: 25.03,
              lastLineLng: 121.56,
            }),
        }),
      }),
    });
    userModel.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ name: "王小明" }) }),
    });

    const result = await getRoutePreview(sessionId);

    expect(result.ok).toBe(true);
    expect(vi.mocked(planAccessibleRouteFromRequest)).toHaveBeenCalledWith({
      origin: { latitude: 25.03, longitude: 121.56 },
      destination: { latitude: 25.0478, longitude: 121.5171 },
      mode: "normal",
      travelMode: "drive",
      maxTransfers: 2,
      departureTime: undefined,
    });
    expect(result.data).toMatchObject({
      sessionId,
      ownerName: "王小明",
      origin: { lat: 25.03, lng: 121.56 },
      destination: { lat: 25.0478, lng: 121.5171 },
      originLabel: "你分享的位置",
      destinationLabel: "台北車站",
      routes: [{ routeName: "route1" }],
    });
  });

  it("returns 404 when the session is not active", async () => {
    sosSessionModel.findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "68ef6e5b7f7f3a3b78f51291",
          status: "resolved",
        }),
    });

    const result = await getRoutePreview("68ef6e5b7f7f3a3b78f51291");

    expect(result.ok).toBe(false);
    expect(result.httpCode).toBe(ResponseCode.NOT_FOUND);
    expect(vi.mocked(planAccessibleRouteFromRequest)).not.toHaveBeenCalled();
  });

  it("returns 400 when no bound contact has shared a location", async () => {
    sosSessionModel.findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "68ef6e5b7f7f3a3b78f51291",
          userId: "u1",
          status: "active",
          lat: 25.0478,
          lng: 121.5171,
        }),
    });
    contactModel.findOne.mockReturnValue({
      sort: () => ({
        select: () => ({ lean: () => Promise.resolve(null) }),
      }),
    });

    const result = await getRoutePreview("68ef6e5b7f7f3a3b78f51291");

    expect(result.ok).toBe(false);
    expect(result.httpCode).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(planAccessibleRouteFromRequest)).not.toHaveBeenCalled();
  });

  it("passes travelMode, mode, and departureTime to planAccessibleRouteFromRequest", async () => {
    const sessionId = "68ef6e5b7f7f3a3b78f51291";
    sosSessionModel.findById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: sessionId,
          userId: "u1",
          status: "active",
          lat: 25.0478,
          lng: 121.5171,
          address: "台北車站",
        }),
    });
    contactModel.findOne.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              lastLineLat: 25.03,
              lastLineLng: 121.56,
            }),
        }),
      }),
    });
    userModel.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ name: "王小明" }) }),
    });

    const result = await getRoutePreview(
      sessionId,
      "drive",
      "wheelchair",
      "2026-07-09T16:00:00+08:00",
    );

    expect(result.ok).toBe(true);
    expect(vi.mocked(planAccessibleRouteFromRequest)).toHaveBeenCalledWith({
      origin: { latitude: 25.03, longitude: 121.56 },
      destination: { latitude: 25.0478, longitude: 121.5171 },
      mode: "wheelchair",
      travelMode: "drive",
      maxTransfers: 2,
      departureTime: "2026-07-09T16:00:00+08:00",
    });
  });
});

describe("line.service — SOS information menu", () => {
  function groupPostbackEvent(data: string): LineEvent {
    return {
      type: "postback",
      replyToken: "rp",
      source: { type: "group", groupId: "G1" },
      postback: { data },
    } as unknown as LineEvent;
  }

  const boundContact = {
    contactId: "68f0000000000000000000aa",
    contactName: "小明",
    ownerId: "u1",
    ownerName: "王小明",
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  };

  it("replies the menu on the exact trigger without calling the agent", async () => {
    await handleEvents([textEvent("SOS資訊查詢")]);

    expect(vi.mocked(replyMessages)).toHaveBeenCalledWith("r1", [
      { type: "text", text: "menu" },
    ]);
    expect(vi.mocked(runLineAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(appendLineChatTurn)).not.toHaveBeenCalled();
  });

  it("still routes near-miss text to the agent", async () => {
    await handleEvents([textEvent("SOS 資訊查詢")]);

    expect(vi.mocked(runLineAgent)).toHaveBeenCalled();
    expect(vi.mocked(buildSosMenuMessage)).not.toHaveBeenCalled();
  });

  it("lists bound contacts as a carousel", async () => {
    vi.mocked(listBoundContacts).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: [boundContact],
    });

    await handleEvents([postbackEvent("action=sos_contacts")]);

    expect(vi.mocked(listBoundContacts)).toHaveBeenCalledWith("U1");
    expect(vi.mocked(buildBoundContactsMessage)).toHaveBeenCalledWith([
      boundContact,
    ]);
    expect(vi.mocked(replyMessages)).toHaveBeenCalledWith("rp", [
      { type: "flex", altText: "contacts" },
    ]);
  });

  it("replies the empty-state message when nothing is bound", async () => {
    vi.mocked(listBoundContacts).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: [],
    });

    await handleEvents([postbackEvent("action=sos_contacts")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_NO_CONTACTS,
    );
    expect(vi.mocked(buildBoundContactsMessage)).not.toHaveBeenCalled();
  });

  it("replies the bind prompt and clears any stale rename slot", async () => {
    await handleEvents([postbackEvent("action=sos_bind_start")]);

    expect(vi.mocked(clearPendingRename)).toHaveBeenCalledWith("U1");
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_BIND_PROMPT,
    );
  });

  it("replies the static help text", async () => {
    await handleEvents([postbackEvent("action=sos_help")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.SOS_HELP);
  });

  it("passes the owner filter through to the history query", async () => {
    vi.mocked(listSosHistory).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: {
        entries: [
          {
            sessionId: "s1",
            ownerId: "u1",
            ownerName: "王小明",
            type: "body",
            status: "resolved",
            handlingStatus: "resolved",
            address: "台北車站",
            createdAt: new Date("2026-07-01T00:00:00Z"),
            resolvedAt: new Date("2026-07-01T00:30:00Z"),
            claimedByName: "小明",
          },
        ],
        owners: [{ ownerId: "u1", ownerName: "王小明" }],
        activeOwnerId: "u1",
      },
    });

    await handleEvents([postbackEvent("action=sos_history&owner=u1")]);

    expect(vi.mocked(listSosHistory)).toHaveBeenCalledWith({
      lineUserId: "U1",
      ownerId: "u1",
    });
    expect(vi.mocked(replyMessages)).toHaveBeenCalledWith("rp", [
      { type: "flex", altText: "history" },
    ]);
  });

  it("replies the empty-state message when there is no history", async () => {
    vi.mocked(listSosHistory).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: { entries: [], owners: [] },
    });

    await handleEvents([postbackEvent("action=sos_history")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_NO_HISTORY,
    );
  });

  it("asks for confirmation before unbinding", async () => {
    vi.mocked(listBoundContacts).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: [boundContact],
    });

    await handleEvents([
      postbackEvent(`action=sos_unbind&cid=${boundContact.contactId}`),
    ]);

    expect(vi.mocked(buildUnbindConfirmMessage)).toHaveBeenCalledWith(
      boundContact,
    );
    expect(vi.mocked(unbindContact)).not.toHaveBeenCalled();
  });

  it("rejects a contact id that is not one of the caller's bindings", async () => {
    vi.mocked(listBoundContacts).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: [boundContact],
    });

    await handleEvents([
      postbackEvent("action=sos_unbind&cid=68f0000000000000000000bb"),
    ]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_CONTACT_NOT_FOUND,
    );
    expect(vi.mocked(buildUnbindConfirmMessage)).not.toHaveBeenCalled();
  });

  it("unbinds on confirmation", async () => {
    vi.mocked(unbindContact).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: LINE_MSG.SOS_UNBIND_DONE,
      data: { ownerName: "王小明" },
    });

    await handleEvents([
      postbackEvent(`action=sos_unbind_do&cid=${boundContact.contactId}`),
    ]);

    expect(vi.mocked(unbindContact)).toHaveBeenCalledWith({
      lineUserId: "U1",
      contactId: boundContact.contactId,
    });
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_UNBIND_DONE,
    );
  });

  it("answers an unknown sos_ action with the info message", async () => {
    await handleEvents([postbackEvent("action=sos_unknown")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
  });

  it("refuses menu postbacks without an identified user and never queries", async () => {
    await handleEvents([groupPostbackEvent("action=sos_contacts")]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith("rp", LINE_MSG.INFO);
    expect(vi.mocked(listBoundContacts)).not.toHaveBeenCalled();
    expect(vi.mocked(listSosHistory)).not.toHaveBeenCalled();
  });
});

describe("line.service — pending display-name edit", () => {
  const contactId = "68f0000000000000000000aa";

  it("starts the edit only for the caller's own binding", async () => {
    vi.mocked(listBoundContacts).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "OK",
      data: [
        {
          contactId,
          contactName: "小明",
          ownerId: "u1",
          ownerName: "王小明",
        },
      ],
    });

    await handleEvents([
      postbackEvent(`action=sos_contact_rename&cid=${contactId}`),
    ]);

    expect(vi.mocked(setPendingRename)).toHaveBeenCalledWith("U1", contactId);
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "rp",
      LINE_MSG.SOS_RENAME_PROMPT,
    );
  });

  it("applies the next message as the new name and clears the slot", async () => {
    vi.mocked(getPendingRename).mockResolvedValue(contactId);
    vi.mocked(renameBoundContact).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "已將顯示名稱改為「阿明」。",
      data: { name: "阿明" },
    });

    await handleEvents([textEvent(" 阿明 ")]);

    expect(vi.mocked(renameBoundContact)).toHaveBeenCalledWith({
      lineUserId: "U1",
      contactId,
      name: "阿明",
    });
    expect(vi.mocked(clearPendingRename)).toHaveBeenCalledWith("U1");
    expect(vi.mocked(runLineAgent)).not.toHaveBeenCalled();
  });

  it("keeps the slot when the name is rejected", async () => {
    vi.mocked(getPendingRename).mockResolvedValue(contactId);
    vi.mocked(renameBoundContact).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.INVALID_INPUT,
      message: LINE_MSG.SOS_RENAME_INVALID,
    });

    await handleEvents([textEvent("x".repeat(60))]);

    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r1",
      LINE_MSG.SOS_RENAME_INVALID,
    );
    expect(vi.mocked(clearPendingRename)).not.toHaveBeenCalled();
  });

  it("cancels on the cancel word without renaming", async () => {
    vi.mocked(getPendingRename).mockResolvedValue(contactId);

    await handleEvents([textEvent("取消")]);

    expect(vi.mocked(renameBoundContact)).not.toHaveBeenCalled();
    expect(vi.mocked(clearPendingRename)).toHaveBeenCalledWith("U1");
    expect(vi.mocked(replyText)).toHaveBeenCalledWith(
      "r1",
      LINE_MSG.SOS_RENAME_CANCELLED,
    );
  });

  it("lets the menu trigger win over a pending edit", async () => {
    vi.mocked(getPendingRename).mockResolvedValue(contactId);

    await handleEvents([textEvent("SOS資訊查詢")]);

    expect(vi.mocked(renameBoundContact)).not.toHaveBeenCalled();
    expect(vi.mocked(replyMessages)).toHaveBeenCalledWith("r1", [
      { type: "text", text: "menu" },
    ]);
  });
});
