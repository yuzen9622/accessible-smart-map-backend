import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE, CAMPUS_MSG } from "../../constants/messages";
import { CAMPUS_FAC_TYPES } from "./campus.fac-type";
import * as service from "./campus.service";
import type { CampusSort } from "./campus.service";

/** GET /a11y/campus/facility-types — canonical facility-type registry. */
export async function listFacilityTypes(_req: Request, res: Response) {
  return sendResponse(
    res,
    true,
    "success",
    ResponseCode.OK,
    MSG.OK,
    CAMPUS_FAC_TYPES,
  );
}

/** GET /a11y/campus/nearby — campus summaries within radius of the coordinate. */
export async function nearbyCampus(req: Request, res: Response) {
  try {
    const { lat, lng, radius, type } = req.validated?.query as {
      lat: number;
      lng: number;
      radius: number;
      type?: string;
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

/** GET /a11y/campus/schools — paginated school-level directory. */
export async function listSchools(req: Request, res: Response) {
  try {
    const { city, keyword, page, limit } = req.validated?.query as {
      city?: string;
      keyword?: string;
      page: number;
      limit: number;
    };
    const result = await service.listSchools({ city, keyword, page, limit });
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

/** GET /a11y/campus — paginated campus directory, optionally filtered. */
export async function listCampus(req: Request, res: Response) {
  try {
    const { city, type, keyword, schoolId, sort, page, limit } = req.validated
      ?.query as {
      city?: string;
      type?: string;
      keyword?: string;
      schoolId?: number;
      sort?: CampusSort;
      page: number;
      limit: number;
    };
    const result = await service.findAll({
      city,
      type,
      keyword,
      schoolId,
      sort,
      page,
      limit,
    });
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

/** GET /a11y/campus/:campusId — single campus detail with full facilities. */
export async function getCampusByCampusId(req: Request, res: Response) {
  try {
    const { campusId } = req.validated?.params as { campusId: number };
    const result = await service.findByCampusId(campusId);
    if (!result) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        CAMPUS_MSG.NOT_FOUND,
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
