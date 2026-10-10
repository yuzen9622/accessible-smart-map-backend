import { optionalAuth } from "../../middleware/optional-auth.middleware";
import {
  requireContributor,
  personalizedHeaders,
} from "../content-safety/content-safety.middleware";
import { Router } from "express";
import middleware from "../../middleware/middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { reviewSummaryRateLimit } from "../ai/ai.middleware";
import {
  CreateReviewSchema,
  UpdateReviewSchema,
  ListReviewsQuerySchema,
  SummaryQuerySchema,
  ReviewIdParamSchema,
} from "./review.schema";
import {
  createReview,
  listReviews,
  updateReview,
  deleteReview,
  getAiSummary,
} from "./review.controller";

export function createReviewRouter(): Router {
  const router = Router();

  // summary must be declared before /:id to avoid Express treating "summary" as an id
  router.get(
    "/reviews/summary",
    personalizedHeaders,
    optionalAuth,
    reviewSummaryRateLimit,
    validateRequest({ query: SummaryQuerySchema }),
    getAiSummary,
  );
  router.get(
    "/reviews",
    personalizedHeaders,
    optionalAuth,
    validateRequest({ query: ListReviewsQuerySchema }),
    listReviews,
  );
  router.post(
    "/reviews",
    middleware,
    requireContributor,
    validateRequest({ body: CreateReviewSchema }),
    createReview,
  );
  router.patch(
    "/reviews/:id",
    middleware,
    requireContributor,
    validateRequest({ params: ReviewIdParamSchema, body: UpdateReviewSchema }),
    updateReview,
  );
  router.delete(
    "/reviews/:id",
    middleware,
    validateRequest({ params: ReviewIdParamSchema }),
    deleteReview,
  );

  return router;
}
