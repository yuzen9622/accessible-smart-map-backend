import type {
  AccessibilityMode,
  AccessibleRoute,
  BusLeg,
  BusDepartureCandidate,
  BusVehicleAccessibility,
} from "../../types/route";
import { taipeiIsoOffset, taipeiHHmm } from "../../config/taipei-time";
import { copyWithDescriptors } from "../../utils/route-source-names";
import {
  getCanonicalBusPair,
  type CandidateRequestBudget,
} from "../transit/bus-stop-pair-eta.service";
import type { BusPairRoute } from "../transit/bus.repository";

export interface ScheduledCandidateSeed {
  candidate: BusDepartureCandidate;
  leg: BusLeg;
}
export interface BusRouteCandidateContext {
  mode: AccessibilityMode;
  routeDepartureTime: number;
  timeline: CandidateTimeline;
  legs: Record<
    number,
    {
      leg: BusLeg;
      canonicalDepartureStopId: string;
      canonicalArrivalStopId: string;
      scheduledSeeds: ScheduledCandidateSeed[];
      effectiveBoardingReadyAt: number;
      selectedCandidateId?: string;
      candidateSearchComplete: boolean;
    }
  >;
}
const contexts = new WeakMap<AccessibleRoute, BusRouteCandidateContext>();
export function getBusCandidateContext(
  route: AccessibleRoute,
): BusRouteCandidateContext | undefined {
  return (
    contexts.get(route) ??
    Object.getOwnPropertyDescriptor(route, "_busCandidateContext")?.value
  );
}

export function routeCandidateTimeline(
  route: AccessibleRoute,
): CandidateTimeline | null {
  const timeline: CandidateTimeline = [];
  for (const [legIndex, leg] of route.legs.entries()) {
    if (leg.type === "WALK")
      timeline.push({
        type: "WALK",
        durationMs:
          Object.getOwnPropertyDescriptor(leg, "_durationMs")?.value ??
          leg.minutesEst * 60000,
      });
    else if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE")
      timeline.push({
        type: "WALK",
        durationMs: (leg.durationInTrafficMin ?? leg.durationMin) * 60000,
      });
    else if (leg.type === "BUS")
      timeline.push({
        type: "BUS",
        legIndex,
        minimumBoardingSlackMs: 0,
      });
    else if (
      leg.type === "METRO" ||
      leg.type === "TRA" ||
      leg.type === "THSR"
    ) {
      if (
        leg._scheduledDepartureTime === undefined ||
        leg._scheduledArrivalTime === undefined
      )
        return null;
      timeline.push({
        type: "FIXED_TRANSIT",
        legIndex,
        departureAt: leg._scheduledDepartureTime,
        arrivalAt: leg._scheduledArrivalTime,
        minimumBoardingSlackMs: 0,
      });
    }
  }
  return timeline;
}
const wholeMinutes = (from: number, to: number): number =>
  Math.max(0, Math.round((to - from) / 60000));
function seedOf(leg: BusLeg, now: number): ScheduledCandidateSeed | null {
  const stops = leg.scheduledTrip?.stops;
  const first = stops?.[0],
    last = stops?.[stops.length - 1];
  const board =
    first?.departureAt ?? first?.arrivalAt ?? leg._scheduledDepartureTime;
  const end = last?.arrivalAt ?? last?.departureAt ?? leg._scheduledArrivalTime;
  if (
    board === undefined ||
    end === undefined ||
    !Number.isFinite(board) ||
    !Number.isFinite(end) ||
    end < board ||
    !leg.departureStopId ||
    !leg.arrivalStopId
  )
    return null;
  return {
    leg,
    candidate: {
      candidateId: `${leg.subRouteUid}|${leg.direction}|${leg.scheduledTrip?.tripId ?? leg._scheduledTripId ?? "schedule"}|${board}`,
      routeName: leg.routeName,
      subRouteUid: leg.subRouteUid,
      subRouteName: leg.subRouteName,
      direction: leg.direction,
      departureStopId: leg.departureStopId,
      arrivalStopId: leg.arrivalStopId,
      tripId: leg.scheduledTrip?.tripId,
      estimatedWaitMinutes: wholeMinutes(now, board),
      boardingTime: taipeiIsoOffset(board),
      alightingTime: taipeiIsoOffset(end),
      boardingTimeSource: "schedule",
      alightingTimeSource: "schedule",
      vehicleAccessibility: normalizeVehicleAccessibility(
        leg.isLowFloor,
        leg.hasLiftOrRamp,
      ),
      hasLiftOrRamp: leg.hasLiftOrRamp ?? null,
      selected: false,
    },
  };
}
/** Margin for a tracked bus running ahead of its timetable. */
const SAME_TRIP_SLACK_MS = 5 * 60000;
/** Live ETA rows name the next bus at the boarding stop, so a timetable trip
 * of the same run boarding before that bus (or within the slack after it) is
 * that bus. It replaces the timetable copy only when it also has a live
 * alighting time; otherwise the copy is what the journey chain can trust.
 * A row without a plate is only a predicted first-stop departure: it twins a
 * trip within the slack either way, and the timetable copy is the one that
 * carries per-stop times. */
function sameTrip(
  live: BusDepartureCandidate,
  seed: BusDepartureCandidate,
): boolean {
  if (
    live.subRouteUid !== seed.subRouteUid ||
    live.direction !== seed.direction
  )
    return false;
  const gap =
    candidateEpoch(seed.boardingTime) - candidateEpoch(live.boardingTime);
  return live.plateNumb
    ? gap <= SAME_TRIP_SLACK_MS
    : Math.abs(gap) <= SAME_TRIP_SLACK_MS;
}
/** The planned leg re-pointed at another service between the same stops,
 * with geometry from that route's own ordered stops. A different service
 * must never inherit the planned line's trip, plate or vehicle. */
function pairLeg(base: BusLeg, route: BusPairRoute): BusLeg | null {
  const stops = (route.stops ?? [])
    .filter((s) => s.seq >= route.board.seq && s.seq <= route.alight.seq)
    .sort((a, b) => a.seq - b.seq);
  if (
    !route.board.stopUID ||
    !route.alight.stopUID ||
    stops.length < 2 ||
    stops.some((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lng))
  )
    return null;
  const routeName = route.routeName?.Zh_tw ?? base.routeName;
  const leg = copyWithDescriptors(base, {
    geometrySource: "route_stops",
    routeName,
    subRouteUid: route.subRouteUid,
    subRouteName: route.subRouteName?.Zh_tw ?? routeName,
    direction: route.direction === 1 ? 1 : 0,
    departureStopId: route.board.stopUID,
    arrivalStopId: route.alight.stopUID,
    departureStop: route.board.stopName?.Zh_tw ?? base.departureStop,
    arrivalStop: route.alight.stopName?.Zh_tw ?? base.arrivalStop,
    polyline: stops.map((s) => [s.lng, s.lat] as [number, number]),
    intermediateStops: stops.slice(1, -1).map((s) => ({
      name: s.stopName?.Zh_tw ?? "",
      stationUid: s.stopUID,
      location: [s.lng, s.lat] as [number, number],
    })),
  });
  delete leg.routeNameEn;
  delete leg.routeDisplayName;
  delete leg.alerts;
  delete leg.scheduledTrip;
  delete leg.plateNumb;
  delete leg.isLowFloor;
  delete leg.hasLiftOrRamp;
  delete leg.lowFloorAlternative;
  return leg;
}
export type PairSearchMemo = Map<
  string,
  ReturnType<typeof getCanonicalBusPair>
>;

/** Builds full bounded candidates, retaining materialization separately from DTOs. */
export async function collectBusCandidates({
  base,
  seeds,
  canonicalBoard,
  canonicalAlight,
  now,
  budget,
  memo,
}: {
  base: BusLeg;
  seeds: ScheduledCandidateSeed[];
  canonicalBoard: string;
  canonicalAlight: string;
  now: number;
  budget: CandidateRequestBudget;
  memo: PairSearchMemo;
}): Promise<{
  candidates: BusDepartureCandidate[];
  materialized: Map<string, BusLeg>;
  complete: boolean;
}> {
  const materialized = new Map<string, BusLeg>();
  const candidates: BusDepartureCandidate[] = [];
  let complete = true;
  const city = base.tdxCity ?? base.cityCode;
  if (!city)
    return {
      candidates: seeds.map((s) => s.candidate),
      materialized: new Map(seeds.map((s) => [s.candidate.candidateId, s.leg])),
      complete: false,
    };
  const key = `${city}|${canonicalBoard}>${canonicalAlight}`;
  try {
    let promise = memo.get(key);
    if (!promise) {
      promise = getCanonicalBusPair(
        {
          city,
          canonicalBoardStopId: canonicalBoard,
          canonicalAlightStopId: canonicalAlight,
          now,
        },
        budget,
      );
      memo.set(key, promise);
    }
    const data = await promise;
    complete = data.complete;
    for (const { route, eta } of data.routes) {
      const departureStopId = route.board.stopUID,
        arrivalStopId = route.alight.stopUID;
      if (!departureStopId || !arrivalStopId) {
        complete = false;
        continue;
      }
      for (const row of eta) {
        // Only discard vehicles that have already passed at refresh time.
        // Per-leg boarding readiness is derived dynamically by the chain
        // solver from the selected upstream arrival plus transfer movement.
        if (row.boardingAt < now) continue;
        const vehicle = data.vehicles.find(
          (v) => v.plateNumb === row.plateNumb,
        );
        const vehicleAccessibility = normalizeVehicleAccessibility(
          vehicle?.isLowFloor,
          vehicle?.hasLiftOrRamp,
        );
        const candidate: BusDepartureCandidate = {
          candidateId: `${route.subRouteUid}|${route.direction}|${row.plateNumb ?? "unknown"}|${row.boardingAt}`,
          routeName: route.routeName?.Zh_tw ?? base.routeName,
          subRouteUid: route.subRouteUid,
          subRouteName: route.subRouteName?.Zh_tw,
          direction: route.direction === 1 ? 1 : 0,
          departureStopId: departureStopId,
          arrivalStopId: arrivalStopId,
          plateNumb: row.plateNumb,
          estimatedWaitMinutes: wholeMinutes(now, row.boardingAt),
          boardingTime: taipeiIsoOffset(row.boardingAt),
          alightingTime:
            row.alightingAt === null ? null : taipeiIsoOffset(row.alightingAt),
          boardingTimeSource: "realtime",
          alightingTimeSource:
            row.alightingAt === null ? "unknown" : "realtime",
          vehicleAccessibility,
          hasLiftOrRamp:
            vehicle?.hasLiftOrRamp === undefined
              ? null
              : (normalized(vehicle.hasLiftOrRamp) ?? null),
          selected: false,
        };
        candidates.push(candidate);
        const leg = pairLeg(base, route);
        if (!leg) {
          complete = false;
          continue;
        }
        materialized.set(candidate.candidateId, leg);
      }
    }
    const timetable = [...seeds];
    for (const trip of data.trips ?? []) {
      if (timetable.some((s) => s.candidate.tripId === trip.tripId)) continue;
      const route = data.routes.find(
        ({ route: r }) =>
          r.subRouteUid === trip.subRouteUid && r.direction === trip.direction,
      )?.route;
      const leg = route && pairLeg(base, route);
      if (!leg) continue;
      leg.scheduledTrip = {
        tripId: trip.tripId,
        boardingReadyAt: base.scheduledTrip?.boardingReadyAt ?? now,
        stops: trip.stops,
      };
      const seed = seedOf(leg, now);
      if (seed) timetable.push(seed);
    }
    // A live vehicle may already have passed the dynamically reachable
    // transfer time while a later scheduled trip is still valid, so only the
    // timetable copy of a live vehicle is dropped, never the next trip.
    const live = candidates.filter((c) => materialized.has(c.candidateId));
    const twins = new Set<string>();
    for (const seed of timetable) {
      const twin = live.find((l) => sameTrip(l, seed.candidate));
      if (twin?.plateNumb && twin.alightingTimeSource === "realtime") continue;
      if (twin && !twin.plateNumb) twins.add(twin.candidateId);
      candidates.push(seed.candidate);
      materialized.set(seed.candidate.candidateId, seed.leg);
    }
    for (const id of twins) materialized.delete(id);
    return {
      candidates: candidates.filter((c) => !twins.has(c.candidateId)),
      materialized,
      complete,
    };
  } catch {
    complete = false;
    for (const seed of seeds) {
      candidates.push(seed.candidate);
      materialized.set(seed.candidate.candidateId, seed.leg);
    }
  }
  return { candidates, materialized, complete };
}

/** Materialize only an identity with trusted geometry; never write 105 times into 14. */
export function selectedBusLeg(
  source: BusLeg,
  c: BusDepartureCandidate,
  ready: number,
): BusLeg {
  const board = candidateEpoch(c.boardingTime),
    end = candidateEpoch(c.alightingTime);
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of [
    "_scheduledDepartureTime",
    "_scheduledArrivalTime",
    "_boardingReadyTime",
    "_scheduledTripId",
  ])
    delete descriptors[key];
  const leg = Object.defineProperties({ ...source }, descriptors);
  Object.defineProperties(leg, {
    _scheduledDepartureTime: { value: board, writable: true },
    _scheduledArrivalTime: { value: end, writable: true },
    _boardingReadyTime: { value: ready, writable: true },
    ...(c.tripId ? { _scheduledTripId: { value: c.tripId } } : {}),
  });
  leg.departureTime = taipeiHHmm(new Date(board));
  leg.arrivalTime = taipeiHHmm(new Date(end));
  leg.rideMinutes = wholeMinutes(board, end);
  leg.waitInfo = {
    time:
      c.boardingTimeSource === "schedule"
        ? leg.departureTime
        : wholeMinutes(ready, board),
    source:
      c.boardingTimeSource === "unknown" ? "unavailable" : c.boardingTimeSource,
  };
  leg.estimatedWaitMinutes = wholeMinutes(ready, board);
  if (c.plateNumb) leg.plateNumb = c.plateNumb;
  if (c.vehicleAccessibility !== "unknown")
    leg.isLowFloor = c.vehicleAccessibility === "low_floor";
  if (c.hasLiftOrRamp !== null) leg.hasLiftOrRamp = c.hasLiftOrRamp;
  return leg;
}

export async function resolveCandidateGroup({
  members,
  mode,
  planningNow,
  realtimeNow = planningNow,
  budget,
  memo,
  validateMaterialized,
}: {
  members: AccessibleRoute[];
  mode: AccessibilityMode;
  planningNow: number;
  realtimeNow?: number;
  budget: CandidateRequestBudget;
  memo: PairSearchMemo;
  validateMaterialized?: (
    base: AccessibleRoute,
    legs: Map<number, Awaited<ReturnType<typeof collectBusCandidates>>>,
  ) => Promise<void>;
}): Promise<AccessibleRoute[]> {
  const resolved: AccessibleRoute[] = [];
  for (const base of members) {
    const start = base._scheduledDepartureTime ?? planningNow;
    const timeline = routeCandidateTimeline(base);
    const busLegs = base.legs.filter((l): l is BusLeg => l.type === "BUS");
    if (!busLegs.length) {
      const hasRail = timeline?.some((l) => l.type === "FIXED_TRANSIT");
      const chain =
        hasRail && timeline
          ? selectFeasibleBusChain(timeline, new Map(), start, mode)
          : null;
      if (hasRail && !chain) continue;
      // A legacy rail route without absolute evidence retains its planned
      // duration; no BUS identity or guessed candidate is selected here.
      const end = chain?.arrivalAt ?? start + base.totalMinutes * 60000;
      base.departureTime = taipeiIsoOffset(start);
      base.arrivalTime = taipeiIsoOffset(end);
      base.totalMinutes = Math.round((end - start) / 60000);
      resolved.push(base);
      continue;
    }
    if (!timeline) continue;
    const context: BusRouteCandidateContext = {
      mode,
      routeDepartureTime: start,
      timeline,
      legs: {},
    };
    const collections = new Map<
      number,
      Awaited<ReturnType<typeof collectBusCandidates>>
    >();
    let transitIndex = -1;
    for (const [index, leg] of base.legs.entries()) {
      if (leg.type === "WALK") continue;
      transitIndex++;
      if (leg.type !== "BUS") continue;
      const ordinal = transitIndex;
      const seeds = members.flatMap((r) => {
        const l = r.legs.filter((l) => l.type !== "WALK")[ordinal];
        const seed = l?.type === "BUS" ? seedOf(l, realtimeNow) : null;
        return seed ? [seed] : [];
      });
      const board = leg._canonicalDepartureStopId ?? leg.departureStopId,
        alight = leg._canonicalArrivalStopId ?? leg.arrivalStopId;
      if (!board || !alight) continue;
      const collection = await collectBusCandidates({
        base: leg,
        seeds,
        canonicalBoard: board,
        canonicalAlight: alight,
        now: realtimeNow,
        budget,
        memo,
      });
      collections.set(index, collection);
      context.legs[index] = {
        leg,
        canonicalDepartureStopId: board,
        canonicalArrivalStopId: alight,
        scheduledSeeds: seeds,
        effectiveBoardingReadyAt: start,
        candidateSearchComplete: collection.complete,
      };
    }
    // Recheck new identities/geometries against the same hard a11y/hazard
    // evidence as the base before DP, so an unsafe fastest trip cannot hide a
    // slower safe member of this skeleton.
    await validateMaterialized?.(base, collections);
    const selectable = new Map(
      [...collections].map(([i, c]) => [
        i,
        c.candidates.filter((v) => c.materialized.has(v.candidateId)),
      ]),
    );
    const chain = selectFeasibleBusChain(timeline, selectable, start, mode);
    if (!chain) continue;
    const route = copyWithDescriptors(base, {
      legs: base.legs.slice(),
      departureTime: taipeiIsoOffset(start),
      arrivalTime: taipeiIsoOffset(chain.arrivalAt),
      totalMinutes: Math.round((chain.arrivalAt - start) / 60000),
    });
    for (const [i, collection] of collections) {
      const selected = chain.selected.get(i);
      if (!selected) continue;
      const ready = chain.ready.get(i);
      const source = collection.materialized.get(selected.candidateId);
      if (ready === undefined || !source) continue;
      const leg = selectedBusLeg(source, selected, ready);
      leg.departureCandidates = projectPublicCandidates(
        collection.candidates,
        mode,
        selected.candidateId,
        ready,
      );
      leg.candidateSearchComplete = collection.complete;
      route.legs[i] = leg;
      context.legs[i] = {
        ...context.legs[i],
        leg,
        effectiveBoardingReadyAt: ready,
        selectedCandidateId: selected.candidateId,
      };
    }
    contexts.set(route, context);
    Object.defineProperty(route, "_busCandidateContext", { value: context });
    Object.defineProperty(route, "_vehicleEligibilityTier", {
      value: chain.vehicleTier,
    });
    resolved.push(route);
  }
  // The finalizer scores the assembled geometries before choosing one member
  // per skeleton, so equal-arrival score ties use current (not planner) data.
  return resolved.sort(compareRoutesByArrival);
}

export type CandidateTimeline = Array<
  | { type: "WALK"; durationMs: number }
  | {
      type: "BUS";
      legIndex: number;
      minimumBoardingSlackMs: number;
    }
  | {
      type: "FIXED_TRANSIT";
      legIndex: number;
      departureAt: number;
      arrivalAt: number;
      minimumBoardingSlackMs: number;
    }
>;
export interface BusCandidateChain {
  selected: Map<number, BusDepartureCandidate>;
  ready: Map<number, number>;
  arrivalAt: number;
  vehicleTier: number;
}
const normalized = (v: unknown): boolean | undefined =>
  v === 1 || v === true ? true : v === 0 || v === false ? false : undefined;
export function normalizeVehicleAccessibility(
  low: unknown,
  lift: unknown,
): BusVehicleAccessibility {
  if (normalized(low) === true || normalized(lift) === true) return "low_floor";
  return normalized(low) === false ? "high_floor" : "unknown";
}
export const candidateEpoch = (v: string | null): number =>
  v === null
    ? Infinity
    : Number.isFinite(Date.parse(v))
      ? Date.parse(v)
      : Infinity;
export function compareCandidateForMode(mode: AccessibilityMode) {
  return (a: BusDepartureCandidate, b: BusDepartureCandidate): number =>
    (mode === "wheelchair"
      ? Number(a.vehicleAccessibility !== "low_floor") -
        Number(b.vehicleAccessibility !== "low_floor")
      : 0) ||
    candidateEpoch(a.boardingTime) - candidateEpoch(b.boardingTime) ||
    0 ||
    a.candidateId.localeCompare(b.candidateId);
}
export function buildDepartureCandidates(
  candidates: BusDepartureCandidate[],
  mode: AccessibilityMode,
  readyAt: number,
): BusDepartureCandidate[] {
  return [
    ...new Map(
      candidates
        .filter(
          (c) =>
            (mode !== "wheelchair" ||
              c.vehicleAccessibility !== "high_floor") &&
            (c.boardingTime === null ||
              candidateEpoch(c.boardingTime) >= readyAt),
        )
        .map((c) => [c.candidateId, c]),
    ).values(),
  ].sort(compareCandidateForMode(mode));
}
export function projectPublicCandidates(
  candidates: BusDepartureCandidate[],
  mode: AccessibilityMode,
  selectedId?: string,
  readyAt = -Infinity,
): BusDepartureCandidate[] {
  const eligible = buildDepartureCandidates(candidates, mode, readyAt);
  const top = eligible.slice(0, 5);
  const selected = eligible.find((c) => c.candidateId === selectedId);
  if (selected && !top.some((c) => c.candidateId === selectedId)) {
    if (top.length === 5) top.pop();
    top.push(selected);
  }
  return top
    .sort(compareCandidateForMode(mode))
    .map((c) => ({ ...c, selected: c.candidateId === selectedId }));
}
function identity(s: BusCandidateChain): string {
  return [...s.selected.values()].map((c) => c.candidateId).join("|");
}
/** Exact dominance: for each vehicle tier the earlier cursor can reach every
 * suffix that a later cursor can reach. Never truncate boarding candidates. */
export function selectFeasibleBusChain(
  timeline: CandidateTimeline,
  candidates: Map<number, BusDepartureCandidate[]>,
  startAt: number,
  mode: AccessibilityMode,
): BusCandidateChain | null {
  let states: BusCandidateChain[] = [
    {
      selected: new Map(),
      ready: new Map(),
      arrivalAt: startAt,
      vehicleTier: 0,
    },
  ];
  for (const leg of timeline) {
    const next: BusCandidateChain[] = [];
    for (const state of states) {
      if (leg.type === "WALK") {
        if (Number.isFinite(leg.durationMs) && leg.durationMs >= 0)
          next.push({ ...state, arrivalAt: state.arrivalAt + leg.durationMs });
      } else if (leg.type === "FIXED_TRANSIT") {
        if (
          state.arrivalAt + leg.minimumBoardingSlackMs <= leg.departureAt &&
          leg.arrivalAt >= leg.departureAt
        )
          next.push({ ...state, arrivalAt: leg.arrivalAt });
      } else {
        const ready = state.arrivalAt + leg.minimumBoardingSlackMs;
        for (const c of buildDepartureCandidates(
          candidates.get(leg.legIndex) ?? [],
          mode,
          ready,
        )) {
          const board = candidateEpoch(c.boardingTime),
            alight = candidateEpoch(c.alightingTime);
          if (
            !Number.isFinite(board) ||
            !Number.isFinite(alight) ||
            alight < board
          )
            continue;
          next.push({
            arrivalAt: alight,
            vehicleTier: Math.max(
              state.vehicleTier,
              mode === "wheelchair" && c.vehicleAccessibility !== "low_floor"
                ? 1
                : 0,
            ),
            selected: new Map(state.selected).set(leg.legIndex, c),
            ready: new Map(state.ready).set(leg.legIndex, ready),
          });
        }
      }
    }
    const dominant = new Map<number, BusCandidateChain>();
    for (const state of next) {
      const old = dominant.get(state.vehicleTier);
      if (
        !old ||
        state.arrivalAt < old.arrivalAt ||
        (state.arrivalAt === old.arrivalAt &&
          identity(state).localeCompare(identity(old)) < 0)
      )
        dominant.set(state.vehicleTier, state);
    }
    states = [...dominant.values()];
    if (!states.length) return null;
  }
  return (
    states.sort(
      (a, b) =>
        a.vehicleTier - b.vehicleTier ||
        a.arrivalAt - b.arrivalAt ||
        identity(a).localeCompare(identity(b)),
    )[0] ?? null
  );
}
export function groupRoutesByTransitSkeleton(
  routes: AccessibleRoute[],
): { key: string; members: AccessibleRoute[] }[] {
  const groups = new Map<string, { key: string; members: AccessibleRoute[] }>();
  for (const route of routes) {
    const key =
      route.legs
        .filter((l) => l.type !== "WALK")
        .map((l) => {
          if (l.type === "BUS") {
            // Without canonical evidence do not merge distinct route-specific ids.
            const board = l._canonicalDepartureStopId,
              alight = l._canonicalArrivalStopId;
            if (board && alight)
              return `BUS:${l.tdxCity ?? l.cityCode}:${board}>${alight}`;
            if (l.departureStopId && l.arrivalStopId)
              return `BUS:legacy:${l.subRouteUid}:${l.direction}:${l.departureStopId}>${l.arrivalStopId}`;
            return `BUS:unresolved:${route.routeId}`;
          }
          if (l.type === "METRO")
            return `METRO:${l.railSystem}:${l.lineId ?? l.lineUid ?? l.lineName}:${l.departureStationUid}>${l.arrivalStationUid}`;
          if (l.type === "TRA" || l.type === "THSR")
            return `${l.type}:${l.departureStationUID}>${l.arrivalStationUID}`;
          return `${l.type}:${route.routeId}`;
        })
        .join("::") || `WALK:${route.routeId}`;
    const group = groups.get(key) ?? { key, members: [] };
    group.members.push(route);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function compareRoutesByArrival(
  a: AccessibleRoute,
  b: AccessibleRoute,
): number {
  return (
    Number(!!a.degraded) - Number(!!b.degraded) ||
    (Object.getOwnPropertyDescriptor(a, "_advisoryEligibilityTier")?.value ??
      0) -
      (Object.getOwnPropertyDescriptor(b, "_advisoryEligibilityTier")?.value ??
        0) ||
    (Object.getOwnPropertyDescriptor(a, "_vehicleEligibilityTier")?.value ??
      0) -
      (Object.getOwnPropertyDescriptor(b, "_vehicleEligibilityTier")?.value ??
        0) ||
    candidateEpoch(a.arrivalTime ?? null) -
      candidateEpoch(b.arrivalTime ?? null) ||
    0 ||
    (b.accessibilityScore ?? 0) - (a.accessibilityScore ?? 0) ||
    a.transferCount - b.transferCount ||
    a.routeId.localeCompare(b.routeId)
  );
}
