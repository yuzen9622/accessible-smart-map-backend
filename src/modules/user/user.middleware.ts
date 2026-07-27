import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { AUTH_MSG } from "../../constants/messages";
import { redisClient } from "../../config/redis";

function makeStore(prefix: string) {
  const client = redisClient;
  if (!client) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) =>
      client.call(...(args as [string, ...string[]])) as Promise<never>,
  });
}

function makeLimiter(prefix: string, limit: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(prefix),
    handler: (_req: Request, res: Response) =>
      sendResponse(res, false, "error", ResponseCode.TOO_MANY_REQUESTS, AUTH_MSG.RATE_LIMITED),
  });
}

export const loginLimiter = makeLimiter("auth-login-rl:", 10, 15 * 60 * 1000);
export const registerLimiter = makeLimiter("auth-register-rl:", 5, 60 * 60 * 1000);
export const resendLimiter = makeLimiter("auth-resend-rl:", 3, 60 * 60 * 1000);
export const forgotLimiter = makeLimiter("auth-forgot-rl:", 3, 60 * 60 * 1000);
export const passwordLimiter = makeLimiter("auth-password-rl:", 10, 60 * 60 * 1000);
