import { optionalAuth } from "../../middleware/optional-auth.middleware";
import {
  requireContributor,
  personalizedHeaders,
} from "../content-safety/content-safety.middleware";
import { Router } from "express";
import middleware from "../../middleware/middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  createReport,
  getNearbyReports,
  getSafetyReports,
  getReport,
  getReportPhoto,
  getMyReports,
  confirmReport,
  getReviewQueue,
  reviewReport,
  getAiMetrics,
} from "./hazard-report.controller";
import {
  CreateHazardReportSchema,
  NearbyReportsQuerySchema,
  MyReportsQuerySchema,
  ReportIdParamSchema,
  PhotoReportIdParamSchema,
  ConfirmSchema,
  ReviewQueueQuerySchema,
  ReviewDecisionSchema,
  AiMetricsQuerySchema,
} from "./hazard-report.schema";
import {
  uploadPhoto,
  privatePhotoHeaders,
  requirePhotoLogin,
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
    optionalAuth,
    requireContributor,
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
    personalizedHeaders,
    optionalAuth,
    nearbyLimiter,
    validateRequest({ query: NearbyReportsQuerySchema }),
    getNearbyReports,
  );

  router.get(
    "/reports/safety",
    nearbyLimiter,
    validateRequest({ query: NearbyReportsQuerySchema }),
    getSafetyReports,
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
    "/reports/ops/metrics",
    middleware,
    requireAdmin,
    nearbyLimiter,
    validateRequest({ query: AiMetricsQuerySchema }),
    getAiMetrics,
  );

  router.get(
    "/reports/:id/photo",
    privatePhotoHeaders,
    requirePhotoLogin,
    nearbyLimiter,
    validateRequest({ params: PhotoReportIdParamSchema }),
    getReportPhoto,
  );

  router.get(
    "/reports/:id",
    personalizedHeaders,
    optionalAuth,
    validateRequest({ params: ReportIdParamSchema }),
    getReport,
    getReportPhoto,
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
