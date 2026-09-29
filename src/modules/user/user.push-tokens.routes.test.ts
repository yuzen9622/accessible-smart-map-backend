import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

vi.mock("./user.push.service", async (importActual) => ({
  ...(await importActual<typeof import("./user.push.service")>()),
  registerPushToken: vi.fn(),
  unregisterPushToken: vi.fn(),
}));

import {
  buildAuthorizationHeader,
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import {
  DEFAULT_AUTH_SESSION_ID,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";
import * as pushService from "./user.push.service";
import { ResponseCode } from "../../types/code";
import { PUSH_MSG } from "../../constants/messages";

let app: Awaited<ReturnType<typeof startTestServer>>;
const URL = "/api/v1/user/push-tokens";
const auth = buildAuthorizationHeader();
const TOKEN = "ExponentPushToken[abcDEF123_-]";

const registerPushToken = vi.mocked(pushService.registerPushToken);
const unregisterPushToken = vi.mocked(pushService.unregisterPushToken);

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
  stubAuthUserLookup();
});

describe("POST /user/push-tokens", () => {
  it("binds the token to the caller and the current login session", async () => {
    registerPushToken.mockResolvedValue({
      token: TOKEN,
      platform: "ios",
      locale: "zh-TW",
    });

    const res = await request(app)
      .post(URL)
      .set("Authorization", auth)
      .send({ token: TOKEN, platform: "ios" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(PUSH_MSG.REGISTERED);
    expect(res.body.data).toEqual({
      token: TOKEN,
      platform: "ios",
      locale: "zh-TW",
    });
    expect(registerPushToken).toHaveBeenCalledWith({
      userId: "test-user-id",
      authSessionId: DEFAULT_AUTH_SESSION_ID,
      token: TOKEN,
      platform: "ios",
      locale: "zh-TW",
    });
  });

  it.each([
    ["a non-Expo token", { token: "fcm-token-123", platform: "ios" }],
    ["an unknown platform", { token: TOKEN, platform: "web" }],
    ["a malformed locale", { token: TOKEN, platform: "ios", locale: "zh_TW" }],
    [
      "a client-supplied userId",
      { token: TOKEN, platform: "ios", userId: "x" },
    ],
  ])("rejects %s", async (_label, body) => {
    const res = await request(app)
      .post(URL)
      .set("Authorization", auth)
      .send(body);

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(registerPushToken).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post(URL)
      .send({ token: TOKEN, platform: "ios" });

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(registerPushToken).not.toHaveBeenCalled();
  });
});

describe("DELETE /user/push-tokens", () => {
  it("removes the caller's token", async () => {
    unregisterPushToken.mockResolvedValue(true);

    const res = await request(app)
      .delete(URL)
      .set("Authorization", auth)
      .send({ token: TOKEN });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(PUSH_MSG.UNREGISTERED);
    expect(res.body.data).toEqual({ removed: true });
    expect(unregisterPushToken).toHaveBeenCalledWith("test-user-id", TOKEN);
  });

  it("is idempotent for an unknown token", async () => {
    unregisterPushToken.mockResolvedValue(false);

    const res = await request(app)
      .delete(URL)
      .set("Authorization", auth)
      .send({ token: TOKEN });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.data).toEqual({ removed: false });
  });

  it("rejects a missing token", async () => {
    const res = await request(app)
      .delete(URL)
      .set("Authorization", auth)
      .send({});

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(unregisterPushToken).not.toHaveBeenCalled();
  });
});
