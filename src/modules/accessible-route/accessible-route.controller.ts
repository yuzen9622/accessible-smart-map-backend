import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { authenticateToken } from "../../config/auth";
import { planAccessibleRouteForHttp } from "./accessible-route.service";
import { ApiResponse } from "../../types/response";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";

/**
 * Resolves the caller's identity from an optional Bearer token so a logged-in
 * user's saved accessibility profile can fill in unset routing preferences.
 * Route planning itself never requires login; a missing header is anonymous,
 * but a present-and-broken token is still rejected rather than silently
 * ignored, matching how `/ai/chat` treats optional auth.
 */
async function resolveOptionalUserId(
  req: Request,
): Promise<{ userId?: string; expired: boolean; invalid: boolean }> {
  const authHeader = req.headers.authorization;
  if (!authHeader) return { expired: false, invalid: false };
  const token = authHeader.split(" ")[1];
  if (!token) return { expired: false, invalid: false };
  const result = await authenticateToken(token);
  if (!result.ok) return { expired: result.expired, invalid: !result.expired };
  return { userId: result.userId, expired: false, invalid: false };
}

export async function accessibleRoute(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const auth = await resolveOptionalUserId(req);
    if (auth.expired) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.UNAUTHORIZED,
        ResponseMessage.UNAUTHORIZED,
      );
    }
    if (auth.invalid) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN,
      );
    }

    const result = await planAccessibleRouteForHttp({
      ...req.body,
      userId: auth.userId,
    });

    if (!result.ok) {
      return sendResponse(
        res,
        false,
        "error",
        result.status,
        result.error,
        result.data,
      );
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      MSG.OK,
      result.data,
    );
  } catch (error: any) {
    console.error("[accessible-route]", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL,
    );
  }
}
