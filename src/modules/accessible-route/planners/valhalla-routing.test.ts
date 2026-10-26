import { encode } from "@googlemaps/polyline-codec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeValhallaRoutes } from "../../../adapters/valhalla.adapter";
import { TRAFFIC_MSG } from "../../../constants/messages";
import { planOtpWalkDetailed } from "./otp-routing";
import {
  decodeValhallaShape,
  planValhallaRoute,
  ValhallaRoutingError,
} from "./valhalla-routing";

vi.mock("../../../adapters/valhalla.adapter", () => ({
  computeValhallaRoutes: vi.fn(),
}));
vi.mock("./otp-routing", () => ({
  planOtpRouteDetailed: vi.fn(),
  planOtpWalkDetailed: vi.fn(),
}));
const compute = vi.mocked(computeValhallaRoutes);
const otpWalk = vi.mocked(planOtpWalkDetailed);

function resetPlannerMocks(): void {
  vi.resetAllMocks();
  otpWalk.mockResolvedValue({ status: "unavailable", routes: [] });
}
const points: [number, number][] = [
  [25.041, 121.567],
  [25.04, 121.565],
  [25.034, 121.564],
];
const shape = encode(points, 6);
const normalizedTrip = {
  summary: { lengthKm: 1.5, timeSec: 125 },
  legs: [
    {
      summary: { lengthKm: 1.5, timeSec: 125 },
      shapePolyline6: shape,
      maneuvers: [
        {
          type: 1,
          instruction: "沿道路出發",
          lengthKm: 0.5,
          timeSec: 40,
          beginShapeIndex: 0,
          endShapeIndex: 1,
          streetNames: ["信義路"],
          stairs: false as const,
        },
        {
          type: 15,
          instruction: "左轉",
          lengthKm: 1,
          timeSec: 85,
          beginShapeIndex: 1,
          endShapeIndex: 2,
          stairs: false as const,
        },
      ],
    },
  ],
};

describe("planValhallaRoute", () => {
  beforeEach(resetPlannerMocks);
  it("decodes polyline6 to lng/lat", () =>
    expect(decodeValhallaShape(shape)[0]).toEqual([121.567, 25.041]));

  it("maps drive trips and alternatives without traffic fields", async () => {
    compute.mockResolvedValue({
      status: "OK",
      trips: [normalizedTrip, normalizedTrip],
    });
    const routes = await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      { travelMode: "drive" },
    );
    expect(routes.map((r) => r.routeId)).toEqual(["drive-0", "drive-1"]);
    expect(routes[0]).toMatchObject({
      totalMinutes: 2,
      attribution: "© OpenStreetMap contributors",
    });
    expect(routes[0].legs[0]).toMatchObject({
      type: "DRIVE",
      distanceM: 1500,
      durationMin: 2,
    });
    expect(
      routes[0].legs[0].type === "DRIVE" &&
        routes[0].legs[0].steps?.[0].instruction,
    ).toBe("沿「信義路」出發");
    expect(routes[0].legs[0]).not.toHaveProperty("durationInTrafficMin");
    expect(compute).toHaveBeenCalledWith(
      expect.objectContaining({
        dateTime: { type: 0 },
      }),
    );
  });

  it("maps walk steps using true shape locations", async () => {
    compute.mockResolvedValue({ status: "OK", trips: [normalizedTrip] });
    const routes = await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      { travelMode: "walk" },
    );
    expect(routes[0].legs[0]).toMatchObject({
      type: "WALK",
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
    });
    expect(
      routes[0].legs[0].type === "WALK" && routes[0].legs[0].steps?.[0],
    ).toMatchObject({
      location: [121.567, 25.041],
      relativeDirection: "DEPART",
      absoluteDirection: null,
      stairs: false,
      steepSlope: false,
    });
    const step =
      routes[0].legs[0].type === "WALK"
        ? routes[0].legs[0].steps?.[0]
        : undefined;
    expect(Object.keys(step ?? {}).sort()).toEqual([
      "absoluteDirection",
      "area",
      "bogusName",
      "distanceM",
      "location",
      "relativeDirection",
      "stairs",
      "steepSlope",
      "streetName",
    ]);
    expect(step).not.toHaveProperty("instruction");
    expect(step).not.toHaveProperty("maneuver");
  });

  it("omits whole-leg steps for out-of-bounds guidance", async () => {
    compute.mockResolvedValue({
      status: "OK",
      trips: [
        {
          ...normalizedTrip,
          legs: [
            {
              ...normalizedTrip.legs[0],
              maneuvers: [
                { ...normalizedTrip.legs[0].maneuvers[0], endShapeIndex: 99 },
              ],
            },
          ],
        },
      ],
    });
    const routes = await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      { travelMode: "walk" },
    );
    expect(routes[0].legs[0]).not.toHaveProperty("steps");
  });

  it("returns [] only for no route and throws typed errors otherwise", async () => {
    compute.mockResolvedValueOnce({ status: "NO_ROUTE", trips: [] });
    await expect(
      planValhallaRoute(
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
        { travelMode: "drive" },
      ),
    ).resolves.toEqual([]);
    compute.mockResolvedValueOnce({
      status: "UPSTREAM_ERROR",
      trips: [],
      httpStatus: 503,
    });
    await expect(
      planValhallaRoute(
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
        { travelMode: "drive" },
      ),
    ).rejects.toBeInstanceOf(ValhallaRoutingError);
  });
});

// --- walk access legs (head / tail / waypoint connectors for drive & motorcycle) ---

type LL = { lat: number; lng: number };
// A drive leg's from/to round-trip back to the original [lat,lng] pair fed to encode().
const driveLeg = (pts: [number, number][]) => ({
  summary: { lengthKm: 3, timeSec: 600 },
  shapePolyline6: encode(pts, 6),
});
const driveTrip = (legs: [number, number][][]) => ({
  status: "OK" as const,
  trips: [
    {
      summary: { lengthKm: 3 * legs.length, timeSec: 600 * legs.length },
      legs: legs.map(driveLeg),
    },
  ],
});
// Pedestrian mock endpoints EXACTLY equal the requested anchors → passes the gate.
const pedTripFrom = (o: LL, d: LL, timeSec = 180) => ({
  status: "OK" as const,
  trips: [
    {
      summary: { lengthKm: 0.15, timeSec },
      legs: [
        {
          summary: { lengthKm: 0.15, timeSec },
          shapePolyline6: encode(
            [
              [o.lat, o.lng],
              [d.lat, d.lng],
            ],
            6,
          ),
        },
      ],
    },
  ],
});
const otpTripFrom = (o: LL, d: LL) => ({
  status: "ok" as const,
  routes: [
    {
      routeId: "walk-0",
      routeName: "步行",
      totalMinutes: 3,
      transferCount: 0,
      totalWalkDistanceM: 150,
      accessibilityHighlights: [],
      legs: [
        {
          type: "WALK" as const,
          from: "出發地",
          to: "目的地",
          distanceM: 150,
          minutesEst: 3,
          polyline: [
            [o.lng, o.lat],
            [d.lng, d.lat],
          ] as [number, number][],
          a11yFacilities: [],
          maxSlopePercent: null,
          crossings: null,
          crossingsWithCurbRamp: null,
          minPathWidthCm: null,
          surfaceType: "unknown" as const,
          restPoints: [],
        },
      ],
    },
  ],
});
const walkLegs = (r: { legs: { type: string }[] }) =>
  r.legs.filter((l) => l.type === "WALK");

const ORIGIN: LL = { lat: 25.0, lng: 121.0 };
const OSNAP: LL = { lat: 25.002, lng: 121.0 }; // ~222m from ORIGIN → head connector
const DSNAP: LL = { lat: 25.05, lng: 121.05 };
const DEST: LL = { lat: 25.052, lng: 121.05 }; // ~222m from DSNAP → tail connector

describe("planValhallaRoute walk access legs", () => {
  beforeEach(resetPlannerMocks);

  const pedestrianRouter = (fn: (o: LL, d: LL) => any) =>
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? fn(p.origin, p.destination)
        : driveTrip([
            [
              [OSNAP.lat, OSNAP.lng],
              [DSNAP.lat, DSNAP.lng],
            ],
          ]),
    );

  it("declares access anchors without OTP or Valhalla pedestrian even when OTP is available", async () => {
    otpWalk.mockImplementation(async (origin, destination) =>
      otpTripFrom(origin, destination),
    );
    compute.mockResolvedValue(
      driveTrip([
        [
          [OSNAP.lat, OSNAP.lng],
          [DSNAP.lat, DSNAP.lng],
        ],
      ]),
    );

    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
      mode: "wheelchair",
      avoidStairs: true,
    });

    expect(route.legs.map((leg) => leg.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({
        beforeLegIndex: 0,
        fromAnchor: ORIGIN,
        toAnchor: OSNAP,
        role: "origin",
      }),
    ]);
    expect(otpWalk).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("defers wheelchair connector qualification without a raw pedestrian fallback", async () => {
    pedestrianRouter((origin, destination) => pedTripFrom(origin, destination));

    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
      mode: "wheelchair",
      avoidStairs: true,
    });

    expect(route.legs.map((leg) => leg.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toHaveLength(1);
    expect(compute.mock.calls.some(([p]) => p.costing === "pedestrian")).toBe(
      false,
    );
    expect(otpWalk).not.toHaveBeenCalled();
  });

  it("declares a head request when origin is off the drivable network", async () => {
    pedestrianRouter((o, d) => pedTripFrom(o, d));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      {
        beforeLegIndex: 0,
        fromAnchor: ORIGIN,
        toAnchor: OSNAP,
        from: "起點",
        to: "上車處",
        role: "origin",
      },
    ]);
    expect(route.totalWalkDistanceM).toBe(0);
    expect(route.accessibilityHighlights).toEqual([]);
  });

  it("declares both head and tail requests when both ends are off-network", async () => {
    pedestrianRouter((o, d) => pedTripFrom(o, d));
    const [route] = await planValhallaRoute(ORIGIN, DEST, {
      travelMode: "drive",
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({
        beforeLegIndex: 0,
        fromAnchor: ORIGIN,
        toAnchor: OSNAP,
        role: "origin",
      }),
      expect.objectContaining({
        beforeLegIndex: 1,
        fromAnchor: DSNAP,
        toAnchor: DEST,
        role: "destination",
        from: "下車處",
        to: "終點",
      }),
    ]);
  });

  it("leaves the route untouched when endpoints are already roadside", async () => {
    pedestrianRouter((o, d) => pedTripFrom(o, d));
    const [route] = await planValhallaRoute(OSNAP, DSNAP, {
      travelMode: "drive",
    });
    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(compute.mock.calls.some((c) => c[0].costing === "pedestrian")).toBe(
      false,
    );
    expect(route.totalWalkDistanceM).toBe(0);
  });

  it("retains the obligation even when a raw provider would return NO_ROUTE", async () => {
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toHaveLength(1);
    expect(route.accessibilityHighlights).toEqual([]);
    expect(otpWalk).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("defers access highlights until the consumer knows selected walking distance", async () => {
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });

    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({ role: "origin", from: "起點", to: "上車處" }),
    ]);
    expect(route.accessibilityHighlights).toEqual([]);
    expect(route._accessibilityHighlightMessages).toBeUndefined();
  });

  it("retains exact anchors rather than accepting raw provider endpoint drift", async () => {
    // pedestrian path ends ~55m from the drive snap → out of the 25m gate
    pedestrianRouter((o) =>
      pedTripFrom(o, { lat: OSNAP.lat + 0.0005, lng: OSNAP.lng }),
    );
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({ fromAnchor: ORIGIN, toAnchor: OSNAP }),
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("never emits a straight 2-point connector polyline (uses real pedestrian geometry only)", async () => {
    // Even for a failed gate the code must not fabricate a straight line
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(ORIGIN, DEST, {
      travelMode: "drive",
    });
    expect(walkLegs(route)).toHaveLength(0);
  });

  it("applies the same treatment to motorcycle", async () => {
    pedestrianRouter((o, d) => pedTripFrom(o, d));
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : driveTrip([
            [
              [OSNAP.lat, OSNAP.lng],
              [DSNAP.lat, DSNAP.lng],
            ],
          ]),
    );
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "motorcycle",
    });

    expect(route.legs.map((l) => l.type)).toEqual(["MOTORCYCLE"]);
    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({
        role: "origin",
        fromAnchor: ORIGIN,
        toAnchor: OSNAP,
      }),
    ]);
  });

  it("does not add connectors in walk mode", async () => {
    compute.mockResolvedValue(
      driveTrip([
        [
          [OSNAP.lat, OSNAP.lng],
          [DSNAP.lat, DSNAP.lng],
        ],
      ]),
    );
    const routes = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "walk",
    });
    expect(routes[0].legs.every((l) => l.type === "WALK")).toBe(true);
    // walk mode's own main query is pedestrian; connector logic must NOT run → exactly 1 call
    expect(
      compute.mock.calls.filter((c) => c[0].costing === "pedestrian"),
    ).toHaveLength(1);
  });

  it("declares independent obligations across alternates without pedestrian IO", async () => {
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : {
            status: "OK",
            trips: [
              driveTrip([
                [
                  [OSNAP.lat, OSNAP.lng],
                  [DSNAP.lat, DSNAP.lng],
                ],
              ]).trips[0],
              driveTrip([
                [
                  [OSNAP.lat, OSNAP.lng],
                  [DSNAP.lat, DSNAP.lng],
                ],
              ]).trips[0],
            ],
          },
    );
    const routes = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });

    expect(routes).toHaveLength(2);
    expect(
      compute.mock.calls.filter(([p]) => p.costing === "pedestrian"),
    ).toHaveLength(0);
    expect(
      routes.every(
        (r) =>
          r.legs[0].type === "DRIVE" && r._walkAccessRequests?.length === 1,
      ),
    ).toBe(true);
    expect(routes[0]._walkAccessRequests).not.toBe(
      routes[1]._walkAccessRequests,
    );
  });

  it("brackets a walk-only waypoint with an atomic arrive+depart WALK pair", async () => {
    const WP: LL = { lat: 25.03, lng: 121.03 }; // true waypoint
    const ARR: LL = { lat: 25.028, lng: 121.028 }; // arrival snap (leg0.to)
    const DEP: LL = { lat: 25.0281, lng: 121.0281 }; // departure snap (leg1.from), different point
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : driveTrip([
            [
              [OSNAP.lat, OSNAP.lng],
              [ARR.lat, ARR.lng],
            ],
            [
              [DEP.lat, DEP.lng],
              [DSNAP.lat, DSNAP.lng],
            ],
          ]),
    );
    const [route] = await planValhallaRoute(OSNAP, DSNAP, {
      travelMode: "drive",
      waypoints: [WP],
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE", "DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      {
        beforeLegIndex: 1,
        fromAnchor: ARR,
        toAnchor: WP,
        from: "中途點 1 停車處",
        to: "中途點 1",
        role: "waypoint",
        waypointIndex: 1,
      },
      {
        beforeLegIndex: 1,
        fromAnchor: WP,
        toAnchor: DEP,
        from: "中途點 1",
        to: "中途點 1 停車處",
        role: "waypoint",
        waypointIndex: 1,
      },
    ]);
  });

  it("retains both waypoint obligations even when raw departure would fail", async () => {
    const WP: LL = { lat: 25.03, lng: 121.03 };
    const ARR: LL = { lat: 25.028, lng: 121.028 };
    const DEP: LL = { lat: 25.0281, lng: 121.0281 };
    compute.mockImplementation(async (p: any) => {
      if (p.costing !== "pedestrian")
        return driveTrip([
          [
            [OSNAP.lat, OSNAP.lng],
            [ARR.lat, ARR.lng],
          ],
          [
            [DEP.lat, DEP.lng],
            [DSNAP.lat, DSNAP.lng],
          ],
        ]);
      // depart connector (from the true waypoint) fails; arrive succeeds
      if (
        Math.abs(p.origin.lat - WP.lat) < 1e-9 &&
        Math.abs(p.origin.lng - WP.lng) < 1e-9
      )
        return { status: "NO_ROUTE", trips: [] };
      return pedTripFrom(p.origin, p.destination);
    });
    const [route] = await planValhallaRoute(OSNAP, DSNAP, {
      travelMode: "drive",
      waypoints: [WP],
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE", "DRIVE"]);
    expect(route._walkAccessRequests).toHaveLength(2);
    expect(
      route._walkAccessRequests?.map((r) => [r.fromAnchor, r.toAnchor]),
    ).toEqual([
      [ARR, WP],
      [WP, DEP],
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("retains both waypoint obligations even when raw arrival would fail", async () => {
    const WP: LL = { lat: 25.03, lng: 121.03 };
    const ARR: LL = { lat: 25.028, lng: 121.028 };
    const DEP: LL = { lat: 25.0281, lng: 121.0281 };
    compute.mockImplementation(async (p: any) => {
      if (p.costing !== "pedestrian")
        return driveTrip([
          [
            [OSNAP.lat, OSNAP.lng],
            [ARR.lat, ARR.lng],
          ],
          [
            [DEP.lat, DEP.lng],
            [DSNAP.lat, DSNAP.lng],
          ],
        ]);
      // arrive connector (to the true waypoint) fails; depart succeeds
      if (
        Math.abs(p.destination.lat - WP.lat) < 1e-9 &&
        Math.abs(p.destination.lng - WP.lng) < 1e-9
      )
        return { status: "NO_ROUTE", trips: [] };
      return pedTripFrom(p.origin, p.destination);
    });
    const [route] = await planValhallaRoute(OSNAP, DSNAP, {
      travelMode: "drive",
      waypoints: [WP],
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE", "DRIVE"]);
    expect(route._walkAccessRequests).toHaveLength(2);
    expect(
      route._walkAccessRequests?.map((r) => [r.fromAnchor, r.toAnchor]),
    ).toEqual([
      [ARR, WP],
      [WP, DEP],
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("excludes malformed provider records when leg count does not match waypoint count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 1 waypoint requested but Valhalla returns a single leg
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : driveTrip([
            [
              [OSNAP.lat, OSNAP.lng],
              [DSNAP.lat, DSNAP.lng],
            ],
          ]),
    );
    const [route] = await planValhallaRoute(ORIGIN, DEST, {
      travelMode: "drive",
      waypoints: [{ lat: 25.03, lng: 121.03 }],
    });

    expect(route).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid vehicle leg/waypoint count"),
      { routeIndex: 0 },
    );
    warn.mockRestore();
  });

  it("keeps per-position labels correct when the same geometry is reused (no cache label bleed)", async () => {
    // head anchors (ORIGIN→OSNAP) and a waypoint arrive share identical coords → same cache key
    const WP: LL = OSNAP; // waypoint equals the head snap coords
    const ARR: LL = ORIGIN; // arrival snap equals origin → arrive connector key == head key
    const DEP: LL = { lat: 25.0281, lng: 121.0281 };
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : driveTrip([
            [
              [OSNAP.lat, OSNAP.lng],
              [ARR.lat, ARR.lng],
            ],
            [
              [DEP.lat, DEP.lng],
              [DSNAP.lat, DSNAP.lng],
            ],
          ]),
    );
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
      waypoints: [WP],
    });

    const head = route._walkAccessRequests?.find((r) => r.role === "origin");
    const wpIn = route._walkAccessRequests?.find(
      (r) => r.from === "中途點 1 停車處",
    );
    expect(head).toMatchObject({
      from: "起點",
      to: "上車處",
      fromAnchor: ORIGIN,
      toAnchor: OSNAP,
    });
    expect(wpIn).toMatchObject({
      from: "中途點 1 停車處",
      to: "中途點 1",
      fromAnchor: ORIGIN,
      toAnchor: OSNAP,
    });
    expect(head).not.toBe(wpIn);
  });
});

// --- parking-aware tail: finalWalkTarget redirects the trailing WALK ---

// PARK = the drive's routing destination snap (the disabled-parking bay);
// DEST is the TRUE destination ~222m past it, so a tail connector appears.
const PARK: LL = DSNAP;

describe("planValhallaRoute finalWalkTarget (parking-aware tail)", () => {
  beforeEach(resetPlannerMocks);

  it("targets finalWalkTarget instead of the routing destination", async () => {
    // origin == drive leg start → no head; routing dest == PARK == drive leg end
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : driveTrip([
            [
              [ORIGIN.lat, ORIGIN.lng],
              [PARK.lat, PARK.lng],
            ],
          ]),
    );
    const [route] = await planValhallaRoute(ORIGIN, PARK, {
      travelMode: "drive",
      finalWalkTarget: DEST,
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({
        beforeLegIndex: 1,
        fromAnchor: PARK,
        toAnchor: DEST,
        role: "destination",
      }),
    ]);
  });

  it("targets the routing destination when finalWalkTarget is unset (regression)", async () => {
    compute.mockImplementation(async (p: any) =>
      p.costing === "pedestrian"
        ? pedTripFrom(p.origin, p.destination)
        : driveTrip([
            [
              [ORIGIN.lat, ORIGIN.lng],
              [PARK.lat, PARK.lng],
            ],
          ]),
    );
    const [route] = await planValhallaRoute(ORIGIN, DEST, {
      travelMode: "drive",
    });

    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(route._walkAccessRequests).toEqual([
      expect.objectContaining({
        fromAnchor: PARK,
        toAnchor: DEST,
        role: "destination",
      }),
    ]);
  });
});

describe("planValhallaRoute closed-road exclusions", () => {
  beforeEach(resetPlannerMocks);

  const CLOSURES = [
    { lat: 25.0439, lng: 121.5445 },
    { lat: 25.0401, lng: 121.5502 },
  ];

  /** Drive attempts only, excluding the pedestrian connector calls. */
  const driveCalls = () =>
    compute.mock.calls.filter((call) => call[0].costing === "auto");

  it("forwards the requested exclusions on the first attempt", async () => {
    compute.mockResolvedValue({ status: "OK", trips: [normalizedTrip] });
    await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      {
        travelMode: "drive",
        excludeLocations: CLOSURES,
      },
    );
    expect(driveCalls()).toHaveLength(1);
    expect(driveCalls()[0][0]).toMatchObject({ excludeLocations: CLOSURES });
  });

  it("retries without exclusions and warns when they remove every route", async () => {
    compute
      .mockResolvedValueOnce({ status: "NO_ROUTE", trips: [] })
      .mockResolvedValueOnce({ status: "OK", trips: [normalizedTrip] });
    const routes = await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      { travelMode: "drive", excludeLocations: CLOSURES },
    );
    expect(driveCalls()).toHaveLength(2);
    expect(driveCalls()[1][0]).not.toHaveProperty("excludeLocations");
    expect(routes).not.toHaveLength(0);
    expect(routes[0].accessibilityHighlights).toContain(
      TRAFFIC_MSG.CLOSURE_BYPASS_FAILED,
    );
  });

  it("does not retry when no exclusions were requested", async () => {
    compute.mockResolvedValue({ status: "NO_ROUTE", trips: [] });
    await expect(
      planValhallaRoute(
        { lat: 25, lng: 121 },
        { lat: 25.1, lng: 121.1 },
        {
          travelMode: "drive",
        },
      ),
    ).resolves.toEqual([]);
    expect(driveCalls()).toHaveLength(1);
  });

  it("gives up after the unexcluded retry also finds no route", async () => {
    compute.mockResolvedValue({ status: "NO_ROUTE", trips: [] });
    await expect(
      planValhallaRoute(
        { lat: 25, lng: 121 },
        { lat: 25.1, lng: 121.1 },
        {
          travelMode: "drive",
          excludeLocations: CLOSURES,
        },
      ),
    ).resolves.toEqual([]);
    expect(driveCalls()).toHaveLength(2);
  });
});

describe("exact arrival obligations and invalid provider alternatives", () => {
  beforeEach(resetPlannerMocks);
  it("requires a known 10m parking walk while retaining ordinary 30m snap tolerance", async () => {
    compute.mockResolvedValue(
      driveTrip([
        [
          [ORIGIN.lat, ORIGIN.lng],
          [PARK.lat, PARK.lng],
        ],
      ]),
    );
    const target = { lat: PARK.lat + 0.00009, lng: PARK.lng };
    const [ordinary] = await planValhallaRoute(ORIGIN, target, {
      travelMode: "drive",
    });
    expect(ordinary._walkAccessRequests).toBeUndefined();
    const [parking] = await planValhallaRoute(ORIGIN, PARK, {
      travelMode: "drive",
      finalWalkTarget: target,
    });
    expect(parking.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(parking._walkAccessRequests).toEqual([
      expect.objectContaining({
        beforeLegIndex: 1,
        fromAnchor: PARK,
        toAnchor: target,
        role: "destination",
      }),
    ]);
    expect(parking.totalWalkDistanceM).toBe(0);
    expect(compute.mock.calls.some(([p]) => p.costing === "pedestrian")).toBe(
      false,
    );
    expect(otpWalk).not.toHaveBeenCalled();
  });
  it("does not request walking below exact endpoint precision", async () => {
    compute.mockResolvedValue(
      driveTrip([
        [
          [ORIGIN.lat, ORIGIN.lng],
          [PARK.lat, PARK.lng],
        ],
      ]),
    );
    const [parking] = await planValhallaRoute(ORIGIN, PARK, {
      travelMode: "drive",
      finalWalkTarget: { lat: PARK.lat + 0.000001, lng: PARK.lng },
    });
    expect(parking._walkAccessRequests).toBeUndefined();
  });
  it("excludes a malformed trip without throwing away a valid alternative", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = driveTrip([
      [
        [ORIGIN.lat, ORIGIN.lng],
        [PARK.lat, PARK.lng],
      ],
    ]).trips[0];
    compute.mockResolvedValue({
      status: "OK",
      trips: [
        { ...valid, legs: [{ ...valid.legs[0], shapePolyline6: "" }] },
        valid,
      ],
    });
    const routes = await planValhallaRoute(ORIGIN, PARK, {
      travelMode: "drive",
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].routeId).toBe("drive-1");
    expect(warn).toHaveBeenCalledWith(
      "[valhalla-routing] malformed vehicle trip",
      { index: 0 },
    );
    warn.mockRestore();
  });
});
