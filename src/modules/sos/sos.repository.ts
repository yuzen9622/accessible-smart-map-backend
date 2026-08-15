import SosSession from "../../model/sos-session.model";
import EmergencyContact from "../../model/emergency-contact.model";
import User from "../../model/user.model";
import type { ISosSession } from "../../types";

/** An SOS session as stored, as a plain object. */
export type SosSessionRecord = ISosSession & { _id: unknown };

/** The (owner, name) pair the notification fan-out keys off. */
export interface BoundContactRef {
  userId: string;
  name?: string;
}

/**
 * Bound contacts for one LINE user, across every owner they serve.
 *
 * @param lineUserId The acting LINE user
 * @returns Owner id and display name per bound contact
 */
export async function findBoundContactsByLineUser(
  lineUserId: string,
): Promise<BoundContactRef[]> {
  return EmergencyContact.find({ lineUserId, bindStatus: "bound" })
    .select("userId name")
    .lean<BoundContactRef[]>();
}

/**
 * The bound contact linking one owner to one LINE user.
 *
 * @param ownerUserId Session owner
 * @param lineUserId The acting LINE user
 * @returns The contact's id and name, or null when not bound
 */
export async function findBoundContact(
  ownerUserId: string,
  lineUserId: string,
): Promise<{ _id: unknown; name?: string } | null> {
  return EmergencyContact.findOne({
    userId: ownerUserId,
    lineUserId,
    bindStatus: "bound",
  })
    .select("name")
    .lean<{ _id: unknown; name?: string } | null>();
}

/**
 * LINE user ids of an owner's bound contacts.
 *
 * @param userId Owner
 * @returns Bound LINE user ids
 */
export async function findBoundLineUserIds(userId: string): Promise<string[]> {
  const contacts = await EmergencyContact.find({
    userId,
    bindStatus: "bound",
    lineUserId: { $ne: null },
  })
    .select("lineUserId")
    .lean<{ lineUserId?: string }[]>();
  return contacts
    .map((c) => c.lineUserId)
    .filter((id): id is string => Boolean(id));
}

/**
 * Reads a user's display name, tolerating lookup failures.
 *
 * @param userId User to name
 * @returns The name, or undefined when unknown or unreadable
 */
export async function findUserName(
  userId: string,
): Promise<string | undefined> {
  const user = await User.findById(userId).select("name").lean();
  return (user as { name?: string } | null)?.name;
}

/**
 * One session by id.
 *
 * @param sessionId Session id
 * @returns The session, or null when unknown
 */
export async function findSessionById(
  sessionId: string,
): Promise<SosSessionRecord | null> {
  return SosSession.findById(sessionId).lean<SosSessionRecord | null>();
}

/**
 * One session by its public share token.
 *
 * @param shareToken The 32-char share token
 * @returns The session, or null when unknown
 */
export async function findSessionByShareToken(
  shareToken: string,
): Promise<SosSessionRecord | null> {
  return SosSession.findOne({ shareToken }).lean<SosSessionRecord | null>();
}

/**
 * The owner's currently active session, if any.
 *
 * @param userId Owner
 * @returns The active session, or null
 */
export async function findActiveSessionByUser(
  userId: string,
): Promise<SosSessionRecord | null> {
  return SosSession.findOne({
    userId,
    status: "active",
  }).lean<SosSessionRecord | null>();
}

/**
 * Inserts a session. The unique partial index on `{userId} where status=active`
 * is left to reject double-taps, so an `E11000` propagates to the caller.
 *
 * @param doc The session to store
 * @returns The stored session
 */
export async function insertSession(
  doc: Record<string, unknown>,
): Promise<SosSessionRecord> {
  const created = await SosSession.create(doc);
  return created.toObject() as unknown as SosSessionRecord;
}

/**
 * Moves an active session owned by the caller to a new location.
 *
 * @param sessionId Session id
 * @param patch New coordinates and optional address
 * @returns The session after the update, or null when it is no longer active
 */
export async function updateActiveSessionLocation(
  sessionId: string,
  patch: { lat: number; lng: number; address?: string | null },
): Promise<SosSessionRecord | null> {
  const set: Record<string, unknown> = {
    lat: patch.lat,
    lng: patch.lng,
    locationUpdatedAt: new Date(),
    staleAlertSent: false,
  };
  if (patch.address !== undefined) set.address = patch.address;
  return SosSession.findOneAndUpdate(
    { _id: sessionId, status: "active" },
    { $set: set },
    { returnDocument: "after" },
  ).lean<SosSessionRecord | null>();
}

/**
 * Records a contact's acknowledgement, at most once per LINE user.
 *
 * @param sessionId Session id
 * @param lineUserId Acknowledging contact
 * @param acknowledgement The acknowledgement entry to push
 * @param timelineEntry The timeline entry to push alongside it
 * @returns True when this call was the one that recorded it
 */
export async function pushAcknowledgement(
  sessionId: string,
  lineUserId: string,
  acknowledgement: Record<string, unknown>,
  timelineEntry: Record<string, unknown>,
): Promise<boolean> {
  const res = await SosSession.updateOne(
    {
      _id: sessionId,
      status: "active",
      "acknowledgements.lineUserId": { $ne: lineUserId },
    },
    { $push: { acknowledgements: acknowledgement, timeline: timelineEntry } },
  );
  return res.modifiedCount > 0;
}

/**
 * Promotes `notified` to `acknowledged`, leaving any later status alone.
 *
 * @param sessionId Session id
 */
export async function promoteToAcknowledged(sessionId: string): Promise<void> {
  await SosSession.updateOne(
    { _id: sessionId, handlingStatus: "notified" },
    { $set: { handlingStatus: "acknowledged" } },
  );
}

/**
 * Claims an unclaimed active session.
 *
 * @param sessionId Session id
 * @param set Claim attribution fields
 * @param timelineEntry The timeline entry to push
 * @returns True when this call was the one that claimed it
 */
export async function claimUnclaimedSession(
  sessionId: string,
  set: Record<string, unknown>,
  timelineEntry: Record<string, unknown>,
): Promise<boolean> {
  // `new: false` returns the pre-update document, so a non-null result means
  // this call is the one that matched the still-unclaimed filter.
  const prev = await SosSession.findOneAndUpdate(
    {
      _id: sessionId,
      status: "active",
      $or: [{ claimedBy: null }, { claimedBy: { $exists: false } }],
    },
    { $set: set, $push: { timeline: timelineEntry } },
    { new: false },
  );
  return Boolean(prev);
}

/**
 * Appends a handling-status update to an active session.
 *
 * @param sessionId Session id
 * @param update The `$set`/`$push` document to apply
 * @returns The session after the update, or null when it is no longer active
 */
export async function applyHandlingUpdate(
  sessionId: string,
  update: Record<string, unknown>,
): Promise<SosSessionRecord | null> {
  return SosSession.findOneAndUpdate(
    { _id: sessionId, status: "active" },
    update,
    { returnDocument: "after" },
  ).lean<SosSessionRecord | null>();
}

/**
 * Flips an active session to resolved, atomically so only one caller wins.
 *
 * @param sessionId Session id
 * @param set The resolution fields
 * @param timelineEntry The timeline entry to push
 * @returns True when this call was the one that resolved it
 */
export async function resolveActiveSession(
  sessionId: string,
  set: Record<string, unknown>,
  timelineEntry: Record<string, unknown>,
): Promise<boolean> {
  // `new: false` returns the pre-update document, so a non-null result means
  // this call is the one that flipped active → resolved.
  const prev = await SosSession.findOneAndUpdate(
    { _id: sessionId, status: "active" },
    { $set: set, $push: { timeline: timelineEntry } },
    { new: false },
  );
  return Boolean(prev);
}
