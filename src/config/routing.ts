import type { AccessibilityMode } from "../types/route";

/**
 * Mode walking speeds (m/s), sent to OTP as `walkSpeed` and used to turn walk
 * distance into duration. Deliberately not env-tunable: OTP keys its
 * precomputed stop-to-stop transfer cache on the exact speed and wheelchair
 * flag, and a request outside `transit.transferCacheRequests` in
 * otp-data/router-config.json blocks for 40 s or more while OTP builds a new
 * cache entry. routing.test.ts keeps the two in step.
 */
export const WALK_SPEED_MPS: Readonly<Record<AccessibilityMode, number>> = {
  wheelchair: 0.8,
  elderly: 0.9,
  visual_impaired: 1.0,
  normal: 1.3,
};

/** Route-level low-floor evidence, used only as a ranking signal. */
export interface LowFloorEvidenceConfig {
  /** Distinct plates a route needs before its history counts at all. */
  minDistinctPlates: number;
  /** Observations older than this are ignored. */
  maxAgeDays: number;
  /** Share of observed plates with a known car type needed to use the route. */
  minTypeCoverage: number;
}

export interface RoutingConfig {
  /**
   * Total time one transit planning request may spend across every OTP stage
   * (primary, widening, stop snap, preferred mode, later service, the
   * diagnostic retry). Each stage only gets what remains.
   */
  planBudgetMs: number;
  /** Itineraries requested from the primary OTP query. */
  otpNumItineraries: number;
  /** Itineraries requested from the diversity-widening OTP query. */
  otpNumItinerariesWide: number;
  lowFloorEvidence: LowFloorEvidenceConfig;
  /** How long a bus fleet sighting (plate seen on a route) is kept. */
  fleetSightingTtlDays: number;
}

const DEFAULTS: RoutingConfig = {
  planBudgetMs: 45_000,
  otpNumItineraries: 8,
  otpNumItinerariesWide: 15,
  lowFloorEvidence: {
    minDistinctPlates: 5,
    maxAgeDays: 30,
    minTypeCoverage: 0.8,
  },
  fleetSightingTtlDays: 30,
};

function readNumber(
  name: string,
  fallback: number,
  valid: (value: number) => boolean,
  expected: string,
): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !valid(value)) {
    throw new Error(`Invalid ${name}: expected ${expected}, got "${raw}"`);
  }
  return value;
}

const positiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const ratio = (value: number) => value >= 0 && value <= 1;

/**
 * Resolves the routing tunables. Overrides are read on every call so a bad
 * deployment value fails the first request loudly instead of silently falling
 * back to a default.
 *
 * @returns The effective routing configuration.
 */
export function getRoutingConfig(): RoutingConfig {
  const d = DEFAULTS;
  return {
    planBudgetMs: readNumber(
      "ROUTE_PLAN_BUDGET_MS",
      d.planBudgetMs,
      positiveInteger,
      "a positive whole number of milliseconds",
    ),
    otpNumItineraries: readNumber(
      "OTP_NUM_ITINERARIES",
      d.otpNumItineraries,
      positiveInteger,
      "a positive whole number",
    ),
    otpNumItinerariesWide: readNumber(
      "OTP_NUM_ITINERARIES_WIDE",
      d.otpNumItinerariesWide,
      positiveInteger,
      "a positive whole number",
    ),
    lowFloorEvidence: {
      minDistinctPlates: readNumber(
        "LOW_FLOOR_MIN_DISTINCT_PLATES",
        d.lowFloorEvidence.minDistinctPlates,
        positiveInteger,
        "a positive whole number",
      ),
      maxAgeDays: readNumber(
        "LOW_FLOOR_EVIDENCE_MAX_AGE_DAYS",
        d.lowFloorEvidence.maxAgeDays,
        positiveInteger,
        "a positive whole number of days",
      ),
      minTypeCoverage: readNumber(
        "LOW_FLOOR_MIN_TYPE_COVERAGE",
        d.lowFloorEvidence.minTypeCoverage,
        ratio,
        "a number between 0 and 1",
      ),
    },
    fleetSightingTtlDays: readNumber(
      "BUS_FLEET_SIGHTING_TTL_DAYS",
      d.fleetSightingTtlDays,
      positiveInteger,
      "a positive whole number of days",
    ),
  };
}
