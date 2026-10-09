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
  "a11yFacilities",
  "facilities",
  "departureStopA11y",
  "arrivalStopA11y",
  "departureStationA11y",
  "arrivalStationA11y",
  "_canonicalRequest",
  "userId",
]);

/** Removes only non-conversational route fields; preserves every leg and warning. */
export function projectRouteForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectRouteForModel);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !PRIVATE_OR_BULKY_KEYS.has(key) && !key.startsWith("_"),
      )
      .map(([key, item]) => [key, projectRouteForModel(item)]),
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
                  "lineName",
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
  const summary = {
    planId: value.planId,
    selectedRouteId: value.selectedRouteId,
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
