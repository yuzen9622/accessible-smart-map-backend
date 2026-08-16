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
  };
  return { default: mockModel };
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
  deleteDocuments: vi.fn().mockResolvedValue(undefined),
  queryDocuments: vi.fn(),
}));

import UserMemory from "../../model/user-memory.model";
import { redisGet, redisSet, redisDel } from "../../config/redis";
import { queryDocuments } from "../../adapters/chroma.adapter";
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
const mockUpdateOne = UserMemory.updateOne as unknown as ReturnType<
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
});

describe("loadMemories", () => {
  it("Redis 有快取時直接回傳", async () => {
    const cached = [{ _id: "m1", content: "坐輪椅", category: "preference" }];
    mockRedisGet.mockResolvedValue(JSON.stringify(cached));

    const result = await loadMemories("user1");
    expect(result).toEqual(cached);
    expect(mockFind).not.toHaveBeenCalled();
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
    mockFindByIdAndUpdate.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "m1",
          userId: "u1",
          content: "家住板橋",
          promptText: "家住板橋",
          retrievalText: "place: 家住板橋",
          category: "place",
          sensitivity: "medium",
          source: "explicit_user",
        }),
    });
    mockCount.mockResolvedValue(1);

    const result = await saveMemory("u1", "家住板橋", "place");
    expect(result.content).toBe("家住板橋");
    expect(mockRedisDel).toHaveBeenCalledWith("user-mem:u1");
  });

  it("已存在相同內容 — 更新 updatedAt", async () => {
    mockFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });
    mockFindByIdAndUpdate.mockReturnValue({
      lean: () =>
        Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });

    await saveMemory("u1", "家住板橋", "place");
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({
        $set: expect.objectContaining({ content: "家住板橋" }),
      }),
      { returnDocument: "after" },
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("超過 50 筆時刪除最舊的", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      _id: "m51",
      toObject: () => ({ _id: "m51", content: "new", category: "context" }),
    });
    mockFindByIdAndUpdate.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "m51",
          userId: "u1",
          content: "new",
          promptText: "new",
          retrievalText: "context: new",
          category: "context",
          sensitivity: "low",
          source: "explicit_user",
        }),
    });
    mockCount.mockResolvedValue(51);
    mockFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => Promise.resolve([{ _id: "oldest" }]),
        }),
      }),
    });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    await saveMemory("u1", "new", "context");
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ["oldest"] }, userId: "u1" },
      { $set: { deletedAt: expect.any(Date) } },
    );
  });
});

describe("deleteMemory", () => {
  it("成功刪除 — 回 true + 清快取", async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    const result = await deleteMemory("u1", "m1");
    expect(result).toBe(true);
    expect(mockRedisDel).toHaveBeenCalledWith("user-mem:u1");
  });

  it("找不到 — 回 false，不清快取", async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    const result = await deleteMemory("u1", "nonexistent");
    expect(result).toBe(false);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});
