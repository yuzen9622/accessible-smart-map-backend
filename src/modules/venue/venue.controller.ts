import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ERROR_MESSAGE, MSG, VENUE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { SupportedLang } from "../../types/lang";
import type { AccessibilityMode } from "../../types/route";
import * as service from "./venue.service";

const internalError = (res: Response, error: unknown) => {
  console.error(error);
  return sendResponse(
    res,
    false,
    "error",
    ResponseCode.INTERNAL_ERROR,
    ERROR_MESSAGE.INTERNAL,
  );
};

/** GET /a11y/venues — imported venue summaries. */
export async function listVenues(_req: Request, res: Response) {
  try {
    const venues = await service.listVenues();
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, venues);
  } catch (error) {
    return internalError(res, error);
  }
}

/** GET /a11y/venues/:venueId — buildings, levels, places and display geometry. */
export async function getVenue(req: Request, res: Response) {
  try {
    const { venueId } = req.validated?.params as { venueId: string };
    const venue = await service.getVenueDetail(venueId);
    if (!venue) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        VENUE_MSG.NOT_FOUND,
      );
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, venue);
  } catch (error) {
    return internalError(res, error);
  }
}

/** POST /a11y/venues/:venueId/route — accessible route between two places. */
export async function planVenueRoute(req: Request, res: Response) {
  try {
    const { venueId } = req.validated?.params as { venueId: string };
    const { fromPlaceId, toPlaceId, mode, language } = req.validated?.body as {
      fromPlaceId: string;
      toPlaceId: string;
      mode: AccessibilityMode;
      language: SupportedLang;
    };
    const result = await service.planVenueRoute({
      venueId,
      fromPlaceId,
      toPlaceId,
      mode,
      lang: language,
    });
    if (!result.ok) {
      return sendResponse(
        res,
        false,
        "error",
        result.status,
        result.error,
        "data" in result ? result.data : undefined,
      );
    }
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      MSG.OK,
      result.route,
    );
  } catch (error) {
    return internalError(res, error);
  }
}
