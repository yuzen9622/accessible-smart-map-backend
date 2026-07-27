import Review from "../../model/review.model";
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
  ReviewListResult,
  ReviewSummaryResult,
} from "./review.types";

const MIN_REVIEWS_FOR_AI_SUMMARY = 3;

function ok<T>(data: T, message: string, httpCode = ResponseCode.OK): ServiceResult<T> {
  return { ok: true, httpCode, message, data };
}

function fail(httpCode: number, message: string): ServiceResult {
  return { ok: false, httpCode, message };
}

export async function createReview(
  userId: string,
  input: CreateReviewInput,
): Promise<ServiceResult> {
  const existing = await Review.findOne({
    placeId: input.placeId,
    placeType: input.placeType,
    userId,
    status: "active",
  });
  if (existing) {
    return fail(ResponseCode.INVALID_INPUT, REVIEW_MSG.ALREADY_REVIEWED);
  }

  const rating = (input.passageWidthRating + input.toiletRating + input.elevatorRating + input.serviceRating) / 4;

  const review = await Review.create({
    placeId: input.placeId,
    placeType: input.placeType,
    userId,
    rating,
    passageWidthRating: input.passageWidthRating,
    toiletRating: input.toiletRating,
    elevatorRating: input.elevatorRating,
    serviceRating: input.serviceRating,
    comment: input.comment,
  });

  return ok(
    {
      review: {
        _id: String(review._id),
        userId: review.userId,
        rating: review.rating,
        passageWidthRating: review.passageWidthRating,
        toiletRating: review.toiletRating,
        elevatorRating: review.elevatorRating,
        serviceRating: review.serviceRating,
        comment: review.comment,
        createdAt: review.createdAt,
      },
    },
    REVIEW_MSG.CREATED,
    ResponseCode.CREATED,
  );
}

export async function findByPlace(params: ReviewQueryParams): Promise<ServiceResult<ReviewListResult>> {
  const { placeId, placeType, page, limit } = params;
  const filter = { placeId, placeType, status: "active" };

  const [items, totalCount] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Review.countDocuments(filter),
  ]);

  let avgRating: number | null = null;
  if (totalCount > 0) {
    const agg = await Review.aggregate([
      { $match: filter },
      { $group: { _id: null, avg: { $avg: "$rating" } } },
    ]);
    avgRating = agg[0]?.avg != null ? Math.round(agg[0].avg * 10) / 10 : null;
  }

  return ok(
    {
      items: items.map((r) => ({
        _id: String(r._id),
        userId: r.userId,
        rating: r.rating,
        passageWidthRating: r.passageWidthRating,
        toiletRating: r.toiletRating,
        elevatorRating: r.elevatorRating,
        serviceRating: r.serviceRating,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
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
  const review = await Review.findOne({ _id: id, status: "active" });
  if (!review) {
    return fail(ResponseCode.NOT_FOUND, REVIEW_MSG.NOT_FOUND);
  }
  if (review.userId !== userId) {
    return fail(ResponseCode.FORBIDDEN, REVIEW_MSG.FORBIDDEN);
  }

  if (patch.passageWidthRating !== undefined) review.passageWidthRating = patch.passageWidthRating;
  if (patch.toiletRating !== undefined) review.toiletRating = patch.toiletRating;
  if (patch.elevatorRating !== undefined) review.elevatorRating = patch.elevatorRating;
  if (patch.serviceRating !== undefined) review.serviceRating = patch.serviceRating;
  if (patch.comment !== undefined) review.comment = patch.comment;

  // Recalculate average rating
  review.rating = (review.passageWidthRating + review.toiletRating + review.elevatorRating + review.serviceRating) / 4;

  await review.save();

  return ok(
    {
      review: {
        _id: String(review._id),
        userId: review.userId,
        rating: review.rating,
        passageWidthRating: review.passageWidthRating,
        toiletRating: review.toiletRating,
        elevatorRating: review.elevatorRating,
        serviceRating: review.serviceRating,
        comment: review.comment,
        createdAt: review.createdAt,
      },
    },
    REVIEW_MSG.UPDATED,
  );
}

export async function deleteReview(id: string, userId: string): Promise<ServiceResult> {
  const review = await Review.findOne({ _id: id, status: "active" });
  if (!review) {
    return fail(ResponseCode.NOT_FOUND, REVIEW_MSG.NOT_FOUND);
  }
  if (review.userId !== userId) {
    return fail(ResponseCode.FORBIDDEN, REVIEW_MSG.FORBIDDEN);
  }

  review.status = "deleted";
  await review.save();

  return ok(null, REVIEW_MSG.DELETED);
}

export async function getAiSummary(
  placeId: string,
  placeType: string,
): Promise<ServiceResult<ReviewSummaryResult>> {
  const filter = { placeId, placeType, status: "active" };

  const [reviews, totalCount] = await Promise.all([
    Review.find(filter)
      .select("rating comment")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    Review.countDocuments(filter),
  ]);

  let avgRating: number | null = null;
  if (totalCount > 0) {
    const agg = await Review.aggregate([
      { $match: filter },
      { $group: { _id: null, avg: { $avg: "$rating" } } },
    ]);
    avgRating = agg[0]?.avg != null ? Math.round(agg[0].avg * 10) / 10 : null;
  }

  if (totalCount < MIN_REVIEWS_FOR_AI_SUMMARY) {
    return ok<ReviewSummaryResult>(
      { avgRating, totalCount, summary: null, highlights: null },
      REVIEW_MSG.SUMMARY_OK,
    );
  }

  const reviewsForAi = reviews.map((r) => ({ rating: r.rating, comment: r.comment ?? "" }));

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
