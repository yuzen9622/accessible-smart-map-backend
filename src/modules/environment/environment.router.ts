import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { getEnvironmentInfo, getNearbyCctv } from "./environment.controller";
import { EnvironmentQuerySchema } from "./environment.schema";

export function createEnvironmentRouter(): Router {
  const router = Router();

  router.get(
    "/environment",
    validateRequest({ query: EnvironmentQuerySchema }),
    getEnvironmentInfo,
  );

  router.get(
    "/cctv",
    validateRequest({ query: EnvironmentQuerySchema }),
    getNearbyCctv,
  );

  return router;
}
