import type { AccessibleRoute, TransitPreference } from "../../../types/route";

/** Initial soft preference: penalize other transit ride time, never walking or waiting. */
const OTHER_TRANSIT_WEIGHT = 1.5;

/** OTP legacy plan uses RAIL (TRA/THSR); metro covers SUBWAY/TRAM/MONORAIL. */
export function transitModeWeights(
  preference?: TransitPreference,
): Record<string, number> | undefined {
  if (!preference || preference === "none") return undefined;
  return {
    BUS: preference === "bus" ? 1 : OTHER_TRANSIT_WEIGHT,
    TROLLEYBUS: preference === "bus" ? 1 : OTHER_TRANSIT_WEIGHT,
    RAIL: preference === "rail" ? 1 : OTHER_TRANSIT_WEIGHT,
    SUBWAY: preference === "metro" ? 1 : OTHER_TRANSIT_WEIGHT,
    TRAM: preference === "metro" ? 1 : OTHER_TRANSIT_WEIGHT,
    MONORAIL: preference === "metro" ? 1 : OTHER_TRANSIT_WEIGHT,
  };
}

/**
 * OTP transit modes that satisfy a preference, for the preferred-only
 * candidate search.
 *
 * @param preference The requested transit preference.
 * @returns The OTP modes, or undefined when no preference applies.
 */
export function preferredOtpModes(
  preference?: TransitPreference,
): string[] | undefined {
  switch (preference) {
    case "bus":
      return ["BUS", "TROLLEYBUS"];
    case "rail":
      return ["RAIL"];
    case "metro":
      return ["SUBWAY", "TRAM", "MONORAIL"];
    default:
      return undefined;
  }
}

/**
 * Whether a route rides the preferred transit mode at least once.
 *
 * @param route The route to inspect.
 * @param preference The requested transit preference.
 * @returns Whether any leg is of the preferred type.
 */
export function routeUsesPreferredMode(
  route: AccessibleRoute,
  preference?: TransitPreference,
): boolean {
  return route.legs.some((leg) =>
    preference === "bus"
      ? leg.type === "BUS"
      : preference === "rail"
        ? leg.type === "TRA" || leg.type === "THSR"
        : preference === "metro" && leg.type === "METRO",
  );
}

/**
 * Keep at least one preferred-mode route within a limited list: when none made
 * the cut, the best eligible preferred route from the pool takes the last
 * slot. Order within the list and every route's own data are unchanged.
 *
 * @param limited The already limited, ranked routes.
 * @param pool The ranked candidates the limited list was cut from.
 * @param limit Maximum routes to retain.
 * @param preference The requested transit preference.
 * @param eligible Safety filter a substitute must pass.
 * @returns The limited routes, with a preferred route reserved when possible.
 */
export function reservePreferredRoute(
  limited: AccessibleRoute[],
  pool: AccessibleRoute[],
  limit: number,
  preference: TransitPreference | undefined,
  eligible: (route: AccessibleRoute) => boolean = () => true,
): AccessibleRoute[] {
  if (
    limit < 2 ||
    !preferredOtpModes(preference) ||
    limited.some((route) => routeUsesPreferredMode(route, preference))
  )
    return limited;
  const substitute = pool.find(
    (route) =>
      !limited.includes(route) &&
      routeUsesPreferredMode(route, preference) &&
      eligible(route),
  );
  if (!substitute) return limited;
  if (limited.length < limit) return [...limited, substitute];
  return [...limited.slice(0, limit - 1), substitute];
}

/** Extra generalized minutes for backend ranking; does not change duration or a11y scores. */
export function transitPreferencePenalty(
  route: AccessibleRoute,
  preference?: TransitPreference,
): number {
  const weights = transitModeWeights(preference);
  if (!weights) return 0;
  return route.legs.reduce((cost, leg) => {
    const mode =
      leg.type === "BUS"
        ? "BUS"
        : leg.type === "TRA" || leg.type === "THSR"
          ? "RAIL"
          : leg.type === "METRO"
            ? "SUBWAY"
            : undefined;
    if (!mode || !("rideMinutes" in leg)) return cost;
    const minutes = leg.rideMinutes;
    return (
      cost +
      (typeof minutes === "number" && Number.isFinite(minutes)
        ? Math.max(0, minutes) * (weights[mode] - 1)
        : 0)
    );
  }, 0);
}
