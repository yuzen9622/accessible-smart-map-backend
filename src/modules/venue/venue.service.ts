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
import {
  inspectVenue,
  selectVenue,
  type InspectVenueArgs,
  type InspectVenueResult,
} from "./venue.inspect";
import { haversineM } from "./venue.compile";
import type {
  ReplanVenueLegResult,
  ResolveVenueArrivalInput,
  ResolveVenueDepartureInput,
  VenueArrivalResult,
  VenueDepartureResult,
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
 * reachable on foot but not within the mode's limits (stairs, escalators,
 * narrow or steep ways, `wheelchair=no`), or `NO_ROUTE` when it is not
 * connected at all.
 */
export async function planVenueRoute(
  input: PlanVenueRouteInput,
): Promise<PlanVenueRouteResult> {
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
  );
  if (outcome.ok) return { ok: true, route: outcome.route };
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

/**
 * Answers an `inspectVenue` query: picks the venue the query names (or the
 * only one), then reads facts from its compiled data.
 *
 * @param args Validated tool arguments.
 * @param mode Effective mode for costs from `args.nearPlaceId`.
 */
export async function inspectVenueByQuery(
  args: InspectVenueArgs,
  mode: AccessibilityMode,
): Promise<InspectVenueResult> {
  const picked = await resolveVenueQuery(args.venue);
  if (!picked.ok) return picked;
  const entry = await getCompiledVenue(picked.venueId);
  if (!entry) return venueNotFound();
  return inspectVenue(entry, args, mode, getRoutingConfig().venue);
}

type VenueNotFound = {
  ok: false;
  reason: "VENUE_NOT_FOUND";
  candidates: { id: string; name: string }[];
};

async function venueNotFound(): Promise<VenueNotFound> {
  const venues = await listVenues();
  return {
    ok: false,
    reason: "VENUE_NOT_FOUND",
    candidates: venues.map((v) => ({ id: v.venueId, name: v.name })),
  };
}

/**
 * @param query Venue id or name from an AI tool call; omitted means the only
 * venue when exactly one exists.
 */
export async function resolveVenueQuery(
  query: string | undefined,
): Promise<{ ok: true; venueId: string } | VenueNotFound> {
  const picked = selectVenue(await listVenues(), query);
  return picked.ok
    ? picked
    : { ok: false, reason: "VENUE_NOT_FOUND", candidates: picked.candidates };
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

type GateHandover =
  | { ok: true; handover: VenueArrival; leg: VenueRoute }
  | { ok: false; status: ResponseCode.NOT_FOUND; error: string }
  | RouteFailureResult;

/**
 * Chooses the venue gate an outdoor route meets and plans the indoor leg
 * between that gate and the place: gate → place when arriving, place → gate
 * when departing. Fail-closed: an unknown venue or place is 404; when no gate
 * that serves the mode connects to the place, the whole request fails (422)
 * instead of routing through a gate anyway.
 *
 * The choice is a heuristic, not the true outdoor optimum: the weighted
 * indoor cost (so a mode's stairs penalty counts) plus the straight-line
 * distance between the gate and the far end of the trip, both in metres. Only
 * the chosen gate is then planned outdoors, once.
 */
async function resolveGateHandover(
  input: {
    venueId: string;
    placeId: string;
    /** The outdoor end of the trip: its origin when arriving, destination when departing. */
    farEnd: { lat: number; lng: number };
    mode: AccessibilityMode;
    lang: SupportedLang;
  },
  direction: "arrive" | "depart",
): Promise<GateHandover> {
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
  const plan = (gate: VenuePlace, mode: AccessibilityMode) =>
    direction === "arrive"
      ? planOnGraph(
          entry.graph,
          entry.venue,
          gate,
          target,
          mode,
          config,
          input.lang,
        )
      : planOnGraph(
          entry.graph,
          entry.venue,
          target,
          gate,
          mode,
          config,
          input.lang,
        );
  const gates = entry.venue.places.filter((p) => p.kind === "gate");
  let best: { gate: VenuePlace; leg: VenueRoute; score: number } | null = null;
  let stairsOnly = false;
  for (const gate of gates.filter((g) => gateServes(g, input.mode))) {
    const outcome = plan(gate, input.mode);
    if (!outcome.ok) {
      stairsOnly ||= outcome.reason === "NO_ACCESSIBLE_ROUTE";
      continue;
    }
    const score =
      outcome.costM +
      haversineM([input.farEnd.lng, input.farEnd.lat], gate.location);
    if (!best || score < best.score) best = { gate, leg: outcome.route, score };
  }
  // reachable only through a gate this mode may not use counts as no
  // accessible route, not as a disconnected place
  stairsOnly ||=
    !best &&
    gates.some((g) => !gateServes(g, input.mode) && plan(g, "normal").ok);
  if (!best) {
    return stairsOnly
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
    handover: {
      venueId: input.venueId,
      placeId: target.id,
      gateId: best.gate.id,
      gateLocation: { lat: best.gate.location[1], lng: best.gate.location[0] },
      mode: input.mode,
      venueVersion: entry.version,
    },
    leg: best.leg,
  };
}

/** Chooses the gate an outdoor route leads to and plans gate → place. */
export async function resolveVenueArrival(
  input: ResolveVenueArrivalInput,
): Promise<VenueArrivalResult> {
  const resolved = await resolveGateHandover(
    { ...input, farEnd: input.origin },
    "arrive",
  );
  return resolved.ok
    ? { ok: true, venueArrival: resolved.handover, venueLeg: resolved.leg }
    : resolved;
}

/** Chooses the gate a trip leaves the venue by and plans place → gate. */
export async function resolveVenueDeparture(
  input: ResolveVenueDepartureInput,
): Promise<VenueDepartureResult> {
  const resolved = await resolveGateHandover(
    { ...input, farEnd: input.destination },
    "depart",
  );
  return resolved.ok
    ? {
        ok: true,
        venueDeparture: resolved.handover,
        venueDepartureLeg: resolved.leg,
      }
    : resolved;
}

/**
 * @param arrival Stored hand-over from a route token.
 * @returns Whether the stored gate still exists, unmoved and still usable in
 * the trip's mode, and the destination place still exists in the current
 * venue.
 */
export async function isVenueArrivalCurrent(
  arrival: VenueArrival,
): Promise<boolean> {
  const entry = await getCompiledVenue(arrival.venueId);
  const places = entry?.venue.places ?? [];
  const gate = places.find((p) => p.id === arrival.gateId && p.kind === "gate");
  if (
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
  );
  if (!outcome.ok) {
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
