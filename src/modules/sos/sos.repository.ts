import { SOS_NOTICE } from "../../constants/sos";
import SosSession from "../../model/sos-session.model";
import EmergencyContact from "../../model/emergency-contact.model";
import User from "../../model/user.model";
import type { ISosSession, ISosInitialNotice } from "../../types";

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
    { _id: sessionId, handlingStatus: { $in: ["pending", "notified"] } },
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

/**
 * Auto-resolves the stalest active session whose location has not moved
 * since `staleCutoff`. The stale condition sits inside the atomic update, so a
 * location upload that lands first keeps the session open.
 *
 * @param staleCutoff Sessions last located at or before this are stale
 * @param now Resolution time
 * @param retryKey Stable LINE retry key for the contact notice
 * @returns The resolved session, or null when none is stale
 */
export async function autoResolveStalestSession(
  staleCutoff: Date,
  now: Date,
  retryKey: string,
): Promise<SosSessionRecord | null> {
  return SosSession.findOneAndUpdate(
    { status: "active", locationUpdatedAt: { $lte: staleCutoff } },
    {
      $set: {
        status: "resolved",
        resolvedAt: now,
        handlingStatus: "resolved",
        autoResolved: true,
        resolvedNotice: {
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          claimId: null,
          retryKey,
          lastError: null,
        },
      },
      $push: {
        timeline: {
          type: "resolved",
          actorType: "system",
          actorLineUserId: null,
          actorName: null,
          note: "auto_resolved_stale",
          at: now,
        },
      },
    },
    { sort: { locationUpdatedAt: 1 }, new: true },
  ).lean<SosSessionRecord>();
}

/**
 * Claims one due auto-resolve notice for delivery. The claim id fences the
 * result write, so a worker whose lease ran out cannot overwrite the outcome
 * of the worker that took over.
 *
 * @param now Current time
 * @param leaseMs How long the claim holds before another worker may retry
 * @param maxAttempts Notices at this many attempts are not claimed again
 * @param claimId Fresh unguessable id for this claim
 * @returns The claimed session, or null when nothing is due
 */
export async function claimDueResolvedNotice(
  now: Date,
  leaseMs: number,
  maxAttempts: number,
  claimId: string,
): Promise<SosSessionRecord | null> {
  return SosSession.findOneAndUpdate(
    {
      "resolvedNotice.status": "pending",
      "resolvedNotice.nextAttemptAt": { $lte: now },
      "resolvedNotice.attempts": { $lt: maxAttempts },
    },
    {
      $set: {
        "resolvedNotice.claimId": claimId,
        "resolvedNotice.nextAttemptAt": new Date(now.getTime() + leaseMs),
      },
      $inc: { "resolvedNotice.attempts": 1 },
    },
    { sort: { "resolvedNotice.nextAttemptAt": 1 }, new: true },
  ).lean<SosSessionRecord>();
}

/**
 * Records a claimed notice as delivered.
 *
 * @param sessionId Session id
 * @param claimId The claim this worker holds
 * @returns True when the claim was still ours
 */
export async function markResolvedNoticeSent(
  sessionId: string,
  claimId: string,
): Promise<boolean> {
  const result = await SosSession.updateOne(
    {
      _id: sessionId,
      "resolvedNotice.claimId": claimId,
      "resolvedNotice.status": "pending",
    },
    {
      $set: {
        "resolvedNotice.status": "sent",
        "resolvedNotice.lastError": null,
      },
    },
  );
  return result.modifiedCount > 0;
}

/**
 * Records a failed attempt; the notice stays pending and becomes due again
 * when the lease set at claim time expires.
 *
 * @param sessionId Session id
 * @param claimId The claim this worker holds
 * @param error Failure description
 * @returns True when the claim was still ours
 */
export async function markResolvedNoticeAttemptFailed(
  sessionId: string,
  claimId: string,
  error: string,
): Promise<boolean> {
  const result = await SosSession.updateOne(
    {
      _id: sessionId,
      "resolvedNotice.claimId": claimId,
      "resolvedNotice.status": "pending",
    },
    { $set: { "resolvedNotice.lastError": error.slice(0, 500) } },
  );
  return result.modifiedCount > 0;
}

/**
 * Gives up on notices that used every attempt and whose last lease expired.
 *
 * @param now Current time
 * @param maxAttempts Attempt limit
 * @param limit Batch size
 * @returns Ids of the sessions marked failed
 */
export async function failExhaustedResolvedNotices(
  now: Date,
  maxAttempts: number,
  limit: number,
): Promise<string[]> {
  const filter: Record<string, unknown> = {
    "resolvedNotice.status": "pending",
    "resolvedNotice.attempts": { $gte: maxAttempts },
    "resolvedNotice.nextAttemptAt": { $lte: now },
  };
  const docs = await SosSession.find(filter)
    .select("_id")
    .limit(limit)
    .lean<{ _id: unknown }[]>();
  const ids = docs.map((d) => String(d._id));
  if (!ids.length) return [];
  await SosSession.updateMany(
    { _id: { $in: ids }, ...filter } as Record<string, unknown>,
    { $set: { "resolvedNotice.status": "failed" } },
  );
  return ids;
}

/**
 * Deletes one batch of sessions resolved at or before the cutoff.
 *
 * @param cutoff Resolution time limit
 * @param limit Batch size
 * @returns Number of sessions deleted
 */
export async function deleteResolvedSessionsBefore(
  cutoff: Date,
  limit: number,
): Promise<number> {
  const filter: Record<string, unknown> = {
    status: "resolved",
    resolvedAt: { $lte: cutoff },
  };
  const docs = await SosSession.find(filter)
    .select("_id")
    .sort({ resolvedAt: 1 })
    .limit(limit)
    .lean<{ _id: unknown }[]>();
  if (!docs.length) return 0;
  const result = await SosSession.deleteMany({
    _id: { $in: docs.map((d) => d._id) },
    ...filter,
  } as Record<string, unknown>);
  return result.deletedCount ?? 0;
}

/**
 * Oldest resolution time still present, for overdue monitoring.
 *
 * @returns The oldest `resolvedAt`, or null
 */
export async function findOldestResolvedAt(): Promise<Date | null> {
  const doc = await SosSession.findOne({ status: "resolved" })
    .sort({ resolvedAt: 1 })
    .select("resolvedAt")
    .lean<{ resolvedAt?: Date | null }>();
  return doc?.resolvedAt ?? null;
}

/** Initializes delivery for legacy sessions without inventing historical success. */
export async function initializeInitialNotice(
  sessionId: string,
  notice: ISosInitialNotice,
): Promise<void> {
  await SosSession.updateOne(
    { _id: sessionId, status: "active", initialNotice: { $exists: false } },
    { $set: { initialNotice: notice } },
  );
}

/** Claims one initial notification, with fencing shared by HTTP retries and workers. */
export async function claimInitialNotice(
  now: Date,
  claimId: string,
  sessionId?: string,
): Promise<SosSessionRecord | null> {
  return SosSession.findOneAndUpdate(
    {
      ...(sessionId ? { _id: sessionId } : {}),
      status: "active",
      "initialNotice.status": { $in: ["queued", "failed"] },
      "initialNotice.attempts": { $lt: SOS_NOTICE.maxAttempts },
      "initialNotice.retryUntil": { $gt: now },
      // Explicit create retries may retry a failed, released attempt immediately.
      ...(sessionId ? {} : { "initialNotice.nextAttemptAt": { $lte: now } }),
      $or: [
        { "initialNotice.claimId": null },
        { "initialNotice.leaseUntil": { $lte: now } },
      ],
    },
    {
      $set: {
        "initialNotice.status": "queued",
        "initialNotice.claimId": claimId,
        "initialNotice.leaseUntil": new Date(
          now.getTime() + SOS_NOTICE.leaseMs,
        ),
      },
      $inc: { "initialNotice.attempts": 1 },
    },
    { returnDocument: "after", sort: { "initialNotice.nextAttemptAt": 1 } },
  ).lean<SosSessionRecord>();
}

/** Records acceptance and its timeline event in the same fenced write. */
export async function acceptInitialNotice(
  sessionId: string,
  claimId: string,
  count: number,
): Promise<void> {
  await SosSession.updateOne(
    {
      _id: sessionId,
      "initialNotice.claimId": claimId,
      "initialNotice.status": "queued",
    },
    [
      {
        $set: {
          "initialNotice.status": "accepted",
          "initialNotice.notifiedCount": count,
          "initialNotice.claimId": null,
          "initialNotice.leaseUntil": null,
          handlingStatus: {
            $cond: [
              { $eq: ["$handlingStatus", "pending"] },
              "notified",
              "$handlingStatus",
            ],
          },
          timeline: {
            $concatArrays: [
              { $ifNull: ["$timeline", []] },
              [{ type: "notified", actorType: "system", at: new Date() }],
            ],
          },
        },
      },
    ],
    { updatePipeline: true },
  );
}

/** Releases a failed attempt; only the current claim may change its state. */
export async function failInitialNotice(
  sessionId: string,
  claimId: string,
  attempts: number,
): Promise<void> {
  await SosSession.updateOne(
    {
      _id: sessionId,
      "initialNotice.claimId": claimId,
      "initialNotice.status": "queued",
    },
    {
      $set: {
        "initialNotice.status": "failed",
        "initialNotice.claimId": null,
        "initialNotice.leaseUntil": null,
        "initialNotice.nextAttemptAt": new Date(
          Date.now() + SOS_NOTICE.retryMs * 2 ** (attempts - 1),
        ),
      },
    },
  );
}

/** A crashed final attempt or expired retry window must not remain queued forever. */
export async function expireInitialNotices(now: Date): Promise<void> {
  await SosSession.updateMany(
    {
      "initialNotice.status": "queued",
      $and: [
        {
          $or: [
            { "initialNotice.claimId": null },
            { "initialNotice.leaseUntil": { $lte: now } },
          ],
        },
        {
          $or: [
            { status: "resolved" },
            { "initialNotice.attempts": { $gte: SOS_NOTICE.maxAttempts } },
            { "initialNotice.retryUntil": { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        "initialNotice.status": "failed",
        "initialNotice.claimId": null,
        "initialNotice.leaseUntil": null,
      },
    },
  );
}
