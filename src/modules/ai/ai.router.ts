import { Router } from "express";
import { aiIntent, aiExplain } from "./ai.controller";
import { aiChat } from "./ai.chat.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import middleware from "../../middleware/middleware";
import { optionalAuth } from "../../middleware/optional-auth.middleware";
import {
  aiChatRateLimit,
  aiExplainRateLimit,
  aiIntentRateLimit,
} from "./ai.middleware";
import {
  AgentChatRequestSchema,
  CreateMemoryBodySchema,
  ExplainBodySchema,
  IntentBodySchema,
  MemoryIdParamsSchema,
  MemoryListQuerySchema,
  MemorySettingsBodySchema,
  UpdateMemoryBodySchema,
} from "./ai.schema";
import {
  clearUserMemories,
  createUserMemory,
  deleteUserMemory,
  getUserMemorySettings,
  listUserMemories,
  updateUserMemory,
  updateUserMemorySettings,
} from "./memory.controller";

export function createAiRouter(): Router {
  const router = Router();
  router.post(
    "/intent",
    optionalAuth,
    aiIntentRateLimit,
    validateRequest({ body: IntentBodySchema }),
    aiIntent,
  );
  router.post(
    "/explain",
    optionalAuth,
    aiExplainRateLimit,
    validateRequest({ body: ExplainBodySchema }),
    aiExplain,
  );
  router.post(
    "/chat",
    optionalAuth,
    aiChatRateLimit,
    validateRequest({ body: AgentChatRequestSchema }),
    aiChat,
  );
  router.get("/memories/settings", middleware, getUserMemorySettings);
  router.patch(
    "/memories/settings",
    middleware,
    validateRequest({ body: MemorySettingsBodySchema }),
    updateUserMemorySettings,
  );
  router.get(
    "/memories",
    middleware,
    validateRequest({ query: MemoryListQuerySchema }),
    listUserMemories,
  );
  router.post(
    "/memories",
    middleware,
    validateRequest({ body: CreateMemoryBodySchema }),
    createUserMemory,
  );
  router.patch(
    "/memories/:id",
    middleware,
    validateRequest({
      params: MemoryIdParamsSchema,
      body: UpdateMemoryBodySchema,
    }),
    updateUserMemory,
  );
  router.delete(
    "/memories/:id",
    middleware,
    validateRequest({ params: MemoryIdParamsSchema }),
    deleteUserMemory,
  );
  router.delete("/memories", middleware, clearUserMemories);
  return router;
}
