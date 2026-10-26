import { getRoutingConfig } from "../../config/routing";
import { ROUTE_REASON, VENUE_MSG } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { SupportedLang } from "../../types/lang";
import type { AccessibilityMode } from "../../types/route";
import {
  routeFailure,
  type RouteFailureResult,
} from "../accessible-route/accessible-route.failure";
import { venueConnections, type VenueConnection } from "./venue.connections";
import { buildVenueGraph, type VenueGraph } from "./venue.graph";
import {
  venueBuildings,
  venueWalkways,
  type VenueWalkway,
} from "./venue.presentation";
import * as repository from "./venue.repository";
import { planVenueRoute as planOnGraph, type VenueRoute } from "./venue.route";
import { haversineM } from "./venue.compile";
import type {
  ReplanVenueLegResult,
  ResolveVenueArrivalInput,
  VenueArrivalResult,
} from "../accessible-route/venue-arrival.port";
import type { VenueArrival, VenueDocument, VenuePlace } from "./venue.types";

interface CompiledVenue {
  version: number;
  venue: VenueDocument;
  graph: VenueGraph;
  connections: VenueConnection[];
  walkways: VenueWalkway[];
}

const compiled = new Map<string, CompiledVenue>();
/** Snapshot reads in flight, keyed by `${venueId}:${observedVersion}`. */
const inFlight = new Map<string, Promise<VenueDocument | null>>();
/** A snapshot older than the version just observed is read again this often. */
const MAX_SNAPSHOT_READS = 3;

/**
 * Compiles a snapshot unless the cache already holds that version or a newer
 * one. Synchronous, so concurrent requests cannot interleave inside it and a
 * version is compiled once.
 */
function adopt(venue: VenueDocument): CompiledVenue {
  const current = compiled.get(venue.venueId);
  if (current && current.version >= venue.version) return current;
  const entry: CompiledVenue = {
    version: venue.version,
    venue,
    graph: buildVenueGraph(venue, venue.version, getRoutingConfig().venue),
    connections: venueConnections(venue),
    walkways: venueWalkways(venue),
  };
  compiled.set(venue.venueId, entry);
  return entry;
}

/** One shared read of the whole venue document per observed version. */
function readSnapshot(
  venueId: string,
  observed: number,
): Promise<VenueDocument | null> {
  const key = `${venueId}:${observed}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = repository.findVenue(venueId).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * Returns the compiled venue graph, rebuilding it when a newer version was
 * imported. The cheap version read decides whether the cache is current; the
 * whole document is then read once per observed version and compiled under
 * the version it carries itself. A request that observed version V never
 * receives a graph older than V.
 *
 * @param venueId Venue id.
 * @returns The compiled venue, or null when it does not exist.
 */
export async function getCompiledVenue(
  venueId: string,
): Promise<CompiledVenue | null> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_READS; attempt += 1) {
    const observed = await repository.findVenueVersion(venueId);
    if (observed === null) return null;
    const cached = compiled.get(venueId);
    if (cached && cached.version >= observed) return cached;
    const venue = await readSnapshot(venueId, observed);
    if (!venue) return null;
    if (venue.version >= observed) return adopt(venue);
    // the document read lagged behind the version read; read both again
  }
  throw new Error(
    `venue ${venueId}: the stored document stayed older than its version`,
  );
}

/** Test hook: drop every compiled venue. */
export function clearVenueCache(): void {
  compiled.clear();
  inFlight.clear();
}

/** @returns Summaries of every imported venue. */
export async function listVenues() {
  const rows = await repository.listVenueSummaries();
  return rows.map((r) => ({
    venueId: r.venueId,
    name: r.name,
    center: r.center,
    version: r.version,
    importedAt: r.importedAt,
    buildings: r.buildings.map((b) => ({ id: b.id, name: b.name })),
  }));
}

/**
 * @param venueId Venue id.
 * @returns Buildings, levels, places, display features and the stairs,
 * ramps and elevators with their heights, or null.
 */
export async function getVenueDetail(venueId: string) {
  const entry = await getCompiledVenue(venueId);
  if (!entry) return null;
  const v = entry.venue;
  return {
    venueId: v.venueId,
    name: v.name,
    version: v.version,
    importedAt: v.importedAt,
    center: v.center,
    sourceSha256: v.source?.sha256 ?? null,
    buildings: venueBuildings(v),
    places: v.places,
    features: v.features,
    walls: v.walls ?? [],
    connections: entry.connections,
    walkways: entry.walkways,
  };
}

export interface PlanVenueRouteInput {
  venueId: string;
  fromPlaceId: string;
  toPlaceId: string;
  mode: AccessibilityMode;
  lang: SupportedLang;
  /** Absolute internal search deadline, including venue snapshot acquisition. */
  deadlineMs?: number;
}

export type PlanVenueRouteResult =
  | { ok: true; route: VenueRoute }
  | { ok: false; status: ResponseCode.NOT_FOUND; error: string }
  | RouteFailureResult;

/**
 * Plans an accessible route between two places of one venue.
 *
 * @returns The route; 404 for an unknown venue or place; 422
 * `NO_ACCESSIBLE_ROUTE` (with `venueAccessibility`) when the destination is
 * reachable on foot but not within the mode's limits (escalators,
 * narrow or steep ways, `wheelchair=no`), or `NO_ROUTE` when it is not
 * connected at all.
 */
export async function planVenueRoute(
  input: PlanVenueRouteInput,
): Promise<PlanVenueRouteResult> {
  const deadlineMs =
    input.deadlineMs ?? Date.now() + getRoutingConfig().planBudgetMs;
  const entry = await getCompiledVenue(input.venueId);
  if (!entry) {
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: VENUE_MSG.NOT_FOUND,
    };
  }
  const placeById = new Map(entry.venue.places.map((p) => [p.id, p]));
  const from = placeById.get(input.fromPlaceId);
  const to = placeById.get(input.toPlaceId);
  if (!from || !to) {
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: VENUE_MSG.PLACE_NOT_FOUND,
    };
  }
  const outcome = planOnGraph(
    entry.graph,
    entry.venue,
    from,
    to,
    input.mode,
    getRoutingConfig().venue,
    input.lang,
    { deadlineMs },
  );
  if (outcome.ok) return { ok: true, route: outcome.route };
  if (outcome.reason === "UNAVAILABLE")
    return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, input.lang);
  if (outcome.reason === "NO_ACCESSIBLE_ROUTE") {
    return routeFailure(
      ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
      {
        venueAccessibility: {
          venueId: input.venueId,
          placeId: to.id,
          levelRef: outcome.levelRef,
          stepFreeReachable: false,
        },
      },
      input.lang,
    );
  }
  return routeFailure(ROUTE_REASON.NO_ROUTE, {}, input.lang);
}

/** A stored gate that moved further than this is treated as a different gate. */
export const GATE_MOVED_TOLERANCE_M = 1;

/**
 * @returns Whether a gate may start a trip in this mode: every gate for
 * `normal`, otherwise only a gate explicitly tagged `wheelchair=yes`.
 */
function gateServes(gate: VenuePlace, mode: AccessibilityMode): boolean {
  return mode === "normal" || gate.wheelchair === "yes";
}

/**
 * Chooses the gate an outdoor route should lead to and plans the indoor leg
 * from it. Fail-closed: an unknown venue or place is 404; when no gate that
 * serves the mode reaches the place, the whole request fails (422) instead
 * of routing to a gate anyway.
 *
 * With an outdoor callback, compare completed whole-trip durations within
 * the best reachable policy tier. Standalone callers retain the indoor plus
 * straight-line heuristic.
 */
export async function resolveVenueArrival(
  input: ResolveVenueArrivalInput,
): Promise<VenueArrivalResult> {
  const deadlineMs =
    input.deadlineMs ?? Date.now() + getRoutingConfig().planBudgetMs;
  const entry = await getCompiledVenue(input.venueId);
  if (!entry) {
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: VENUE_MSG.NOT_FOUND,
    };
  }
  const target = entry.venue.places.find((p) => p.id === input.placeId);
  if (!target) {
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: VENUE_MSG.PLACE_NOT_FOUND,
    };
  }
  const config = getRoutingConfig().venue;
  const gates = entry.venue.places.filter((p) => p.kind === "gate");
  let best: { gate: VenuePlace; leg: VenueRoute; score: number } | null = null;
  let inaccessible = false;
  const eligible = gates.filter((g) => gateServes(g, input.mode));
  const tiers = input.mode === "wheelchair" ? [false, true] : [false];
  for (const allowStairsFallback of tiers) {
    let unavailable = false;
    for (const gate of eligible) {
      const outcome = planOnGraph(
        entry.graph,
        entry.venue,
        gate,
        target,
        input.mode,
        config,
        input.lang,
        { deadlineMs, allowStairsFallback },
      );
      if (!outcome.ok) {
        if (outcome.reason === "UNAVAILABLE") unavailable = true;
        inaccessible ||= outcome.reason === "NO_ACCESSIBLE_ROUTE";
        continue;
      }
      let score: number;
      if (input.planOutdoorApproach) {
        const approach = await input.planOutdoorApproach({
          venueArrival: {
            venueId: input.venueId,
            placeId: target.id,
            gateId: gate.id,
            gateLocation: { lat: gate.location[1], lng: gate.location[0] },
            mode: input.mode,
            venueVersion: entry.version,
          },
          venueLeg: outcome.route,
          allowStairsFallback,
        });
        if (approach.status !== "ok") {
          unavailable ||= approach.status === "unavailable";
          continue;
        }
        if (!Number.isFinite(approach.durationS) || approach.durationS < 0) {
          unavailable = true;
          continue;
        }
        score = approach.durationS + outcome.route.durationS;
      } else {
        score =
          outcome.costM +
          haversineM([input.origin.lng, input.origin.lat], gate.location);
      }
      if (!best || score < best.score)
        best = { gate, leg: outcome.route, score };
    }
    if (best) break;
    if (unavailable)
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, input.lang);
  }
  if (!best) {
    for (const gate of gates.filter((g) => !gateServes(g, input.mode))) {
      const outcome = planOnGraph(
        entry.graph,
        entry.venue,
        gate,
        target,
        "normal",
        config,
        input.lang,
        { deadlineMs },
      );
      if (!outcome.ok && outcome.reason === "UNAVAILABLE")
        return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, input.lang);
      inaccessible ||= outcome.ok;
    }
  }
  if (!best) {
    return inaccessible
      ? routeFailure(
          ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
          {
            venueAccessibility: {
              venueId: input.venueId,
              placeId: target.id,
              levelRef: target.levelRef,
              stepFreeReachable: false,
            },
          },
          input.lang,
        )
      : routeFailure(ROUTE_REASON.NO_ROUTE, {}, input.lang);
  }
  return {
    ok: true,
    venueArrival: {
      venueId: input.venueId,
      placeId: target.id,
      gateId: best.gate.id,
      gateLocation: { lat: best.gate.location[1], lng: best.gate.location[0] },
      mode: input.mode,
      venueVersion: entry.version,
    },
    venueLeg: best.leg,
  };
}

/**
 * @param arrival Stored hand-over from a route token.
 * @returns Whether the stored venue version is current, the gate still exists
 * unmoved and usable in the trip's mode, and the destination still exists.
 */
export async function isVenueArrivalCurrent(
  arrival: VenueArrival,
): Promise<boolean> {
  const entry = await getCompiledVenue(arrival.venueId);
  const places = entry?.venue.places ?? [];
  const gate = places.find((p) => p.id === arrival.gateId && p.kind === "gate");
  if (
    !entry ||
    entry.version !== arrival.venueVersion ||
    !gate ||
    !gateServes(gate, arrival.mode) ||
    !places.some((p) => p.id === arrival.placeId)
  ) {
    return false;
  }
  const moved = haversineM(
    [arrival.gateLocation.lng, arrival.gateLocation.lat],
    gate.location,
  );
  return moved <= GATE_MOVED_TOLERANCE_M;
}

/**
 * Rebuilds the indoor leg of a stored hand-over on the current venue
 * version, from the same gate. The returned arrival carries the version that
 * was actually used, so the next reroute does not carry an old version.
 *
 * @returns The new leg; `stale` when the gate or place is gone or the gate
 * moved; 422 when the place is no longer reachable from that gate.
 */
export async function replanVenueLeg(
  arrival: VenueArrival,
  lang: SupportedLang,
  deadlineMs = Date.now() + getRoutingConfig().planBudgetMs,
): Promise<ReplanVenueLegResult> {
  const entry = await getCompiledVenue(arrival.venueId);
  const places = entry?.venue.places ?? [];
  const gate = places.find((p) => p.id === arrival.gateId && p.kind === "gate");
  const target = places.find((p) => p.id === arrival.placeId);
  // a gate that no longer serves the mode is stale too: never re-select one
  if (!entry || !gate || !target || !gateServes(gate, arrival.mode)) {
    return { ok: false, stale: true };
  }
  const moved = haversineM(
    [arrival.gateLocation.lng, arrival.gateLocation.lat],
    gate.location,
  );
  if (moved > GATE_MOVED_TOLERANCE_M) return { ok: false, stale: true };
  const outcome = planOnGraph(
    entry.graph,
    entry.venue,
    gate,
    target,
    arrival.mode,
    getRoutingConfig().venue,
    lang,
    { deadlineMs },
  );
  if (!outcome.ok) {
    if (outcome.reason === "UNAVAILABLE")
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, lang);
    return outcome.reason === "NO_ACCESSIBLE_ROUTE"
      ? routeFailure(
          ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
          {
            venueAccessibility: {
              venueId: arrival.venueId,
              placeId: target.id,
              levelRef: target.levelRef,
              stepFreeReachable: false,
            },
          },
          lang,
        )
      : routeFailure(ROUTE_REASON.NO_ROUTE, {}, lang);
  }
  return {
    ok: true,
    venueArrival: { ...arrival, venueVersion: entry.version },
    venueLeg: outcome.route,
  };
}
