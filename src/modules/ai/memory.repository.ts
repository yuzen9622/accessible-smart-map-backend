import UserMemory, {
  MEMORY_TOMBSTONE_UNSET,
  type IUserMemory,
} from "../../model/user-memory.model";
import Config from "../../model/config.model";
import DeletedAccount from "../../model/deleted-account.model";

export type { IUserMemory };

/**
 * Matches memories that are live: not tombstoned and not past `expiresAt`.
 * `deletedAt: null` matches both the absent and the explicit-null shape, as
 * older documents were written before `deletedAt` existed.
 *
 * @param now Expiry reference time
 */
export function liveMemoryFilter(now = new Date()): Record<string, unknown> {
  return {
    deletedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
}

function activeMemoryFilter(userId: string): Record<string, unknown> {
  return { userId, ...liveMemoryFilter() };
}

/** A tombstoned memory's vector address. */
export interface MemoryVectorRef {
  memoryId: string;
  userId: string;
  vectorId: string;
}

function toVectorRef(row: {
  _id: unknown;
  userId: string;
  embeddingId?: string | null;
}): MemoryVectorRef {
  const memoryId = String(row._id);
  return {
    memoryId,
    userId: row.userId,
    vectorId: row.embeddingId ?? memoryId,
  };
}

/**
 * Reads a user's memory opt-in flag from their Config.
 *
 * @param userId Owner
 * @returns Whether memory capture is enabled
 */
export async function findMemoryEnabled(userId: string): Promise<boolean> {
  const config = await Config.findOne({ user_id: userId })
    .select("memoryEnabled")
    .lean();
  return Boolean(config?.memoryEnabled);
}

/**
 * Sets a user's memory opt-in flag in their Config.
 *
 * @param userId Owner
 * @param memoryEnabled Desired flag value
 * @returns The flag after the update
 */
export async function setMemoryEnabled(
  userId: string,
  memoryEnabled: boolean,
): Promise<boolean> {
  const config = await Config.findOneAndUpdate(
    { user_id: userId },
    { $set: { memoryEnabled } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  )
    .select("memoryEnabled")
    .lean();
  return Boolean(config?.memoryEnabled);
}

/**
 * A user's live memories, most recently updated first.
 *
 * @param userId Owner
 * @param limit Maximum rows
 * @returns Still-encrypted memories
 */
export async function findActiveMemories(
  userId: string,
  limit: number,
): Promise<IUserMemory[]> {
  return UserMemory.find(activeMemoryFilter(userId))
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean<IUserMemory[]>();
}

/**
 * Finds a live memory carrying the same retrieval text in the same category.
 *
 * @param userId Owner
 * @param category Memory category
 * @param retrievalText Normalised retrieval text
 * @returns The existing memory, or null
 */
export async function findMemoryByRetrievalText(
  userId: string,
  category: IUserMemory["category"],
  retrievalText: string,
): Promise<IUserMemory | null> {
  return UserMemory.findOne({
    ...activeMemoryFilter(userId),
    category,
    retrievalText,
  }).lean<IUserMemory | null>();
}

/**
 * One live memory owned by a user.
 *
 * @param userId Owner
 * @param memoryId Memory id
 * @returns The memory, or null when missing, deleted, or not owned
 */
export async function findActiveMemoryById(
  userId: string,
  memoryId: string,
): Promise<IUserMemory | null> {
  return UserMemory.findOne({
    ...activeMemoryFilter(userId),
    _id: memoryId,
  }).lean<IUserMemory | null>();
}

/**
 * Applies a `$set` to a memory addressed by id.
 *
 * @param memoryId Memory id
 * @param fields Fields to set
 * @returns The memory after the update, or null when it vanished
 */
export async function updateMemoryById(
  memoryId: string,
  fields: Record<string, unknown>,
): Promise<IUserMemory | null> {
  // Guarded on liveness so a write racing a delete or retention purge cannot
  // put content back into a tombstone.
  return UserMemory.findOneAndUpdate(
    { _id: memoryId, ...liveMemoryFilter() },
    { $set: fields },
    { returnDocument: "after" },
  ).lean<IUserMemory | null>();
}

/**
 * Applies a `$set` to a memory addressed by id and owner.
 *
 * @param memoryId Memory id
 * @param userId Owner
 * @param fields Fields to set
 * @returns The memory after the update, or null when missing or not owned
 */
export async function updateOwnedMemory(
  memoryId: string,
  userId: string,
  fields: Record<string, unknown>,
): Promise<IUserMemory | null> {
  return UserMemory.findOneAndUpdate(
    { _id: memoryId, ...activeMemoryFilter(userId) },
    { $set: fields },
    { returnDocument: "after" },
  ).lean<IUserMemory | null>();
}

/**
 * Inserts a memory.
 *
 * @param doc The memory to store
 * @returns The stored memory
 */
export async function insertMemory(
  doc: Record<string, unknown>,
): Promise<IUserMemory> {
  const created = await UserMemory.create(doc);
  return created.toObject() as IUserMemory;
}

/**
 * Counts a user's live memories.
 *
 * @param userId Owner
 * @returns The live memory count
 */
export async function countActiveMemories(userId: string): Promise<number> {
  return UserMemory.countDocuments(activeMemoryFilter(userId));
}

/**
 * Ids of a user's oldest live memories.
 *
 * @param userId Owner
 * @param limit How many to take
 * @returns Memory ids, oldest first
 */
export async function findOldestMemoryIds(
  userId: string,
  limit: number,
): Promise<string[]> {
  const rows = await UserMemory.find(activeMemoryFilter(userId))
    .sort({ updatedAt: 1 })
    .limit(limit)
    .select("_id");
  return rows.map((row) => String(row._id));
}

/**
 * Ids of every live memory a user owns.
 *
 * @param userId Owner
 * @returns Memory ids
 */
export async function findAllActiveMemoryIds(
  userId: string,
): Promise<string[]> {
  const rows = await UserMemory.find(activeMemoryFilter(userId))
    .select("_id")
    .lean<{ _id: unknown }[]>();
  return rows.map((row) => String(row._id));
}

/**
 * Tombstones every not-yet-tombstoned memory matching `filter`: sets
 * `deletedAt` and drops the content fields in one atomic update per document.
 * The filter is re-applied in the update, so a document that stopped matching
 * in between is left alone.
 *
 * @param filter Which memories to retire (must not match tombstones)
 * @param limit Optional cap on how many to retire
 * @returns Vector addresses of the memories that were tombstoned
 */
async function tombstoneWhere(
  filter: Record<string, unknown>,
  limit?: number,
): Promise<MemoryVectorRef[]> {
  const scoped: Record<string, unknown> = { ...filter, deletedAt: null };
  let query = UserMemory.find(scoped).select("_id userId embeddingId");
  if (limit) query = query.limit(limit);
  const rows =
    await query.lean<
      { _id: unknown; userId: string; embeddingId?: string | null }[]
    >();
  if (!rows.length) return [];
  await UserMemory.updateMany(
    { ...scoped, _id: { $in: rows.map((row) => row._id) } } as Record<
      string,
      unknown
    >,
    { $set: { deletedAt: new Date() }, $unset: MEMORY_TOMBSTONE_UNSET },
  );
  // Only report the ones this call actually retired.
  const retired = await UserMemory.find({
    _id: { $in: rows.map((row) => row._id) },
    deletedAt: { $ne: null },
  } as Record<string, unknown>)
    .select("_id userId embeddingId")
    .lean<{ _id: unknown; userId: string; embeddingId?: string | null }[]>();
  return retired.map(toVectorRef);
}

/**
 * Tombstones the given memories owned by a user.
 *
 * @param memoryIds Memories to retire
 * @param userId Owner, as an ownership guard
 * @returns Vector addresses of the memories tombstoned
 */
export async function softDeleteMemories(
  memoryIds: string[],
  userId: string,
): Promise<MemoryVectorRef[]> {
  return tombstoneWhere({ _id: { $in: memoryIds }, userId });
}

/**
 * Tombstones one live memory owned by a user.
 *
 * @param userId Owner
 * @param memoryId Memory to retire
 * @returns Its vector address, or null when nothing was live to retire
 */
export async function softDeleteActiveMemory(
  userId: string,
  memoryId: string,
): Promise<MemoryVectorRef | null> {
  const [ref] = await tombstoneWhere({
    ...activeMemoryFilter(userId),
    _id: memoryId,
  });
  return ref ?? null;
}

/**
 * A user's live memories restricted to a set of ids.
 *
 * @param userId Owner
 * @param memoryIds Ids to fetch
 * @returns Still-encrypted memories
 */
export async function findActiveMemoriesByIds(
  userId: string,
  memoryIds: string[],
): Promise<IUserMemory[]> {
  return UserMemory.find({
    ...activeMemoryFilter(userId),
    _id: { $in: memoryIds },
  }).lean<IUserMemory[]>();
}

/**
 * Stamps `lastUsedAt` on the given memories.
 *
 * @param memoryIds Memories that were just used
 * @param userId Owner, as an ownership guard
 */
export async function markMemoriesUsed(
  memoryIds: unknown[],
  userId: string,
): Promise<void> {
  await UserMemory.updateMany(
    { _id: { $in: memoryIds }, ...activeMemoryFilter(userId) } as Record<
      string,
      unknown
    >,
    { $set: { lastUsedAt: new Date() } },
  );
}

/**
 * Memories due for retention: past `expiresAt`, or neither updated nor used
 * since the cutoff. Activity is the later of `lastUsedAt` and `updatedAt`
 * (which is never earlier than `createdAt`).
 *
 * @param cutoff Activity time limit
 * @param now Expiry reference time
 */
function dueMemoryFilter(cutoff: Date, now: Date): Record<string, unknown> {
  return {
    deletedAt: null,
    $or: [
      { expiresAt: { $lte: now } },
      {
        updatedAt: { $lte: cutoff },
        $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: cutoff } }],
      },
    ],
  };
}

/**
 * Counts memories due for retention, capped, for dry runs.
 *
 * @param cutoff Activity time limit
 * @param now Expiry reference time
 * @param limit Cap
 */
export async function countDueMemories(
  cutoff: Date,
  now: Date,
  limit: number,
): Promise<number> {
  return UserMemory.countDocuments(dueMemoryFilter(cutoff, now)).limit(limit);
}

/**
 * Tombstones one batch of memories due for retention. The due condition is
 * re-checked atomically, so a memory used or edited in between survives.
 *
 * @param cutoff Activity time limit
 * @param now Expiry reference time
 * @param limit Batch size
 * @returns Vector addresses of the memories tombstoned
 */
export async function tombstoneDueMemories(
  cutoff: Date,
  now: Date,
  limit: number,
): Promise<MemoryVectorRef[]> {
  return tombstoneWhere(dueMemoryFilter(cutoff, now), limit);
}

/** Tombstones still carrying any field a tombstone should have dropped. */
export function legacyTombstoneFilter(): Record<string, unknown> {
  return {
    deletedAt: { $ne: null },
    $or: Object.keys(MEMORY_TOMBSTONE_UNSET).map((field) => ({
      [field]: { $exists: true },
    })),
  };
}

/**
 * Drops content still left on tombstones written before tombstones were
 * content-free.
 *
 * @param limit Batch size
 * @returns How many tombstones were scrubbed
 */
export async function scrubLegacyTombstones(limit: number): Promise<number> {
  const filter = legacyTombstoneFilter();
  const rows = await UserMemory.find(filter)
    .select("_id")
    .limit(limit)
    .lean<{ _id: unknown }[]>();
  if (!rows.length) return 0;
  const result = await UserMemory.updateMany(
    {
      _id: { $in: rows.map((row) => row._id) },
      deletedAt: { $ne: null },
    } as Record<string, unknown>,
    { $unset: MEMORY_TOMBSTONE_UNSET },
  );
  return result.modifiedCount;
}

/**
 * One batch of tombstones older than the keep window.
 *
 * @param keepCutoff Tombstones retired at or before this are purgeable
 * @param limit Batch size
 */
export async function findPurgeableTombstones(
  keepCutoff: Date,
  limit: number,
): Promise<MemoryVectorRef[]> {
  const rows = await UserMemory.find({ deletedAt: { $lte: keepCutoff } })
    .select("_id userId embeddingId")
    .sort({ deletedAt: 1 })
    .limit(limit)
    .lean<{ _id: unknown; userId: string; embeddingId?: string | null }[]>();
  return rows.map(toVectorRef);
}

/**
 * Hard-deletes tombstones by id.
 *
 * @param memoryIds Tombstone ids (non-tombstones are never matched)
 * @returns How many were deleted
 */
export async function hardDeleteTombstones(
  memoryIds: string[],
): Promise<number> {
  if (!memoryIds.length) return 0;
  const result = await UserMemory.deleteMany({
    _id: { $in: memoryIds },
    deletedAt: { $ne: null },
  });
  return result.deletedCount ?? 0;
}

/**
 * Distinct owners that have tombstones, paged by userId, for the per-user
 * vector reconciliation.
 *
 * @param afterUserId Resume after this userId (exclusive)
 * @param limit Page size
 */
export async function findTombstoneOwners(
  afterUserId: string | null,
  limit: number,
): Promise<string[]> {
  const match: Record<string, unknown> = { deletedAt: { $ne: null } };
  if (afterUserId !== null) match.userId = { $gt: afterUserId };
  const rows = await UserMemory.aggregate<{ _id: string }>([
    { $match: match },
    { $group: { _id: "$userId" } },
    { $sort: { _id: 1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => row._id);
}

/**
 * Ids of deleted accounts, paged by userId. Their vectors are reconciled too,
 * covering anything an account deletion could not delete.
 *
 * @param afterUserId Resume after this userId (exclusive)
 * @param limit Page size
 */
export async function findDeletedAccountOwners(
  afterUserId: string | null,
  limit: number,
): Promise<string[]> {
  const filter: Record<string, unknown> =
    afterUserId === null ? {} : { userId: { $gt: afterUserId } };
  const rows = await DeletedAccount.find(filter)
    .select("userId")
    .sort({ userId: 1 })
    .limit(limit)
    .lean<{ userId: string }[]>();
  return rows.map((row) => row.userId);
}

/**
 * Of the given memory ids, the ones still live for the user.
 *
 * @param userId Owner
 * @param memoryIds Candidate ids (e.g. from cache)
 */
export async function findLiveMemoryIds(
  userId: string,
  memoryIds: string[],
): Promise<Set<string>> {
  if (!memoryIds.length) return new Set();
  const rows = await UserMemory.find({
    ...activeMemoryFilter(userId),
    _id: { $in: memoryIds },
  } as Record<string, unknown>)
    .select("_id")
    .lean<{ _id: unknown }[]>();
  return new Set(rows.map((row) => String(row._id)));
}

/**
 * Vector ids of a user's live memories.
 *
 * @param userId Owner
 */
export async function findLiveVectorIds(userId: string): Promise<Set<string>> {
  const rows = await UserMemory.find(activeMemoryFilter(userId))
    .select("_id embeddingId")
    .lean<{ _id: unknown; embeddingId?: string | null }[]>();
  return new Set(rows.map((row) => row.embeddingId ?? String(row._id)));
}

/**
 * Whether a memory is live, for post-index compensation.
 *
 * @param memoryId Memory id
 */
export async function isMemoryLive(memoryId: string): Promise<boolean> {
  const row = await UserMemory.exists({ _id: memoryId, ...liveMemoryFilter() });
  return Boolean(row);
}
