import Review, {
	type EntranceAccessibility,
	type IReview,
	type PlaceType,
} from "../../model/review.model";

export type { EntranceAccessibility, IReview, PlaceType };

const SCORE_ROUNDING_FACTOR = 10;

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

/** A review as stored, as a plain object. */
export type ReviewRecord = Pick<
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

/** The rating/comment pair the AI summary consumes. */
export type ReviewRatingComment = Pick<IReview, "rating" | "comment">;

/** Identifies one place's active reviews, optionally floored by score. */
export interface PlaceReviewFilter {
	placeId: string;
	placeType: PlaceType;
	minAggregateScore?: number;
}

function buildPlaceFilter(filter: PlaceReviewFilter): Record<string, unknown> {
	return {
		placeId: filter.placeId,
		placeType: filter.placeType,
		status: "active" as const,
		...(filter.minAggregateScore !== undefined
			? {
					$expr: {
						$gte: [
							{
								$ifNull: [
									"$aggregateAccessibilityScore",
									LEGACY_RATING_ROUNDING_EXPR,
								],
							},
							filter.minAggregateScore,
						],
					},
				}
			: {}),
	};
}

/**
 * Whether a user already has an active review for a place.
 *
 * @param placeId Place identifier
 * @param placeType Place kind
 * @param userId Author
 * @returns True when an active review already exists
 */
export async function activeReviewExists(
	placeId: string,
	placeType: PlaceType,
	userId: string,
): Promise<boolean> {
	const existing = await Review.findOne({
		placeId,
		placeType,
		userId,
		status: "active",
	}).lean<ReviewRecord | null>();
	return Boolean(existing);
}

/**
 * Inserts a review.
 *
 * @param doc The review to store
 * @returns The stored review
 */
export async function insertReview(
	doc: Record<string, unknown>,
): Promise<ReviewRecord> {
	const created = await Review.create(doc);
	return created.toObject() as unknown as ReviewRecord;
}

/**
 * One page of a place's active reviews plus the unpaginated total.
 *
 * @param filter Place and optional minimum aggregate score
 * @param page 1-based page number
 * @param limit Page size
 * @returns The page's reviews and the total count
 */
export async function findReviewPage(
	filter: PlaceReviewFilter,
	page: number,
	limit: number,
): Promise<{ items: ReviewRecord[]; totalCount: number }> {
	const query = buildPlaceFilter(filter);
	const [items, totalCount] = await Promise.all([
		Review.find(query)
			.sort({ createdAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean<ReviewRecord[]>(),
		Review.countDocuments(query),
	]);
	return { items, totalCount };
}

/**
 * Mean legacy rating across a place's matching active reviews.
 *
 * @param filter Place and optional minimum aggregate score
 * @returns The mean rounded to one decimal, or null when there is nothing to average
 */
export async function averageRating(
	filter: PlaceReviewFilter,
): Promise<number | null> {
	const agg = await Review.aggregate([
		{ $match: buildPlaceFilter(filter) },
		{ $group: { _id: null, avg: { $avg: "$rating" } } },
	]);
	return agg[0]?.avg != null ? Math.round(agg[0].avg * 10) / 10 : null;
}

/**
 * The most recent ratings and comments for a place, for AI summarisation.
 *
 * @param placeId Place identifier
 * @param placeType Place kind
 * @param limit Hard cap on returned reviews
 * @returns Rating/comment pairs plus the place's total active review count
 */
export async function findRatingsForSummary(
	placeId: string,
	placeType: PlaceType,
	limit: number,
): Promise<{ reviews: ReviewRatingComment[]; totalCount: number }> {
	const query = { placeId, placeType, status: "active" as const };
	const [reviews, totalCount] = await Promise.all([
		Review.find(query)
			.select("rating comment")
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean<ReviewRatingComment[]>(),
		Review.countDocuments(query),
	]);
	return { reviews, totalCount };
}

/**
 * One active review by id.
 *
 * @param id Review id
 * @returns The review, or null when missing or already deleted
 */
export async function findActiveReviewById(
	id: string,
): Promise<ReviewRecord | null> {
	return Review.findOne({ _id: id, status: "active" }).lean<ReviewRecord | null>();
}

/**
 * Applies a field patch to an active review.
 *
 * @param id Review id
 * @param fields Already-resolved fields to set
 * @returns The review after the update, or null when it is no longer active
 */
export async function updateActiveReview(
	id: string,
	fields: Record<string, unknown>,
): Promise<ReviewRecord | null> {
	return Review.findOneAndUpdate(
		{ _id: id, status: "active" },
		{ $set: fields },
		{ returnDocument: "after" },
	).lean<ReviewRecord | null>();
}

/**
 * Soft-deletes an active review.
 *
 * @param id Review id
 */
export async function softDeleteReview(id: string): Promise<void> {
	await Review.updateOne({ _id: id, status: "active" }, { $set: { status: "deleted" } });
}
