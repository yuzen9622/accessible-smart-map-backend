import ContentReport from "../../model/content-report.model";
import UserBlock from "../../model/user-block.model";
import { Types } from "mongoose";
import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthSession from "../../model/auth-session.model";
import AuthToken from "../../model/auth-token.model";
import PasswordAssistanceJob from "../../model/password-assistance-job.model";
import LineLinkCode from "../../model/line-link-code.model";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import PushToken from "../../model/push-token.model";
import Review from "../../model/review.model";
import HazardReport from "../../model/hazard-report.model";
import UserMemory, {
  MEMORY_TOMBSTONE_UNSET,
} from "../../model/user-memory.model";
import DeletedAccount from "../../model/deleted-account.model";

/**
 * When the given session was created, i.e. when its owner last signed in.
 * Refresh rotation updates the session in place, so this stays the sign-in time.
 *
 * @param sessionId AuthSession id
 * @param userId Owner, as an ownership guard
 * @returns The sign-in time, or null when the session is missing or not owned
 */
export async function findSessionSignedInAt(
  sessionId: string,
  userId: string,
): Promise<Date | null> {
  if (!Types.ObjectId.isValid(sessionId)) return null;
  const session = await AuthSession.findOne({ _id: sessionId, userId })
    .select("createdAt")
    .lean<{ createdAt?: Date }>();
  return session?.createdAt ?? null;
}

/**
 * Reads the account fields deletion needs, including the hidden Apple subject.
 *
 * @param userId Owner's user id
 * @returns Email and Apple subject, or null when the user does not exist
 */
export async function findAccountForDeletion(
  userId: string,
): Promise<{ email: string; appleUserId: string | null } | null> {
  const user = await User.findById(userId)
    .select("email +appleUserId")
    .lean<{ email: string; appleUserId?: string | null }>();
  if (!user) return null;
  return { email: user.email, appleUserId: user.appleUserId ?? null };
}

/**
 * Hard-deletes every record that belongs only to the user and is keyed by
 * their id: config, auth tokens and sessions, LINE link code, emergency
 * contacts, SOS history, push tokens and reviews. AI memories are tombstoned
 * separately (their vectors need reconciling). Each owner field is matched
 * with its stored type: `Config.user_id` is an ObjectId, the rest are strings.
 *
 * @param userId Owner's user id
 * @returns How many documents were deleted
 */
export async function deleteOwnedRecords(userId: string): Promise<number> {
  const results = await Promise.all([
    Types.ObjectId.isValid(userId)
      ? Config.deleteMany({ user_id: new Types.ObjectId(userId) })
      : Promise.resolve({ deletedCount: 0 }),
    AuthToken.deleteMany({ userId }),
    LineLinkCode.deleteMany({ userId }),
    EmergencyContact.deleteMany({ userId }),
    SosSession.deleteMany({ userId }),
    PushToken.deleteMany({ userId }),
    Review.deleteMany({ userId }),
    UserBlock.deleteMany({
      $or: [{ ownerId: userId }, { blockedUserId: userId }],
    }),
    ContentReport.deleteMany({
      $or: [{ reporterId: userId }, { authorId: userId }],
    }),
  ]);
  return results.reduce((sum, result) => sum + (result.deletedCount ?? 0), 0);
}

/**
 * Tombstones every memory the user still has: content and metadata go, the
 * ids stay so the retention job can reconcile vectors. Vectors themselves are
 * deleted by userId (`deleteMemoryVectors`).
 *
 * @param userId Owner's user id
 * @returns How many memories were tombstoned
 */
export async function tombstoneUserMemories(userId: string): Promise<number> {
  const result = await UserMemory.updateMany(
    { userId, deletedAt: null },
    { $set: { deletedAt: new Date() }, $unset: MEMORY_TOMBSTONE_UNSET },
  );
  return result.modifiedCount;
}

/**
 * Deletes password-assistance jobs for an email. Only called during account
 * deletion itself: afterwards the email may belong to a new account, and any
 * job that lands late expires through its 7-day TTL.
 *
 * @param email The deleted account's email
 */
export async function deletePasswordAssistanceJobs(
  email: string,
): Promise<void> {
  await PasswordAssistanceJob.deleteMany({ email });
}

/**
 * Replaces the user's id on hazard reports with a pseudonym: as reporter, as
 * manual reviewer, and inside other reports' confirm/deny voter lists. Reports stay public so
 * other users keep seeing the hazard, and vote counts stay intact.
 *
 * @param userId Owner's user id
 * @param pseudonym Stand-in id that no real user can hold
 */
export async function anonymizeHazardReports(
  userId: string,
  pseudonym: string,
): Promise<number> {
  const results = await Promise.all([
    HazardReport.updateMany(
      { reporterId: userId },
      { $set: { reporterId: pseudonym } },
    ),
    HazardReport.updateMany(
      { "manualReview.reviewerId": userId },
      { $set: { "manualReview.reviewerId": pseudonym } },
    ),
    HazardReport.updateMany(
      { confirmedBy: userId },
      { $set: { "confirmedBy.$[voter]": pseudonym } },
      { arrayFilters: [{ voter: userId }] },
    ),
    HazardReport.updateMany(
      { deniedBy: userId },
      { $set: { "deniedBy.$[voter]": pseudonym } },
      { arrayFilters: [{ voter: userId }] },
    ),
  ]);
  return results.reduce((sum, result) => sum + result.modifiedCount, 0);
}

/**
 * Deletes the user's sessions and then the user document itself.
 *
 * @param userId Owner's user id
 */
export async function deleteUserAndSessions(userId: string): Promise<void> {
  await AuthSession.deleteMany({ userId });
  await User.deleteOne({ _id: userId });
}

/**
 * Deletes a user's auth sessions (also used by the deleted-account sweep, for
 * sessions a sign-in raced into existence).
 *
 * @param userId Owner's user id
 * @returns How many were deleted
 */
export async function deleteAuthSessions(userId: string): Promise<number> {
  const result = await AuthSession.deleteMany({ userId });
  return result.deletedCount ?? 0;
}

/**
 * Whether the user document still exists.
 *
 * @param userId User id
 */
export async function userExists(userId: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(userId)) return false;
  return Boolean(await User.exists({ _id: userId }));
}

/**
 * Registers an account deletion before any data is removed, so the sweep can
 * clean up writes that race in afterwards. Holds only the user id.
 *
 * @param userId The account being deleted
 */
export async function registerAccountDeletion(userId: string): Promise<void> {
  await DeletedAccount.updateOne(
    { userId },
    { $setOnInsert: { userId, state: "pending" } },
    { upsert: true },
  );
}

/**
 * Marks a registered deletion as complete (the user document is gone).
 *
 * @param userId The deleted account
 */
export async function markAccountDeleted(userId: string): Promise<void> {
  await DeletedAccount.updateOne(
    { userId },
    { $set: { state: "user_deleted", userDeletedAt: new Date() } },
  );
}

/** A registered deletion as the sweep sees it. */
export interface DeletedAccountEntry {
  userId: string;
  state: "pending" | "user_deleted";
  userDeletedAt?: Date;
  lastFoundAt?: Date;
  createdAt: Date;
}

/**
 * One batch of registered deletions not yet swept in this run, least
 * recently swept first.
 *
 * @param runStart Entries swept at or after this were handled this run
 * @param limit Batch size
 */
export async function findDeletedAccountsToSweep(
  runStart: Date,
  limit: number,
): Promise<DeletedAccountEntry[]> {
  return DeletedAccount.find({
    $or: [{ lastSweptAt: null }, { lastSweptAt: { $lt: runStart } }],
  })
    .sort({ lastSweptAt: 1 })
    .limit(limit)
    .lean<DeletedAccountEntry[]>();
}

/**
 * Records a sweep of one entry.
 *
 * @param userId Deleted account
 * @param sweptAt Sweep time
 * @param foundResidue Whether the sweep removed anything
 * @param userGone Whether the user document is confirmed gone
 */
export async function recordDeletedAccountSweep(
  userId: string,
  sweptAt: Date,
  foundResidue: boolean,
  userGone: boolean,
): Promise<void> {
  const set: Record<string, unknown> = { lastSweptAt: sweptAt };
  if (foundResidue) set.lastFoundAt = sweptAt;
  if (userGone) {
    await DeletedAccount.updateOne(
      { userId, state: "pending" },
      { $set: { state: "user_deleted", userDeletedAt: sweptAt } },
    );
  }
  await DeletedAccount.updateOne({ userId }, { $set: set });
}

/**
 * Drops a registered deletion once the sweep is finished with it.
 *
 * @param userId Deleted account
 */
export async function removeDeletedAccountEntry(userId: string): Promise<void> {
  await DeletedAccount.deleteOne({ userId });
}
