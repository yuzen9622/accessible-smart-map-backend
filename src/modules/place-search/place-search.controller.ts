import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { MSG } from "../../constants/messages";
import { apiErrorMessage, type ApiErrorData } from "../../constants/api-errors";
import * as placeSearchService from "./place-search.service";
import type { AutocompleteItem, PlaceResult } from "./place-search.service";
import type { PlaceSource } from "./place-search.types";
import { normalizeLang } from "../../types/lang";

function requestLanguage(req: Request) {
  const { lang } = (req.validated?.query ?? {}) as { lang?: string };
  return lang === undefined ? undefined : normalizeLang(lang);
}

/** Parses a validated coordinate string into a number, or undefined when absent. */
function toNum(value?: string): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** Splits the validated `sources` CSV into the source list, or undefined for all. */
function toSources(value?: string): PlaceSource[] | undefined {
  return value === undefined ? undefined : (value.split(",") as PlaceSource[]);
}

async function autocomplete(
  req: Request,
  res: Response<ApiResponse<AutocompleteItem[] | ApiErrorData>>,
) {
  try {
    const { q, sessiontoken, lat, lng, sources, limit, lang } = (req.validated
      ?.query ?? {}) as {
      q: string;
      sessiontoken?: string;
      lat?: string;
      lng?: string;
      sources?: string;
      limit?: number;
      lang?: string;
    };
    const data = await placeSearchService.autocomplete({
      q,
      sessionToken: sessiontoken,
      lat: toNum(lat),
      lng: toNum(lng),
      sources: toSources(sources),
      limit,
      lang: normalizeLang(lang),
    });
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      apiErrorMessage("PLACE_SEARCH_FAILED", requestLanguage(req)),
      { reason: "PLACE_SEARCH_FAILED" },
    );
  }
}

async function details(
  req: Request,
  res: Response<ApiResponse<PlaceResult | ApiErrorData>>,
) {
  try {
    const { id } = (req.validated?.params ?? {}) as { id: string };
    const { sessiontoken, lat, lng, lang } = (req.validated?.query ?? {}) as {
      sessiontoken?: string;
      lat?: string;
      lng?: string;
      lang?: string;
    };
    const resolvedLang = normalizeLang(lang);
    const data = await placeSearchService.details({
      id,
      sessionToken: sessiontoken,
      lat: toNum(lat),
      lng: toNum(lng),
      lang: lang === undefined ? undefined : resolvedLang,
    });
    if (!data) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        apiErrorMessage("PLACE_NOT_FOUND", resolvedLang),
        { reason: "PLACE_NOT_FOUND" },
      );
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      apiErrorMessage("PLACE_SEARCH_FAILED", requestLanguage(req)),
      { reason: "PLACE_SEARCH_FAILED" },
    );
  }
}

export { autocomplete, details };
