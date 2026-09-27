import User from "../model/user.model";
import AuthSession from "../model/auth-session.model";
import { toPublicUser, verifyAccessToken } from "./jwt";
import type { IUser } from "../types";

export type AuthenticateResult =
  | { ok: true; userId: string; user: IUser; sessionId: string }
  | { ok: false; expired: boolean };

/**
 * Verify an access token and confirm it has not been revoked.
 *
 * A token is revoked when its tokenVersion no longer matches the one stored on
 * the user (e.g. password changes and resets), or when its associated
 * AuthSession is revoked, expired, or belongs to a different user.
 * Tokens lacking a valid session ID (`sid`) are rejected as invalid pre-deployment
 * credentials.
 *
 * @param token Raw JWT access token, without the "Bearer " prefix.
 * @returns The fresh user and session id on success, or whether the token was merely expired.
 */
export async function authenticateToken(
  token: string,
): Promise<AuthenticateResult> {
  const verify = verifyAccessToken(token);
  if (!verify.success || !verify.decoded) {
    return { ok: false, expired: Boolean(verify.expired) };
  }

  const claimed = verify.decoded.user as IUser | undefined;
  const userId = claimed?._id ? String(claimed._id) : "";
  const decoded = verify.decoded as Record<string, unknown>;
  const rawSid =
    decoded.sid ?? (decoded.user as Record<string, unknown> | undefined)?.sid;
  const sid = typeof rawSid === "string" ? rawSid : "";

  if (!userId || !sid) {
    return { ok: false, expired: false };
  }

  let user;
  let session;
  try {
    [user, session] = await Promise.all([
      User.findById(userId),
      AuthSession.findById(sid),
    ]);
  } catch (err) {
    // DB unavailable fails closed, log safely without exposing credentials
    console.error(
      "authenticateToken: DB lookup failed",
      err instanceof Error ? err.message : "unknown error",
    );
    return { ok: false, expired: false };
  }

  if (!user || !session) {
    return { ok: false, expired: false };
  }

  if (Number(user.tokenVersion ?? 0) !== Number(claimed?.tokenVersion ?? -1)) {
    return { ok: false, expired: false };
  }

  if (String(session.userId) !== userId) {
    return { ok: false, expired: false };
  }

  if (session.revokedAt != null) {
    return { ok: false, expired: false };
  }

  if (
    session.expiresAt &&
    new Date(session.expiresAt).getTime() <= Date.now()
  ) {
    return { ok: false, expired: false };
  }

  return { ok: true, userId, user: toPublicUser(user), sessionId: sid };
}

/**
 * Verifies that a raw token or Authorization header string corresponds to an
 * active, unrevoked session in the database, optionally matching an expected user ID.
 *
 * Fails closed on any error (database failure, invalid signature, mismatched
 * tokenVersion, revoked or expired session).
 *
 * @param tokenOrHeader Raw JWT or "Bearer <token>" header string.
 * @param expectedUserId Optional user ID that must match the authenticated token.
 * @returns true if the session is currently active and valid; false otherwise.
 */
export async function verifyActiveSession(
  tokenOrHeader: string,
  expectedUserId?: string,
): Promise<boolean> {
  if (!tokenOrHeader) return false;
  const token = tokenOrHeader.startsWith("Bearer ")
    ? tokenOrHeader.slice(7).trim()
    : tokenOrHeader.trim();
  if (!token) return false;
  const result = await authenticateToken(token);
  if (!result.ok) return false;
  if (expectedUserId && result.userId !== expectedUserId) return false;
  return true;
}
