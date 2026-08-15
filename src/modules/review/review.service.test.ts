import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/review.model", () => ({
  default: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  },
}));

vi.mock("../../config/ai", () => ({
  googleGenAi: { models: { generateContent: vi.fn() } },
  model: "test-model",
}));

vi.mock("../../config/ai/config", () => ({ reviewSummaryConfig: {} }));
vi.mock("../../config/ai/contents", () => ({ reviewSummaryContents: [] }));

import Review from "../../model/review.model";
import { createReview, findByPlace, updateReview } from "./review.service";

const reviewModel = Review as unknown as {
  findOne: ReturnType<typeof vi.fn>;
  findOneAndUpdate: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  countDocuments: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
};

/** A `.lean()`-terminated query chain resolving to `value`. */
function leanChain(value: unknown) {
  const chain = { select: vi.fn(), lean: vi.fn() };
  chain.select.mockReturnValue(chain);
  chain.lean.mockResolvedValue(value);
  return chain;
}

const CREATED_AT = new Date("2026-08-11T00:00:00.000Z");

function findChain(items: unknown[]) {
  const chain = {
    sort: vi.fn(),
    skip: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockResolvedValue(items);
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createReview", () => {
  it("materializes an aggregate score from legacy rating and present structured evidence", async () => {
    reviewModel.findOne.mockReturnValue(leanChain(null));
    reviewModel.create.mockImplementation(async (review) => {
      const doc = { _id: "new-review", createdAt: CREATED_AT, ...review };
      return { ...doc, toObject: () => doc };
    });

    const result = await createReview("user-1", {
      placeId: "node/123456",
      placeType: "osm",
      passageWidthRating: 4,
      toiletRating: 4,
      elevatorRating: 4,
      serviceRating: 4,
      entranceAccessibility: "step_free",
      toiletTurningRoom: true,
      wheelchairTableHeight: false,
      adequateAisleWidth: true,
      staffHelpfulnessRating: 3,
    });

    expect(reviewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: 4,
        aggregateAccessibilityScore: 3.8,
        entranceAccessibility: "step_free",
        toiletTurningRoom: true,
        wheelchairTableHeight: false,
        adequateAisleWidth: true,
        staffHelpfulnessRating: 3,
      }),
    );
    expect(result.data).toMatchObject({
      review: {
        rating: 4,
        aggregateAccessibilityScore: 3.8,
      },
    });
  });
});

describe("updateReview", () => {
  it("keeps legacy rating semantics and recalculates the separate aggregate score", async () => {
    const review = {
      _id: "66a1f2c3e4b5a6d7c8e9f0d4",
      userId: "user-1",
      rating: 4,
      passageWidthRating: 5,
      toiletRating: 4,
      elevatorRating: 3,
      serviceRating: 4,
      entranceAccessibility: "ramp" as const,
      toiletTurningRoom: true,
      wheelchairTableHeight: false,
      adequateAisleWidth: true,
      staffHelpfulnessRating: 3,
      aggregateAccessibilityScore: undefined as number | undefined,
      createdAt: CREATED_AT,
    };
    reviewModel.findOne.mockReturnValue(leanChain(review));
    reviewModel.findOneAndUpdate.mockImplementation((_q, update) =>
      leanChain({ ...review, ...(update as { $set: object }).$set }),
    );

    const result = await updateReview(review._id, "user-1", {
      serviceRating: 5,
      entranceAccessibility: "inaccessible",
      staffHelpfulnessRating: 5,
    });

    const persisted = (
      reviewModel.findOneAndUpdate.mock.calls[0][1] as {
        $set: Record<string, unknown>;
      }
    ).$set;
    expect(persisted.rating).toBe(4.25);
    expect(persisted.aggregateAccessibilityScore).toBe(3.5);
    expect(reviewModel.findOneAndUpdate).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      review: {
        rating: 4.25,
        aggregateAccessibilityScore: 3.5,
      },
    });
  });

  it("does not overwrite a legacy rating when only structured evidence changes", async () => {
    const review = {
      _id: "66a1f2c3e4b5a6d7c8e9f0d5",
      userId: "user-1",
      rating: 3.7,
      passageWidthRating: 4,
      toiletRating: 4,
      elevatorRating: 4,
      serviceRating: 4,
      aggregateAccessibilityScore: undefined as number | undefined,
      createdAt: CREATED_AT,
    };
    reviewModel.findOne.mockReturnValue(leanChain(review));
    reviewModel.findOneAndUpdate.mockImplementation((_q, update) =>
      leanChain({ ...review, ...(update as { $set: object }).$set }),
    );

    const result = await updateReview(review._id, "user-1", {
      adequateAisleWidth: true,
    });

    const persisted = (
      reviewModel.findOneAndUpdate.mock.calls[0][1] as {
        $set: Record<string, unknown>;
      }
    ).$set;
    expect(persisted.rating).toBeUndefined();
    expect(review.rating).toBe(3.7);
    expect(persisted.aggregateAccessibilityScore).toBe(4.4);
    expect(result.data).toMatchObject({
      review: {
        rating: 3.7,
        aggregateAccessibilityScore: 4.4,
      },
    });
  });
});

describe("findByPlace", () => {
  it("filters with the materialized aggregate score and falls back to legacy rating", async () => {
    const chain = findChain([
      {
        _id: "structured-review",
        userId: "user-1",
        rating: 4,
        passageWidthRating: 4,
        toiletRating: 4,
        elevatorRating: 4,
        serviceRating: 4,
        aggregateAccessibilityScore: 4.2,
        createdAt: CREATED_AT,
      },
    ]);
    reviewModel.find.mockReturnValue(chain);
    reviewModel.countDocuments.mockResolvedValue(1);
    reviewModel.aggregate.mockResolvedValue([{ avg: 4 }]);

    const result = await findByPlace({
      placeId: "node/123456",
      placeType: "osm",
      page: 1,
      limit: 10,
      minAggregateScore: 4,
    });

    const expectedFilter = {
      placeId: "node/123456",
      placeType: "osm",
      status: "active",
      $expr: {
        $gte: [
          {
            $ifNull: [
              "$aggregateAccessibilityScore",
              {
                $divide: [
                  {
                    $floor: {
                      $add: [{ $multiply: ["$rating", 10] }, 0.5],
                    },
                  },
                  10,
                ],
              },
            ],
          },
          4,
        ],
      },
    };
    expect(reviewModel.find).toHaveBeenCalledWith(expectedFilter);
    expect(reviewModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    expect(reviewModel.aggregate).toHaveBeenCalledWith([
      { $match: expectedFilter },
      { $group: { _id: null, avg: { $avg: "$rating" } } },
    ]);
    expect(result.data?.items).toHaveLength(1);
  });

  it("matches the response's one-decimal legacy fallback in the database filter", async () => {
    const chain = findChain([
      {
        _id: "legacy-rounded-review",
        userId: "legacy-user",
        rating: 3.75,
        passageWidthRating: 4,
        toiletRating: 4,
        elevatorRating: 3,
        serviceRating: 4,
        createdAt: CREATED_AT,
      },
    ]);
    reviewModel.find.mockReturnValue(chain);
    reviewModel.countDocuments.mockResolvedValue(1);
    reviewModel.aggregate.mockResolvedValue([{ avg: 3.75 }]);

    const result = await findByPlace({
      placeId: "node/legacy-rounded",
      placeType: "osm",
      page: 1,
      limit: 10,
      minAggregateScore: 3.8,
    });

    const expectedFilter = {
      placeId: "node/legacy-rounded",
      placeType: "osm",
      status: "active",
      $expr: {
        $gte: [
          {
            $ifNull: [
              "$aggregateAccessibilityScore",
              {
                $divide: [
                  {
                    $floor: {
                      $add: [{ $multiply: ["$rating", 10] }, 0.5],
                    },
                  },
                  10,
                ],
              },
            ],
          },
          3.8,
        ],
      },
    };
    expect(reviewModel.find).toHaveBeenCalledWith(expectedFilter);
    expect(reviewModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    expect(result.data?.items).toMatchObject([
      { _id: "legacy-rounded-review", aggregateAccessibilityScore: 3.8 },
    ]);
  });

  it("returns a legacy document without structured fields and preserves its rating", async () => {
    const chain = findChain([
      {
        _id: "legacy-review",
        userId: "legacy-user",
        rating: 2.5,
        passageWidthRating: 2,
        toiletRating: 3,
        elevatorRating: 2,
        serviceRating: 3,
        comment: "舊評價",
        createdAt: CREATED_AT,
      },
    ]);
    reviewModel.find.mockReturnValue(chain);
    reviewModel.countDocuments.mockResolvedValue(1);
    reviewModel.aggregate.mockResolvedValue([{ avg: 2.5 }]);

    const result = await findByPlace({
      placeId: "node/legacy",
      placeType: "osm",
      page: 1,
      limit: 10,
    });

    const item = result.data?.items[0];
    expect(item).toMatchObject({
      _id: "legacy-review",
      rating: 2.5,
      aggregateAccessibilityScore: 2.5,
    });
    expect(item).not.toHaveProperty("entranceAccessibility");
    expect(item).not.toHaveProperty("toiletTurningRoom");
    expect(item).not.toHaveProperty("wheelchairTableHeight");
    expect(item).not.toHaveProperty("adequateAisleWidth");
    expect(item).not.toHaveProperty("staffHelpfulnessRating");
  });
});
