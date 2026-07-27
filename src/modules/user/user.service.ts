import User from "../../model/user.model";
import Config from "../../model/config.model";
import LineLinkCode from "../../model/line-link-code.model";
import { buildBindUrl } from "../../adapters/line.adapter";
import crypto from "crypto";
import type { IUser, IConfig } from "../../types";

const LINE_LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LINE_LINK_CODE_LENGTH = 6;
const LINE_LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000;

async function generateLineLinkCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < LINE_LINK_CODE_LENGTH; i++) {
      code += LINE_LINK_CODE_ALPHABET[crypto.randomInt(LINE_LINK_CODE_ALPHABET.length)];
    }
    const exists = await LineLinkCode.exists({ code });
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
  return User.findById(userId);
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
  const user = await User.findById(userId);
  if (!user) return { user: null, config: null };
  const config = await Config.findOne({ user_id: user._id });
  return { user, config };
}

export async function getConfig(user_id: string): Promise<IConfig | null> {
  return Config.findOne({ user_id });
}

export async function updateConfig(
  user_id: string,
  fields: Record<string, unknown>,
): Promise<IConfig | null> {
  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) updateFields[key] = value;
  }
  return Config.findOneAndUpdate({ user_id }, { $set: updateFields }, { new: true });
}

export async function issueLineLinkCode(userId: string): Promise<{
  bindCode: string;
  bindCodeExpiresAt: Date;
  bindUrl: string;
}> {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const bindCode = await generateLineLinkCode();
  const bindCodeExpiresAt = new Date(Date.now() + LINE_LINK_CODE_TTL_MS);

  await LineLinkCode.findOneAndUpdate(
    { userId },
    { $set: { code: bindCode, expiresAt: bindCodeExpiresAt } },
    { upsert: true, new: true },
  );

  return {
    bindCode,
    bindCodeExpiresAt,
    bindUrl: buildBindUrl(),
  };
}
