import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { DEFAULT_LANG } from "../../types/lang";
import type { NavInstructionsInput } from "./nav-instructions.types";
import { NAV_API_MSG } from "../../constants/messages";
import { generateNavInstructionsFromInput } from "./nav-instructions.service";

export async function navInstructions(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  const {
    routeToken,
    userHeading,
    language = DEFAULT_LANG,
  } = req.validated?.body as NavInstructionsInput;
  try {
    const result = await generateNavInstructionsFromInput({
      routeToken,
      userHeading,
      language,
    });

    if (!result.ok) {
      return sendResponse(res, false, "error", result.status, result.message, {
        reason: result.reason,
      });
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      NAV_API_MSG[language].OK(result.data.totalSteps),
      result.data,
    );
  } catch (error: any) {
    console.error("[nav-instructions]", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      NAV_API_MSG[language].INTERNAL,
    );
  }
}
