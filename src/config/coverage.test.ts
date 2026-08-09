import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SERVICE_COVERAGE_BBOX,
  MAX_ROUTE_DISTANCE_KM,
  getServiceCoverageConfig,
  isWithinServiceCoverage,
} from "./coverage";

const ORIGINAL_SERVICE_COVERAGE_BBOX = process.env.SERVICE_COVERAGE_BBOX;

beforeEach(() => {
  delete process.env.SERVICE_COVERAGE_BBOX;
});

afterEach(() => {
  if (ORIGINAL_SERVICE_COVERAGE_BBOX === undefined) {
    delete process.env.SERVICE_COVERAGE_BBOX;
  } else {
    process.env.SERVICE_COVERAGE_BBOX = ORIGINAL_SERVICE_COVERAGE_BBOX;
  }
});

describe("getServiceCoverageConfig", () => {
  it("returns the all-Taiwan default when SERVICE_COVERAGE_BBOX is unset", () => {
    expect(getServiceCoverageConfig()).toEqual({
      bbox: DEFAULT_SERVICE_COVERAGE_BBOX,
      maxRouteDistanceKm: MAX_ROUTE_DISTANCE_KM,
    });
  });

  it("reads a custom SERVICE_COVERAGE_BBOX on each call", () => {
    process.env.SERVICE_COVERAGE_BBOX = "118,22,122,26";
    expect(getServiceCoverageConfig().bbox).toEqual([118, 22, 122, 26]);

    process.env.SERVICE_COVERAGE_BBOX = "119,23,121,25";
    expect(getServiceCoverageConfig().bbox).toEqual([119, 23, 121, 25]);
  });

  it("fails fast when SERVICE_COVERAGE_BBOX is invalid", () => {
    process.env.SERVICE_COVERAGE_BBOX = "117.9,21.85,122.6";

    expect(() => getServiceCoverageConfig()).toThrowError(
      /Invalid SERVICE_COVERAGE_BBOX: expected minLng,minLat,maxLng,maxLat/,
    );
  });
});

describe("isWithinServiceCoverage", () => {
  it("includes both bbox boundaries and excludes points outside them", () => {
    expect(
      isWithinServiceCoverage({
        lng: DEFAULT_SERVICE_COVERAGE_BBOX[0],
        lat: DEFAULT_SERVICE_COVERAGE_BBOX[1],
      }),
    ).toBe(true);
    expect(
      isWithinServiceCoverage({
        lng: DEFAULT_SERVICE_COVERAGE_BBOX[2],
        lat: DEFAULT_SERVICE_COVERAGE_BBOX[3],
      }),
    ).toBe(true);
    expect(
      isWithinServiceCoverage({
        lng: DEFAULT_SERVICE_COVERAGE_BBOX[0] - 0.001,
        lat: 25,
      }),
    ).toBe(false);
    expect(
      isWithinServiceCoverage({
        lng: 121,
        lat: DEFAULT_SERVICE_COVERAGE_BBOX[3] + 0.001,
      }),
    ).toBe(false);
  });
});
