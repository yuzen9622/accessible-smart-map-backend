import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Review from "../../model/review.model";
import {
  activeReviewExists,
  averageRating,
  findActiveReviewById,
  findRatingsForSummary,
  findReviewPage,
  insertReview,
  softDeleteReview,
  updateActiveReview,
} from "./review.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("review repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("aggregates, paginates, updates and soft-deletes active reviews", async () => {
    const place = { placeId: "review-place", placeType: "osm" as const };
    const old = await insertReview({
      ...place,
      userId: "review-user-old",
      rating: 4,
      passageWidthRating: 4,
      toiletRating: 4,
      elevatorRating: 4,
      serviceRating: 4,
      aggregateAccessibilityScore: 4,
      comment: "Older review",
      status: "active",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    await insertReview({
      ...place,
      userId: "review-user-middle",
      rating: 3,
      passageWidthRating: 3,
      toiletRating: 3,
      elevatorRating: 3,
      serviceRating: 3,
      comment: "Legacy score",
      status: "active",
      createdAt: new Date("2024-02-01T00:00:00.000Z"),
      updatedAt: new Date("2024-02-01T00:00:00.000Z"),
    });
    const newest = await insertReview({
      ...place,
      userId: "review-user-new",
      rating: 5,
      passageWidthRating: 5,
      toiletRating: 5,
      elevatorRating: 5,
      serviceRating: 5,
      aggregateAccessibilityScore: 5,
      comment: "Newest review",
      status: "active",
      createdAt: new Date("2024-03-01T00:00:00.000Z"),
      updatedAt: new Date("2024-03-01T00:00:00.000Z"),
    });

    const page = await findReviewPage(place, 1, 2);
    expect(page.totalCount).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.comment).toBe("Newest review");
    expect(page.items[1]?.comment).toBe("Legacy score");
    await expect(averageRating(place)).resolves.toBe(4);
    await expect(
      activeReviewExists(place.placeId, place.placeType, "review-user-new"),
    ).resolves.toBe(true);

    const filtered = await findReviewPage(
      { ...place, minAggregateScore: 4.5 },
      1,
      10,
    );
    expect(filtered.totalCount).toBe(1);
    expect(filtered.items[0]?.comment).toBe("Newest review");

    await expect(
      findRatingsForSummary(place.placeId, place.placeType, 1),
    ).resolves.toMatchObject({
      totalCount: 3,
      reviews: [{ rating: 5, comment: "Newest review" }],
    });

    const updated = await updateActiveReview(String(newest._id), {
      comment: "Updated review",
      aggregateAccessibilityScore: 4.8,
    });
    expect(updated).toMatchObject({
      _id: newest._id,
      comment: "Updated review",
      aggregateAccessibilityScore: 4.8,
    });
    await expect(Review.findById(newest._id).lean()).resolves.toMatchObject({
      comment: "Updated review",
    });

    await softDeleteReview(String(old._id));
    await expect(findActiveReviewById(String(old._id))).resolves.toBeNull();
    await expect(
      activeReviewExists(place.placeId, place.placeType, "review-user-old"),
    ).resolves.toBe(false);
  });
});
