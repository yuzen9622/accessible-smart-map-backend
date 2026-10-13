import { Router } from "express";
import middleware from "../../middleware/middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  createSession,
  updateLocation,
  resolveSession,
  rotateShareToken,
  getPublicSession,
  getSession,
  streamSession,
} from "./sos.controller";
import { publicTrackingLimiter, trackingHeaders } from "./sos.middleware";
import {
  CreateSosSchema,
  UpdateSosLocationSchema,
  SessionIdParamSchema,
  ShareTokenParamSchema,
} from "./sos.schema";

export function createSosRouter(): Router {
  const router = Router();

  router.post(
    "/sessions",
    middleware,
    validateRequest({ body: CreateSosSchema }),
    createSession,
  );

  router.patch(
    "/sessions/:id/location",
    middleware,
    validateRequest({
      params: SessionIdParamSchema,
      body: UpdateSosLocationSchema,
    }),
    updateLocation,
  );

  router.patch(
    "/sessions/:id/resolve",
    middleware,
    validateRequest({ params: SessionIdParamSchema }),
    resolveSession,
  );

  router.post(
    "/sessions/:id/share-token",
    middleware,
    trackingHeaders,
    validateRequest({ params: SessionIdParamSchema }),
    rotateShareToken,
  );

  router.get(
    "/sessions/:token/public",
    publicTrackingLimiter,
    trackingHeaders,
    validateRequest({ params: ShareTokenParamSchema }),
    getPublicSession,
  );

  router.get(
    "/sessions/:id/stream",
    middleware,
    validateRequest({ params: SessionIdParamSchema }),
    streamSession,
  );

  router.get(
    "/sessions/:id",
    middleware,
    validateRequest({ params: SessionIdParamSchema }),
    getSession,
  );

  return router;
}
