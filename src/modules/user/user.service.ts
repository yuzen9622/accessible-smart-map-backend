import {
  findConfigByUserId,
  findUserById,
  lineLinkCodeExists,
  updateConfigByUserId,
  upsertConfigByUserId,
  upsertLineLinkCode,
} from "./user.repository";
import { buildBindUrl } from "../../adapters/line.adapter";
import crypto from "crypto";
import type { IUser, IConfig, IA11yProfile } from "../../types";

const LINE_LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LINE_LINK_CODE_LENGTH = 6;
const LINE_LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000;

async function generateLineLinkCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < LINE_LINK_CODE_LENGTH; i++) {
      code +=
        LINE_LINK_CODE_ALPHABET[
          crypto.randomInt(LINE_LINK_CODE_ALPHABET.length)
        ];
    }
    const exists = await lineLinkCodeExists(code);
    if (!exists) return code;
  }
  throw new Error("Failed to generate a unique LINE link code");
}

/**
 * Look up a user by id.
 *
 * @param userId MongoDB user _id.
 * @returns The user, or null when no such user exists.
 */
export async function getUserById(userId: string): Promise<IUser | null> {
  return findUserById(userId);
}

/**
 * Look up a user and its config by id.
 *
 * Both lookups are keyed on the user _id and short-circuit when the user is
 * missing: querying Config with an undefined user_id would match every document
 * and hand back an unrelated user's settings.
 *
 * @param userId MongoDB user _id.
 * @returns The user and its config, both null when the user does not exist.
 */
export async function getUserWithConfig(
  userId: string,
): Promise<{ user: IUser | null; config: IConfig | null }> {
  const user = await findUserById(userId);
  if (!user) return { user: null, config: null };
  const config = await findConfigByUserId(user._id);
  return { user, config };
}

export async function getConfig(user_id: string): Promise<IConfig | null> {
  return findConfigByUserId(user_id);
}

export async function updateConfig(
  user_id: string,
  fields: Record<string, unknown>,
): Promise<IConfig | null> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) updateFields[key] = value;
  }
  return updateConfigByUserId(user_id, updateFields);
}

const DEFAULT_A11Y_PROFILE: IA11yProfile = {
  mobilityAid: null,
  canUseStairs: null,
  maxSlopePercent: null,
  needsAccessibleToilet: null,
  needsElevator: null,
  needsHandrail: null,
  visualAssistance: null,
  preferredFontScale: null,
};

/**
 * Reads the caller's accessibility profile, creating an empty Config document
 * (all fields null/default) on first access so onboarding always has
 * something to read and write.
 *
 * @param userId The authenticated user's id.
 * @returns The accessibility profile, defaulting every field to null when unset.
 */
export async function getA11yProfile(userId: string): Promise<IA11yProfile> {
  const config = await upsertConfigByUserId(userId);
  return { ...DEFAULT_A11Y_PROFILE, ...(config.accessibility ?? {}) };
}

/**
 * Merges the given fields into the caller's accessibility profile.
 *
 * @param userId The authenticated user's id.
 * @param fields Partial profile fields to set; `undefined` values are left untouched.
 * @returns The full profile after the update.
 */
export async function updateA11yProfile(
  userId: string,
  fields: Partial<IA11yProfile>,
): Promise<IA11yProfile> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) updateFields[`accessibility.${key}`] = value;
  }
  const config = await upsertConfigByUserId(userId, updateFields);
  return { ...DEFAULT_A11Y_PROFILE, ...(config.accessibility ?? {}) };
}

export async function issueLineLinkCode(userId: string): Promise<{
  bindCode: string;
  bindCodeExpiresAt: Date;
  bindUrl: string;
}> {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const bindCode = await generateLineLinkCode();
  const bindCodeExpiresAt = new Date(Date.now() + LINE_LINK_CODE_TTL_MS);

  await upsertLineLinkCode(userId, bindCode, bindCodeExpiresAt);

  return {
    bindCode,
    bindCodeExpiresAt,
    bindUrl: buildBindUrl(),
  };
}
