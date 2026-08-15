import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE, TRANSIT_MSG } from "../../constants/messages";
import type { ApiResponse } from "../../types/response";
import type { Response, Request } from "express";
import type { TaiwanCityEn } from "../../types/transit";
import * as busService from "./bus.service";
import * as alertService from "./alert.service";

async function resolveCityOr400(
  city: string | undefined,
  res: Response<ApiResponse<any>>,
): Promise<TaiwanCityEn | "InterCity" | null> {
  if (city === "InterCity") return "InterCity";
  const resolved = await busService.resolveBusCity(city);
  if (!resolved) {
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      TRANSIT_MSG.INVALID_CITY,
    );
    return null;
  }
  return resolved;
}

async function getBusRouteHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { routeName, city } = req.validated?.query as {
      routeName: string;
      city?: string;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusRouteInfo({
      routeName,
      city: resolved,
    });
    if (!result.ok)
      return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getBusRouteDetailHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { routeName, city } = req.validated?.query as {
      routeName: string;
      city?: string;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusRouteDetail({
      routeName,
      city: resolved,
    });
    if (!result.ok)
      return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getBusArrivalHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { routeName, stopName, city, direction } = req.validated?.query as {
      routeName: string;
      stopName: string;
      city?: string;
      direction?: number;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusArrivalAtStop({
      routeName,
      stopName,
      city: resolved,
      direction,
    });
    if (!result.ok)
      return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getBusTimetableHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { routeName, city } = req.validated?.query as {
      routeName: string;
      city?: string;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusTimetable({
      routeName,
      city: resolved,
    });
    if (!result.ok)
      return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getBusPositionsHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { routeName, city, direction } = req.validated?.query as {
      routeName: string;
      city?: string;
      direction?: number;
    };
    const resolved = await resolveCityOr400(city, res);
    if (!resolved) return;
    const result = await busService.getBusRealtimeOnRoute({
      routeName,
      city: resolved,
      direction,
    });
    if (!result.ok)
      return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getTransitAlertsHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const ctx = req.validated?.query as alertService.TransitContext;
    const result = await alertService.getTransitAlerts(ctx);
    if (!result.ok)
      return sendResponse(res, false, "error", result.status, result.error);
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getTrainData(req: Request, res: Response<ApiResponse<null>>) {
  const { arrival_stop, departure_stop, train_no } = req.query;
}
async function getHighSpeedTrainData(
  req: Request,
  res: Response<ApiResponse<null>>,
) {
  const { type, detail } = req.query;
}

async function searchBusRoutesHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { keyword } = req.validated?.query as { keyword: string };
    const result = await busService.searchBusRoutes(keyword);
    if (!result.ok) {
      return sendResponse(
        res,
        false,
        "error",
        result.status || ResponseCode.INTERNAL_ERROR,
        result.error,
      );
    }
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function searchBusStopsHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { keyword } = req.validated?.query as { keyword: string };
    const result = await busService.searchBusStops(keyword);
    if (!result.ok) {
      return sendResponse(
        res,
        false,
        "error",
        result.status || ResponseCode.INTERNAL_ERROR,
        result.error,
      );
    }
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

async function getNearbyStopsHandler(
  req: Request,
  res: Response<ApiResponse<any>>,
) {
  try {
    const { lat, lng, radius, limit } = req.validated?.query as {
      lat: number;
      lng: number;
      radius: number;
      limit: number;
    };
    const result = await busService.getNearbyStops({ lat, lng, radius, limit });
    if (!result.ok) {
      return sendResponse(
        res,
        false,
        "error",
        result.status || ResponseCode.INTERNAL_ERROR,
        result.error,
      );
    }
    const { ok, ...data } = result;
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch (error: any) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      error.message,
    );
  }
}

export {
  getTrainData,
  getHighSpeedTrainData,
  getBusRouteHandler,
  getBusRouteDetailHandler,
  getBusArrivalHandler,
  getBusTimetableHandler,
  getBusPositionsHandler,
  searchBusRoutesHandler,
  searchBusStopsHandler,
  getNearbyStopsHandler,
  getTransitAlertsHandler,
};
