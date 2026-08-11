/**
 * Route / leg domain model — the shared shape of a planned accessible route.
 *
 * Lives in the neutral types layer (not in the orchestrator) so that every
 * planner in src/service/* and the orchestrator in
 * modules/accessible-route/accessible-route.service.ts can depend on these
 * types DOWNWARD, with no upward import and no runtime circular dependency.
 */

import type { HazardSeverity, HazardType, IOsmA11y } from "./index";

export type AccessibilityMode =
  | "wheelchair"
  | "elderly"
  | "visual_impaired"
  | "normal";

/**
 * Transport mode requested by the client — orthogonal to AccessibilityMode.
 * "transit" plans via OTP (bus/metro/rail); the rest plan via the road router.
 */
export type TravelMode = "transit" | "drive" | "motorcycle" | "walk";

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

export interface WalkStep {
  /** Upstream turn-by-turn text when the planner already provides localized guidance. */
  instruction?: string;
  /** Normalized maneuver code when supplied by the road planner. */
  maneuver?: string;
  relativeDirection: string;
  absoluteDirection: string | null;
  streetName: string;
  bogusName: boolean;
  area: boolean;
  stairs: boolean;
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
