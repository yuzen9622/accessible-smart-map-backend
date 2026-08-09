import { Router } from "express";
import {
  getAllFacilities,
  getBathrooms,
  getRamps,
  getElevators,
  getServiceCoverage,
  nearbyA11y,
  nearbyParking,
  getA11yPlace,
  quickAssess,
} from "./a11y.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  AllFacilitiesQuerySchema,
  ServiceCoverageQuerySchema,
  NearbyA11yQuerySchema,
  A11yPlaceQuerySchema,
  ParkingNearbyQuerySchema,
  QuickAssessQuerySchema,
} from "./a11y.schema";

export function createA11yRouter(): Router {
  const router = Router();
  router.get(
    "/coverage",
    validateRequest({ query: ServiceCoverageQuerySchema }),
    getServiceCoverage
  );
  router.get(
    "/all-facilities",
    validateRequest({ query: AllFacilitiesQuerySchema }),
    getAllFacilities
  );
  router.get("/all-bathrooms", getBathrooms);
  router.get("/all-ramps", getRamps);
  router.get("/all-elevators", getElevators);
  router.get("/nearby-a11y", validateRequest({ query: NearbyA11yQuerySchema }), nearbyA11y);
  router.get("/quick-assess", validateRequest({ query: QuickAssessQuerySchema }), quickAssess);
  router.get("/parking/nearby", validateRequest({ query: ParkingNearbyQuerySchema }), nearbyParking);
  router.get("/place", validateRequest({ query: A11yPlaceQuerySchema }), getA11yPlace);
  return router;
}
