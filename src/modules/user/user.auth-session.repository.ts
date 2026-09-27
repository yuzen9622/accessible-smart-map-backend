import { Types, type HydratedDocument } from "mongoose";
import AuthSession from "../../model/auth-session.model";
import type { IAuthSession } from "../../types";

/** Maximum database operation duration in milliseconds. */
const DB_OPERATION_MAX_MS = 10_000;

/** Default grace window in milliseconds for concurrent refresh requests. */
export const DEFAULT_REFRESH_GRACE_WINDOW_MS = 30_000;

export type RotateSessionResult =
  | { status: "SUCCESS"; session: IAuthSession }
  | { status: "GRACE_PERIOD"; session: IAuthSession }
  | { status: "REUSE_DETECTED"; session: IAuthSession }
  | { status: "NOT_FOUND" }
  | { status: "REVOKED"; session: IAuthSession }
  | { status: "EXPIRED"; session: IAuthSession };

/**
 * Validates whether an id string is a valid 24-character hexadecimal ObjectId.
 */
function isValidId(id: string | Types.ObjectId | null | undefined): boolean {
  if (!id) return false;
  if (id instanceof Types.ObjectId) return true;
  if (typeof id === "string") return Types.ObjectId.isValid(id);
  return Types.ObjectId.isValid(id);
}

function toSessionDto(doc: HydratedDocument<IAuthSession>): IAuthSession {
  const obj = doc.toObject();
  return {
    ...obj,
    _id: String(obj._id),
    userId: String(obj.userId),
  };
}

/**
 * Creates a new AuthSession document for an authenticated user.
 *
 * @param params User ID, initial refresh token JTI, and session expiration timestamp.
 * @returns The created AuthSession document.
 */
export async function createSession(params: {
  userId: string;
  currentRefreshJti: string;
  expiresAt: Date;
}): Promise<IAuthSession> {
  const session = await AuthSession.create({
    userId: params.userId,
    currentRefreshJti: params.currentRefreshJti,
    expiresAt: params.expiresAt,
    recentRefreshJtis: [],
  });
  return toSessionDto(session);
}

/**
 * Finds an AuthSession by its ID, regardless of revocation or expiration status.
 *
 * @param sid The session ID.
 * @returns The AuthSession document, or null if not found or id is invalid.
 */
export async function findSessionById(
  sid: string,
): Promise<IAuthSession | null> {
  if (!isValidId(sid)) return null;
  const doc = await AuthSession.findById(sid).maxTimeMS(DB_OPERATION_MAX_MS);
  return doc ? toSessionDto(doc) : null;
}

/**
 * Finds an active (not revoked and not expired) AuthSession by its ID.
 *
 * @param sid The session ID.
 * @param now Reference timestamp for expiry comparison (defaults to Date.now()).
 * @returns The active AuthSession document, or null if not found, revoked, or expired.
 */
export async function findActiveSessionById(
  sid: string,
  now: Date = new Date(),
): Promise<IAuthSession | null> {
  if (!isValidId(sid)) return null;
  const doc = await AuthSession.findOne({
    _id: sid,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).maxTimeMS(DB_OPERATION_MAX_MS);
  return doc ? toSessionDto(doc) : null;
}

/**
 * Atomically performs a compare-and-swap (CAS) rotation of a session's refresh token.
 *
 * If CAS succeeds:
 *   - Updates `currentRefreshJti` to `newJti`.
 *   - Updates `previousRefreshJti` to `oldJti`.
 *   - Appends `{ jti: oldJti, rotatedAt: now }` to `recentRefreshJtis` (bounded to last 10).
 *   - Sets `expiresAt` to `newExpiresAt` and `rotatedAt` to `now`.
 *
 * If CAS loses:
 *   - Checks if session was revoked -> returns REVOKED.
 *   - Checks if session expired -> returns EXPIRED.
 *   - Checks if `oldJti` was recently rotated within `graceWindowMs` -> returns GRACE_PERIOD
 *     (does NOT revoke the session; protects against 3-way R1/R1/R2 races).
 *   - If `oldJti` is stale and outside grace window -> conditionally revokes ONLY this session
 *     and returns REUSE_DETECTED.
 */
export async function rotateSession(params: {
  sid: string;
  userId: string;
  oldJti: string;
  newJti: string;
  newExpiresAt: Date;
  now?: Date;
  graceWindowMs?: number;
}): Promise<RotateSessionResult> {
  const {
    sid,
    userId,
    oldJti,
    newJti,
    newExpiresAt,
    now = new Date(),
    graceWindowMs = DEFAULT_REFRESH_GRACE_WINDOW_MS,
  } = params;

  if (!isValidId(sid) || !isValidId(userId)) {
    return { status: "NOT_FOUND" };
  }

  // 1. Atomic compare-and-swap (CAS) rotation
  // Retain all rotation history within the bounded grace window (30s) atomically,
  // preventing false revocation when >10 rotations occur within 30s.
  const graceCutoff = new Date(now.getTime() - graceWindowMs);

  const updated = await AuthSession.findOneAndUpdate(
    {
      _id: sid,
      userId: userId,
      revokedAt: null,
      expiresAt: { $gt: now },
      currentRefreshJti: oldJti,
    },
    [
      {
        $set: {
          currentRefreshJti: newJti,
          previousRefreshJti: oldJti,
          rotatedAt: now,
          expiresAt: newExpiresAt,
          recentRefreshJtis: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$recentRefreshJtis", []] },
                  as: "item",
                  cond: { $gte: ["$$item.rotatedAt", graceCutoff] },
                },
              },
              [{ jti: oldJti, rotatedAt: now }],
            ],
          },
        },
      },
    ],
    {
      returnDocument: "after",
      maxTimeMS: DB_OPERATION_MAX_MS,
      updatePipeline: true,
    },
  );

  if (updated) {
    return {
      status: "SUCCESS",
      session: toSessionDto(updated),
    };
  }

  // 2. CAS failed: read current session state to classify reason
  const current = await AuthSession.findOne(
    { _id: sid, userId: userId },
    null,
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );

  if (!current) {
    return { status: "NOT_FOUND" };
  }

  if (current.revokedAt != null) {
    return {
      status: "REVOKED",
      session: toSessionDto(current),
    };
  }

  if (
    current.expiresAt &&
    new Date(current.expiresAt).getTime() <= now.getTime()
  ) {
    return {
      status: "EXPIRED",
      session: toSessionDto(current),
    };
  }

  // 3. Check bounded grace window for recent rotation (handles R1/R1/R2 three-way races)
  const matchingRecent = current.recentRefreshJtis?.find(
    (entry) =>
      entry.jti === oldJti &&
      new Date(entry.rotatedAt).getTime() >= graceCutoff.getTime(),
  );

  const isPreviousInGrace =
    current.previousRefreshJti === oldJti &&
    current.rotatedAt != null &&
    new Date(current.rotatedAt).getTime() >= graceCutoff.getTime();

  if (matchingRecent || isPreviousInGrace) {
    return {
      status: "GRACE_PERIOD",
      session: toSessionDto(current),
    };
  }

  // 4. Truly stale replay detected: conditionally revoke ONLY this active session
  const revoked = await AuthSession.findOneAndUpdate(
    { _id: sid, userId: userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: "token_reuse_detected" } },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  );

  const finalDoc = (revoked ?? current) as HydratedDocument<IAuthSession>;
  return {
    status: "REUSE_DETECTED",
    session: toSessionDto(finalDoc),
  };
}

/**
 * Revokes a single session belonging to a user.
 *
 * @param sid Session ID
 * @param userId User ID
 * @param reason Reason for revocation
 * @param now Reference timestamp (defaults to Date.now())
 * @returns True if the session was found and revoked, false otherwise.
 */
export async function revokeSession(
  sid: string,
  userId: string,
  reason = "user_logout",
  now: Date = new Date(),
): Promise<boolean> {
  if (!isValidId(sid) || !isValidId(userId)) return false;
  const result = await AuthSession.findOneAndUpdate(
    { _id: sid, userId: userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: reason } },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return Boolean(result);
}

/**
 * Revokes all active sessions belonging to a user (e.g. on password change/reset).
 *
 * @param userId User ID
 * @param reason Reason for revocation
 * @param now Reference timestamp (defaults to Date.now())
 * @returns Number of revoked sessions.
 */
export async function revokeAllSessionsByUserId(
  userId: string,
  reason = "user_all_logout",
  now: Date = new Date(),
): Promise<number> {
  if (!isValidId(userId)) return 0;
  const result = await AuthSession.updateMany(
    { userId: userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: reason } },
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return result.modifiedCount;
}

/**
 * Finds all active sessions belonging to a user.
 *
 * @param userId User ID
 * @param now Reference timestamp
 * @returns Array of active AuthSession documents.
 */
export async function findActiveSessionsByUserId(
  userId: string,
  now: Date = new Date(),
): Promise<IAuthSession[]> {
  if (!isValidId(userId)) return [];
  const docs = await AuthSession.find({
    userId: userId,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).maxTimeMS(DB_OPERATION_MAX_MS);
  return docs.map(toSessionDto);
}
