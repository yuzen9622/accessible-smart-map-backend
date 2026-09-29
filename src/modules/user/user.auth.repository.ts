import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthToken from "../../model/auth-token.model";
import type { AuthTokenType, IConfig, IUser } from "../../types";

/** How long a single auth-related database operation may run. */
const DB_OPERATION_MAX_MS = 10_000;

/** A user record including the normally-hidden password hash. */
export type UserWithPasswordHash = IUser & { passwordHash?: string };

/**
 * Upserts the single-use token of a given type for a user, replacing any
 * previous one.
 *
 * @param userId Owner
 * @param type Token kind
 * @param tokenHash Hash of the raw token
 * @param expiresAt When the token stops being valid
 */
export async function upsertAuthToken(
  userId: string,
  type: AuthTokenType,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await AuthToken.findOneAndUpdate(
    { userId, type },
    { $set: { tokenHash, expiresAt, usedAt: null } },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
      maxTimeMS: DB_OPERATION_MAX_MS,
    },
  );
}

/**
 * Atomically claims and removes a live single-use token.
 *
 * @param tokenHash Hash of the presented token
 * @param type Token kind
 * @returns The owning user id, or null when the token is unknown, expired or used
 */
export async function consumeAuthTokenRecord(
  tokenHash: string,
  type: AuthTokenType,
): Promise<{ userId: string } | null> {
  const record = await AuthToken.findOneAndDelete(
    { tokenHash, type, usedAt: null, expiresAt: { $gt: new Date() } },
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return record ? { userId: String(record.userId) } : null;
}

/**
 * Rotates this job's password-reset token without invalidating other queued
 * jobs' links, refusing to recreate one this job already consumed.
 *
 * @param userId Owner
 * @param jobId The queue job issuing the token
 * @param tokenHash Hash of the raw token
 * @param expiresAt When the token stops being valid
 * @param now Current time, used to drop expired entries
 * @returns True when the token was stored
 */
export async function rotatePasswordResetToken(
  userId: string,
  jobId: string,
  tokenHash: string,
  expiresAt: Date,
  now: Date,
): Promise<boolean> {
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      authProviders: "local",
      passwordResetTokens: {
        $not: { $elemMatch: { jobId, consumedAt: { $exists: true } } },
      },
    },
    [
      {
        $set: {
          passwordResetTokens: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$passwordResetTokens", []] },
                  as: "token",
                  cond: {
                    $and: [
                      { $gt: ["$$token.expiresAt", now] },
                      { $ne: ["$$token.jobId", jobId] },
                    ],
                  },
                },
              },
              [{ jobId, tokenHash, expiresAt }],
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
  return Boolean(user);
}

/**
 * Consumes a password-reset token and writes the new password in one atomic
 * update, revoking previously issued access tokens.
 *
 * @param tokenHash Hash of the presented token
 * @param passwordHash The new bcrypt hash
 * @param now Current time, used for expiry and the consumed tombstone
 * @returns The updated user, or null when the token is unusable
 */
export async function consumePasswordResetToken(
  tokenHash: string,
  passwordHash: string,
  now: Date,
): Promise<IUser | null> {
  return User.findOneAndUpdate(
    {
      passwordResetTokens: {
        $elemMatch: {
          tokenHash,
          expiresAt: { $gt: now },
          consumedAt: { $exists: false },
        },
      },
      authProviders: "local",
    },
    [
      {
        $set: {
          passwordHash: { $literal: passwordHash },
          emailVerified: true,
          tokenVersion: { $add: [{ $ifNull: ["$tokenVersion", 0] }, 1] },
          // Each queued email owns an independent one-time token. Consume only
          // the matching entry: another link may be in flight, and consuming it
          // before dispatch would make the newest delivered email immediately
          // invalid. The consumed tombstone blocks this job from recreating it.
          passwordResetTokens: {
            $map: {
              input: { $ifNull: ["$passwordResetTokens", []] },
              as: "token",
              in: {
                $cond: [
                  { $eq: ["$$token.tokenHash", tokenHash] },
                  { $mergeObjects: ["$$token", { consumedAt: now }] },
                  "$$token",
                ],
              },
            },
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
}

/**
 * Reads a user's config, creating an empty one when absent.
 *
 * @param userId Owner
 * @returns The config
 */
export async function ensureConfigForUser(
  userId: unknown,
): Promise<IConfig | null> {
  const existing = await Config.findOne({ user_id: userId });
  if (existing) return existing;
  return Config.create({ user_id: userId });
}

/**
 * Reads a user's config.
 *
 * @param userId Owner
 * @returns The config, or null when absent
 */
export async function findConfigForUser(
  userId: unknown,
): Promise<IConfig | null> {
  return Config.findOne({ user_id: userId });
}

/**
 * Whether an address already belongs to an account.
 *
 * @param email Normalised address
 * @returns True when taken
 */
export async function emailExists(email: string): Promise<boolean> {
  return Boolean(await User.exists({ email }));
}

/**
 * Inserts a user.
 *
 * @param doc The user to store
 * @returns The stored user
 */
export async function insertUser(doc: Record<string, unknown>): Promise<IUser> {
  const created = await User.create(doc);
  // SAFETY: Mongoose toObject() returns a plain POJO conforming to the IUser schema
  return created.toObject() as unknown as IUser;
}

/**
 * Looks up a user by address.
 *
 * @param email Normalised address
 * @returns The user, or null
 */
export async function findUserByEmail(email: string): Promise<IUser | null> {
  return User.findOne({ email });
}

/**
 * Looks up a user by address under the shared auth operation timeout.
 *
 * @param email Normalised address
 * @returns The user, or null
 */
export async function findUserByEmailBounded(
  email: string,
): Promise<IUser | null> {
  return User.findOne({ email }, null, { maxTimeMS: DB_OPERATION_MAX_MS });
}

/**
 * Looks up a user by address, including the password hash.
 *
 * @param email Normalised address
 * @returns The user, or null
 */
export async function findUserByEmailWithPassword(
  email: string,
): Promise<UserWithPasswordHash | null> {
  // SAFETY: Mongoose query with select("+passwordHash +appleUserId") resolves to a User document including the passwordHash and appleUserId fields
  return User.findOne({ email }).select(
    "+passwordHash +appleUserId",
  ) as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Looks up a user by id, including the password hash.
 *
 * @param userId User id
 * @returns The user, or null
 */
export async function findUserByIdWithPassword(
  userId: string,
): Promise<UserWithPasswordHash | null> {
  // SAFETY: Mongoose query with select("+passwordHash") resolves to a User document including the passwordHash field
  return User.findById(userId).select(
    "+passwordHash",
  ) as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Looks up a user by id under the shared auth operation timeout.
 *
 * @param userId User id
 * @returns The user, or null
 */
export async function findUserByIdBounded(
  userId: string,
): Promise<IUser | null> {
  return User.findById(userId, null, { maxTimeMS: DB_OPERATION_MAX_MS });
}

/**
 * Looks up a user by Google subject id.
 *
 * @param clientId The Google `sub` claim
 * @returns The user, or null
 */
export async function findUserByClientId(
  clientId: string,
): Promise<IUser | null> {
  return User.findOne({ client_id: clientId });
}

/**
 * Applies a field patch to a user, optionally removing fields.
 *
 * @param userId User id
 * @param set Fields to set
 * @param unset Field names to remove
 * @returns The user after the update, or null when it vanished
 */
export async function updateUserById(
  userId: unknown,
  set: Record<string, unknown>,
  unset?: string[],
): Promise<UserWithPasswordHash | null> {
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (unset?.length) {
    update.$unset = Object.fromEntries(unset.map((field) => [field, ""]));
  }
  // SAFETY: Mongoose query with select("+passwordHash") resolves to a User document including the passwordHash field
  return User.findOneAndUpdate(
    { _id: userId } as Record<string, unknown>,
    update,
    { returnDocument: "after" },
  ).select("+passwordHash") as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Atomically updates a user's password and increments tokenVersion using CAS.
 * Matches _id, expected tokenVersion, and expected passwordHash (or null if unset).
 * If a concurrent update modified the credentials or tokenVersion, returns null (loser).
 */
export async function atomicChangePassword(params: {
  userId: string;
  expectedTokenVersion: number;
  expectedPasswordHash: string | null;
  newPasswordHash: string;
  authProviders: string[];
}): Promise<UserWithPasswordHash | null> {
  const filter: Record<string, unknown> = {
    _id: params.userId,
    tokenVersion: params.expectedTokenVersion,
  };
  if (params.expectedPasswordHash) {
    filter.passwordHash = params.expectedPasswordHash;
  } else {
    filter.$or = [{ passwordHash: null }, { passwordHash: { $exists: false } }];
  }

  // SAFETY: Mongoose query with select("+passwordHash") resolves to a User document including the passwordHash field
  return User.findOneAndUpdate(
    filter,
    {
      $set: {
        passwordHash: params.newPasswordHash,
        authProviders: params.authProviders,
      },
      $inc: { tokenVersion: 1 },
    },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  ).select("+passwordHash") as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Atomically performs Google takeover of an unverified local account:
 * matches _id, expectedTokenVersion, emailVerified: false, and expectedPasswordHash.
 * Drops passwordHash, sets client_id, emailVerified: true, updates authProviders,
 * and atomically increments tokenVersion by 1.
 * If credentials or version changed concurrently, returns null (loser).
 */
export async function atomicGoogleTakeover(params: {
  userId: string;
  expectedTokenVersion: number;
  expectedPasswordHash: string;
  clientId: string;
  authProviders: string[];
  avatar?: string;
}): Promise<UserWithPasswordHash | null> {
  const filter: Record<string, unknown> = {
    _id: params.userId,
    tokenVersion: params.expectedTokenVersion,
    emailVerified: false,
    passwordHash: params.expectedPasswordHash,
  };

  const setObj: Record<string, unknown> = {
    client_id: params.clientId,
    emailVerified: true,
    authProviders: params.authProviders,
  };
  if (params.avatar) {
    setObj.avatar = params.avatar;
  }

  // SAFETY: Mongoose query with select("+passwordHash") resolves to a User document including the passwordHash field
  return User.findOneAndUpdate(
    filter,
    {
      $set: setObj,
      $unset: { passwordHash: "" },
      $inc: { tokenVersion: 1 },
    },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  ).select("+passwordHash") as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Atomically links Google to an existing account without dropping password.
 */
export async function atomicLinkGoogle(params: {
  userId: string;
  expectedTokenVersion: number;
  clientId: string;
  avatar?: string;
}): Promise<UserWithPasswordHash | null> {
  const setObj: Record<string, unknown> = {
    client_id: params.clientId,
    emailVerified: true,
  };
  if (params.avatar) {
    setObj.avatar = params.avatar;
  }

  // SAFETY: Mongoose query with select("+passwordHash") resolves to a User document including the passwordHash field
  return User.findOneAndUpdate(
    {
      _id: params.userId,
      tokenVersion: params.expectedTokenVersion,
    },
    {
      $set: setObj,
      $addToSet: { authProviders: "google" },
    },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  ).select("+passwordHash") as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Looks up a user by Apple subject id (appleUserId).
 *
 * @param appleUserId The Apple `sub` claim
 * @returns The user, or null
 */
export async function findUserByAppleUserId(
  appleUserId: string,
): Promise<IUser | null> {
  return User.findOne({ appleUserId }).select("+appleUserId");
}

/**
 * Atomically performs Apple takeover of an unverified local account:
 * matches _id, expectedTokenVersion, emailVerified: false, expectedPasswordHash,
 * and ensures appleUserId is null/absent to prevent overwriting existing Apple identity.
 * Drops passwordHash, sets appleUserId, emailVerified: true, updates authProviders,
 * and atomically increments tokenVersion by 1.
 * If credentials or version changed concurrently, returns null (loser).
 *
 * @param params Takeover parameters with CAS preconditions
 * @returns The updated user with passwordHash, or null on CAS mismatch
 */
export async function atomicAppleTakeover(params: {
  userId: string;
  expectedTokenVersion: number;
  expectedPasswordHash: string;
  appleUserId: string;
  authProviders: string[];
}): Promise<UserWithPasswordHash | null> {
  const filter: Record<string, unknown> = {
    _id: params.userId,
    tokenVersion: params.expectedTokenVersion,
    emailVerified: false,
    passwordHash: params.expectedPasswordHash,
    appleUserId: null,
  };

  const setObj: Record<string, unknown> = {
    appleUserId: params.appleUserId,
    emailVerified: true,
    authProviders: params.authProviders,
  };

  // SAFETY: Mongoose query with select("+passwordHash +appleUserId") resolves to a User document including the passwordHash and appleUserId fields
  return User.findOneAndUpdate(
    filter,
    {
      $set: setObj,
      $unset: { passwordHash: "" },
      $inc: { tokenVersion: 1 },
    },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  ).select(
    "+passwordHash +appleUserId",
  ) as unknown as Promise<UserWithPasswordHash | null>;
}

/**
 * Atomically links Apple identity to an existing account without dropping password.
 * Only allows linking if appleUserId is currently null/absent or already matches
 * the incoming appleUserId (idempotent), preventing overwriting another Apple identity.
 *
 * @param params Linking parameters with CAS preconditions
 * @returns The updated user with passwordHash, or null on CAS mismatch
 */
export async function atomicLinkApple(params: {
  userId: string;
  expectedTokenVersion: number;
  appleUserId: string;
}): Promise<UserWithPasswordHash | null> {
  const filter: Record<string, unknown> = {
    _id: params.userId,
    tokenVersion: params.expectedTokenVersion,
    $or: [{ appleUserId: null }, { appleUserId: params.appleUserId }],
  };

  const setObj: Record<string, unknown> = {
    appleUserId: params.appleUserId,
    emailVerified: true,
  };

  // SAFETY: Mongoose query with select("+passwordHash +appleUserId") resolves to a User document including the passwordHash and appleUserId fields
  return User.findOneAndUpdate(
    filter,
    {
      $set: setObj,
      $addToSet: { authProviders: "apple" },
    },
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  ).select(
    "+passwordHash +appleUserId",
  ) as unknown as Promise<UserWithPasswordHash | null>;
}
