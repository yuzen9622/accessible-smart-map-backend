import Review, {
	type EntranceAccessibility,
	type IReview,
} from "../../model/review.model";
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

// MongoDB's $round uses banker's rounding, unlike Math.round. Ratings are
// positive, so this mirrors the response's one-decimal Math.round fallback.
const LEGACY_RATING_ROUNDING_EXPR = {
	$divide: [
		{
			$floor: {
				$add: [{ $multiply: ["$rating", SCORE_ROUNDING_FACTOR] }, 0.5],
			},
		},
		SCORE_ROUNDING_FACTOR,
	],
};

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

type ReviewRecord = Pick<
	IReview,
	| "_id"
	| "userId"
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
	| "aggregateAccessibilityScore"
	| "comment"
	| "createdAt"
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
	const existing = await Review.findOne({
		placeId: input.placeId,
		placeType: input.placeType,
		userId,
		status: "active",
	});
	if (existing) {
		return fail(ResponseCode.INVALID_INPUT, REVIEW_MSG.ALREADY_REVIEWED);
	}

	const rating = calculateLegacyRating(input);
	const aggregateAccessibilityScore = calculateAggregateAccessibilityScore({
		...input,
		rating,
	});

	const review = await Review.create({
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
	const filter = {
		placeId,
		placeType,
		status: "active",
		...(minAggregateScore !== undefined
			? {
					$expr: {
						$gte: [
							{
								$ifNull: [
									"$aggregateAccessibilityScore",
									LEGACY_RATING_ROUNDING_EXPR,
								],
							},
							minAggregateScore,
						],
					},
				}
			: {}),
	};

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
	const review = await Review.findOne({ _id: id, status: "active" });
	if (!review) {
		return fail(ResponseCode.NOT_FOUND, REVIEW_MSG.NOT_FOUND);
	}
	if (review.userId !== userId) {
		return fail(ResponseCode.FORBIDDEN, REVIEW_MSG.FORBIDDEN);
	}

	const legacyRatingChanged =
		patch.passageWidthRating !== undefined ||
		patch.toiletRating !== undefined ||
		patch.elevatorRating !== undefined ||
		patch.serviceRating !== undefined;

	if (patch.passageWidthRating !== undefined)
		review.passageWidthRating = patch.passageWidthRating;
	if (patch.toiletRating !== undefined)
		review.toiletRating = patch.toiletRating;
	if (patch.elevatorRating !== undefined)
		review.elevatorRating = patch.elevatorRating;
	if (patch.serviceRating !== undefined)
		review.serviceRating = patch.serviceRating;
	if (patch.entranceAccessibility !== undefined)
		review.entranceAccessibility = patch.entranceAccessibility;
	if (patch.toiletTurningRoom !== undefined)
		review.toiletTurningRoom = patch.toiletTurningRoom;
	if (patch.wheelchairTableHeight !== undefined)
		review.wheelchairTableHeight = patch.wheelchairTableHeight;
	if (patch.adequateAisleWidth !== undefined)
		review.adequateAisleWidth = patch.adequateAisleWidth;
	if (patch.staffHelpfulnessRating !== undefined) {
		review.staffHelpfulnessRating = patch.staffHelpfulnessRating;
	}
	if (patch.comment !== undefined) review.comment = patch.comment;

	if (legacyRatingChanged) {
		review.rating = calculateLegacyRating(review);
	}

	const aggregateAccessibilityScore =
		calculateAggregateAccessibilityScore(review);
	if (aggregateAccessibilityScore !== undefined) {
		review.aggregateAccessibilityScore = aggregateAccessibilityScore;
	}

	await review.save();

	return ok({ review: toReviewItem(review) }, REVIEW_MSG.UPDATED);
}

export async function deleteReview(
	id: string,
	userId: string,
): Promise<ServiceResult> {
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
