import UserMemory, { type IUserMemory } from "../../model/user-memory.model";
import User from "../../model/user.model";

export type { IUserMemory };

/**
 * Matches a user's memories that have not been soft-deleted. Both the
 * "field absent" and the "explicitly null" shapes count as live, because older
 * documents were written before `deletedAt` existed.
 */
function activeMemoryFilter(userId: string): Record<string, unknown> {
	return {
		userId,
		$or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
	};
}

/**
 * Reads a user's memory opt-in flag.
 *
 * @param userId Owner
 * @returns Whether memory capture is enabled
 */
export async function findMemoryEnabled(userId: string): Promise<boolean> {
	const user = await User.findById(userId)
		.select("settings.memoryEnabled")
		.lean();
	return Boolean(user?.settings?.memoryEnabled);
}

/**
 * Sets a user's memory opt-in flag.
 *
 * @param userId Owner
 * @param memoryEnabled Desired flag value
 * @returns The flag after the update
 */
export async function setMemoryEnabled(
	userId: string,
	memoryEnabled: boolean,
): Promise<boolean> {
	const user = await User.findByIdAndUpdate(
		userId,
		{ $set: { "settings.memoryEnabled": memoryEnabled } },
		{ returnDocument: "after" },
	)
		.select("settings.memoryEnabled")
		.lean();
	return Boolean(user?.settings?.memoryEnabled);
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
	return UserMemory.findByIdAndUpdate(
		memoryId,
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
		{ _id: memoryId, userId },
		{ $set: fields },
		{ returnDocument: "after" },
	).lean<IUserMemory | null>();
}

/**
 * Inserts a memory.
 *
 * @param doc The memory to store
 * @returns The stored memory's id
 */
export async function insertMemory(
	doc: Record<string, unknown>,
): Promise<string> {
	const created = await UserMemory.create(doc);
	return String(created._id);
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
 * Soft-deletes the given memories.
 *
 * @param memoryIds Memories to retire
 * @param userId Owner, as an ownership guard
 * @returns How many documents changed
 */
export async function softDeleteMemories(
	memoryIds: string[],
	userId: string,
): Promise<number> {
	const result = await UserMemory.updateMany(
		{ _id: { $in: memoryIds }, userId },
		{ $set: { deletedAt: new Date() } },
	);
	return result.modifiedCount;
}

/**
 * Soft-deletes one live memory owned by a user.
 *
 * @param userId Owner
 * @param memoryId Memory to retire
 * @returns True when a document changed
 */
export async function softDeleteActiveMemory(
	userId: string,
	memoryId: string,
): Promise<boolean> {
	const result = await UserMemory.updateOne(
		{ ...activeMemoryFilter(userId), _id: memoryId },
		{ $set: { deletedAt: new Date() } },
	);
	return result.modifiedCount > 0;
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
		{ _id: { $in: memoryIds }, userId } as Record<string, unknown>,
		{ $set: { lastUsedAt: new Date() } },
	);
}
