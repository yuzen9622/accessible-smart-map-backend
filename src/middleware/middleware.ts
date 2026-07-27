import { type NextFunction, type Request, type Response } from "express";
import { sendResponse } from "../config/lib";
import { ResponseCode, ResponseMessage } from "../types/code";
import { authenticateToken } from "../config/auth";

const PUBLIC_ROUTES = [
  "/auth/google",
  "/auth/register",
  "/auth/login",
  "/auth/verify-email",
  "/auth/verify-email/resend",
  "/auth/password/forgot",
  "/auth/password/reset",
  "/refresh",
  "/logout",
];

const middleware = async (req: Request, res: Response, next: NextFunction) => {
  if (PUBLIC_ROUTES.includes(req.path)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  const result = await authenticateToken(token ?? "");

  if (!result.ok) {
    return sendResponse(
      res,
      false,
      "error",
      result.expired ? ResponseCode.UNAUTHORIZED : ResponseCode.FORBIDDEN,
      result.expired ? ResponseMessage.UNAUTHORIZED : ResponseMessage.FORBIDDEN
    );
  }

  req.auth = { userId: result.userId, user: result.user };

  next();
};
export default middleware;
