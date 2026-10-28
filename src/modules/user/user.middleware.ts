import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { sendResponse } from "../../config/lib";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { AUTH_MSG, AVATAR_MSG, ERROR_MESSAGE } from "../../constants/messages";
import { redisClient, redisReady } from "../../config/redis";
import { MobileRefreshBodySchema, WebRefreshBodySchema } from "./user.schema";

function makeStore(prefix: string) {
  const client = redisClient;
  if (!client) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      // RedisStore issues its SCRIPT LOAD at construction (module load),
      // racing the lazy client's async connect; wait for readiness so the
      // store initializes once instead of failing open forever.
      await redisReady();
      return client.call(...(args as [string, ...string[]])) as Promise<never>;
    },
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
      sendResponse(
        res,
        false,
        "error",
        ResponseCode.TOO_MANY_REQUESTS,
        AUTH_MSG.RATE_LIMITED,
      ),
  });
}

export const loginLimiter = makeLimiter("auth-login-rl:", 10, 15 * 60 * 1000);
export const registerLimiter = makeLimiter(
  "auth-register-rl:",
  5,
  60 * 60 * 1000,
);
export const resendLimiter = makeLimiter("auth-resend-rl:", 3, 60 * 60 * 1000);
export const forgotLimiter = makeLimiter("auth-forgot-rl:", 3, 60 * 60 * 1000);
// Password verification performs bcrypt before token lookup; fail closed on a
// configured Redis store outage so attackers cannot bypass this CPU guard.
export const resetLimiter = makeLimiter(
  "auth-reset-rl:",
  10,
  60 * 60 * 1000,
  false,
);
export const passwordLimiter = makeLimiter(
  "auth-password-rl:",
  10,
  60 * 60 * 1000,
);

export const refreshLimiter = makeLimiter(
  "auth-refresh-rl:",
  60,
  15 * 60 * 1000,
);

export const logoutLimiter = makeLimiter("auth-logout-rl:", 30, 15 * 60 * 1000);

export const avatarUploadLimiter = makeLimiter(
  "avatar-upload-rl:",
  20,
  60 * 60 * 1000,
);

export const avatarReadLimiter = makeLimiter(
  "avatar-read-rl:",
  300,
  15 * 60 * 1000,
);

const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const singleAvatar = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: AVATAR_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 0,
    parts: 1,
  },
}).single("avatar");

/**
 * Parses the `avatar` field of a multipart/form-data request into `req.file`.
 * The image type is checked from the bytes by the service, not the MIME here.
 */
export function uploadAvatarFile(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  singleAvatar(req, res, (err: unknown) => {
    if (!err) return next();
    const tooLarge =
      err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      tooLarge ? AVATAR_MSG.TOO_LARGE : AVATAR_MSG.INVALID,
      { reason: tooLarge ? "AVATAR_TOO_LARGE" : "AVATAR_INVALID" },
    );
  });
}

/**
 * Errors and rate-limit answers must never be cached; the controller marks
 * only a successful image as cacheable.
 */
export function avatarHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}

/**
 * Resolves the client transport mode from the X-Client header at the edge.
 * - Missing X-Client => 'web'
 * - Exact 'mobile' => 'mobile'
 * - Duplicate array or unknown values => 400
 */
export function resolveClientMode(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const clientHeader = req.headers["x-client"];
  if (clientHeader === undefined) {
    req.clientMode = "web";
    return next();
  }
  if (typeof clientHeader === "string" && clientHeader === "mobile") {
    req.clientMode = "mobile";
    return next();
  }
  return sendResponse(
    res,
    false,
    "error",
    ResponseCode.INVALID_INPUT,
    AUTH_MSG.INVALID_CLIENT_HEADER,
  );
}

/**
 * Protects all Web cookie writer endpoints (login, google, verify, reset, change, refresh, logout)
 * against CSRF.
 * - Exact allowed Origin, or when absent a valid allowlisted Referer;
 * - If both are missing or neither is allowlisted, rejects with 403 BEFORE any mutations.
 * - Mobile requests (X-Client: mobile) bypass this check as they do not use/set cookies.
 */
export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.clientMode === "mobile") {
    return next();
  }

  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer || req.headers.referrer;

  const configuredOrigins = process.env.CORS_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? ["http://localhost:3000"];

  const allowedOrigins = new Set(configuredOrigins);
  if (process.env.CANONICAL_API_ORIGIN) {
    allowedOrigins.add(
      process.env.CANONICAL_API_ORIGIN.trim().replace(/\/+$/, ""),
    );
  }

  if (typeof originHeader === "string") {
    if (allowedOrigins.has(originHeader)) {
      return next();
    }
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.FORBIDDEN,
      ResponseMessage.FORBIDDEN,
    );
  }

  if (typeof refererHeader === "string") {
    try {
      const refererOrigin = new URL(refererHeader).origin;
      if (allowedOrigins.has(refererOrigin)) {
        return next();
      }
    } catch {
      // Malformed Referer
    }
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.FORBIDDEN,
      ResponseMessage.FORBIDDEN,
    );
  }

  // Missing both Origin and Referer
  return sendResponse(
    res,
    false,
    "error",
    ResponseCode.FORBIDDEN,
    ResponseMessage.FORBIDDEN,
  );
}

/**
 * Enforces Cache-Control: no-store and Pragma: no-cache on auth responses,
 * including failures and validation errors.
 */
export function authCacheControl(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function hasRefreshTokenCookie(req: Request): boolean {
  if (
    req.cookies &&
    Object.prototype.hasOwnProperty.call(req.cookies, "refreshToken")
  ) {
    return true;
  }
  if (
    req.signedCookies &&
    Object.prototype.hasOwnProperty.call(req.signedCookies, "refreshToken")
  ) {
    return true;
  }
  const rawCookie = req.headers.cookie;
  if (
    typeof rawCookie === "string" &&
    /(?:^|;\s*)refreshToken(?:=|$)/.test(rawCookie)
  ) {
    return true;
  }
  return false;
}

/**
 * Validates request transport and body shape for /refresh.
 * - ANY Authorization header (including empty) => 400 immediately with zero DB writes.
 * - Mobile requires Content-Type: application/json, strict { refreshToken }, NO cookie key present.
 * - Web permits only cookie and empty body (no token in body).
 */
export function validateRefreshTransport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.headers.authorization !== undefined) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AUTH_MSG.UNSUPPORTED_AUTH_HEADER,
    );
  }

  if (req.clientMode === "mobile") {
    if (hasRefreshTokenCookie(req)) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        AUTH_MSG.MIXED_TOKEN_SOURCES,
      );
    }
    if (!req.is("application/json")) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ERROR_MESSAGE.BAD_REQUEST,
      );
    }
    const parse = MobileRefreshBodySchema.safeParse(req.body);
    if (!parse.success) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT,
      );
    }
    if (!req.validated) req.validated = {};
    req.validated.body = parse.data;
    return next();
  }

  // Web: reject if token in body
  if (
    req.body &&
    typeof req.body === "object" &&
    ("refreshToken" in req.body || "accessToken" in req.body)
  ) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AUTH_MSG.MIXED_TOKEN_SOURCES,
    );
  }
  const parse = WebRefreshBodySchema.safeParse(req.body ?? {});
  if (!parse.success) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AUTH_MSG.MIXED_TOKEN_SOURCES,
    );
  }
  if (!req.validated) req.validated = {};
  req.validated.body = parse.data;
  return next();
}

/**
 * Validates request transport and body shape for /logout.
 * - ANY Authorization header (including empty) => 400 immediately with zero DB writes.
 * - Mobile requires Content-Type: application/json, strict { refreshToken }, NO cookie key present.
 * - Web permits only cookie and empty body (no token in body).
 */
export function validateLogoutTransport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // FROZEN USER DECISION: reject ANY Authorization header on logout with 400 and zero DB writes
  if (req.headers.authorization !== undefined) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AUTH_MSG.UNSUPPORTED_AUTH_HEADER,
    );
  }

  if (req.clientMode === "mobile") {
    if (hasRefreshTokenCookie(req)) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        AUTH_MSG.MIXED_TOKEN_SOURCES,
      );
    }
    if (!req.is("application/json")) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ERROR_MESSAGE.BAD_REQUEST,
      );
    }
    const parse = MobileRefreshBodySchema.safeParse(req.body);
    if (!parse.success) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT,
      );
    }
    if (!req.validated) req.validated = {};
    req.validated.body = parse.data;
    return next();
  }

  // Web: reject if token in body
  if (
    req.body &&
    typeof req.body === "object" &&
    ("refreshToken" in req.body || "accessToken" in req.body)
  ) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AUTH_MSG.MIXED_TOKEN_SOURCES,
    );
  }
  const parse = WebRefreshBodySchema.safeParse(req.body ?? {});
  if (!parse.success) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AUTH_MSG.MIXED_TOKEN_SOURCES,
    );
  }
  if (!req.validated) req.validated = {};
  req.validated.body = parse.data;
  return next();
}
