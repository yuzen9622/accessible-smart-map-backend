import { redisGet, redisSet } from "../../config/redis";
import type { AccessibleRoute, BusLeg } from "../../types/route";

const BUS_PLAN_PREFIX = "bus-plan:";
const ARRIVAL_GRACE_SEC = 30 * 60;
const MAX_BUS_PLAN_TTL_SEC = 48 * 60 * 60;

interface BusPlanSnapshot {
  legs: Record<number, BusLeg>;
}

/** Read-only bus context outlives the 30-minute reroute capability when needed. */
export async function storeBusPlan(
  token: string,
  route: AccessibleRoute,
): Promise<void> {
  const legs: BusPlanSnapshot["legs"] = {};
  let lastArrival = Date.now();
  route.legs.forEach((leg, index) => {
    if (leg.type !== "BUS" || !leg.scheduledTrip) return;
    // Keep only bus matching/display data, not walking geometry, user settings,
    // origin/destination intent, facility documents, or live vehicle snapshots.
    legs[index] = {
      type: "BUS",
      routeName: leg.routeName,
      subRouteUid: leg.subRouteUid,
      subRouteName: leg.subRouteName,
      departureStop: leg.departureStop,
      arrivalStop: leg.arrivalStop,
      departureStopId: leg.departureStopId,
      arrivalStopId: leg.arrivalStopId,
      tdxCity: leg.tdxCity,
      cityCode: leg.cityCode,
      direction: leg.direction,
      polyline: leg.polyline,
      scheduledTrip: leg.scheduledTrip,
      waitInfo: { time: null, source: "unavailable" },
      departureStopA11y: [],
      arrivalStopA11y: [],
    };
    for (const stop of leg.scheduledTrip.stops) {
      const time = stop.arrivalAt ?? stop.departureAt;
      if (typeof time === "number" && Number.isFinite(time))
        lastArrival = Math.max(lastArrival, time);
    }
  });
  if (!Object.keys(legs).length) return;
  const ttl = Math.min(
    MAX_BUS_PLAN_TTL_SEC,
    Math.max(
      ARRIVAL_GRACE_SEC,
      Math.ceil((lastArrival - Date.now()) / 1000) + ARRIVAL_GRACE_SEC,
    ),
  );
  await redisSet(`${BUS_PLAN_PREFIX}${token}`, JSON.stringify({ legs }), ttl);
}

/** Never renew TTL on read; this snapshot cannot authorize a reroute. */
export async function readBusPlan(
  token: string,
): Promise<BusPlanSnapshot | null> {
  const raw = await redisGet(`${BUS_PLAN_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const snapshot = JSON.parse(raw) as BusPlanSnapshot;
    return snapshot?.legs && typeof snapshot.legs === "object"
      ? snapshot
      : null;
  } catch {
    return null;
  }
}
