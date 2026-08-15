import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";

/** The active session fields the LINE route preview reads. */
export interface ActiveSessionRow {
  _id: unknown;
  userId: unknown;
  lat: number;
  lng: number;
  address?: string | null;
}

/** The last-known location a bound contact shared over LINE. */
export interface ContactLastLocation {
  lastLineLat?: number | null;
  lastLineLng?: number | null;
  lastLineLocationUpdatedAt?: Date | null;
}

/**
 * Stamps the latest LINE-shared location onto every slot this account is bound to.
 *
 * @param lineUserId The sharing LINE user
 * @param latitude Latitude just shared
 * @param longitude Longitude just shared
 */
export async function updateBoundContactLocations(
  lineUserId: string,
  latitude: number,
  longitude: number,
): Promise<void> {
  await EmergencyContact.updateMany(
    { lineUserId, bindStatus: "bound" },
    {
      $set: {
        lastLineLat: latitude,
        lastLineLng: longitude,
        lastLineLocationUpdatedAt: new Date(),
      },
    },
  );
}

/**
 * Releases every slot a LINE account holds, used when the account unfollows.
 *
 * @param lineUserId The unfollowing LINE user
 */
export async function releaseContactsForLineUser(
  lineUserId: string,
): Promise<void> {
  await EmergencyContact.updateMany(
    { lineUserId },
    { $set: { bindStatus: "pending", lineUserId: null } },
  );
}

/**
 * An active session addressed by its public share token.
 *
 * @param shareToken The share token
 * @returns The session, or null when unknown or no longer active
 */
export async function findActiveSessionByShareToken(
  shareToken: string,
): Promise<ActiveSessionRow | null> {
  return SosSession.findOne({
    shareToken,
    status: "active",
  }).lean<ActiveSessionRow | null>();
}

/**
 * The most recently located bound contact of an owner.
 *
 * @param ownerUserId Session owner
 * @returns That contact's last shared location, or null when nobody has shared one
 */
export async function findLatestLocatedContact(
  ownerUserId: string,
): Promise<ContactLastLocation | null> {
  return EmergencyContact.findOne({
    userId: ownerUserId,
    bindStatus: "bound",
    lineUserId: { $ne: null },
    lastLineLat: { $ne: null },
    lastLineLng: { $ne: null },
  })
    .sort({ lastLineLocationUpdatedAt: -1, updatedAt: -1 })
    .select("lastLineLat lastLineLng lastLineLocationUpdatedAt")
    .lean<ContactLastLocation | null>();
}

/**
 * Reads a user's display name.
 *
 * @param userId User to name
 * @returns The name, or undefined when unknown
 */
export async function findUserName(
  userId: string,
): Promise<string | undefined> {
  const user = await User.findById(userId).select("name").lean();
  return (user as { name?: string } | null)?.name;
}
