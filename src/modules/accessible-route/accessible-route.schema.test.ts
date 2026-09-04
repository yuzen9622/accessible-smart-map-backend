import { describe, expect, it } from "vitest";
import {
  AccessibleRouteDataSchema,
  AccessibleRouteRerouteBodySchema,
  AccessibleRouteRerouteDataSchema,
  AccessibleRouteSchema,
} from "./accessible-route.schema";
import { ROUTE_WARNING } from "../../constants/messages";

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

describe("AccessibleRouteRerouteBodySchema", () => {
  const valid = {
    routeToken: "capability",
    currentPosition: { latitude: 25.04, longitude: 121.56, accuracy: 8 },
    previousRouteVersion: 1,
    reason: "OFF_ROUTE",
    clientRequestId: "11111111-1111-4111-8111-111111111111",
  };

  it("accepts all valid RerouteReason values and rejects resubmitted intent", () => {
    expect(AccessibleRouteRerouteBodySchema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      AccessibleRouteRerouteBodySchema.safeParse({
        ...valid,
        destination: "不得重送",
      }).success,
    ).toBe(false);
    for (const reason of [
      "OFF_ROUTE",
      "FACILITY_OUTAGE",
      "CONFIRMED_HAZARD",
      "TRANSIT_DISRUPTION",
      "MANUAL",
    ] as const) {
      expect(
        AccessibleRouteRerouteBodySchema.safeParse({
          ...valid,
          reason,
        }).success,
      ).toBe(true);
    }
    expect(
      AccessibleRouteRerouteBodySchema.safeParse({
        ...valid,
        reason: "INVALID_REASON",
      }).success,
    ).toBe(false);
  });
});

describe("AccessibleRouteRerouteDataSchema", () => {
  it("publishes the frozen previous-version success field", () => {
    const data = {
      navigationId: "11111111-1111-4111-8111-111111111111",
      previousRouteVersion: 1,
      routeVersion: 2,
      routeToken: "replacement",
      route,
      instructions: [],
      steps: [],
      warnings: [],
      currentStepIndex: 0,
      replayed: false,
    };
    expect(AccessibleRouteRerouteDataSchema.parse(data)).toEqual(data);
  });
});

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

const machineWalkStep = {
  relativeDirection: "DEPART",
  absoluteDirection: null,
  streetName: "中山北路",
  bogusName: false,
  area: false,
  stairs: false,
  steepSlope: false,
  distanceM: 120,
  location: [121.56, 25.04] as [number, number],
};

describe("AccessibleRouteSchema WalkStep machine-only contract", () => {
  it("accepts a route without any WalkStep (steps optional)", () => {
    expect(AccessibleRouteSchema.safeParse(route).success).toBe(true);
  });

  it("accepts all and only the required machine fields", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, steps: [machineWalkStep] }],
      }).success,
    ).toBe(true);
  });

  it.each(["instruction", "maneuver", "text", "type"])(
    "rejects removed WalkStep field %s",
    (removedField) => {
      expect(
        AccessibleRouteSchema.safeParse({
          ...route,
          legs: [
            {
              ...walkLeg,
              steps: [{ ...machineWalkStep, [removedField]: "legacy" }],
            },
          ],
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown relative-direction and non-English absolute-direction values", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            steps: [{ ...machineWalkStep, relativeDirection: "FOLLOW_SIGNS" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            steps: [{ ...machineWalkStep, absoluteDirection: "東北" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects the removed navInstructions field", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        navInstructions: {
          instructions: [],
          initialBearing: 0,
          totalSteps: 0,
          warnings: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe("AccessibleRouteSchema pure-walk engine", () => {
  it("accepts only the two optional pure-walk provenance values", () => {
    for (const engine of ["pedestrian-a11y", "otp-fallback"] as const) {
      expect(
        AccessibleRouteSchema.safeParse({ ...route, engine }).success,
      ).toBe(true);
    }
    expect(
      AccessibleRouteSchema.safeParse({ ...route, engine: "valhalla" }).success,
    ).toBe(false);
  });

  it("keeps engine optional so transit routes remain compatible", () => {
    expect(AccessibleRouteSchema.safeParse(metroRoute).success).toBe(true);
  });
});

describe("AccessibleRouteDataSchema CSR slope constraint", () => {
  it("accepts a truthful unenforced arbitrary slope limit for a CSR route", () => {
    expect(
      AccessibleRouteDataSchema.safeParse({
        origin: { lat: 25.04, lng: 121.56 },
        destination: { lat: 25.03, lng: 121.55 },
        city: "Taipei",
        travelMode: "walk",
        routes: [{ ...route, engine: "pedestrian-a11y" }],
        slopeConstraint: {
          requestedMaxPercent: 10,
          enforced: false,
          note: ROUTE_WARNING.CSR_SLOPE_LIMIT_NOT_ENFORCED,
        },
      }).success,
    ).toBe(true);
  });
});

describe("AccessibleRouteSchema BUS, TRA, THSR alerts", () => {
  const matchedAlert = {
    alertId: "alert-101",
    title: "營運異常",
    description: "受施工影響改道",
    status: 2,
    matchKind: "route" as const,
  };

  const busLeg = {
    type: "BUS" as const,
    routeName: "307",
    departureStop: "板橋",
    arrivalStop: "撫遠街",
    waitInfo: { time: 5, source: "schedule" as const },
    direction: 0 as const,
    polyline: [
      [121.5, 25.0],
      [121.51, 25.01],
    ],
    departureStopA11y: [],
    arrivalStopA11y: [],
  };

  const traLeg = {
    type: "TRA" as const,
    trainNo: "123",
    trainTypeName: "自強",
    departureStation: "台北",
    arrivalStation: "基隆",
    departureStationUID: "TRA-1000",
    arrivalStationUID: "TRA-0900",
    departureTime: "08:30",
    arrivalTime: "09:02",
    rideMinutes: 32,
    waitInfo: { time: 10, source: "schedule" as const },
    polyline: [
      [121.5, 25.0],
      [121.7, 25.1],
    ],
    departureStationA11y: [],
    arrivalStationA11y: [],
    facilityHighlights: [],
  };

  const thsrLeg = {
    type: "THSR" as const,
    trainNo: "0617",
    departureStation: "台北",
    arrivalStation: "台中",
    departureStationUID: "THSR-1000",
    arrivalStationUID: "THSR-1040",
    departureTime: "09:00",
    arrivalTime: "09:47",
    rideMinutes: 47,
    waitInfo: { time: 8, source: "schedule" as const },
    polyline: [
      [121.5, 25.0],
      [120.6, 24.1],
    ],
    departureStationA11y: [],
    arrivalStationA11y: [],
    facilityHighlights: [],
  };

  it("accepts BUS leg with alerts", () => {
    const busRoute = {
      routeId: "bus-1",
      routeName: "307公車",
      totalMinutes: 20,
      transferCount: 0,
      legs: [{ ...busLeg, alerts: [matchedAlert] }],
      accessibilityHighlights: [],
    };
    expect(AccessibleRouteSchema.safeParse(busRoute).success).toBe(true);
  });

  it("accepts TRA leg with alerts", () => {
    const traRoute = {
      routeId: "tra-1",
      routeName: "臺鐵",
      totalMinutes: 32,
      transferCount: 0,
      legs: [{ ...traLeg, alerts: [matchedAlert] }],
      accessibilityHighlights: [],
    };
    expect(AccessibleRouteSchema.safeParse(traRoute).success).toBe(true);
  });

  it("accepts THSR leg with alerts", () => {
    const thsrRoute = {
      routeId: "thsr-1",
      routeName: "高鐵",
      totalMinutes: 47,
      transferCount: 0,
      legs: [{ ...thsrLeg, alerts: [matchedAlert] }],
      accessibilityHighlights: [],
    };
    expect(AccessibleRouteSchema.safeParse(thsrRoute).success).toBe(true);
  });
});

describe("AccessibleRouteDataSchema metroAlerts & transitAlerts", () => {
  const data = {
    origin: { lat: 25.05, lng: 121.52 },
    destination: { lat: 25.046, lng: 121.517 },
    city: "Taipei",
    travelMode: "transit" as const,
    routes: [metroRoute],
  };

  it("stays valid without metroAlerts and accepts per-system results and transitAlerts", () => {
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
        transitAlerts: [
          {
            alertId: "alert-101",
            title: "營運異常",
            description: "受施工影響改道",
            status: 2,
            matchKind: "route",
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

  it("omits a11ySegments on non-CSR WALK legs without failing", () => {
    expect(AccessibleRouteSchema.safeParse(route).success).toBe(true);
  });

  it("accepts a legal a11ySegments array on a WALK leg", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            a11ySegments: [
              {
                feature: "curb_ramp_crossing",
                startIndex: 0,
                endIndex: 1,
                indoor: false,
                distanceM: 8,
                maxSlopePercent: null,
                minWidthCm: null,
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an a11ySegments entry with a negative endIndex", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            a11ySegments: [
              {
                feature: "elevator",
                startIndex: 0,
                endIndex: -1,
                indoor: true,
                distanceM: null,
                maxSlopePercent: null,
                minWidthCm: null,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("omits a11yPoints on non-CSR WALK legs without failing", () => {
    expect(AccessibleRouteSchema.safeParse(route).success).toBe(true);
  });

  it("accepts a legal a11yPoints array on a WALK leg", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            a11yPoints: [{ type: "curb_ramp", location: [121.567, 25.041] }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an a11yPoints entry whose type is not curb_ramp", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            a11yPoints: [{ type: "elevator", location: [121.567, 25.041] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects an a11ySegments entry with an unknown feature", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            a11ySegments: [
              {
                feature: "bench",
                startIndex: 0,
                endIndex: 1,
                indoor: false,
                distanceM: null,
                maxSlopePercent: null,
                minWidthCm: null,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a WALK leg with sidewalkRampCount", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, sidewalkRampCount: 12 }],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-integer sidewalkRampCount", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, sidewalkRampCount: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a negative sidewalkRampCount", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, sidewalkRampCount: -1 }],
      }).success,
    ).toBe(false);
  });

  const baseStep = {
    relativeDirection: "DEPART",
    absoluteDirection: null,
    streetName: "",
    bogusName: true,
    area: false,
    stairs: false,
    steepSlope: false,
    distanceM: 15,
    location: [121.56, 25.04] as [number, number],
  };

  it("accepts a WalkStep with a legal steepSlope value", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, steps: [{ ...baseStep, steepSlope: true }] }],
      }).success,
    ).toBe(true);
  });

  it("rejects a WalkStep that omits steepSlope", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            steps: [
              (() => {
                const { steepSlope: _steepSlope, ...withoutSteepSlope } =
                  baseStep;
                return withoutSteepSlope;
              })(),
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a WalkStep whose steepSlope is not a boolean", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          {
            ...walkLeg,
            steps: [{ ...baseStep, steepSlope: "yes" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("AccessibleRouteSchema BusLeg low-floor enrichment", () => {
  const baseBusLeg = {
    type: "BUS" as const,
    routeName: "307",
    departureStop: "板橋",
    arrivalStop: "撫遠街",
    waitInfo: { time: 5, source: "schedule" as const },
    direction: 0 as const,
    polyline: [
      [121.5, 25.0] as [number, number],
      [121.51, 25.01] as [number, number],
    ],
    departureStopA11y: [],
    arrivalStopA11y: [],
  };

  const makeBusRoute = (legOverrides: Record<string, unknown> = {}) => ({
    routeId: "bus-lf-1",
    routeName: "307",
    totalMinutes: 20,
    transferCount: 0,
    legs: [{ ...baseBusLeg, ...legOverrides }],
    accessibilityHighlights: [],
  });

  it("accepts a BUS leg without any new low-floor fields (optional semantics)", () => {
    expect(AccessibleRouteSchema.safeParse(makeBusRoute()).success).toBe(true);
  });

  it("accepts a BUS leg with full low-floor and alternative metadata", () => {
    const valid = makeBusRoute({
      plateNumb: "KEA-1234",
      isLowFloor: false,
      hasLiftOrRamp: false,
      lowFloorAlternative: {
        plateNumb: "KEB-5678",
        etaMinutes: 12,
        stopsAway: null,
      },
    });
    expect(AccessibleRouteSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts lowFloorAlternative with null etaMinutes and numeric stopsAway", () => {
    const valid = makeBusRoute({
      plateNumb: "KEA-1234",
      isLowFloor: false,
      lowFloorAlternative: {
        plateNumb: "KEC-9999",
        etaMinutes: null,
        stopsAway: 4,
      },
    });
    expect(AccessibleRouteSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects non-boolean isLowFloor", () => {
    const invalid = makeBusRoute({
      isLowFloor: "是",
    });
    expect(AccessibleRouteSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects lowFloorAlternative missing plateNumb", () => {
    const invalid = makeBusRoute({
      lowFloorAlternative: {
        etaMinutes: 12,
        stopsAway: null,
      },
    });
    expect(AccessibleRouteSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects unknown extra fields on lowFloorAlternative (.strict())", () => {
    const invalid = makeBusRoute({
      lowFloorAlternative: {
        plateNumb: "KEB-5678",
        etaMinutes: 12,
        stopsAway: null,
        extraField: "not allowed",
      },
    });
    expect(AccessibleRouteSchema.safeParse(invalid).success).toBe(false);
  });
});
