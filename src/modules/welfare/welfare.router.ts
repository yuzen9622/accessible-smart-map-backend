import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  nearbyWelfare,
  listWelfare,
  getWelfareById,
} from "./welfare.controller";
import {
  WelfareNearbyQuerySchema,
  WelfareListQuerySchema,
  WelfareParamsSchema,
  WelfareDetailQuerySchema,
} from "./welfare.schema";

export function createWelfareRouter(): Router {
  const router = Router();
  router.get(
    "/welfare/nearby",
    validateRequest({ query: WelfareNearbyQuerySchema }),
    nearbyWelfare,
  );
  router.get(
    "/welfare",
    validateRequest({ query: WelfareListQuerySchema }),
    listWelfare,
  );
  router.get(
    "/welfare/:id",
    validateRequest({
      params: WelfareParamsSchema,
      query: WelfareDetailQuerySchema,
    }),
    getWelfareById,
  );
  return router;
}
