import type { AccessibleRoute, BusLeg } from "../../types/route";

/**
 * The OTP build merges co-located duplicate bus stops, so an itinerary names
 * the merged stop. Swap each bus leg's stop ids back to the boarding route's
 * own TDX StopUID, which the API returns and alert matching relies on.
 * Advisory: when the lookup fails the merged id (a real StopUID at the same
 * pole, same city) is kept.
 *
 * @param routes Planned routes, updated in place.
 */
export async function restoreRouteStopIds(
  routes: AccessibleRoute[],
): Promise<void> {
  const busLegs = routes.flatMap((route) =>
    route.legs.filter((leg): leg is BusLeg => leg.type === "BUS"),
  );
  if (!busLegs.length) return;
  const routeIdOf = (leg: BusLeg) => `${leg.subRouteUid}_${leg.direction}`;
  const pairs = busLegs.flatMap((leg) => {
    const routeId = routeIdOf(leg);
    return [
      leg.departureStopId,
      leg.arrivalStopId,
      ...(leg.intermediateStops ?? []).map((s) => s.stationUid),
    ]
      .filter((stopId): stopId is string => !!stopId)
      .map((stopId) => ({ routeId, stopId }));
  });

  let aliases: Map<string, string>;
  try {
    const { findStopAliases } =
      await import("../transit/stop-alias.repository");
    aliases = await findStopAliases(pairs);
  } catch (err) {
    console.warn("[accessible-route] stop alias lookup failed", err);
    return;
  }
  if (!aliases.size) return;

  for (const leg of busLegs) {
    const routeId = routeIdOf(leg);
    const original = (stopId: string | undefined) =>
      (stopId && aliases.get(`${routeId}|${stopId}`)) || stopId;
    leg.departureStopId = original(leg.departureStopId);
    leg.arrivalStopId = original(leg.arrivalStopId);
    for (const stop of leg.intermediateStops ?? []) {
      stop.stationUid = original(stop.stationUid) ?? stop.stationUid;
    }
  }
}
