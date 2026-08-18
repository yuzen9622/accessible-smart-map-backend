import * as a11yService from "../a11y/a11y.service";
import * as a11yOrchestration from "../a11y/a11y.orchestration";
import * as busService from "../transit/bus.service";
import * as metroService from "../transit/metro.service";
import * as trainService from "../transit/train.service";
import * as alertService from "../transit/alert.service";
import * as airService from "../air/air.service";
import * as campusService from "../campus/campus.service";
import * as hazardService from "../hazard-report/hazard-report.service";
import { getEnvironmentInfo as fetchEnvironment } from "../environment/environment.service";
import type { GroundingChunk } from "@google/genai";
import { googleGenAi, model } from "../../config/ai";
import { getCoordinates, searchPlaces } from "../../adapters/google.adapter";
import { buildBindUrl } from "../../adapters/line.adapter";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { generateNavInstructions } from "../nav-instructions/nav-instructions.service";
import {
  getAuthorizedSessionForLineUser,
  acknowledgeSession,
  claimSession,
  updateHandlingStatus,
  resolveSession as resolveSosSession,
} from "../sos/sos.service";
import { slimFacility } from "../accessible-route/facility-slim";
import EmergencyContact from "../../model/emergency-contact.model";
import LineLinkCode from "../../model/line-link-code.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import * as memoryService from "./memory.service";
import { searchKnowledge } from "./knowledge.service";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../accessible-route/accessible-route.service";
import type { DriveLeg } from "../../types/route";
import type { TaiwanCityEn } from "../../types/transit";

export async function findGooglePlaces(args: {
  query: string;
  latitude?: number;
  longitude?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const hasValidPair =
      typeof args.latitude === "number" &&
      Number.isFinite(args.latitude) &&
      args.latitude >= -90 &&
      args.latitude <= 90 &&
      typeof args.longitude === "number" &&
      Number.isFinite(args.longitude) &&
      args.longitude >= -180 &&
      args.longitude <= 180;
    const location = hasValidPair
      ? { latitude: args.latitude!, longitude: args.longitude! }
      : args.userLocation;
    const places = await searchPlaces(args.query, {
      latitude: location?.latitude,
      longitude: location?.longitude,
      sortByDistance: Boolean(location),
    });
    if (!places.length)
      return JSON.stringify({ status: "ZERO_RESULTS", places: [] });
    return JSON.stringify({ status: "OK", places });
  } catch (error: any) {
    console.error("[agent-tool:findGooglePlaces]", error.message);
    return JSON.stringify({ error: "Google Places API 查詢失敗" });
  }
}

export async function findA11yPlaces(args: {
  query?: string;
  latitude?: number;
  longitude?: number;
  range?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  let { latitude: searchLat, longitude: searchLng } = args;
  const searchRange = args.range ?? 300;

  if (args.query && (!searchLat || !searchLng)) {
    const coords = await getCoordinates(
      args.query,
      args.userLocation?.latitude,
      args.userLocation?.longitude,
    );
    if (!coords) {
      return JSON.stringify({
        ok: false,
        message: `找不到地點「${args.query}」的座標`,
      });
    }
    searchLat = coords.latitude;
    searchLng = coords.longitude;
  }

  if (!searchLat || !searchLng) {
    return JSON.stringify({
      ok: false,
      error: "缺少位置資訊（query 或 lat/lng 必填）",
    });
  }

  try {
    const places = await a11yOrchestration.findNearbyLimited(
      searchLat,
      searchLng,
      searchRange,
    );
    return JSON.stringify({
      ok: true,
      searchLocation: { lat: searchLat, lng: searchLng, query: args.query },
      places: {
        ...places,
        nearbyOsm: places.nearbyOsm.map(slimFacility),
      },
    });
  } catch (error) {
    console.error("[agent-tool:findA11yPlaces]", error);
    return JSON.stringify({ error: "資料庫查詢失敗" });
  }
}

function normalizeLineCode(code: string): string {
  return code.trim().toUpperCase();
}

function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function publicTrackingUrl(sessionId: string): string {
  const base = process.env.PUBLIC_TRACKING_BASE_URL ?? "";
  return `${base}/zh-TW?sos=${sessionId}`;
}

async function getLineContacts(
  lineUserId: string,
): Promise<Array<{ userId: string; name: string; _id: unknown }>> {
  return EmergencyContact.find({
    lineUserId,
    bindStatus: "bound",
  })
    .select("userId name")
    .lean();
}

async function getLatestSharedLineLocation(lineUserId: string): Promise<{
  latitude: number;
  longitude: number;
  updatedAt: Date | null;
} | null> {
  const contact = await EmergencyContact.findOne({
    lineUserId,
    bindStatus: "bound",
    lastLineLat: { $ne: null },
    lastLineLng: { $ne: null },
  })
    .sort({ lastLineLocationUpdatedAt: -1, updatedAt: -1 })
    .select("lastLineLat lastLineLng lastLineLocationUpdatedAt")
    .lean();

  if (
    typeof contact?.lastLineLat !== "number" ||
    typeof contact?.lastLineLng !== "number"
  ) {
    return null;
  }

  return {
    latitude: contact.lastLineLat,
    longitude: contact.lastLineLng,
    updatedAt: contact.lastLineLocationUpdatedAt ?? null,
  };
}

function asCoords(
  latitude?: number,
  longitude?: number,
): { latitude: number; longitude: number } | null {
  return typeof latitude === "number" && typeof longitude === "number"
    ? { latitude, longitude }
    : null;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" ? Math.trunc(value) : fallback;
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
}

export async function findCampusAccessibility(args: {
  query?: string;
  latitude?: number;
  longitude?: number;
  radiusM?: number;
  city?: string;
  type?: string;
  page?: number;
  limit?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const page = clampInt(args.page, 1, 1, 1000);
    const limit = clampInt(args.limit, 5, 1, 20);
    let { latitude, longitude } = args;

    if (!asCoords(latitude, longitude) && !args.query && args.userLocation) {
      latitude = args.userLocation.latitude;
      longitude = args.userLocation.longitude;
    }

    const coordsInput = asCoords(latitude, longitude);
    if (coordsInput) {
      const campuses = await campusService.findNearby(
        coordsInput.latitude,
        coordsInput.longitude,
        args.radiusM ?? 1000,
        args.type,
      );
      return JSON.stringify({
        ok: true,
        mode: "nearby",
        query: args.query ?? null,
        searchLocation: {
          lat: coordsInput.latitude,
          lng: coordsInput.longitude,
        },
        total: campuses.length,
        campuses: campuses.slice(0, limit),
      });
    }

    const keywordResult = await campusService.findAll({
      city: args.city,
      type: args.type,
      keyword: args.query,
      page,
      limit,
    });
    if (keywordResult.totalCount > 0 || !args.query) {
      return JSON.stringify({
        ok: true,
        mode: "search",
        query: args.query ?? null,
        ...keywordResult,
        campuses: keywordResult.items,
        items: undefined,
      });
    }

    const coords = await getCoordinates(
      args.query,
      args.userLocation?.latitude,
      args.userLocation?.longitude,
    );
    if (!coords) {
      return JSON.stringify({
        ok: false,
        error: `找不到校園或地點「${args.query}」`,
      });
    }

    const campuses = await campusService.findNearby(
      coords.latitude,
      coords.longitude,
      args.radiusM ?? 1000,
      args.type,
    );
    return JSON.stringify({
      ok: true,
      mode: "nearby",
      query: args.query,
      searchLocation: { lat: coords.latitude, lng: coords.longitude },
      total: campuses.length,
      campuses: campuses.slice(0, limit),
    });
  } catch (error: any) {
    console.error("[agent-tool:findCampusAccessibility]", error);
    return JSON.stringify({ ok: false, error: "校園無障礙資料查詢失敗" });
  }
}

export async function getCampusAccessibilityDetails(args: {
  campusId: number;
  type?: string;
  limit?: number;
}): Promise<string> {
  try {
    const campus = await campusService.findByCampusId(args.campusId);
    if (!campus) {
      return JSON.stringify({ ok: false, error: "查無此校區" });
    }

    const limit = clampInt(args.limit, 30, 1, 80);
    const facilities = args.type
      ? campus.facilities.filter((facility) => facility.type === args.type)
      : campus.facilities;

    return JSON.stringify({
      ok: true,
      campus: {
        campusId: campus.campusId,
        schoolId: campus.schoolId,
        schoolName: campus.schoolName,
        branchName: campus.branchName,
        city: campus.city,
        address: campus.address,
        phone: campus.phone,
        location: campus.location,
        buildingCount: campus.buildingCount,
        facilityCount: campus.facilityCount,
        facTypeSummary: campus.facTypeSummary,
      },
      filter: { type: args.type ?? null },
      totalMatchedFacilities: facilities.length,
      facilities: facilities.slice(0, limit),
      truncated: facilities.length > limit,
    });
  } catch (error: any) {
    console.error("[agent-tool:getCampusAccessibilityDetails]", error);
    return JSON.stringify({ ok: false, error: "校區無障礙設施詳情查詢失敗" });
  }
}

function summarizeLeg(
  leg: WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg | DriveLeg,
): Record<string, unknown> {
  if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") {
    return {
      type: leg.type,
      distanceM: leg.distanceM,
      durationMin: leg.durationMin,
      durationInTrafficMin: leg.durationInTrafficMin ?? null,
      trafficLevel: leg.trafficLevel ?? null,
      summary: leg.summary ?? null,
    };
  }
  if (leg.type === "WALK") {
    return {
      type: "WALK",
      from: leg.from,
      to: leg.to,
      distanceM: leg.distanceM,
      minutesEst: leg.minutesEst,
    };
  }
  if (leg.type === "BUS") {
    return {
      type: "BUS",
      routeName: leg.routeName,
      departureStop: leg.departureStop,
      arrivalStop: leg.arrivalStop,
      direction: leg.direction,
      waitMinutes: leg.estimatedWaitMinutes,
      departureTime: leg.departureTime ?? null,
      arrivalTime: leg.arrivalTime ?? null,
      ...(leg.alerts?.length ? { alerts: leg.alerts } : {}),
    };
  }
  if (leg.type === "METRO") {
    return {
      type: "METRO",
      railSystem: leg.railSystem,
      lineId: leg.lineId,
      lineName: leg.lineName,
      departureStation: leg.departureStation,
      arrivalStation: leg.arrivalStation,
      rideMinutes: leg.rideMinutes,
      waitMinutes: leg.estimatedWaitMinutes,
      departureTime: leg.departureTime ?? null,
      arrivalTime: leg.arrivalTime ?? null,
      ...(leg.alerts?.length ? { alerts: leg.alerts } : {}),
    };
  }
  if (leg.type === "THSR") {
    return {
      type: "THSR",
      trainNo: leg.trainNo,
      departureStation: leg.departureStation,
      arrivalStation: leg.arrivalStation,
      departureTime: leg.departureTime,
      arrivalTime: leg.arrivalTime,
      rideMinutes: leg.rideMinutes,
      ...(leg.alerts?.length ? { alerts: leg.alerts } : {}),
    };
  }
  if (leg.type === "TRA") {
    return {
      type: "TRA",
      trainNo: leg.trainNo,
      trainTypeName: leg.trainTypeName,
      departureStation: leg.departureStation,
      arrivalStation: leg.arrivalStation,
      departureTime: leg.departureTime,
      arrivalTime: leg.arrivalTime,
      rideMinutes: leg.rideMinutes,
      ...(leg.alerts?.length ? { alerts: leg.alerts } : {}),
    };
  }
  return { type: (leg as any).type };
}

function summarizeRoute(route: AccessibleRoute): Record<string, unknown> {
  return {
    routeName: route.routeName,
    totalMinutes: route.totalMinutes,
    transferCount: route.transferCount,
    accessibilityScore: route.accessibilityScore ?? null,
    accessibilityLabel: route.accessibilityLabel ?? null,
    departureDate: route.departureDate ?? null,
    accessibilityHighlights: route.accessibilityHighlights ?? [],
    legs: route.legs.map(summarizeLeg),
  };
}

export async function planAccessibleRoute(args: {
  origin: string;
  destination: string;
  mode?: string;
  departureTime?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  const { origin, destination, mode, departureTime } = args;

  try {
    const validMode = [
      "wheelchair",
      "elderly",
      "visual_impaired",
      "normal",
    ].includes(mode ?? "")
      ? (mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : "normal";

    // "current_location" only resolves via the caller-injected GPS fix; every
    // other origin and the destination are passed through verbatim so the SHARED
    // planner geocodes them — identical to POST /a11y/accessible-route. This keeps
    // the agent and the HTTP endpoint from ever drifting on geocoding, city
    // resolution or the transfer limit again. maxTransfers is 2 because realistic
    // cross-city trips (e.g. 雙鐵/高鐵接駁) routinely need two transfers.
    if (origin === "current_location" && !args.userLocation) {
      return JSON.stringify({
        ok: false,
        error: "需要使用者位置以使用「目前位置」作為起點",
      });
    }
    const originInput =
      origin === "current_location" ? args.userLocation : origin;

    const result = await planAccessibleRouteFromRequest({
      origin: originInput,
      destination,
      userLocation: args.userLocation,
      mode: validMode,
      maxTransfers: 2,
      departureTime,
    });

    if (!result.ok) {
      return JSON.stringify({ ok: false, error: result.error });
    }

    return JSON.stringify({
      ok: true,
      origin: {
        name: origin === "current_location" ? "目前位置" : origin,
        lat: result.data.origin.lat,
        lng: result.data.origin.lng,
      },
      destination: {
        name: destination,
        lat: result.data.destination.lat,
        lng: result.data.destination.lng,
      },
      city: result.data.city,
      mode: validMode,
      routes: result.data.routes.slice(0, 3).map(summarizeRoute),
      metroAlerts: result.data.metroAlerts ?? [],
      transitAlerts: result.data.transitAlerts ?? [],
    });
  } catch (error: any) {
    console.error("[agent-tool:planAccessibleRoute]", error);
    return JSON.stringify({
      ok: false,
      error: error?.message ?? "路線規劃失敗",
    });
  }
}

/**
 * Resolve the city for a bus tool from an explicit `city` arg, falling back to
 * the user's GPS fix. Returns the resolved code or a ready-to-return error
 * string when neither is usable.
 */
async function resolveBusCityOrError(
  city: string | undefined,
  userLocation?: { latitude: number; longitude: number },
): Promise<TaiwanCityEn | "InterCity" | { error: string }> {
  const resolved = await busService.resolveBusCity(city, userLocation);
  if (!resolved) {
    return {
      error: "無法判斷縣市，請告訴我公車所在的縣市（例如「台北」「台中」）",
    };
  }
  return resolved;
}

export async function getBusRoute(args: {
  routeName: string;
  city?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRouteInfo({
      routeName: args.routeName,
      city,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusRoute]", error);
    return JSON.stringify({ ok: false, error: "公車路線查詢失敗" });
  }
}

export async function getBusRouteDetail(args: {
  routeName: string;
  city?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRouteDetail({
      routeName: args.routeName,
      city,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusRouteDetail]", error);
    return JSON.stringify({ ok: false, error: "公車路線詳情查詢失敗" });
  }
}

export async function getBusArrival(args: {
  routeName: string;
  stopName: string;
  city?: string;
  direction?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusArrivalAtStop({
      routeName: args.routeName,
      stopName: args.stopName,
      city,
      direction: args.direction,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusArrival]", error);
    return JSON.stringify({ ok: false, error: "公車到站查詢失敗" });
  }
}

export async function getBusTimetable(args: {
  routeName: string;
  city?: string;
  afterTime?: string;
  limit?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusTimetable({
      routeName: args.routeName,
      city,
      afterTime: args.afterTime,
      limit: args.limit,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getBusTimetable]", error);
    return JSON.stringify({ ok: false, error: "公車時刻表查詢失敗" });
  }
}

export async function getTrainTimetable(args: {
  originStation: string;
  destinationStation: string;
  date?: string;
  departAfter?: string;
  arriveBy?: string;
  railSystem?: "TRA" | "THSR";
}): Promise<string> {
  try {
    const result = await trainService.getTrainTimetable(args);
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getTrainTimetable]", error);
    return JSON.stringify({ ok: false, error: "火車時刻表查詢失敗" });
  }
}

export async function getStationTimetable(args: {
  station: string;
  date?: string;
  departAfter?: string;
  railSystem?: "TRA" | "THSR";
}): Promise<string> {
  try {
    const result = await trainService.getStationTimetable(args);
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getStationTimetable]", error);
    return JSON.stringify({ ok: false, error: "車站時刻表查詢失敗" });
  }
}

export async function trackBuses(args: {
  routeName: string;
  city?: string;
  direction?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRealtimeOnRoute({
      routeName: args.routeName,
      city,
      direction: args.direction,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:trackBuses]", error);
    return JSON.stringify({ ok: false, error: "公車即時位置查詢失敗" });
  }
}

export async function findNearbyBusStops(args: {
  latitude?: number;
  longitude?: number;
  query?: string;
  radius?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && (!latitude || !longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({
          ok: false,
          error: `找不到地點「${args.query}」的座標`,
        });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if ((!latitude || !longitude) && args.userLocation) {
      latitude = args.userLocation.latitude;
      longitude = args.userLocation.longitude;
    }
    if (!latitude || !longitude) {
      return JSON.stringify({
        ok: false,
        error: "缺少位置資訊（query 或 lat/lng，或使用者目前位置）",
      });
    }
    const result = await busService.getNearbyStops({
      lat: latitude,
      lng: longitude,
      radius: args.radius ?? 500,
      limit: 10,
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:findNearbyBusStops]", error);
    return JSON.stringify({ ok: false, error: "附近公車站牌查詢失敗" });
  }
}

export async function getAirQuality(args: {
  latitude: number;
  longitude: number;
}): Promise<string> {
  try {
    const data = await airService.getAirData(args.latitude, args.longitude);
    if (!data)
      return JSON.stringify({ ok: false, message: "此區域無空氣品質監測數據" });

    const pm25 = data.readings[0].pm25;
    const { quality, advice } = airService.classifyPm25(pm25);

    return JSON.stringify({
      ok: true,
      city: data.city,
      area: data.readings[0].area,
      pm25,
      quality,
      advice,
      coordinates: data.readings[0].coordinates,
    });
  } catch (error: any) {
    console.error("[agent-tool:getAirQuality]", error);
    return JSON.stringify({ ok: false, error: "空氣品質查詢失敗" });
  }
}

export async function getA11yFacilityDetails(args: {
  osmId: string;
}): Promise<string> {
  try {
    const ids = args.osmId
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      return JSON.stringify({ ok: false, error: "缺少 osmId 參數" });
    }
    const places = await a11yService.findByOsmIds(ids);
    if (!places.length) {
      return JSON.stringify({
        ok: false,
        error: `找不到 osmId: ${ids.join(", ")} 的設施`,
      });
    }
    return JSON.stringify({
      ok: true,
      count: places.length,
      facilities: places.map(slimFacility),
    });
  } catch (error: any) {
    console.error("[agent-tool:getA11yFacilityDetails]", error);
    return JSON.stringify({ ok: false, error: "設施詳情查詢失敗" });
  }
}

export async function getEnvironmentInfo(args: {
  latitude?: number;
  longitude?: number;
  radius?: number;
  query?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && !asCoords(latitude, longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({
          ok: false,
          error: `找不到地點「${args.query}」的座標`,
        });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if (!asCoords(latitude, longitude) && args.userLocation) {
      latitude = args.userLocation.latitude;
      longitude = args.userLocation.longitude;
    }
    const location = asCoords(latitude, longitude);
    if (!location) {
      return JSON.stringify({
        ok: false,
        error: "缺少位置資訊（query 或 lat/lng 必填）",
      });
    }
    const data = await fetchEnvironment(
      location.latitude,
      location.longitude,
      args.radius ?? 1000,
    );
    return JSON.stringify({ ok: true, query: args.query ?? null, ...data });
  } catch (error: any) {
    console.error("[agent-tool:getEnvironmentInfo]", error);
    return JSON.stringify({ ok: false, error: "環境資訊查詢失敗" });
  }
}

export async function getNearbyHazards(args: {
  latitude?: number;
  longitude?: number;
  query?: string;
  radiusM?: number;
  hazardType?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && (!latitude || !longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({
          ok: false,
          error: `找不到地點「${args.query}」的座標`,
        });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if (!latitude || !longitude) {
      return JSON.stringify({
        ok: false,
        error: "缺少位置資訊（query 或 lat/lng 必填）",
      });
    }
    const result = await hazardService.findNearby({
      lat: latitude,
      lng: longitude,
      radius: args.radiusM,
      hazardType: args.hazardType as any,
    });
    return JSON.stringify({ ok: result.ok, data: result.data });
  } catch (error: any) {
    console.error("[agent-tool:getNearbyHazards]", error);
    return JSON.stringify({ ok: false, error: "附近路況查詢失敗" });
  }
}

export async function findNearbyParking(args: {
  latitude?: number;
  longitude?: number;
  query?: string;
  radiusM?: number;
  type?: "disabled" | "standard" | "all";
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    let { latitude, longitude } = args;
    if (args.query && (!latitude || !longitude)) {
      const coords = await getCoordinates(
        args.query,
        args.userLocation?.latitude,
        args.userLocation?.longitude,
      );
      if (!coords) {
        return JSON.stringify({
          ok: false,
          error: `找不到地點「${args.query}」的座標`,
        });
      }
      latitude = coords.latitude;
      longitude = coords.longitude;
    }
    if (!latitude || !longitude) {
      return JSON.stringify({
        ok: false,
        error: "缺少位置資訊（query 或 lat/lng 必填）",
      });
    }
    const spots = await a11yService.findNearbyParking(
      latitude,
      longitude,
      args.radiusM ?? 500,
      args.type,
    );
    return JSON.stringify({
      ok: true,
      query: args.query ?? null,
      searchLocation: { lat: latitude, lng: longitude },
      total: spots.length,
      parkingSpots: spots,
    });
  } catch (error: any) {
    console.error("[agent-tool:findNearbyParking]", error);
    return JSON.stringify({ ok: false, error: "停車位查詢失敗" });
  }
}

export async function getMetroAlerts(args: {
  railSystem?: string;
}): Promise<string> {
  try {
    const results = await metroService.getMetroAlerts(args.railSystem);
    if (results.every((result) => result.alerts.length === 0)) {
      return JSON.stringify({
        ok: true,
        summary: "各捷運系統目前皆正常營運，無異常公告",
        alerts: [],
      });
    }
    return JSON.stringify({ ok: true, alerts: results });
  } catch (error: any) {
    console.error("[agent-tool:getMetroAlerts]", error);
    return JSON.stringify({ ok: false, error: "捷運營運狀態查詢失敗" });
  }
}

export async function getTransitAlerts(args: {
  mode: "bus" | "metro" | "tra" | "thsr" | string;
  city?: string;
  routeName?: string;
  railSystem?: string;
  trainNo?: string;
  stopName?: string;
  direction?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const mode = args.mode?.toLowerCase();
    if (
      mode !== "bus" &&
      mode !== "metro" &&
      mode !== "tra" &&
      mode !== "thsr"
    ) {
      return JSON.stringify({
        ok: false,
        error: "不支援的運具類型，請指定 bus、metro、tra 或 thsr",
      });
    }

    let ctx: alertService.TransitContext;

    if (mode === "bus") {
      const routeName = args.routeName?.trim() || "";
      if (!routeName) {
        return JSON.stringify({
          ok: false,
          error: "公車通阻查詢需要提供路線名稱（routeName，例如 '307'）",
        });
      }
      const cityResult = await resolveBusCityOrError(
        args.city,
        args.userLocation,
      );
      if (typeof cityResult !== "string") {
        return JSON.stringify({ ok: false, ...cityResult });
      }
      ctx = {
        mode: "bus",
        city: cityResult as TaiwanCityEn,
        routeName,
        direction:
          args.direction === 0 || args.direction === 1
            ? args.direction
            : undefined,
        stopName: args.stopName?.trim() || undefined,
      };
    } else if (mode === "metro") {
      const validRailSystems = ["TRTC", "KRTC", "TYMC", "TMRT", "NTMC", "KLRT"];
      const rawSystem = (args.railSystem || "TRTC").toUpperCase();
      const railSystem = validRailSystems.includes(rawSystem)
        ? (rawSystem as "TRTC" | "KRTC" | "TYMC" | "TMRT" | "NTMC" | "KLRT")
        : "TRTC";
      ctx = {
        mode: "metro",
        railSystem,
        lineCode: args.routeName?.trim() || undefined,
        stationIds: args.stopName?.trim() ? [args.stopName.trim()] : undefined,
      };
    } else if (mode === "tra") {
      ctx = {
        mode: "tra",
        trainNo:
          args.trainNo?.trim() ||
          (args.routeName && /^\d+$/.test(args.routeName.trim())
            ? args.routeName.trim()
            : undefined),
        lineId:
          args.routeName && !/^\d+$/.test(args.routeName.trim())
            ? args.routeName.trim()
            : undefined,
        stationIds: args.stopName?.trim() ? [args.stopName.trim()] : undefined,
        direction:
          args.direction === 0 || args.direction === 1
            ? args.direction
            : undefined,
      };
    } else {
      ctx = {
        mode: "thsr",
        lineId: args.routeName?.trim() || undefined,
        fromStationId: args.stopName?.trim() || undefined,
        direction:
          args.direction === 0 || args.direction === 1
            ? args.direction
            : undefined,
      };
    }

    const result = await alertService.getTransitAlerts(ctx);
    if (!result.ok) {
      return JSON.stringify({ ok: false, error: result.error });
    }

    const alerts = result.alerts;
    return JSON.stringify({
      ok: true,
      mode: ctx.mode,
      total: alerts.length,
      alerts,
      summary:
        alerts.length === 0
          ? "目前營運正常，未發現通阻或異常公告"
          : `發現 ${alerts.length} 則相關即時通阻/異常警報`,
    });
  } catch (error: any) {
    console.error("[agent-tool:getTransitAlerts]", error);
    return JSON.stringify({ ok: false, error: "大眾運輸通阻查詢失敗" });
  }
}

export async function getNavInstructions(args: {
  origin: string;
  destination: string;
  mode?: string;
  departureTime?: string;
  routeIndex?: number;
  userHeading?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    if (args.origin === "current_location" && !args.userLocation) {
      return JSON.stringify({
        ok: false,
        error: "需要使用者位置以使用「目前位置」作為起點",
      });
    }
    const originInput =
      args.origin === "current_location" ? args.userLocation : args.origin;
    const validMode = [
      "wheelchair",
      "elderly",
      "visual_impaired",
      "normal",
    ].includes(args.mode ?? "")
      ? (args.mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : "normal";

    const result = await planAccessibleRouteFromRequest({
      origin: originInput,
      destination: args.destination,
      userLocation: args.userLocation,
      mode: validMode,
      maxTransfers: 2,
      departureTime: args.departureTime,
    });
    if (!result.ok) {
      return JSON.stringify({ ok: false, error: result.error });
    }

    const routes = result.data.routes;
    const idx = Math.min(Math.max(args.routeIndex ?? 0, 0), routes.length - 1);
    const route = routes[idx];

    const navResult = generateNavInstructions(
      { legs: route.legs as any },
      args.userHeading,
    );
    if (!navResult.ok) {
      return JSON.stringify({ ok: false, error: navResult.message });
    }

    return JSON.stringify({
      ok: true,
      routeName: route.routeName,
      totalMinutes: route.totalMinutes,
      instructions: navResult.data.instructions,
      totalSteps: navResult.data.totalSteps,
      initialBearing: navResult.data.initialBearing,
      warnings: navResult.data.warnings,
    });
  } catch (error: any) {
    console.error("[agent-tool:getNavInstructions]", error);
    return JSON.stringify({
      ok: false,
      error: error?.message ?? "導航指引產生失敗",
    });
  }
}

export async function searchAccessibilityGuide(args: {
  query: string;
}): Promise<string> {
  if (!args.query?.trim()) {
    return JSON.stringify({ ok: false, error: "搜尋關鍵字不能為空" });
  }
  try {
    const results = await searchKnowledge(args.query.trim(), 3);
    if (!results.length) {
      return JSON.stringify({
        ok: true,
        results: [],
        message: "未找到相關指南",
      });
    }
    return JSON.stringify({
      ok: true,
      results: results.map((r) => ({
        title: r.title,
        content: r.content,
        source: r.source,
        category: r.category,
      })),
    });
  } catch (error: any) {
    console.error("[agent-tool:searchAccessibilityGuide]", error.message);
    return JSON.stringify({ ok: false, error: "知識庫查詢失敗" });
  }
}

export async function bindEmergencyContactCode(
  args: {
    code: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  const code = normalizeLineCode(args.code ?? "");
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return JSON.stringify({ ok: false, error: "綁定碼格式錯誤" });
  }

  try {
    const contact = await EmergencyContact.findOne({
      bindStatus: "pending",
      bindCode: code,
      bindCodeExpiresAt: { $gt: new Date() },
    });
    if (!contact) {
      return JSON.stringify({
        ok: false,
        errorCode: "NO_EMERGENCY_BIND_CODE",
        error: "找不到可用的緊急聯絡人綁定碼",
      });
    }

    contact.bindStatus = "bound";
    contact.lineUserId = lineUserId;
    contact.bindCode = undefined;
    contact.bindCodeExpiresAt = undefined;
    await contact.save();

    return JSON.stringify({
      ok: true,
      bound: true,
      contactId: String(contact._id),
      contactName: contact.name,
    });
  } catch (error: any) {
    console.error("[agent-tool:bindEmergencyContactCode]", error);
    return JSON.stringify({ ok: false, error: "緊急聯絡人綁定失敗" });
  }
}

export async function bindLineAccountCode(
  args: {
    code: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  const code = normalizeLineCode(args.code ?? "");
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return JSON.stringify({ ok: false, error: "綁定碼格式錯誤" });
  }

  try {
    const linkCode = await LineLinkCode.findOne({
      code,
      expiresAt: { $gt: new Date() },
    });
    if (!linkCode) {
      return JSON.stringify({
        ok: false,
        errorCode: "NO_LINE_BIND_CODE",
        error: "找不到可用的 LINE 帳號綁定碼",
      });
    }

    const existingBoundUser = await User.findOne({ lineUserId })
      .select("_id name")
      .lean();
    if (
      existingBoundUser &&
      String(existingBoundUser._id) !== String(linkCode.userId)
    ) {
      return JSON.stringify({
        ok: false,
        error: "這個 LINE 帳號已綁定其他使用者",
      });
    }

    const alreadyLinkedUser = await User.findById(linkCode.userId)
      .select("name lineUserId")
      .lean();
    if (!alreadyLinkedUser) {
      return JSON.stringify({ ok: false, error: "找不到對應的使用者" });
    }
    if (
      alreadyLinkedUser.lineUserId &&
      alreadyLinkedUser.lineUserId !== lineUserId
    ) {
      return JSON.stringify({
        ok: false,
        error: "這個使用者已綁定其他 LINE 帳號",
      });
    }

    await User.updateOne({ _id: linkCode.userId }, { $set: { lineUserId } });
    await LineLinkCode.deleteOne({ _id: linkCode._id });

    return JSON.stringify({
      ok: true,
      bound: true,
      userId: String(linkCode.userId),
      userName: alreadyLinkedUser.name,
      bindUrl: buildBindUrl(),
    });
  } catch (error: any) {
    console.error("[agent-tool:bindLineAccountCode]", error);
    return JSON.stringify({ ok: false, error: "LINE 帳號綁定失敗" });
  }
}

export async function getActiveSosContext(
  args: object,
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }

  try {
    const contacts = await getLineContacts(lineUserId);
    if (!contacts.length) {
      return JSON.stringify({
        ok: true,
        activeSessions: [],
        latestSession: null,
        message: "目前沒有綁定的家人求救",
      });
    }

    const userIds = contacts.map((contact) => contact.userId);
    const [users, sessions] = await Promise.all([
      User.find({ _id: { $in: userIds } })
        .select("name")
        .lean(),
      SosSession.find({ userId: { $in: userIds } })
        .sort({ updatedAt: -1 })
        .lean(),
    ]);

    const userNameById = new Map(
      users.map((u) => [String(u._id), u.name ?? "未知使用者"]),
    );
    const activeSessions = sessions
      .filter((session) => session.status === "active")
      .map((session) => ({
        sessionId: String(session._id),
        ownerUserId: String(session.userId),
        ownerName: userNameById.get(String(session.userId)) ?? "未知使用者",
        type: session.type,
        status: session.status,
        address: session.address ?? null,
        lat: session.lat,
        lng: session.lng,
        locationUpdatedAt: session.locationUpdatedAt,
        updatedAt: session.updatedAt,
        mapsUrl: googleMapsUrl(session.lat, session.lng),
        trackingUrl: publicTrackingUrl(String(session._id)),
      }));

    const latestSession = sessions[0]
      ? {
          sessionId: String(sessions[0]._id),
          ownerUserId: String(sessions[0].userId),
          ownerName:
            userNameById.get(String(sessions[0].userId)) ?? "未知使用者",
          type: sessions[0].type,
          status: sessions[0].status,
          address: sessions[0].address ?? null,
          lat: sessions[0].lat,
          lng: sessions[0].lng,
          locationUpdatedAt: sessions[0].locationUpdatedAt,
          updatedAt: sessions[0].updatedAt,
          mapsUrl: googleMapsUrl(sessions[0].lat, sessions[0].lng),
          trackingUrl: publicTrackingUrl(String(sessions[0]._id)),
        }
      : null;

    return JSON.stringify({
      ok: true,
      contacts: contacts.map((contact) => ({
        contactId: String(contact._id),
        contactName: contact.name,
        ownerUserId: contact.userId,
      })),
      activeSessions,
      latestSession,
    });
  } catch (error: any) {
    console.error("[agent-tool:getActiveSosContext]", error);
    return JSON.stringify({ ok: false, error: "SOS 狀態查詢失敗" });
  }
}

export async function getSosLiveLocation(
  args: {
    sessionId: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  if (!args.sessionId?.trim()) {
    return JSON.stringify({ ok: false, error: "缺少 sessionId" });
  }

  try {
    const result = await getAuthorizedSessionForLineUser(
      lineUserId,
      args.sessionId.trim(),
    );
    if (!result?.session) {
      return JSON.stringify({ ok: false, error: "找不到可查詢的 SOS session" });
    }
    const { session, ownerName } = result;
    return JSON.stringify({
      ok: true,
      sessionId: session._id,
      ownerName,
      type: session.type,
      status: session.status,
      lat: session.lat,
      lng: session.lng,
      address: session.address ?? null,
      locationUpdatedAt: session.locationUpdatedAt,
      trackingUrl: publicTrackingUrl(String(session._id)),
      mapsUrl: googleMapsUrl(session.lat, session.lng),
    });
  } catch (error: any) {
    console.error("[agent-tool:getSosLiveLocation]", error);
    return JSON.stringify({ ok: false, error: "即時位置查詢失敗" });
  }
}

export async function planRouteToSosVictim(
  args: {
    sessionId: string;
    mode?: string;
    departureTime?: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  if (!args.sessionId?.trim()) {
    return JSON.stringify({ ok: false, error: "缺少 sessionId" });
  }

  try {
    const sessionResult = await getAuthorizedSessionForLineUser(
      lineUserId,
      args.sessionId.trim(),
    );
    if (!sessionResult?.session) {
      return JSON.stringify({ ok: false, error: "找不到可查詢的 SOS session" });
    }

    const sharedLocation = await getLatestSharedLineLocation(lineUserId);
    if (!sharedLocation) {
      return JSON.stringify({
        ok: false,
        error: "請先傳送你目前的位置，再規劃前往路線",
      });
    }

    const validMode = [
      "wheelchair",
      "elderly",
      "visual_impaired",
      "normal",
    ].includes(args.mode ?? "")
      ? (args.mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : "normal";

    const result = await planAccessibleRouteFromRequest({
      origin: {
        latitude: sharedLocation.latitude,
        longitude: sharedLocation.longitude,
      },
      destination: {
        latitude: sessionResult.session.lat,
        longitude: sessionResult.session.lng,
      },
      mode: validMode,
      maxTransfers: 2,
      departureTime: args.departureTime,
    });

    if (!result.ok) {
      return JSON.stringify({ ok: false, error: result.error });
    }

    return JSON.stringify({
      ok: true,
      ownerName: sessionResult.ownerName,
      sessionId: sessionResult.session._id,
      shareToken: sessionResult.session.shareToken,
      destination: {
        lat: sessionResult.session.lat,
        lng: sessionResult.session.lng,
        address: sessionResult.session.address ?? null,
      },
      origin: {
        lat: sharedLocation.latitude,
        lng: sharedLocation.longitude,
        updatedAt: sharedLocation.updatedAt,
      },
      mode: validMode,
      routes: result.data.routes.slice(0, 3).map(summarizeRoute),
    });
  } catch (error: any) {
    console.error("[agent-tool:planRouteToSosVictim]", error);
    return JSON.stringify({
      ok: false,
      error: error?.message ?? "路線規劃失敗",
    });
  }
}

export async function findSosNearbyPlaces(
  args: {
    sessionId: string;
    query: string;
    maxResults?: number;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  if (!args.sessionId?.trim()) {
    return JSON.stringify({ ok: false, error: "缺少 sessionId" });
  }
  if (!args.query?.trim()) {
    return JSON.stringify({ ok: false, error: "搜尋關鍵字不能為空" });
  }

  try {
    const result = await getAuthorizedSessionForLineUser(
      lineUserId,
      args.sessionId.trim(),
    );
    if (!result?.session) {
      return JSON.stringify({ ok: false, error: "找不到可查詢的 SOS session" });
    }

    const places = await searchPlaces(args.query.trim(), {
      latitude: result.session.lat,
      longitude: result.session.lng,
      maxResults: args.maxResults ?? 3,
    });
    return JSON.stringify({
      ok: true,
      sessionId: result.session._id,
      ownerName: result.ownerName,
      query: args.query.trim(),
      center: { lat: result.session.lat, lng: result.session.lng },
      places,
    });
  } catch (error: any) {
    console.error("[agent-tool:findSosNearbyPlaces]", error);
    return JSON.stringify({ ok: false, error: "附近地點查詢失敗" });
  }
}

export async function findSosNearbyA11yPlaces(
  args: {
    sessionId: string;
    query: string;
    range?: number;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  if (!args.sessionId?.trim()) {
    return JSON.stringify({ ok: false, error: "缺少 sessionId" });
  }
  if (!args.query?.trim()) {
    return JSON.stringify({ ok: false, error: "地點名稱不能為空" });
  }

  try {
    const result = await getAuthorizedSessionForLineUser(
      lineUserId,
      args.sessionId.trim(),
    );
    if (!result?.session) {
      return JSON.stringify({ ok: false, error: "找不到可查詢的 SOS session" });
    }
    const places = await a11yOrchestration.findNearbyLimited(
      result.session.lat,
      result.session.lng,
      args.range ?? 300,
    );
    return JSON.stringify({
      ok: true,
      sessionId: result.session._id,
      ownerName: result.ownerName,
      query: args.query.trim(),
      center: { lat: result.session.lat, lng: result.session.lng },
      places: {
        ...places,
        nearbyOsm: places.nearbyOsm.map(slimFacility),
      },
    });
  } catch (error: any) {
    console.error("[agent-tool:findSosNearbyA11yPlaces]", error);
    return JSON.stringify({ ok: false, error: "附近無障礙設施查詢失敗" });
  }
}

export async function getSosEnvironmentInfo(
  args: {
    sessionId: string;
    radius?: number;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "缺少 LINE 使用者資訊" });
  }
  if (!args.sessionId?.trim()) {
    return JSON.stringify({ ok: false, error: "缺少 sessionId" });
  }

  try {
    const result = await getAuthorizedSessionForLineUser(
      lineUserId,
      args.sessionId.trim(),
    );
    if (!result?.session) {
      return JSON.stringify({ ok: false, error: "找不到可查詢的 SOS session" });
    }
    const data = await fetchEnvironment(
      result.session.lat,
      result.session.lng,
      args.radius ?? 1000,
    );
    return JSON.stringify({
      ok: true,
      sessionId: result.session._id,
      ownerName: result.ownerName,
      center: { lat: result.session.lat, lng: result.session.lng },
      ...data,
    });
  } catch (error: any) {
    console.error("[agent-tool:getSosEnvironmentInfo]", error);
    return JSON.stringify({ ok: false, error: "環境資訊查詢失敗" });
  }
}

async function resolveActiveSosSessionId(
  lineUserId: string,
): Promise<string | null> {
  const contacts = await getLineContacts(lineUserId);
  if (!contacts.length) return null;
  const userIds = contacts.map((contact) => contact.userId);
  const session = await SosSession.findOne({
    userId: { $in: userIds },
    status: "active",
  })
    .sort({ updatedAt: -1 })
    .select("_id")
    .lean();
  return session ? String(session._id) : null;
}

export async function confirmSosReceived(
  args: {
    sessionId?: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "LINE 使用者未識別" });
  }
  const sessionId =
    args.sessionId?.trim() || (await resolveActiveSosSessionId(lineUserId));
  if (!sessionId) {
    return JSON.stringify({ ok: false, error: "找不到進行中的求救事件" });
  }
  try {
    const result = await acknowledgeSession({ sessionId, lineUserId });
    return JSON.stringify({
      ok: result.ok,
      message: result.message,
      data: result.data,
    });
  } catch (error: any) {
    console.error("[agent-tool:confirmSosReceived]", error);
    return JSON.stringify({ ok: false, error: "確認收到通知失敗" });
  }
}

export async function claimSosEvent(
  args: {
    sessionId?: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "LINE 使用者未識別" });
  }
  const sessionId =
    args.sessionId?.trim() || (await resolveActiveSosSessionId(lineUserId));
  if (!sessionId) {
    return JSON.stringify({ ok: false, error: "找不到進行中的求救事件" });
  }
  try {
    const result = await claimSession({ sessionId, lineUserId });
    return JSON.stringify({
      ok: result.ok,
      message: result.message,
      data: result.data,
    });
  } catch (error: any) {
    console.error("[agent-tool:claimSosEvent]", error);
    return JSON.stringify({ ok: false, error: "承接事件失敗" });
  }
}

export async function updateSosHandlingStatus(
  args: {
    sessionId?: string;
    status?: string;
    note?: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "LINE 使用者未識別" });
  }
  const sessionId =
    args.sessionId?.trim() || (await resolveActiveSosSessionId(lineUserId));
  if (!sessionId) {
    return JSON.stringify({ ok: false, error: "找不到進行中的求救事件" });
  }
  const handlingStatus =
    args.status === "en_route" || args.status === "arrived"
      ? args.status
      : undefined;
  try {
    const result = await updateHandlingStatus({
      sessionId,
      lineUserId,
      handlingStatus,
      note: args.note,
    });
    return JSON.stringify({
      ok: result.ok,
      message: result.message,
      data: result.data,
    });
  } catch (error: any) {
    console.error("[agent-tool:updateSosHandlingStatus]", error);
    return JSON.stringify({ ok: false, error: "更新處理狀態失敗" });
  }
}

export async function resolveSosEvent(
  args: {
    sessionId?: string;
  },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId) {
    return JSON.stringify({ ok: false, error: "LINE 使用者未識別" });
  }
  const sessionId =
    args.sessionId?.trim() || (await resolveActiveSosSessionId(lineUserId));
  if (!sessionId) {
    return JSON.stringify({ ok: false, error: "找不到進行中的求救事件" });
  }
  try {
    const result = await resolveSosSession({ sessionId, lineUserId });
    return JSON.stringify({
      ok: result.ok,
      message: result.message,
      data: result.data,
    });
  } catch (error: any) {
    console.error("[agent-tool:resolveSosEvent]", error);
    return JSON.stringify({ ok: false, error: "解除事件失敗" });
  }
}

function collectGroundingSources(chunks?: GroundingChunk[]): Array<{
  title: string | null;
  url: string;
  domain: string | null;
}> {
  const seen = new Set<string>();
  const sources: Array<{
    title: string | null;
    url: string;
    domain: string | null;
  }> = [];

  for (const chunk of chunks ?? []) {
    const web = chunk.web;
    if (!web?.uri || seen.has(web.uri)) continue;
    seen.add(web.uri);
    sources.push({
      title: web.title ?? null,
      url: web.uri,
      domain: web.domain ?? null,
    });
  }

  return sources;
}

export async function webSearch(args: { query: string }): Promise<string> {
  const query = args.query?.trim();
  if (!query) {
    return JSON.stringify({ ok: false, error: "搜尋關鍵字不能為空" });
  }

  try {
    const response = await googleGenAi.models.generateContent({
      model,
      contents: query,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0,
      },
    });
    const grounding = response.candidates?.[0]?.groundingMetadata;

    return JSON.stringify({
      ok: true,
      query,
      answer: response.text ?? "",
      webSearchQueries:
        grounding?.webSearchQueries ?? grounding?.retrievalQueries ?? [],
      sources: collectGroundingSources(grounding?.groundingChunks),
    });
  } catch (error: any) {
    console.error("[agent-tool:webSearch]", error);
    return JSON.stringify({ ok: false, error: "網路搜尋失敗" });
  }
}

const VALID_MEMORY_CATEGORIES = new Set([
  "preference",
  "place",
  "habit",
  "context",
]);

export async function saveMemory(args: {
  content: string;
  category: string;
  userId?: string;
  allowMemoryWrite?: boolean;
  explicitMemoryRequest?: boolean;
}): Promise<string> {
  if (!args.userId) {
    return JSON.stringify({ ok: false, error: "需要登入才能儲存記憶" });
  }
  if (!args.content?.trim()) {
    return JSON.stringify({ ok: false, error: "記憶內容不能為空" });
  }
  if (!VALID_MEMORY_CATEGORIES.has(args.category)) {
    return JSON.stringify({
      ok: false,
      error: `無效的記憶類別：${args.category}`,
    });
  }
  try {
    if (!args.allowMemoryWrite) {
      return JSON.stringify({ ok: false, error: "記憶功能尚未開啟" });
    }
    const memory = await memoryService.saveMemory(
      args.userId,
      args.content.trim(),
      args.category as "preference" | "place" | "habit" | "context",
      {
        source: args.explicitMemoryRequest
          ? "explicit_user"
          : "agent_suggested",
        requireMemoryEnabled: false,
      },
    );
    return JSON.stringify({
      ok: true,
      memory: {
        id: memory._id,
        content: memory.content,
        category: memory.category,
      },
    });
  } catch (error: any) {
    if (error?.message === "MEMORY_DISABLED") {
      return JSON.stringify({ ok: false, error: "記憶功能尚未開啟" });
    }
    console.error("[agent-tool:saveMemory]", error);
    return JSON.stringify({ ok: false, error: "記憶儲存失敗" });
  }
}

export async function deleteMemory(args: {
  memoryId: string;
  userId?: string;
}): Promise<string> {
  if (!args.userId) {
    return JSON.stringify({ ok: false, error: "需要登入才能刪除記憶" });
  }
  if (!args.memoryId?.trim()) {
    return JSON.stringify({ ok: false, error: "缺少 memoryId" });
  }
  try {
    const deleted = await memoryService.deleteMemory(
      args.userId,
      args.memoryId.trim(),
    );
    if (!deleted) {
      return JSON.stringify({ ok: false, error: "找不到該筆記憶或無權刪除" });
    }
    return JSON.stringify({ ok: true, deleted: true });
  } catch (error: any) {
    console.error("[agent-tool:deleteMemory]", error);
    return JSON.stringify({ ok: false, error: "記憶刪除失敗" });
  }
}

export async function executeLocalTool(
  name: string,
  args: Record<string, any>,
  userLocation?: { latitude: number; longitude: number },
  userId?: string,
  options: {
    allowMemoryWrite?: boolean;
    explicitMemoryRequest?: boolean;
    lineUserId?: string;
  } = {},
): Promise<string> {
  switch (name) {
    case "findGooglePlaces":
      return findGooglePlaces({
        ...(args as Parameters<typeof findGooglePlaces>[0]),
        userLocation,
      });

    case "findA11yPlaces":
      return findA11yPlaces({
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        range: args.range,
        userLocation,
      });

    case "findCampusAccessibility":
      return findCampusAccessibility({
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        radiusM: args.radiusM,
        city: args.city,
        type: args.type,
        page: args.page,
        limit: args.limit,
        userLocation,
      });

    case "getCampusAccessibilityDetails":
      return getCampusAccessibilityDetails({
        campusId: args.campusId,
        type: args.type,
        limit: args.limit,
      });

    case "planAccessibleRoute":
      return planAccessibleRoute({
        origin: args.origin,
        destination: args.destination,
        mode: args.mode,
        departureTime: args.departureTime,
        userLocation,
      });

    case "getBusRoute":
      return getBusRoute({
        routeName: args.routeName,
        city: args.city,
        userLocation,
      });

    case "getBusRouteDetail":
      return getBusRouteDetail({
        routeName: args.routeName,
        city: args.city,
        userLocation,
      });

    case "getBusArrival":
      return getBusArrival({
        routeName: args.routeName,
        stopName: args.stopName,
        city: args.city,
        direction: args.direction,
        userLocation,
      });

    case "getBusTimetable":
      return getBusTimetable({
        routeName: args.routeName,
        city: args.city,
        afterTime: args.afterTime,
        limit: args.limit,
        userLocation,
      });

    case "getTrainTimetable":
      return getTrainTimetable({
        originStation: args.originStation,
        destinationStation: args.destinationStation,
        date: args.date,
        departAfter: args.departAfter,
        arriveBy: args.arriveBy,
        railSystem: args.railSystem,
      });

    case "getStationTimetable":
      return getStationTimetable({
        station: args.station,
        date: args.date,
        departAfter: args.departAfter,
        railSystem: args.railSystem,
      });

    case "trackBuses":
      return trackBuses({
        routeName: args.routeName,
        city: args.city,
        direction: args.direction,
        userLocation,
      });

    case "findNearbyBusStops":
      return findNearbyBusStops({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radius: args.radius,
        userLocation,
      });

    case "getAirQuality":
      return getAirQuality({
        latitude: args.latitude,
        longitude: args.longitude,
      });

    case "getA11yFacilityDetails":
      return getA11yFacilityDetails({ osmId: args.osmId });

    case "getEnvironmentInfo":
      return getEnvironmentInfo({
        latitude: args.latitude,
        longitude: args.longitude,
        radius: args.radius,
        query: args.query,
        userLocation,
      });

    case "getNearbyHazards":
      return getNearbyHazards({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radiusM: args.radiusM,
        hazardType: args.hazardType,
        userLocation,
      });

    case "findNearbyParking":
      return findNearbyParking({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radiusM: args.radiusM,
        type: args.type,
        userLocation,
      });

    case "getMetroAlerts":
      return getMetroAlerts({ railSystem: args.railSystem });

    case "getTransitAlerts":
      return getTransitAlerts({
        mode: args.mode as any,
        city: args.city as string | undefined,
        routeName: args.routeName as string | undefined,
        railSystem: args.railSystem as string | undefined,
        trainNo: args.trainNo as string | undefined,
        stopName: args.stopName as string | undefined,
        direction:
          typeof args.direction === "number" ? args.direction : undefined,
        userLocation,
      });

    case "getNavInstructions":
      return getNavInstructions({
        origin: args.origin as string,
        destination: args.destination as string,
        mode: args.mode as string | undefined,
        departureTime: args.departureTime as string | undefined,
        routeIndex: args.routeIndex as number | undefined,
        userHeading: args.userHeading as number | undefined,
        userLocation,
      });

    case "saveMemory":
      return saveMemory({
        content: args.content as string,
        category: args.category as string,
        userId,
        allowMemoryWrite: options.allowMemoryWrite,
        explicitMemoryRequest: options.explicitMemoryRequest,
      });

    case "deleteMemory":
      return deleteMemory({
        memoryId: args.memoryId as string,
        userId,
      });

    case "searchAccessibilityGuide":
      return searchAccessibilityGuide({
        query: args.query as string,
      });

    case "bindEmergencyContactCode":
      return bindEmergencyContactCode(
        { code: args.code as string },
        options.lineUserId,
      );

    case "bindLineAccountCode":
      return bindLineAccountCode(
        { code: args.code as string },
        options.lineUserId,
      );

    case "getActiveSosContext":
      return getActiveSosContext({}, options.lineUserId);

    case "getSosLiveLocation":
      return getSosLiveLocation(
        { sessionId: args.sessionId as string },
        options.lineUserId,
      );

    case "planRouteToSosVictim":
      return planRouteToSosVictim(
        {
          sessionId: args.sessionId as string,
          mode: args.mode as string | undefined,
          departureTime: args.departureTime as string | undefined,
        },
        options.lineUserId,
      );

    case "findSosNearbyPlaces":
      return findSosNearbyPlaces(
        {
          sessionId: args.sessionId as string,
          query: args.query as string,
          maxResults: args.maxResults as number | undefined,
        },
        options.lineUserId,
      );

    case "findSosNearbyA11yPlaces":
      return findSosNearbyA11yPlaces(
        {
          sessionId: args.sessionId as string,
          query: args.query as string,
          range: args.range as number | undefined,
        },
        options.lineUserId,
      );

    case "getSosEnvironmentInfo":
      return getSosEnvironmentInfo(
        {
          sessionId: args.sessionId as string,
          radius: args.radius as number | undefined,
        },
        options.lineUserId,
      );

    case "confirmSosReceived":
      return confirmSosReceived(
        { sessionId: args.sessionId as string | undefined },
        options.lineUserId,
      );

    case "claimSosEvent":
      return claimSosEvent(
        { sessionId: args.sessionId as string | undefined },
        options.lineUserId,
      );

    case "updateSosHandlingStatus":
      return updateSosHandlingStatus(
        {
          sessionId: args.sessionId as string | undefined,
          status: args.status as string | undefined,
          note: args.note as string | undefined,
        },
        options.lineUserId,
      );

    case "resolveSosEvent":
      return resolveSosEvent(
        { sessionId: args.sessionId as string | undefined },
        options.lineUserId,
      );

    case "webSearch":
      return webSearch({
        query: args.query as string,
      });

    default:
      return JSON.stringify({ error: `未知工具：${name}` });
  }
}
