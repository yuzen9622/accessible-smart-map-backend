import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReplyMessage = vi.fn();
const mockShowLoadingAnimation = vi.fn();
const mockPushMessage = vi.fn();
const mockMulticast = vi.fn();

vi.mock("@line/bot-sdk", () => {
  class HTTPFetchError extends Error {
    constructor(
      public status: number,
      public body: string,
    ) {
      super(`HTTP ${status}`);
    }
  }
  return {
    HTTPFetchError,
    messagingApi: {
      MessagingApiClient: vi.fn(function MessagingApiClient() {
        return {
          replyMessage: mockReplyMessage,
          pushMessage: mockPushMessage,
          multicast: mockMulticast,
          showLoadingAnimation: mockShowLoadingAnimation,
        };
      }),
    },
  };
});

import { HTTPFetchError } from "@line/bot-sdk";
import {
  buildActiveSosMessage,
  buildClaimedControlsMessage,
  pushSosResolved,
  replyMessages,
  sendSosNotification,
  sendSosResolved,
  buildBoundContactsMessage,
  buildSosActionSelectionMessage,
  buildSosHistoryMessage,
  buildSosMenuMessage,
  buildUnbindConfirmMessage,
  replyAgentResult,
  showLoadingAnimation,
} from "./line.adapter";

beforeEach(() => {
  vi.clearAllMocks();
  mockReplyMessage.mockResolvedValue(undefined);
  mockShowLoadingAnimation.mockResolvedValue({});
  mockPushMessage.mockResolvedValue({});
  mockMulticast.mockResolvedValue({});
});

describe("line.adapter — SOS target selection", () => {
  it("uses bounded quick replies with event-specific ids, type, time and page controls", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      ownerName: "同名親友",
      type: "body" as const,
      createdAt: new Date("2026-10-12T00:00:00Z"),
    }));
    const message = buildSosActionSelectionMessage("claim", {
      bound: true,
      sessions,
      hasMore: true,
      offset: 10,
    });
    expect(message.quickReply?.items).toHaveLength(12);
    expect(message.text).toContain("2026-10-12 08:00");
    expect(message.text).toContain("人身安全");
    const buttons = message.quickReply!.items!;
    expect(buttons[0].action).toMatchObject({
      type: "postback",
      data: "action=claim&sid=s0",
    });
    expect(buttons[9].action).toMatchObject({
      type: "postback",
      data: "action=claim&sid=s9",
    });
    expect(buttons[10].action).toMatchObject({
      data: "action=sos_action_page&intent=claim&offset=20",
    });
    expect(buttons[11].action).toMatchObject({
      data: "action=sos_action_page&intent=claim&offset=0",
    });
  });

  it("lets an emptied later page restart without inventing a target", () => {
    const message = buildSosActionSelectionMessage("ack", {
      bound: true,
      sessions: [],
      hasMore: false,
      offset: 10,
    });
    expect(message.quickReply?.items).toHaveLength(1);
    expect(message.quickReply?.items?.[0].action).toMatchObject({
      data: "action=sos_action_page&intent=ack&offset=0",
    });
  });
});

describe("line.adapter — agent replies", () => {
  it("replies with speech text and a route Flex Message", async () => {
    await replyAgentResult("reply-token", "我幫你找到可前往的路線。", {
      origin: "你分享的位置",
      destination: "台北車站",
      options: [
        { label: "無障礙路線", time: "約 12 分鐘", detail: "步行 → 公車 307" },
      ],
      liffUrl: "https://liff.example.com/route?sessionId=s1",
    });

    expect(mockReplyMessage).toHaveBeenCalledWith({
      replyToken: "reply-token",
      messages: [
        { type: "text", text: "我幫你找到可前往的路線。" },
        expect.objectContaining({
          type: "flex",
          altText: "路線規劃結果",
          contents: expect.objectContaining({
            type: "bubble",
            footer: expect.objectContaining({
              contents: [
                expect.objectContaining({
                  type: "button",
                  action: expect.objectContaining({
                    type: "uri",
                    label: "查看地圖",
                    uri: "https://liff.example.com/route?sessionId=s1",
                  }),
                }),
              ],
            }),
          }),
        }),
      ],
    });
  });
});

describe("line.adapter — showLoadingAnimation", () => {
  it("requests the maximum 60s loading animation for the chat", async () => {
    await showLoadingAnimation("U1");

    expect(mockShowLoadingAnimation).toHaveBeenCalledWith({
      chatId: "U1",
      loadingSeconds: 60,
    });
  });

  it("swallows an immediately rejecting client call", async () => {
    mockShowLoadingAnimation.mockRejectedValue(new Error("line down"));

    await expect(showLoadingAnimation("U1")).resolves.toBeUndefined();
  });

  it("returns within the timeout bound when the client call never settles", async () => {
    vi.useFakeTimers();
    try {
      mockShowLoadingAnimation.mockReturnValue(new Promise<never>(() => {}));

      const pending = showLoadingAnimation("U1");
      await vi.advanceTimersByTimeAsync(2000);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no pending timer when the client call settles quickly", async () => {
    vi.useFakeTimers();
    try {
      mockShowLoadingAnimation.mockResolvedValue({});

      await showLoadingAnimation("U1");

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("line.adapter — SOS menu builders", () => {
  const contact = {
    contactId: "68f0000000000000000000aa",
    contactName: "小明",
    ownerId: "u1",
    ownerName: "王小明",
    updatedAt: new Date("2026-07-01T04:00:00Z"),
  };

  it("builds the four menu entries as postbacks", () => {
    const message = buildSosMenuMessage();
    const data = (message.quickReply?.items ?? []).map((item) =>
      item.action?.type === "postback" ? item.action.data : undefined,
    );

    expect(data).toEqual([
      "action=sos_contacts",
      "action=sos_bind_start",
      "action=sos_help",
      "action=sos_history",
    ]);
    expect(data.every((entry) => (entry ?? "").length <= 300)).toBe(true);
  });

  it("gives every bound contact a rename and an unbind postback", () => {
    const message = buildBoundContactsMessage([contact]);
    const carousel = message.contents as { contents: any[] };
    const buttons = carousel.contents[0].footer.contents;

    expect(carousel.contents).toHaveLength(1);
    expect(buttons.map((button: any) => button.action.data)).toEqual([
      `action=sos_contact_rename&cid=${contact.contactId}`,
      `action=sos_unbind&cid=${contact.contactId}`,
    ]);
  });

  it("caps the contacts carousel at ten bubbles", () => {
    const contacts = Array.from({ length: 14 }, (_, index) => ({
      ...contact,
      contactId: `68f00000000000000000${String(index).padStart(4, "0")}`,
    }));

    const carousel = buildBoundContactsMessage(contacts).contents as {
      contents: unknown[];
    };

    expect(carousel.contents).toHaveLength(10);
  });

  it("asks for confirmation with a distinct confirm postback", () => {
    const message = buildUnbindConfirmMessage(contact);
    const data = (message.quickReply?.items ?? []).map((item) =>
      item.action?.type === "postback" ? item.action.data : undefined,
    );

    expect(data).toEqual([
      `action=sos_unbind_do&cid=${contact.contactId}`,
      "action=sos_menu",
    ]);
  });

  it("offers an all-owners chip only while a filter is active", () => {
    const entries = [
      {
        sessionId: "s1",
        ownerId: "u1",
        ownerName: "王小明",
        type: "body" as const,
        status: "resolved" as const,
        handlingStatus: "resolved",
        address: "台北車站",
        createdAt: new Date("2026-07-01T04:00:00Z"),
        resolvedAt: new Date("2026-07-01T04:30:00Z"),
        claimedByName: "小明",
      },
    ];
    const owners = [
      { ownerId: "u1", ownerName: "王小明" },
      { ownerId: "u2", ownerName: "李小華" },
    ];

    const filtered = buildSosHistoryMessage({
      entries,
      owners,
      activeOwnerId: "u1",
    });
    const unfiltered = buildSosHistoryMessage({ entries, owners });

    expect(
      (filtered.quickReply?.items ?? []).map((item) =>
        item.action?.type === "postback" ? item.action.data : undefined,
      ),
    ).toEqual(["action=sos_history", "action=sos_history&owner=u2"]);
    expect(
      (unfiltered.quickReply?.items ?? []).map((item) =>
        item.action?.type === "postback" ? item.action.data : undefined,
      ),
    ).toEqual(["action=sos_history&owner=u1", "action=sos_history&owner=u2"]);
    expect((filtered.quickReply?.items ?? []).length).toBeLessThanOrEqual(13);
  });
});

describe("line.adapter — reply fallback", () => {
  const messages = [{ type: "text" as const, text: "hi" }];

  it("pushes when a slow reply outlived the reply token", async () => {
    mockReplyMessage.mockRejectedValue(
      new (HTTPFetchError as any)(400, '{"message":"Invalid reply token"}'),
    );
    await replyMessages("rt", messages, "U1");
    expect(mockPushMessage).toHaveBeenCalledWith({ to: "U1", messages });
  });

  it("does not push on other failures (the reply may have been delivered)", async () => {
    mockReplyMessage.mockRejectedValue(new (HTTPFetchError as any)(500, ""));
    await replyMessages("rt", messages, "U1");
    expect(mockPushMessage).not.toHaveBeenCalled();
  });

  it("does not push without a fallback user", async () => {
    mockReplyMessage.mockRejectedValue(
      new (HTTPFetchError as any)(400, "Invalid reply token"),
    );
    await replyMessages("rt", messages);
    expect(mockPushMessage).not.toHaveBeenCalled();
  });
});

describe("line.adapter — app-aware live location links", () => {
  it("opens the notification's tracking link outside LINE so the app can claim it", async () => {
    await sendSosNotification(
      ["U1"],
      {
        sessionId: "64b7f0c2a1b2c3d4e5f60718",
        type: "body",
        trackingUrl: "https://map.example.com/zh-TW/sos/?token=abc",
      },
      "retry",
      1000,
    );
    const flex = mockMulticast.mock.calls[0][0].messages[0];
    const uris = JSON.stringify(flex).match(/"uri":"[^"]+"/g);
    expect(uris).toEqual([
      '"uri":"https://map.example.com/zh-TW/sos/?token=abc&openExternalBrowser=1"',
    ]);
  });

  it("status cards link by tracking URL and claim by session id", () => {
    const message = buildActiveSosMessage([
      {
        sessionId: "64b7f0c2a1b2c3d4e5f60718",
        shareToken: "t",
        ownerName: "媽媽",
        type: "body",
        address: null,
        handlingStatus: "notified",
        claimedByName: null,
        locationUpdatedAt: new Date("2026-10-12T10:00:00Z"),
        trackingUrl: "https://map.example.com/zh-TW/sos/?token=t",
      },
    ]);
    const json = JSON.stringify(message);
    expect(json).toContain("openExternalBrowser=1");
    expect(json).toContain("action=claim&sid=64b7f0c2a1b2c3d4e5f60718");
    expect(json).toContain("action=sos_route&sid=64b7f0c2a1b2c3d4e5f60718");
    expect(message.quickReply?.items?.[0]?.action?.type).toBe("location");
  });

  it("hides the claim button once someone is handling it", () => {
    const json = JSON.stringify(
      buildActiveSosMessage([
        {
          sessionId: "s1",
          shareToken: "t",
          ownerName: "媽媽",
          type: "body",
          address: null,
          handlingStatus: "claimed",
          claimedByName: "小明",
          locationUpdatedAt: new Date(),
          trackingUrl: "https://map.example.com/zh-TW/sos/?token=t",
        },
      ]),
    );
    expect(json).not.toContain("action=claim");
    expect(json).toContain("小明");
  });

  it("claimed controls start with LINE's share-location picker", () => {
    const items = buildClaimedControlsMessage("s1").quickReply?.items ?? [];
    expect(items[0].action).toEqual({
      type: "location",
      label: "分享我的位置",
    });
  });
});

describe("line.adapter — SOS resolved notice", () => {
  function sentTexts(): string[] {
    const message = mockMulticast.mock.calls[0][0].messages[0];
    return [
      message.altText,
      ...message.contents.body.contents.map((c: { text: string }) => c.text),
    ];
  }

  it("tells contacts a manually resolved SOS is safe", async () => {
    await sendSosResolved(["U1"], "小明");
    expect(sentTexts().join("\n")).toContain("目前平安");
  });

  it("never claims an auto-resolved stale SOS is safe and dates the original alert", async () => {
    await pushSosResolved(
      ["U1"],
      "retry-key",
      1000,
      {
        startedAt: new Date("2026-10-13T04:07:00Z"),
        locationUpdatedAt: new Date("2026-10-13T04:10:00Z"),
      },
      "小明",
    );
    const text = sentTexts().join("\n");
    expect(text).not.toContain("平安。");
    expect(text).not.toContain("求救已解除");
    expect(text).toContain("2026-10-13 12:07");
    expect(text).toContain("2026-10-13 12:10");
    expect(text).toContain("請直接聯絡");
  });
});
