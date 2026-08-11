import type { EntranceAccessibility, PlaceType } from "../../model/review.model";

export type { EntranceAccessibility, PlaceType };

export interface ServiceResult<T = unknown> {
  ok: boolean;
  httpCode: number;
  message: string;
  data?: T;
}

export interface StructuredAccessibilityReviewInput {
  entranceAccessibility?: EntranceAccessibility;
  toiletTurningRoom?: boolean;
  wheelchairTableHeight?: boolean;
  adequateAisleWidth?: boolean;
  staffHelpfulnessRating?: number;
}

export interface CreateReviewInput extends StructuredAccessibilityReviewInput {
  placeId: string;
  placeType: PlaceType;
  passageWidthRating: number;
  toiletRating: number;
  elevatorRating: number;
  serviceRating: number;
  comment?: string;
}

export interface UpdateReviewInput extends StructuredAccessibilityReviewInput {
  passageWidthRating?: number;
  toiletRating?: number;
  elevatorRating?: number;
  serviceRating?: number;
  comment?: string;
}

export interface ReviewQueryParams {
  placeId: string;
  placeType: PlaceType;
  page: number;
  limit: number;
  minAggregateScore?: number;
}

export interface ReviewSummaryInput {
  placeId: string;
  placeType: PlaceType;
}

export interface ReviewItem extends StructuredAccessibilityReviewInput {
  _id: string;
  userId: string;
  rating: number;
  passageWidthRating: number;
  toiletRating: number;
  elevatorRating: number;
  serviceRating: number;
  aggregateAccessibilityScore?: number;
  comment?: string;
  createdAt: Date;
}

export interface ReviewListResult {
  items: ReviewItem[];
  avgRating: number | null;
  totalCount: number;
  page: number;
  totalPages: number;
}

export interface ReviewSummaryResult {
  avgRating: number | null;
  totalCount: number;
  summary: string | null;
  highlights: string[] | null;
}
