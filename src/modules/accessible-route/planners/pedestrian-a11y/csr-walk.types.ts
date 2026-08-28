import type {
  AccessibilityMode,
  WalkA11yFeature,
  WalkA11yPoint,
  WalkA11ySegment,
  WalkStep,
} from "../../../../types/route";
import type { LngLat } from "./ped-graph-geometry.repository";

/** Alias of the single source of truth in `types/route.ts`. */
export type CsrWalkA11yFeature = WalkA11yFeature;

/** Alias of the single source of truth in `types/route.ts`. */
export type CsrWalkA11ySegment = WalkA11ySegment;

/** Source-backed accessibility observations for a CSR-selected walking path. */
export interface CsrWalkAccessibility {
  /** Steepest absolute longitudinal slope on the path, or null when unmeasured. */
  maxSlopePercent: number | null;
  /** Number of traversed crossing edges, or null when the path has no edges. */
  crossings: number | null;
  /** Crossing edges whose kerb is tagged as ramped, or null when unmeasured. */
  crossingsWithCurbRamp: number | null;
  /** Narrowest net usable width in centimetres, or null when unmeasured. */
  minPathWidthCm: number | null;
  surfaceType: "paved" | "gravel" | "unknown";
}

export interface CsrWalkDiagnostics {
  expandedNodes: number;
  reopenedNodes: number;
  edgeCount: number;
  totalCostM: number;
  relaxationLevel: number;
  /** Request-origin distance to the chosen routable graph endpoint. */
  originSnapDistanceM: number;
  /** Request-destination distance to the chosen routable graph endpoint. */
  destinationSnapDistanceM: number;
}

/** One planned walking segment produced by the CSR pedestrian graph. */
export interface CsrWalkPlan {
  /** Ordered [longitude, latitude] pairs, including counted straight snap connectors. */
  polyline: LngLat[];
  /** Selected-edge ground distance plus accepted endpoint connectors, in metres. */
  distanceM: number;
  /** Selected-edge traversal duration plus endpoint connector walking time, in seconds. */
  durationS: number;
  /** ACTIVE graph version that produced this path. */
  graphVersionId: number;
  /**
   * Selected provenance-qualified indoor edges represented by endpoint proxy
   * coordinates because stored geometry was unavailable. Non-zero means the
   * drawn line is approximate; when their stored length is also absent, their
   * source traversal time estimates distance rather than centroid separation.
   */
  approximateIndoorSegmentCount: number;
  accessibility: CsrWalkAccessibility;
  /**
   * Facility-classified runs of `polyline`, ordered and non-overlapping.
   * Empty means no traversed edge carried a classified facility observation.
   */
  a11ySegments: CsrWalkA11ySegment[];
  /**
   * De-duplicated, path-ordered curb ramp points recorded on the traversed
   * edges. Ramp points are locations, not runs, so they are reported as their
   * own coordinates rather than folded into `a11ySegments` — colouring a
   * whole edge as a ramp would misreport its extent.
   */
  a11yPoints: WalkA11yPoint[];
  /**
   * Turn-by-turn steps derived from the selected edges' geometry and facility
   * types. Carries no street names — the CSR graph has none.
   */
  steps: WalkStep[];
  /**
   * De-duplicated ramp total recorded on the government sidewalk segments
   * this plan travels along. See `sumSidewalkRampCount`.
   */
  sidewalkRampCount: number;
  diagnostics: CsrWalkDiagnostics;
}

/**
 * Why a CSR walking request produced no path. The distinction controls the
 * fallback contract: unavailable, unsupported, and topology-disconnected
 * requests may use a marked OTP2 route, while `fare_policy_blocked` and
 * `accessibility_blocked` are terminal and never invoke another planner.
 *
 * `outside_coverage` is the only reason that is not a degradation: the graph
 * simply does not describe that ground, so OTP2 was always the primary engine.
 * `unsupported_constraints` is its inside-coverage counterpart — the request
 * was in scope but names a mode/avoidStairs combination this engine's cost
 * profiles cannot represent faithfully, which is a real loss of protection.
 */
export type CsrWalkFailureReason =
  | "outside_coverage"
  | "unsupported_constraints"
  | "unavailable"
  | "topology_disconnected"
  | "fare_policy_blocked"
  | "accessibility_blocked";

export type CsrWalkResult =
  | { status: "ok"; plans: CsrWalkPlan[] }
  | { status: "outside_coverage" }
  | { status: "unsupported_constraints" }
  | { status: "unavailable"; reason: string }
  | { status: "topology_disconnected" }
  | { status: "fare_policy_blocked" }
  | { status: "accessibility_blocked" };

export interface CsrWalkOptions {
  mode: AccessibilityMode;
  /** Resolved request constraint; omitted callers retain the mode default. */
  avoidStairs?: boolean;
}
