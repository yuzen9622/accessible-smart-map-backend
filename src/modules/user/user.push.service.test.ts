import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./user.push-token.repository", () => ({
  upsertPushToken: vi.fn(),
  deletePushTokenForUser: vi.fn(),
  findPushTokensByUserId: vi.fn(),
  deletePushTokens: vi.fn(),
}));
vi.mock("./user.auth-session.repository", () => ({
  findActiveSessionsByUserId: vi.fn(),
}));
vi.mock("../../adapters/expo-push.adapter", () => ({
  sendExpoPushMessages: vi.fn(),
}));

import {
  deletePushTokens,
  findPushTokensByUserId,
} from "./user.push-token.repository";
import { findActiveSessionsByUserId } from "./user.auth-session.repository";
import { sendExpoPushMessages } from "../../adapters/expo-push.adapter";
import { pickLocale, sendPushToUser } from "./user.push.service";

const USER_ID = "u1";
const LIVE_SID = "s-live";
const ENDED_SID = "s-ended";

function token(value: string, authSessionId: string, locale = "zh-TW") {
  return {
    _id: value,
    token: value,
    userId: USER_ID,
    authSessionId,
    platform: "ios",
    locale,
  } as never;
}

const build = (locale: string) => ({
  title: `t:${locale}`,
  body: `b:${locale}`,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(deletePushTokens).mockImplementation(async (t) => t.length);
  vi.mocked(findActiveSessionsByUserId).mockResolvedValue([
    { _id: LIVE_SID } as never,
  ]);
});

describe("sendPushToUser", () => {
  it("sends only to tokens of active sessions and removes the rest", async () => {
    vi.mocked(findPushTokensByUserId).mockResolvedValue([
      token("ExponentPushToken[live]", LIVE_SID, "en"),
      token("ExponentPushToken[old]", ENDED_SID),
    ]);
    vi.mocked(sendExpoPushMessages).mockResolvedValue([
      { status: "ok", id: "r1" },
    ]);

    const res = await sendPushToUser(USER_ID, build, { sessionId: "x" });

    expect(deletePushTokens).toHaveBeenCalledWith([
      expect.objectContaining({
        token: "ExponentPushToken[old]",
        authSessionId: ENDED_SID,
      }),
    ]);
    expect(sendExpoPushMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        to: "ExponentPushToken[live]",
        title: "t:en",
        body: "b:en",
        data: { sessionId: "x" },
      }),
    ]);
    expect(res).toEqual({ sent: 1, removed: 1 });
  });

  it("does not call Expo when every token belongs to an ended session", async () => {
    vi.mocked(findActiveSessionsByUserId).mockResolvedValue([]);
    vi.mocked(findPushTokensByUserId).mockResolvedValue([
      token("ExponentPushToken[old]", LIVE_SID),
    ]);

    const res = await sendPushToUser(USER_ID, build, {});

    expect(sendExpoPushMessages).not.toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, removed: 1 });
  });

  it("removes tokens Expo reports as DeviceNotRegistered and keeps other failures", async () => {
    vi.mocked(findPushTokensByUserId).mockResolvedValue([
      token("ExponentPushToken[a]", LIVE_SID),
      token("ExponentPushToken[b]", LIVE_SID),
      token("ExponentPushToken[c]", LIVE_SID),
    ]);
    vi.mocked(sendExpoPushMessages).mockResolvedValue([
      { status: "ok", id: "r1" },
      {
        status: "error",
        message: "gone",
        details: { error: "DeviceNotRegistered" },
      },
      {
        status: "error",
        message: "too big",
        details: { error: "MessageTooBig" },
      },
    ]);

    const res = await sendPushToUser(USER_ID, build, {});

    expect(deletePushTokens).toHaveBeenLastCalledWith([
      expect.objectContaining({
        token: "ExponentPushToken[b]",
        authSessionId: LIVE_SID,
      }),
    ]);
    expect(res).toEqual({ sent: 1, removed: 1 });
  });

  it("never throws when Expo is unreachable", async () => {
    vi.mocked(findPushTokensByUserId).mockResolvedValue([
      token("ExponentPushToken[a]", LIVE_SID),
    ]);
    vi.mocked(sendExpoPushMessages).mockRejectedValue(new Error("offline"));

    await expect(sendPushToUser(USER_ID, build, {})).resolves.toEqual({
      sent: 0,
      removed: 0,
    });
  });
});

describe("pickLocale", () => {
  const table = { "zh-TW": "zh", en: "en" };

  it("matches exactly, then by language, then falls back to zh-TW", () => {
    expect(pickLocale(table, "en")).toBe("en");
    expect(pickLocale(table, "en-GB")).toBe("en");
    expect(pickLocale(table, "zh-Hant-TW")).toBe("zh");
    expect(pickLocale(table, "ja-JP")).toBe("zh");
  });
});
