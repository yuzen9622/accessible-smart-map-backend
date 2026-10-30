import { createHash } from "node:crypto";
import { normalizeLang, type SupportedLang } from "../../types/lang";
import type { Request, Response } from "express";
import type { ServiceCoverageConfig } from "../../config/coverage";
import { HTTP_CONFIG } from "../../config/http";
import { buildResponsePayload, sendResponse } from "../../config/lib";
import type { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import * as a11yService from "./a11y.service";
import * as a11yOrchestration from "./a11y.orchestration";
import type { A11yCategory, A11yFacility } from "./a11y.service";
import type { PlaceBounds } from "../../utils/place-extent";

// Every map open fetches this ~1 MB list. Rebuilding and re-serializing it per
// request saturated the event loop under load, so the encoded body is reused.
const allFacilitiesBodies = new Map<
  string,
  { expiresAt: number; body: Promise<{ json: string; etag: string }> }
>();

function allFacilitiesBody(
  category: A11yCategory[] | undefined,
  langArgs: [] | [SupportedLang],
) {
  const key = `${[...new Set(category ?? [])].sort().join(",")}|${langArgs[0] ?? ""}`;
  const hit = allFacilitiesBodies.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.body;
  const body = a11yOrchestration
    .findAllFacilities(category, ...langArgs)
    .then((data) => {
      const json = JSON.stringify(
        buildResponsePayload(true, "success", ResponseCode.OK, MSG.OK, data),
      );
      const hash = createHash("sha1").update(json).digest("base64url");
      return { json, etag: `W/"${hash}"` };
    });
  allFacilitiesBodies.set(key, {
    expiresAt: Date.now() + HTTP_CONFIG.facilityListCacheTtlMs,
    body,
  });
  body.catch(() => allFacilitiesBodies.delete(key));
  return body;
}

async function getAllFacilities(req: Request, res: Response) {
  try {
    const { category } = (req.validated?.query ?? {}) as {
      category?: A11yCategory[];
    };
    const { json, etag } = await allFacilitiesBody(
      category,
      readLanguageArgs(req),
    );
    res.status(ResponseCode.OK).type("json").set("ETag", etag).send(json);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

function getServiceCoverage(
  _req: Request,
  res: Response<ApiResponse<ServiceCoverageConfig>>,
) {
  try {
    const data = a11yService.getServiceCoverage();
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function getBathrooms(
  req: Request,
  res: Response<ApiResponse<A11yFacility[]>>,
) {
  try {
    const data = await a11yOrchestration.findBathroomFacilities(
      ...readLanguageArgs(req),
    );
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function getRamps(
  req: Request,
  res: Response<ApiResponse<A11yFacility[]>>,
) {
  try {
    const data = await a11yOrchestration.findRampFacilities(
      ...readLanguageArgs(req),
    );
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function getElevators(
  req: Request,
  res: Response<ApiResponse<A11yFacility[]>>,
) {
  try {
    const data = await a11yOrchestration.findElevatorFacilities(
      ...readLanguageArgs(req),
    );
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
  } catch {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function getA11yPlace(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const raw = String(req.query.osmId ?? "");
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        `${ERROR_MESSAGE.MISSING_PARAMS}：osmId`,
      );
    }
    const places = await a11yService.findByOsmIds(
      ids,
      ...readLanguageArgs(req),
    );
    if (!places.length) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        "查無此設施",
      );
    }
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, places);
  } catch (error) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      (error as string) || ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function nearbyA11y(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng, bbox } = req.validated!.query as {
      lat: string;
      lng: string;
      bbox?: PlaceBounds;
    };
    const result = await a11yOrchestration.findNearby(
      Number(lat),
      Number(lng),
      bbox ? { kind: "bbox", bounds: bbox } : undefined,
      ...readLanguageArgs(req),
    );
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      (error as string) || ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function nearbyParking(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng, radius, type } = (req.validated?.query ?? {}) as {
      lat: string;
      lng: string;
      radius?: string;
      type?: a11yService.ParkingKind | "all";
    };
    const result = await a11yService.findNearbyParking(
      Number(lat),
      Number(lng),
      radius != null ? Number(radius) : undefined,
      type,
      ...readLanguageArgs(req),
    );
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      (error as string) || ERROR_MESSAGE.INTERNAL,
    );
  }
}

async function quickAssess(req: Request, res: Response<ApiResponse<any>>) {
  try {
    const { lat, lng, mode, radius } = (req.validated?.query ?? {}) as {
      lat: string;
      lng: string;
      mode?: a11yService.QuickAssessMode;
      radius?: string;
    };
    const result = await a11yOrchestration.assessQuickAccess({
      lat: Number(lat),
      lng: Number(lng),
      mode,
      radiusM: radius != null ? Number(radius) : undefined,
    });
    return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
  } catch (error) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      (error as string) || ERROR_MESSAGE.INTERNAL,
    );
  }
}

export {
  getAllFacilities,
  getServiceCoverage,
  getBathrooms,
  getRamps,
  getElevators,
  nearbyA11y,
  nearbyParking,
  getA11yPlace,
  quickAssess,
};

function readLanguage(req: Request) {
  const lang = (req.validated?.query as { lang?: string } | undefined)?.lang;
  return lang === undefined ? undefined : normalizeLang(lang);
}

function readLanguageArgs(req: Request): [] | [SupportedLang] {
  const lang = readLanguage(req);
  return lang === undefined ? [] : [lang];
}
