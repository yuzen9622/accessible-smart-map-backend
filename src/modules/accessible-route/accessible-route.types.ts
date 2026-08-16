/**
 * accessible-route module type declarations — the shapes used across the
 * module's own files (the orchestrator service, scoring engine, OTP planner
 * and response slimming). Planner-specific types live beside each planner in
 * planners/<planner>.types.ts; cross-module contracts live in src/types.
 */

import type { ResponseCode } from "../../types/code";
import type {
  AccessibilityMode,
  AccessibleRoute,
  TravelMode,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  DriveLeg,
} from "../../types/route";
import type { RouteIntent } from "../../types/ai";
import type {
  MatchedAlert,
  MetroAlertResult,
  TaiwanCityEn,
} from "../../types/transit";
import type { RouteFailureData } from "./accessible-route.failure";

export type TagWeightMap = Record<string, Record<string, number>>;

export type ScoreLabel = "excellent" | "good" | "fair" | "poor" | "critical";

export interface ModeProfile {
  a11yWeight: number;
  timeWeight: number;
  transferPenaltyMultiplier: number;
  tier1Required: boolean;
  criticalWeights: {
    elevator: number;
    flushKerb: number;
    ramp: number;
    wheelchairYes: number;
    accessibleToilet: number;
    audioSignal: number;
    tactilePaving: number;
  };
}

export type DataConfidence = "high" | "medium" | "low";

/**
 * Hard accessibility constraints for one plan request. Orthogonal to
 * `AccessibilityMode` (which only tunes weights): these decide whether a route
 * is *eligible* at all. Callers may send them explicitly (the client's A11y
 * Profile derives them from e.g. "uses a walker"); when omitted they fall back
 * to the mode profile's `tier1Required`, which preserves the pre-flag behaviour.
 */
export interface A11yConstraints {
  /** Ask the street engine for step-free paths and drop walk legs through a stairs-only barrier. */
  avoidStairs: boolean;
  /** Drop rail legs whose station has facility data but no working elevator. */
  requireElevator: boolean;
}

/** Caller-supplied overrides for {@link A11yConstraints}; unset fields fall back to the mode default. */
export type A11yConstraintOverrides = Partial<A11yConstraints>;

export interface RouteAccessibilityScore {
  totalScore: number;
  label: ScoreLabel;
  dataConfidence: DataConfidence;
  warnings: string[];
  components: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
    walkPenalty: number;
    environmentScore?: number;
  };
}

export type LatLng = { lat: number; lng: number };

export type RoadTravelMode = Exclude<TravelMode, "transit">;

export interface FindAccessibleRoutesOptions {
  mode?: AccessibilityMode;
  maxTransfers?: 0 | 1 | 2;
  departureTime?: Date;
  format?: "standard" | "compact";
  waypoints?: LatLng[];
  avoidStairs?: boolean;
  requireElevator?: boolean;
}

/** Detailed transit planner outcome for callers that must distinguish no route from an unavailable upstream. */
export type FindAccessibleRoutesResult =
  | { status: "ok"; routes: AccessibleRoute[] }
  | { status: "no_route" | "unavailable"; routes: [] };

export interface PlanRoadRouteOptions {
  travelMode: RoadTravelMode;
  waypoints?: LatLng[];
  departureTime?: Date;
  mode?: AccessibilityMode;
  avoidStairs?: boolean;
  /** True destination for the tail walk when the drive routes to a proxy arrival point (e.g. disabled parking). */
  finalWalkTarget?: LatLng;
}

export interface FindDrivingRoutesOptions {
  travelMode: RoadTravelMode;
  waypoints?: LatLng[];
  departureTime?: Date;
  mode?: AccessibilityMode;
  avoidStairs?: boolean;
  /** True destination for the tail walk when `destination` is a proxy arrival point (e.g. disabled parking). */
  finalWalkTarget?: LatLng;
  /** Set when the drive was routed to a disabled parking bay, for the arrival highlight. */
  arrivalParking?: { name: string; distanceM: number };
}

export interface PlanRouteRequest {
  origin?: unknown;
  destination?: unknown;
  query?: string;
  userLocation?: { latitude: number; longitude: number };
  maxTransfers?: number;
  departureTime?: string;
  format?: string;
  mode?: RouteIntent["mode"];
  travelMode?: TravelMode;
  waypoints?: (string | { latitude: number; longitude: number })[];
  avoidStairs?: boolean;
  requireElevator?: boolean;
  needsAccessibleToilet?: boolean;
  needsHandrail?: boolean;
  maxSlopePercent?: number;
  /** Authenticated caller's id, set by the controller from an optional Bearer token; never client-supplied. */
  userId?: string;
}

export type PlanRouteResult =
  | {
      ok: true;
      data: {
        origin: { lat: number; lng: number };
        destination: { lat: number; lng: number };
        city: TaiwanCityEn;
        travelMode: TravelMode;
        waypoints?: LatLng[];
        routes: AccessibleRoute[];
        intent?: RouteIntent;
        /** Present only when the caller (or their profile) requested a maxSlopePercent; tells them whether it could actually be enforced. */
        slopeConstraint?: {
          requestedMaxPercent: number;
          enforced: boolean;
          note: string;
        };
        /** Present only when a ridden metro system currently has alerts; per-leg copies sit on the METRO legs. */
        metroAlerts?: MetroAlertResult[];
        /** Present only when ridden transit legs (bus/metro/tra/thsr) have active alerts. */
        transitAlerts?: MatchedAlert[];
      };
    }
  | {
      ok: false;
      status: ResponseCode;
      error: string;
      data?: RouteFailureData;
    };

export type AnyLeg = WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg | DriveLeg;
