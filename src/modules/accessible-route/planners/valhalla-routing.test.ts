import { encode } from "@googlemaps/polyline-codec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeValhallaRoutes } from "../../../adapters/valhalla.adapter";
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
const near = (a: [number, number], b: LL) =>
  Math.abs(a[0] - b.lng) < 1e-6 && Math.abs(a[1] - b.lat) < 1e-6;

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

  it("uses OTP as the primary walk connector without calling Valhalla pedestrian", async () => {
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

    expect(route.legs.map((leg) => leg.type)).toEqual(["WALK", "DRIVE"]);
    expect(otpWalk).toHaveBeenCalledWith(ORIGIN, OSNAP, {
      mode: "wheelchair",
      avoidStairs: true,
    });
    expect(
      compute.mock.calls.filter((call) => call[0].costing === "pedestrian"),
    ).toHaveLength(0);
    expect(route.warnings).toBeUndefined();
  });

  it("marks and wheelchair-costs a Valhalla connector fallback", async () => {
    pedestrianRouter((origin, destination) => pedTripFrom(origin, destination));

    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
      mode: "wheelchair",
      avoidStairs: true,
    });

    const pedestrianCall = compute.mock.calls.find(
      (call) => call[0].costing === "pedestrian",
    );
    expect(pedestrianCall?.[0].wheelchair).toBe(true);
    expect(route.warnings).toContain(
      "OTP 步行規劃暫時不可用，已降級使用 Valhalla 步行路線，指引品質可能不同",
    );
    expect(route.legs[0]).toMatchObject({
      type: "WALK",
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
    });
  });

  it("prepends a head WALK when origin is off the drivable network", async () => {
    pedestrianRouter((o, d) => pedTripFrom(o, d));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });
    expect(route.legs.map((l) => l.type)).toEqual(["WALK", "DRIVE"]);
    const head = route.legs[0];
    const drive = route.legs[1];
    expect(head.type === "WALK" && head.from).toBe("起點");
    // continuity: WALK end ≈ DRIVE from (Osnap); WALK start ≈ origin
    expect(head.type === "WALK" && near(head.polyline.at(-1)!, OSNAP)).toBe(
      true,
    );
    expect(head.type === "WALK" && near(head.polyline[0], ORIGIN)).toBe(true);
    expect(drive.type === "DRIVE" && drive.from).toMatchObject(OSNAP);
    expect(route.totalWalkDistanceM).toBe(150);
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("起點需步行約 150 公尺"),
      ),
    ).toBe(true);
  });

  it("adds both head and tail WALK when both ends are off-network", async () => {
    pedestrianRouter((o, d) => pedTripFrom(o, d));
    const [route] = await planValhallaRoute(ORIGIN, DEST, {
      travelMode: "drive",
    });
    expect(route.legs.map((l) => l.type)).toEqual(["WALK", "DRIVE", "WALK"]);
    const tail = route.legs[2];
    expect(tail.type === "WALK" && [tail.from, tail.to]).toEqual([
      "下車處",
      "終點",
    ]);
    expect(tail.type === "WALK" && near(tail.polyline[0], DSNAP)).toBe(true);
    expect(tail.type === "WALK" && near(tail.polyline.at(-1)!, DEST)).toBe(
      true,
    );
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

  it("drops the connector and warns when no walkable path exists (NO_ROUTE)", async () => {
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });
    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("無法建立可信步行路徑"),
      ),
    ).toBe(true);
  });

  it("drops the connector when the pedestrian endpoint lands beyond tolerance", async () => {
    // pedestrian path ends ~55m from the drive snap → out of the 25m gate
    pedestrianRouter((o) =>
      pedTripFrom(o, { lat: OSNAP.lat + 0.0005, lng: OSNAP.lng }),
    );
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });
    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE"]);
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("無法建立可信步行路徑"),
      ),
    ).toBe(true);
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
    expect(route.legs.map((l) => l.type)).toEqual(["WALK", "MOTORCYCLE"]);
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

  it("single-flights shared connectors across alternates", async () => {
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
    // both alternates share the same Osnap → one pedestrian call, not two
    expect(
      compute.mock.calls.filter((c) => c[0].costing === "pedestrian"),
    ).toHaveLength(1);
    expect(routes.every((r) => r.legs[0].type === "WALK")).toBe(true);
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
    expect(route.legs.map((l) => l.type)).toEqual([
      "DRIVE",
      "WALK",
      "WALK",
      "DRIVE",
    ]);
    const [, wIn, wOut] = route.legs;
    // arrive-side gate against leg0.to, depart-side against leg1.from (R8-F1)
    expect(wIn.type === "WALK" && near(wIn.polyline[0], ARR)).toBe(true);
    expect(wIn.type === "WALK" && near(wIn.polyline.at(-1)!, WP)).toBe(true);
    expect(wOut.type === "WALK" && near(wOut.polyline[0], WP)).toBe(true);
    expect(wOut.type === "WALK" && near(wOut.polyline.at(-1)!, DEP)).toBe(true);
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("中途點 1 需步行約 300 公尺往返停車處"),
      ),
    ).toBe(true);
  });

  it("inserts neither waypoint WALK when the pair is not atomic (depart fails)", async () => {
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
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("中途點 1 距可行車路段"),
      ),
    ).toBe(true);
  });

  it("inserts neither waypoint WALK when the pair is not atomic (arrive fails)", async () => {
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
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("中途點 1 距可行車路段"),
      ),
    ).toBe(true);
  });

  it("skips waypoint legs (head/tail only) when leg count does not match waypoint count", async () => {
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
    expect(route.legs.map((l) => l.type)).toEqual(["WALK", "DRIVE", "WALK"]);
    expect(warn).toHaveBeenCalled();
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
    const head = route.legs.find((l) => l.type === "WALK" && l.from === "起點");
    const wpIn = route.legs.find(
      (l) => l.type === "WALK" && l.from === "中途點 1 停車處",
    );
    expect(head).toBeDefined();
    expect(wpIn).toBeDefined();
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
    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE", "WALK"]);
    const drive = route.legs[0];
    const tail = route.legs[1];
    expect(drive.type === "DRIVE" && drive.to).toMatchObject(PARK);
    // tail reaches the TRUE destination, not the parking snap
    expect(tail.type === "WALK" && near(tail.polyline.at(-1)!, DEST)).toBe(
      true,
    );
    expect(tail.type === "WALK" && near(tail.polyline.at(-1)!, PARK)).toBe(
      false,
    );
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
    expect(route.legs.map((l) => l.type)).toEqual(["DRIVE", "WALK"]);
    const tail = route.legs[1];
    expect(tail.type === "WALK" && near(tail.polyline.at(-1)!, DEST)).toBe(
      true,
    );
  });
});
