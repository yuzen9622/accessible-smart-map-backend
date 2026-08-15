import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import * as service from "./welfare.service";

/** GET /a11y/welfare/nearby — institutions within radius of the coordinate. */
export async function nearbyWelfare(req: Request, res: Response) {
  try {
    const { lat, lng, radius } = req.validated?.query as {
      lat: number;
      lng: number;
      radius: number;
    };
    const result = await service.findNearby(lat, lng, radius);
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

/** GET /a11y/welfare — directory, optionally filtered by county / type. */
export async function listWelfare(req: Request, res: Response) {
  try {
    const { county, type } = req.validated?.query as {
      county?: string;
      type?: string;
    };
    const result = await service.findAll({ county, type });
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

/** GET /a11y/welfare/:id — single institution detail. */
export async function getWelfareById(req: Request, res: Response) {
  try {
    const { id } = req.validated?.params as { id: string };
    const result = await service.findById(id);
    if (!result) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        "查無此機構",
      );
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}
