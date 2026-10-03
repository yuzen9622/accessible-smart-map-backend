import type { AccessibleRoute, TransitPreference } from "../../../types/route";

/** Initial soft preference: penalize other transit ride time, never walking or waiting. */
const OTHER_TRANSIT_WEIGHT = 1.5;

/** OTP legacy plan uses RAIL (TRA/THSR) and separate SUBWAY/TRAM/MONORAIL modes. */
export function transitModeWeights(
  preference?: TransitPreference,
): Record<string, number> | undefined {
  if (!preference || preference === "none") return undefined;
  return {
    BUS: preference === "bus" ? 1 : OTHER_TRANSIT_WEIGHT,
    TROLLEYBUS: preference === "bus" ? 1 : OTHER_TRANSIT_WEIGHT,
    RAIL: preference === "rail" ? 1 : OTHER_TRANSIT_WEIGHT,
    SUBWAY: OTHER_TRANSIT_WEIGHT,
    TRAM: OTHER_TRANSIT_WEIGHT,
    MONORAIL: OTHER_TRANSIT_WEIGHT,
  };
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
