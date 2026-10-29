import type { ResponseCode } from "../../types/code";
import type { SupportedLang } from "../../types/lang";
import type { AccessibilityMode } from "../../types/route";
import type { RouteFailureResult } from "./accessible-route.failure";
import type { VenueArrival, VenueRoute } from "./venue-leg.types";

/**
 * Port for leading an outdoor route into a venue (campus) place.
 *
 * The planner needs the venue planner for `destinationVenuePlace` and for
 * rerouting such a trip, but must not depend on the `venue` module — `venue`
 * already depends on the planner (it routes on the pedestrian CSR core and
 * returns the planner's failure contract), so a direct import would close a
 * cycle. The planner therefore owns the interface and `venue` supplies the
 * implementation, which is registered once at the composition root
 * (src/app.ts).
 */
export interface ResolveVenueArrivalInput {
  venueId: string;
  placeId: string;
  /** Trip origin, for the straight-line part of the gate choice. */
  origin: { lat: number; lng: number };
  mode: AccessibilityMode;
  lang: SupportedLang;
}

export type VenueArrivalResult =
  | { ok: true; venueArrival: VenueArrival; venueLeg: VenueRoute }
  | { ok: false; status: ResponseCode.NOT_FOUND; error: string }
  | RouteFailureResult;

export interface ResolveVenueDepartureInput {
  venueId: string;
  placeId: string;
  /** Trip destination, for the straight-line part of the gate choice. */
  destination: { lat: number; lng: number };
  mode: AccessibilityMode;
  lang: SupportedLang;
}

/** The gate a trip leaves the venue by and the indoor leg place → gate. */
export type VenueDepartureResult =
  | { ok: true; venueDeparture: VenueArrival; venueDepartureLeg: VenueRoute }
  | { ok: false; status: ResponseCode.NOT_FOUND; error: string }
  | RouteFailureResult;

export type ReplanVenueLegResult =
  | { ok: true; venueArrival: VenueArrival; venueLeg: VenueRoute }
  | { ok: false; stale: true }
  | RouteFailureResult;

export interface VenueArrivalPlanner {
  /** Chooses the gate and plans the indoor leg; fail-closed. */
  resolveVenueArrival(
    input: ResolveVenueArrivalInput,
  ): Promise<VenueArrivalResult>;
  /** Chooses the gate a trip leaves by and plans the indoor leg to it; fail-closed. */
  resolveVenueDeparture(
    input: ResolveVenueDepartureInput,
  ): Promise<VenueDepartureResult>;
  /** Rebuilds the indoor leg from the stored gate on the current venue. */
  replanVenueLeg(
    arrival: VenueArrival,
    lang: SupportedLang,
  ): Promise<ReplanVenueLegResult>;
  /** Whether the stored gate and place are still valid for the trip's mode. */
  isVenueArrivalCurrent(arrival: VenueArrival): Promise<boolean>;
}

let planner: VenueArrivalPlanner | null = null;

/**
 * Installs the concrete venue planner. Called once from the composition root.
 *
 * @param next Implementation supplied by the `venue` module
 */
export function registerVenueArrivalPlanner(next: VenueArrivalPlanner): void {
  planner = next;
}

/**
 * @returns The registered venue planner.
 * @throws Error when none was registered, which is a wiring bug: every venue
 * request would otherwise silently lose its indoor leg.
 */
export function venueArrivalPlanner(): VenueArrivalPlanner {
  if (!planner) {
    throw new Error("[accessible-route] no venue arrival planner registered");
  }
  return planner;
}
