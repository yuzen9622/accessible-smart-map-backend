import { ResponseCode } from "../../types/code";
import { TRANSIT_MSG } from "../../constants/messages";
import {
  getPlannedBusRouteDetail,
  getCandidateBusRouteDetail,
  resolveBusCity,
} from "../transit/bus.service";
import type { BusLeg } from "../../types/route";
import type { BusRouteDetailResult } from "../transit/transit.types";
import {
  createCandidateRequestBudget,
  getBusVehicleStopTimes,
  type CandidateRequestBudget,
} from "../transit/bus-stop-pair-eta.service";
import {
  readBusPlan,
  storeOfferedBusCandidates,
  type BusPlanSnapshotV2,
} from "./bus-plan.repository";
import { getRouteByToken } from "./route-token.service";
import { attachBusSchedule } from "./route-schedule";
import {
  collectBusCandidates,
  projectPublicCandidates,
  selectFeasibleBusChain,
  selectedBusLeg,
  type PairSearchMemo,
} from "./bus-stop-pair-candidates";

const missing = (): BusRouteDetailResult => ({
  ok: false,
  status: ResponseCode.INVALID_INPUT,
  error: TRANSIT_MSG.PLAN_BUS_MISSING,
});

/** JSON storage drops the non-enumerable schedule identity live matching needs. */
function withStoredSchedule(leg: BusLeg): BusLeg {
  const trip = leg.scheduledTrip;
  const first = trip?.stops[0];
  const departure = first?.departureAt ?? first?.arrivalAt;
  if (trip && typeof departure === "number")
    attachBusSchedule(leg, departure, trip.boardingReadyAt, trip.tripId);
  return leg;
}

/** Stop-by-stop detail for whichever service rides this leg: a timetable trip
 * keeps every planned stop time, a live vehicle is followed by its plate. */
async function rideDetail(
  leg: BusLeg,
  city: NonNullable<Awaited<ReturnType<typeof resolveBusCity>>>,
  budget: CandidateRequestBudget,
  now: number,
): Promise<BusRouteDetailResult> {
  if (leg.scheduledTrip && (!leg.selectedDeparture || !leg.plateNumb))
    return getPlannedBusRouteDetail(leg, city);
  const providerCity = leg.tdxCity ?? leg.cityCode;
  if (!leg.plateNumb || !providerCity)
    return getCandidateBusRouteDetail(leg, city);
  const stopIds = [
    ...new Set(
      [
        leg.departureStopId,
        ...(leg.intermediateStops ?? []).map((s) => s.stationUid),
        leg.arrivalStopId,
        ...(leg.scheduledTrip?.stops.map((s) => s.stopUid) ?? []),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const { plateNumb, subRouteUid, direction, routeName } = leg;
  const times = await budget
    .run(() =>
      getBusVehicleStopTimes({
        city: providerCity,
        routeName,
        subRouteUid,
        direction: direction === 1 ? 1 : 0,
        plateNumb,
        stopIds,
        now,
        signal: budget.signal,
      }),
    )
    .catch(() => new Map<string, number>());
  return getCandidateBusRouteDetail(leg, city, times, now);
}

async function refreshPair(
  snapshot: BusPlanSnapshotV2,
  legIndex: number,
  now: number,
): Promise<BusRouteDetailResult> {
  const stored = snapshot.legs[legIndex];
  if (!stored) return missing();
  const city = await resolveBusCity(stored.leg.tdxCity ?? stored.leg.cityCode);
  if (!city) return missing();
  if (stored.lockedCandidate) {
    const budget = createCandidateRequestBudget();
    try {
      const leg = withStoredSchedule({
        ...stored.leg,
        selectedDeparture: stored.lockedCandidate,
      });
      if (stored.lockedCandidate.plateNumb)
        leg.plateNumb = stored.lockedCandidate.plateNumb;
      const detail = await rideDetail(leg, city, budget, now);
      if (!detail.ok) return detail;
      const selected =
        detail.departureCandidates?.[0] ?? stored.lockedCandidate;
      return {
        ...detail,
        departureCandidates: [
          { ...selected, selected: true },
          ...(stored.leg.departureCandidates ?? [])
            .filter(
              (candidate) =>
                candidate.candidateId !== stored.lockedCandidate?.candidateId,
            )
            .map((candidate) => ({ ...candidate, selected: false })),
        ].slice(0, 5),
        candidateSearchComplete: false,
      };
    } finally {
      budget.close();
    }
  }
  const first = snapshot.timeline.findIndex(
    (l) => l.type === "BUS" && l.legIndex === legIndex,
  );
  if (first < 0) return missing();
  const timeline = snapshot.timeline
    .slice(first)
    .map((l) => (l.type === "BUS" ? { ...l, readyAt: undefined } : { ...l }));
  const ready = Math.max(stored.effectiveBoardingReadyAt, now);
  const budget = createCandidateRequestBudget();
  const memo: PairSearchMemo = new Map();
  const collections = new Map<
    number,
    Awaited<ReturnType<typeof collectBusCandidates>>
  >();
  let complete = true;
  try {
    await Promise.all(
      timeline.map(async (l) => {
        if (l.type !== "BUS") return false;
        const context = snapshot.legs[l.legIndex];
        if (!context) {
          complete = false;
          return false;
        }
        // Prefix ready applies to the requested leg only. Downstream ready is
        // recomputed by replaying walks and fixed rail after the fresh alighting.
        const collection = await collectBusCandidates({
          base: context.leg,
          seeds: context.scheduledSeeds,
          canonicalBoard: context.canonicalDepartureStopId,
          canonicalAlight: context.canonicalArrivalStopId,
          now,
          budget,
          memo,
        });
        collections.set(l.legIndex, collection);
        if (!collection.complete) complete = false;
        return true;
      }),
    );
    const candidates = new Map(
      [...collections].map(([i, c]) => [
        i,
        c.candidates.filter((v) => c.materialized.has(v.candidateId)),
      ]),
    );
    const chain = selectFeasibleBusChain(
      timeline,
      candidates,
      ready,
      snapshot.mode,
    );
    const collection = collections.get(legIndex);
    const selected = chain?.selected.get(legIndex);
    const source =
      selected && collection?.materialized.get(selected.candidateId);
    const leg =
      selected && source
        ? selectedBusLeg(source, selected, ready)
        : withStoredSchedule(stored.leg);
    if (selected && source) leg.selectedDeparture = selected;
    const detail = await rideDetail(leg, city, budget, now);
    if (!detail.ok) return detail;
    const timing = detail.departureCandidates?.[0];
    const sameRide = detail.directions.some(
      (direction) =>
        direction.subRouteUid === selected?.subRouteUid &&
        direction.direction === selected?.direction &&
        direction.stops[0]?.stopUid === selected?.departureStopId &&
        direction.stops.at(-1)?.stopUid === selected?.arrivalStopId,
    );
    return {
      ...detail,
      departureCandidates: projectPublicCandidates(
        collection?.candidates ?? [],
        snapshot.mode,
        selected?.candidateId,
        ready,
      ).map((candidate) =>
        sameRide && timing?.candidateId === candidate.candidateId
          ? {
              ...candidate,
              ...(timing.boardingTimeSource === "realtime"
                ? {
                    boardingTime: timing.boardingTime,
                    boardingTimeSource: timing.boardingTimeSource,
                    estimatedWaitMinutes: timing.estimatedWaitMinutes,
                  }
                : {}),
              ...(timing.alightingTimeSource === "realtime"
                ? {
                    alightingTime: timing.alightingTime,
                    alightingTimeSource: timing.alightingTimeSource,
                  }
                : {}),
            }
          : candidate,
      ),
      candidateSearchComplete: complete,
    };
  } finally {
    budget.close();
  }
}

/** Only trusted, stored plan data selects route/stop/direction/mode queries. */
export async function getPlannedBusArrivals(
  routeToken: string,
  legIndex: number,
): Promise<BusRouteDetailResult> {
  // A live navigation envelope never bypasses the longer-lived v2 context.
  const [route, busPlan] = await Promise.all([
    getRouteByToken(routeToken),
    readBusPlan(routeToken),
  ]);
  if (!route && !busPlan)
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: TRANSIT_MSG.PLAN_EXPIRED,
    };
  if (busPlan && "schemaVersion" in busPlan && busPlan.schemaVersion === 2) {
    const result = await refreshPair(busPlan, legIndex, Date.now());
    if (result.ok && result.departureCandidates)
      await storeOfferedBusCandidates(
        routeToken,
        legIndex,
        result.departureCandidates,
      );
    return result;
  }
  const cachedLeg = busPlan?.legs[legIndex];
  const leg =
    route?.legs[legIndex] ??
    (cachedLeg && "leg" in cachedLeg ? cachedLeg.leg : cachedLeg);
  if (leg?.type !== "BUS" || !leg.scheduledTrip) return missing();
  const first = leg.scheduledTrip.stops[0];
  const departure = first?.departureAt ?? first?.arrivalAt;
  const city = await resolveBusCity(leg.tdxCity ?? leg.cityCode);
  if (!city || typeof departure !== "number") return missing();
  attachBusSchedule(
    leg,
    departure,
    leg.scheduledTrip.boardingReadyAt,
    leg.scheduledTrip.tripId,
  );
  return getPlannedBusRouteDetail(leg, city);
}
