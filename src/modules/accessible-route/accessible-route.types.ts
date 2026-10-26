import type { SupportedLang } from "../../types/lang";
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
  TransitPreference,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  DriveLeg,
  ScoreFactor,
} from "../../types/route";
export type { ScoreFactor } from "../../types/route";
import type { RouteIntent } from "../../types/ai";
import type {
  MatchedAlert,
  MetroAlertResult,
  TaiwanCityEn,
} from "../../types/transit";
import type { RouteFailureData } from "./accessible-route.failure";
import type { VenueArrival, VenueRoute } from "./venue-leg.types";
import type { TRANSIT_FALLBACK_REASON } from "../../constants/messages";

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
  warningMessages: import("../../types/route-message").RouteMessageDescriptor[];
  components: {
    facilityScore: number;
    timeScore: number;
    criticalFeatureScore: number;
    walkPenalty: number;
    transferPenalty?: number;
    environmentScore?: number;
  };
  factors?: ScoreFactor[];
}

export type LatLng = { lat: number; lng: number };

export type RoadTravelMode = Exclude<TravelMode, "transit">;

export interface FindAccessibleRoutesOptions {
  /** Presentation only; never forwarded as an OTP routing/locale option. */
  language?: SupportedLang;
  transitPreference?: TransitPreference;
  mode?: AccessibilityMode;
  maxTransfers?: 0 | 1 | 2;
  departureTime?: Date;
  format?: "standard" | "compact";
  waypoints?: LatLng[];
  avoidStairs?: boolean;
  requireElevator?: boolean;
  /** Epoch ms shared by every OTP stage of one request (see PlanOtpRouteOptions). */
  deadline?: number;
}

/**
 * Detailed transit planner outcome for callers that must distinguish no route
 * from an unavailable upstream. `walkingBetter` is set when OTP itself
 * reported walking beats transit (WALKING_BETTER_THAN_TRANSIT), as opposed to
 * finding no transit at all.
 */
export type FindAccessibleRoutesResult =
  | { status: "ok"; routes: AccessibleRoute[]; walkingBetter?: boolean }
  | { status: "no_route" | "unavailable"; routes: [] };

export interface PlanRoadRouteOptions {
  travelMode: RoadTravelMode;
  waypoints?: LatLng[];
  departureTime?: Date;
  mode?: AccessibilityMode;
  avoidStairs?: boolean;
  /** True destination for the tail walk when the drive routes to a proxy arrival point (e.g. disabled parking). */
  finalWalkTarget?: LatLng;
  /** Closed-road points the route must avoid; dropped when no route survives them. */
  excludeLocations?: LatLng[];
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
  transitPreference?: TransitPreference;
  language?: SupportedLang;
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
  /**
   * Internal, never client-supplied: the destination is a live person's
   * position (an SOS victim), so it must not be redirected to a park entrance.
   */
  keepExactDestination?: boolean;
  /**
   * A place inside an indoor venue (campus). Mutually exclusive with
   * `destination` and `query`; requires `origin`. The outdoor route ends at
   * the chosen venue gate and `venueLeg` continues inside.
   */
  destinationVenuePlace?: { venueId: string; placeId: string };
  /**
   * Internal, never client-supplied: the venue hand-over stored on a route
   * token. A reroute plans outdoors to its fixed gate and rebuilds the leg.
   */
  venueArrival?: VenueArrival;
}

export interface CanonicalPlanRouteRequest extends PlanRouteRequest {
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  userLocation: { latitude: number; longitude: number };
  travelMode: TravelMode;
  mode: AccessibilityMode;
  maxTransfers: number;
  format: "standard" | "compact";
  waypoints: { latitude: number; longitude: number }[];
  avoidStairs: boolean;
  requireElevator: boolean;
  needsAccessibleToilet: boolean;
  needsHandrail: boolean;
}

export type RerouteReason =
  | "OFF_ROUTE"
  | "FACILITY_OUTAGE"
  | "CONFIRMED_HAZARD"
  | "TRANSIT_DISRUPTION"
  | "MANUAL";

export interface NavigationRouteEnvelope {
  schemaVersion: 1;
  route: AccessibleRoute;
  navigationId: string;
  routeVersion: number;
  canonicalRequest: CanonicalPlanRouteRequest;
}

export interface RerouteRequest {
  completedLegIndex?: number;
  language?: SupportedLang;
  routeToken: string;
  currentPosition: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  previousRouteVersion: number;
  reason: RerouteReason;
  clientRequestId: string;
}

export interface RerouteStep {
  index: number;
  instruction: string;
  legType: string;
  distanceM: number | null;
  isTransit: boolean;
}

export interface RerouteInstruction {
  text: string;
  type: string;
  bearing: number | null;
  relativeDirection: string | null;
  maneuver: string | null;
  distanceM: number | null;
  streetName: string | null;
  legType: string;
  stairs: boolean;
  legIndex: number;
  polylineIndex: number | null;
  cumulativeDistanceM: number;
}

export interface RerouteData {
  navigationId: string;
  previousRouteVersion: number;
  routeVersion: number;
  routeToken: string;
  route: AccessibleRoute;
  instructions: RerouteInstruction[];
  steps: RerouteStep[];
  warnings: string[];
  warningDetails?: import("../../types/route-message").RouteMessageDetail[];
  currentStepIndex: 0;
  replayed: boolean;
  /** Present when the trip ends inside a venue: the gate hand-over, on the venue version used. */
  venueArrival?: VenueArrival;
  /** The indoor leg from the gate, rebuilt on this reroute. */
  venueLeg?: VenueRoute;
}

/** The accessible park entrance a park-bound route was led to. */
export interface ArrivalEntrance {
  parkName: string;
  entranceName: string;
  location: LatLng;
  /** Surveyed minimum clear width, metres. */
  minClearWidthM: number | null;
  /** Surveyed entrance slope, percent. */
  slopePercent: number | null;
  /** Straight-line distance from the destination the caller asked for. */
  distanceFromRequestedM: number;
}

export interface TransitFallback {
  travelMode: "walk";
  reason: (typeof TRANSIT_FALLBACK_REASON)[keyof typeof TRANSIT_FALLBACK_REASON];
}

export type PlanRouteResult =
  | {
      ok: true;
      data: {
        origin: { lat: number; lng: number };
        destination: { lat: number; lng: number };
        city: TaiwanCityEn | null;
        travelMode: TravelMode;
        transitPreference?: TransitPreference;
        waypoints?: LatLng[];
        /** Present only when the destination is a park and the route was led to one of its accessible entrances; `destination` is then that entrance. */
        arrivalEntrance?: ArrivalEntrance;
        /** Present only for `destinationVenuePlace`: the venue gate every route ends at; `destination` is that gate. */
        venueArrival?: VenueArrival;
        /** Present only for `destinationVenuePlace`: the indoor route from the gate to the place. */
        venueLeg?: VenueRoute;
        routes: AccessibleRoute[];
        intent?: RouteIntent;
        /** Present only when the caller (or their profile) requested a maxSlopePercent; tells them whether it could actually be enforced. */
        slopeConstraint?: {
          requestedMaxPercent: number;
          enforced: boolean;
          note: string;
        };
        /** Present only when a transit request was answered with walking routes. */
        fallback?: TransitFallback;
        /** Present only when a ridden metro system currently has alerts; per-leg copies sit on the METRO legs. */
        metroAlerts?: MetroAlertResult[];
        /** Present only when ridden transit legs (bus/metro/tra/thsr) have active alerts. */
        transitAlerts?: MatchedAlert[];
        /** Internal, non-enumerable reroute intent captured after resolution. */
        _canonicalRequest?: CanonicalPlanRouteRequest;
      };
    }
  | {
      ok: false;
      status: ResponseCode;
      error: string;
      data?: RouteFailureData | { reason: string; [key: string]: unknown };
    };

export type AnyLeg = WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg | DriveLeg;
