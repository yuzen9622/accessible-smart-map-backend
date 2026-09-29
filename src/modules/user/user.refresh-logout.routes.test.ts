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

vi.mock("./user.middleware", async (importActual) => {
  const actual = await importActual<typeof import("./user.middleware")>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) =>
    next();
  return {
    ...actual,
    loginLimiter: passthrough,
    registerLimiter: passthrough,
    resendLimiter: passthrough,
    forgotLimiter: passthrough,
    resetLimiter: passthrough,
    passwordLimiter: passthrough,
    refreshLimiter: passthrough,
    logoutLimiter: passthrough,
  };
});

vi.mock("./user.auth.service", async (importActual) => {
  const actual = await importActual<typeof import("./user.auth.service")>();
  return {
    ...actual,
    refreshSession: vi.fn(),
    logoutSession: vi.fn(),
  };
});

import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import * as authService from "./user.auth.service";
import { ResponseCode } from "../../types/code";
import { AUTH_MSG } from "../../constants/messages";

import type { IUser } from "../../types";

let app: Awaited<ReturnType<typeof startTestServer>>;
const ORIGIN = "http://localhost:3000";

const MOCK_USER: IUser = {
  _id: "665f1a2b3c4d5e6f7a8b9c0d",
  name: "Jane",
  email: "jane@example.com",
  authProviders: ["local"],
  emailVerified: true,
  tokenVersion: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/v1/user/refresh", () => {
  describe("Web mode (cookie transport)", () => {
    it("returns 200, sets 7d httpOnly cookie, and NEVER leaks refreshToken in JSON body", async () => {
      vi.mocked(authService.refreshSession).mockResolvedValue({
        ok: true,
        user: MOCK_USER,
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      });

      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-old-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.OK);
      expect(res.body.accessToken).toBe("new-access-token");
      expect(res.body.refreshToken).toBeUndefined(); // Web NEVER receives refreshToken in JSON body!
      expect(res.body.data.user.email).toBe("jane@example.com");

      // Verify Set-Cookie header
      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie)
        ? setCookie.join(";")
        : String(setCookie);
      expect(cookieStr).toContain("refreshToken=new-refresh-token");
      expect(cookieStr).toContain("HttpOnly");
      expect(cookieStr).toContain("Max-Age=604800"); // 7d in seconds

      // Verify Cache-Control
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.headers["pragma"]).toBe("no-cache");
    });

    it("rejects with 400 when body contains refreshToken in Web mode (mixed sources)", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=cookie-token"])
        .send({ refreshToken: "body-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.MIXED_TOKEN_SOURCES);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects with 403 when both Origin and Referer are missing", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Cookie", ["refreshToken=some-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.FORBIDDEN);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects with 403 when Origin is untrusted", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Origin", "https://malicious-attacker.com")
        .set("Cookie", ["refreshToken=some-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.FORBIDDEN);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("accepts when Origin is missing but Referer is allowlisted", async () => {
      vi.mocked(authService.refreshSession).mockResolvedValue({
        ok: true,
        user: MOCK_USER,
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      });

      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Referer", "http://localhost:3000/app/dashboard")
        .set("Cookie", ["refreshToken=valid-old-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.OK);
    });

    it("returns 401 without cookie mutation when cookie is missing", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Origin", ORIGIN)
        .send({});

      expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("CRITICAL: 401 (e.g. grace period or invalid) NEVER clears winner's cookie (no Set-Cookie Max-Age=0)", async () => {
      // Late loser or invalid refresh returns 401
      vi.mocked(authService.refreshSession).mockResolvedValue({
        ok: false,
        reason: "GRACE_PERIOD",
      });

      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=loser-token-in-race"])
        .send({});

      expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
      // Late loser response MUST NOT clear cookie, protecting the winner's newly set cookie!
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  });

  describe("Authorization header prohibition on refresh", () => {
    it("rejects ANY Authorization header on Web refresh with 400 and zero DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Authorization", "Bearer some-access-token")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects empty Authorization header on Web refresh with 400 and zero DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Authorization", "")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects Authorization header on Mobile refresh with 400 and zero DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Authorization", "Bearer token")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "valid-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects empty Authorization header on Mobile refresh with 400 and zero DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Authorization", "")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "valid-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("precedence: Authorization header returns 400 even with untrusted Origin before CSRF check", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("Authorization", "Bearer token")
        .set("Origin", "https://evil.example")
        .set("Cookie", ["refreshToken=token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });
  });

  describe("Mobile mode (X-Client: mobile, body transport)", () => {
    it("returns 200 with refreshToken in JSON body and NEVER sets Set-Cookie", async () => {
      vi.mocked(authService.refreshSession).mockResolvedValue({
        ok: true,
        user: MOCK_USER,
        accessToken: "mobile-new-access",
        refreshToken: "mobile-new-refresh",
      });

      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "valid-mobile-refresh-token" });

      expect(res.status).toBe(ResponseCode.OK);
      expect(res.body.accessToken).toBe("mobile-new-access");
      expect(res.body.refreshToken).toBe("mobile-new-refresh"); // Mobile receives refreshToken in body
      expect(res.headers["set-cookie"]).toBeUndefined(); // Mobile NEVER receives Set-Cookie!

      // Verify Cache-Control
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.headers["pragma"]).toBe("no-cache");
    });

    it("rejects with 400 when a mobile request sends a refresh cookie (mixed sources)", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Cookie", ["refreshToken=rogue-cookie"])
        .send({ refreshToken: "valid-body-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.MIXED_TOKEN_SOURCES);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects with 400 when a mobile request sends an empty refresh cookie key", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Cookie", ["refreshToken="])
        .set("Content-Type", "application/json")
        .send({ refreshToken: "valid-body-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.MIXED_TOKEN_SOURCES);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects with 400 when Content-Type is not application/json (e.g. form-urlencoded)", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send("refreshToken=form-token");

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("rejects with 400 when mobile body shape is invalid or missing refreshToken", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/json")
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(authService.refreshSession).not.toHaveBeenCalled();
    });

    it("returns 401 without Set-Cookie when refreshSession fails on mobile", async () => {
      vi.mocked(authService.refreshSession).mockResolvedValue({
        ok: false,
        reason: "INVALID_TOKEN",
      });

      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "bad-token" });

      expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  });

  describe("Transport header edge cases", () => {
    it("rejects with 400 for unknown X-Client header values", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "desktop")
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.INVALID_CLIENT_HEADER);
    });

    it("rejects with 400 for duplicate X-Client headers", async () => {
      const res = await request(app)
        .post("/api/v1/user/refresh")
        .set("X-Client", "mobile, mobile")
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.INVALID_CLIENT_HEADER);
    });

    it("rejects with 400 for unknown X-Client header on logout", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "desktop")
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.INVALID_CLIENT_HEADER);
    });

    it("rejects with 400 for duplicate X-Client header on logout", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile, mobile")
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.INVALID_CLIENT_HEADER);
    });
  });
});

describe("POST /api/v1/user/logout", () => {
  describe("Authorization header prohibition (FROZEN USER DECISION)", () => {
    it("rejects ANY Authorization header on logout with 400 and ZERO DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Authorization", "Bearer some-access-token")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.logoutSession).not.toHaveBeenCalled();
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects empty Authorization header on Web logout with 400 and ZERO DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Authorization", "")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.logoutSession).not.toHaveBeenCalled();
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects empty Authorization header on mobile logout with 400 and ZERO DB writes", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile")
        .set("Authorization", "")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "mobile-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });

    it("precedence: Authorization header on logout returns 400 even with untrusted Origin before CSRF check", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Authorization", "Bearer token")
        .set("Origin", "https://evil.example")
        .set("Cookie", ["refreshToken=token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.UNSUPPORTED_AUTH_HEADER);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });
  });

  describe("Web mode logout", () => {
    it("revokes session in DB, clears cookie (Max-Age=0), and returns 200", async () => {
      vi.mocked(authService.logoutSession).mockResolvedValue(true);

      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-cookie-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.OK);
      expect(res.body.message).toBe(AUTH_MSG.LOGOUT_SUCCESS);
      expect(authService.logoutSession).toHaveBeenCalledWith(
        "valid-cookie-token",
      );

      // Verify cookie cleared
      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie)
        ? setCookie.join(";")
        : String(setCookie);
      expect(cookieStr).toContain("refreshToken=;");
      expect(cookieStr).toContain("Max-Age=0");
    });

    it("returns 200 and clears cookie without DB write when cookie is missing or empty", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Origin", ORIGIN)
        .send({});

      expect(res.status).toBe(ResponseCode.OK);
      expect(res.body.message).toBe(AUTH_MSG.LOGOUT_SUCCESS);
      expect(authService.logoutSession).not.toHaveBeenCalled();

      // Cookie is still cleared
      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
    });

    it("rejects with 400 when Web mode logout sends refreshToken in body", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Origin", ORIGIN)
        .send({ refreshToken: "body-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.MIXED_TOKEN_SOURCES);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });

    it("rejects with 403 when CSRF Origin and Referer are both missing on Web logout", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Cookie", ["refreshToken=valid-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.FORBIDDEN);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });

    it("returns 500 and never claims success when DB revocation throws", async () => {
      vi.mocked(authService.logoutSession).mockRejectedValueOnce(
        new Error("Database connection lost"),
      );

      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("Origin", ORIGIN)
        .set("Cookie", ["refreshToken=valid-token"])
        .send({});

      expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
      expect(res.body.message).toBe(AUTH_MSG.LOGOUT_FAILED);
    });
  });

  describe("Mobile mode logout", () => {
    it("revokes session via body token, returns 200, and NEVER touches Set-Cookie", async () => {
      vi.mocked(authService.logoutSession).mockResolvedValue(true);

      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "valid-mobile-token" });

      expect(res.status).toBe(ResponseCode.OK);
      expect(res.body.message).toBe(AUTH_MSG.LOGOUT_SUCCESS);
      expect(authService.logoutSession).toHaveBeenCalledWith(
        "valid-mobile-token",
      );
      expect(res.headers["set-cookie"]).toBeUndefined(); // Mobile never touches Set-Cookie!
    });

    it("rejects with 400 if mobile logout sends a refresh cookie", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile")
        .set("Cookie", ["refreshToken=cookie-token"])
        .send({ refreshToken: "body-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.MIXED_TOKEN_SOURCES);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });

    it("rejects with 400 if mobile logout sends an empty refresh cookie key", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile")
        .set("Cookie", ["refreshToken="])
        .set("Content-Type", "application/json")
        .send({ refreshToken: "body-token" });

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(res.body.message).toBe(AUTH_MSG.MIXED_TOKEN_SOURCES);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });

    it("rejects with 400 if mobile logout sends form-urlencoded body", async () => {
      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send("refreshToken=form-token");

      expect(res.status).toBe(ResponseCode.INVALID_INPUT);
      expect(authService.logoutSession).not.toHaveBeenCalled();
    });

    it("returns 500 when DB revocation fails for mobile logout", async () => {
      vi.mocked(authService.logoutSession).mockRejectedValueOnce(
        new Error("Database write error"),
      );

      const res = await request(app)
        .post("/api/v1/user/logout")
        .set("X-Client", "mobile")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "valid-mobile-token" });

      expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
      expect(res.body.message).toBe(AUTH_MSG.LOGOUT_FAILED);
    });
  });
});
