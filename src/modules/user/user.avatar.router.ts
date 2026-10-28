import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import { getAvatar } from "./user.avatar.controller";
import { avatarHeaders, avatarReadLimiter } from "./user.middleware";
import { AvatarParamsSchema } from "./user.schema";

/** Public avatar bytes; mounted outside the JWT-protected `/user` prefix. */
export function createAvatarRouter(): Router {
  const router = Router();
  router.get(
    "/:userId/:file",
    avatarHeaders,
    avatarReadLimiter,
    validateRequest({ params: AvatarParamsSchema }),
    getAvatar,
  );
  return router;
}
