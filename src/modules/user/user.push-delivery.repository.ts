import { Types } from "mongoose";
import PushToken from "../../model/push-token.model";
import User from "../../model/user.model";
import AuthSession from "../../model/auth-session.model";
import DeletedAccount from "../../model/deleted-account.model";
import type { IPushToken } from "../../types";

export const PUSH_DELIVERY_DB_OPTIONS = { maxTimeMS: 5_000, timeoutMS: 5_000 };

/** Durable callers must see storage errors, not confuse them with an empty set. */
export async function findDeliveryTokens(
  userId: string,
): Promise<IPushToken[]> {
  return PushToken.find({ userId }, null, PUSH_DELIVERY_DB_OPTIONS).lean<
    IPushToken[]
  >();
}

/** Recheck account, deletion tombstone, session and current device ownership at dispatch.
 * Returns false for missing/rebound/revoked entries; DB errors deliberately propagate. */
export async function isPushDeliveryActive(
  token: IPushToken,
): Promise<boolean> {
  if (
    !Types.ObjectId.isValid(token.userId) ||
    !Types.ObjectId.isValid(token.authSessionId)
  )
    return false;
  const [user, deleted, session, registration] = await Promise.all([
    User.exists({ _id: token.userId }).setOptions(PUSH_DELIVERY_DB_OPTIONS),
    DeletedAccount.exists({ userId: token.userId }).setOptions(
      PUSH_DELIVERY_DB_OPTIONS,
    ),
    AuthSession.exists({
      _id: token.authSessionId,
      userId: token.userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).setOptions(PUSH_DELIVERY_DB_OPTIONS),
    PushToken.exists({
      _id: token._id,
      token: token.token,
      userId: token.userId,
      authSessionId: token.authSessionId,
    }).setOptions(PUSH_DELIVERY_DB_OPTIONS),
  ]);
  return Boolean(user && !deleted && session && registration);
}
