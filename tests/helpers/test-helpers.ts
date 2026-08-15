import jwt from "jsonwebtoken";
import app from "../../src/app";

/**
 * Returns the real Express app for route-level integration tests.
 *
 * `src/app.ts` exports a fully-wired app without `.listen()` or a MongoDB
 * connection (those live in `src/server.ts`), so supertest can drive it
 * directly. Mock the service layer with `vi.mock` in the test file so the
 * request exercises router + middleware + validation + controller + envelope
 * without touching the network or DB.
 *
 * @returns The Express application instance.
 */
export function buildTestApp() {
  return app;
}

/**
 * Signs a valid access token and returns it as a Bearer header value for
 * protected routes. Mirrors the production JWT payload shape `{ user }` that
 * the auth middleware (`src/middleware/middleware.ts`) decodes into `req.auth`.
 *
 * @param user Optional user payload override (defaults to a stub user).
 * @returns A string suitable for `.set("Authorization", ...)`.
 */
export function buildAuthorizationHeader(
  user: Record<string, unknown> = {
    _id: "test-user-id",
    email: "test@example.com",
  },
): string {
  const token = jwt.sign(
    { user },
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
  );
  return `Bearer ${token}`;
}
