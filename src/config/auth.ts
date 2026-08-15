import User from "../model/user.model";
import { toPublicUser, verifyAccessToken } from "./jwt";
import type { IUser } from "../types";

export type AuthenticateResult =
  { ok: true; userId: string; user: IUser } | { ok: false; expired: boolean };

/**
 * Verify an access token and confirm it has not been revoked.
 *
 * A token is revoked when its tokenVersion no longer matches the one stored on
 * the user, which is how password changes and resets invalidate tokens that were
 * issued earlier. Every entry point that authenticates a request must go through
 * this helper, otherwise revocation only covers part of the API.
 *
 * @param token Raw JWT access token, without the "Bearer " prefix.
 * @returns The fresh user on success, or whether the token was merely expired.
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
  if (!userId) return { ok: false, expired: false };

  let user;
  try {
    user = await User.findById(userId);
  } catch {
    return { ok: false, expired: false };
  }
  if (!user) return { ok: false, expired: false };

  if (Number(user.tokenVersion ?? 0) !== Number(claimed?.tokenVersion ?? -1)) {
    return { ok: false, expired: false };
  }

  return { ok: true, userId, user: toPublicUser(user) };
}
