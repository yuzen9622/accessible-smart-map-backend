import { ROUTE_WARNING } from "../../../constants/messages";
import type { HazardSeverity, HazardType } from "../../../types";
import type {
  AccessibleRoute,
  RouteHazard,
  RouteHazardAdvisory,
} from "../../../types/route";

/**
 * A small urban corridor around a ground-level route geometry. It covers normal
 * GPS/road-snapping error without turning a nearby report into an on-route one.
 */
export const HAZARD_ROUTE_CORRIDOR_M = 25;

/** Never issue an unbounded hazard query for a long/inter-city candidate set. */
export const MAX_HAZARD_QUERY_RADIUS_M = 50_000;

/** Blocking reports must dominate the normal time/accessibility rank. */
export const HAZARD_PENALTY_POINTS: Record<HazardSeverity, number> = {
  blocking: 1_000,
  difficult: 250,
  minor: 75,
};

const EARTH_RADIUS_M = 6_371_000;
const HAZARD_TYPES = new Set<HazardType>([
  "obstacle",
  "construction",
  "data_error",
]);
const HAZARD_SEVERITIES = new Set<HazardSeverity>([
  "blocking",
  "difficult",
  "minor",
]);
const SEVERITY_ORDER: Record<HazardSeverity, number> = {
  blocking: 0,
  difficult: 1,
  minor: 2,
};

type LngLat = readonly [number, number];

/** The DB projection consumed by this pure planner. Coordinates are [lng, lat]. */
export interface ConfirmedHazardInput {
  id: string;
  hazardType: HazardType;
  severity: HazardSeverity;
  description?: string;
  coordinates: [number, number];
}

/** A bounded circle that contains every matchable candidate ground polyline. */
export interface HazardQueryArea {
  center: { lat: number; lng: number };
  radiusM: number;
}

/** Result of ranking a pre-ranked candidate list using verified hazard geometry. */
export interface HazardRoutePlan {
  routes: AccessibleRoute[];
  /** True only when multiple fully-matchable candidates had a confirmed hit. */
  selectionApplied: boolean;
  /** True only when every candidate was matchable and had at least one hit. */
  allCandidatesAffected: boolean;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function assertLngLat(value: unknown, label: string): asserts value is LngLat {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    value[0] < -180 ||
    value[0] > 180 ||
    value[1] < -90 ||
    value[1] > 90
  ) {
    throw new Error(`Invalid ${label}; expected finite [lng, lat] coordinates`);
  }
}

function angularDistance(a: LngLat, b: LngLat): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b[0] - a[0]);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function initialBearing(from: LngLat, to: LngLat): number {
  const lat1 = toRadians(from[1]);
  const lat2 = toRadians(to[1]);
  const deltaLng = toRadians(to[0] - from[0]);
  return Math.atan2(
    Math.sin(deltaLng) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng),
  );
}

function haversineDistanceM(a: LngLat, b: LngLat): number {
  return angularDistance(a, b) * EARTH_RADIUS_M;
}

/**
 * Shortest great-circle distance from a point to a finite polyline segment.
 * Unlike a bounding-box check, this projects onto the segment and falls back to
 * the closest endpoint when that projection lies outside the segment.
 */
export function pointToSegmentDistanceM(
  point: LngLat,
  start: LngLat,
  end: LngLat,
): number {
  assertLngLat(point, "hazard point");
  assertLngLat(start, "segment start");
  assertLngLat(end, "segment end");

  const segmentAngularLength = angularDistance(start, end);
  if (segmentAngularLength <= Number.EPSILON) {
    return haversineDistanceM(point, start);
  }

  const pointAngularDistance = angularDistance(start, point);
  if (pointAngularDistance <= Number.EPSILON) return 0;

  const pointBearing = initialBearing(start, point);
  const segmentBearing = initialBearing(start, end);
  const bearingDelta = pointBearing - segmentBearing;
  const crossTrackAngular = Math.asin(
    Math.max(
      -1,
      Math.min(1, Math.sin(pointAngularDistance) * Math.sin(bearingDelta)),
    ),
  );
  const alongTrackAngular = Math.atan2(
    Math.sin(pointAngularDistance) * Math.cos(bearingDelta),
    Math.cos(pointAngularDistance),
  );

  if (alongTrackAngular >= 0 && alongTrackAngular <= segmentAngularLength) {
    return Math.abs(crossTrackAngular) * EARTH_RADIUS_M;
  }
  return Math.min(
    haversineDistanceM(point, start),
    haversineDistanceM(point, end),
  );
}

/**
 * Return only pedestrian/road geometries. Transit leg lines are deliberately
 * excluded: they can be station-to-station approximations and cannot prove a
 * street-level obstruction affects a rider.
 */
function groundPolylines(route: AccessibleRoute): LngLat[][] {
  const polylines: LngLat[][] = [];
  for (const leg of route.legs) {
    if (
      leg.type !== "WALK" &&
      leg.type !== "DRIVE" &&
      leg.type !== "MOTORCYCLE"
    ) {
      continue;
    }
    if (!Array.isArray(leg.polyline)) {
      throw new Error(`Route ${route.routeId} has an invalid ground polyline`);
    }
    for (const point of leg.polyline) {
      assertLngLat(point, `ground polyline point on route ${route.routeId}`);
    }
    if (leg.polyline.length >= 2) polylines.push(leg.polyline);
  }
  return polylines;
}

function collectCandidateGroundPolylines(
  routes: readonly AccessibleRoute[],
): LngLat[][][] | undefined {
  if (!routes.length) return undefined;
  const perRoute = routes.map(groundPolylines);
  // A route with no usable ground geometry is unknown, not demonstrated clear.
  if (perRoute.some((polylines) => polylines.length === 0)) return undefined;
  return perRoute;
}

/**
 * Compute one bounded request/candidate circle from the actual ground geometry.
 * Returning undefined means the caller must skip the overlay rather than make
 * an incomplete "clear" or "avoided" claim.
 */
export function buildHazardQueryArea(
  routes: readonly AccessibleRoute[],
): HazardQueryArea | undefined {
  const candidatePolylines = collectCandidateGroundPolylines(routes);
  if (!candidatePolylines) return undefined;
  const points = candidatePolylines.flat(2);
  if (!points.length) return undefined;

  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lng, lat] of points) {
    const latRad = toRadians(lat);
    const lngRad = toRadians(lng);
    x += Math.cos(latRad) * Math.cos(lngRad);
    y += Math.cos(latRad) * Math.sin(lngRad);
    z += Math.sin(latRad);
  }
  const magnitude = Math.hypot(x, y, z);
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON)
    return undefined;

  const center: LngLat = [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
  ];
  const radiusM =
    Math.max(...points.map((point) => haversineDistanceM(center, point))) +
    HAZARD_ROUTE_CORRIDOR_M;
  if (!Number.isFinite(radiusM) || radiusM > MAX_HAZARD_QUERY_RADIUS_M) {
    return undefined;
  }
  return {
    center: { lat: center[1], lng: center[0] },
    radiusM: Math.ceil(radiusM),
  };
}

function normalizeHazards(
  hazards: readonly ConfirmedHazardInput[],
): ConfirmedHazardInput[] {
  const ids = new Set<string>();
  return hazards.map((hazard) => {
    if (!hazard || typeof hazard.id !== "string" || hazard.id.length === 0) {
      throw new Error("Confirmed hazard is missing an id");
    }
    if (ids.has(hazard.id)) {
      throw new Error(`Duplicate confirmed hazard id: ${hazard.id}`);
    }
    ids.add(hazard.id);
    if (!HAZARD_TYPES.has(hazard.hazardType)) {
      throw new Error(
        `Invalid confirmed hazard type: ${String(hazard.hazardType)}`,
      );
    }
    if (!HAZARD_SEVERITIES.has(hazard.severity)) {
      throw new Error(
        `Invalid confirmed hazard severity: ${String(hazard.severity)}`,
      );
    }
    if (
      hazard.description !== undefined &&
      typeof hazard.description !== "string"
    ) {
      throw new Error(`Invalid confirmed hazard description: ${hazard.id}`);
    }
    assertLngLat(
      hazard.coordinates,
      `confirmed hazard coordinates for ${hazard.id}`,
    );
    return hazard;
  });
}

function toRouteHazard(
  hazard: ConfirmedHazardInput,
  distanceM: number,
): RouteHazard {
  return {
    id: hazard.id,
    hazardType: hazard.hazardType,
    severity: hazard.severity,
    ...(hazard.description ? { description: hazard.description } : {}),
    location: { lat: hazard.coordinates[1], lng: hazard.coordinates[0] },
    distanceM: Math.round(distanceM * 10) / 10,
  };
}

function sortRouteHazards(hazards: RouteHazard[]): RouteHazard[] {
  return [...hazards].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.distanceM - b.distanceM ||
      a.id.localeCompare(b.id),
  );
}

function matchRouteHazards(
  route: AccessibleRoute,
  hazards: readonly ConfirmedHazardInput[],
  polylines = groundPolylines(route),
): RouteHazard[] {
  const matches: RouteHazard[] = [];
  for (const hazard of hazards) {
    let nearestDistanceM = Infinity;
    for (const polyline of polylines) {
      for (let index = 1; index < polyline.length; index++) {
        nearestDistanceM = Math.min(
          nearestDistanceM,
          pointToSegmentDistanceM(
            hazard.coordinates,
            polyline[index - 1],
            polyline[index],
          ),
        );
      }
    }
    if (nearestDistanceM <= HAZARD_ROUTE_CORRIDOR_M) {
      matches.push(toRouteHazard(hazard, nearestDistanceM));
    }
  }
  return sortRouteHazards(matches);
}

/** Match one route's ground geometry against verified confirmed hazards. */
export function matchConfirmedHazardsToRoute(
  route: AccessibleRoute,
  hazards: readonly ConfirmedHazardInput[],
): RouteHazard[] {
  return matchRouteHazards(route, normalizeHazards(hazards));
}

function advisoryFor(onRoute: RouteHazard[]): RouteHazardAdvisory {
  return {
    onRoute,
    avoided: [],
    blockingOnRoute: onRoute.filter((hazard) => hazard.severity === "blocking")
      .length,
    penaltyPoints: onRoute.reduce(
      (total, hazard) => total + HAZARD_PENALTY_POINTS[hazard.severity],
      0,
    ),
  };
}

const INTERNAL_SCHEDULE_METADATA = [
  "_scheduledDepartureTime",
  "_scheduledEndTime",
  "_isFutureScheduled",
] as const;

type RouteDecoration = Partial<
  Pick<AccessibleRoute, "hazardAdvisory" | "degraded" | "warnings">
>;

/**
 * Object spread intentionally omits the non-enumerable schedule fields attached
 * by `attachInternalSchedule`. Advisory decoration must keep their descriptors
 * so later schedule selection continues to reference the decorated route.
 */
function decorateRoute(
  route: AccessibleRoute,
  decoration: RouteDecoration,
): AccessibleRoute {
  const decorated = { ...route, ...decoration };
  for (const key of INTERNAL_SCHEDULE_METADATA) {
    const descriptor = Object.getOwnPropertyDescriptor(route, key);
    if (descriptor) Object.defineProperty(decorated, key, descriptor);
  }
  return decorated;
}

function appendWarning(
  route: AccessibleRoute,
  warning: string,
  decoration: RouteDecoration = {},
): AccessibleRoute {
  return decorateRoute(route, {
    ...decoration,
    warnings: [...new Set([...(route.warnings ?? []), warning])],
  });
}

/**
 * Decorate and rank an already base-ranked candidate list. This function is
 * intentionally pure: it never mutates a route, and callers can discard the
 * entire result if a hazard query or geometry operation failed.
 */
export function planConfirmedHazardRoutes(
  routes: AccessibleRoute[],
  hazards: readonly ConfirmedHazardInput[],
): HazardRoutePlan {
  const candidatePolylines = collectCandidateGroundPolylines(routes);
  if (!candidatePolylines) {
    return { routes, selectionApplied: false, allCandidatesAffected: false };
  }
  const confirmedHazards = normalizeHazards(hazards);
  if (!confirmedHazards.length) {
    return { routes, selectionApplied: false, allCandidatesAffected: false };
  }

  const candidates = routes.map((route, index) => {
    const onRoute = matchRouteHazards(
      route,
      confirmedHazards,
      candidatePolylines[index],
    );
    const advisory = advisoryFor(onRoute);
    const decorated = onRoute.length
      ? appendWarning(route, ROUTE_WARNING.HAZARD_ON_ROUTE, {
          hazardAdvisory: advisory,
        })
      : route;
    return { route: decorated, index, advisory };
  });

  if (!candidates.some((candidate) => candidate.advisory.onRoute.length > 0)) {
    return { routes, selectionApplied: false, allCandidatesAffected: false };
  }

  const allCandidatesAffected =
    routes.length > 1 &&
    candidates.every((candidate) => candidate.advisory.onRoute.length > 0);
  const ranked = [...candidates].sort(
    (a, b) =>
      a.advisory.penaltyPoints - b.advisory.penaltyPoints || a.index - b.index,
  );

  // `avoided` is a comparative assertion, so only the selected candidate may
  // expose it, and only for hazards proven to intersect an alternative but not it.
  if (routes.length > 1) {
    const selected = ranked[0];
    const selectedHazardIds = new Set(
      selected.advisory.onRoute.map((hazard) => hazard.id),
    );
    const avoided = sortRouteHazards(
      ranked
        .slice(1)
        .flatMap((candidate) => candidate.advisory.onRoute)
        .filter(
          (hazard, index, all) =>
            !selectedHazardIds.has(hazard.id) &&
            all.findIndex((other) => other.id === hazard.id) === index,
        ),
    );
    if (avoided.length) {
      selected.route = decorateRoute(selected.route, {
        hazardAdvisory: {
          ...(selected.route.hazardAdvisory ?? selected.advisory),
          avoided,
        },
      });
    }
  }

  if (allCandidatesAffected) {
    const selected = ranked[0];
    selected.route = appendWarning(
      selected.route,
      ROUTE_WARNING.HAZARD_ALL_ROUTES_BLOCKED,
      { degraded: true },
    );
  }

  return {
    routes: ranked.map((candidate) => candidate.route),
    selectionApplied: routes.length > 1,
    allCandidatesAffected,
  };
}
