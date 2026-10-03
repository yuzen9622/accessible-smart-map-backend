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

vi.mock("./user.account.service", async (importActual) => ({
  ...(await importActual<typeof import("./user.account.service")>()),
  deleteAccount: vi.fn(),
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
import * as accountService from "./user.account.service";
import { ResponseCode } from "../../types/code";
import { ACCOUNT_MSG } from "../../constants/messages";

let app: Awaited<ReturnType<typeof startTestServer>>;
const URL = "/api/v1/user";
const auth = buildAuthorizationHeader();

const deleteAccount = vi.mocked(accountService.deleteAccount);

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

describe("DELETE /user", () => {
  it("deletes the caller's account using the current session", async () => {
    deleteAccount.mockResolvedValue({ ok: true });

    const res = await request(app).delete(URL).set("Authorization", auth);

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe(ACCOUNT_MSG.DELETED);
    expect(deleteAccount).toHaveBeenCalledWith({
      userId: "test-user-id",
      sessionId: DEFAULT_AUTH_SESSION_ID,
    });
    expect(String(res.headers["set-cookie"])).toMatch(/refreshToken=;/);
  });

  it("leaves cookies alone for mobile clients", async () => {
    deleteAccount.mockResolvedValue({ ok: true });

    const res = await request(app)
      .delete(URL)
      .set("Authorization", auth)
      .set("X-Client", "mobile");

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("asks for a fresh sign-in when the session is not recent", async () => {
    deleteAccount.mockResolvedValue({ ok: false, reason: "REAUTH_REQUIRED" });

    const res = await request(app).delete(URL).set("Authorization", auth);

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(res.body.message).toBe(ACCOUNT_MSG.REAUTH_REQUIRED);
    expect(res.body.data).toEqual({ reason: "REAUTH_REQUIRED" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("returns 404 when the account is already gone", async () => {
    deleteAccount.mockResolvedValue({ ok: false, reason: "NOT_FOUND" });

    const res = await request(app).delete(URL).set("Authorization", auth);

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.data).toEqual({ reason: "NOT_FOUND" });
  });

  it("returns 500 when deletion fails", async () => {
    deleteAccount.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).delete(URL).set("Authorization", auth);

    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
  });

  it("passes the Apple authorization code through", async () => {
    deleteAccount.mockResolvedValue({ ok: true });

    const res = await request(app)
      .delete(URL)
      .set("Authorization", auth)
      .send({ appleAuthorizationCode: "c0de" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(deleteAccount).toHaveBeenCalledWith({
      userId: "test-user-id",
      sessionId: DEFAULT_AUTH_SESSION_ID,
      appleAuthorizationCode: "c0de",
    });
  });

  it.each([
    ["an unknown field", { userId: "someone-else" }],
    ["an empty Apple code", { appleAuthorizationCode: "" }],
  ])("rejects %s", async (_label, body) => {
    const res = await request(app)
      .delete(URL)
      .set("Authorization", auth)
      .send(body);

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it.each([
    [
      "APPLE_AUTHORIZATION_REQUIRED",
      ResponseCode.FORBIDDEN,
      ACCOUNT_MSG.APPLE_AUTHORIZATION_REQUIRED,
    ],
    [
      "APPLE_AUTHORIZATION_INVALID",
      ResponseCode.FORBIDDEN,
      ACCOUNT_MSG.APPLE_AUTHORIZATION_INVALID,
    ],
    [
      "APPLE_REVOKE_UNAVAILABLE",
      ResponseCode.SERVICE_UNAVAILABLE,
      ACCOUNT_MSG.APPLE_REVOKE_UNAVAILABLE,
    ],
  ] as const)("maps %s", async (reason, status, message) => {
    deleteAccount.mockResolvedValue({ ok: false, reason });

    const res = await request(app).delete(URL).set("Authorization", auth);

    expect(res.status).toBe(status);
    expect(res.body.message).toBe(message);
    expect(res.body.data).toEqual({ reason });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await request(app).delete(URL);

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(deleteAccount).not.toHaveBeenCalled();
  });
});
