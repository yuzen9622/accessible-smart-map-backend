import axios from "axios";
import {
  VALHALLA_BASE_URL,
  VALHALLA_MAX_EXCLUDE_LOCATIONS,
  VALHALLA_ROUTE_PATH,
  VALHALLA_TIMEOUT_MS,
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
  stairs: false;
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
  wheelchair?: boolean;
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
    stairs: false,
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
  if (params.costing === "pedestrian" && params.wheelchair) {
    costingOptions.type = "wheelchair";
    costingOptions.step_penalty = 600;
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
      { signal: AbortSignal.timeout(VALHALLA_TIMEOUT_MS) },
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
