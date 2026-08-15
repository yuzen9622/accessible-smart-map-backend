import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  middleware as lineSdkMiddleware,
  SignatureValidationFailed,
} from "@line/bot-sdk";
import { rateLimit } from "express-rate-limit";
import { sendResponse } from "../../config/lib";
import { ResponseCode, ResponseMessage } from "../../types/code";

/**
 * Buffers the raw request body so `@line/bot-sdk`'s signature middleware can
 * verify the HMAC-SHA256 over the unparsed bytes. Mounted before the global
 * `express.json()` (see `app.ts`).
 */
export const webhookRawBody = express.raw({ type: "application/json" });

/**
 * `@line/bot-sdk` signature middleware. Constructed with a non-empty fallback
 * secret so the app stays importable when LINE is unconfigured — any real
 * request then fails signature validation and is rejected (fail-closed).
 */
export const lineSignatureMiddleware = lineSdkMiddleware({
  channelSecret:
    process.env.LINE_CHANNEL_SECRET || "line-channel-secret-not-configured",
});

/**
 * Basic per-IP rate limit for the public webhook endpoint.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) =>
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.TOO_MANY_REQUESTS,
      ResponseMessage.TOO_MANY_REQUESTS,
    ),
});

/**
 * Route-level error handler that converts the SDK's thrown
 * `SignatureValidationFailed` into a 401 envelope; all other errors propagate.
 *
 * @param err The error thrown upstream in this route's chain.
 * @param _req Express request.
 * @param res Express response.
 * @param next Next error handler for non-signature errors.
 */
export function webhookErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err instanceof SignatureValidationFailed) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED,
    );
  }
  next(err);
}
