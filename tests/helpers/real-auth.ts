import jwt from "jsonwebtoken";
import { vi } from "vitest";
import User from "../../src/model/user.model";

/**
 * Real-auth fixtures and seam helpers for route-level integration tests.
 *
 * Route tests must exercise the PRODUCTION auth path: the real JWT verification
 * in `src/config/jwt.ts` and the real `authenticateToken()` in
 * `src/config/auth.ts`, including its tokenVersion revocation check. The only
 * thing mocked is the lowest-level DB seam that path reads — `User.findById` —
 * so deleting the revocation comparison turns revocation tests red.
 *
 * This module therefore provides ONLY token/user fixtures and the findById
 * stub. It never mocks `src/config/auth` or the auth middleware.
 */

export const DEFAULT_AUTH_USER_ID = "test-user-id";

/** Shape returned by the `User.findById` stub (a plain user document). */
export interface DbUserFixture {
  _id: string;
  email: string;
  name: string;
  tokenVersion: number;
  [key: string]: unknown;
}

/**
 * Builds the DB-side user document the auth middleware reads.
 *
 * @param overrides Fields to override on the default fixture.
 * @returns A plain user document with a tokenVersion the token must match.
 */
export function buildDbUser(
  overrides: Partial<DbUserFixture> = {},
): DbUserFixture {
  return {
    _id: DEFAULT_AUTH_USER_ID,
    email: "test@example.com",
    name: "Test User",
    tokenVersion: 0,
    ...overrides,
  };
}

/** Document type `User.findById` resolves to, for typing the seam stub. */
type UserDoc = NonNullable<Awaited<ReturnType<typeof User.findById>>>;

// `authenticateToken()` only reads `tokenVersion` and passes the document
// through `toPublicUser()`, which accepts plain objects. The stub therefore
// returns the fixture plain object; the single cast narrows it to the model's
// document type without silencing any other code.
const toUserDoc = (user: DbUserFixture | null): UserDoc | null =>
  user as unknown as UserDoc | null;

/**
 * Signs a REAL access token with the production payload shape `{ user }` and
 * the same secret the app verifies against, so the production middleware
 * accepts it.
 *
 * @param user Fields of the user embedded in the token (default fixture).
 * @param signOptions Extra jwt sign options (e.g. `{ expiresIn: -10 }`).
 * @returns The signed access token.
 */
export function signAccessToken(
  user: Partial<DbUserFixture> = {},
  signOptions: jwt.SignOptions = {},
): string {
  return jwt.sign(
    { user: buildDbUser(user) },
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
    signOptions,
  );
}

/**
 * Builds an Authorization header for a token the production middleware
 * accepts, provided the `User.findById` stub returns a user whose
 * tokenVersion matches.
 *
 * @param user Fields of the user embedded in the token.
 * @param signOptions Extra jwt sign options.
 * @returns A `Bearer <token>` header value.
 */
export function bearerFor(
  user: Partial<DbUserFixture> = {},
  signOptions: jwt.SignOptions = {},
): string {
  return `Bearer ${signAccessToken(user, signOptions)}`;
}

/**
 * Builds an Authorization header whose token is already expired, so the
 * production verifier rejects it with `TokenExpiredError` (→ 401).
 *
 * @param user Fields of the user embedded in the token.
 * @returns A `Bearer <expired token>` header value.
 */
export function expiredBearerFor(user: Partial<DbUserFixture> = {}): string {
  return bearerFor(user, { expiresIn: -10 });
}

/**
 * Builds an Authorization header whose token carries a tokenVersion that does
 * NOT match the DB user, so the production revocation check rejects it.
 *
 * @param user Fields of the user embedded in the token.
 * @param tokenVersion The mismatched version to embed.
 * @returns A `Bearer <revoked token>` header value.
 */
export function revokedBearerFor(
  user: Partial<DbUserFixture> = {},
  tokenVersion = 999,
): string {
  return bearerFor({ ...user, tokenVersion });
}

/**
 * Stubs the lowest-level DB seam the production auth path reads:
 * `User.findById`. Accepts a fixed document, `null` (user not found), or a
 * resolver keyed by the requested id.
 *
 * @param resolve Document, null, or an id-keyed resolver (default: the
 * default fixture user for every id).
 * @returns The spy, so tests can assert call counts.
 */
export function stubAuthUserLookup(
  resolve:
    | DbUserFixture
    | null
    | ((id: string) => DbUserFixture | null) = buildDbUser(),
) {
  const lookup =
    typeof resolve === "function" ? resolve : () => resolve ?? null;
  return vi.spyOn(User, "findById").mockImplementation(
    (id?: unknown) =>
      // Mongoose findById returns an awaitable Query, not a Promise. Returning
      // the document synchronously preserves `await User.findById(...)` at
      // runtime while keeping the spy compatible with the method signature.
      toUserDoc(lookup(String(id))) as unknown as ReturnType<
        typeof User.findById
      >,
  );
}
