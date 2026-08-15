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

/**
 * Auth contract for EVERY route guarded by the production JWT middleware.
 *
 * These tests run the REAL auth path end to end: a real signed JWT is verified
 * by `src/config/jwt.ts`, and `authenticateToken()` in `src/config/auth.ts`
 * performs the real `User.findById` lookup and tokenVersion revocation check.
 * The only seam mocked is the lowest-level DB read (`User.findById`, stubbed
 * via tests/helpers/real-auth.ts); no controller, router, or auth module is
 * mocked. The service modules ARE mocked — the point here is to prove they are
 * never reached when authentication fails.
 *
 * Production status mapping (src/middleware/middleware.ts):
 *   - no token / invalid token / revoked tokenVersion / unknown user → 403
 *   - expired token → 401
 * NOTE: the revocation case answers 403 (not 401) in production because the
 * middleware maps every non-expired failure to FORBIDDEN; that behaviour is
 * frozen by rule (no production status-code changes in this task).
 *
 * ── Protected route inventory (method + full mount path) ──────────────────
 * Mounted behind `middleware` at app.use("/api/v1/user", middleware, ...):
 *   1. POST   /api/v1/user/auth/password              testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only
 *   2. GET    /api/v1/user/info                       testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only
 *   3. POST   /api/v1/user/line-link-code             testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only
 *   4. POST   /api/v1/user/config                     testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only; body user_id is rejected
 *                                                      by the strict schema in
 *                                                      src/modules/user/user.config.routes.test.ts
 *   5. POST   /api/v1/user/config/update              testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only
 *   6. GET    /api/v1/user/a11y-profile               testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only
 *   7. PUT    /api/v1/user/a11y-profile               testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — self only
 *   8. GET    /api/v1/user/emergency-contacts         testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — own list
 *   9. POST   /api/v1/user/emergency-contacts         testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — creates own
 *  10. DELETE /api/v1/user/emergency-contacts/:id     testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in src/modules/emergency-contact/
 *                                                      emergency-contact.routes.test.ts
 * Per-route `middleware`:
 *  11. POST   /api/v1/a11y/reviews                    testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — creates own
 *  12. PATCH  /api/v1/a11y/reviews/:id                testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in src/modules/review/review.routes.test.ts
 *  13. DELETE /api/v1/a11y/reviews/:id                testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in this test file below
 *  14. POST   /api/v1/a11y/visual-a11y/sync           testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — global sync, no user-owned resource
 *  15. POST   /api/v1/sos/sessions                    testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: N/A — creates own
 *  16. PATCH  /api/v1/sos/sessions/:id/location       testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in src/modules/sos/sos.routes.test.ts
 *  17. PATCH  /api/v1/sos/sessions/:id/resolve        testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in this test file below
 *  18. GET    /api/v1/sos/sessions/:id/stream         testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in this test file below
 *  19. GET    /api/v1/sos/sessions/:id                testFile: src/middleware/auth-contract.routes.test.ts;
 *                                                      IDOR: 403 in src/modules/sos/sos.routes.test.ts
 * Not listed: GET /api/v1/sos/sessions/:token/public — deliberately public
 * (share-token endpoint, no middleware).
 */

vi.mock("../modules/user/user.service", () => ({
  getUserById: vi.fn(),
  getUserWithConfig: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getA11yProfile: vi.fn(),
  updateA11yProfile: vi.fn(),
  issueLineLinkCode: vi.fn(),
}));

vi.mock("../modules/user/user.auth.service", async (importActual) => {
  const actual =
    await importActual<typeof import("../modules/user/user.auth.service")>();
  return {
    ...actual,
    authenticateWithGoogle: vi.fn(),
    registerLocalUser: vi.fn(),
    loginLocalUser: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerificationEmail: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    changePassword: vi.fn(),
  };
});

vi.mock("../modules/emergency-contact/emergency-contact.service", () => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  deleteContact: vi.fn(),
}));

vi.mock("../modules/review/review.service", async (importActual) => {
  const actual =
    await importActual<typeof import("../modules/review/review.service")>();
  return {
    ...actual,
    createReview: vi.fn(),
    findByPlace: vi.fn(),
    updateReview: vi.fn(),
    deleteReview: vi.fn(),
    getAiSummary: vi.fn(),
  };
});

vi.mock("../modules/visual-a11y/visual-a11y.service", () => ({
  findNearby: vi.fn(),
  syncFromOverpass: vi.fn(),
}));

vi.mock("../modules/sos/sos.service", () => ({
  createSession: vi.fn(),
  updateLocation: vi.fn(),
  resolveSession: vi.fn(),
  getPublicByToken: vi.fn(),
  getSessionForOwner: vi.fn(),
}));

import {
  startTestServer,
  stopTestServer,
} from "../../tests/helpers/test-helpers";
import {
  bearerFor,
  buildDbUser,
  expiredBearerFor,
  revokedBearerFor,
  stubAuthUserLookup,
} from "../../tests/helpers/real-auth";
import * as userService from "../modules/user/user.service";
import * as authService from "../modules/user/user.auth.service";
import * as contactService from "../modules/emergency-contact/emergency-contact.service";
import * as reviewService from "../modules/review/review.service";
import * as visualA11yService from "../modules/visual-a11y/visual-a11y.service";
import * as sosService from "../modules/sos/sos.service";
import { ResponseCode, ResponseMessage } from "../types/code";
import { SOS_MSG, SOS_REASON, REVIEW_MSG } from "../constants/messages";

let app: Awaited<ReturnType<typeof startTestServer>>;

const SERVICE_NAMESPACES = [
  userService,
  authService,
  contactService,
  reviewService,
  visualA11yService,
  sosService,
];

/**
 * Asserts no mocked service function was invoked — authentication failures must
 * stop the request at the middleware, before any business logic runs.
 */
function expectNoServiceCalls(): void {
  for (const ns of SERVICE_NAMESPACES) {
    for (const [name, fn] of Object.entries(ns)) {
      if (typeof fn === "function" && vi.isMockFunction(fn)) {
        expect(
          fn,
          `service.${name} must not run when authentication fails`,
        ).not.toHaveBeenCalled();
      }
    }
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface ProtectedRoute {
  method: Method;
  path: string;
  /** Request body for methods that carry one (never reaches validation). */
  body?: Record<string, unknown>;
}

/** The 19 middleware-guarded routes from the inventory above. */
const PROTECTED_ROUTES: ProtectedRoute[] = [
  { method: "POST", path: "/api/v1/user/auth/password" },
  { method: "GET", path: "/api/v1/user/info" },
  { method: "POST", path: "/api/v1/user/line-link-code" },
  { method: "POST", path: "/api/v1/user/config", body: {} },
  { method: "POST", path: "/api/v1/user/config/update", body: {} },
  { method: "GET", path: "/api/v1/user/a11y-profile" },
  { method: "PUT", path: "/api/v1/user/a11y-profile", body: {} },
  { method: "GET", path: "/api/v1/user/emergency-contacts" },
  { method: "POST", path: "/api/v1/user/emergency-contacts", body: {} },
  {
    method: "DELETE",
    path: "/api/v1/user/emergency-contacts/507f1f77bcf86cd799439011",
  },
  { method: "POST", path: "/api/v1/a11y/reviews", body: {} },
  { method: "PATCH", path: "/api/v1/a11y/reviews/66a1f2c3e4b5a6d7c8e9f0d4" },
  { method: "DELETE", path: "/api/v1/a11y/reviews/66a1f2c3e4b5a6d7c8e9f0d4" },
  { method: "POST", path: "/api/v1/a11y/visual-a11y/sync" },
  { method: "POST", path: "/api/v1/sos/sessions", body: {} },
  {
    method: "PATCH",
    path: "/api/v1/sos/sessions/6a4e797394fbb1b1721c8b81/location",
    body: {},
  },
  {
    method: "PATCH",
    path: "/api/v1/sos/sessions/6a4e797394fbb1b1721c8b81/resolve",
  },
  {
    method: "GET",
    path: "/api/v1/sos/sessions/6a4e797394fbb1b1721c8b81/stream",
  },
  { method: "GET", path: "/api/v1/sos/sessions/6a4e797394fbb1b1721c8b81" },
];

function hit(route: ProtectedRoute, authHeader?: string) {
  const req = request(app)[route.method.toLowerCase() as Lowercase<Method>](
    route.path,
  );
  if (authHeader) req.set("Authorization", authHeader);
  if (route.body) req.send(route.body);
  return req;
}

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
  // Real auth path: JWT verification + tokenVersion comparison run for real;
  // only the User.findById DB seam is stubbed with a matching tokenVersion.
  stubAuthUserLookup();
});

describe("every protected route rejects authentication failures before any service runs", () => {
  it.each(PROTECTED_ROUTES)(
    "403 $method $path with no Authorization header",
    async (route) => {
      const res = await hit(route);
      expect(res.status).toBe(ResponseCode.FORBIDDEN);
      expect(res.body.message).toBe(ResponseMessage.FORBIDDEN);
      expectNoServiceCalls();
    },
  );

  it.each(PROTECTED_ROUTES)(
    "401 $method $path with an expired token",
    async (route) => {
      const res = await hit(route, expiredBearerFor());
      expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
      expect(res.body.message).toBe(ResponseMessage.UNAUTHORIZED);
      expectNoServiceCalls();
    },
  );

  it.each(PROTECTED_ROUTES)(
    "403 $method $path when the token's tokenVersion is revoked",
    async (route) => {
      // Token carries tokenVersion 999; the stubbed DB user has 0. Production
      // maps this non-expired failure to FORBIDDEN (403).
      const res = await hit(route, revokedBearerFor());
      expect(res.status).toBe(ResponseCode.FORBIDDEN);
      expect(res.body.message).toBe(ResponseMessage.FORBIDDEN);
      expectNoServiceCalls();
    },
  );

  it("403 GET /api/v1/user/info when the user no longer exists (findById → null)", async () => {
    stubAuthUserLookup(null);
    const res = await request(app)
      .get("/api/v1/user/info")
      .set("Authorization", bearerFor());
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expectNoServiceCalls();
  });

  it("200 GET /api/v1/user/info with a valid token reaches the service (control case)", async () => {
    vi.mocked(userService.getUserWithConfig).mockResolvedValue({
      user: buildDbUser(),
      config: null,
    } as never);
    const res = await request(app)
      .get("/api/v1/user/info")
      .set("Authorization", bearerFor());
    expect(res.status).toBe(ResponseCode.OK);
    expect(userService.getUserWithConfig).toHaveBeenCalledTimes(1);
  });
});

describe("tokenVersion revocation regression (deleting the comparison turns this red)", () => {
  it("rejects a token whose tokenVersion does not match the DB user", async () => {
    // Token says tokenVersion 5, the DB user is at 0 → revoked. If the
    // tokenVersion comparison in src/config/auth.ts is removed, this request
    // would authenticate and reach the service, so the assertions below fail.
    stubAuthUserLookup(buildDbUser({ tokenVersion: 0 }));

    const res = await request(app)
      .get("/api/v1/user/info")
      .set("Authorization", bearerFor({ tokenVersion: 5 }));

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(res.body.message).toBe(ResponseMessage.FORBIDDEN);
    expectNoServiceCalls();
  });

  it("accepts the same token once the DB tokenVersion catches up", async () => {
    vi.mocked(userService.getUserWithConfig).mockResolvedValue({
      user: buildDbUser({ tokenVersion: 5 }),
      config: null,
    } as never);
    stubAuthUserLookup(buildDbUser({ tokenVersion: 5 }));

    const res = await request(app)
      .get("/api/v1/user/info")
      .set("Authorization", bearerFor({ tokenVersion: 5 }));

    expect(res.status).toBe(ResponseCode.OK);
  });
});

describe("IDOR: another user's resource is rejected with 403 (auth valid, ownership fails)", () => {
  it("DELETE /api/v1/a11y/reviews/:id — deleting someone else's review", async () => {
    vi.mocked(reviewService.deleteReview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.FORBIDDEN,
      message: REVIEW_MSG.FORBIDDEN,
    });

    const res = await request(app)
      .delete("/api/v1/a11y/reviews/66a1f2c3e4b5a6d7c8e9f0d4")
      .set("Authorization", bearerFor());

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(reviewService.deleteReview).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/v1/sos/sessions/:id/resolve — resolving someone else's session", async () => {
    vi.mocked(sosService.resolveSession).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.FORBIDDEN,
      message: SOS_MSG.NOT_SESSION_OWNER,
      data: { reason: SOS_REASON.NOT_SESSION_OWNER },
    });

    const res = await request(app)
      .patch("/api/v1/sos/sessions/6a4e797394fbb1b1721c8b81/resolve")
      .set("Authorization", bearerFor());

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(res.body.data.reason).toBe(SOS_REASON.NOT_SESSION_OWNER);
    expect(sosService.resolveSession).toHaveBeenCalledTimes(1);
  });

  it("GET /api/v1/sos/sessions/:id/stream — streaming someone else's session", async () => {
    vi.mocked(sosService.getSessionForOwner).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.FORBIDDEN,
      message: SOS_MSG.NOT_SESSION_OWNER,
      data: { reason: SOS_REASON.NOT_SESSION_OWNER },
    });

    const res = await request(app)
      .get("/api/v1/sos/sessions/6a4e797394fbb1b1721c8b81/stream")
      .set("Authorization", bearerFor());

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(res.body.data.reason).toBe(SOS_REASON.NOT_SESSION_OWNER);
    expect(sosService.getSessionForOwner).toHaveBeenCalledTimes(1);
  });
});
