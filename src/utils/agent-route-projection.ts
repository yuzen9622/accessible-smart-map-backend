import type { ProjectedToolResult } from "../types/agent-route";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PRIVATE_OR_BULKY_KEYS = new Set([
  "routeToken",
  "token",
  "polyline",
  "encodedPolyline",
  "geometry",
  "coordinates",
  "steps",
  "stepStreetNames",
  "a11yFacilities",
  "facilities",
  "departureStopA11y",
  "arrivalStopA11y",
  "departureStationA11y",
  "arrivalStationA11y",
  "_canonicalRequest",
  "userId",
]);

/** JSON tool-result values, including omitted optional object properties. */
export type ModelRouteValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ModelRouteValue[]
  | { [key: string]: ModelRouteValue };

/** Response keys holding an indoor venue leg (place ↔ gate). */
const VENUE_LEG_KEYS = new Set(["venueLeg", "venueDepartureLeg"]);

/**
 * An indoor venue leg as the model needs it to speak the route: totals and
 * each step's instruction and floors, never the path geometry.
 */
export function projectVenueLegForModel(value: unknown): ModelRouteValue {
  if (!record(value)) return null;
  const steps = Array.isArray(value.steps) ? value.steps.filter(record) : [];
  const durationS = typeof value.durationS === "number" ? value.durationS : 0;
  return {
    fromPlaceId: value.fromPlaceId as string,
    toPlaceId: value.toPlaceId as string,
    mode: value.mode as string,
    distanceM:
      typeof value.distanceM === "number" ? Math.round(value.distanceM) : null,
    minutes: Math.max(1, Math.round(durationS / 60)),
    elevatorRides: value.elevatorRides as number,
    stairFlights: value.stairFlights as number,
    steps: steps.map((step) => ({
      type: step.type as string,
      instruction: step.instruction as string,
      ...(typeof step.fromLevelRef === "string" &&
      typeof step.toLevelRef === "string"
        ? { floors: `${step.fromLevelRef}→${step.toLevelRef}` }
        : typeof step.levelRef === "string"
          ? { floor: step.levelRef }
          : {}),
      ...(step.heightPending === true ? { heightPending: true } : {}),
    })),
  };
}

/** Removes only non-conversational route fields; preserves every leg and warning. */
export function projectRouteForModel(value: unknown): ModelRouteValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(projectRouteForModel);
  if (!record(value))
    throw new TypeError("Route projection requires JSON-compatible tool data");
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !PRIVATE_OR_BULKY_KEYS.has(key) && !key.startsWith("_"),
      )
      .map(
        ([key, item]) =>
          [
            key,
            VENUE_LEG_KEYS.has(key)
              ? projectVenueLegForModel(item)
              : projectRouteForModel(item),
          ] as const,
      ),
  );
}

export function projectToolResult(result: unknown): ProjectedToolResult {
  return {
    clientResult: result,
    modelResult:
      record(result) && Array.isArray(result.routes)
        ? projectRouteForModel(result)
        : result,
  };
}

/** Bounded valid JSON, retaining leg facts instead of truncating at nesting depth. */
export function summarizeRouteResult(
  value: unknown,
  maxChars: number,
): string | null {
  if (!record(value) || !Array.isArray(value.routes)) return null;
  const routes: Record<string, unknown>[] = value.routes
    .filter(record)
    .map((route) => ({
      routeId: route.routeId,
      routeName:
        typeof route.routeName === "string"
          ? route.routeName.slice(0, 100)
          : route.routeName,
      warnings: Array.isArray(route.warnings)
        ? route.warnings
            .map((warning) => String(warning).slice(0, 120))
            .slice(0, 3)
        : undefined,
      totalMinutes: route.totalMinutes,
      legs: Array.isArray(route.legs)
        ? route.legs
            .filter(record)
            .map((leg) =>
              Object.fromEntries(
                [
                  "type",
                  "from",
                  "to",
                  "routeName",
                  "fromDisplayName",
                  "toDisplayName",
                  "routeDisplayName",
                  "lineName",
                  "terminalStation",
                  "terminalDisplayName",
                  "trainNo",
                  "departureStop",
                  "arrivalStop",
                  "departureStation",
                  "arrivalStation",
                  "departureTime",
                  "arrivalTime",
                ]
                  .filter((key) => leg[key] !== undefined)
                  .map((key) => [
                    key,
                    typeof leg[key] === "string"
                      ? leg[key].slice(0, 80)
                      : leg[key],
                  ]),
              ),
            )
        : [],
    }));
  const selected = routes.findIndex(
    (route) => route.routeId === value.selectedRouteId,
  );
  if (selected > 0) routes.unshift(...routes.splice(selected, 1));
  const indoorPlace = (handover: unknown) =>
    record(handover) && typeof handover.placeId === "string"
      ? handover.placeId
      : undefined;
  // an indoor-only plan has no hand-overs; its one leg names both ends
  const indoorOnly = record(value.venueLeg) && !value.venueArrival;
  const indoor = {
    from: indoorOnly
      ? (value.venueLeg as { fromPlaceId?: string }).fromPlaceId
      : indoorPlace(value.venueDeparture),
    to: indoorOnly
      ? (value.venueLeg as { toPlaceId?: string }).toPlaceId
      : indoorPlace(value.venueArrival),
  };
  const summary = {
    planId: value.planId,
    selectedRouteId: value.selectedRouteId,
    ...(indoor.from || indoor.to ? { indoor } : {}),
    routes,
    truncated: false,
  };
  while (JSON.stringify(summary).length > maxChars && routes.length > 1) {
    routes.pop();
    summary.truncated = true;
  }
  while (JSON.stringify(summary).length > maxChars && routes.length) {
    const legs = routes[0].legs as unknown[];
    if (legs.length) legs.pop();
    else routes.pop();
    summary.truncated = true;
  }
  return JSON.stringify(summary).length <= maxChars
    ? JSON.stringify(summary)
    : '{"truncated":true}';
}
