import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../model/user-memory.model", () => {
  const mockModel: any = {
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
    countDocuments: vi.fn(),
    deleteMany: vi.fn(),
    deleteOne: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
    exists: vi.fn(),
  };
  return {
    default: mockModel,
    MEMORY_TOMBSTONE_UNSET: {
      content: "",
      promptText: "",
      retrievalText: "",
      category: "",
      sensitivity: "",
      source: "",
      embeddingModel: "",
      lastUsedAt: "",
      expiresAt: "",
    },
  };
});
vi.mock("../../model/config.model", () => ({
  default: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));
vi.mock("../../adapters/embedding.adapter", () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));
vi.mock("../../adapters/chroma.adapter", () => ({
  getOrCreateCollection: vi.fn().mockResolvedValue({}),
  upsertDocuments: vi.fn().mockResolvedValue(undefined),
  upsertDocumentsWithin: vi.fn().mockResolvedValue(undefined),
  deleteDocuments: vi.fn().mockResolvedValue(undefined),
  queryDocuments: vi.fn(),
}));

import UserMemory from "../../model/user-memory.model";
import { redisGet, redisSet, redisDel } from "../../config/redis";
import {
  deleteDocuments,
  queryDocuments,
  upsertDocumentsWithin,
} from "../../adapters/chroma.adapter";
import {
  loadMemories,
  saveMemory,
  deleteMemory,
  searchMemoriesForPrompt,
} from "./memory.service";

const mockFind = UserMemory.find as unknown as ReturnType<typeof vi.fn>;
const mockFindOne = UserMemory.findOne as unknown as ReturnType<typeof vi.fn>;
const mockCreate = UserMemory.create as unknown as ReturnType<typeof vi.fn>;
const mockCount = UserMemory.countDocuments as unknown as ReturnType<
  typeof vi.fn
>;
const mockFindByIdAndUpdate =
  UserMemory.findByIdAndUpdate as unknown as ReturnType<typeof vi.fn>;
const mockUpdateMany = UserMemory.updateMany as unknown as ReturnType<
  typeof vi.fn
>;
const mockFindOneAndUpdate =
  UserMemory.findOneAndUpdate as unknown as ReturnType<typeof vi.fn>;
const mockExists = UserMemory.exists as unknown as ReturnType<typeof vi.fn>;
const mockDeleteDocuments = deleteDocuments as unknown as ReturnType<
  typeof vi.fn
>;
const mockRedisGet = redisGet as unknown as ReturnType<typeof vi.fn>;
const mockRedisSet = redisSet as unknown as ReturnType<typeof vi.fn>;
const mockRedisDel = redisDel as unknown as ReturnType<typeof vi.fn>;
const mockQueryDocuments = queryDocuments as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockResolvedValue({ _id: "live" });
});

/** `find().select().lean()` chain, as the tombstone queries use it. */
function selectLean(rows: unknown[]) {
  return { select: () => ({ lean: () => Promise.resolve(rows) }) };
}

const TOMBSTONE_UPDATE = {
  $set: { deletedAt: expect.any(Date) },
  $unset: {
    content: "",
    promptText: "",
    retrievalText: "",
    category: "",
    sensitivity: "",
    source: "",
    embeddingModel: "",
    lastUsedAt: "",
    expiresAt: "",
  },
};
const mockUpsertWithin = upsertDocumentsWithin as unknown as ReturnType<
  typeof vi.fn
>;

describe("loadMemories", () => {
  it("Redis 有快取時直接回傳", async () => {
    const cached = [{ _id: "m1", content: "坐輪椅", category: "preference" }];
    mockRedisGet.mockResolvedValue(JSON.stringify(cached));
    mockFind.mockReturnValueOnce(selectLean([{ _id: "m1" }]));

    const result = await loadMemories("user1");
    expect(result).toEqual(cached);
  });

  it("drops cached memories Mongo no longer holds live", async () => {
    // m2 expired or was deleted after caching (e.g. the cache DEL failed).
    const cached = [
      { _id: "m1", content: "坐輪椅", category: "preference" },
      { _id: "m2", content: "暫時拄拐", category: "context" },
    ];
    mockRedisGet.mockResolvedValue(JSON.stringify(cached));
    mockFind.mockReturnValueOnce(selectLean([{ _id: "m1" }]));

    const result = await loadMemories("user1");
    expect(result.map((m) => m._id)).toEqual(["m1"]);
  });

  it("stamps lastUsedAt on memories it returns for a prompt", async () => {
    const cached = [{ _id: "m1", content: "坐輪椅", category: "preference" }];
    mockRedisGet.mockResolvedValue(JSON.stringify(cached));
    mockFind.mockReturnValueOnce(selectLean([{ _id: "m1" }]));

    await loadMemories("user1");
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ["m1"] }, userId: "user1" }),
      { $set: { lastUsedAt: expect.any(Date) } },
    );
  });

  it("Redis miss 時查 MongoDB 並寫入快取", async () => {
    mockRedisGet.mockResolvedValue(null);
    const docs = [
      { _id: "m1", content: "坐輪椅", category: "preference", userId: "u1" },
    ];
    mockFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve(docs) }) }),
    });

    const result = await loadMemories("u1");
    expect(result).toEqual(docs);
    expect(mockRedisSet).toHaveBeenCalledWith(
      "user-mem:u1",
      JSON.stringify(docs),
      300,
    );
  });

  it("MongoDB 也為空時不寫快取", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    });

    const result = await loadMemories("u1");
    expect(result).toEqual([]);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("searchMemoriesForPrompt", () => {
  it("vector 無命中時 fallback 到最近記憶", async () => {
    mockQueryDocuments.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(null);
    const docs = [
      {
        _id: "school",
        content: "使用者的學校是台大",
        promptText: "使用者的學校是台大",
        retrievalText: "place: 使用者的學校是台大",
        category: "place",
        sensitivity: "medium",
        source: "explicit_user",
        userId: "u1",
      },
    ];
    mockFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve(docs) }) }),
    });

    const result = await searchMemoriesForPrompt("u1", "我要去學校");

    expect(result).toEqual(docs);
  });
});

describe("saveMemory", () => {
  it("新記憶 — 寫入 + 清快取", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const created = {
      _id: "m1",
      userId: "u1",
      content: "家住板橋",
      category: "place",
      toObject: () => ({
        _id: "m1",
        userId: "u1",
        content: "家住板橋",
        category: "place",
      }),
    };
    mockCreate.mockResolvedValue(created);
    mockCount.mockResolvedValue(1);

    const result = await saveMemory("u1", "家住板橋", "place");
    expect(result.content).toBe("家住板橋");
    expect(mockRedisDel).toHaveBeenCalledWith("user-mem:u1");
    const inserted = mockCreate.mock.calls[0][0];
    expect(inserted.embeddingId).toBe(inserted._id);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("skips the vector write when the memory died while embedding", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      toObject: () => ({
        _id: "m1",
        userId: "u1",
        content: "x",
        category: "place",
      }),
    });
    mockCount.mockResolvedValue(1);
    mockExists.mockResolvedValue(null);

    await saveMemory("u1", "家住板橋", "place");
    expect(mockUpsertWithin).not.toHaveBeenCalled();
  });

  it("writes the vector with an abort deadline", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      toObject: () => ({
        _id: "m1",
        userId: "u1",
        content: "x",
        category: "place",
      }),
    });
    mockCount.mockResolvedValue(1);

    await saveMemory("u1", "家住板橋", "place");
    expect(mockUpsertWithin).toHaveBeenCalledWith(
      "user_memories",
      [
        expect.objectContaining({
          metadata: expect.objectContaining({ indexedAt: expect.any(Number) }),
        }),
      ],
      30_000,
    );
  });

  it("deletes the vector it just wrote when the memory died meanwhile", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      toObject: () => ({
        _id: "m1",
        userId: "u1",
        content: "x",
        category: "place",
      }),
    });
    mockCount.mockResolvedValue(1);
    // Live when checked before the write, gone right after it.
    mockExists.mockResolvedValueOnce({ _id: "m1" }).mockResolvedValueOnce(null);

    await saveMemory("u1", "家住板橋", "place");
    expect(mockDeleteDocuments).toHaveBeenCalledWith(expect.anything(), [
      expect.any(String),
    ]);
  });

  it("已存在相同內容 — 更新 updatedAt", async () => {
    mockFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });
    mockFindOneAndUpdate.mockReturnValue({
      lean: () =>
        Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });

    await saveMemory("u1", "家住板橋", "place");
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "m1", deletedAt: null }),
      expect.objectContaining({
        $set: expect.objectContaining({ content: "家住板橋" }),
      }),
      { returnDocument: "after" },
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("stores a fresh memory when the duplicate was deleted after it was read", async () => {
    mockFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });
    mockFindOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      toObject: () => ({
        _id: "m2",
        userId: "u1",
        content: "家住板橋",
        category: "place",
      }),
    });
    mockCount.mockResolvedValue(1);

    await saveMemory("u1", "家住板橋", "place");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("超過 50 筆時刪除最舊的", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      toObject: () => ({
        _id: "m51",
        userId: "u1",
        content: "new",
        category: "context",
      }),
    });
    mockCount.mockResolvedValue(51);
    const oldest = { _id: "oldest", userId: "u1", embeddingId: "oldest" };
    mockFind
      .mockReturnValueOnce({
        sort: () => ({
          limit: () => ({
            select: () => Promise.resolve([{ _id: "oldest" }]),
          }),
        }),
      })
      .mockReturnValueOnce(selectLean([oldest]))
      .mockReturnValueOnce(selectLean([oldest]));
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    await saveMemory("u1", "new", "context");
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: ["oldest"] },
        userId: "u1",
        deletedAt: null,
      }),
      TOMBSTONE_UPDATE,
    );
    expect(mockDeleteDocuments).toHaveBeenCalledWith(expect.anything(), [
      "oldest",
    ]);
  });
});

describe("deleteMemory", () => {
  it("成功刪除 — 回 true + 清快取", async () => {
    const row = { _id: "m1", userId: "u1", embeddingId: "vec-m1" };
    mockFind
      .mockReturnValueOnce(selectLean([row]))
      .mockReturnValueOnce(selectLean([row]));
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    const result = await deleteMemory("u1", "m1");
    expect(result).toBe(true);
    expect(mockRedisDel).toHaveBeenCalledWith("user-mem:u1");
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ["m1"] }, deletedAt: null }),
      TOMBSTONE_UPDATE,
    );
    // The vector is addressed by embeddingId, not the document id.
    expect(mockDeleteDocuments).toHaveBeenCalledWith(expect.anything(), [
      "vec-m1",
    ]);
  });

  it("找不到 — 回 false，不清快取", async () => {
    mockFind.mockReturnValueOnce(selectLean([]));
    const result = await deleteMemory("u1", "nonexistent");
    expect(result).toBe(false);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});
