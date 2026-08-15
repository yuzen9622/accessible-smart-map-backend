import { describe, expect, it } from "vitest";
import {
  AccessibleRouteDataSchema,
  AccessibleRouteSchema,
} from "./accessible-route.schema";

const walkLeg = {
  type: "WALK" as const,
  from: "起點",
  to: "終點",
  distanceM: 120,
  minutesEst: 2,
  polyline: [
    [121.56, 25.04],
    [121.561, 25.04],
  ],
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown" as const,
  restPoints: [],
};

const route = {
  routeId: "b12-walk",
  routeName: "步行",
  totalMinutes: 2,
  transferCount: 0,
  legs: [walkLeg],
  accessibilityHighlights: [],
};

const metroLeg = {
  type: "METRO" as const,
  railSystem: "TRTC",
  lineId: "R",
  lineName: "淡水信義線",
  lineUid: "TRTC-R",
  departureStation: "中山站",
  arrivalStation: "台北車站",
  departureStationUid: "TRTC-R10",
  arrivalStationUid: "TRTC-R11",
  direction: 0 as const,
  stopsCount: 1,
  rideMinutes: 3,
  waitInfo: { time: 4, source: "schedule" as const },
  polyline: [
    [121.52, 25.05],
    [121.517, 25.046],
  ],
  departureStationA11y: [],
  arrivalStationA11y: [],
  facilityHighlights: [],
};

const metroRoute = {
  routeId: "metro-1",
  routeName: "捷運",
  totalMinutes: 5,
  transferCount: 0,
  legs: [metroLeg],
  accessibilityHighlights: [],
};

const metroAlert = {
  alertId: "fault-1",
  title: "電梯故障",
  description: "R10 電梯維修中",
  status: 2,
  stations: [{ id: "R10", name: "中山站" }],
  lines: ["R"],
  publishTime: "2026-08-15T09:30:00+08:00",
  updateTime: "2026-08-15T09:45:00+08:00",
};

describe("AccessibleRouteSchema METRO alerts", () => {
  it("accepts a METRO leg with or without alerts", () => {
    expect(AccessibleRouteSchema.safeParse(metroRoute).success).toBe(true);
    expect(
      AccessibleRouteSchema.safeParse({
        ...metroRoute,
        legs: [{ ...metroLeg, alerts: [metroAlert] }],
      }).success,
    ).toBe(true);
  });

  it("keeps the alert shape typed", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...metroRoute,
        legs: [{ ...metroLeg, alerts: [{ ...metroAlert, status: "2" }] }],
      }).success,
    ).toBe(false);
  });
});

describe("AccessibleRouteDataSchema metroAlerts", () => {
  const data = {
    origin: { lat: 25.05, lng: 121.52 },
    destination: { lat: 25.046, lng: 121.517 },
    city: "Taipei",
    travelMode: "transit" as const,
    routes: [metroRoute],
  };

  it("stays valid without metroAlerts and accepts per-system results", () => {
    expect(AccessibleRouteDataSchema.safeParse(data).success).toBe(true);
    expect(
      AccessibleRouteDataSchema.safeParse({
        ...data,
        metroAlerts: [
          {
            railSystem: "TRTC",
            updatedAt: "2026-08-15T10:00:00+08:00",
            alerts: [metroAlert],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("AccessibleRouteSchema B12 WALK details", () => {
  it("requires the stable explicit unknown-capable WALK detail shape", () => {
    expect(AccessibleRouteSchema.safeParse(route).success).toBe(true);
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, maxSlopePercent: undefined }],
      }).success,
    ).toBe(false);
  });

  it("keeps WALK details strict, including strict rest-point objects", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            restPoints: [
              { type: "accessible_toilet", distanceM: 45, guessed: true },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
