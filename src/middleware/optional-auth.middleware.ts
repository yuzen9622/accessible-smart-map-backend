import type { NextFunction, Request, Response } from "express";
import { sendResponse } from "../config/lib";
import { ResponseCode, ResponseMessage } from "../types/code";
import { authenticateToken } from "../config/auth";

/**
 * Authenticates a request only when it carries an Authorization header.
 *
 * Endpoints whose product contract is "usable anonymously" still have to tell
 * the two identities apart — rate limiters key on `req.auth.userId` — so this
 * gate lets a header-less request through untouched while a present but broken
 * token is rejected exactly like the fully protected routes. Silently
 * downgrading a stale session to anonymous would hide expired logins from the
 * client and hand the caller the anonymous quota instead of an error.
 *
 * @param req Incoming request; `req.auth` is populated on success.
 * @param res Response used to answer 401/403 when the token is unusable.
 * @param next Passes control on for anonymous and authenticated callers alike.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    next();
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    next();
    return;
  }

  const result = await authenticateToken(token);
  if (!result.ok) {
    sendResponse(
      res,
      false,
      "error",
      result.expired ? ResponseCode.UNAUTHORIZED : ResponseCode.FORBIDDEN,
      result.expired ? ResponseMessage.UNAUTHORIZED : ResponseMessage.FORBIDDEN,
    );
    return;
  }

  req.auth = { userId: result.userId, user: result.user };
  next();
}

export default optionalAuth;
