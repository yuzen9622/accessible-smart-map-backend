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

export interface RouteFailureData {
  reason: RouteFailureReason;
  maxDistanceKm?: number;
}

export type RoutePreflightResult =
  | { ok: true }
  | {
      ok: false;
      status: ResponseCode.UNPROCESSABLE_ENTITY;
      error: string;
      data: RouteFailureData;
    };

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
    return {
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.OUT_OF_COVERAGE,
      data: { reason: ROUTE_REASON.OUT_OF_COVERAGE },
    };
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
    return {
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.OUT_OF_RANGE,
      data: {
        reason: ROUTE_REASON.OUT_OF_RANGE,
        maxDistanceKm: coverage.maxRouteDistanceKm,
      },
    };
  }

  return { ok: true };
}
