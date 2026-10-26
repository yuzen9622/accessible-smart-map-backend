/**
 * Contract of an indoor (venue) leg as the accessible-route planner returns
 * it, and of the hand-over from an outdoor route to that leg. The venue
 * module produces values of these shapes; accessible-route owns them so it
 * never has to import the venue module (module dependencies stay one-way:
 * venue -> accessible-route).
 */
import type { AccessibilityMode } from "../../types/route";

/** `[lng, lat, z]`, z in metres above the venue datum. */
export type LngLatZ = [number, number, number];

export type VenueStepType =
  | "depart"
  | "walk"
  | "enter"
  | "exit"
  | "elevator"
  | "escalator"
  | "stairs"
  | "steps"
  | "ramp"
  | "arrive";

export type VenueManeuver = "left" | "right" | "uturn";

export interface VenueRouteStep {
  type: VenueStepType;
  instruction: string;
  maneuver?: VenueManeuver;
  /** Stable detail.connections ID; null if a slope alone suggested a ramp. */
  connectionId?: string | null;
  /** True if any source edge in the step has unverified height. */
  heightPending?: boolean;
  distanceM: number;
  durationS: number;
  buildingId: string | null;
  levelRef: string | null;
  fromLevelRef?: string;
  toLevelRef?: string;
  /**
   * Inclusive path range. Zero-length enter/exit instructions can trigger at
   * the point before a building boundary; their context names the instruction
   * target. Actual point ownership always comes from path.buildingIds/levelRefs.
   */
  pathStart: number;
  pathEnd: number;
}

/**
 * One floor's part of the route (or the outdoor part), for drawing the path
 * floor by floor. Consecutive segments share their boundary index.
 */
export interface VenueRouteSegment {
  /** null outdoors. */
  buildingId: string | null;
  /** null outdoors. */
  levelRef: string | null;
  /** Inclusive range of `path.coordinates`. */
  pathStart: number;
  pathEnd: number;
}

export interface VenueRoute {
  venueId: string;
  venueVersion: number;
  mode: AccessibilityMode;
  fromPlaceId: string;
  toPlaceId: string;
  distanceM: number;
  durationS: number;
  elevatorRides: number;
  stairFlights: number;
  path: {
    coordinates: LngLatZ[];
    buildingIds: (string | null)[];
    levelRefs: (string | null)[];
  };
  segments: VenueRouteSegment[];
  steps: VenueRouteStep[];
}

/**
 * Where an outdoor route hands over to a venue route, stored on the route
 * token so a reroute can rebuild the indoor leg. The gate is fixed for the
 * whole trip; it is never re-selected.
 */
export interface VenueArrival {
  venueId: string;
  placeId: string;
  gateId: string;
  /** Gate position when the trip was planned. */
  gateLocation: { lat: number; lng: number };
  mode: "wheelchair" | "elderly" | "visual_impaired" | "normal";
  /** Venue version the indoor leg was planned on. */
  venueVersion: number;
}
