import { Router } from "express";
import middleware from "../../middleware/middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  createReport,
  getNearbyReports,
  getReport,
  getMyReports,
  confirmReport,
  getReviewQueue,
  reviewReport,
} from "./hazard-report.controller";
import {
  CreateHazardReportSchema,
  NearbyReportsQuerySchema,
  MyReportsQuerySchema,
  ReportIdParamSchema,
  ConfirmSchema,
  ReviewQueueQuerySchema,
  ReviewDecisionSchema,
} from "./hazard-report.schema";
import {
  uploadPhoto,
  postReportsLimiter,
  confirmLimiter,
  nearbyLimiter,
} from "./hazard-report.middleware";

export function createHazardReportRouter(): Router {
  const router = Router();

  // Rate limit after validation so malformed/incomplete requests don't burn
  // the submitter's quota — only requests that reach `createReport` count.
  router.post(
    "/reports",
    uploadPhoto,
    validateRequest({ body: CreateHazardReportSchema }),
    postReportsLimiter,
    createReport,
  );

  router.get(
    "/reports/mine",
    middleware,
    validateRequest({ query: MyReportsQuerySchema }),
    getMyReports,
  );

  router.get(
    "/reports",
    nearbyLimiter,
    validateRequest({ query: NearbyReportsQuerySchema }),
    getNearbyReports,
  );

  // Must be registered before "/reports/:id" so "review-queue" is not
  // captured as an :id path parameter.
  router.get(
    "/reports/review-queue",
    middleware,
    requireAdmin,
    validateRequest({ query: ReviewQueueQuerySchema }),
    getReviewQueue,
  );

  router.get(
    "/reports/:id",
    validateRequest({ params: ReportIdParamSchema }),
    getReport,
  );

  router.post(
    "/reports/:id/confirm",
    confirmLimiter,
    validateRequest({ params: ReportIdParamSchema, body: ConfirmSchema }),
    confirmReport,
  );

  router.post(
    "/reports/:id/review",
    middleware,
    requireAdmin,
    validateRequest({
      params: ReportIdParamSchema,
      body: ReviewDecisionSchema,
    }),
    reviewReport,
  );

  return router;
}
