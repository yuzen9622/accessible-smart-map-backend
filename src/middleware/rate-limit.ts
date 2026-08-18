import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { sendResponse } from "../config/lib";
import { ResponseCode } from "../types/code";
import { AUTH_MSG } from "../constants/messages";
import { redisClient, redisReady } from "../config/redis";

export type RateLimitKeyBy = "ip" | "userOrIp";

export interface RateLimiterOptions {
  /** Redis key prefix; also identifies the limiter in store-error logs. */
  prefix: string;
  /** Length of the window in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per window. */
  limit: number;
  /** Whether the bucket is keyed by client IP or by user id with an IP fallback. */
  keyBy: RateLimitKeyBy;
  /**
   * Forces the built-in in-memory store even when Redis is configured. Used for
   * the per-process backstop layer, which has to keep counting when Redis is
   * the thing that failed.
   */
  inMemory?: boolean;
}

/**
 * Wraps a store so every failure is reported before it is swallowed.
 *
 * `passOnStoreError` lets the request through on a store failure, which means
 * a broken Redis would otherwise degrade rate limiting completely silently —
 * the one failure mode nobody would notice until the bill arrives.
 *
 * @param store The store to delegate to.
 * @param prefix Key prefix identifying the limiter in the log line.
 * @returns A store with identical behaviour plus error logging.
 */
function withErrorLogging(store: Store, prefix: string): Store {
  const report = (err: unknown) =>
    console.error("[ratelimit] store error", { prefix, err });
  return {
    localKeys: store.localKeys,
    prefix: store.prefix,
    init: (options) => {
      const result = store.init?.(options);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          report(err);
          throw err;
        });
      }
      return result;
    },
    get: (key) => store.get?.(key),
    increment: async (key) => {
      try {
        return await store.increment(key);
      } catch (err) {
        report(err);
        throw err;
      }
    },
    decrement: (key) => store.decrement(key),
    resetKey: (key) => store.resetKey(key),
    resetAll: () => store.resetAll?.(),
    shutdown: () => store.shutdown?.(),
  };
}

/**
 * Builds the Redis-backed store, or undefined when Redis is not configured.
 *
 * Returning undefined makes express-rate-limit fall back to its built-in
 * in-memory store, so a deployment without Redis is still rate limited — just
 * per process instead of across instances.
 *
 * @param prefix Redis key prefix isolating this limiter's buckets.
 * @returns The store, or undefined to use the built-in memory store.
 */
function makeStore(prefix: string): Store | undefined {
  const client = redisClient;
  if (!client) return undefined;
  const store = new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      // rate-limit-redis loads its LUA scripts as soon as the limiter is
      // constructed (module load), racing the lazy client's async connect;
      // waiting for readiness lets the store initialize once instead of
      // failing open forever.
      await redisReady();
      return client.call(...(args as [string, ...string[]])) as Promise<never>;
    },
  });
  return withErrorLogging(store, prefix);
}

/**
 * Builds the bucket key for a request.
 *
 * IP keys must go through the package's `ipKeyGenerator` helper: it collapses
 * an IPv6 address to its /56 subnet, without which a single IPv6 client can
 * walk through addresses to get a fresh bucket per request.
 *
 * @param keyBy Whether to key by IP only, or by user id when authenticated.
 * @returns The key generator passed to express-rate-limit.
 */
function makeKeyGenerator(keyBy: RateLimitKeyBy) {
  if (keyBy === "ip") return (req: Request) => ipKeyGenerator(req.ip ?? "");
  return (req: Request) => {
    const userId = req.auth?.userId;
    return userId ? `u:${userId}` : ipKeyGenerator(req.ip ?? "");
  };
}

/**
 * Creates a rate limiter that answers through the shared response envelope.
 *
 * `passOnStoreError` is always on: with it off express-rate-limit rethrows the
 * store error instead of calling the handler, so an unreachable Redis turns
 * every request into a 500. Letting the request through instead costs us
 * distributed rate limiting, and the in-memory backstop layer keeps a spend
 * ceiling on each process.
 *
 * @param options Bucket prefix, window, limit and keying strategy.
 * @returns The configured rate limit middleware.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { prefix, windowMs, limit, keyBy, inMemory = false } = options;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: inMemory ? undefined : makeStore(prefix),
    passOnStoreError: true,
    keyGenerator: makeKeyGenerator(keyBy),
    handler: (_req: Request, res: Response) =>
      sendResponse(
        res,
        false,
        "error",
        ResponseCode.TOO_MANY_REQUESTS,
        AUTH_MSG.RATE_LIMITED,
      ),
  });
}
