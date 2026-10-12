import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { apiErrorMessage, type ApiErrorData } from "../../constants/api-errors";
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
  res: Response<ApiResponse<RouteExplanation | ApiErrorData>>,
) {
  try {
    const { route, mode, language } = req.body as {
      route: Record<string, unknown>;
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
        apiErrorMessage("AI_EXPLANATION_FAILED", language),
        { reason: "AI_EXPLANATION_FAILED" },
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
      apiErrorMessage("AI_REQUEST_FAILED", req.body.language),
      { reason: "AI_REQUEST_FAILED" },
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
  res: Response<ApiResponse<RouteIntent | ApiErrorData>>,
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
        apiErrorMessage("AI_INTENT_UNRESOLVED"),
        { reason: "AI_INTENT_UNRESOLVED" },
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
      apiErrorMessage("AI_REQUEST_FAILED"),
      { reason: "AI_REQUEST_FAILED" },
    );
  }
}
