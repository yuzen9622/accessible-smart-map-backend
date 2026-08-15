import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseMessage, ResponseCode } from "../../types/code";
import { MSG } from "../../constants/messages";
import { ApiResponse } from "../../types/response";
import { parseRouteIntent, generateRouteExplanation } from "./ai.service";
import type { RouteIntent, RouteExplanation } from "../../types/ai";
import type { AccessibilityMode } from "../../types/route";

/**
 * POST /api/v1/ai/explain — AccessibleRoute → RouteExplanation.
 *
 * @param req Express request carrying the route, mode and language
 * @param res Express response for the RouteExplanation
 * @returns The sent ApiResponse
 */
export async function aiExplain(
  req: Request,
  res: Response<ApiResponse<RouteExplanation>>,
) {
  try {
    const { route, mode, language } = req.body as {
      route: Record<string, any>;
      mode?: AccessibilityMode;
      language?: "zh-TW" | "en";
    };
    const explanation = await generateRouteExplanation(
      route,
      mode ?? "normal",
      language ?? "zh-TW",
    );

    if (!explanation) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INTERNAL_ERROR,
        "路線說明生成失敗，請稍後再試",
      );
    }
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      MSG.OK,
      explanation,
    );
  } catch (error) {
    console.error("[ai/explain]", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

/**
 * POST /api/v1/ai/intent — natural language → RouteIntent.
 *
 * @param req Express request carrying the natural-language query
 * @param res Express response for the RouteIntent
 * @returns The sent ApiResponse
 */
export async function aiIntent(
  req: Request,
  res: Response<ApiResponse<RouteIntent>>,
) {
  try {
    const { query } = req.body as { query: string };
    const intent = await parseRouteIntent(query);

    if (!intent) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        "無法解析您的查詢，請改用『從 A 到 B』的描述方式",
      );
    }

    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, intent);
  } catch (error) {
    console.error("[ai/intent]", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}
