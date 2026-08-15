import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { ENV_MSG, ERROR_MESSAGE } from "../../constants/messages";
import * as service from "./environment.service";

/**
 * Handles `GET /a11y/environment`: aggregates weather, air quality and nearby
 * CCTV for the validated coordinate, reporting how many sources degraded.
 */
export async function getEnvironmentInfo(req: Request, res: Response) {
  try {
    const { lat, lng, radius } = req.validated?.query as {
      lat: number;
      lng: number;
      radius: number;
    };

    const data = await service.getEnvironmentInfo(lat, lng, radius);

    const unavailableCount = [
      data.weather,
      data.airQuality,
      data.nearbyCctv,
    ].filter((block) => block.status === "unavailable").length;
    const message =
      unavailableCount === 0 ? ENV_MSG.OK : ENV_MSG.partial(unavailableCount);

    return sendResponse(res, true, "success", ResponseCode.OK, message, data);
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
