import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { getVenue, listVenues, planVenueRoute } from "./venue.controller";
import { VenueParamsSchema, VenueRouteBodySchema } from "./venue.schema";

export function createVenueRouter(): Router {
  const router = Router();
  router.get("/venues", listVenues);
  router.get(
    "/venues/:venueId",
    validateRequest({ params: VenueParamsSchema }),
    getVenue,
  );
  router.post(
    "/venues/:venueId/route",
    validateRequest({ params: VenueParamsSchema, body: VenueRouteBodySchema }),
    planVenueRoute,
  );
  return router;
}
