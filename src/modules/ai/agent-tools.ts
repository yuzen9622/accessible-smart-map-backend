import { z } from "zod";
import type { VenueRoute } from "../accessible-route/venue-leg.types";
import type { AgentLanguage } from "../../types/agent";
import { apiErrorMessage } from "../../constants/api-errors";
import {
  AgentNavOptionsSchema,
  AgentAccessibilityOptionsSchema,
} from "../../schemas/agent-route.schema";
import { randomUUID } from "crypto";
import { attachRouteTokens } from "../accessible-route/route-token.service";
import {
  AGENT_ROUTE_CONTRACT_VERSION,
  agentRouteError,
} from "../../constants/agent-route";
import type { CanonicalPlanRouteRequest } from "../accessible-route/accessible-route.types";
import * as a11yService from "../a11y/a11y.service";
import * as a11yOrchestration from "../a11y/a11y.orchestration";
import * as busService from "../transit/bus.service";
import * as metroService from "../transit/metro.service";
import * as trainService from "../transit/train.service";
import * as alertService from "../transit/alert.service";
import { getRailAlertsByName } from "../transit/alert-scope";
import * as airService from "../air/air.service";
import * as campusService from "../campus/campus.service";
import { cityFilter } from "../campus/campus.util";
import * as hazardService from "../hazard-report/hazard-report.service";
import { getActiveRoadIncidents } from "../traffic/road-incident.service";
import { haversineMeters } from "../../utils/geo";
import { isBusDirection } from "../../utils/transit-text";
import { getEnvironmentInfo as fetchEnvironment } from "../environment/environment.service";
import { ThinkingLevel, type GroundingChunk } from "@google/genai";
import { getWebSearchTimeoutMs, googleGenAi, model } from "../../config/ai";
import { getCoordinates, searchPlaces } from "../../adapters/google.adapter";
import { bindEmergencyContactCode as bindEmergencyCode } from "../emergency-contact/emergency-contact.service";
import {
  accessibilityModeFromProfile,
  bindLineAccountCode as bindAccountCode,
  getConfig,
} from "../user/user.service";
import {
  inspectVenueByQuery,
  planVenueRoute,
  resolveVenueQuery,
} from "../venue/venue.service";
import { InspectVenueArgsSchema } from "../venue/venue.inspect";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { generateNavInstructionsFromInput } from "../nav-instructions/nav-instructions.service";
import {
  getAuthorizedSessionForLineUser,
  getActiveSosChoicesForLineUser,
  acknowledgeSession,
  claimSession,
  updateHandlingStatus,
  resolveSession as resolveSosSession,
} from "../sos/sos.service";
import { slimFacility } from "../accessible-route/facility-slim";
import EmergencyContact from "../../model/emergency-contact.model";
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
import {
  ERROR_MESSAGE,
  LINE_MSG,
  VENUE_INSPECT_MSG,
} from "../../constants/messages";
import { TransitPreferenceSchema } from "../../schemas/transit-preference.schema";
import type {
  AccessibilityMode,
  DriveLeg,
  TravelMode,
} from "../../types/route";
import { forLineExternalOpen, sosTrackingUrl } from "../../config/public-links";
import type { TaiwanCityEn } from "../../types/transit";

/** Keep legacy service call arity when no trusted session language was supplied. */
function sourceLanguageArgs(language?: AgentLanguage): [AgentLanguage?] {
  return language === undefined ? [] : [language];
}

export async function findGooglePlaces(args: {
  query: string;
  locationQuery?: string;
  language?: AgentLanguage;
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
    const locationQuery = args.locationQuery?.trim();
    const explicitCenter = locationQuery
      ? await getCoordinates(locationQuery)
      : null;
    if (locationQuery && !explicitCenter)
      return JSON.stringify({
        ok: false,
        reason: "LOCATION_NOT_FOUND",
        locationQuery,
      });
    const location =
      explicitCenter ??
      (hasValidPair
        ? { latitude: args.latitude!, longitude: args.longitude! }
        : args.userLocation);
    const places = await searchPlaces(args.query, {
      latitude: location?.latitude,
      longitude: location?.longitude,
      sortByDistance: Boolean(location),
      ...(args.language ? { lang: args.language } : {}),
    });
    if (!places.length)
      return JSON.stringify({ status: "ZERO_RESULTS", places: [] });
    return JSON.stringify({ status: "OK", places });
  } catch (error: any) {
    console.error("[agent-tool:findGooglePlaces]", error.message);
    return JSON.stringify({
      reason: "PLACE_SEARCH_FAILED",
      error: args.language
        ? apiErrorMessage("PLACE_SEARCH_FAILED", args.language)
        : "Google Places API 查詢失敗",
    });
  }
}

export async function findA11yPlaces(args: {
  language?: AgentLanguage;
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
      ...sourceLanguageArgs(args.language),
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

function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
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

/** Apply the tool's city filter and paging to a distance-sorted nearby list. */
function pageNearbyCampuses<T extends { city?: string }>(
  campuses: T[],
  city: string | undefined,
  page: number,
  limit: number,
) {
  const cityPattern = city?.trim()
    ? new RegExp(cityFilter(city.trim()).$regex)
    : undefined;
  const inCity = cityPattern
    ? campuses.filter((campus) => cityPattern.test(campus.city ?? ""))
    : campuses;
  return {
    total: inCity.length,
    page,
    totalPages: Math.ceil(inCity.length / limit),
    campuses: inCity.slice((page - 1) * limit, page * limit),
  };
}

export async function findCampusAccessibility(args: {
  language?: AgentLanguage;
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
        ...sourceLanguageArgs(args.language),
      );
      return JSON.stringify({
        ok: true,
        mode: "nearby",
        query: args.query ?? null,
        searchLocation: {
          lat: coordsInput.latitude,
          lng: coordsInput.longitude,
        },
        ...pageNearbyCampuses(campuses, args.city, page, limit),
      });
    }

    const keywordResult = await campusService.findAll(
      {
        city: args.city,
        type: args.type,
        keyword: args.query,
        page,
        limit,
      },
      ...sourceLanguageArgs(args.language),
    );
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
      ...sourceLanguageArgs(args.language),
    );
    return JSON.stringify({
      ok: true,
      mode: "nearby",
      query: args.query,
      searchLocation: { lat: coords.latitude, lng: coords.longitude },
      ...pageNearbyCampuses(campuses, args.city, page, limit),
    });
  } catch (error: any) {
    console.error("[agent-tool:findCampusAccessibility]", error);
    return JSON.stringify({ ok: false, error: "校園無障礙資料查詢失敗" });
  }
}

export async function getCampusAccessibilityDetails(args: {
  language?: AgentLanguage;
  campusId: number;
  type?: string;
  limit?: number;
}): Promise<string> {
  try {
    const campus = await campusService.findByCampusId(
      args.campusId,
      ...sourceLanguageArgs(args.language),
    );
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
        displaySchoolName: campus.displaySchoolName,
        displayBranchName: campus.displayBranchName,
        displayAddress: campus.displayAddress,
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

/**
 * Mode for `inspectVenue` route costs: the explicit one, else the one the
 * caller's stored profile implies, else `normal`. Read-only: never creates a
 * Config document.
 */
async function inspectVenueMode(
  explicit: AccessibilityMode | undefined,
  userId: string | undefined,
): Promise<AccessibilityMode> {
  if (explicit) return explicit;
  if (!userId) return "normal";
  try {
    const config = await getConfig(userId);
    return accessibilityModeFromProfile(config?.accessibility) ?? "normal";
  } catch (error) {
    console.error("[agent-tool:inspectVenue] profile read failed", error);
    return "normal";
  }
}

export async function inspectVenue(args: {
  raw: Record<string, unknown>;
  language?: AgentLanguage;
  userId?: string;
}): Promise<string> {
  const messages = VENUE_INSPECT_MSG[args.language === "en" ? "en" : "zh-TW"];
  const parsed = InspectVenueArgsSchema.safeParse(args.raw);
  if (!parsed.success)
    return JSON.stringify({
      ok: false,
      reason: "INVALID_ARGUMENTS",
      error: messages.INVALID_ARGUMENTS,
    });
  try {
    const mode = await inspectVenueMode(parsed.data.mode, args.userId);
    const result = await inspectVenueByQuery(parsed.data, mode);
    return JSON.stringify(
      result.ok ? result : { ...result, error: messages[result.reason] },
    );
  } catch (error) {
    console.error("[agent-tool:inspectVenue]", error);
    return JSON.stringify({ ok: false, error: messages.FAILED });
  }
}

const PlanIndoorRouteArgsSchema = z.object({
  venue: z.string().trim().min(1).max(100).optional(),
  fromPlaceId: z.string().trim().min(1).max(200),
  toPlaceId: z.string().trim().min(1).max(200),
  mode: z
    .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
    .optional(),
});

/**
 * An indoor-only trip as a navigable route: no outdoor legs, the venue leg
 * travels in the token, so voice navigation can start it like any route.
 */
function indoorOnlyRoute(
  venueRoute: VenueRoute,
  language?: AgentLanguage,
): AccessibleRoute {
  return {
    routeId: `indoor:${venueRoute.fromPlaceId}>${venueRoute.toPlaceId}`,
    routeName: language === "en" ? "Indoor route" : "室內路線",
    totalMinutes: Math.max(1, Math.round(venueRoute.durationS / 60)),
    transferCount: 0,
    legs: [],
    accessibilityHighlights: [],
  };
}

function indoorOnlyCanonical(
  venueRoute: VenueRoute,
): CanonicalPlanRouteRequest {
  const [startLng, startLat] = venueRoute.path.coordinates[0] ?? [0, 0];
  const [endLng, endLat] = venueRoute.path.coordinates.at(-1) ?? [0, 0];
  const stepFree = venueRoute.mode !== "normal";
  return {
    origin: { latitude: startLat, longitude: startLng },
    destination: { latitude: endLat, longitude: endLng },
    userLocation: { latitude: startLat, longitude: startLng },
    travelMode: "walk",
    mode: venueRoute.mode,
    maxTransfers: 0,
    format: "standard",
    waypoints: [],
    avoidStairs: stepFree,
    requireElevator: false,
    needsAccessibleToilet: false,
    needsHandrail: false,
  };
}

/**
 * Plans a route between two places of one indoor venue with the venue
 * planner, so the assistant never has to describe indoor directions itself.
 */
export async function planIndoorRoute(args: {
  raw: Record<string, unknown>;
  language?: AgentLanguage;
  userId?: string;
}): Promise<string> {
  const messages = VENUE_INSPECT_MSG[args.language === "en" ? "en" : "zh-TW"];
  const parsed = PlanIndoorRouteArgsSchema.safeParse(args.raw);
  if (!parsed.success)
    return JSON.stringify({
      ok: false,
      reason: "INVALID_ARGUMENTS",
      error: messages.INVALID_ARGUMENTS,
    });
  try {
    const venue = await resolveVenueQuery(parsed.data.venue);
    if (!venue.ok)
      return JSON.stringify({ ...venue, error: messages.VENUE_NOT_FOUND });
    const mode = await inspectVenueMode(parsed.data.mode, args.userId);
    const result = await planVenueRoute({
      venueId: venue.venueId,
      fromPlaceId: parsed.data.fromPlaceId,
      toPlaceId: parsed.data.toPlaceId,
      mode,
      lang: args.language === "en" ? "en" : "zh-TW",
    });
    if (result.ok) {
      const [route] = await attachRouteTokens(
        [indoorOnlyRoute(result.route, args.language)],
        indoorOnlyCanonical(result.route),
        { departure: result.route },
      );
      return JSON.stringify({
        ok: true,
        venueId: result.route.venueId,
        mode: result.route.mode,
        // the full leg for clients to draw; the model sees it as steps only
        venueLeg: result.route,
        selectedRouteId: route.routeId,
        routes: [route],
      });
    }
    if (!("data" in result))
      return JSON.stringify({
        ok: false,
        reason: "PLACE_NOT_FOUND",
        error: messages.PLACE_NOT_FOUND,
      });
    return JSON.stringify({
      ok: false,
      mode,
      error: result.error,
      ...result.data,
    });
  } catch (error) {
    console.error("[agent-tool:planIndoorRoute]", error);
    return JSON.stringify({ ok: false, error: messages.FAILED });
  }
}

function summarizeLeg(
  leg: WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg | DriveLeg,
): Record<string, unknown> {
  const displayFields = Object.fromEntries(
    Object.entries(leg).filter(
      ([key, value]) =>
        [
          "fromDisplayName",
          "toDisplayName",
          "routeDisplayName",
          "terminalDisplayName",
        ].includes(key) && typeof value === "string",
    ),
  );
  if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") {
    return {
      type: leg.type,
      ...displayFields,
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
      ...displayFields,
      from: leg.from,
      to: leg.to,
      distanceM: leg.distanceM,
      minutesEst: leg.minutesEst,
    };
  }
  if (leg.type === "BUS") {
    return {
      type: "BUS",
      ...displayFields,
      rideMinutes: leg.rideMinutes,
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
      ...displayFields,
      railSystem: leg.railSystem,
      lineId: leg.lineId,
      lineName: leg.lineName,
      ...(leg.terminalStation ? { terminalStation: leg.terminalStation } : {}),
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
      ...displayFields,
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
      ...displayFields,
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

const TRAVEL_MODES: readonly TravelMode[] = [
  "transit",
  "drive",
  "motorcycle",
  "walk",
];

function parseTravelMode(
  value: string | undefined,
): { ok: true; value?: TravelMode } | { ok: false } {
  if (value === undefined) return { ok: true };
  return TRAVEL_MODES.includes(value as TravelMode)
    ? { ok: true, value: value as TravelMode }
    : { ok: false };
}

/** Only public effective conditions; never includes account identity or capability tokens. */
function agentEffectivePreferences(request: CanonicalPlanRouteRequest) {
  const {
    mode,
    travelMode,
    transitPreference,
    maxTransfers,
    avoidStairs,
    requireElevator,
    departureTime,
    needsAccessibleToilet,
    needsHandrail,
    maxSlopePercent,
  } = request;
  return {
    mode,
    travelMode,
    transitPreference: transitPreference ?? "none",
    maxTransfers,
    avoidStairs,
    requireElevator,
    ...(departureTime ? { departureTime } : {}),
    needsAccessibleToilet,
    needsHandrail,
    ...(maxSlopePercent === undefined ? {} : { maxSlopePercent }),
  };
}

export async function planAccessibleRoute(args: {
  origin?: string;
  destination?: string;
  /** A place inside an indoor venue the trip starts from (from inspectVenue). */
  originPlaceId?: string;
  /** A place inside an indoor venue the trip ends at (from inspectVenue). */
  destinationPlaceId?: string;
  venue?: string;
  language?: AgentLanguage;
  mode?: string;
  travelMode?: string;
  transitPreference?: string;
  departureTime?: string;
  userLocation?: { latitude: number; longitude: number };
  userId?: string;
  avoidStairs?: boolean;
  requireElevator?: boolean;
}): Promise<string> {
  const { origin, destination, mode, departureTime } = args;
  const originPlaceId = args.originPlaceId?.trim() || undefined;
  const destinationPlaceId = args.destinationPlaceId?.trim() || undefined;
  if (
    (originPlaceId && destinationPlaceId) ||
    (!originPlaceId && !origin) ||
    (!destinationPlaceId && !destination)
  ) {
    return JSON.stringify({
      ok: false,
      reason: "INVALID_ROUTE_ARGUMENTS",
      error:
        originPlaceId && destinationPlaceId
          ? args.language === "en"
            ? "Both ends are inside the venue; use planIndoorRoute."
            : "起訖都在校內，請改用 planIndoorRoute。"
          : agentRouteError("INVALID_ROUTE_ARGUMENTS", args.language),
    });
  }

  const travelMode = parseTravelMode(args.travelMode);
  if (!travelMode.ok) {
    return JSON.stringify({
      ok: false,
      reason: "INVALID_ROUTE_ARGUMENTS",
      error: agentRouteError("INVALID_ROUTE_ARGUMENTS", args.language),
    });
  }

  const preference = TransitPreferenceSchema.optional().safeParse(
    args.transitPreference,
  );
  if (!preference.success) {
    return JSON.stringify({
      ok: false,
      reason: "INVALID_ROUTE_ARGUMENTS",
      error:
        args.language === "en"
          ? agentRouteError("INVALID_ROUTE_ARGUMENTS", args.language)
          : ERROR_MESSAGE.INVALID_TRANSIT_PREFERENCE,
    });
  }
  try {
    const validMode = [
      "wheelchair",
      "elderly",
      "visual_impaired",
      "normal",
    ].includes(mode ?? "")
      ? (mode as "wheelchair" | "elderly" | "visual_impaired" | "normal")
      : undefined;

    // "current_location" only resolves via the caller-injected GPS fix; every
    // other origin and the destination are passed through verbatim so the SHARED
    // planner geocodes them — identical to POST /a11y/accessible-route. This keeps
    // the agent and the HTTP endpoint from ever drifting on geocoding, city
    // resolution or the transfer limit again. maxTransfers is 2 because realistic
    // cross-city trips (e.g. 雙鐵/高鐵接駁) routinely need two transfers.
    if (!originPlaceId && origin === "current_location" && !args.userLocation) {
      return JSON.stringify({
        ok: false,
        reason: "LOCATION_REQUIRED",
        error: agentRouteError("LOCATION_REQUIRED", args.language),
      });
    }
    const originInput =
      origin === "current_location" ? args.userLocation : origin;
    let venueId: string | undefined;
    if (originPlaceId || destinationPlaceId) {
      const venue = await resolveVenueQuery(args.venue);
      if (!venue.ok)
        return JSON.stringify({
          ...venue,
          error:
            VENUE_INSPECT_MSG[args.language === "en" ? "en" : "zh-TW"]
              .VENUE_NOT_FOUND,
        });
      venueId = venue.venueId;
    }

    const result = await planAccessibleRouteFromRequest({
      ...(originPlaceId && venueId
        ? { originVenuePlace: { venueId, placeId: originPlaceId } }
        : { origin: originInput }),
      ...(destinationPlaceId && venueId
        ? { destinationVenuePlace: { venueId, placeId: destinationPlaceId } }
        : { destination }),
      userLocation: args.userLocation,
      mode: validMode,
      userId: args.userId,
      avoidStairs: args.avoidStairs,
      requireElevator: args.requireElevator,
      maxTransfers: 2,
      ...(travelMode.value ? { travelMode: travelMode.value } : {}),
      transitPreference: preference.data,
      departureTime,
      ...(args.language ? { language: args.language } : {}),
    });

    if (!result.ok) {
      return JSON.stringify({
        ok: false,
        error: result.error,
        ...(result.data ?? {}),
      });
    }

    const { _canonicalRequest: canonical, ...publicData } = result.data;
    if (!result.data.routes.length)
      return JSON.stringify({
        ok: false,
        reason: "EMPTY_ROUTES",
        error: agentRouteError("EMPTY_ROUTES", args.language),
      });
    if (!canonical)
      return JSON.stringify({
        ok: false,
        reason: "ROUTE_CONTEXT_UNAVAILABLE",
        error: agentRouteError("ROUTE_CONTEXT_UNAVAILABLE", args.language),
      });
    const routes = await attachRouteTokens(result.data.routes, canonical, {
      departure: result.data.venueDepartureLeg,
      arrival: result.data.venueLeg,
    });
    const effectivePreferences = agentEffectivePreferences(canonical);
    return JSON.stringify({
      ...publicData,
      ok: true,
      routeContractVersion: AGENT_ROUTE_CONTRACT_VERSION,
      planId: randomUUID(),
      selectedRouteId: routes[0].routeId,
      origin: {
        ...result.data.origin,
        name:
          originPlaceId ??
          (origin === "current_location"
            ? args.language === "en"
              ? "Current location"
              : "目前位置"
            : origin),
      },
      destination: {
        ...result.data.destination,
        name: destinationPlaceId ?? destination,
      },
      mode: effectivePreferences.mode,
      transitPreference: effectivePreferences.transitPreference,
      effectivePreferences,
      routes,
      metroAlerts: result.data.metroAlerts ?? [],
      transitAlerts: result.data.transitAlerts ?? [],
    });
  } catch (error: any) {
    console.error("[agent-tool:planAccessibleRoute]", error);
    return JSON.stringify({
      ok: false,
      reason: "ROUTE_PLANNING_FAILED",
      error: agentRouteError("ROUTE_PLANNING_FAILED", args.language),
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
  language?: AgentLanguage;
  routeName: string;
  city?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRouteInfo({
      ...(args.language ? { lang: args.language } : {}),
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
  language?: AgentLanguage;
  routeName: string;
  city?: string;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRouteDetail({
      ...(args.language ? { lang: args.language } : {}),
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
  language?: AgentLanguage;
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
      ...(args.language ? { lang: args.language } : {}),
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
  language?: AgentLanguage;
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
      ...(args.language ? { lang: args.language } : {}),
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
  language?: AgentLanguage;
  originStation: string;
  destinationStation: string;
  date?: string;
  departAfter?: string;
  arriveBy?: string;
  railSystem?: "TRA" | "THSR";
}): Promise<string> {
  try {
    const { language, ...params } = args;
    const result = await trainService.getTrainTimetable({
      ...params,
      ...(language ? { lang: language } : {}),
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getTrainTimetable]", error);
    return JSON.stringify({ ok: false, error: "火車時刻表查詢失敗" });
  }
}

export async function getStationTimetable(args: {
  language?: AgentLanguage;
  station: string;
  date?: string;
  departAfter?: string;
  railSystem?: "TRA" | "THSR";
}): Promise<string> {
  try {
    const { language, ...params } = args;
    const result = await trainService.getStationTimetable({
      ...params,
      ...(language ? { lang: language } : {}),
    });
    return JSON.stringify(result);
  } catch (error: any) {
    console.error("[agent-tool:getStationTimetable]", error);
    return JSON.stringify({ ok: false, error: "車站時刻表查詢失敗" });
  }
}

export async function trackBuses(args: {
  language?: AgentLanguage;
  routeName: string;
  city?: string;
  direction?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  try {
    const city = await resolveBusCityOrError(args.city, args.userLocation);
    if (typeof city !== "string") return JSON.stringify({ ok: false, ...city });
    const result = await busService.getBusRealtimeOnRoute({
      ...(args.language ? { lang: args.language } : {}),
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
  language?: AgentLanguage;
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
      ...(args.language ? { lang: args.language } : {}),
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
  language?: AgentLanguage;
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
    const places = await a11yService.findByOsmIds(
      ids,
      ...sourceLanguageArgs(args.language),
    );
    if (!places.length) {
      return JSON.stringify({
        ok: false,
        error: `找不到 osmId: ${ids.join(", ")} 的設施`,
      });
    }
    return JSON.stringify({
      ok: true,
      count: places.length,
      // The drill-down tool: list tools stay slim, details carry every OSM tag.
      facilities: places.map((place) => ({
        ...slimFacility(place),
        tags: place.tags ?? {},
      })),
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

const ROAD_EVENT_DEFAULT_RADIUS_M = 500;
const ROAD_EVENT_MAX_RADIUS_M = 5000;
const ROAD_EVENT_LIMIT = 15;

/**
 * Government road events (TDX LiveEvent; Taipei enriched with permit closure
 * flags) within a radius, nearest first. Fail-soft: an empty list on error.
 *
 * @param lat Search centre latitude.
 * @param lng Search centre longitude.
 * @param radiusM Search radius in metres.
 * @param hazardType Optional hazard type filter.
 * @returns The nearest events, each tagged `source: "government"`.
 */
async function nearbyRoadEvents(
  lat: number,
  lng: number,
  radiusM: number | undefined,
  hazardType: string | undefined,
) {
  if (hazardType && hazardType !== "construction" && hazardType !== "obstacle")
    return [];
  const radius = Math.min(
    radiusM ?? ROAD_EVENT_DEFAULT_RADIUS_M,
    ROAD_EVENT_MAX_RADIUS_M,
  );
  try {
    const dLat = radius / 111_320;
    const dLng = dLat / Math.cos((lat * Math.PI) / 180);
    const incidents = await getActiveRoadIncidents({
      bbox: [lng - dLng, lat - dLat, lng + dLng, lat + dLat],
    });
    return incidents
      .map((i) => {
        const nearest = (i.points ?? [i.location]).reduce(
          (best, p) => {
            const d = haversineMeters(lat, lng, p.lat, p.lng);
            return d < best.d ? { p, d } : best;
          },
          { p: i.location, d: Infinity },
        );
        return {
          source: "government" as const,
          hazardType: i.title.includes("施工") ? "construction" : "obstacle",
          title: i.title,
          description: i.description ?? null,
          locationDescription: i.locationDescription ?? null,
          severity: i.severity,
          roadClosed: i.roadClosed ?? false,
          endTime: i.endTime ?? null,
          location: nearest.p,
          distanceM: Math.round(nearest.d),
        };
      })
      .filter(
        (e) =>
          e.distanceM <= radius && (!hazardType || e.hazardType === hazardType),
      )
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, ROAD_EVENT_LIMIT);
  } catch (error) {
    console.warn("[agent-tool:getNearbyHazards] road events failed", error);
    return [];
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
    const [reports, roadEvents] = await Promise.all([
      hazardService.findActiveHazardsForAgent({
        lat: latitude,
        lng: longitude,
        radiusM: args.radiusM,
        hazardType: args.hazardType as any,
      }),
      nearbyRoadEvents(latitude, longitude, args.radiusM, args.hazardType),
    ]);
    // Machine-safe projection: controlled enums only, never user free text.
    return JSON.stringify({
      ok: true,
      data: { reports, total: reports.length, roadEvents },
    });
  } catch (error: any) {
    console.error("[agent-tool:getNearbyHazards]", error);
    return JSON.stringify({ ok: false, error: "附近路況查詢失敗" });
  }
}

export async function findNearbyParking(args: {
  language?: AgentLanguage;
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
      ...sourceLanguageArgs(args.language),
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

    let result:
      | alertService.TransitAlertResult
      | Awaited<ReturnType<typeof getRailAlertsByName>>;

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
      result = await alertService.getTransitAlerts({
        mode: "bus",
        city: cityResult as TaiwanCityEn,
        routeName,
        direction: isBusDirection(args.direction) ? args.direction : undefined,
        stopName: args.stopName?.trim() || undefined,
      });
    } else {
      const routeName = args.routeName?.trim() || undefined;
      const numericRoute =
        mode === "tra" && routeName && /^\d+$/.test(routeName);
      result = await getRailAlertsByName({
        mode,
        railSystem: args.railSystem?.trim() || undefined,
        lineName: numericRoute ? undefined : routeName,
        stationName: args.stopName?.trim() || undefined,
        trainNo:
          mode === "tra"
            ? args.trainNo?.trim() || (numericRoute ? routeName : undefined)
            : undefined,
        direction: args.direction,
      });
    }

    if (!result.ok) {
      return JSON.stringify({
        ok: false,
        ...("reason" in result ? { reason: result.reason } : {}),
        error: result.error,
      });
    }

    const alerts = result.alerts;
    return JSON.stringify({
      ok: true,
      mode,
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
  routeToken?: string;
  userHeading?: number;
  language?: "zh-TW" | "en";
  // Legacy callers may still pass these; they never trigger another plan.
  origin?: string;
  destination?: string;
  mode?: string;
  transitPreference?: string;
  departureTime?: string;
  routeIndex?: number;
  userLocation?: { latitude: number; longitude: number };
}): Promise<string> {
  if (!args.routeToken)
    return JSON.stringify({
      ok: false,
      reason: "ROUTE_CONTEXT_REQUIRED",
      error: agentRouteError("ROUTE_CONTEXT_REQUIRED", args.language),
    });
  try {
    const result = await generateNavInstructionsFromInput({
      routeToken: args.routeToken,
      userHeading: args.userHeading,
      language: args.language,
    });
    return JSON.stringify(
      result.ok
        ? { ok: true, ...result.data }
        : { ok: false, reason: result.reason, error: result.message },
    );
  } catch {
    return JSON.stringify({
      ok: false,
      reason: "ROUTE_CONTEXT_UNAVAILABLE",
      error: agentRouteError("ROUTE_CONTEXT_UNAVAILABLE", args.language),
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
  args: { code: string },
  lineUserId?: string,
): Promise<string> {
  return JSON.stringify(await bindEmergencyCode(args.code ?? "", lineUserId));
}

export async function bindLineAccountCode(
  args: { code: string },
  lineUserId?: string,
): Promise<string> {
  return JSON.stringify(await bindAccountCode(args.code ?? "", lineUserId));
}

/** Tool answer once an SOS has ended: its location is no longer shared. */
const SOS_ENDED_RESULT = {
  ok: false,
  error: "此求救已結束，不再提供位置",
} as const;

export async function getActiveSosContext(
  _args: Record<string, unknown>,
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
        trackingUrl: forLineExternalOpen(sosTrackingUrl(session.shareToken)),
      }));

    const latestSession = sessions[0]
      ? {
          sessionId: String(sessions[0]._id),
          ownerUserId: String(sessions[0].userId),
          ownerName:
            userNameById.get(String(sessions[0].userId)) ?? "未知使用者",
          type: sessions[0].type,
          status: sessions[0].status,
          updatedAt: sessions[0].updatedAt,
          // A resolved event no longer reveals where the owner was.
          ...(sessions[0].status === "active"
            ? {
                address: sessions[0].address ?? null,
                lat: sessions[0].lat,
                lng: sessions[0].lng,
                locationUpdatedAt: sessions[0].locationUpdatedAt,
                mapsUrl: googleMapsUrl(sessions[0].lat, sessions[0].lng),
                trackingUrl: forLineExternalOpen(
                  sosTrackingUrl(sessions[0].shareToken),
                ),
              }
            : {}),
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
    if (session.status !== "active") {
      return JSON.stringify({
        ok: true,
        sessionId: session._id,
        ownerName,
        type: session.type,
        status: session.status,
        resolvedAt: session.resolvedAt ?? null,
        message: SOS_ENDED_RESULT.error,
      });
    }
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
      trackingUrl: forLineExternalOpen(sosTrackingUrl(session.shareToken)),
      mapsUrl: googleMapsUrl(session.lat, session.lng),
    });
  } catch (error: any) {
    console.error("[agent-tool:getSosLiveLocation]", error);
    return JSON.stringify({ ok: false, error: "即時位置查詢失敗" });
  }
}

export async function planRouteToSosVictim(
  args: {
    language?: AgentLanguage;
    sessionId: string;
    mode?: string;
    travelMode?: string;
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
  const travelMode = parseTravelMode(args.travelMode);
  if (!travelMode.ok) {
    return JSON.stringify({
      ok: false,
      reason: "INVALID_ROUTE_ARGUMENTS",
      error: agentRouteError("INVALID_ROUTE_ARGUMENTS", args.language),
    });
  }

  try {
    const sessionResult = await getAuthorizedSessionForLineUser(
      lineUserId,
      args.sessionId.trim(),
    );
    if (!sessionResult?.session) {
      return JSON.stringify({ ok: false, error: "找不到可查詢的 SOS session" });
    }

    if (sessionResult.session.status !== "active") {
      return JSON.stringify(SOS_ENDED_RESULT);
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
      keepExactDestination: true,
      ...(args.language ? { language: args.language } : {}),
      mode: validMode,
      ...(travelMode.value ? { travelMode: travelMode.value } : {}),
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
      travelMode: travelMode.value ?? "transit",
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
    language?: AgentLanguage;
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

    if (result.session.status !== "active") {
      return JSON.stringify(SOS_ENDED_RESULT);
    }

    const places = await searchPlaces(args.query.trim(), {
      latitude: result.session.lat,
      longitude: result.session.lng,
      maxResults: args.maxResults ?? 3,
      ...(args.language ? { lang: args.language } : {}),
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
    language?: AgentLanguage;
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

    if (result.session.status !== "active") {
      return JSON.stringify(SOS_ENDED_RESULT);
    }
    const places = await a11yOrchestration.findNearbyLimited(
      result.session.lat,
      result.session.lng,
      args.range ?? 300,
      ...sourceLanguageArgs(args.language),
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

    if (result.session.status !== "active") {
      return JSON.stringify(SOS_ENDED_RESULT);
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

async function runSosReceiptTool(
  action: "ack" | "claim",
  args: { sessionId?: string },
  lineUserId?: string,
): Promise<string> {
  if (!lineUserId)
    return JSON.stringify({ ok: false, error: "LINE 使用者未識別" });
  let actionStarted = false;
  try {
    let sessionId = args.sessionId?.trim();
    if (!sessionId) {
      const page = await getActiveSosChoicesForLineUser(lineUserId);
      if (!page.bound || !page.sessions.length) {
        return JSON.stringify({
          ok: false,
          error: page.bound ? LINE_MSG.SOS_NO_ACTIVE : LINE_MSG.SOS_NO_CONTACTS,
        });
      }
      if (page.sessions.length > 1 || page.hasMore) {
        return JSON.stringify({
          ok: false,
          errorCode: "SOS_SELECTION_REQUIRED",
          error:
            action === "ack"
              ? LINE_MSG.SOS_CHOOSE_ACK
              : LINE_MSG.SOS_CHOOSE_CLAIM,
          sessions: page.sessions,
          hasMore: page.hasMore,
        });
      }
      sessionId = page.sessions[0].sessionId;
    }
    actionStarted = true;
    const result =
      action === "ack"
        ? await acknowledgeSession({ sessionId, lineUserId })
        : await claimSession({ sessionId, lineUserId });
    return JSON.stringify({
      ok: result.ok,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    console.error(
      "[agent-tool:SosReceipt]",
      error instanceof Error ? error.name : "UnknownError",
    );
    return JSON.stringify({
      ok: false,
      error: actionStarted
        ? LINE_MSG.OPERATION_UNCONFIRMED
        : LINE_MSG.SOS_QUERY_FAILED,
    });
  }
}

export async function confirmSosReceived(
  args: { sessionId?: string },
  lineUserId?: string,
): Promise<string> {
  return runSosReceiptTool("ack", args, lineUserId);
}

export async function claimSosEvent(
  args: { sessionId?: string },
  lineUserId?: string,
): Promise<string> {
  return runSosReceiptTool("claim", args, lineUserId);
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

  const signal = AbortSignal.timeout(getWebSearchTimeoutMs());
  try {
    const response = await googleGenAi.models.generateContent({
      model,
      contents: query,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        abortSignal: signal,
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
    if (signal.aborted)
      return JSON.stringify({
        ok: false,
        reason: "WEB_SEARCH_TIMEOUT",
        error: "網路搜尋逾時，請直接告知使用者目前查不到，不要重試",
      });
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
  args: Record<string, unknown>,
  userLocation?: { latitude: number; longitude: number },
  userId?: string,
  options: {
    language?: AgentLanguage;
    allowMemoryWrite?: boolean;
    explicitMemoryRequest?: boolean;
    lineUserId?: string;
    routeToken?: string;
  } = {},
): Promise<string> {
  switch (name) {
    case "findGooglePlaces":
      return findGooglePlaces({
        ...(args as Parameters<typeof findGooglePlaces>[0]),
        userLocation,
        language: options.language,
      });

    case "findA11yPlaces":
      return findA11yPlaces({
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        range: args.range,
        userLocation,
        language: options.language,
      } as Parameters<typeof findA11yPlaces>[0]);

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
        language: options.language,
      } as Parameters<typeof findCampusAccessibility>[0]);

    case "getCampusAccessibilityDetails":
      return getCampusAccessibilityDetails({
        campusId: args.campusId,
        type: args.type,
        limit: args.limit,
        language: options.language,
      } as Parameters<typeof getCampusAccessibilityDetails>[0]);

    case "inspectVenue":
      return inspectVenue({
        raw: args,
        language: options.language,
        userId,
      });

    case "planIndoorRoute":
      return planIndoorRoute({
        raw: args,
        language: options.language,
        userId,
      });

    case "planAccessibleRoute": {
      const accessibility = AgentAccessibilityOptionsSchema.safeParse({
        avoidStairs: args.avoidStairs,
        requireElevator: args.requireElevator,
      });
      if (!accessibility.success)
        return JSON.stringify({
          ok: false,
          reason: "INVALID_ROUTE_ARGUMENTS",
          error: agentRouteError("INVALID_ROUTE_ARGUMENTS", options.language),
        });
      return planAccessibleRoute({
        origin: args.origin,
        destination: args.destination,
        originPlaceId:
          typeof args.originPlaceId === "string"
            ? args.originPlaceId
            : undefined,
        destinationPlaceId:
          typeof args.destinationPlaceId === "string"
            ? args.destinationPlaceId
            : undefined,
        venue: typeof args.venue === "string" ? args.venue : undefined,
        mode: args.mode,
        travelMode: args.travelMode,
        transitPreference: args.transitPreference,
        departureTime: args.departureTime,
        userLocation,
        userId,
        avoidStairs: args.avoidStairs,
        requireElevator: args.requireElevator,
        language: options.language,
      } as Parameters<typeof planAccessibleRoute>[0]);
    }

    case "getBusRoute":
      return getBusRoute({
        routeName: args.routeName,
        city: args.city,
        userLocation,
        language: options.language,
      } as Parameters<typeof getBusRoute>[0]);

    case "getBusRouteDetail":
      return getBusRouteDetail({
        routeName: args.routeName,
        city: args.city,
        userLocation,
        language: options.language,
      } as Parameters<typeof getBusRouteDetail>[0]);

    case "getBusArrival":
      return getBusArrival({
        routeName: args.routeName,
        stopName: args.stopName,
        city: args.city,
        direction: args.direction,
        userLocation,
        language: options.language,
      } as Parameters<typeof getBusArrival>[0]);

    case "getBusTimetable":
      return getBusTimetable({
        routeName: args.routeName,
        city: args.city,
        afterTime: args.afterTime,
        limit: args.limit,
        userLocation,
        language: options.language,
      } as Parameters<typeof getBusTimetable>[0]);

    case "getTrainTimetable":
      return getTrainTimetable({
        originStation: args.originStation,
        destinationStation: args.destinationStation,
        date: args.date,
        departAfter: args.departAfter,
        arriveBy: args.arriveBy,
        railSystem: args.railSystem,
        language: options.language,
      } as Parameters<typeof getTrainTimetable>[0]);

    case "getStationTimetable":
      return getStationTimetable({
        station: args.station,
        date: args.date,
        departAfter: args.departAfter,
        railSystem: args.railSystem,
        language: options.language,
      } as Parameters<typeof getStationTimetable>[0]);

    case "trackBuses":
      return trackBuses({
        routeName: args.routeName,
        city: args.city,
        direction: args.direction,
        userLocation,
        language: options.language,
      } as Parameters<typeof trackBuses>[0]);

    case "findNearbyBusStops":
      return findNearbyBusStops({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radius: args.radius,
        userLocation,
        language: options.language,
      } as Parameters<typeof findNearbyBusStops>[0]);

    case "getAirQuality":
      return getAirQuality({
        latitude: args.latitude,
        longitude: args.longitude,
      } as Parameters<typeof getAirQuality>[0]);

    case "getA11yFacilityDetails":
      return getA11yFacilityDetails({
        osmId: args.osmId as string,
        language: options.language,
      });

    case "getEnvironmentInfo":
      return getEnvironmentInfo({
        latitude: args.latitude,
        longitude: args.longitude,
        radius: args.radius,
        query: args.query,
        userLocation,
      } as Parameters<typeof getEnvironmentInfo>[0]);

    case "getNearbyHazards":
      return getNearbyHazards({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radiusM: args.radiusM,
        hazardType: args.hazardType,
        userLocation,
      } as Parameters<typeof getNearbyHazards>[0]);

    case "findNearbyParking":
      return findNearbyParking({
        latitude: args.latitude,
        longitude: args.longitude,
        query: args.query,
        radiusM: args.radiusM,
        type: args.type,
        userLocation,
        language: options.language,
      } as Parameters<typeof findNearbyParking>[0]);

    case "getMetroAlerts":
      return getMetroAlerts({
        railSystem: args.railSystem as string | undefined,
      });

    case "getTransitAlerts":
      return getTransitAlerts({
        mode: args.mode as string,
        city: args.city as string | undefined,
        routeName: args.routeName as string | undefined,
        railSystem: args.railSystem as string | undefined,
        trainNo: args.trainNo as string | undefined,
        stopName: args.stopName as string | undefined,
        direction:
          typeof args.direction === "number" ? args.direction : undefined,
        userLocation,
      });

    case "getNavInstructions": {
      const navOptions = AgentNavOptionsSchema.safeParse({
        userHeading: args.userHeading,
        language: args.language,
      });
      if (!navOptions.success)
        return JSON.stringify({
          ok: false,
          reason: "INVALID_ROUTE_ARGUMENTS",
          error: agentRouteError("INVALID_ROUTE_ARGUMENTS", options.language),
        });
      return getNavInstructions({
        routeToken: options.routeToken,
        ...navOptions.data,
        language: options.language ?? navOptions.data.language,
      });
    }

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
          travelMode: args.travelMode as string | undefined,
          departureTime: args.departureTime as string | undefined,
          language: options.language,
        },
        options.lineUserId,
      );

    case "findSosNearbyPlaces":
      return findSosNearbyPlaces(
        {
          sessionId: args.sessionId as string,
          query: args.query as string,
          maxResults: args.maxResults as number | undefined,
          language: options.language,
        },
        options.lineUserId,
      );

    case "findSosNearbyA11yPlaces":
      return findSosNearbyA11yPlaces(
        {
          sessionId: args.sessionId as string,
          query: args.query as string,
          range: args.range as number | undefined,
          language: options.language,
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
