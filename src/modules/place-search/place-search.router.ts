import { Router } from "express";
import { autocomplete, details } from "./place-search.controller";
import { autocompleteLimiter, detailsLimiter } from "./place-search.middleware";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  AutocompleteQuerySchema,
  DetailsParamsSchema,
  DetailsQuerySchema,
} from "./place-search.schema";

export function createPlaceSearchRouter(): Router {
  const router = Router();
  router.get(
    "/search/autocomplete",
    autocompleteLimiter,
    validateRequest({ query: AutocompleteQuerySchema }),
    autocomplete,
  );
  router.get(
    "/search/details/:id",
    detailsLimiter,
    validateRequest({ params: DetailsParamsSchema, query: DetailsQuerySchema }),
    details,
  );
  return router;
}
