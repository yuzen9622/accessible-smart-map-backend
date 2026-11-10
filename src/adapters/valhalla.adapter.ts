import axios from "axios";
import { decode } from "@googlemaps/polyline-codec";
import type {
  RoadLane,
  RoadLaneDirection,
  RoadSigns,
} from "../types/road-guidance";
import {
  VALHALLA_BASE_URL,
  VALHALLA_MAX_EXCLUDE_LOCATIONS,
  VALHALLA_ROUTE_PATH,
  VALHALLA_TIMEOUT_MS,
  VALHALLA_WHEELCHAIR_MAX_DISTANCE_M,
} from "../config/valhalla";

export type ValhallaCosting = "auto" | "motorcycle" | "pedestrian";

export interface NormalizedValhallaSummary {
  lengthKm: number;
  timeSec: number;
}

export interface NormalizedValhallaManeuver {
  instruction?: string;
  type: number;
  lengthKm: number;
  timeSec: number;
  beginShapeIndex: number;
  endShapeIndex: number;
  streetNames?: string[];
  highway?: boolean;
  stairs: boolean;
  beginStreetNames?: string[];
  bearingBefore?: number;
  bearingAfter?: number;
  signs?: RoadSigns;
  lanes?: RoadLane[];
}

export interface NormalizedValhallaLeg {
  shapePolyline6: string;
  summary: NormalizedValhallaSummary;
  maneuvers?: NormalizedValhallaManeuver[];
}

export interface NormalizedValhallaTrip {
  summary: NormalizedValhallaSummary;
  legs: NormalizedValhallaLeg[];
}

export interface ComputeValhallaRoutesParams {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  waypoints?: { lat: number; lng: number }[];
  costing: ValhallaCosting;
  computeAlternatives?: boolean;
  /** Blend distance into road route costing without disabling other penalties. */
  distanceWeight?: 0.7;
  wheelchair?: boolean;
  /** Remaining shared request budget. */
  timeoutMs?: number;
  /** Points the route must not pass through, e.g. closed-road incidents. */
  excludeLocations?: { lat: number; lng: number }[];
  /**
   * Date and time configuration for dynamic costing and live traffic reading.
   * type 0: current departure time (enables Valhalla native live traffic evaluation)
   * type 1: specified departure time (format: YYYY-MM-DDTHH:MM)
   * type 2: specified arrival time (format: YYYY-MM-DDTHH:MM)
   */
  dateTime?: { type: 0 | 1 | 2; value?: string };
}

export type ComputeValhallaRoutesResult =
  | { status: "OK"; trips: NormalizedValhallaTrip[] }
  | {
      status: "NO_ROUTE" | "UPSTREAM_ERROR";
      trips: [];
      httpStatus?: number;
      errorCode?: number;
    };

const NO_ROUTE_ERROR_CODES = new Set([442]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeSummary(value: unknown): NormalizedValhallaSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!finiteNonNegative(raw.length) || !finiteNonNegative(raw.time))
    return null;
  return { lengthKm: raw.length, timeSec: raw.time };
}

function normalizeManeuver(value: unknown): NormalizedValhallaManeuver | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const begin = raw.begin_shape_index;
  const end = raw.end_shape_index;
  if (
    !Number.isInteger(raw.type) ||
    (raw.type as number) < 0 ||
    !finiteNonNegative(raw.length) ||
    !finiteNonNegative(raw.time) ||
    !Number.isInteger(begin) ||
    (begin as number) < 0 ||
    !Number.isInteger(end) ||
    (end as number) < (begin as number)
  )
    return null;
  if (raw.instruction !== undefined && typeof raw.instruction !== "string")
    return null;
  if (
    raw.street_names !== undefined &&
    (!Array.isArray(raw.street_names) ||
      raw.street_names.some((v) => typeof v !== "string"))
  )
    return null;
  const maneuver: NormalizedValhallaManeuver = {
    type: raw.type as number,
    lengthKm: raw.length,
    timeSec: raw.time,
    beginShapeIndex: begin as number,
    endShapeIndex: end as number,
    stairs: raw.type === 40,
  };
  if (typeof raw.instruction === "string") {
    maneuver.instruction = raw.instruction;
  }
  if (Array.isArray(raw.street_names)) {
    maneuver.streetNames = raw.street_names as string[];
  }
  if (raw.highway === true) {
    maneuver.highway = true;
  }
  if (
    Array.isArray(raw.begin_street_names) &&
    raw.begin_street_names.every((v) => typeof v === "string")
  )
    maneuver.beginStreetNames = raw.begin_street_names;
  if (validBearing(raw.bearing_before))
    maneuver.bearingBefore = raw.bearing_before;
  if (validBearing(raw.bearing_after))
    maneuver.bearingAfter = raw.bearing_after;
  const signs = normalizeSigns(raw.sign);
  if (signs) maneuver.signs = signs;
  const lanes = normalizeLanes(raw.lanes);
  if (lanes) maneuver.lanes = lanes;
  if ((raw.sign !== undefined && !signs) || (raw.lanes !== undefined && !lanes))
    console.warn("[valhalla] optional road metadata discarded", {
      signsInvalid: raw.sign !== undefined && !signs,
      lanesInvalid: raw.lanes !== undefined && !lanes,
    });
  return maneuver;
}

function normalizeLeg(value: unknown): NormalizedValhallaLeg | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const summary = normalizeSummary(raw.summary);
  if (!summary || typeof raw.shape !== "string" || raw.shape.length === 0)
    return null;
  let maneuvers: NormalizedValhallaManeuver[] | undefined;
  if (raw.maneuvers !== undefined) {
    if (!Array.isArray(raw.maneuvers)) return null;
    const normalized = raw.maneuvers.map(normalizeManeuver);
    if (normalized.some((m) => m === null)) return null;
    maneuvers = normalized as NormalizedValhallaManeuver[];
  }
  return {
    shapePolyline6: raw.shape,
    summary,
    ...(maneuvers ? { maneuvers } : {}),
  };
}

function normalizeTrip(value: unknown): NormalizedValhallaTrip | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const summary = normalizeSummary(raw.summary);
  if (!summary || !Array.isArray(raw.legs) || raw.legs.length === 0)
    return null;
  const legs = raw.legs.map(normalizeLeg);
  if (legs.some((leg) => leg === null)) return null;
  return { summary, legs: legs as NormalizedValhallaLeg[] };
}

export async function computeValhallaRoutes(
  params: ComputeValhallaRoutesParams,
): Promise<ComputeValhallaRoutesResult> {
  const locations = [
    params.origin,
    ...(params.waypoints ?? []),
    params.destination,
  ].map(({ lat, lng }) => ({ lat, lon: lng, type: "break" as const }));
  const costingOptions: Record<string, unknown> = {
    exclude_ferries: true,
    use_ferry: 0,
  };
  if (params.distanceWeight !== undefined && params.costing !== "pedestrian") {
    costingOptions.use_distance = params.distanceWeight;
  }
  if (params.costing === "pedestrian" && params.wheelchair) {
    costingOptions.type = "wheelchair";
    costingOptions.step_penalty = 600;
    // The wheelchair type defaults max_distance to 10 km (foot: 100 km);
    // restore the foot limit so step-free walks are not dropped for length.
    costingOptions.max_distance = VALHALLA_WHEELCHAIR_MAX_DISTANCE_M;
  }
  const body: Record<string, unknown> = {
    locations,
    costing: params.costing,
    // Exclude ferries so no mode (walk/drive/motorcycle) routes across the strait
    // to an offshore island (e.g. a 新竹→台南 walk hopping via 澎湖/馬公). exclude_ferries
    // is a hard exclusion where the deployment allows it; use_ferry: 0 is the soft
    // fallback that any deployment honors.
    costing_options: { [params.costing]: costingOptions },
    directions_options: { units: "kilometers" },
  };
  if (params.costing !== "pedestrian") body.turn_lanes = true;
  if (params.computeAlternatives && !params.waypoints?.length)
    body.alternates = 2;
  if (params.dateTime) {
    const dt: { type: 0 | 1 | 2; value?: string } = {
      type: params.dateTime.type,
    };
    if (params.dateTime.value) {
      dt.value = params.dateTime.value;
    }
    body.date_time = dt;
  }
  // exclude_locations is a top-level /route field (not a costing option) and a
  // HARD exclusion: Valhalla answers error_code 442 rather than routing through
  // the point. The key is omitted when empty so existing requests are unchanged.
  if (params.excludeLocations?.length) {
    body.exclude_locations = params.excludeLocations
      .slice(0, VALHALLA_MAX_EXCLUDE_LOCATIONS)
      .map(({ lat, lng }) => ({ lat, lon: lng }));
  }

  try {
    const response = await axios.post(
      `${VALHALLA_BASE_URL}${VALHALLA_ROUTE_PATH}`,
      body,
      {
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              VALHALLA_TIMEOUT_MS,
              params.timeoutMs ?? VALHALLA_TIMEOUT_MS,
            ),
          ),
        ),
      },
    );
    const data = response.data as Record<string, unknown>;
    const rawTrips: unknown[] = [data?.trip];
    if (data?.alternates !== undefined) {
      if (!Array.isArray(data.alternates))
        return { status: "UPSTREAM_ERROR", trips: [] };
      for (const alternate of data.alternates) {
        if (
          !alternate ||
          typeof alternate !== "object" ||
          !("trip" in alternate)
        ) {
          return { status: "UPSTREAM_ERROR", trips: [] };
        }
        rawTrips.push((alternate as { trip: unknown }).trip);
      }
    }
    const trips = rawTrips.map(normalizeTrip);
    if (trips.some((trip) => trip === null))
      return { status: "UPSTREAM_ERROR", trips: [] };
    return { status: "OK", trips: trips as NormalizedValhallaTrip[] };
  } catch (error) {
    const httpStatus = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    const rawCode = axios.isAxiosError(error)
      ? error.response?.data?.error_code
      : undefined;
    const errorCode = typeof rawCode === "number" ? rawCode : undefined;
    if (errorCode !== undefined && NO_ROUTE_ERROR_CODES.has(errorCode)) {
      return { status: "NO_ROUTE", trips: [], httpStatus, errorCode };
    }
    return { status: "UPSTREAM_ERROR", trips: [], httpStatus, errorCode };
  }
}

function validBearing(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < 360
  );
}
function normalizeSigns(value: unknown): RoadSigns | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const signs: RoadSigns = {
    exitNumbers: [],
    branches: [],
    destinations: [],
    exitNames: [],
  };
  for (const [field, key] of [
    ["exit_number_elements", "exitNumbers"],
    ["exit_branch_elements", "branches"],
    ["exit_toward_elements", "destinations"],
    ["exit_name_elements", "exitNames"],
  ] as const) {
    const elements = raw[field];
    if (elements === undefined) continue;
    if (
      !Array.isArray(elements) ||
      elements.some(
        (e) => !e || typeof e !== "object" || typeof e.text !== "string",
      )
    )
      return undefined;
    signs[key] = elements.map((e: { text: string }) => e.text);
  }
  return signs;
}
// Valhalla 3.9.1 TurnLane::Direction bit positions (not maneuver enum values).
const LANE_BITS: [number, RoadLaneDirection][] = [
  [1, "none"],
  [2, "straight"],
  [4, "sharp_left"],
  [8, "left"],
  [16, "slight_left"],
  [32, "slight_right"],
  [64, "right"],
  [128, "sharp_right"],
  [256, "uturn"],
  [512, "merge_left"],
  [1024, "merge_right"],
];
function normalizeLanes(value: unknown): RoadLane[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const lanes: RoadLane[] = [];
  for (const lane of value) {
    if (!lane || typeof lane !== "object") return undefined;
    const { directions, active = 0, valid = 0 } = lane;
    if (
      !Number.isInteger(directions) ||
      directions <= 0 ||
      directions > 2047 ||
      !Number.isInteger(active) ||
      !Number.isInteger(valid) ||
      active < 0 ||
      valid < 0 ||
      ((active | valid) & ~directions) !== 0
    )
      return undefined;
    const selected = active || valid;
    if (selected && (selected & (selected - 1)) !== 0) return undefined;
    const decoded = LANE_BITS.filter(([bit]) => directions & bit).map(
      ([, direction]) => direction,
    );
    if (decoded.includes("none") && decoded.length > 1) return undefined;
    if (active && valid && active !== valid) return undefined;
    lanes.push({
      directions: decoded,
      recommendation: active
        ? "preferred"
        : valid
          ? "usable"
          : "not_recommended",
      maneuverDirection:
        LANE_BITS.find(([bit]) => bit === selected)?.[1] ?? null,
    });
  }
  return lanes;
}

export interface NormalizedRoadTraceSpan {
  fromIndex: number;
  toIndex: number;
  directedEdgeId: string;
  osmWayId: string;
  edgeForward: boolean;
}
export type NormalizedRoadTraceResult =
  | {
      status: "OK";
      shapePolyline6: string;
      speedLimitValues: number[];
      spans: NormalizedRoadTraceSpan[];
    }
  | {
      status: "NO_MATCH" | "UPSTREAM_ERROR" | "INVALID_RESPONSE";
      httpStatus?: number;
      errorCode?: number;
    };
export interface ComputeValhallaTraceAttributesParams {
  shapePolyline6: string;
  costing: ValhallaCosting;
  timeoutMs?: number;
  dateTime?: ComputeValhallaRoutesParams["dateTime"];
}
function safeId(value: unknown): string | null {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}
export async function computeValhallaTraceAttributes(
  params: ComputeValhallaTraceAttributesParams,
): Promise<NormalizedRoadTraceResult> {
  try {
    const input = decode(params.shapePolyline6, 6);
    if (
      input.length < 2 ||
      input.some(
        ([lat, lng]) =>
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          Math.abs(lat) > 90 ||
          Math.abs(lng) > 180,
      )
    )
      return { status: "INVALID_RESPONSE" };
    const response = await axios.post(
      `${VALHALLA_BASE_URL}/trace_attributes`,
      {
        encoded_polyline: params.shapePolyline6,
        shape_match: "edge_walk",
        costing: params.costing,
        units: "kilometers",
        ...(params.dateTime ? { date_time: params.dateTime } : {}),
        filters: {
          action: "include",
          attributes: [
            "shape",
            "edge.id",
            "edge.way_id",
            "edge.forward",
            "edge.begin_shape_index",
            "edge.end_shape_index",
            "edge.begin_heading",
            "edge.end_heading",
            "edge.speed_limit",
            "shape_attributes.speed_limit",
          ],
        },
      },
      {
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              VALHALLA_TIMEOUT_MS,
              params.timeoutMs ?? VALHALLA_TIMEOUT_MS,
            ),
          ),
        ),
      },
    );
    const data = response.data;
    if (!data || typeof data.shape !== "string")
      return { status: "INVALID_RESPONSE" };
    let returnedShape;
    try {
      returnedShape = decode(data.shape, 6);
    } catch {
      return { status: "INVALID_RESPONSE" };
    }
    if (JSON.stringify(returnedShape) !== JSON.stringify(input))
      return { status: "NO_MATCH" };
    const values = data.shape_attributes?.speed_limit;
    if (
      !Array.isArray(values) ||
      values.length !== input.length - 1 ||
      values.some(
        (v: unknown) =>
          typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255,
      )
    )
      return { status: "INVALID_RESPONSE" };
    if (!Array.isArray(data.edges) || !data.edges.length)
      return { status: "INVALID_RESPONSE" };
    const spans: NormalizedRoadTraceSpan[] = [];
    let next = 0;
    for (const edge of data.edges) {
      if (!edge || typeof edge !== "object")
        return { status: "INVALID_RESPONSE" };
      const id = safeId(edge.id),
        way = safeId(edge.way_id);
      const from = edge.begin_shape_index,
        to = edge.end_shape_index;
      if (
        !id ||
        !way ||
        typeof edge.forward !== "boolean" ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from !== next ||
        to <= from ||
        to >= input.length
      )
        return { status: "INVALID_RESPONSE" };
      spans.push({
        fromIndex: from,
        toIndex: to,
        directedEdgeId: id,
        osmWayId: way,
        edgeForward: edge.forward,
      });
      next = to;
    }
    if (next !== input.length - 1) return { status: "INVALID_RESPONSE" };
    return {
      status: "OK",
      shapePolyline6: data.shape,
      speedLimitValues: values,
      spans,
    };
  } catch (error) {
    const httpStatus = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    const errorCode = axios.isAxiosError(error)
      ? error.response?.data?.error_code
      : undefined;
    return {
      status:
        errorCode === 443 || errorCode === 442 ? "NO_MATCH" : "UPSTREAM_ERROR",
      httpStatus,
      ...(typeof errorCode === "number" ? { errorCode } : {}),
    };
  }
}
