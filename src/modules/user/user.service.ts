import {
  findConfigByUserId,
  findUserById,
  lineLinkCodeExists,
  updateConfigByUserId,
  upsertConfigByUserId,
  upsertLineLinkCode,
  usableLineAccountCodeExists,
  findUsableLineAccountCode,
  findUserBoundToLine,
  consumeLineAccountCode,
  bindUserToLineConditionally,
} from "./user.repository";
import { normalizeLineBindingCode } from "../../utils/line-binding-code";
import type { LineAccountBindingResult } from "../../types/line-binding";
export type { LineAccountBindingResult } from "../../types/line-binding";
import { buildBindUrl } from "../../adapters/line.adapter";
import { LINE_MSG } from "../../constants/messages";
import crypto from "crypto";
import type { IUser, IConfig, IA11yProfile } from "../../types";
import type { AccessibilityMode } from "../../types/route";

export async function hasUsableLineAccountCode(code: string): Promise<boolean> {
  const normalized = normalizeLineBindingCode(code);
  return normalized ? usableLineAccountCodeExists(normalized) : false;
}

export async function bindLineAccountCode(
  code: string,
  lineUserId?: string,
): Promise<LineAccountBindingResult> {
  if (!lineUserId?.trim()) return { ok: false, error: "缺少 LINE 使用者資訊" };
  const normalized = normalizeLineBindingCode(code);
  if (!normalized) return { ok: false, error: "綁定碼格式錯誤" };
  let phase = "precheck";
  try {
    const linkCode = await findUsableLineAccountCode(normalized);
    const noCode: LineAccountBindingResult = {
      ok: false,
      errorCode: "NO_LINE_BIND_CODE",
      error: "找不到可用的 LINE 帳號綁定碼",
    };
    if (!linkCode) return noCode;
    const existingBoundUser = await findUserBoundToLine(lineUserId);
    if (
      existingBoundUser &&
      String(existingBoundUser._id) !== String(linkCode.userId)
    ) {
      return { ok: false, error: "這個 LINE 帳號已綁定其他使用者" };
    }
    const user = await findUserById(linkCode.userId);
    if (!user) return { ok: false, error: "找不到對應的使用者" };
    if (user.lineUserId && user.lineUserId !== lineUserId) {
      return { ok: false, error: "這個使用者已綁定其他 LINE 帳號" };
    }

    // Standalone Mongo cannot atomically update both collections. Consume first:
    // at most one redeemer proceeds, but a subsequent failure may burn the code.
    // Never restore it: restoration can overwrite a concurrently reissued code.
    phase = "consume";
    if (!(await consumeLineAccountCode(linkCode))) return noCode;
    phase = "bind-user";
    const boundUser = await bindUserToLineConditionally(
      linkCode.userId,
      lineUserId,
    );
    if (!boundUser) {
      const currentUser = await findUserById(linkCode.userId);
      return {
        ok: false,
        error: currentUser
          ? "這個使用者已綁定其他 LINE 帳號"
          : "找不到對應的使用者",
      };
    }
    return {
      ok: true,
      bound: true,
      userId: String(boundUser._id),
      userName: boundUser.name,
      bindUrl: buildBindUrl(),
    };
  } catch (error: unknown) {
    // Only a duplicate from the conditional user write represents a LINE conflict.
    if (
      phase === "bind-user" &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000
    ) {
      return { ok: false, error: "這個 LINE 帳號已綁定其他使用者" };
    }
    // No raw error/code/identifier logging: write outcome may be unknown.
    console.error(`[user:bind-line] ${phase} failed; outcome unconfirmed`);
    return {
      ok: false,
      errorCode: "BIND_OUTCOME_UNCONFIRMED",
      error: LINE_MSG.BIND_UNCONFIRMED,
    };
  }
}

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
 * The accessibility mode a profile implies: a wheelchair user routes as
 * `wheelchair`, a user needing visual assistance as `visual_impaired`;
 * otherwise the profile implies none.
 *
 * @param profile Stored accessibility profile, possibly partial or absent.
 */
export function accessibilityModeFromProfile(
  profile: Partial<IA11yProfile> | null | undefined,
): AccessibilityMode | undefined {
  if (
    profile?.mobilityAid === "manual_wheelchair" ||
    profile?.mobilityAid === "power_wheelchair"
  )
    return "wheelchair";
  if (profile?.visualAssistance === true) return "visual_impaired";
  return undefined;
}

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
