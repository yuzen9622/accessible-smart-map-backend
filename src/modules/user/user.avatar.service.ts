import { createHash } from "node:crypto";
import {
  deleteAvatarObject,
  deleteAvatarObjects,
  getAvatarStoragePath,
  readAvatarObject,
  uploadAvatarObject,
} from "../../adapters/gcs.adapter";
import { findUserAvatar, swapUserAvatar } from "./user.repository";
import { AvatarImageError, normalizeAvatarImage } from "./user.avatar-image";

export type UpdateAvatarResult =
  | { ok: true; avatarUrl: string }
  | {
      ok: false;
      reason: "AVATAR_INVALID" | "AVATAR_UNSUPPORTED" | "NOT_FOUND";
    };

/**
 * Public, unguessable URL of one avatar version. It is served by this backend
 * (the bucket stays private) and resolved by clients against the API origin.
 */
export function avatarUrl(userId: string, hash: string): string {
  return `/api/v1/avatars/${userId}/${hash}.jpg`;
}

/** The storage path behind one of our avatar URLs; null for provider URLs. */
function storagePathOf(userId: string, url: string): string | null {
  const prefix = `/api/v1/avatars/${userId}/`;
  const match = url.startsWith(prefix)
    ? /^([0-9a-f]{16})\.jpg$/.exec(url.slice(prefix.length))
    : null;
  return match ? getAvatarStoragePath(userId, match[1]) : null;
}

/**
 * Normalizes and stores a new avatar, points the user at it, then removes the
 * avatar version it replaced.
 *
 * @param userId The authenticated user's id
 * @param bytes Raw uploaded image bytes
 * @returns The new avatar URL, or why it was rejected
 */
export async function updateAvatar(
  userId: string,
  bytes: Buffer,
): Promise<UpdateAvatarResult> {
  let jpeg: Buffer;
  try {
    jpeg = await normalizeAvatarImage(bytes);
  } catch (error) {
    if (error instanceof AvatarImageError)
      return { ok: false, reason: error.code };
    throw error;
  }
  const hash = createHash("sha256").update(jpeg).digest("hex").slice(0, 16);
  const storagePath = getAvatarStoragePath(userId, hash);
  await uploadAvatarObject(jpeg, storagePath);

  const url = avatarUrl(userId, hash);
  const previous = await swapUserAvatar(userId, url);
  if (previous === undefined) {
    // The account vanished mid-upload; the deleted-account sweep retries this.
    await purgeUserAvatars(userId);
    return { ok: false, reason: "NOT_FOUND" };
  }
  // Each upload deletes only the version it replaced, so concurrent uploads
  // never delete the one that ends up current.
  const stale = previous && storagePathOf(userId, previous);
  if (stale && stale !== storagePath) {
    try {
      await deleteAvatarObject(stale);
    } catch (error) {
      // Already unreachable (GET checks the current avatar); account deletion
      // purges the prefix.
      console.error("[avatar] stale avatar cleanup failed", error);
    }
  }
  return { ok: true, avatarUrl: url };
}

/**
 * Reads an avatar only while it is the user's current one, so replaced and
 * deleted avatars stop being served even if their objects linger.
 *
 * @returns The JPEG bytes, or null when not the current avatar or missing
 */
export async function readCurrentAvatar(
  userId: string,
  hash: string,
): Promise<Buffer | null> {
  if ((await findUserAvatar(userId)) !== avatarUrl(userId, hash)) return null;
  try {
    return await readAvatarObject(getAvatarStoragePath(userId, hash));
  } catch (error) {
    if ((error as { code?: string })?.code === "GCS_OBJECT_MISSING")
      return null;
    throw error;
  }
}

/**
 * Deletes every stored avatar of a (deleted) account. Idempotent.
 *
 * @returns How many objects were deleted, or -1 when storage failed
 */
export async function purgeUserAvatars(userId: string): Promise<number> {
  try {
    return await deleteAvatarObjects(userId);
  } catch (error) {
    console.error("[avatar] purge failed", error);
    return -1;
  }
}
