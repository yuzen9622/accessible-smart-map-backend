import { encode } from "@googlemaps/polyline-codec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeValhallaRoutes } from "../../../adapters/valhalla.adapter";
import { TRAFFIC_MSG } from "../../../constants/messages";
import { VALHALLA_MAX_EXCLUDE_LOCATIONS } from "../../../config/valhalla";
import { presentRouteMessages } from "../../../utils/route-messages";
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

  it("estimates exploratory walking candidates at the requested wheelchair speed", async () => {
    compute.mockResolvedValue({ status: "OK", trips: [normalizedTrip] });
    await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      {
        travelMode: "walk",
        mode: "wheelchair",
        walkingCandidates: true,
      },
    );
    expect(compute).toHaveBeenCalledWith(
      expect.objectContaining({
        wheelchair: false,
        walkingSpeedKmh: expect.closeTo(2.88),
        computeAlternatives: true,
      }),
    );
  });

  it("marks stairs in Valhalla pedestrian guidance", async () => {
    const stairManeuver = {
      ...normalizedTrip.legs[0].maneuvers[0],
      type: 40,
      stairs: true,
    };
    compute.mockResolvedValue({
      status: "OK",
      trips: [
        {
          ...normalizedTrip,
          legs: [{ ...normalizedTrip.legs[0], maneuvers: [stairManeuver] }],
        },
      ],
    });
    const [route] = await planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.1, lng: 121.1 },
      { travelMode: "walk" },
    );
    const leg = route.legs[0];
    expect(leg.type === "WALK" && leg.steps?.[0].stairs).toBe(true);
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

  it.each([
    { mode: "wheelchair" as const, avoidStairs: true },
    { mode: "wheelchair" as const, avoidStairs: false },
    { mode: "normal" as const, avoidStairs: true },
  ])(
    "keeps the gap warning when step-free connector evidence is unavailable for $mode",
    async (options) => {
      pedestrianRouter((origin, destination) =>
        pedTripFrom(origin, destination),
      );

      const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
        travelMode: "drive",
        ...options,
      });

      expect(route.legs.map((leg) => leg.type)).toEqual(["DRIVE"]);
      expect(route.accessibilityHighlights).toEqual(
        expect.arrayContaining([
          expect.stringContaining("無法建立可信步行路徑"),
        ]),
      );
      expect(
        compute.mock.calls.some(([params]) => params.costing === "pedestrian"),
      ).toBe(false);
    },
  );

  it("selects an OTP connector alternative that reaches both anchors", async () => {
    otpWalk.mockImplementation(async (origin, destination) => {
      const bad = otpTripFrom(origin, {
        lat: destination.lat + 0.001,
        lng: destination.lng,
      });
      const good = otpTripFrom(origin, destination);
      return { status: "ok", routes: [bad.routes[0], good.routes[0]] };
    });
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
      avoidStairs: true,
    });

    expect(route.legs.map((leg) => leg.type)).toEqual(["WALK", "DRIVE"]);
    const walk = route.legs[0];
    expect(walk.type === "WALK" && near(walk.polyline.at(-1)!, OSNAP)).toBe(
      true,
    );
    expect(
      route.accessibilityHighlights.some((h) =>
        h.includes("無法建立可信步行路徑"),
      ),
    ).toBe(false);
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

  it("emits a machine-tagged connector warning that renders in English without changing the route", async () => {
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });
    const before = JSON.stringify(route);
    const presented = presentRouteMessages(
      route.accessibilityHighlights,
      route._accessibilityHighlightMessages,
      "en",
    );
    expect(presented.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ROUTE_WALK_CONNECTOR_UNAVAILABLE",
          params: expect.objectContaining({
            placeRole: "origin",
            placeLabel: "Origin",
          }),
          message: expect.stringContaining("Origin is about"),
        }),
      ]),
    );
    expect(JSON.stringify(route)).toBe(before);
  });

  it("drops the connector when the pedestrian endpoint lands beyond tolerance", async () => {
    // Pedestrian path ends ~10 m from the drive snap, beyond the 5 m gate.
    pedestrianRouter((o) =>
      pedTripFrom(o, { lat: OSNAP.lat + 0.00009, lng: OSNAP.lng }),
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

  it.each(["origin", "road"] as const)(
    "rejects OTP geometry over 5 m from the %s anchor and retains its warning",
    async (endpoint) => {
      otpWalk.mockImplementation(async (origin, destination) =>
        otpTripFrom(
          endpoint === "origin"
            ? { ...origin, lat: origin.lat + 0.00009 }
            : origin,
          endpoint === "road"
            ? { ...destination, lat: destination.lat + 0.00009 }
            : destination,
        ),
      );
      pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
      const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
        travelMode: "drive",
      });
      expect(route.legs.map((leg) => leg.type)).toEqual(["DRIVE"]);
      expect(route.accessibilityHighlights).toEqual(
        expect.arrayContaining([
          expect.stringContaining("無法建立可信步行路徑"),
        ]),
      );
    },
  );

  it("accepts a genuine connector whose endpoints are within 5 m", async () => {
    otpWalk.mockImplementation(async (origin, destination) =>
      otpTripFrom(
        { ...origin, lat: origin.lat + 0.00002 },
        { ...destination, lat: destination.lat + 0.00002 },
      ),
    );
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(ORIGIN, DSNAP, {
      travelMode: "drive",
    });
    expect(route.legs.map((leg) => leg.type)).toEqual(["WALK", "DRIVE"]);
  });

  it("tries a connector for a road snap more than 5 m from the requested point", async () => {
    const nearOrigin = { ...OSNAP, lat: OSNAP.lat + 0.00009 };
    pedestrianRouter(() => ({ status: "NO_ROUTE", trips: [] }));
    const [route] = await planValhallaRoute(nearOrigin, DSNAP, {
      travelMode: "drive",
    });
    expect(route.legs.map((leg) => leg.type)).toEqual(["DRIVE"]);
    expect(route.accessibilityHighlights).toEqual(
      expect.arrayContaining([expect.stringContaining("無法建立可信步行路徑")]),
    );
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

  it("warns when waypoint walks each approach the point but their endpoints are over 5 m apart", async () => {
    const WP: LL = { lat: 25.03, lng: 121.03 };
    const ARR: LL = { lat: 25.028, lng: 121.028 };
    const DEP: LL = ARR;
    otpWalk.mockImplementation(async (origin, destination) => {
      if (Math.abs(destination.lat - WP.lat) < 1e-9) {
        return otpTripFrom(origin, {
          ...destination,
          lat: destination.lat + 0.00004,
        });
      }
      return otpTripFrom({ ...origin, lat: origin.lat - 0.00004 }, destination);
    });
    compute.mockResolvedValue(
      driveTrip([
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
    expect(route.legs.map((leg) => leg.type)).toEqual(["DRIVE", "DRIVE"]);
    expect(route.accessibilityHighlights).toEqual(
      expect.arrayContaining([
        expect.stringContaining("中途點 1 距可行車路段"),
      ]),
    );
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

  it("rejects only candidates whose leg count does not match the requested waypoints", async () => {
    const wp: LL = { lat: 25.03, lng: 121.03 };
    const invalid = driveTrip([
      [
        [OSNAP.lat, OSNAP.lng],
        [DSNAP.lat, DSNAP.lng],
      ],
    ]).trips[0];
    const valid = driveTrip([
      [
        [OSNAP.lat, OSNAP.lng],
        [wp.lat, wp.lng],
      ],
      [
        [wp.lat, wp.lng],
        [DSNAP.lat, DSNAP.lng],
      ],
    ]).trips[0];
    compute.mockResolvedValue({ status: "OK", trips: [invalid, valid] });
    const routes = await planValhallaRoute(OSNAP, DSNAP, {
      travelMode: "drive",
      waypoints: [wp],
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].legs.map((leg) => leg.type)).toEqual(["DRIVE", "DRIVE"]);
    expect(routes[0].legs[0].polyline.at(-1)).toEqual([wp.lng, wp.lat]);
    expect(routes[0].legs[1].polyline[0]).toEqual([wp.lng, wp.lat]);
  });

  it("returns no candidates when none contain all requested waypoint legs", async () => {
    compute.mockResolvedValue(
      driveTrip([
        [
          [OSNAP.lat, OSNAP.lng],
          [DSNAP.lat, DSNAP.lng],
        ],
      ]),
    );
    const routes = await planValhallaRoute(OSNAP, DSNAP, {
      travelMode: "drive",
      waypoints: [{ lat: 25.03, lng: 121.03 }],
    });
    expect(routes).toEqual([]);
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
    expect(driveCalls()).toHaveLength(6);
    expect(driveCalls()[0][0]).toMatchObject({ excludeLocations: CLOSURES });
    for (const [params] of driveCalls().slice(1)) {
      expect(params.excludeLocations?.slice(0, CLOSURES.length)).toEqual(
        CLOSURES,
      );
      expect(params.excludeLocations).toHaveLength(
        params.distanceWeight ? CLOSURES.length : CLOSURES.length + 1,
      );
    }
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
    expect(driveCalls()).toHaveLength(7);
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

describe("road alternative searches", () => {
  beforeEach(resetPlannerMocks);

  it.each(["drive", "motorcycle"] as const)(
    "keeps live traffic, waypoints and closures while finding distinct %s routes",
    async (travelMode) => {
      const origin = { lat: 25.041, lng: 121.567 };
      const destination = { lat: 25.034, lng: 121.564 };
      const waypoint = { lat: 25.04, lng: 121.565 };
      const closures = [{ lat: 25.05, lng: 121.55 }];
      const alternate = (offset: number) =>
        driveTrip([
          [points[0], [points[1][0] + offset, points[1][1]], points[1]],
          [points[1], points[2]],
        ]).trips[0];
      const first = alternate(0);
      const other = [alternate(0.002), alternate(-0.002)];
      let roadCalls = 0;
      compute.mockImplementation(async (params) => {
        if (params.costing === "pedestrian")
          return { status: "NO_ROUTE", trips: [] };
        roadCalls++;
        if (roadCalls === 1) return { status: "OK", trips: [first] };
        if (roadCalls === 2) return { status: "OK", trips: [other[0]] };
        if (roadCalls === 3) return { status: "OK", trips: [other[1]] };
        return { status: "NO_ROUTE", trips: [] };
      });

      const routes = await planValhallaRoute(origin, destination, {
        travelMode,
        waypoints: [waypoint],
        excludeLocations: closures,
      });
      expect(routes).toHaveLength(3);
      expect(
        new Set(routes.map((route) => JSON.stringify(route.legs))).size,
      ).toBe(3);
      const calls = compute.mock.calls.filter(
        ([params]) => params.costing !== "pedestrian",
      );
      expect(calls.length).toBeGreaterThanOrEqual(3);
      const distanceCalls = calls.filter(
        ([params]) => params.distanceWeight === 0.7,
      );
      expect(distanceCalls).toHaveLength(1);
      expect(distanceCalls[0][0].excludeLocations).toEqual(closures);
      for (const [params] of calls.slice(1)) {
        expect(params).toMatchObject({
          dateTime: { type: 0 },
          waypoints: [waypoint],
          computeAlternatives: false,
          costing: travelMode === "drive" ? "auto" : "motorcycle",
        });
        expect(params.excludeLocations?.[0]).toEqual(closures[0]);
        expect(params.excludeLocations).toHaveLength(
          params.distanceWeight ? 1 : 2,
        );
      }
    },
  );

  it.each(["drive", "motorcycle"] as const)(
    "retains a distance-weighted %s candidate even at the closure limit",
    async (travelMode) => {
      const closures = Array.from(
        { length: VALHALLA_MAX_EXCLUDE_LOCATIONS },
        (_, i) => ({
          lat: 25.1 + i / 1000,
          lng: 121.6,
        }),
      );
      const shorter = {
        ...normalizedTrip,
        summary: { lengthKm: 1, timeSec: 140 },
        legs: [
          {
            ...normalizedTrip.legs[0],
            shapePolyline6: encode([points[0], [25.045, 121.56], points[2]], 6),
          },
        ],
      };
      compute.mockImplementation(async (params) => {
        if (params.costing === "pedestrian")
          return { status: "NO_ROUTE", trips: [] };
        return {
          status: "OK",
          trips: [params.distanceWeight ? shorter : normalizedTrip],
        };
      });
      const routes = await planValhallaRoute(
        { lat: 25.041, lng: 121.567 },
        { lat: 25.034, lng: 121.564 },
        { travelMode, excludeLocations: closures },
      );
      expect(routes).toHaveLength(2);
      const calls = compute.mock.calls.filter(
        ([params]) => params.costing !== "pedestrian",
      );
      expect(calls).toHaveLength(2);
      expect(calls[1][0]).toMatchObject({
        distanceWeight: 0.7,
        excludeLocations: closures,
        dateTime: { type: 0 },
      });
    },
  );

  it("keeps the primary route when the distance-weighted request throws", async () => {
    compute.mockImplementation(async (params) => {
      if (params.costing === "pedestrian")
        return { status: "NO_ROUTE", trips: [] };
      if (params.distanceWeight) throw new Error("distance query failed");
      if (params.excludeLocations?.length)
        return { status: "NO_ROUTE", trips: [] };
      return { status: "OK", trips: [normalizedTrip] };
    });
    const routes = await planValhallaRoute(
      { lat: 25.041, lng: 121.567 },
      { lat: 25.034, lng: 121.564 },
      { travelMode: "drive" },
    );
    expect(routes).toHaveLength(1);
  });

  it("rejects an excessively long alternative", async () => {
    let calls = 0;
    const excessiveTrip = {
      ...normalizedTrip,
      summary: { ...normalizedTrip.summary, lengthKm: 4 },
      legs: [
        {
          ...normalizedTrip.legs[0],
          shapePolyline6: encode([points[0], [25.05, 121.55], points[2]], 6),
        },
      ],
    };
    compute.mockImplementation(async (params) => {
      if (params.costing === "pedestrian")
        return { status: "NO_ROUTE", trips: [] };
      calls++;
      return {
        status: "OK",
        trips: [calls === 1 ? normalizedTrip : excessiveTrip],
      };
    });
    const routes = await planValhallaRoute(
      { lat: 25.041, lng: 121.567 },
      { lat: 25.034, lng: 121.564 },
      { travelMode: "drive" },
    );
    expect(calls).toBeGreaterThan(1);
    expect(routes).toHaveLength(1);
  });

  it("keeps the original route when optional searches fail or repeat it", async () => {
    let calls = 0;
    compute.mockImplementation(async (params) => {
      if (params.costing === "pedestrian")
        return { status: "NO_ROUTE", trips: [] };
      calls++;
      if (calls === 1 || calls === 2)
        return { status: "OK", trips: [normalizedTrip] };
      return { status: "UPSTREAM_ERROR", trips: [] };
    });
    const routes = await planValhallaRoute(
      { lat: 25.041, lng: 121.567 },
      { lat: 25.034, lng: 121.564 },
      { travelMode: "drive" },
    );
    expect(calls).toBeGreaterThan(1);
    expect(routes).toHaveLength(1);
  });
});
