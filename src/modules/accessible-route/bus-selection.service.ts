import { BUS_SELECTION_MSG } from "../../constants/messages";
import { isFrequencyTemplateTrip } from "../../constants/bus";
import { ResponseCode } from "../../types/code";
import type {
  AccessibleRoute,
  BusDepartureCandidate,
  BusLeg,
} from "../../types/route";
import { taipeiIsoOffset } from "../../config/taipei-time";
import { copyWithDescriptors } from "../../utils/route-source-names";
import { createCandidateRequestBudget } from "../transit/bus-stop-pair-eta.service";
import { getSelectedBusGeometry } from "../transit/bus.service";
import { readNavigationTokenStrict } from "./navigation-state.repository";
import { attachRouteTokens, isNavigationEnvelope } from "./route-token.service";
import { readBusPlan, readOfferedBusCandidate } from "./bus-plan.repository";
import { isBusSelectionAccessible } from "./accessible-route.service";
import {
  collectBusCandidates,
  projectPublicCandidates,
  selectFeasibleBusChain,
  selectedBusLeg,
  type BusRouteCandidateContext,
  type PairSearchMemo,
} from "./bus-stop-pair-candidates";

type SelectionResult =
  | { ok: true; route: AccessibleRoute }
  | {
      ok: false;
      status: ResponseCode;
      error: string;
      data: { reason: string };
    };

const unavailable = (): SelectionResult => ({
  ok: false,
  status: ResponseCode.SERVICE_UNAVAILABLE,
  error: BUS_SELECTION_MSG.UNAVAILABLE,
  data: { reason: "NAVIGATION_STATE_UNAVAILABLE" },
});
const stale = (): SelectionResult => ({
  ok: false,
  status: ResponseCode.CONFLICT,
  error: BUS_SELECTION_MSG.STALE,
  data: { reason: "BUS_CANDIDATE_UNAVAILABLE" },
});

function serviceDay(time: string | null): string | undefined {
  const epoch = time === null ? NaN : Date.parse(time);
  return Number.isFinite(epoch)
    ? new Date(epoch + 8 * 3600000).toISOString().slice(0, 10)
    : undefined;
}

/** ETA timestamps can change; a plate or a timetable trip must still be
 * unique. A frequency template's trip id is shared by its whole headway band,
 * so without a plate the scheduled start in the candidate id tells them apart. */
export function sameBusDeparture(
  a: BusDepartureCandidate,
  b: BusDepartureCandidate,
): boolean {
  return (
    !(a.tripId && b.tripId && a.tripId !== b.tripId) &&
    a.subRouteUid === b.subRouteUid &&
    a.direction === b.direction &&
    a.departureStopId === b.departureStopId &&
    a.arrivalStopId === b.arrivalStopId &&
    serviceDay(a.boardingTime) !== undefined &&
    serviceDay(a.boardingTime) === serviceDay(b.boardingTime) &&
    (a.plateNumb
      ? a.plateNumb === b.plateNumb
      : Boolean(a.tripId && a.tripId === b.tripId) &&
        (!isFrequencyTemplateTrip(a.tripId) || a.candidateId === b.candidateId))
  );
}

function uniqueDeparture(
  identity: BusDepartureCandidate,
  candidates: BusDepartureCandidate[],
): BusDepartureCandidate | undefined {
  const matches = candidates.filter((candidate) =>
    sameBusDeparture(identity, candidate),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function selectBusDeparture(request: {
  routeToken: string;
  legIndex: number;
  candidateId: string;
}): Promise<SelectionResult> {
  const token = await readNavigationTokenStrict(request.routeToken);
  if (token.status === "unavailable") return unavailable();
  if (token.status === "missing" || !isNavigationEnvelope(token.value))
    return {
      ok: false,
      status: ResponseCode.GONE,
      error: BUS_SELECTION_MSG.EXPIRED,
      data: { reason: "ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED" },
    };
  const previous = token.value;
  const baseLeg = previous.route.legs[request.legIndex];
  if (!baseLeg || baseLeg.type !== "BUS")
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: BUS_SELECTION_MSG.INVALID_LEG,
      data: { reason: "BUS_LEG_INVALID" },
    };
  const snapshot = await readBusPlan(request.routeToken);
  if (
    !snapshot ||
    !("schemaVersion" in snapshot) ||
    snapshot.schemaVersion !== 2
  )
    return unavailable();
  const target = snapshot.legs[request.legIndex];
  if (!target) return stale();
  const budget = createCandidateRequestBudget();
  const memo: PairSearchMemo = new Map();
  const now = Date.now();
  try {
    const collections = new Map(
      await Promise.all(
        Object.entries(snapshot.legs).map(
          async ([key, stored]) =>
            [
              Number(key),
              await collectBusCandidates({
                base: stored.leg,
                seeds: stored.scheduledSeeds,
                canonicalBoard: stored.canonicalDepartureStopId,
                canonicalAlight: stored.canonicalArrivalStopId,
                now,
                budget,
                memo,
              }),
            ] as const,
        ),
      ),
    );
    const targetCandidates =
      collections.get(request.legIndex)?.candidates ?? [];
    const exact = targetCandidates.filter(
      (candidate) => candidate.candidateId === request.candidateId,
    );
    const offered = await readOfferedBusCandidate(
      request.routeToken,
      request.legIndex,
      request.candidateId,
    );
    const old =
      offered ??
      target.leg.departureCandidates?.find(
        (candidate) => candidate.candidateId === request.candidateId,
      ) ??
      (target.lockedCandidate?.candidateId === request.candidateId
        ? target.lockedCandidate
        : undefined);
    const chosen =
      exact.length === 1
        ? exact[0]
        : old && uniqueDeparture(old, targetCandidates);
    if (!chosen || (!chosen.plateNumb && !chosen.tripId)) return stale();
    const selectable = new Map<number, BusDepartureCandidate[]>();
    for (const [index, collection] of collections) {
      const lock =
        index === request.legIndex
          ? (old ?? chosen)
          : snapshot.legs[index]?.lockedCandidate;
      const selected = lock && uniqueDeparture(lock, collection.candidates);
      if (lock && !selected) return stale();
      selectable.set(
        index,
        (selected ? [selected] : collection.candidates).filter((candidate) =>
          collection.materialized.has(candidate.candidateId),
        ),
      );
    }
    const start = Math.max(snapshot.routeDepartureTime, now);
    const chain = selectFeasibleBusChain(
      snapshot.timeline,
      selectable,
      start,
      snapshot.mode,
    );
    if (!chain) return stale();
    const route = copyWithDescriptors(previous.route, {
      legs: previous.route.legs.map((leg) => structuredClone(leg)),
      departureTime: taipeiIsoOffset(start),
      arrivalTime: taipeiIsoOffset(chain.arrivalAt),
      totalMinutes: Math.max(0, Math.round((chain.arrivalAt - start) / 60000)),
    });
    // Old capabilities must never survive a failed attempt to persist the new route.
    delete route.routeToken;
    delete route.navigationId;
    delete route.routeVersion;
    const context: BusRouteCandidateContext = {
      mode: snapshot.mode,
      routeDepartureTime: start,
      timeline: snapshot.timeline,
      legs: structuredClone(snapshot.legs),
    };
    await Promise.all(
      [...chain.selected].map(async ([index, candidate]) => {
        const collection = collections.get(index)!;
        let source = collection.materialized.get(candidate.candidateId)!;
        const ready = chain.ready.get(index)!;
        const identity =
          index === request.legIndex
            ? (old ?? chosen)
            : snapshot.legs[index].lockedCandidate;
        const adopted = identity
          ? { ...candidate, tripId: candidate.tripId ?? identity.tripId }
          : candidate;
        const previousLeg = snapshot.legs[index].leg;
        const previousTrip = previousLeg.scheduledTrip;
        if (
          !source.scheduledTrip &&
          previousTrip &&
          previousTrip.tripId === adopted.tripId &&
          previousLeg.subRouteUid === adopted.subRouteUid &&
          previousLeg.direction === adopted.direction &&
          previousLeg.departureStopId === adopted.departureStopId &&
          previousLeg.arrivalStopId === adopted.arrivalStopId
        )
          source = { ...source, scheduledTrip: previousTrip };
        const leg: BusLeg = selectedBusLeg(source, adopted, ready);
        if (identity) leg.selectedDeparture = { ...adopted, selected: true };
        else delete leg.selectedDeparture;
        leg.departureCandidates = projectPublicCandidates(
          collection.candidates,
          snapshot.mode,
          candidate.candidateId,
          ready,
        );
        leg.candidateSearchComplete = collection.complete;
        const geometry = await getSelectedBusGeometry(leg).catch(() => null);
        if (geometry) {
          leg.polyline = geometry;
          leg.geometrySource = "route_shape";
        }
        route.legs[index] = leg;
        context.legs[index] = {
          ...context.legs[index],
          leg,
          effectiveBoardingReadyAt: ready,
          selectedCandidateId: candidate.candidateId,
          candidateSearchComplete: collection.complete,
          ...(identity ? { lockedCandidate: leg.selectedDeparture } : {}),
        };
      }),
    );
    if (
      !(await isBusSelectionAccessible(
        previous.route,
        route,
        previous.canonicalRequest,
      ))
    )
      return stale();
    Object.defineProperty(route, "_busCandidateContext", {
      value: context,
      configurable: true,
    });
    const [stored] = await attachRouteTokens(
      [route],
      previous.canonicalRequest,
      previous.route.venueLegs,
    );
    if (!stored.routeToken || stored.routeToken === request.routeToken)
      return unavailable();
    const saved = await readBusPlan(stored.routeToken);
    if (
      !saved ||
      !("schemaVersion" in saved) ||
      saved.schemaVersion !== 2 ||
      !saved.legs[request.legIndex]?.lockedCandidate
    )
      return unavailable();
    return { ok: true, route: stored };
  } finally {
    budget.close();
  }
}
