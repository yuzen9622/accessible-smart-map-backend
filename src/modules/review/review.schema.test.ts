import { describe, expect, it } from "vitest";
import {
  CreateReviewSchema,
  ListReviewsQuerySchema,
  UpdateReviewSchema,
} from "./review.schema";

const VALID_CREATE = {
  placeId: "node/123456",
  placeType: "osm",
  passageWidthRating: 4,
  toiletRating: 4,
  elevatorRating: 4,
  serviceRating: 4,
};

describe("structured review request schemas", () => {
  it("accepts all optional structured accessibility evidence", () => {
    const result = CreateReviewSchema.safeParse({
      ...VALID_CREATE,
      entranceAccessibility: "step_free",
      toiletTurningRoom: true,
      wheelchairTableHeight: false,
      adequateAisleWidth: true,
      staffHelpfulnessRating: 5,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid entranceAccessibility enum on create and update", () => {
    expect(
      CreateReviewSchema.safeParse({
        ...VALID_CREATE,
        entranceAccessibility: "elevator",
      }).success,
    ).toBe(false);
    expect(
      UpdateReviewSchema.safeParse({ entranceAccessibility: "stairs" }).success,
    ).toBe(false);
  });

  it("rejects non-integer and out-of-range staff helpfulness ratings", () => {
    expect(
      UpdateReviewSchema.safeParse({ staffHelpfulnessRating: 0 }).success,
    ).toBe(false);
    expect(
      UpdateReviewSchema.safeParse({ staffHelpfulnessRating: 5.5 }).success,
    ).toBe(false);
    expect(
      UpdateReviewSchema.safeParse({ staffHelpfulnessRating: 6 }).success,
    ).toBe(false);
  });

  it("rejects unknown fields on create and update", () => {
    expect(
      CreateReviewSchema.safeParse({ ...VALID_CREATE, unsupported: true })
        .success,
    ).toBe(false);
    expect(
      UpdateReviewSchema.safeParse({
        adequateAisleWidth: true,
        unsupported: true,
      }).success,
    ).toBe(false);
  });

  it("coerces minAggregateScore and enforces its 1–5 bounds", () => {
    const result = ListReviewsQuerySchema.safeParse({
      placeId: "node/123456",
      placeType: "osm",
      minAggregateScore: "3.5",
    });

    expect(result.success && result.data.minAggregateScore).toBe(3.5);
    expect(
      ListReviewsQuerySchema.safeParse({
        placeId: "node/123456",
        placeType: "osm",
        minAggregateScore: "0.9",
      }).success,
    ).toBe(false);
    expect(
      ListReviewsQuerySchema.safeParse({
        placeId: "node/123456",
        placeType: "osm",
        minAggregateScore: "5.1",
      }).success,
    ).toBe(false);
  });
});
