import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import { IVisualA11y } from "../../types";
import * as service from "./visual-a11y.service";

export async function getNearbyVisualA11y(req: Request, res: Response) {
  try {
    const { lat, lng, radius, type } = req.validated?.query as {
      lat: number;
      lng: number;
      radius: number;
      type?: IVisualA11y["type"];
    };
    const result = await service.findNearby(lat, lng, radius, type);
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

export async function syncVisualA11y(_req: Request, res: Response) {
  try {
    const result = await service.syncFromOverpass();
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
