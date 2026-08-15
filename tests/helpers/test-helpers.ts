import http from "http";
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
 * Starts one stable HTTP server for a route-test file.
 *
 * Passing an Express function directly to each SuperTest request makes
 * SuperTest bind and close a new ephemeral server for every request. Under the
 * full parallel suite, rapid cross-process port reuse can connect a request to
 * the wrong short-lived server. Keeping one server for the file removes that
 * transport race while exercising the same production Express app.
 */
export async function startTestServer(): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}

/** Closes a server created by {@link startTestServer}. */
export async function stopTestServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Signs a valid access token and returns it as a Bearer header value for
 * protected routes. Mirrors the production JWT payload shape `{ user }` that
 * the auth middleware (`src/middleware/middleware.ts`) decodes into `req.auth`.
 *
 * The token carries `tokenVersion: 0` unless overridden, and the request only
 * authenticates when the `User.findById` seam (see `tests/helpers/real-auth.ts`)
 * returns a user whose tokenVersion matches — the production revocation check.
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
    { user: { tokenVersion: 0, ...user } },
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
  );
  return `Bearer ${token}`;
}
