import User from "../../model/user.model";
import Config from "../../model/config.model";
import LineLinkCode from "../../model/line-link-code.model";
import type { IUser, IConfig } from "../../types";

/**
 * Looks up a user by id.
 *
 * @param userId User document id
 * @returns The user, or null when no such user exists
 */
export async function findUserById(userId: string): Promise<IUser | null> {
  return User.findById(userId);
}

/**
 * Reads a user's config document.
 *
 * @param userId Owner's user id
 * @returns The config, or null when the user has none yet
 */
export async function findConfigByUserId(
  userId: IUser["_id"] | string,
): Promise<IConfig | null> {
  return Config.findOne({ user_id: userId });
}

/**
 * Applies a `$set` to a user's config, returning the updated document.
 *
 * @param userId Owner's user id
 * @param updateFields Already-filtered fields to set
 * @returns The config after the update, or null when the user has none
 */
export async function updateConfigByUserId(
  userId: string,
  updateFields: Record<string, unknown>,
): Promise<IConfig | null> {
  return Config.findOneAndUpdate(
    { user_id: userId },
    { $set: updateFields },
    { returnDocument: "after" },
  );
}

/**
 * Upserts a user's config and returns it, creating an empty one on first access.
 *
 * @param userId Owner's user id
 * @param updateFields Fields to set; omit for a read-through upsert
 * @returns The config after the upsert
 */
export async function upsertConfigByUserId(
  userId: string,
  updateFields?: Record<string, unknown>,
): Promise<IConfig> {
  // An empty `$set` is rejected by MongoDB, so the read-through upsert path
  // must send `$setOnInsert` alone rather than `$set: {}`.
  const update = updateFields
    ? { $set: updateFields, $setOnInsert: { user_id: userId } }
    : { $setOnInsert: { user_id: userId } };
  return Config.findOneAndUpdate({ user_id: userId }, update, {
    returnDocument: "after",
    upsert: true,
  });
}

/**
 * Whether a LINE link code is already issued.
 *
 * @param code Candidate link code
 * @returns True when the code is taken
 */
export async function lineLinkCodeExists(code: string): Promise<boolean> {
  return Boolean(await LineLinkCode.exists({ code }));
}

/**
 * Stores (or replaces) a user's LINE link code.
 *
 * @param userId Owner's user id
 * @param code The issued link code
 * @param expiresAt When the code stops being valid
 */
export async function upsertLineLinkCode(
  userId: string,
  code: string,
  expiresAt: Date,
): Promise<void> {
  await LineLinkCode.findOneAndUpdate(
    { userId },
    { $set: { code, expiresAt } },
    { upsert: true, returnDocument: "after" },
  );
}
