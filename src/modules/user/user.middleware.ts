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

/**
 * Builds a rate limiter backed by Redis when available.
 *
 * `passOnStoreError` lets the request through when the store cannot be reached,
 * matching the graceful degradation the Redis client is built for: an
 * unreachable Redis must cost us rate limiting, not the ability to log in.
 * Without it express-rate-limit rethrows the store error and auth answers 500.
 *
 * @param prefix Redis key prefix isolating this limiter's buckets.
 * @param limit Maximum requests allowed per window.
 * @param windowMs Length of the window in milliseconds.
 * @returns The configured rate limit middleware.
 */
function makeLimiter(
  prefix: string,
  limit: number,
  windowMs: number,
  passOnStoreError = true,
) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(prefix),
    passOnStoreError,
    handler: (_req: Request, res: Response) =>
      sendResponse(res, false, "error", ResponseCode.TOO_MANY_REQUESTS, AUTH_MSG.RATE_LIMITED),
  });
}

export const loginLimiter = makeLimiter("auth-login-rl:", 10, 15 * 60 * 1000);
export const registerLimiter = makeLimiter("auth-register-rl:", 5, 60 * 60 * 1000);
export const resendLimiter = makeLimiter("auth-resend-rl:", 3, 60 * 60 * 1000);
export const forgotLimiter = makeLimiter("auth-forgot-rl:", 3, 60 * 60 * 1000);
// Password verification performs bcrypt before token lookup; fail closed on a
// configured Redis store outage so attackers cannot bypass this CPU guard.
export const resetLimiter = makeLimiter("auth-reset-rl:", 10, 60 * 60 * 1000, false);
export const passwordLimiter = makeLimiter("auth-password-rl:", 10, 60 * 60 * 1000);
