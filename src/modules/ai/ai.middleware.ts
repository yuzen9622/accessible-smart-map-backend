import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createRateLimiter } from "../../middleware/rate-limit";

const BURST_WINDOW_MS = 10 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

// The backstop layer runs on the process-local memory store, so it keeps
// counting when Redis is the thing that broke. Its allowance is deliberately
// looser than the real burst limit: it is a spend ceiling, not the policy.
const BACKSTOP_MULTIPLIER = 3;

const CHAT_ANON_BURST = 10;
const CHAT_ANON_DAILY = 60;
const CHAT_USER_BURST = 40;
const CHAT_USER_DAILY = 400;

const INTENT_ANON_BURST = 30;
const INTENT_ANON_DAILY = 200;
const INTENT_USER_BURST = 60;
const INTENT_USER_DAILY = 600;

const REVIEW_SUMMARY_BURST = 20;
const REVIEW_SUMMARY_DAILY = 200;

/**
 * Routes a request to the limiter matching its identity.
 *
 * Anonymous and authenticated callers must never share a bucket: they are
 * keyed differently and have different allowances, so one identity's traffic
 * would otherwise eat the other's quota.
 *
 * @param anonymous Limiter applied when the request carries no identity.
 * @param authenticated Limiter applied once `optionalAuth` injected `req.auth`.
 * @returns A middleware delegating to exactly one of the two limiters.
 */
function byIdentity(
  anonymous: RequestHandler,
  authenticated: RequestHandler,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    req.auth?.userId
      ? authenticated(req, res, next)
      : anonymous(req, res, next);
}

/**
 * Builds the backstop / burst / daily trio for one endpoint and one identity.
 *
 * @param prefix Redis key prefix shared by the trio, suffixed per layer.
 * @param burst Requests allowed per 10-minute window.
 * @param daily Requests allowed per 24-hour window.
 * @param keyBy Whether the bucket is keyed by IP or by user id.
 * @returns The three limiters in mount order.
 */
function buildTiers(
  prefix: string,
  burst: number,
  daily: number,
  keyBy: "ip" | "userOrIp",
): RequestHandler[] {
  return [
    createRateLimiter({
      prefix: `${prefix}backstop:`,
      windowMs: BURST_WINDOW_MS,
      limit: burst * BACKSTOP_MULTIPLIER,
      keyBy,
      inMemory: true,
    }),
    createRateLimiter({
      prefix: `${prefix}burst:`,
      windowMs: BURST_WINDOW_MS,
      limit: burst,
      keyBy,
    }),
    createRateLimiter({
      prefix: `${prefix}daily:`,
      windowMs: DAILY_WINDOW_MS,
      limit: daily,
      keyBy,
    }),
  ];
}

/**
 * Interleaves an anonymous and an authenticated tier stack layer by layer, so
 * the mount order stays backstop → burst → daily for both identities.
 *
 * @param prefix Redis key prefix root for the endpoint.
 * @param anonBurst Anonymous requests per 10-minute window.
 * @param anonDaily Anonymous requests per 24-hour window.
 * @param userBurst Authenticated requests per 10-minute window.
 * @param userDaily Authenticated requests per 24-hour window.
 * @returns The three identity-aware limiters in mount order.
 */
function buildIdentityTiers(
  prefix: string,
  anonBurst: number,
  anonDaily: number,
  userBurst: number,
  userDaily: number,
): RequestHandler[] {
  const anonymous = buildTiers(`${prefix}anon:`, anonBurst, anonDaily, "ip");
  const authenticated = buildTiers(
    `${prefix}user:`,
    userBurst,
    userDaily,
    "userOrIp",
  );
  return anonymous.map((layer, index) =>
    byIdentity(layer, authenticated[index]),
  );
}

/** Tiered limiters for POST /api/v1/ai/chat. */
export const aiChatRateLimit = buildIdentityTiers(
  "ai-chat-rl:",
  CHAT_ANON_BURST,
  CHAT_ANON_DAILY,
  CHAT_USER_BURST,
  CHAT_USER_DAILY,
);

/**
 * Tiered limiters shared by POST /api/v1/ai/intent and /api/v1/ai/explain.
 * The two endpoints deliberately draw on one allowance: they are the same
 * one-shot model call from a quota point of view.
 */
export const aiIntentRateLimit = buildIdentityTiers(
  "ai-intent-rl:",
  INTENT_ANON_BURST,
  INTENT_ANON_DAILY,
  INTENT_USER_BURST,
  INTENT_USER_DAILY,
);

/**
 * Tiered limiters for GET /api/v1/a11y/reviews/summary. Keyed by IP for every
 * caller: the endpoint takes no identity, so there is no user bucket to split.
 */
export const reviewSummaryRateLimit = buildTiers(
  "review-summary-rl:",
  REVIEW_SUMMARY_BURST,
  REVIEW_SUMMARY_DAILY,
  "ip",
);
