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
    loginLocalUser: vi.fn(),
    authenticateWithGoogle: vi.fn(),
    authenticateWithApple: vi.fn(),
    verifyEmail: vi.fn(),
    resetPassword: vi.fn(),
    changePassword: vi.fn(),
    refreshSession: vi.fn(),
    logoutSession: vi.fn(),
  };
});

import {
  buildAuthorizationHeader,
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { stubAuthUserLookup } from "../../../tests/helpers/real-auth";
import { ResponseCode } from "../../types/code";

let app: Awaited<ReturnType<typeof startTestServer>>;
const auth = buildAuthorizationHeader();
const ALLOWED_ORIGIN = "http://localhost:3000";
const ALLOWED_REFERER = "http://localhost:3000/app/page";
const EVIL_ORIGIN = "https://attacker.evil.com";
const EVIL_REFERER = "https://attacker.evil.com/exploit.html";

interface WriterRouteCase {
  name: string;
  path: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  cookie?: string[];
  mobileBody?: Record<string, unknown>;
}

const COOKIE_WRITER_ROUTES: WriterRouteCase[] = [
  {
    name: "login",
    path: "/api/v1/user/auth/login",
    body: { email: "test@example.com", password: "password123" },
  },
  {
    name: "googleAuth",
    path: "/api/v1/user/auth/google",
    body: { idToken: "sample.google.idToken" },
  },
  {
    name: "appleAuth",
    path: "/api/v1/user/auth/apple",
    body: { identityToken: "sample.apple.identityToken" },
  },
  {
    name: "verifyEmail",
    path: "/api/v1/user/auth/verify-email",
    body: { token: "sample-verify-token" },
  },
  {
    name: "resetPassword",
    path: "/api/v1/user/auth/password/reset",
    body: { token: "sample-reset-token", password: "NewPassword123" },
  },
  {
    name: "changePassword",
    path: "/api/v1/user/auth/password",
    headers: { Authorization: auth },
    body: { currentPassword: "OldPassword123", newPassword: "NewPassword123" },
  },
  {
    name: "refresh",
    path: "/api/v1/user/refresh",
    cookie: ["refreshToken=sample-cookie-token"],
    body: {},
    mobileBody: { refreshToken: "sample-mobile-token" },
  },
  {
    name: "logout",
    path: "/api/v1/user/logout",
    cookie: ["refreshToken=sample-cookie-token"],
    body: {},
    mobileBody: { refreshToken: "sample-mobile-token" },
  },
];

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

describe("CSRF Origin/Referer Protection on ALL Web cookie writer routes", () => {
  for (const route of COOKIE_WRITER_ROUTES) {
    describe(`Route: ${route.name} (${route.path})`, () => {
      it("rejects with 403 when both Origin and Referer are missing", async () => {
        let req = request(app).post(route.path);
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }
        if (route.cookie) {
          req = req.set("Cookie", route.cookie);
        }

        const res = await req.send(route.body);

        expect(res.status).toBe(ResponseCode.FORBIDDEN);
        expect(res.headers["cache-control"]).toContain("no-store");
        expect(res.headers["pragma"]).toBe("no-cache");
      });

      it("rejects with 403 when Origin is untrusted", async () => {
        let req = request(app).post(route.path).set("Origin", EVIL_ORIGIN);
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }
        if (route.cookie) {
          req = req.set("Cookie", route.cookie);
        }

        const res = await req.send(route.body);

        expect(res.status).toBe(ResponseCode.FORBIDDEN);
      });

      it("rejects with 403 when Referer is untrusted and Origin is missing", async () => {
        let req = request(app).post(route.path).set("Referer", EVIL_REFERER);
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }
        if (route.cookie) {
          req = req.set("Cookie", route.cookie);
        }

        const res = await req.send(route.body);

        expect(res.status).toBe(ResponseCode.FORBIDDEN);
      });

      it("rejects with 403 when Host: evil.example and Origin: http://evil.example (dynamic host not trusted)", async () => {
        let req = request(app)
          .post(route.path)
          .set("Host", "evil.example")
          .set("Origin", "http://evil.example");
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }
        if (route.cookie) {
          req = req.set("Cookie", route.cookie);
        }

        const res = await req.send(route.body);

        expect(res.status).toBe(ResponseCode.FORBIDDEN);
      });

      it("passes CSRF check (non-403) when Origin is allowlisted", async () => {
        let req = request(app).post(route.path).set("Origin", ALLOWED_ORIGIN);
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }
        if (route.cookie) {
          req = req.set("Cookie", route.cookie);
        }

        const res = await req.send(route.body);

        expect(res.status).not.toBe(ResponseCode.FORBIDDEN);
        expect(res.headers["cache-control"]).toContain("no-store");
      });

      it("passes CSRF check (non-403) when Origin is missing but Referer is allowlisted", async () => {
        let req = request(app).post(route.path).set("Referer", ALLOWED_REFERER);
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }
        if (route.cookie) {
          req = req.set("Cookie", route.cookie);
        }

        const res = await req.send(route.body);

        expect(res.status).not.toBe(ResponseCode.FORBIDDEN);
      });

      it("bypasses Web CSRF check (non-403) when X-Client is mobile", async () => {
        let req = request(app).post(route.path).set("X-Client", "mobile");
        if (route.headers) {
          for (const [k, v] of Object.entries(route.headers)) {
            req = req.set(k, v);
          }
        }

        const bodyToSend = route.mobileBody ?? route.body;
        const res = await req.send(bodyToSend);

        // Mobile does not use cookie transport so Web CSRF check does not block it with 403
        expect(res.status).not.toBe(ResponseCode.FORBIDDEN);
        // Mobile responses also must have Cache-Control: no-store
        expect(res.headers["cache-control"]).toContain("no-store");
      });
    });
  }
});
