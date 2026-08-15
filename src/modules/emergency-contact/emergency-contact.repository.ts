import { Types } from "mongoose";
import EmergencyContact from "../../model/emergency-contact.model";
import type { IEmergencyContact } from "../../types";

/** An emergency contact as stored, with its id surfaced as a plain field. */
export type EmergencyContactRecord = IEmergencyContact & {
  _id: string;
  createdAt?: Date;
};

/** The subset the list endpoint projects. */
export type EmergencyContactSummary = Pick<
  EmergencyContactRecord,
  | "_id"
  | "name"
  | "bindStatus"
  | "lineUserId"
  | "bindCodeExpiresAt"
  | "createdAt"
>;

/**
 * Whether any contact already holds a bind code.
 *
 * @param bindCode Candidate bind code
 * @returns True when the code is already taken
 */
export async function bindCodeExists(bindCode: string): Promise<boolean> {
  return Boolean(await EmergencyContact.exists({ bindCode }));
}

/**
 * Lists one owner's contacts, newest first.
 *
 * @param userId Owner's user id
 * @returns Contact summaries
 */
export async function findContactsByUser(
  userId: string,
): Promise<EmergencyContactSummary[]> {
  return EmergencyContact.find({ userId })
    .sort({ createdAt: -1 })
    .select("name bindStatus lineUserId bindCodeExpiresAt createdAt")
    .lean<EmergencyContactSummary[]>();
}

/**
 * Counts one owner's contacts.
 *
 * @param userId Owner's user id
 * @returns How many contacts the owner has
 */
export async function countContactsByUser(userId: string): Promise<number> {
  return EmergencyContact.countDocuments({ userId });
}

/**
 * Inserts a contact.
 *
 * @param input The contact to store
 * @returns The stored contact
 */
export async function insertContact(input: {
  userId: string;
  name: string;
  bindStatus: IEmergencyContact["bindStatus"];
  bindCode: string;
  bindCodeExpiresAt: Date;
}): Promise<EmergencyContactRecord> {
  const contact = await EmergencyContact.create(input);
  return contact.toObject() as EmergencyContactRecord;
}

/**
 * Looks up a contact by id.
 *
 * @param contactId Candidate contact id
 * @returns The contact, or null when the id is malformed or unknown
 */
export async function findContactById(
  contactId: string,
): Promise<EmergencyContactRecord | null> {
  if (!Types.ObjectId.isValid(contactId)) return null;
  return EmergencyContact.findById(
    contactId,
  ).lean<EmergencyContactRecord | null>();
}

/**
 * Deletes a contact by id.
 *
 * @param contactId Contact id to delete
 */
export async function deleteContactById(contactId: string): Promise<void> {
  await EmergencyContact.deleteOne({ _id: contactId });
}
