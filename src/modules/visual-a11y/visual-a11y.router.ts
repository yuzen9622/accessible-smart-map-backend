import { Router } from "express";
import middleware from "../../middleware/middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { getNearbyVisualA11y, syncVisualA11y } from "./visual-a11y.controller";
import { VisualA11yNearbyQuerySchema } from "./visual-a11y.schema";

export function createVisualA11yRouter(): Router {
  const router = Router();
  router.get(
    "/visual-a11y",
    validateRequest({ query: VisualA11yNearbyQuerySchema }),
    getNearbyVisualA11y,
  );
  router.post("/visual-a11y/sync", middleware, syncVisualA11y);
  return router;
}
