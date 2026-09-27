import jwt from "jsonwebtoken";
import { vi } from "vitest";
import User from "../../src/model/user.model";
import AuthSession from "../../src/model/auth-session.model";

/**
 * Real-auth fixtures and seam helpers for route-level integration tests.
 *
 * Route tests must exercise the PRODUCTION auth path: the real JWT verification
 * in `src/config/jwt.ts` and the real `authenticateToken()` in
 * `src/config/auth.ts`, including its tokenVersion revocation check and
 * AuthSession validation. The DB seams that path reads — `User.findById` and
 * `AuthSession.findById` — are stubbed so deleting the revocation or session
 * validation turns tests red.
 *
 * This module therefore provides token/user/session fixtures and the findById
 * stubs with sid-to-owner/status mapping. It never mocks `src/config/auth` or
 * the auth middleware.
 */

export const DEFAULT_AUTH_USER_ID = "test-user-id";
export const DEFAULT_AUTH_SESSION_ID = "665f1a2b3c4d5e6f7a8b9c01";

/** Shape returned by the `User.findById` stub (a plain user document). */
export interface DbUserFixture {
  _id: string;
  email: string;
  name: string;
  tokenVersion: number;
  [key: string]: unknown;
}

/** Shape returned by the `AuthSession.findById` stub. */
export interface DbSessionFixture {
  _id: string;
  userId: string;
  currentRefreshJti: string;
  previousRefreshJti?: string | null;
  recentRefreshJtis?: Array<{ jti: string; rotatedAt: Date }>;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string | null;
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

/**
 * Builds a DB-side session document the auth middleware reads.
 *
 * @param overrides Fields to override on the default fixture.
 * @returns A plain session document with a valid sid and unrevoked status.
 */
export function buildDbSession(
  overrides: Partial<DbSessionFixture> = {},
): DbSessionFixture {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    _id: DEFAULT_AUTH_SESSION_ID,
    userId: DEFAULT_AUTH_USER_ID,
    currentRefreshJti: "test-refresh-jti",
    previousRefreshJti: null,
    recentRefreshJtis: [],
    expiresAt: tomorrow,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

/** Document type `User.findById` resolves to, for typing the seam stub. */
type UserDoc = NonNullable<Awaited<ReturnType<typeof User.findById>>>;

/** Document type `AuthSession.findById` resolves to. */
type SessionDoc = NonNullable<Awaited<ReturnType<typeof AuthSession.findById>>>;

const toUserDoc = (user: DbUserFixture | null): UserDoc | null =>
  user as unknown as UserDoc | null;

const toSessionDoc = (session: DbSessionFixture | null): SessionDoc | null =>
  session as unknown as SessionDoc | null;

/** Currently active user id tracked by stubAuthUserLookup. */
let activeLookupUserId = DEFAULT_AUTH_USER_ID;

/** Map of custom sid -> DbSessionFixture registered by tests. */
const customSessionMap = new Map<string, DbSessionFixture>();

/**
 * Registers an AuthSession fixture in the test session registry.
 *
 * @param session The session fixture to register.
 */
export function registerAuthSession(session: DbSessionFixture): void {
  customSessionMap.set(session._id, session);
}

/**
 * Clears all custom session fixtures.
 */
export function clearAuthSessions(): void {
  customSessionMap.clear();
}

/**
 * Signs a REAL access token with the production payload shape `{ user, sid }`
 * and the same secret the app verifies against.
 *
 * @param user Fields of the user embedded in the token (default fixture).
 * @param signOptions Extra jwt sign options (e.g. `{ expiresIn: -10 }`).
 * @param sid The session ID to embed (defaults to DEFAULT_AUTH_SESSION_ID).
 * @returns The signed access token.
 */
export function signAccessToken(
  user: Partial<DbUserFixture> = {},
  signOptions: jwt.SignOptions = {},
  sid: string = DEFAULT_AUTH_SESSION_ID,
): string {
  const dbUser = buildDbUser(user);
  return jwt.sign(
    { user: dbUser, sid },
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
    signOptions,
  );
}

/**
 * Signs a legacy access token without a `sid` claim to test rejection of
 * pre-deployment credentials.
 *
 * @param user Fields of the user embedded in the token.
 * @param signOptions Extra jwt sign options.
 * @returns The signed sid-less access token.
 */
export function signLegacySidlessAccessToken(
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
 * accepts, provided the `User.findById` and `AuthSession.findById` stubs
 * return matching active documents.
 *
 * @param user Fields of the user embedded in the token.
 * @param signOptions Extra jwt sign options.
 * @param sid Session ID (defaults to DEFAULT_AUTH_SESSION_ID).
 * @returns A `Bearer <token>` header value.
 */
export function bearerFor(
  user: Partial<DbUserFixture> = {},
  signOptions: jwt.SignOptions = {},
  sid: string = DEFAULT_AUTH_SESSION_ID,
): string {
  return `Bearer ${signAccessToken(user, signOptions, sid)}`;
}

/**
 * Builds an Authorization header for a legacy sid-less token.
 */
export function legacyBearerFor(
  user: Partial<DbUserFixture> = {},
  signOptions: jwt.SignOptions = {},
): string {
  return `Bearer ${signLegacySidlessAccessToken(user, signOptions)}`;
}

/**
 * Builds an Authorization header whose token is already expired, so the
 * production verifier rejects it with `TokenExpiredError` (→ 401).
 *
 * @param user Fields of the user embedded in the token.
 * @returns A `Bearer <expired token>` header value.
 */
export function expiredBearerFor(
  user: Partial<DbUserFixture> = {},
  sid: string = DEFAULT_AUTH_SESSION_ID,
): string {
  return bearerFor(user, { expiresIn: -10 }, sid);
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
  sid: string = DEFAULT_AUTH_SESSION_ID,
): string {
  return bearerFor({ ...user, tokenVersion }, {}, sid);
}

/**
 * Stubs `AuthSession.findById` with a sid-to-owner/status mapping.
 *
 * It is NOT an all-sids-active stub:
 * - If sid matches customSessionMap, returns that session fixture.
 * - If sid === DEFAULT_AUTH_SESSION_ID, returns an active session bound to the active user.
 * - If sid is unknown, returns null.
 *
 * @param resolve Optional fixed document, null, or resolver function.
 */
export function stubAuthSessionLookup(
  resolve?:
    DbSessionFixture | null | ((sid: string) => DbSessionFixture | null),
) {
  const sessionLookup = (sid: string): DbSessionFixture | null => {
    if (resolve === null) return null;
    if (typeof resolve === "function") return resolve(sid);
    if (resolve && typeof resolve === "object") {
      return resolve._id === sid ? resolve : null;
    }
    if (customSessionMap.has(sid)) {
      return customSessionMap.get(sid) ?? null;
    }
    if (sid === DEFAULT_AUTH_SESSION_ID) {
      return buildDbSession({
        _id: DEFAULT_AUTH_SESSION_ID,
        userId: activeLookupUserId,
      });
    }
    return null;
  };

  return vi
    .spyOn(AuthSession, "findById")
    .mockImplementation(
      (id?: unknown) =>
        toSessionDoc(sessionLookup(String(id))) as unknown as ReturnType<
          typeof AuthSession.findById
        >,
    );
}

/**
 * Stubs the lowest-level DB seams the production auth path reads:
 * `User.findById` and `AuthSession.findById`.
 *
 * @param resolve Document, null, or an id-keyed resolver (default: default user).
 * @returns The spy on User.findById.
 */
export function stubAuthUserLookup(
  resolve:
    | DbUserFixture
    | null
    | ((id: string) => DbUserFixture | null) = buildDbUser(),
) {
  const lookup =
    typeof resolve === "function" ? resolve : () => resolve ?? null;

  if (typeof resolve === "object" && resolve?._id) {
    activeLookupUserId = resolve._id;
  } else {
    activeLookupUserId = DEFAULT_AUTH_USER_ID;
  }

  // Automatically stub session lookup with sid-to-owner mapping
  stubAuthSessionLookup();

  return vi.spyOn(User, "findById").mockImplementation((id?: unknown) => {
    const found = lookup(String(id));
    if (found?._id) {
      activeLookupUserId = found._id;
    }
    return toUserDoc(found) as unknown as ReturnType<typeof User.findById>;
  });
}
