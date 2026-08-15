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
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
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
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
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
  return User.create(doc) as unknown as Promise<IUser>;
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
  return User.findOne({ email }).select(
    "+passwordHash",
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
  return User.findOneAndUpdate(
    { _id: userId } as Record<string, unknown>,
    update,
    { returnDocument: "after" },
  ).select("+passwordHash") as unknown as Promise<UserWithPasswordHash | null>;
}
