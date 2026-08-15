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

vi.mock("./user.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) =>
    next();
  return {
    loginLimiter: passthrough,
    registerLimiter: passthrough,
    resendLimiter: passthrough,
    forgotLimiter: passthrough,
    resetLimiter: passthrough,
    passwordLimiter: passthrough,
  };
});

vi.mock("./user.auth.service", async (importActual) => {
  const actual = await importActual<typeof import("./user.auth.service")>();
  return {
    ...actual,
    registerLocalUser: vi.fn(),
    loginLocalUser: vi.fn(),
    authenticateWithGoogle: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerificationEmail: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    changePassword: vi.fn(),
  };
});

import {
  buildAuthorizationHeader,
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { stubAuthUserLookup } from "../../../tests/helpers/real-auth";
import * as service from "./user.auth.service";
import { AuthError } from "./user.auth.service";
import { ResponseCode } from "../../types/code";
import { AUTH_MSG } from "../../constants/messages";

let app: Awaited<ReturnType<typeof startTestServer>>;
const BASE = "/api/v1/user/auth";
const auth = buildAuthorizationHeader();

const USER = {
  _id: "665f1a2b3c4d5e6f7a8b9c0d",
  name: "Jane",
  email: "jane@example.com",
  client_id: null,
  authProviders: ["local"],
  emailVerified: true,
  tokenVersion: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as any;

const SESSION = { user: USER, config: null };

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
  // Real auth path for the protected POST /auth/password endpoint: the JWT is
  // verified for real, and only the User.findById DB seam is stubbed.
  stubAuthUserLookup();
});

describe("POST /user/auth/register", () => {
  it("returns 200 and no token, because login requires verification first", async () => {
    vi.mocked(service.registerLocalUser).mockResolvedValue({ emailSent: true });

    const res = await request(app).post(`${BASE}/register`).send({
      name: "Jane",
      email: "jane@example.com",
      password: "taipei2026",
    });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(AUTH_MSG.REGISTERED);
    expect(res.body.data).toEqual({ emailSent: true });
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("still succeeds but says so when the verification email could not be sent", async () => {
    vi.mocked(service.registerLocalUser).mockResolvedValue({
      emailSent: false,
    });

    const res = await request(app).post(`${BASE}/register`).send({
      name: "Jane",
      email: "jane@example.com",
      password: "taipei2026",
    });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(AUTH_MSG.REGISTERED_EMAIL_FAILED);
    expect(res.body.data).toEqual({ emailSent: false });
  });

  it("returns 409 when the email is already registered", async () => {
    vi.mocked(service.registerLocalUser).mockRejectedValue(
      new AuthError("EMAIL_TAKEN"),
    );

    const res = await request(app).post(`${BASE}/register`).send({
      name: "Jane",
      email: "jane@example.com",
      password: "taipei2026",
    });

    expect(res.status).toBe(ResponseCode.CONFLICT);
    expect(res.body.data.reason).toBe("EMAIL_TAKEN");
  });

  it.each([
    ["shorter than 8 characters", "ab1"],
    ["letters only", "abcdefghij"],
    ["digits only", "1234567890"],
    ["longer than 72 bytes", `a1${"x".repeat(71)}`],
  ])("rejects a password that is %s", async (_label, password) => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ name: "Jane", email: "jane@example.com", password });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.registerLocalUser)).not.toHaveBeenCalled();
  });

  it("counts the 72-byte password ceiling in bytes, not characters", async () => {
    // 24 CJK characters are 72 bytes in UTF-8 and must pass; 25 must not.
    const ok = `a1${"字".repeat(23)}`;
    const tooLong = `a1${"字".repeat(24)}`;
    expect(Buffer.byteLength(ok, "utf8")).toBe(71);
    expect(Buffer.byteLength(tooLong, "utf8")).toBe(74);

    vi.mocked(service.registerLocalUser).mockResolvedValue({ emailSent: true });
    const okRes = await request(app)
      .post(`${BASE}/register`)
      .send({ name: "Jane", email: "jane@example.com", password: ok });
    expect(okRes.status).toBe(ResponseCode.OK);

    const longRes = await request(app)
      .post(`${BASE}/register`)
      .send({ name: "Jane", email: "jane@example.com", password: tooLong });
    expect(longRes.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects a malformed email", async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ name: "Jane", email: "not-an-email", password: "taipei2026" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });
});

describe("POST /user/auth/login", () => {
  it("returns 200 with an access token and a refresh cookie", async () => {
    vi.mocked(service.loginLocalUser).mockResolvedValue(SESSION);

    const res = await request(app)
      .post(`${BASE}/login`)
      .send({ email: "jane@example.com", password: "taipei2026" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.accessToken).toBeTruthy();
    expect(String(res.headers["set-cookie"])).toContain("refreshToken=");
    expect(res.body.data.user.email).toBe("jane@example.com");
  });

  it("never leaks the password hash", async () => {
    vi.mocked(service.loginLocalUser).mockResolvedValue({
      user: { ...USER, passwordHash: "$2b$12$leaked" },
      config: null,
    });

    const res = await request(app)
      .post(`${BASE}/login`)
      .send({ email: "jane@example.com", password: "taipei2026" });

    expect(JSON.stringify(res.body)).not.toContain("leaked");
  });

  it("returns the same 401 for a wrong password as for an unknown email", async () => {
    vi.mocked(service.loginLocalUser).mockRejectedValue(
      new AuthError("INVALID_CREDENTIALS"),
    );

    const res = await request(app)
      .post(`${BASE}/login`)
      .send({ email: "nobody@example.com", password: "taipei2026" });

    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
    expect(res.body.message).toBe(AUTH_MSG.INVALID_CREDENTIALS);
    expect(res.body.data.reason).toBe("INVALID_CREDENTIALS");
  });

  it("returns 403 with EMAIL_NOT_VERIFIED for an unverified account", async () => {
    vi.mocked(service.loginLocalUser).mockRejectedValue(
      new AuthError("EMAIL_NOT_VERIFIED"),
    );

    const res = await request(app)
      .post(`${BASE}/login`)
      .send({ email: "jane@example.com", password: "taipei2026" });

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(res.body.data.reason).toBe("EMAIL_NOT_VERIFIED");
  });
});

describe("POST /user/auth/google", () => {
  it("returns 200 with a session for a valid ID token", async () => {
    vi.mocked(service.authenticateWithGoogle).mockResolvedValue(SESSION);

    const res = await request(app)
      .post(`${BASE}/google`)
      .send({ idToken: "valid.id.token" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(vi.mocked(service.authenticateWithGoogle)).toHaveBeenCalledWith(
      "valid.id.token",
    );
    expect(res.body.accessToken).toBeTruthy();
  });

  it("returns 401 for an ID token Google does not accept", async () => {
    vi.mocked(service.authenticateWithGoogle).mockRejectedValue(
      new AuthError("INVALID_TOKEN"),
    );

    const res = await request(app)
      .post(`${BASE}/google`)
      .send({ idToken: "forged" });

    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
  });

  it("rejects the legacy client-supplied identity body", async () => {
    const res = await request(app)
      .post(`${BASE}/google`)
      .send({ name: "Jane", email: "victim@example.com", client_id: "12345" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.authenticateWithGoogle)).not.toHaveBeenCalled();
  });
});

describe("POST /user/auth/verify-email", () => {
  it("returns 200 and signs the user in", async () => {
    vi.mocked(service.verifyEmail).mockResolvedValue(SESSION);

    const res = await request(app)
      .post(`${BASE}/verify-email`)
      .send({ token: "raw-token" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(AUTH_MSG.EMAIL_VERIFIED);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("returns 401 for an expired or reused link", async () => {
    vi.mocked(service.verifyEmail).mockRejectedValue(
      new AuthError("INVALID_TOKEN"),
    );

    const res = await request(app)
      .post(`${BASE}/verify-email`)
      .send({ token: "stale" });

    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
    expect(res.body.data.reason).toBe("INVALID_TOKEN");
  });
});

describe("POST /user/auth/verify-email/resend", () => {
  it("returns the same 200 whether or not the address exists", async () => {
    vi.mocked(service.resendVerificationEmail).mockResolvedValue(undefined);

    const res = await request(app)
      .post(`${BASE}/verify-email/resend`)
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(AUTH_MSG.VERIFICATION_SENT);
    expect(res.body.data).toBeUndefined();
  });
});

describe("POST /user/auth/password/forgot", () => {
  it("returns 202 without revealing whether the address is registered", async () => {
    vi.mocked(service.requestPasswordReset).mockResolvedValue(undefined);

    const res = await request(app)
      .post(`${BASE}/password/forgot`)
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(ResponseCode.ACCEPTED);
    expect(res.body.message).toBe(AUTH_MSG.RESET_SENT);
  });

  it("returns 503 when the durable queue cannot accept the request", async () => {
    vi.mocked(service.requestPasswordReset).mockRejectedValue(
      new Error("queue down"),
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await request(app)
      .post(`${BASE}/password/forgot`)
      .send({ email: "jane@example.com" });

    expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
    expect(res.body.message).toBe(AUTH_MSG.RESET_QUEUE_UNAVAILABLE);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("POST /user/auth/password/reset", () => {
  it("returns 200 and a fresh session", async () => {
    vi.mocked(service.resetPassword).mockResolvedValue(SESSION);

    const res = await request(app)
      .post(`${BASE}/password/reset`)
      .send({ token: "raw-token", password: "taipei2026" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(AUTH_MSG.PASSWORD_RESET);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("applies the same password rules as registration", async () => {
    const res = await request(app)
      .post(`${BASE}/password/reset`)
      .send({ token: "raw-token", password: "short" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.resetPassword)).not.toHaveBeenCalled();
  });

  it("returns 401 for a used link", async () => {
    vi.mocked(service.resetPassword).mockRejectedValue(
      new AuthError("INVALID_TOKEN"),
    );

    const res = await request(app)
      .post(`${BASE}/password/reset`)
      .send({ token: "used", password: "taipei2026" });

    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
  });
});

describe("POST /user/auth/password", () => {
  it("rejects an unauthenticated request at the middleware", async () => {
    const res = await request(app)
      .post(`${BASE}/password`)
      .send({ newPassword: "taipei2026" });

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.changePassword)).not.toHaveBeenCalled();
  });

  it("returns 200 with replacement tokens for the caller", async () => {
    vi.mocked(service.changePassword).mockResolvedValue({ user: USER });

    const res = await request(app)
      .post(`${BASE}/password`)
      .set("Authorization", auth)
      .send({ currentPassword: "taipei2026", newPassword: "taipei2027" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(AUTH_MSG.PASSWORD_CHANGED);
    expect(res.body.accessToken).toBeTruthy();
    expect(vi.mocked(service.changePassword)).toHaveBeenCalledWith({
      userId: "test-user-id",
      currentPassword: "taipei2026",
      newPassword: "taipei2027",
    });
  });

  it("returns 401 when the current password is wrong", async () => {
    vi.mocked(service.changePassword).mockRejectedValue(
      new AuthError("INVALID_CREDENTIALS"),
    );

    const res = await request(app)
      .post(`${BASE}/password`)
      .set("Authorization", auth)
      .send({ currentPassword: "wrong", newPassword: "taipei2027" });

    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
  });

  it("returns 400 when the account has a password but none was supplied", async () => {
    vi.mocked(service.changePassword).mockRejectedValue(
      new AuthError("PASSWORD_REQUIRED"),
    );

    const res = await request(app)
      .post(`${BASE}/password`)
      .set("Authorization", auth)
      .send({ newPassword: "taipei2027" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.data.reason).toBe("PASSWORD_REQUIRED");
  });
});

describe("removed endpoints", () => {
  it("no longer exposes POST /user/token", async () => {
    const res = await request(app)
      .post("/api/v1/user/token")
      .send({ token: "anything" });
    expect(res.status).not.toBe(ResponseCode.OK);
  });

  it("no longer accepts the old POST /user/login OAuth body", async () => {
    const res = await request(app)
      .post("/api/v1/user/login")
      .send({ name: "Jane", email: "jane@example.com", client_id: "12345" });
    expect(res.status).not.toBe(ResponseCode.OK);
  });
});
