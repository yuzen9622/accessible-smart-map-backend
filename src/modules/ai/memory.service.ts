import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { Types } from "mongoose";
import {
  countActiveMemories,
  findActiveMemories,
  findActiveMemoriesByIds,
  findActiveMemoryById,
  findAllActiveMemoryIds,
  findLiveMemoryIds,
  findMemoryByRetrievalText,
  findMemoryEnabled,
  findOldestMemoryIds,
  insertMemory,
  isMemoryLive,
  markMemoriesUsed,
  setMemoryEnabled,
  softDeleteActiveMemory,
  softDeleteMemories,
  updateMemoryById,
  updateOwnedMemory,
  type IUserMemory,
  type MemoryVectorRef,
} from "./memory.repository";
import { getRetentionConfig } from "../../config/retention";
import { redisGet, redisSet, redisDel } from "../../config/redis";
import { embedText } from "../../adapters/embedding.adapter";
import {
  deleteDocuments,
  getOrCreateCollection,
  queryDocuments,
  upsertDocumentsWithin,
} from "../../adapters/chroma.adapter";
import { MEMORY_CACHE_PREFIX, MEMORY_COLLECTION } from "../../constants/memory";

const CACHE_TTL_SEC = 300;
const MAX_MEMORIES_PER_USER = 50;
const EMBEDDING_MODEL = "text-embedding-004";
const VECTOR_DISTANCE_THRESHOLD = 0.72;
const ENCRYPTED_PREFIX = "enc:v1:";

export type MemoryCategory = IUserMemory["category"];
export type MemorySensitivity = IUserMemory["sensitivity"];
export type MemorySource = IUserMemory["source"];

export interface SaveMemoryOptions {
  source?: MemorySource;
  sensitivity?: MemorySensitivity;
  requireMemoryEnabled?: boolean;
  expiresAt?: Date;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  sensitivity?: MemorySensitivity;
  expiresAt?: Date | null;
}

export interface MemorySettings {
  memoryEnabled: boolean;
}

function cacheKey(userId: string): string {
  return MEMORY_CACHE_PREFIX + userId;
}

async function invalidateCache(userId: string): Promise<void> {
  await redisDel(cacheKey(userId));
}

function trimMemoryText(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}

function hasPreciseCoordinates(content: string): boolean {
  return /\b2[1-6]\.\d{3,}\s*,\s*12[0-2]\.\d{3,}\b/.test(content);
}

function redactPreciseCoordinates(content: string): string {
  return content.replace(
    /\b2[1-6]\.\d{3,}\s*,\s*12[0-2]\.\d{3,}\b/g,
    "座標已隱藏",
  );
}

function inferSensitivity(
  content: string,
  category: MemoryCategory,
): MemorySensitivity {
  if (hasPreciseCoordinates(content)) return "high";
  if (category === "place") return "medium";
  if (/(住家|住址|家裡|公司|工作地點|學校|醫院|診所)/.test(content)) {
    return "medium";
  }
  return "low";
}

function buildPromptText(
  content: string,
  sensitivity: MemorySensitivity,
): string {
  const trimmed = trimMemoryText(content);
  if (sensitivity === "high") {
    return redactPreciseCoordinates(trimmed);
  }
  return trimmed;
}

function buildRetrievalText(content: string, category: MemoryCategory): string {
  return `${category}: ${redactPreciseCoordinates(trimMemoryText(content))}`;
}

function memoryEncryptionKey(): Buffer | null {
  const secret = process.env.MEMORY_ENCRYPTION_KEY;
  if (!secret) return null;
  return createHash("sha256").update(secret).digest();
}

function encryptMemoryContent(content: string): string {
  const key = memoryEncryptionKey();
  if (!key || content.startsWith(ENCRYPTED_PREFIX)) return content;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(content, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptMemoryContent(content: string): string {
  if (!content.startsWith(ENCRYPTED_PREFIX)) return content;
  const key = memoryEncryptionKey();
  if (!key) return "[已加密的記憶：缺少解密金鑰]";
  try {
    const [ivRaw, tagRaw, ciphertextRaw] = content
      .slice(ENCRYPTED_PREFIX.length)
      .split(":");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivRaw, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    console.warn("[memory] decrypt failed:", error);
    return "[無法解密的記憶]";
  }
}

function decryptMemory(memory: IUserMemory): IUserMemory {
  return { ...memory, content: decryptMemoryContent(memory.content) };
}

export async function getMemoryCollection() {
  return getOrCreateCollection(MEMORY_COLLECTION);
}

/**
 * Embeds and upserts a memory's vector. Embedding may take long (rate-limit
 * backoff), so liveness is re-checked right before the write, and the write
 * itself is aborted after MEMORY_INDEX_TIMEOUT_MS so it cannot land later
 * than that. If the memory was deleted meanwhile, the vector just written is
 * removed again; should that fail, the retention job's per-user vector
 * reconciliation removes it (`indexedAt` tells it the grace window passed).
 */
async function indexMemory(memory: IUserMemory): Promise<void> {
  const memoryId = String(memory._id);
  const vectorId = memory.embeddingId ?? memoryId;
  try {
    const embedding = await embedText(memory.retrievalText);
    if (!(await isMemoryLive(memoryId))) return;
    await upsertDocumentsWithin(
      MEMORY_COLLECTION,
      [
        {
          id: vectorId,
          content: memory.retrievalText,
          embedding,
          metadata: {
            userId: memory.userId,
            memoryId,
            category: memory.category,
            sensitivity: memory.sensitivity,
            deleted: false,
            indexedAt: Date.now(),
          },
        },
      ],
      getRetentionConfig().memoryIndexTimeoutMs,
    );
  } catch (error) {
    console.warn("[memory] vector index unavailable:", error);
  }
  if (!(await isMemoryLive(memoryId))) {
    await deleteMemoryIndex([vectorId]);
  }
}

/**
 * Deletes vectors by id. Failures are logged and left to the retention job,
 * which keeps the tombstones that address them.
 *
 * @param vectorIds Vector ids (`embeddingId ?? _id`)
 * @returns True when Chroma confirmed the delete
 */
export async function deleteMemoryIndex(vectorIds: string[]): Promise<boolean> {
  if (!vectorIds.length) return true;
  try {
    const collection = await getMemoryCollection();
    await deleteDocuments(collection, vectorIds);
    return true;
  } catch (error) {
    console.warn("[memory] vector delete unavailable:", error);
    return false;
  }
}

/**
 * Drops cached prompts and vectors of memories just tombstoned.
 *
 * @param refs Tombstoned memories' vector addresses
 * @returns True when every vector delete was confirmed
 */
export async function retireVectors(refs: MemoryVectorRef[]): Promise<boolean> {
  const userIds = new Set(refs.map((ref) => ref.userId));
  for (const userId of userIds) await invalidateCache(userId);
  return deleteMemoryIndex(refs.map((ref) => ref.vectorId));
}

async function assertMemoryEnabled(userId: string): Promise<void> {
  if (!(await findMemoryEnabled(userId))) {
    throw new Error("MEMORY_DISABLED");
  }
}

export async function getMemorySettings(
  userId: string,
): Promise<MemorySettings> {
  return { memoryEnabled: await findMemoryEnabled(userId) };
}

export async function updateMemorySettings(
  userId: string,
  settings: MemorySettings,
): Promise<MemorySettings> {
  return {
    memoryEnabled: await setMemoryEnabled(userId, settings.memoryEnabled),
  };
}

/**
 * @param userId The authenticated user's ID.
 * @param limit Maximum number of memories to return (default 20).
 * @returns Active memories ordered by updatedAt desc, served from Redis when warm.
 */
export async function loadMemories(
  userId: string,
  limit = 20,
): Promise<IUserMemory[]> {
  const cached = await redisGet(cacheKey(userId));
  let memories: IUserMemory[];
  if (cached) {
    // A cached row may have expired or been deleted since it was cached (a
    // failed cache invalidation must not resurrect a deleted memory), so
    // only rows Mongo still holds as live are used.
    const rows = (JSON.parse(cached) as IUserMemory[]).slice(0, limit);
    const live = await findLiveMemoryIds(
      userId,
      rows.map((m) => String(m._id)),
    );
    memories = rows.filter((m) => live.has(String(m._id)));
  } else {
    memories = await findActiveMemories(userId, limit);
    if (memories.length) {
      await redisSet(cacheKey(userId), JSON.stringify(memories), CACHE_TTL_SEC);
    }
  }
  await markUsed(userId, memories);
  return memories.map(decryptMemory);
}

/**
 * Stamps `lastUsedAt` on memories about to enter a prompt, so the 12-month
 * unused-memory retention measures real use. Best-effort.
 */
async function markUsed(
  userId: string,
  memories: IUserMemory[],
): Promise<void> {
  if (!memories.length) return;
  try {
    await markMemoriesUsed(
      memories.map((memory) => memory._id),
      userId,
    );
  } catch (error) {
    console.warn("[memory] mark used failed:", error);
  }
}

export async function listMemories(
  userId: string,
  limit = 100,
): Promise<IUserMemory[]> {
  const memories = await findActiveMemories(userId, limit);
  return memories.map(decryptMemory);
}

/**
 * @param userId The authenticated user's ID.
 * @param content Natural-language memory content.
 * @param category The memory category.
 * @param options Storage policy options.
 * @returns The saved or updated memory document.
 */
export async function saveMemory(
  userId: string,
  content: string,
  category: MemoryCategory,
  options: SaveMemoryOptions = {},
): Promise<IUserMemory> {
  if (options.requireMemoryEnabled) {
    await assertMemoryEnabled(userId);
  }

  const normalizedContent = trimMemoryText(content);
  const sensitivity =
    options.sensitivity ?? inferSensitivity(normalizedContent, category);
  const promptText = buildPromptText(normalizedContent, sensitivity);
  const retrievalText = buildRetrievalText(normalizedContent, category);
  const source = options.source ?? "explicit_user";

  const existing = await findMemoryByRetrievalText(
    userId,
    category,
    retrievalText,
  );

  // A duplicate that was deleted or expired since it was read no longer
  // matches the guarded update; fall through and store a fresh memory.
  const updated = existing
    ? await updateMemoryById(String(existing._id), {
        content: encryptMemoryContent(normalizedContent),
        promptText,
        retrievalText,
        sensitivity,
        source,
        embeddingId: String(existing._id),
        embeddingModel: EMBEDDING_MODEL,
        expiresAt: options.expiresAt,
        updatedAt: new Date(),
      })
    : null;
  if (updated) {
    await invalidateCache(userId);
    const memory = decryptMemory(updated);
    await indexMemory(memory);
    return memory;
  }

  // The vector id is the document id, assigned up front so the stored memory
  // never exists without one.
  const memoryId = new Types.ObjectId().toString();
  const inserted = await insertMemory({
    _id: memoryId,
    embeddingId: memoryId,
    userId,
    content: encryptMemoryContent(normalizedContent),
    promptText,
    retrievalText,
    category,
    sensitivity,
    source,
    embeddingModel: EMBEDDING_MODEL,
    expiresAt: options.expiresAt,
  });

  const count = await countActiveMemories(userId);
  if (count > MAX_MEMORIES_PER_USER) {
    const oldestIds = await findOldestMemoryIds(
      userId,
      count - MAX_MEMORIES_PER_USER,
    );
    await retireVectors(await softDeleteMemories(oldestIds, userId));
  }

  await invalidateCache(userId);
  const memory = decryptMemory(inserted);
  await indexMemory(memory);
  return memory;
}

export async function updateMemory(
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): Promise<IUserMemory | null> {
  const existing = await findActiveMemoryById(userId, memoryId);
  if (!existing) return null;

  const existingContent = decryptMemoryContent(existing.content);
  const content = input.content
    ? trimMemoryText(input.content)
    : existingContent;
  const category = input.category ?? existing.category;
  const sensitivity = input.sensitivity ?? inferSensitivity(content, category);
  const promptText = buildPromptText(content, sensitivity);
  const retrievalText = buildRetrievalText(content, category);
  const expiresAtUpdate =
    input.expiresAt === undefined
      ? existing.expiresAt
      : (input.expiresAt ?? undefined);

  const updated = await updateOwnedMemory(memoryId, userId, {
    content: encryptMemoryContent(content),
    promptText,
    retrievalText,
    category,
    sensitivity,
    expiresAt: expiresAtUpdate,
    embeddingId: String(existing._id),
    embeddingModel: EMBEDDING_MODEL,
    updatedAt: new Date(),
  });

  if (!updated) return null;
  const memory = decryptMemory(updated as IUserMemory);
  await invalidateCache(userId);
  await indexMemory(memory);
  return memory;
}

/**
 * @param userId The authenticated user's ID.
 * @param memoryId The memory document's _id to delete.
 * @returns True if deleted, false if not found or not owned.
 */
export async function deleteMemory(
  userId: string,
  memoryId: string,
): Promise<boolean> {
  const ref = await softDeleteActiveMemory(userId, memoryId);
  if (!ref) return false;
  await retireVectors([ref]);
  return true;
}

export async function clearMemories(userId: string): Promise<number> {
  const ids = await findAllActiveMemoryIds(userId);
  if (!ids.length) return 0;

  const refs = await softDeleteMemories(ids, userId);
  await retireVectors(refs);
  return refs.length;
}

export async function searchMemoriesForPrompt(
  userId: string,
  query: string,
  limit = 5,
): Promise<IUserMemory[]> {
  const cleanQuery = trimMemoryText(query);
  if (!cleanQuery) return loadMemories(userId, limit);

  try {
    const embedding = await embedText(cleanQuery);
    const collection = await getMemoryCollection();
    const results = await queryDocuments(collection, embedding, limit * 2, {
      userId,
      deleted: false,
    });
    const ids = results
      .filter((result) => result.distance <= VECTOR_DISTANCE_THRESHOLD)
      .map((result) => result.metadata.memoryId)
      .filter((id): id is string => typeof id === "string");

    if (!ids.length) return loadMemories(userId, limit);

    const memories = await findActiveMemoriesByIds(userId, ids);

    const byId = new Map(
      memories.map((memory) => [String(memory._id), memory]),
    );
    const ranked: IUserMemory[] = [];
    for (const id of ids) {
      const memory = byId.get(id);
      if (memory) ranked.push(memory);
      if (ranked.length >= limit) break;
    }

    await markUsed(userId, ranked);

    return ranked.map(decryptMemory);
  } catch (error) {
    console.warn("[memory] vector search unavailable:", error);
    return loadMemories(userId, limit);
  }
}
