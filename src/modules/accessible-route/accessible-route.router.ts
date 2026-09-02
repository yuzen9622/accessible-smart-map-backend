import { Router } from "express";
import {
  accessibleRoute,
  rerouteAccessibleRouteHttp,
} from "./accessible-route.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  AccessibleRouteBodySchema,
  AccessibleRouteRerouteBodySchema,
} from "./accessible-route.schema";

export function createAccessibleRouteRouter(): Router {
  const router = Router();
  router.post(
    "/accessible-route",
    validateRequest({ body: AccessibleRouteBodySchema }),
    accessibleRoute,
  );
  router.post(
    "/accessible-route/reroute",
    validateRequest({ body: AccessibleRouteRerouteBodySchema }),
    rerouteAccessibleRouteHttp,
  );
  return router;
}
