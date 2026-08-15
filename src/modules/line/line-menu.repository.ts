import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";

/** A bound contact row as the LINE menu reads it. */
export interface BoundContactRow {
  _id: unknown;
  name?: string;
  userId: string;
  updatedAt?: Date;
}

/** One SOS session row as the LINE history view reads it. */
export interface SosHistoryRow {
  _id: unknown;
  userId: string;
  type: string;
  status: string;
  handlingStatus?: string;
  address?: string | null;
  createdAt: Date;
  resolvedAt?: Date | null;
  claimedByName?: string | null;
}

/**
 * The contacts this LINE account is bound to, newest first.
 *
 * @param lineUserId The caller's LINE user id
 * @returns Bound contact rows
 */
export async function findBoundContacts(
  lineUserId: string,
): Promise<BoundContactRow[]> {
  return EmergencyContact.find({ lineUserId, bindStatus: "bound" })
    .sort({ updatedAt: -1 })
    .select("name userId updatedAt")
    .lean() as unknown as Promise<BoundContactRow[]>;
}

/**
 * Display names for a set of users.
 *
 * @param ownerIds User ids to name
 * @returns Rows carrying id and name
 */
export async function findUserNames(
  ownerIds: string[],
): Promise<Array<{ _id: unknown; name?: string }>> {
  return User.find({ _id: { $in: ownerIds } })
    .select("name")
    .lean() as unknown as Promise<Array<{ _id: unknown; name?: string }>>;
}

/**
 * Renames a contact slot this LINE account owns.
 *
 * @param contactId Contact id
 * @param lineUserId The caller's LINE user id, as an ownership guard
 * @param name The new display name
 * @returns True when a matching bound contact was found
 */
export async function renameBoundContact(
  contactId: string,
  lineUserId: string,
  name: string,
): Promise<boolean> {
  const result = await EmergencyContact.updateOne(
    { _id: contactId, lineUserId, bindStatus: "bound" },
    { $set: { name } },
  );
  return Boolean(result.matchedCount);
}

/**
 * Reads the owner of a bound contact slot.
 *
 * @param contactId Contact id
 * @param lineUserId The caller's LINE user id, as an ownership guard
 * @returns The owner's user id, or null when not bound to this caller
 */
export async function findBoundContactOwner(
  contactId: string,
  lineUserId: string,
): Promise<{ userId: string } | null> {
  return EmergencyContact.findOne({
    _id: contactId,
    lineUserId,
    bindStatus: "bound",
  })
    .select("userId")
    .lean() as unknown as Promise<{ userId: string } | null>;
}

/**
 * Returns a bound slot to `pending`, releasing this LINE account.
 *
 * `bindCode` is cleared with `$unset` because the unique+sparse index still
 * collides on an explicitly stored `null`.
 *
 * @param contactId Contact id
 * @param lineUserId The caller's LINE user id, as an ownership guard
 * @returns True when a matching bound contact was found
 */
export async function releaseBoundContact(
  contactId: string,
  lineUserId: string,
): Promise<boolean> {
  const result = await EmergencyContact.updateOne(
    { _id: contactId, lineUserId, bindStatus: "bound" },
    {
      $set: {
        bindStatus: "pending",
        lineUserId: null,
        lastLineLat: null,
        lastLineLng: null,
        lastLineLocationUpdatedAt: null,
      },
      $unset: { bindCode: "", bindCodeExpiresAt: "" },
    },
  );
  return Boolean(result.matchedCount);
}

/**
 * SOS history for one owner, or across several, newest first.
 *
 * @param ownerId A single owner to filter to, when given
 * @param ownerIds Every owner the caller may see
 * @param limit Maximum rows
 * @returns History rows
 */
export async function findSosHistory(
  ownerId: string | undefined,
  ownerIds: string[],
  limit: number,
): Promise<SosHistoryRow[]> {
  return SosSession.find({
    userId: ownerId ? ownerId : { $in: ownerIds },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select(
      "userId type status handlingStatus address createdAt resolvedAt claimedByName",
    )
    .lean() as unknown as Promise<SosHistoryRow[]>;
}
