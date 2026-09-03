import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { getRoadIncidents, getTrafficFlow } from "./traffic.controller";
import {
  GetRoadIncidentsQuerySchema,
  GetTrafficFlowQuerySchema,
} from "./traffic.schema";

export function createTrafficRouter(): Router {
  const router = Router();

  router.get(
    "/flow",
    validateRequest({ query: GetTrafficFlowQuerySchema }),
    getTrafficFlow,
  );

  router.get(
    "/incidents",
    validateRequest({ query: GetRoadIncidentsQuerySchema }),
    getRoadIncidents,
  );

  return router;
}
