import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { HAZARD_MSG, HAZARD_REASON } from "../../constants/messages";
import { redisClient } from "../../config/redis";

const MAX_PHOTO_MB = Number(process.env.HAZARD_PHOTO_MAX_SIZE_MB ?? 10);

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: MAX_PHOTO_MB * 1024 * 1024,
		files: 1,
		// Cap multipart text fields so an attacker cannot exhaust memory with
		// thousands of form fields before the Zod schema ever runs (multer
		// defaults: unlimited fields, 1MB per field).
		fields: 10,
		fieldSize: 64 * 1024,
		parts: 12,
	},
	fileFilter: (_req, file, cb) => {
		if (file.mimetype === "image/jpeg" || file.mimetype === "image/png") {
			cb(null, true);
		} else {
			cb(new Error(HAZARD_REASON.INVALID_PHOTO_TYPE));
		}
	},
});

const singlePhoto = upload.single("photo");

/**
 * Parses the `photo` field of a multipart/form-data request into `req.file`,
 * translating Multer size/type rejections into the feature's envelope reasons.
 *
 * @param req Express request.
 * @param res Express response.
 * @param next Next handler, called once the photo is parsed.
 */
export function uploadPhoto(req: Request, res: Response, next: NextFunction) {
	singlePhoto(req, res, (err: unknown) => {
		if (err instanceof multer.MulterError) {
			if (err.code === "LIMIT_FILE_SIZE") {
				return sendResponse(
					res,
					false,
					"error",
					ResponseCode.INVALID_INPUT,
					HAZARD_MSG.PHOTO_TOO_LARGE,
					{ reason: HAZARD_REASON.PHOTO_TOO_LARGE },
				);
			}
			return sendResponse(
				res,
				false,
				"error",
				ResponseCode.INVALID_INPUT,
				HAZARD_MSG.INVALID_PHOTO_TYPE,
				{ reason: HAZARD_REASON.INVALID_PHOTO_TYPE },
			);
		}
		if (err) {
			return sendResponse(
				res,
				false,
				"error",
				ResponseCode.INVALID_INPUT,
				HAZARD_MSG.INVALID_PHOTO_TYPE,
				{ reason: HAZARD_REASON.INVALID_PHOTO_TYPE },
			);
		}
		next();
	});
}

function makeStore() {
	const client = redisClient;
	if (!client) return undefined;
	return new RedisStore({
		prefix: "hazard-rl:",
		sendCommand: (...args: string[]) =>
			client.call(...(args as [string, ...string[]])) as Promise<never>,
	});
}

/**
 * Builds a rate limiter backed by Redis when available.
 *
 * `passOnStoreError` lets the request through when the store cannot be reached,
 * matching the graceful degradation the Redis client is built for: an
 * unreachable Redis must cost us rate limiting, not the ability to file a hazard
 * report. Without it express-rate-limit rethrows the store error as a 500.
 *
 * @param limit Maximum requests allowed per window.
 * @param windowMs Length of the window in milliseconds.
 * @returns The configured rate limit middleware.
 */
function makeLimiter(limit: number, windowMs: number) {
	return rateLimit({
		windowMs,
		limit,
		standardHeaders: true,
		legacyHeaders: false,
		store: makeStore(),
		passOnStoreError: true,
		handler: (_req: Request, res: Response) =>
			sendResponse(
				res,
				false,
				"error",
				ResponseCode.TOO_MANY_REQUESTS,
				HAZARD_MSG.RATE_LIMITED,
				{ reason: HAZARD_REASON.RATE_LIMITED },
			),
	});
}

export const postReportsLimiter = makeLimiter(3, 10 * 60 * 1000);
export const confirmLimiter = makeLimiter(10, 60 * 1000);
export const nearbyLimiter = makeLimiter(30, 60 * 1000);
