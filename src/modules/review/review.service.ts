import {
  activeReviewExists,
  averageRating,
  findActiveReviewById,
  findRatingsForSummary,
  findReviewPage,
  insertReview,
  softDeleteReview,
  updateActiveReview,
  type EntranceAccessibility,
  type IReview,
  type PlaceType,
  type ReviewRecord,
} from "./review.repository";
import { googleGenAi, model } from "../../config/ai";
import { reviewSummaryConfig } from "../../config/ai/config";
import { reviewSummaryContents } from "../../config/ai/contents";
import { REVIEW_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type {
  ServiceResult,
  CreateReviewInput,
  UpdateReviewInput,
  ReviewQueryParams,
  ReviewItem,
  ReviewListResult,
  ReviewSummaryResult,
} from "./review.types";

const MIN_REVIEWS_FOR_AI_SUMMARY = 3;
const MIN_REVIEW_SCORE = 1;
const MAX_REVIEW_SCORE = 5;
const SCORE_ROUNDING_FACTOR = 10;
const LEGACY_RATING_DIMENSION_COUNT = 4;

const ENTRANCE_ACCESSIBILITY_SCORES: Record<EntranceAccessibility, number> = {
  step_free: MAX_REVIEW_SCORE,
  ramp: 4,
  stairs_with_assistance: 2,
  inaccessible: MIN_REVIEW_SCORE,
};

type AggregateScoreEvidence = Pick<
  IReview,
  | "rating"
  | "passageWidthRating"
  | "toiletRating"
  | "elevatorRating"
  | "serviceRating"
  | "entranceAccessibility"
  | "toiletTurningRoom"
  | "wheelchairTableHeight"
  | "adequateAisleWidth"
  | "staffHelpfulnessRating"
>;

function ok<T>(
  data: T,
  message: string,
  httpCode = ResponseCode.OK,
): ServiceResult<T> {
  return { ok: true, httpCode, message, data };
}

function fail(httpCode: number, message: string): ServiceResult {
  return { ok: false, httpCode, message };
}

function isReviewScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_REVIEW_SCORE &&
    value <= MAX_REVIEW_SCORE
  );
}

function average(scores: number[]): number | undefined {
  if (scores.length === 0) return undefined;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function getLegacyRatingBaseline(
  review: AggregateScoreEvidence,
): number | undefined {
  if (isReviewScore(review.rating)) return review.rating;

  return average(
    [
      review.passageWidthRating,
      review.toiletRating,
      review.elevatorRating,
      review.serviceRating,
    ].filter(isReviewScore),
  );
}

function booleanEvidenceScore(value: unknown): number | undefined {
  if (value === true) return MAX_REVIEW_SCORE;
  if (value === false) return MIN_REVIEW_SCORE;
  return undefined;
}

function isEntranceAccessibility(
  value: unknown,
): value is EntranceAccessibility {
  return (
    typeof value === "string" &&
    Object.keys(ENTRANCE_ACCESSIBILITY_SCORES).includes(value)
  );
}

/**
 * Calculates the additive 1–5 accessibility score without changing `rating`.
 * The existing `rating` is the legacy baseline. Every present structured value
 * contributes one equally weighted score: entrance (step_free=5, ramp=4,
 * stairs_with_assistance=2, inaccessible=1), true/false booleans (5/1), and
 * staffHelpfulnessRating (1–5). The arithmetic mean is rounded to one decimal.
 * If an old document has no usable `rating`, its present legacy sub-ratings are
 * averaged for the baseline instead.
 */
export function calculateAggregateAccessibilityScore(
  review: AggregateScoreEvidence,
): number | undefined {
  const scores: number[] = [];
  const legacyBaseline = getLegacyRatingBaseline(review);

  if (legacyBaseline !== undefined) scores.push(legacyBaseline);

  if (isEntranceAccessibility(review.entranceAccessibility)) {
    scores.push(ENTRANCE_ACCESSIBILITY_SCORES[review.entranceAccessibility]);
  }

  for (const value of [
    review.toiletTurningRoom,
    review.wheelchairTableHeight,
    review.adequateAisleWidth,
  ]) {
    const score = booleanEvidenceScore(value);
    if (score !== undefined) scores.push(score);
  }

  if (isReviewScore(review.staffHelpfulnessRating)) {
    scores.push(review.staffHelpfulnessRating);
  }

  const score = average(scores);
  return score === undefined
    ? undefined
    : Math.round(score * SCORE_ROUNDING_FACTOR) / SCORE_ROUNDING_FACTOR;
}

function calculateLegacyRating(
  review: Pick<
    IReview,
    "passageWidthRating" | "toiletRating" | "elevatorRating" | "serviceRating"
  >,
): number {
  return (
    (review.passageWidthRating +
      review.toiletRating +
      review.elevatorRating +
      review.serviceRating) /
    LEGACY_RATING_DIMENSION_COUNT
  );
}

function toReviewItem(review: ReviewRecord): ReviewItem {
  const aggregateAccessibilityScore =
    calculateAggregateAccessibilityScore(review) ??
    (isReviewScore(review.aggregateAccessibilityScore)
      ? review.aggregateAccessibilityScore
      : undefined);

  return {
    _id: String(review._id),
    userId: review.userId,
    rating: review.rating,
    passageWidthRating: review.passageWidthRating,
    toiletRating: review.toiletRating,
    elevatorRating: review.elevatorRating,
    serviceRating: review.serviceRating,
    ...(review.entranceAccessibility !== undefined
      ? { entranceAccessibility: review.entranceAccessibility }
      : {}),
    ...(review.toiletTurningRoom !== undefined
      ? { toiletTurningRoom: review.toiletTurningRoom }
      : {}),
    ...(review.wheelchairTableHeight !== undefined
      ? { wheelchairTableHeight: review.wheelchairTableHeight }
      : {}),
    ...(review.adequateAisleWidth !== undefined
      ? { adequateAisleWidth: review.adequateAisleWidth }
      : {}),
    ...(review.staffHelpfulnessRating !== undefined
      ? { staffHelpfulnessRating: review.staffHelpfulnessRating }
      : {}),
    ...(aggregateAccessibilityScore !== undefined
      ? { aggregateAccessibilityScore }
      : {}),
    ...(review.comment !== undefined ? { comment: review.comment } : {}),
    createdAt: review.createdAt,
  };
}

export async function createReview(
  userId: string,
  input: CreateReviewInput,
): Promise<ServiceResult> {
  const existing = await activeReviewExists(
    input.placeId,
    input.placeType,
    userId,
  );
  if (existing) {
    return fail(ResponseCode.INVALID_INPUT, REVIEW_MSG.ALREADY_REVIEWED);
  }

  const rating = calculateLegacyRating(input);
  const aggregateAccessibilityScore = calculateAggregateAccessibilityScore({
    ...input,
    rating,
  });

  const review = await insertReview({
    placeId: input.placeId,
    placeType: input.placeType,
    userId,
    rating,
    passageWidthRating: input.passageWidthRating,
    toiletRating: input.toiletRating,
    elevatorRating: input.elevatorRating,
    serviceRating: input.serviceRating,
    entranceAccessibility: input.entranceAccessibility,
    toiletTurningRoom: input.toiletTurningRoom,
    wheelchairTableHeight: input.wheelchairTableHeight,
    adequateAisleWidth: input.adequateAisleWidth,
    staffHelpfulnessRating: input.staffHelpfulnessRating,
    aggregateAccessibilityScore,
    comment: input.comment,
  });

  return ok(
    { review: toReviewItem(review) },
    REVIEW_MSG.CREATED,
    ResponseCode.CREATED,
  );
}

export async function findByPlace(
  params: ReviewQueryParams,
): Promise<ServiceResult<ReviewListResult>> {
  const { placeId, placeType, page, limit, minAggregateScore } = params;
  const filter = { placeId, placeType, minAggregateScore };

  const { items, totalCount } = await findReviewPage(filter, page, limit);

  let avgRating: number | null = null;
  if (totalCount > 0) {
    avgRating = await averageRating(filter);
  }

  return ok(
    {
      items: items.map(toReviewItem),
      avgRating,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    },
    REVIEW_MSG.LIST_OK,
  );
}

export async function updateReview(
  id: string,
  userId: string,
  patch: UpdateReviewInput,
): Promise<ServiceResult> {
  const stored = await findActiveReviewById(id);
  if (!stored) {
    return fail(ResponseCode.NOT_FOUND, REVIEW_MSG.NOT_FOUND);
  }
  if (stored.userId !== userId) {
    return fail(ResponseCode.FORBIDDEN, REVIEW_MSG.FORBIDDEN);
  }

  // The patch is applied to a local copy so the recomputed rating and
  // aggregate score see the same merged state the mutated document used to,
  // then persisted as one `$set`.
  const review = { ...stored } as ReviewRecord & Record<string, unknown>;
  const changes: Record<string, unknown> = {};

  const legacyRatingChanged =
    patch.passageWidthRating !== undefined ||
    patch.toiletRating !== undefined ||
    patch.elevatorRating !== undefined ||
    patch.serviceRating !== undefined;

  const apply = <K extends keyof UpdateReviewInput>(key: K) => {
    if (patch[key] === undefined) return;
    review[key as string] = patch[key];
    changes[key as string] = patch[key];
  };
  apply("passageWidthRating");
  apply("toiletRating");
  apply("elevatorRating");
  apply("serviceRating");
  apply("entranceAccessibility");
  apply("toiletTurningRoom");
  apply("wheelchairTableHeight");
  apply("adequateAisleWidth");
  apply("staffHelpfulnessRating");
  apply("comment");

  if (legacyRatingChanged) {
    review.rating = calculateLegacyRating(review);
    changes.rating = review.rating;
  }

  const aggregateAccessibilityScore =
    calculateAggregateAccessibilityScore(review);
  if (aggregateAccessibilityScore !== undefined) {
    review.aggregateAccessibilityScore = aggregateAccessibilityScore;
    changes.aggregateAccessibilityScore = aggregateAccessibilityScore;
  }

  const saved = (await updateActiveReview(id, changes)) ?? review;

  return ok({ review: toReviewItem(saved) }, REVIEW_MSG.UPDATED);
}

export async function deleteReview(
  id: string,
  userId: string,
): Promise<ServiceResult> {
  const review = await findActiveReviewById(id);
  if (!review) {
    return fail(ResponseCode.NOT_FOUND, REVIEW_MSG.NOT_FOUND);
  }
  if (review.userId !== userId) {
    return fail(ResponseCode.FORBIDDEN, REVIEW_MSG.FORBIDDEN);
  }

  await softDeleteReview(id);

  return ok(null, REVIEW_MSG.DELETED);
}

export async function getAiSummary(
  placeId: string,
  placeType: PlaceType,
): Promise<ServiceResult<ReviewSummaryResult>> {
  const { reviews, totalCount } = await findRatingsForSummary(
    placeId,
    placeType,
    50,
  );

  let avgRating: number | null = null;
  if (totalCount > 0) {
    avgRating = await averageRating({ placeId, placeType });
  }

  if (totalCount < MIN_REVIEWS_FOR_AI_SUMMARY) {
    return ok<ReviewSummaryResult>(
      { avgRating, totalCount, summary: null, highlights: null },
      REVIEW_MSG.SUMMARY_OK,
    );
  }

  const reviewsForAi = reviews.map((r) => ({
    rating: r.rating,
    comment: r.comment ?? "",
  }));

  let summary: string | null = null;
  let highlights: string[] | null = null;

  try {
    const aiResponse = await googleGenAi.models.generateContent({
      model,
      contents: [
        ...reviewSummaryContents,
        { role: "user", parts: [{ text: JSON.stringify(reviewsForAi) }] },
      ],
      config: reviewSummaryConfig,
    });

    const text = aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      const parsed = JSON.parse(text);
      summary = parsed.summary ?? null;
      highlights = Array.isArray(parsed.highlights) ? parsed.highlights : null;
    }
  } catch (error) {
    console.error("Failed to generate AI review summary:", error);
    // AI 呼叫失敗時降級為純統計，不影響主流程
  }

  return ok<ReviewSummaryResult>(
    { avgRating, totalCount, summary, highlights },
    REVIEW_MSG.SUMMARY_OK,
  );
}
