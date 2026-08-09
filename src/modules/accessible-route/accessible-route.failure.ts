import {
  isWithinServiceCoverage,
  type ServiceCoverageConfig,
  type ServiceCoveragePoint,
} from "../../config/coverage";
import { ROUTE_MSG, ROUTE_REASON } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import { haversineMeters } from "../../utils/geo";

export type RouteFailureReason =
  (typeof ROUTE_REASON)[keyof typeof ROUTE_REASON];

export interface RouteFailureData<Reason extends RouteFailureReason = RouteFailureReason> {
  reason: Reason;
  maxDistanceKm?: number;
}

type RouteFailureStatus<Reason extends RouteFailureReason> =
  Reason extends typeof ROUTE_REASON.UPSTREAM_TIMEOUT
    ? ResponseCode.SERVICE_UNAVAILABLE
    : ResponseCode.UNPROCESSABLE_ENTITY;

export type RouteFailureResult<Reason extends RouteFailureReason = RouteFailureReason> = {
  ok: false;
  status: RouteFailureStatus<Reason>;
  error: string;
  data: RouteFailureData<Reason>;
};

export type RoutePreflightResult =
  | { ok: true }
  | RouteFailureResult<
      | typeof ROUTE_REASON.OUT_OF_RANGE
      | typeof ROUTE_REASON.OUT_OF_COVERAGE
    >;

/**
 * Build a stable route-engine failure envelope from one domain reason. The
 * reason determines both its localized message and its HTTP status, so callers
 * cannot accidentally return a 404 or a mismatched message for an engine
 * outcome.
 */
export function routeFailure<Reason extends RouteFailureReason>(
  reason: Reason,
  extra: Omit<RouteFailureData<Reason>, "reason"> = {},
): RouteFailureResult<Reason> {
  const status = reason === ROUTE_REASON.UPSTREAM_TIMEOUT
    ? ResponseCode.SERVICE_UNAVAILABLE
    : ResponseCode.UNPROCESSABLE_ENTITY;
  return {
    ok: false,
    status: status as RouteFailureStatus<Reason>,
    error: ROUTE_MSG[reason],
    data: { reason, ...extra } as RouteFailureData<Reason>,
  };
}

/**
 * Validates normalized origin, waypoint, and destination coordinates before a
 * city lookup or routing-engine call. Coverage is checked before total route
 * distance so callers always receive the most actionable failure.
 */
export function preflightAccessibleRoute(
  points: readonly ServiceCoveragePoint[],
  coverage: ServiceCoverageConfig,
): RoutePreflightResult {
  if (!points.every((point) => isWithinServiceCoverage(point, coverage.bbox))) {
    return routeFailure(ROUTE_REASON.OUT_OF_COVERAGE);
  }

  let distanceKm = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    distanceKm +=
      haversineMeters(previous.lat, previous.lng, current.lat, current.lng) /
      1_000;
  }

  if (distanceKm > coverage.maxRouteDistanceKm) {
    return routeFailure(ROUTE_REASON.OUT_OF_RANGE, {
      maxDistanceKm: coverage.maxRouteDistanceKm,
    });
  }

  return { ok: true };
}
