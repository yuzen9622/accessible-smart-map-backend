import type { AccessibleRoute } from "../../types/route";

/**
 * Attach non-serialized absolute schedule metadata used by route orchestration.
 *
 * @param route Route receiving the internal schedule.
 * @param departureTime Absolute scheduled departure in epoch milliseconds.
 * @param endTime Absolute route end in epoch milliseconds.
 * @param isFutureScheduled Whether the route came from a continuation anchor.
 * @returns The same route with writable, non-enumerable schedule metadata.
 */
export function attachInternalSchedule(
  route: AccessibleRoute,
  departureTime: number,
  endTime: number,
  isFutureScheduled: boolean,
): AccessibleRoute {
  Object.defineProperties(route, {
    _scheduledDepartureTime: { value: departureTime, writable: true },
    _scheduledEndTime: { value: endTime, writable: true },
    _isFutureScheduled: { value: isFutureScheduled, writable: true },
  });
  return route;
}

/**
 * Put the earliest future-scheduled route first and retain it within a limit ONLY
 * when there are no currently-departing valid transit routes (e.g. late night service
 * closed, only long-walk options available). If there are valid current transit
 * routes available in the window, keep the original ranked order.
 *
 * @param ranked Ranked routes before limiting.
 * @param candidates Eligible routes from which to select the earliest future departure.
 * @param limit Maximum routes to retain.
 * @returns A limited route list, with earliest future departure at index 0 only if no immediate transit is available.
 */
export function retainEarliestFutureRoute(
  ranked: AccessibleRoute[],
  candidates: AccessibleRoute[],
  limit: number,
): AccessibleRoute[] {
  if (limit <= 0) return [];
  const limited = ranked.slice(0, limit);

  // Check if there is any valid immediate transit route in candidates/ranked
  const hasCurrentTransit = candidates.some(
    (route) =>
      !route._isFutureScheduled &&
      route.legs.some((leg) => leg.type !== "WALK"),
  );

  // If there are current transit routes, do not override with future route at index 0
  if (hasCurrentTransit) {
    return limited;
  }

  const earliest = candidates
    .filter(
      (route) =>
        route._isFutureScheduled &&
        typeof route._scheduledDepartureTime === "number",
    )
    .sort(
      (a, b) =>
        (a._scheduledDepartureTime as number) -
        (b._scheduledDepartureTime as number),
    )[0];
  if (!earliest) return limited;
  const withoutEarliest = limited.filter((route) => route !== earliest);
  return [earliest, ...withoutEarliest].slice(0, limit);
}
