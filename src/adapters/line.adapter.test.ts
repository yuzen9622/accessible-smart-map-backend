import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReplyMessage = vi.fn();
const mockShowLoadingAnimation = vi.fn();

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiClient: vi.fn(function MessagingApiClient() {
      return {
        replyMessage: mockReplyMessage,
        multicast: vi.fn(),
        showLoadingAnimation: mockShowLoadingAnimation,
      };
    }),
  },
}));

import {
  buildBoundContactsMessage,
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
      item.action.type === "postback" ? item.action.data : undefined,
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
      item.action.type === "postback" ? item.action.data : undefined,
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
        item.action.type === "postback" ? item.action.data : undefined,
      ),
    ).toEqual(["action=sos_history", "action=sos_history&owner=u2"]);
    expect(
      (unfiltered.quickReply?.items ?? []).map((item) =>
        item.action.type === "postback" ? item.action.data : undefined,
      ),
    ).toEqual(["action=sos_history&owner=u1", "action=sos_history&owner=u2"]);
    expect((filtered.quickReply?.items ?? []).length).toBeLessThanOrEqual(13);
  });
});
