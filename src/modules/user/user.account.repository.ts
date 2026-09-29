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
import UserMemory from "../../model/user-memory.model";
import Review from "../../model/review.model";
import HazardReport from "../../model/hazard-report.model";

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
 * Hard-deletes every record that belongs only to the user: config, auth and
 * password-assistance tokens, LINE link code, emergency contacts, SOS history,
 * push tokens, AI memories and reviews.
 *
 * @param userId Owner's user id
 * @param email Owner's email, which keys password-assistance jobs
 */
export async function deleteOwnedRecords(
  userId: string,
  email: string,
): Promise<void> {
  const deleteConfig = Types.ObjectId.isValid(userId)
    ? Config.deleteMany({ user_id: userId })
    : Promise.resolve();
  await Promise.all([
    deleteConfig,
    AuthToken.deleteMany({ userId }),
    PasswordAssistanceJob.deleteMany({ email }),
    LineLinkCode.deleteMany({ userId }),
    EmergencyContact.deleteMany({ userId }),
    SosSession.deleteMany({ userId }),
    PushToken.deleteMany({ userId }),
    UserMemory.deleteMany({ userId }),
    Review.deleteMany({ userId }),
  ]);
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
): Promise<void> {
  await Promise.all([
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
