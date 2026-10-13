import type { NextFunction, Request, Response } from "express";
import { createRateLimiter } from "../../middleware/rate-limit";

/**
 * Headers for responses that carry a live location: never cached by browsers
 * or CDNs, never indexed, and never leaking the page URL as a Referer.
 */
export function trackingHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/**
 * Public tracking reads, per IP. The web tracker polls every 10 s, so this
 * leaves room for several viewers behind one NAT while capping link scraping.
 */
export const publicTrackingLimiter = createRateLimiter({
  prefix: "sos-public-rl:",
  windowMs: 60 * 1000,
  limit: 60,
  keyBy: "ip",
});
