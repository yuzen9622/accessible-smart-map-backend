import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendExpoPushMessages,
  type ExpoPushMessage,
} from "./expo-push.adapter";
import { EXPO_PUSH_SEND_URL } from "../constants/push";

const fetchMock = vi.fn();

function message(i: number): ExpoPushMessage {
  return { to: `ExponentPushToken[${i}]`, title: "t", body: "b" };
}

function okResponse(count: number, offset = 0) {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({
        status: "ok",
        id: `r${offset + i}`,
      })),
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  delete process.env.EXPO_ACCESS_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendExpoPushMessages", () => {
  it.each([
    { status: "ok" },
    { status: "ok", id: "" },
    { status: "ok", id: " " },
    { status: "ok", id: 42 },
  ])("preserves acceptance with an untrackable ticket ID %j", async (raw) => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [raw] }));
    expect(await sendExpoPushMessages([message(0)])).toEqual([
      { status: "ok", id: null },
    ]);
  });

  it.each([null, {}])(
    "rejects malformed ticket %j without losing adjacent accepted tickets",
    async (malformed) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          data: [{ status: "ok", id: "accepted" }, malformed],
        }),
      );
      const tickets = await sendExpoPushMessages([message(0), message(1)]);
      expect(tickets[0]).toEqual({ status: "ok", id: "accepted" });
      expect(tickets[1]).toEqual({
        status: "error",
        message: "Invalid Expo push ticket response",
      });
    },
  );

  it("batches at 100 messages per request and keeps ticket order", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(100))
      .mockResolvedValueOnce(okResponse(5, 100));
    const messages = Array.from({ length: 105 }, (_, i) => message(i));

    const tickets = await sendExpoPushMessages(messages);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(EXPO_PUSH_SEND_URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toHaveLength(5);
    expect(tickets).toHaveLength(105);
    expect(tickets[104]).toEqual({ status: "ok", id: "r104" });
  });

  it("sends the access token only when configured", async () => {
    fetchMock.mockImplementation(async () => okResponse(1));

    await sendExpoPushMessages([message(0)]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    process.env.EXPO_ACCESS_TOKEN = "secret";
    await sendExpoPushMessages([message(0)]);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer secret",
    );
  });

  it("turns a failed batch into error tickets without losing the other batches", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(100)).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }],
        }),
        { status: 400 },
      ),
    );
    const messages = Array.from({ length: 102 }, (_, i) => message(i));

    const tickets = await sendExpoPushMessages(messages);

    expect(tickets).toHaveLength(102);
    expect(tickets[99]).toEqual({ status: "ok", id: "r99" });
    expect(tickets[100]).toEqual({
      status: "error",
      message: expect.stringMatching(/HTTP 400: PUSH_TOO_MANY_EXPERIENCE_IDS/),
    });
  });

  it("rejects a response whose ticket count does not match the batch", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(1));

    const tickets = await sendExpoPushMessages([message(0), message(1)]);

    expect(tickets.map((t) => t.status)).toEqual(["error", "error"]);
  });
});
