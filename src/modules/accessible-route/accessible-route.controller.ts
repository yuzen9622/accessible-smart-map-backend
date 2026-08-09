import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { planAccessibleRouteForHttp } from "./accessible-route.service";
import { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";

export async function accessibleRoute(
  req: Request,
  res: Response<ApiResponse<any>>
) {
  try {
    const result = await planAccessibleRouteForHttp(req.body);

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

    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result.data);
  } catch (error: any) {
    console.error("[accessible-route]", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error?.message ?? ERROR_MESSAGE.INTERNAL
    );
  }
}
