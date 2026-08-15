import { Router } from "express";
import { accessibleRoute } from "./accessible-route.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { AccessibleRouteBodySchema } from "./accessible-route.schema";

export function createAccessibleRouteRouter(): Router {
  const router = Router();
  router.post(
    "/accessible-route",
    validateRequest({ body: AccessibleRouteBodySchema }),
    accessibleRoute,
  );
  return router;
}
