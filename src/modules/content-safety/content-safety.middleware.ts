import type { Request, Response, NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";

export const safetyLimiter = rateLimit({
  windowMs: 3600000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? "unauthenticated",
  handler: (_req, res) =>
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.TOO_MANY_REQUESTS,
      "RATE_LIMITED",
      { reason: "RATE_LIMITED" },
    ),
});
export const safetyIpLimiter = rateLimit({
  windowMs: 3600000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.TOO_MANY_REQUESTS,
      "RATE_LIMITED",
      { reason: "RATE_LIMITED" },
    ),
});
export async function requireContributor(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.auth?.user.contentRestrictedAt) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      "CONTENT_RESTRICTED",
      { reason: "CONTENT_RESTRICTED" },
    );
  }
  next();
}
export function personalizedHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
  next();
}
