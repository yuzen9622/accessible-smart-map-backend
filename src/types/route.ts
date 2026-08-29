/**
 * Route / leg domain model — the shared shape of a planned accessible route.
 *
 * Lives in the neutral types layer (not in the orchestrator) so that every
 * planner in src/service/* and the orchestrator in
 * modules/accessible-route/accessible-route.service.ts can depend on these
 * types DOWNWARD, with no upward import and no runtime circular dependency.
 */

import type { HazardSeverity, HazardType, IOsmA11y } from "./index";
import type { MatchedAlert, MetroAlert } from "./transit";

export type AccessibilityMode =
  "wheelchair" | "elderly" | "visual_impaired" | "normal";

/**
 * Transport mode requested by the client — orthogonal to AccessibilityMode.
 * "transit" plans via OTP (bus/metro/rail); the rest plan via the road router.
 */
export type TravelMode = "transit" | "drive" | "motorcycle" | "walk";

/**
 * Pure-walk route selection provenance. `otp-fallback` means the CSR pedestrian
 * graph did not choose the route; when OTP2 itself is unavailable, the route's
 * warnings identify the final Valhalla recovery without widening this contract.
 */
type PureWalkRouteEngine = "pedestrian-a11y" | "otp-fallback";

export interface SlimA11y {
  osmId: string;
  category: IOsmA11y["category"];
  name?: string;
  wheelchair?: IOsmA11y["wheelchair"];
  location: IOsmA11y["location"];
  tags?: Record<string, string>;
}

/** One verified, community-confirmed hazard positioned relative to a planned route. */
export interface RouteHazard {
  id: string;
  hazardType: HazardType;
  severity: HazardSeverity;
  description?: string;
  location: { lat: number; lng: number };
  /** Shortest distance from the route's ground-level polyline to the hazard, in metres. */
  distanceM: number;
}

/**
 * Confirmed-hazard findings for one route. `avoided` is populated only on the
 * selected candidate, and only for hazards that actually sit on another
 * candidate of the same request, so the claim "this route avoids it" is always
 * backed by evidence.
 */
export interface RouteHazardAdvisory {
  onRoute: RouteHazard[];
  avoided: RouteHazard[];
  blockingOnRoute: number;
  penaltyPoints: number;
}

export interface WalkRestPoint {
  type: "accessible_toilet";
  /** Distance from the WALK leg start to the closest point on its routed geometry, in metres. */
  distanceM: number;
}

/**
 * Explicit, source-backed WALK-leg accessibility observations. `null` and
 * `unknown` mean the current route data carries no measurement for that
 * dimension; they must never be rendered as zero / favourable conditions.
 */
export interface WalkA11yDetails {
  maxSlopePercent: number | null;
  crossings: number | null;
  crossingsWithCurbRamp: number | null;
  minPathWidthCm: number | null;
  surfaceType: "paved" | "gravel" | "unknown";
  restPoints: WalkRestPoint[];
}

export interface WaitInfo {
  time: number | string | null;
  source: "realtime" | "schedule" | "unavailable";
}

/**
 * Accessibility-relevant facility class of one traversed graph run.
 *
 * These are source-backed edge classifications, not quality judgements: the
 * client decides how to colour each class. `crossing` is the no-observed-ramp
 * counterpart of `curb_ramp_crossing` and is reported so a client can style
 * them differently; its presence is not a claim that no ramp exists on the
 * ground, only that the graph carries no ramp observation for that edge.
 */
export type WalkA11yFeature =
  | "elevator"
  | "escalator"
  | "moving_walkway"
  | "ramp"
  | "curb_ramp_crossing"
  | "crossing"
  | "stairs"
  | "fare_gate"
  | "exit_gate";

/**
 * One contiguous run of a WalkLeg's `polyline` carrying a facility class.
 *
 * `startIndex` / `endIndex` are inclusive indices into that same polyline, so a
 * client slices rather than re-matches coordinates. `startIndex === endIndex`
 * is a point feature, not a drawable line: a vertical facility such as an
 * elevator has both endpoints at one ground coordinate and must be rendered as
 * a marker. Runs never overlap and are ordered by `startIndex`.
 *
 * Unannotated stretches are deliberately absent; the client draws its base
 * walking colour and overlays only these runs.
 */
export interface WalkA11ySegment {
  feature: WalkA11yFeature;
  startIndex: number;
  endIndex: number;
  /** Whether the whole run is inside a station or building. */
  indoor: boolean;
  /** Run ground length, or null when any of its edges carries no usable length. */
  distanceM: number | null;
  /** Steepest absolute slope on the run, or null when unmeasured. */
  maxSlopePercent: number | null;
  /** Narrowest observed width on the run in centimetres, or null when unmeasured. */
  minWidthCm: number | null;
}

/**
 * A curb-ramp facility recorded near a CSR walking leg's path.
 *
 * `location` is the facility's own surveyed coordinate, not a projection onto
 * the leg's `polyline`: a ramp point is a point, and snapping it onto the
 * path would misreport where it actually is.
 */
export interface WalkA11yPoint {
  type: "curb_ramp";
  /** WGS84 [longitude, latitude] of the recorded facility itself. */
  location: [number, number];
}

export type WalkAbsoluteDirection =
  | "NORTH"
  | "NORTHEAST"
  | "EAST"
  | "SOUTHEAST"
  | "SOUTH"
  | "SOUTHWEST"
  | "WEST"
  | "NORTHWEST";

export interface WalkStep {
  relativeDirection: string;
  absoluteDirection: WalkAbsoluteDirection | null;
  streetName: string;
  bogusName: boolean;
  area: boolean;
  stairs: boolean;
  /** False means no steep slope was observed; it does not confirm a flat step. */
  steepSlope: boolean;
  distanceM: number;
  location: [number, number];
}

export interface IntermediateStop {
  name: string;
  stationUid?: string;
  location?: [number, number];
}

export interface WalkLeg extends WalkA11yDetails {
  type: "WALK";
  a11yRefs?: string[];
  from: string;
  to: string;
  distanceM: number;
  minutesEst: number;
  polyline: [number, number][];
  a11yFacilities: IOsmA11y[];
  exitInfo?: {
    exitName: string;
    exitNumber: string;
    type: "elevator" | "ramp";
    coords: [number, number];
  } | null;
  steps?: WalkStep[];
  /**
   * CSR-engine facility runs over this leg's `polyline`, ordered and
   * non-overlapping. Absent on OTP / Valhalla walking legs, which carry no
   * per-edge facility provenance; absent therefore means "not observed by this
   * engine", never "no facilities on the ground".
   */
  a11ySegments?: WalkA11ySegment[];
  /**
   * Ramps recorded on the government sidewalk segments this CSR leg travels along.
   *
   * This is a sidewalk-segment attribute, not a located feature: it says how many kerb
   * ramps the traversed sidewalks carry, never where they are. Absent on OTP / Valhalla
   * legs, which have no government sidewalk match.
   */
  sidewalkRampCount?: number;
  /**
   * Curb-ramp facilities recorded near this CSR leg's traversed edges, in
   * path order and de-duplicated by coordinate. Absent on OTP / Valhalla
   * walking legs, which carry no per-edge facility provenance; absence
   * therefore means "not observed by this engine", never "no ramps on the
   * ground". An empty array does not mean no ramps exist along the way
   * either: roughly a third of recorded ramp points sit where the graph has
   * no matching sidewalk/footway/crossing edge to snap to.
   */
  a11yPoints?: WalkA11yPoint[];
}

export interface BusLeg {
  type: "BUS";
  a11yRefs?: string[];
  routeName: string;
  departureStop: string;
  arrivalStop: string;
  departureStopId?: string;
  arrivalStopId?: string;
  cityCode?: string;
  departureTime?: string;
  arrivalTime?: string;
  waitInfo: WaitInfo;
  estimatedWaitMinutes?: number;
  direction: 0 | 1;
  polyline: [number, number][];
  departureStopA11y: IOsmA11y[];
  arrivalStopA11y: IOsmA11y[];
  tdxCity?: string;
  intermediateStops?: IntermediateStop[];
  /** Current TDX operating alerts touching this bus route or stop. */
  alerts?: MatchedAlert[];
}

export interface MetroLeg {
  type: "METRO";
  a11yRefs?: string[];
  railSystem: string;
  lineId: string;
  lineName: string;
  lineUid: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUid: string;
  arrivalStationUid: string;
  direction: 0 | 1;
  stopsCount: number;
  rideMinutes: number;
  departureTime?: string;
  arrivalTime?: string;
  waitInfo: WaitInfo;
  estimatedWaitMinutes?: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
  intermediateStops?: IntermediateStop[];
  /** Current TDX operating alerts touching this leg's stations or line. */
  alerts?: MetroAlert[];
}

export interface ThsrLeg {
  type: "THSR";
  a11yRefs?: string[];
  trainNo: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes?: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
  intermediateStops?: IntermediateStop[];
  /** Current TDX operating alerts touching this THSR train or line section. */
  alerts?: MatchedAlert[];
}

export interface TraLeg {
  type: "TRA";
  a11yRefs?: string[];
  trainNo: string;
  trainTypeName: string;
  departureStation: string;
  arrivalStation: string;
  departureStationUID: string;
  arrivalStationUID: string;
  departureTime: string;
  arrivalTime: string;
  rideMinutes: number;
  waitInfo: WaitInfo;
  estimatedWaitMinutes?: number;
  polyline: [number, number][];
  departureStationA11y: IOsmA11y[];
  arrivalStationA11y: IOsmA11y[];
  facilityHighlights: string[];
  intermediateStops?: IntermediateStop[];
  /** Current TDX operating alerts touching this TRA train, line, or stations. */
  alerts?: MatchedAlert[];
}

export interface DriveStep {
  instruction: string;
  distanceM: number;
  durationMin: number;
  polyline: [number, number][];
  maneuver?: string;
}

/**
 * A road-driving leg (car or motorcycle) produced by the road router.
 * `durationMin` is free-flow; `durationInTrafficMin` is the traffic-aware
 * estimate when a future departure time was supplied.
 */
export interface DriveLeg {
  type: "DRIVE" | "MOTORCYCLE";
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  distanceM: number;
  durationMin: number;
  durationInTrafficMin?: number;
  trafficLevel?: "light" | "moderate" | "heavy";
  summary?: string;
  polyline: [number, number][];
  steps?: DriveStep[];
  modeFallback?: "DRIVE";
}

export interface AccessibleRoute {
  routeId: string;
  routeName: string;
  totalMinutes: number;
  transferCount: number;
  legs: (WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg | DriveLeg)[];
  accessibilityHighlights: string[];
  /**
   * Pure-walk planner provenance. `pedestrian-a11y` is a CSR-selected route;
   * `otp-fallback` states plainly that CSR did not decide it, so its
   * stair/slope/width/fare-gate protection was not applied. Transit and driving
   * routes omit this optional field.
   */
  engine?: PureWalkRouteEngine;
  degraded?: boolean;
  warnings?: string[];
  departureDate?: string;
  _scheduledDepartureTime?: number;
  _scheduledEndTime?: number;
  _isFutureScheduled?: boolean;
  facilities?: Record<string, SlimA11y>;
  accessibilityScore?: number;
  accessibilityLabel?: "excellent" | "good" | "fair" | "poor" | "critical";
  dataConfidence?: "high" | "medium" | "low";
  scoreWarnings?: string[];
  totalWalkDistanceM?: number;
  scoreComponents?: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
    walkPenalty: number;
    environmentScore?: number;
  };
  accessibilitySummary?: string;
  hazardAdvisory?: RouteHazardAdvisory;
  attribution?: string;
  /** Short-lived bearer capability for arming voice navigation. */
  routeToken?: string;
}
