/**
 * OTP2 transit planner client.
 *
 * Queries a sidecar OpenTripPlanner 2.x server (GTFS GraphQL API) and maps its
 * itineraries into AccessibleRoute so they enter the same finalizeRoutes()
 * pipeline as the GTFS graph and TDX MaaS planners. This planner does NO a11y
 * enrichment (the orchestrator enriches the final top-3) and never throws: any
 * failure returns [] so the other planners' results still serve.
 *
 * Endpoint: POST {OTP_BASE_URL}/otp/gtfs/v1  (GraphQL)
 */

import { decode } from "@googlemaps/polyline-codec";
import axios from "axios";
import http from "http";
import https from "https";
import { GtfsTrip } from "../../../model/gtfs-trip.model";
import MetroStationModel from "../../../model/metro-station.model";
import TrainStationModel from "../../../model/train-station.model";
import BusStopModel from "../../../model/bus-stop.model";
import { haversineCoords } from "../../../utils/geo";
import { formatWalkStepInstruction } from "../../../utils/transit-text";
import { taipeiHHmm, taipeiYmdDash } from "../../../config/taipei-time";
import { metroLineCode } from "../../../config/transit";
import { walkSpeedMps } from "../scoring";
import type {
  ITdxMetroStation,
  ITdxTrainStation,
  ITdxBusStop,
} from "../../../types";
import type {
  AccessibilityMode,
  AccessibleRoute,
  WalkLeg,
  WalkStep,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WaitInfo,
} from "../../../types/route";
import type {
  OtpStop,
  OtpPlace,
  OtpLeg,
  OtpStep,
  OtpItinerary,
  PlanOtpRouteOptions,
  SnapStop,
} from "./otp-routing.types";
export type {
  PlanOtpRouteOptions,
};

const OTP_TIMEOUT_MS = Number(process.env.OTP_TIMEOUT_MS ?? 30_000);
const OTP_NUM_ITINERARIES = 8;
const OTP_NUM_ITINERARIES_WIDE = 15;
const OTP_SEARCH_WINDOW_S = Number(process.env.OTP_SEARCH_WINDOW_S ?? 3600);
const OTP_SEARCH_WINDOW_WIDE_S = Number(
  process.env.OTP_SEARCH_WINDOW_WIDE_S ?? 28800,
);
const OTP_MIN_DISTINCT_ROUTES = 3;

const otpAgent = new http.Agent({ keepAlive: true });
const otpAgentHttps = new https.Agent({ keepAlive: true });

const otpClient = axios.create({
  httpAgent: otpAgent,
  httpsAgent: otpAgentHttps,
  timeout: OTP_TIMEOUT_MS,
});

const SNAP_RADIUS_M = 2000;

const METRO_SYSTEMS = new Set([
  "TRTC",
  "KRTC",
  "TMRT",
  "NTMC",
  "KLRT",
  "TYMC",
]);

export const SUPPORTED_TRANSIT_MODES = new Set([
  "BUS",
  "TROLLEYBUS",
  "RAIL",
  "SUBWAY",
  "TRAM",
  "MONORAIL",
]);

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

interface Breaker {
  isOpen(): boolean;
  recordFailure(): void;
  recordSuccess(): void;
}

/**
 * Build an isolated circuit breaker: opens after BREAKER_THRESHOLD consecutive
 * failures, stays open for BREAKER_COOLDOWN_MS, and logs each open / recovery
 * transition under `name`. Each breaker owns its own counter so an unrelated
 * caller's failures can never trip it.
 *
 * @param name Identifier used in the breaker's log lines.
 * @returns The breaker handle.
 */
function createBreaker(name: string): Breaker {
  let consecutiveFailures = 0;
  let openUntil = 0;
  return {
    isOpen: () => Date.now() < openUntil,
    recordFailure() {
      consecutiveFailures++;
      if (consecutiveFailures >= BREAKER_THRESHOLD && openUntil <= Date.now()) {
        openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        console.warn(
          `[otp-routing] circuit OPEN (${name}) after ${consecutiveFailures} consecutive failures — pausing ${BREAKER_COOLDOWN_MS / 1000}s`,
        );
      }
    },
    recordSuccess() {
      if (openUntil !== 0 || consecutiveFailures > 0) {
        console.info(`[otp-routing] circuit recovered (${name})`);
      }
      consecutiveFailures = 0;
      openUntil = 0;
    },
  };
}

const planBreaker = createBreaker("plan");
const railGeomBreaker = createBreaker("railgeom");
// Walk-mode routing has its own breaker so its failures never trip the transit
// planner (and vice versa) — the two OTP call paths stay isolated fault domains.
const walkPlanBreaker = createBreaker("walkplan");

const WALK_OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * Whether the main OTP plan circuit is currently open (tripped). Lets callers
 * tell "OTP planner temporarily unavailable" apart from "no route exists", so a
 * skipped plan is not misreported as a 404.
 *
 * @returns True when the plan circuit is open.
 */
export function isOtpCircuitOpen(): boolean {
  return planBreaker.isOpen();
}

function hhmm(epochMs: number): string {
  return taipeiHHmm(new Date(epochMs));
}
const ymdDash = taipeiYmdDash;

/**
 * "1:TXG123" → "TXG123" — restore the TDX id the overlay keys on.
 *
 * @param gtfsId The feed-prefixed GTFS id.
 * @returns The id with the feed prefix stripped.
 */
function stripFeedId(gtfsId: string | undefined): string {
  if (!gtfsId) return "";
  const idx = gtfsId.indexOf(":");
  return idx >= 0 ? gtfsId.slice(idx + 1) : gtfsId;
}

/**
 * System code prefix of a stripped GTFS id, e.g. "TRTC_BL12" → "TRTC".
 *
 * @param id The stripped GTFS id.
 * @returns The system code prefix.
 */
function systemFromId(id: string): string {
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : id;
}

/**
 * Decode OTP's Google-encoded polyline into [lng, lat] pairs (GeoJSON order).
 *
 * @param points The Google-encoded polyline string.
 * @returns The decoded [lng, lat] coordinate pairs.
 */
export function decodeOtpPolyline(points: string | undefined): [number, number][] {
  if (!points) return [];
  try {
    return decode(points, 5).map(([lat, lng]) => [lng, lat] as [number, number]);
  } catch {
    return [];
  }
}

function isTransitLeg(leg: OtpLeg): boolean {
  return leg.mode !== "WALK";
}

/**
 * Train number from a stripped rail trip id ("TRA_1003_…" → "1003").
 *
 * @param tripId The stripped rail trip id.
 * @returns The train number, or null when not parseable.
 */
function trainNoFromTripId(tripId: string): string | null {
  return tripId.match(/^(?:TRA|THSR)_(\d+)/)?.[1] ?? null;
}

/**
 * Explicit transport-mode allowlist for the OTP plan query, derived from
 * SUPPORTED_TRANSIT_MODES so the query and the downstream filter share one
 * source of truth. Requesting these instead of the broad `TRANSIT` composite
 * stops OTP from ever returning AIRPLANE/FERRY (e.g. offshore-island) legs.
 */
const PLAN_TRANSPORT_MODES = ["WALK", ...SUPPORTED_TRANSIT_MODES]
  .map((mode) => `{ mode: ${mode} }`)
  .join(", ");

export const PLAN_QUERY = `
query Plan(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!,
  $wheelchair: Boolean!, $numItineraries: Int!, $walkSpeed: Float,
  $searchWindow: Long
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    wheelchair: $wheelchair
    walkSpeed: $walkSpeed
    numItineraries: $numItineraries
    searchWindow: $searchWindow
    transportModes: [${PLAN_TRANSPORT_MODES}]
    locale: "zh-TW"
  ) {
    itineraries {
      duration
      walkDistance
      legs {
        mode
        startTime
        endTime
        duration
        distance
        from { name stop { gtfsId code lat lon } }
        to { name stop { gtfsId code lat lon } }
        route { gtfsId shortName longName type agency { gtfsId } }
        trip { gtfsId wheelchairAccessible }
        legGeometry { points }
        intermediatePlaces { name lat lon stop { gtfsId code lat lon } }
        steps {
          distance
          lon
          lat
          relativeDirection
          absoluteDirection
          streetName
          area
          bogusName
        }
      }
    }
  }
}`;

async function queryOtpPlan(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  departure: Date,
  wheelchair: boolean,
  walkSpeed: number,
  numItineraries: number,
  searchWindowSec: number,
): Promise<OtpItinerary[]> {
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const response = await otpClient.post(`${baseUrl}/otp/routers/default/index/graphql`, {
    query: PLAN_QUERY,
    variables: {
      fromLat: origin.lat,
      fromLon: origin.lng,
      toLat: destination.lat,
      toLon: destination.lng,
      date: ymdDash(departure),
      time: hhmm(departure.getTime()),
      wheelchair,
      walkSpeed,
      numItineraries,
      searchWindow: searchWindowSec,
    },
  });
  const json = response.data as {
    data?: { plan?: { itineraries?: OtpItinerary[] } };
    errors?: { message?: string }[];
  };
  if (json.errors?.length) {
    throw new Error(`OTP GraphQL: ${json.errors[0]?.message ?? "unknown"}`);
  }
  return json.data?.plan?.itineraries ?? [];
}

const WALK_QUERY = `
query Walk(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!,
  $wheelchair: Boolean!, $numItineraries: Int!, $walkSpeed: Float
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    wheelchair: $wheelchair
    walkSpeed: $walkSpeed
    numItineraries: $numItineraries
    transportModes: [{ mode: WALK }]
    locale: "zh-TW"
  ) {
    itineraries {
      duration
      walkDistance
      legs {
        mode
        startTime
        endTime
        duration
        distance
        from { name }
        to { name }
        legGeometry { points }
        steps {
          distance
          lon
          lat
          relativeDirection
          absoluteDirection
          streetName
          area
          bogusName
        }
      }
    }
  }
}`;

async function queryOtpWalk(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  departure: Date,
  wheelchair: boolean,
  walkSpeed: number,
): Promise<OtpItinerary[]> {
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const response = await otpClient.post(`${baseUrl}/otp/routers/default/index/graphql`, {
    query: WALK_QUERY,
    variables: {
      fromLat: origin.lat,
      fromLon: origin.lng,
      toLat: destination.lat,
      toLon: destination.lng,
      date: ymdDash(departure),
      time: hhmm(departure.getTime()),
      wheelchair,
      walkSpeed,
      numItineraries: OTP_NUM_ITINERARIES,
    },
  });
  const json = response.data as {
    data?: { plan?: { itineraries?: OtpItinerary[] } };
    errors?: { message?: string }[];
  };
  if (json.errors?.length) {
    throw new Error(`OTP GraphQL: ${json.errors[0]?.message ?? "unknown"}`);
  }
  return json.data?.plan?.itineraries ?? [];
}

/**
 * Plan a pure walking route via OTP2 (pedestrian), so `travelMode=walk` uses the
 * same street engine as the walking legs inside transit routing. Uses its own
 * circuit breaker, filters to genuinely walk-only itineraries with usable
 * geometry, and is fail-soft ([]) so the caller can fall back to Valhalla. Does
 * NOT run the transit stop-snap retry.
 *
 * @param origin The origin coordinate.
 * @param destination The destination coordinate.
 * @param opts Optional accessibility mode (drives wheelchair routing + walk speed).
 * @returns Walk-only AccessibleRoutes (top 3), or [] when none are usable.
 */
export async function planOtpWalk(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: { mode?: AccessibilityMode },
): Promise<AccessibleRoute[]> {
  if (walkPlanBreaker.isOpen()) return [];
  const mode = opts?.mode ?? "normal";
  const wheelchair = mode === "wheelchair";
  const walkSpeed = walkSpeedMps(mode);

  let itineraries: OtpItinerary[];
  try {
    itineraries = await queryOtpWalk(origin, destination, new Date(), wheelchair, walkSpeed);
    walkPlanBreaker.recordSuccess();
  } catch (err) {
    walkPlanBreaker.recordFailure();
    console.warn("[otp-routing] walk query failed (fail-soft to [])", err);
    return [];
  }

  const out: AccessibleRoute[] = [];
  for (const it of itineraries) {
    if (!it.legs.length || !it.legs.every((l) => l.mode === "WALK")) continue;
    const legs = it.legs.map((l, i) => walkLegFrom(l, i === 0, i === it.legs.length - 1));
    if (!legs.every((l) => l.polyline.length >= 2)) continue;
    const totalWalkDistanceM = Number.isFinite(it.walkDistance)
      ? Math.round(it.walkDistance as number)
      : Math.round(legs.reduce((sum, l) => sum + l.distanceM, 0));
    out.push({
      routeId: `walk-${out.length}`,
      routeName: "步行",
      totalMinutes: Math.max(1, Math.round(it.duration / 60)),
      transferCount: 0,
      legs,
      accessibilityHighlights: [],
      totalWalkDistanceM,
      attribution: WALK_OSM_ATTRIBUTION,
    });
    if (out.length >= 3) break;
  }
  return out;
}

const RAIL_GEOMETRY_QUERY = `
query RailGeom(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    numItineraries: 1
    transportModes: [{ mode: WALK }, { mode: RAIL }]
    locale: "zh-TW"
  ) {
    itineraries { legs { mode legGeometry { points } } }
  }
}`;

/**
 * Real track polyline ([lng,lat], GeoJSON order) for a rail OD via OTP. Transit
 * legs are concatenated and consecutive duplicate points dropped (OTP repeats a
 * point at stop joins).
 *
 * @param from The [lat, lng] origin.
 * @param to The [lat, lng] destination.
 * @param dateYmd The service date in YYYY-MM-DD form.
 * @param timeHHmm The departure time in "HH:mm" form.
 * @returns The track polyline, or null (OTP down / no itinerary / empty).
 */
export async function fetchRailLegGeometry(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  dateYmd: string,
  timeHHmm: string,
): Promise<[number, number][] | null> {
  if (railGeomBreaker.isOpen()) return null;
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  try {
    const response = await otpClient.post(`${baseUrl}/otp/routers/default/index/graphql`, {
      query: RAIL_GEOMETRY_QUERY,
      variables: {
        fromLat: from.lat,
        fromLon: from.lng,
        toLat: to.lat,
        toLon: to.lng,
        date: dateYmd,
        time: timeHHmm,
      },
    });
    const json = response.data as {
      data?: {
        plan?: {
          itineraries?: {
            legs?: { mode: string; legGeometry?: { points?: string } | null }[];
          }[];
        };
      };
    };
    railGeomBreaker.recordSuccess();
    const legs = json.data?.plan?.itineraries?.[0]?.legs ?? [];
    const coords: [number, number][] = [];
    for (const leg of legs) {
      if (leg.mode === "WALK") continue;
      for (const pt of decodeOtpPolyline(leg.legGeometry?.points)) {
        const last = coords[coords.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
      }
    }
    return coords.length >= 2 ? coords : null;
  } catch {
    railGeomBreaker.recordFailure();
    return null;
  }
}

/**
 * Snap a raw endpoint to the nearest transit station by straight-line distance,
 * so geocoded venue centroids stranded behind a physical barrier still resolve
 * to a routable stop. Motivating case: "松山機場" geocodes to the runway side of
 * the airport fence — metres from the BR13 metro entrance as the crow flies, but
 * ~2 km away on foot — so OTP's walking-distance stopsByRadius returned nothing
 * and the trip 404'd.
 *
 * Rail stations (MRT + TRA/THSR) are preferred over bus stops within
 * SNAP_RADIUS_M: they are higher-capacity anchors with near-universal service
 * and the natural access point for the large venues that trigger this fallback.
 * Falls back to the nearest bus stop when no rail station is in range. Uses a
 * Mongo 2dsphere $near (great-circle), not OTP's walking distance, which the
 * barrier defeats. Fail-soft: null on any error or no candidate.
 *
 * @param point The {lat, lng} point to snap from.
 * @returns The nearest rail-then-bus station, or null.
 */
async function findSnapStop(
  point: {
    lat: number;
    lng: number;
  },
  preferBus = false,
): Promise<SnapStop | null> {
  const origin: [number, number] = [point.lng, point.lat];
  const nearQuery = {
    location: {
      $near: {
        $geometry: { type: "Point" as const, coordinates: origin },
        $maxDistance: SNAP_RADIUS_M,
      },
    },
  };
  try {
    if (preferBus) {
      const [bus] = await BusStopModel.find(nearQuery)
        .limit(1)
        .lean<ITdxBusStop[]>();
      if (bus) {
        return {
          lat: bus.location.coordinates[1],
          lng: bus.location.coordinates[0],
          name: bus.stopName.Zh_tw,
        };
      }
    }

    const [metro, train] = await Promise.all([
      MetroStationModel.find(nearQuery).limit(1).lean<ITdxMetroStation[]>(),
      TrainStationModel.find(nearQuery).limit(1).lean<ITdxTrainStation[]>(),
    ]);
    const rail = [...metro, ...train]
      .map((s) => ({ coords: s.location.coordinates, name: s.stationName.Zh_tw }))
      .sort(
        (a, b) =>
          haversineCoords(origin, a.coords) - haversineCoords(origin, b.coords),
      )[0];
    if (rail) {
      return { lat: rail.coords[1], lng: rail.coords[0], name: rail.name };
    }

    const [bus] = await BusStopModel.find(nearQuery)
      .limit(1)
      .lean<ITdxBusStop[]>();
    if (bus) {
      return {
        lat: bus.location.coordinates[1],
        lng: bus.location.coordinates[0],
        name: bus.stopName.Zh_tw,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Straight-line walk leg bridging a real endpoint to its snapped stop.
 *
 * @param from The origin point with name and coords.
 * @param to The destination point with name and coords.
 * @param mode Accessibility mode driving the walking speed.
 * @returns The bridging WalkLeg.
 */
function snapWalkLeg(
  from: { lng: number; lat: number; name: string },
  to: { lng: number; lat: number; name: string },
  mode: AccessibilityMode,
): WalkLeg {
  const distanceM = Math.round(
    haversineCoords([from.lng, from.lat], [to.lng, to.lat]),
  );
  const speed = walkSpeedMps(mode) * 60;
  return {
    type: "WALK",
    from: from.name,
    to: to.name,
    distanceM,
    minutesEst: Math.max(1, Math.round(distanceM / speed)),
    polyline: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    a11yFacilities: [],
    exitInfo: null,
  };
}

/**
 * Batched direction lookup: OTP exposes no direction_id, but the Mongo GtfsTrip
 * collection has it. Fail-soft to {}.
 *
 * @param tripIds The trip ids to look up.
 * @returns A map of trip id to direction id.
 */
async function lookupDirections(
  tripIds: string[],
): Promise<Map<string, 0 | 1>> {
  const map = new Map<string, 0 | 1>();
  if (!tripIds.length) return map;
  try {
    const trips = await GtfsTrip.find({ tripId: { $in: tripIds } })
      .select("tripId directionId")
      .lean<{ tripId: string; directionId: 0 | 1 }[]>();
    for (const t of trips) map.set(t.tripId, t.directionId ?? 0);
  } catch {
  }
  return map;
}

function walkLegFrom(leg: OtpLeg, isFirst: boolean, isLast: boolean): WalkLeg {
  const fromName =
    isFirst || leg.from.name === "Origin" ? "出發地" : leg.from.name ?? "";
  const toName =
    isLast || leg.to.name === "Destination" ? "目的地" : leg.to.name ?? "";
  const durationSec =
    leg.duration ?? Math.round((leg.endTime - leg.startTime) / 1000);
  return {
    type: "WALK",
    from: fromName,
    to: toName,
    distanceM: Math.round(leg.distance ?? 0),
    minutesEst: Math.max(1, Math.round(durationSec / 60)),
    polyline: decodeOtpPolyline(leg.legGeometry?.points),
    a11yFacilities: [],
    exitInfo: null,
    steps: (leg.steps ?? []).map((s): WalkStep => {
      const relativeDirection = s.relativeDirection ?? "CONTINUE";
      const streetName = s.streetName ?? "";
      const bogusName = s.bogusName ?? false;
      return {
        instruction: formatWalkStepInstruction({
          relativeDirection,
          streetName,
          bogusName,
        }),
        relativeDirection,
        absoluteDirection: s.absoluteDirection ?? null,
        streetName,
        bogusName,
        area: s.area ?? false,
        distanceM: Math.round(s.distance ?? 0),
        location: [s.lon ?? 0, s.lat ?? 0],
      };
    }),
  };
}

function transitLegFrom(
  leg: OtpLeg,
  estimatedWaitMinutes: number,
  directions: Map<string, 0 | 1>,
): BusLeg | MetroLeg | ThsrLeg | TraLeg {
  const routeId = stripFeedId(leg.route?.gtfsId);
  const tripId = stripFeedId(leg.trip?.gtfsId);
  const agencyId = stripFeedId(leg.route?.agency?.gtfsId);
  const routeName =
    leg.route?.shortName || leg.route?.longName || routeId || leg.mode;
  const fromName = leg.from.name ?? "";
  const toName = leg.to.name ?? "";
  const fromStopId = stripFeedId(leg.from.stop?.gtfsId);
  const toStopId = stripFeedId(leg.to.stop?.gtfsId);
  const departureTime = hhmm(leg.startTime);
  const arrivalTime = hhmm(leg.endTime);
  const rideMinutes = Math.max(
    1,
    Math.round((leg.endTime - leg.startTime) / 60000),
  );
  const polyline = decodeOtpPolyline(leg.legGeometry?.points);
  const direction = directions.get(tripId) ?? 0;
  const waitInfo: WaitInfo = { time: departureTime, source: "schedule" };

  const system = systemFromId(routeId);
  const isMetro =
    leg.mode === "SUBWAY" || leg.mode === "TRAM" || METRO_SYSTEMS.has(system);
  const isThsr =
    agencyId === "THSR" || system === "THSR" || tripId.startsWith("THSR");
  const isRail = leg.mode === "RAIL" || isThsr || system === "TRA";

  const intermediateStops = leg.intermediatePlaces?.map((p) => {
    const lat = p.lat ?? p.stop?.lat;
    const lon = p.lon ?? p.stop?.lon;
    return {
      name: p.name || "",
      stationUid: stripFeedId(p.stop?.gtfsId),
      location: lat && lon ? [lon, lat] as [number, number] : undefined,
    };
  });

  if (isMetro) {
    return {
      type: "METRO",
      railSystem: system,
      lineId: metroLineCode(system, routeId),
      lineName: routeName,
      lineUid: routeId,
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUid: fromStopId,
      arrivalStationUid: toStopId,
      direction,
      stopsCount: (leg.intermediatePlaces?.length ?? 0) + 1,
      rideMinutes,
      departureTime,
      arrivalTime,
      waitInfo,
      estimatedWaitMinutes,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
      intermediateStops,
    };
  }

  if (isRail) {
    const trainNo = trainNoFromTripId(tripId) ?? routeName;
    if (isThsr) {
      return {
        type: "THSR",
        trainNo,
        departureStation: fromName,
        arrivalStation: toName,
        departureStationUID: fromStopId,
        arrivalStationUID: toStopId,
        departureTime,
        arrivalTime,
        rideMinutes,
        waitInfo,
        estimatedWaitMinutes,
        polyline,
        departureStationA11y: [],
        arrivalStationA11y: [],
        facilityHighlights: [],
        intermediateStops,
      };
    }
    return {
      type: "TRA",
      trainNo,
      trainTypeName: leg.route?.longName ?? "",
      departureStation: fromName,
      arrivalStation: toName,
      departureStationUID: fromStopId,
      arrivalStationUID: toStopId,
      departureTime,
      arrivalTime,
      rideMinutes,
      waitInfo,
      estimatedWaitMinutes,
      polyline,
      departureStationA11y: [],
      arrivalStationA11y: [],
      facilityHighlights: [],
      intermediateStops,
    };
  }

  return {
    type: "BUS",
    routeName,
    departureStop: fromName,
    arrivalStop: toName,
    departureStopId: fromStopId || undefined,
    arrivalStopId: toStopId || undefined,
    departureTime,
    arrivalTime,
    waitInfo,
    estimatedWaitMinutes,
    direction,
    polyline,
    departureStopA11y: [],
    arrivalStopA11y: [],
    intermediateStops,
  };
}

/**
 * An itinerary is usable iff it has ≥1 transit leg, every transit leg rides a
 * supported mode, and its transfer count (transit legs − 1) is within
 * maxTransfers, and drops any itinerary containing a transit leg whose mode is
 * outside SUPPORTED_TRANSIT_MODES (e.g. AIRPLANE/FERRY). This is the final
 * output filter; the separate stop-snap retry decision is made by
 * hasUsableTransit in planOtpRoute (which checks leg presence and the transfer
 * cap only, not the mode allowlist).
 *
 * @param it The OTP itinerary to test.
 * @param maxTransfers The transfer cap, or undefined for no cap.
 * @returns Whether the itinerary survives the output filter.
 */
function itineraryUsable(it: OtpItinerary, maxTransfers?: number): boolean {
  const transit = it.legs.filter(isTransitLeg);
  if (transit.some((l) => !SUPPORTED_TRANSIT_MODES.has(l.mode))) return false;
  if (maxTransfers !== undefined && transit.length - 1 > maxTransfers)
    return false;
  return true;
}

function isTimeout(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT";
}

/**
 * Plan transit routes via the OTP2 sidecar. Output is AccessibleRoute-compatible
 * and un-enriched (no a11y arrays, no highlights) — finalizeRoutes() handles
 * scoring, enrichment and overlays downstream. Fail-soft: [] on any error.
 *
 * @param origin The [lat, lng] origin.
 * @param destination The [lat, lng] destination.
 * @param opts Planning options (departure time, transfer cap, mode, limit).
 * @returns The planned AccessibleRoute-compatible routes.
 */
export async function planOtpRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  opts?: PlanOtpRouteOptions,
): Promise<AccessibleRoute[]> {
  if (planBreaker.isOpen()) return [];

  const departure = opts?.departureTime ?? new Date();
  const mode = opts?.mode ?? "normal";
  const wheelchair = mode === "wheelchair";
  const walkSpeed = walkSpeedMps(mode);

  const tm: Record<string, number> = {};
  const t0 = Date.now();
  let failureRecorded = false;
  const recordPlanFailure = () => {
    if (failureRecorded) return;
    failureRecorded = true;
    planBreaker.recordFailure();
  };

  let firstItineraries: OtpItinerary[] = [];
  let primarySucceeded = false;
  let primaryTimedOut = false;
  try {
    firstItineraries = await queryOtpPlan(
      origin,
      destination,
      departure,
      wheelchair,
      walkSpeed,
      OTP_NUM_ITINERARIES,
      OTP_SEARCH_WINDOW_S,
    );
    primarySucceeded = true;
    planBreaker.recordSuccess();
  } catch (err) {
    recordPlanFailure();
    primaryTimedOut = isTimeout(err);
    if (primaryTimedOut) {
      tm.primaryTimedOut = 1;
      console.warn("[otp-routing] primary query timed out", err);
    } else {
      console.warn("[otp-routing] primary query failed, attempting stop snap", err);
    }
  }
  tm.otpFirst = Date.now() - t0;
  if (primaryTimedOut) {
    console.log(
      "[route-timing] otp",
      JSON.stringify({ ...tm, snapped: false, routes: 0 }),
    );
    return [];
  }
  let itineraries = firstItineraries;
  let effectiveWindowSec = OTP_SEARCH_WINDOW_S;

  const maxTransfers = opts?.maxTransfers;
  let snapPre: WalkLeg | null = null;
  let snapPost: WalkLeg | null = null;

  const hasUsableTransit = (its: OtpItinerary[]) =>
    its.some((it) => {
      const transit = it.legs.filter(isTransitLeg);
      return (
        transit.length > 0 &&
        (maxTransfers === undefined || transit.length - 1 <= maxTransfers)
      );
    });

  const hasBusLeg = (its: OtpItinerary[]) =>
    its.some((it) => it.legs.some((l) => l.mode === "BUS"));

  if (primarySucceeded) {
    const distinctRouteSignatures = new Set(
      itineraries
        .filter((it) => itineraryUsable(it, maxTransfers))
        .map((it) =>
          it.legs
            .filter(isTransitLeg)
            .map((leg) => leg.route?.shortName ?? leg.mode)
            .join("+"),
        )
        .filter(Boolean),
    ).size;
    if (distinctRouteSignatures < OTP_MIN_DISTINCT_ROUTES) {
      const tWide = Date.now();
      try {
        itineraries = await queryOtpPlan(
          origin,
          destination,
          departure,
          wheelchair,
          walkSpeed,
          OTP_NUM_ITINERARIES_WIDE,
          OTP_SEARCH_WINDOW_WIDE_S,
        );
        effectiveWindowSec = OTP_SEARCH_WINDOW_WIDE_S;
        planBreaker.recordSuccess();
        tm.otpWide = Date.now() - tWide;
      } catch (err) {
        tm.otpWide = Date.now() - tWide;
        if (isTimeout(err)) {
          recordPlanFailure();
          tm.primaryTimedOut = 1;
          console.warn("[otp-routing] wide query timed out", err);
          console.log(
            "[route-timing] otp",
            JSON.stringify({ ...tm, snapped: false, routes: 0 }),
          );
          return [];
        }
        console.warn("[otp-routing] wide query failed, retaining narrow result", err);
      }
    }
  }

  const straightDistM = haversineCoords(
    [origin.lng, origin.lat],
    [destination.lng, destination.lat],
  );
  const needBusSnap = !hasUsableTransit(itineraries) || (straightDistM <= 3500 && !hasBusLeg(itineraries));

  if (needBusSnap) {
    const tSnap = Date.now();
    const preferBus = straightDistM <= 3500 || !hasUsableTransit(itineraries);
    const [originSnap, destSnap] = await Promise.all([
      findSnapStop(origin, preferBus),
      findSnapStop(destination, preferBus),
    ]);
    tm.snapLookup = Date.now() - tSnap;
    if (originSnap || destSnap) {
      const tRetry = Date.now();
      try {
        const retryItineraries = await queryOtpPlan(
          originSnap ?? origin,
          destSnap ?? destination,
          departure,
          wheelchair,
          walkSpeed,
          OTP_NUM_ITINERARIES,
          effectiveWindowSec,
        );
        tm.otpRetry = Date.now() - tRetry;
        if (hasUsableTransit(retryItineraries)) {
          if (!hasUsableTransit(itineraries)) {
            itineraries = retryItineraries;
          } else {
            // Append bus itineraries found via bus stop snap
            itineraries = [...itineraries, ...retryItineraries];
          }
          if (originSnap) {
            snapPre = snapWalkLeg(
              { ...origin, name: "出發地" },
              originSnap,
              mode,
            );
          }
          if (destSnap) {
            snapPost = snapWalkLeg(
              destSnap,
              { ...destination, name: "目的地" },
              mode,
            );
          }
          console.info(
            `[otp-routing] transit plan recovered by stop snap` +
              (originSnap ? ` origin→${originSnap.name}` : "") +
              (destSnap ? ` dest→${destSnap.name}` : ""),
          );
        }
      } catch (err) {
        recordPlanFailure();
        if (isTimeout(err)) {
          tm.primaryTimedOut = 1;
          console.warn("[otp-routing] snap retry timed out", err);
          console.log(
            "[route-timing] otp",
            JSON.stringify({ ...tm, snapped: false, routes: 0 }),
          );
          return [];
        }
        console.warn("[otp-routing] snap retry failed, falling back to walk-only", err);
      }
    }
  }

  const allTripIds = [
    ...new Set(
      itineraries.flatMap((it) =>
        it.legs
          .filter(isTransitLeg)
          .map((l) => stripFeedId(l.trip?.gtfsId))
          .filter(Boolean),
      ),
    ),
  ];
  const tDir = Date.now();
  const directions = await lookupDirections(allTripIds);
  tm.directions = Date.now() - tDir;

  const out: AccessibleRoute[] = [];
  for (const [i, it] of itineraries.entries()) {
    if (!itineraryUsable(it, maxTransfers)) continue;
    const transitOtpLegs = it.legs.filter(isTransitLeg);

    const legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    const transitLegs: (BusLeg | MetroLeg | ThsrLeg | TraLeg)[] = [];
    let clockMs = departure.getTime();
    for (const [j, leg] of it.legs.entries()) {
      if (!isTransitLeg(leg)) {
        if ((leg.distance ?? 0) > 0) {
          const wl = walkLegFrom(leg, j === 0, j === it.legs.length - 1);
          if (j === 0 && snapPre) wl.from = snapPre.to;
          if (j === it.legs.length - 1 && snapPost) wl.to = snapPost.from;
          legs.push(wl);
        }
        clockMs = leg.endTime;
        continue;
      }
      const waitMinutes = Math.max(
        0,
        Math.round((leg.startTime - clockMs) / 60000),
      );
      const mapped = transitLegFrom(leg, waitMinutes, directions);
      clockMs = leg.endTime;
      legs.push(mapped);
      transitLegs.push(mapped);
    }

    const routeName = transitLegs.length > 0
      ? transitLegs
          .map((l) =>
            l.type === "BUS"
              ? l.routeName
              : l.type === "METRO"
                ? l.lineName
                : l.trainNo,
          )
          .join(" → ")
      : "步行路線";

  const queryDate = ymdDash(departure);
  const firstDepDate = transitOtpLegs.length > 0
    ? ymdDash(new Date(transitOtpLegs[0].startTime))
    : queryDate;

    if (snapPre) legs.unshift({ ...snapPre });
    if (snapPost) legs.push({ ...snapPost });
    const snapMinutes =
      (snapPre?.minutesEst ?? 0) + (snapPost?.minutesEst ?? 0);

    const tripIdToken = transitOtpLegs.length > 0
      ? (stripFeedId(transitOtpLegs[0].trip?.gtfsId) || "unknown")
      : "walk";

    out.push({
      routeId: `otp-${i}-${tripIdToken}`,
      routeName,
      totalMinutes: Math.max(1, Math.round(it.duration / 60)) + snapMinutes,
      transferCount: Math.max(0, transitLegs.length - 1),
      legs,
      accessibilityHighlights: [],
      ...(firstDepDate !== queryDate ? { departureDate: firstDepDate } : {}),
    });
  }


  console.log(
    "[route-timing] otp",
    JSON.stringify({
      ...tm,
      snapped: !!(snapPre || snapPost),
      routes: out.length,
    }),
  );
  return out.slice(0, opts?.limit ?? OTP_NUM_ITINERARIES_WIDE);
}
