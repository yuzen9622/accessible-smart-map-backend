import type { PlaceType } from "../../model/review.model";

export type { PlaceType };

export interface ServiceResult<T = unknown> {
  ok: boolean;
  httpCode: number;
  message: string;
  data?: T;
}

export interface CreateReviewInput {
  placeId: string;
  placeType: PlaceType;
  passageWidthRating: number;
  toiletRating: number;
  elevatorRating: number;
  serviceRating: number;
  comment?: string;
}

export interface UpdateReviewInput {
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
}

export interface ReviewSummaryInput {
  placeId: string;
  placeType: PlaceType;
}

export interface ReviewItem {
  _id: string;
  userId: string;
  rating: number;
  passageWidthRating: number;
  toiletRating: number;
  elevatorRating: number;
  serviceRating: number;
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
