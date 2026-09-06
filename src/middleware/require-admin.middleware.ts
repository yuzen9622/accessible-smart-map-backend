import type { NextFunction, Request, Response } from "express";
import { sendResponse } from "../config/lib";
import { ResponseCode, ResponseMessage } from "../types/code";

/**
 * Gate placed after the JWT auth middleware; rejects any request whose
 * authenticated user is not role "admin".
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.user.role !== "admin") {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.FORBIDDEN,
      ResponseMessage.FORBIDDEN,
    );
  }
  next();
}

export default requireAdmin;
