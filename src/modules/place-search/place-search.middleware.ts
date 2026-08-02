import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { redisClient } from "../../config/redis";

const RATE_LIMITED_MSG = "搜尋請求過於頻繁，請稍後再試";

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
 * unreachable Redis must cost us rate limiting, not the endpoint itself. Without
 * it express-rate-limit rethrows the store error and the route answers 500.
 *
 * @param prefix Redis key prefix isolating this limiter's buckets.
 * @param limit Maximum requests allowed per window.
 * @param windowMs Length of the window in milliseconds.
 * @returns The configured rate limit middleware.
 */
function makeLimiter(prefix: string, limit: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(prefix),
    passOnStoreError: true,
    handler: (_req: Request, res: Response) =>
      sendResponse(res, false, "error", ResponseCode.TOO_MANY_REQUESTS, RATE_LIMITED_MSG),
  });
}

export const autocompleteLimiter = makeLimiter("place-search-ac-rl:", 120, 60 * 1000);
export const detailsLimiter = makeLimiter("place-search-dt-rl:", 60, 60 * 1000);
