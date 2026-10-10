import { Router } from "express";
import {
  accessibleRoute,
  plannedBusArrivalsHttp,
  rerouteAccessibleRouteHttp,
} from "./accessible-route.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  AccessibleRouteBodySchema,
  AccessibleRouteRerouteBodySchema,
  PlannedBusArrivalsQuerySchema,
} from "./accessible-route.schema";

export function createAccessibleRouteRouter(): Router {
  const router = Router();
  router.get(
    "/accessible-route/bus-arrivals",
    validateRequest({ query: PlannedBusArrivalsQuerySchema }),
    plannedBusArrivalsHttp,
  );
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
