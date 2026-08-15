import { Types } from "mongoose";
import {
  findBoundContactOwner,
  findBoundContacts,
  findSosHistory,
  findUserNames,
  releaseBoundContact,
  renameBoundContact as renameBoundContactRow,
} from "./line-menu.repository";
import { LINE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type {
  LineBoundContact,
  LineServiceResult,
  LineSosHistoryData,
  LineSosHistoryEntry,
} from "./line.types";

const MAX_BOUND_CONTACTS = 10;
const MAX_HISTORY_ENTRIES = 10;
const MAX_OWNER_FILTERS = 8;
const MAX_CONTACT_NAME_LENGTH = 50;

function fail<T = never>(
  httpCode: ResponseCode,
  message: string,
): LineServiceResult<T> {
  return { ok: false, httpCode, message };
}

function notFound<T = never>(): LineServiceResult<T> {
  return fail(ResponseCode.NOT_FOUND, LINE_MSG.SOS_CONTACT_NOT_FOUND);
}

interface BoundContactDoc {
  _id: unknown;
  name: string;
  userId: string;
  updatedAt?: Date;
}

/**
 * Reads every emergency-contact record this LINE account is currently bound to.
 * Authorization is expressed as part of the query (`lineUserId` + `bound`), so no
 * caller-supplied identifier is ever trusted on its own.
 *
 * @param lineUserId The LINE user id of the caller.
 * @returns The bound contact documents, newest first.
 */
async function boundContactDocs(lineUserId: string): Promise<BoundContactDoc[]> {
  return findBoundContacts(lineUserId) as unknown as Promise<BoundContactDoc[]>;
}

/**
 * Resolves owner display names for a set of user ids.
 *
 * @param ownerIds Owner user ids collected from bound contacts.
 * @returns A map of user id to display name; missing users are absent.
 */
async function ownerNames(ownerIds: string[]): Promise<Map<string, string>> {
  if (!ownerIds.length) return new Map();
  const owners = await findUserNames(ownerIds);
  return new Map(
    owners.map((owner) => [String(owner._id), owner.name ?? "未命名使用者"]),
  );
}

/**
 * Lists the users this LINE account is bound to as an emergency contact, together
 * with the display name the owner sees for this contact.
 *
 * @param lineUserId The LINE user id of the caller.
 * @returns Up to 10 bound contacts; owners whose account no longer exists are skipped.
 */
export async function listBoundContacts(
  lineUserId: string,
): Promise<LineServiceResult<LineBoundContact[]>> {
  if (!lineUserId) return notFound();

  const contacts = await boundContactDocs(lineUserId);
  const names = await ownerNames(contacts.map((contact) => contact.userId));
  const data = contacts
    .filter((contact) => names.has(contact.userId))
    .slice(0, MAX_BOUND_CONTACTS)
    .map((contact): LineBoundContact => ({
      contactId: String(contact._id),
      contactName: contact.name,
      ownerId: contact.userId,
      ownerName: names.get(contact.userId) as string,
      updatedAt: contact.updatedAt,
    }));

  return { ok: true, httpCode: ResponseCode.OK, message: "OK", data };
}

export interface RenameBoundContactInput {
  lineUserId: string;
  contactId: string;
  name: string;
}

/**
 * Renames the display name the owner sees for this contact. The update filter
 * carries the authorization, so a contact id belonging to somebody else simply
 * matches nothing and is reported with the same message as a missing record.
 *
 * @param input The caller's LINE user id, the contact id, and the new name.
 * @returns The updated contact name on success.
 */
export async function renameBoundContact(
  input: RenameBoundContactInput,
): Promise<LineServiceResult<{ name: string }>> {
  const name = input.name.trim();
  if (!input.lineUserId) return notFound();
  if (!name || name.length > MAX_CONTACT_NAME_LENGTH) {
    return fail(ResponseCode.INVALID_INPUT, LINE_MSG.SOS_RENAME_INVALID);
  }
  if (!Types.ObjectId.isValid(input.contactId)) return notFound();

  const renamed = await renameBoundContactRow(
    input.contactId,
    input.lineUserId,
    name,
  );
  if (!renamed) return notFound();

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: `已將顯示名稱改為「${name}」。`,
    data: { name },
  };
}

export interface UnbindContactInput {
  lineUserId: string;
  contactId: string;
}

/**
 * Releases this LINE account from an owner's emergency-contact slot. The slot is
 * kept and returned to `pending` (mirroring the unfollow path) so the owner can
 * re-issue a binding code instead of losing the contact entry. `bindCode` is
 * cleared with `$unset` because the unique+sparse index still collides on an
 * explicitly stored `null`.
 *
 * @param input The caller's LINE user id and the contact id to release.
 * @returns The owner name of the released binding on success.
 */
export async function unbindContact(
  input: UnbindContactInput,
): Promise<LineServiceResult<{ ownerName: string }>> {
  if (!input.lineUserId) return notFound();
  if (!Types.ObjectId.isValid(input.contactId)) return notFound();

  const contact = await findBoundContactOwner(
    input.contactId,
    input.lineUserId,
  );
  if (!contact) return notFound();

  const released = await releaseBoundContact(
    input.contactId,
    input.lineUserId,
  );
  if (!released) return notFound();

  const names = await ownerNames([contact.userId]);
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: LINE_MSG.SOS_UNBIND_DONE,
    data: { ownerName: names.get(contact.userId) ?? "該使用者" },
  };
}

export interface ListSosHistoryInput {
  lineUserId: string;
  ownerId?: string;
}

/**
 * Lists past SOS sessions of every user this LINE account is bound to, newest
 * first. An `ownerId` filter is only honoured when that owner is actually bound
 * to this LINE account, so the filter cannot be used to read a stranger's data.
 *
 * @param input The caller's LINE user id and an optional owner filter.
 * @returns Up to 10 history entries plus the owner list used for filter buttons.
 */
export async function listSosHistory(
  input: ListSosHistoryInput,
): Promise<LineServiceResult<LineSosHistoryData>> {
  if (!input.lineUserId) return notFound();

  const contacts = await boundContactDocs(input.lineUserId);
  const names = await ownerNames(contacts.map((contact) => contact.userId));
  const ownerIds = [...new Set(contacts.map((contact) => contact.userId))].filter(
    (ownerId) => names.has(ownerId),
  );
  if (!ownerIds.length) {
    return fail(ResponseCode.NOT_FOUND, LINE_MSG.SOS_NO_CONTACTS);
  }
  if (input.ownerId && !ownerIds.includes(input.ownerId)) return notFound();

  const owners = ownerIds.slice(0, MAX_OWNER_FILTERS).map((ownerId) => ({
    ownerId,
    ownerName: names.get(ownerId) as string,
  }));

  const sessions = (await findSosHistory(
    input.ownerId,
    ownerIds,
    MAX_HISTORY_ENTRIES,
  )) as unknown as Array<
    Omit<LineSosHistoryEntry, "sessionId" | "ownerId" | "ownerName"> & {
      _id: unknown;
      userId: string;
    }
  >;

  const entries = sessions.map((session): LineSosHistoryEntry => ({
    sessionId: String(session._id),
    ownerId: session.userId,
    ownerName: names.get(session.userId) ?? "未命名使用者",
    type: session.type,
    status: session.status,
    handlingStatus: session.handlingStatus,
    address: session.address,
    createdAt: session.createdAt,
    resolvedAt: session.resolvedAt,
    claimedByName: session.claimedByName,
  }));

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: "OK",
    data: { entries, owners, activeOwnerId: input.ownerId },
  };
}
