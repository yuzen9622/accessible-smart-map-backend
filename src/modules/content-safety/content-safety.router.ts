import { Router } from "express";
import authenticate from "../../middleware/middleware";
import { requireAdmin } from "../../middleware/require-admin.middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import * as controller from "./content-safety.controller";
import {
  ReportSchema,
  TargetSchema,
  IdSchema,
  DecisionSchema,
  CasesQuerySchema,
} from "./content-safety.schema";
import { safetyLimiter, safetyIpLimiter } from "./content-safety.middleware";

export function createContentSafetyRouter() {
  const router = Router();
  router.get(
    "/content-reports",
    authenticate,
    requireAdmin,
    validateRequest({ query: CasesQuerySchema }),
    controller.listCases,
  );
  router.post(
    "/content-reports",
    safetyIpLimiter,
    authenticate,
    safetyLimiter,
    validateRequest({ body: ReportSchema }),
    controller.report,
  );
  router.get(
    "/content-reports/:id",
    authenticate,
    requireAdmin,
    validateRequest({ params: IdSchema }),
    controller.getCase,
  );
  router.post(
    "/content-reports/:id/decision",
    authenticate,
    requireAdmin,
    validateRequest({ params: IdSchema, body: DecisionSchema }),
    controller.decide,
  );
  router.get("/user/blocks", authenticate, controller.blocks);
  router.put(
    "/user/blocks",
    safetyIpLimiter,
    authenticate,
    safetyLimiter,
    validateRequest({ body: TargetSchema }),
    controller.block,
  );
  router.delete(
    "/user/blocks/:id",
    authenticate,
    validateRequest({ params: IdSchema }),
    controller.unblock,
  );
  return router;
}
