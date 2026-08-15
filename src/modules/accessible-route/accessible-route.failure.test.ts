import { describe, expect, it } from "vitest";
import type { ServiceCoverageConfig } from "../../config/coverage";
import { ROUTE_MSG, ROUTE_REASON } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import { haversineMeters } from "../../utils/geo";
import {
  preflightAccessibleRoute,
  routeFailure,
} from "./accessible-route.failure";

const taiwanCoverage: ServiceCoverageConfig = {
  bbox: [117.9, 21.85, 122.6, 26.55],
  maxRouteDistanceKm: 100,
};

describe("routeFailure", () => {
  it("maps route-engine no-route reasons to 422 with their centralized messages", () => {
    expect(routeFailure(ROUTE_REASON.NO_ROUTE)).toEqual({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.NO_ROUTE,
      data: { reason: ROUTE_REASON.NO_ROUTE },
    });
    expect(routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE)).toEqual({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.NO_ACCESSIBLE_ROUTE,
      data: { reason: ROUTE_REASON.NO_ACCESSIBLE_ROUTE },
    });
  });

  it("maps an upstream timeout to 503 with its centralized message", () => {
    expect(routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT)).toEqual({
      ok: false,
      status: ResponseCode.SERVICE_UNAVAILABLE,
      error: ROUTE_MSG.UPSTREAM_TIMEOUT,
      data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
    });
  });
});

describe("preflightAccessibleRoute", () => {
  it("rejects an out-of-coverage waypoint before evaluating total distance", () => {
    expect(
      preflightAccessibleRoute(
        [
          { lat: 25.04, lng: 121.56 },
          { lat: 27, lng: 121.56 },
          { lat: 25.03, lng: 121.55 },
        ],
        taiwanCoverage,
      ),
    ).toEqual({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.OUT_OF_COVERAGE,
      data: { reason: ROUTE_REASON.OUT_OF_COVERAGE },
    });
  });

  it("rejects a route when adjacent legs total more than 100km", () => {
    expect(
      preflightAccessibleRoute(
        [
          { lat: 22, lng: 120 },
          { lat: 22.5, lng: 120 },
          { lat: 23, lng: 120 },
        ],
        taiwanCoverage,
      ),
    ).toEqual({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.OUT_OF_RANGE,
      data: {
        reason: ROUTE_REASON.OUT_OF_RANGE,
        maxDistanceKm: 100,
      },
    });
  });

  it("accepts bbox-boundary and inside points when their total is within 100km", () => {
    expect(
      preflightAccessibleRoute(
        [
          { lat: 22, lng: 120 },
          { lat: 22.25, lng: 120.25 },
          { lat: 22.5, lng: 120.5 },
        ],
        {
          bbox: [120, 22, 120.5, 22.5],
          maxRouteDistanceKm: 100,
        },
      ),
    ).toEqual({ ok: true });
  });

  it("accepts a total distance exactly at the configured maximum", () => {
    const points = [
      { lat: 25, lng: 121 },
      { lat: 25.5, lng: 121 },
    ];
    const maxRouteDistanceKm =
      haversineMeters(
        points[0].lat,
        points[0].lng,
        points[1].lat,
        points[1].lng,
      ) / 1_000;

    expect(
      preflightAccessibleRoute(points, {
        bbox: [117.9, 21.85, 122.6, 26.55],
        maxRouteDistanceKm,
      }),
    ).toEqual({ ok: true });
  });
});
