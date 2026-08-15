import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import {
  countActiveMemories,
  findActiveMemories,
  findActiveMemoriesByIds,
  findActiveMemoryById,
  findAllActiveMemoryIds,
  findMemoryByRetrievalText,
  findMemoryEnabled,
  findOldestMemoryIds,
  insertMemory,
  markMemoriesUsed,
  setMemoryEnabled,
  softDeleteActiveMemory,
  softDeleteMemories,
  updateMemoryById,
  updateOwnedMemory,
  type IUserMemory,
} from "./memory.repository";
import { redisGet, redisSet, redisDel } from "../../config/redis";
import { embedText } from "../../adapters/embedding.adapter";
import {
  deleteDocuments,
  getOrCreateCollection,
  queryDocuments,
  upsertDocuments,
} from "../../adapters/chroma.adapter";

const CACHE_PREFIX = "user-mem:";
const CACHE_TTL_SEC = 300;
const MAX_MEMORIES_PER_USER = 50;
const MEMORY_COLLECTION = "user_memories";
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
  return CACHE_PREFIX + userId;
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
  return content.replace(/\b2[1-6]\.\d{3,}\s*,\s*12[0-2]\.\d{3,}\b/g, "座標已隱藏");
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

function buildRetrievalText(
  content: string,
  category: MemoryCategory,
): string {
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
  const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
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

async function getMemoryCollection() {
  return getOrCreateCollection(MEMORY_COLLECTION);
}

async function indexMemory(memory: IUserMemory): Promise<void> {
  try {
    const embedding = await embedText(memory.retrievalText);
    const collection = await getMemoryCollection();
    await upsertDocuments(collection, [
      {
        id: memory.embeddingId ?? String(memory._id),
        content: memory.retrievalText,
        embedding,
        metadata: {
          userId: memory.userId,
          memoryId: String(memory._id),
          category: memory.category,
          sensitivity: memory.sensitivity,
          deleted: false,
        },
      },
    ]);
  } catch (error) {
    console.warn("[memory] vector index unavailable:", error);
  }
}

async function deleteMemoryIndex(memoryIds: string[]): Promise<void> {
  try {
    const collection = await getMemoryCollection();
    await deleteDocuments(collection, memoryIds);
  } catch (error) {
    console.warn("[memory] vector delete unavailable:", error);
  }
}

async function assertMemoryEnabled(userId: string): Promise<void> {
  if (!(await findMemoryEnabled(userId))) {
    throw new Error("MEMORY_DISABLED");
  }
}

export async function getMemorySettings(userId: string): Promise<MemorySettings> {
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
  if (cached) {
    const parsed = JSON.parse(cached) as IUserMemory[];
    return parsed.slice(0, limit).map(decryptMemory);
  }

  const memories = await findActiveMemories(userId, limit);

  if (memories.length) {
    await redisSet(cacheKey(userId), JSON.stringify(memories), CACHE_TTL_SEC);
  }
  return memories.map(decryptMemory);
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

  if (existing) {
    const updated = await updateMemoryById(String(existing._id), {
      content: encryptMemoryContent(normalizedContent),
      promptText,
      retrievalText,
      sensitivity,
      source,
      embeddingId: String(existing._id),
      embeddingModel: EMBEDDING_MODEL,
      expiresAt: options.expiresAt,
      updatedAt: new Date(),
    });
    await invalidateCache(userId);
    const memory = decryptMemory(updated as IUserMemory);
    await indexMemory(memory);
    return memory;
  }

  const memoryId = await insertMemory({
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

  const memoryWithEmbeddingId = await updateMemoryById(memoryId, {
    embeddingId: memoryId,
  });

  const count = await countActiveMemories(userId);
  if (count > MAX_MEMORIES_PER_USER) {
    const oldestIds = await findOldestMemoryIds(
      userId,
      count - MAX_MEMORIES_PER_USER,
    );
    await softDeleteMemories(oldestIds, userId);
    await deleteMemoryIndex(oldestIds);
  }

  await invalidateCache(userId);
  const memory = decryptMemory(memoryWithEmbeddingId as IUserMemory);
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
  const sensitivity =
    input.sensitivity ?? inferSensitivity(content, category);
  const promptText = buildPromptText(content, sensitivity);
  const retrievalText = buildRetrievalText(content, category);
  const expiresAtUpdate =
    input.expiresAt === undefined ? existing.expiresAt : input.expiresAt ?? undefined;

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
  if (await softDeleteActiveMemory(userId, memoryId)) {
    await invalidateCache(userId);
    await deleteMemoryIndex([memoryId]);
    return true;
  }
  return false;
}

export async function clearMemories(userId: string): Promise<number> {
  const ids = await findAllActiveMemoryIds(userId);
  if (!ids.length) return 0;

  const modifiedCount = await softDeleteMemories(ids, userId);
  await invalidateCache(userId);
  await deleteMemoryIndex(ids);
  return modifiedCount;
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

    const byId = new Map(memories.map((memory) => [String(memory._id), memory]));
    const ranked: IUserMemory[] = [];
    for (const id of ids) {
      const memory = byId.get(id);
      if (memory) ranked.push(memory);
      if (ranked.length >= limit) break;
    }

    if (ranked.length) {
      await markMemoriesUsed(
        ranked.map((memory) => memory._id),
        userId,
      );
    }

    return ranked.map(decryptMemory);
  } catch (error) {
    console.warn("[memory] vector search unavailable:", error);
    return loadMemories(userId, limit);
  }
}
