import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  listFacilityTypes,
  nearbyCampus,
  listSchools,
  listCampus,
  getCampusByCampusId,
} from "./campus.controller";
import {
  CampusNearbyQuerySchema,
  CampusListQuerySchema,
  CampusSchoolsQuerySchema,
  CampusParamsSchema,
} from "./campus.schema";

export function createCampusRouter(): Router {
  const router = Router();
  router.get("/campus/facility-types", listFacilityTypes);
  router.get(
    "/campus/nearby",
    validateRequest({ query: CampusNearbyQuerySchema }),
    nearbyCampus,
  );
  router.get(
    "/campus/schools",
    validateRequest({ query: CampusSchoolsQuerySchema }),
    listSchools,
  );
  router.get(
    "/campus",
    validateRequest({ query: CampusListQuerySchema }),
    listCampus,
  );
  router.get(
    "/campus/:campusId",
    validateRequest({ params: CampusParamsSchema }),
    getCampusByCampusId,
  );
  return router;
}
