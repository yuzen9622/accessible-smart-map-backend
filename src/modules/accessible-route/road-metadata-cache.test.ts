import { beforeEach, describe, expect, it, vi } from "vitest";
const { values, evalRedis } = vi.hoisted(() => ({
  values: new Map<string, string>(),
  evalRedis: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisReady: async () => undefined,
  redisGet: async (key: string) => values.get(key) ?? null,
  redisClient: {
    status: "ready",
    get: async (key: string) => values.get(key) ?? null,
    eval: evalRedis,
  },
}));
vi.mock("./bus-plan.repository", () => ({ storeBusPlan: vi.fn() }));
import {
  attachRouteTokens,
  getNavigationEnvelopeByToken,
  getRouteByToken,
} from "./route-token.service";
import {
  finalizeReroute,
  readNavigationVersion,
  storeInitialNavigationEnvelope,
} from "./navigation-state.repository";
import {
  attachRoadMatchingData,
  geometrySha256,
  getRoadMatchingData,
} from "../../utils/road-matching-data";
import type { AccessibleRoute, DriveLeg } from "../../types/route";
import type {
  NavigationRouteEnvelope,
  RerouteData,
} from "./accessible-route.types";
const canonicalRequest: NavigationRouteEnvelope["canonicalRequest"] = {
  origin: { latitude: 25, longitude: 121 },
  destination: { latitude: 25, longitude: 121.001 },
  userLocation: { latitude: 25, longitude: 121 },
  travelMode: "drive",
  mode: "normal",
  maxTransfers: 2,
  format: "standard",
  waypoints: [],
  avoidStairs: false,
  requireElevator: false,
  needsAccessibleToilet: false,
  needsHandrail: false,
};
function planned(edge = "123"): AccessibleRoute {
  const leg: DriveLeg = {
    type: "DRIVE",
    from: { lat: 25, lng: 121 },
    to: { lat: 25, lng: 121.001 },
    distanceM: 100,
    durationMin: 1,
    polyline: [
      [121, 25],
      [121.001, 25],
    ],
    speedLimits: {
      status: "available",
      direction: "along_leg",
      segments: [
        {
          fromIndex: 0,
          toIndex: 1,
          kind: "known",
          limitKph: 60,
          source: "valhalla",
        },
      ],
    },
  };
  const route: AccessibleRoute = {
    routeId: "road",
    routeName: "road",
    totalMinutes: 1,
    transferCount: 0,
    legs: [leg],
    accessibilityHighlights: [],
    roadNetwork: {
      tilesetId: "tiles",
      sourcePbfSha256: null,
      provenance: "unverified",
    },
  };
  attachRoadMatchingData(route, {
    tilesetId: "tiles",
    legs: [
      {
        legIndex: 0,
        geometrySha256: geometrySha256(leg.polyline),
        spans: [
          {
            fromIndex: 0,
            toIndex: 1,
            directedEdgeId: edge,
            osmWayId: "456",
            osmForward: true,
          },
        ],
      },
    ],
  });
  return route;
}
describe("real token/repository metadata serialization with Redis seam", () => {
  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
    evalRedis.mockImplementation(
      async (_script, keyCount, ...args: string[]) => {
        if (keyCount === 2) {
          values.set(args[0], args[2]);
          values.set(args[1], "1");
          return 1;
        }
        if (keyCount === 6) {
          if (values.get(args[1]) !== args[7]) return ["stale", ""];
          values.set(args[2], args[8]);
          values.set(args[1], args[10]);
          return ["ok", ""];
        }
        throw new Error("unexpected Redis seam");
      },
    );
  });
  it("round-trips metadata in v1 envelope without exposing private spans in route reads/JSON", async () => {
    const [route] = await attachRouteTokens([planned()], canonicalRequest);
    expect(getRoadMatchingData(route)?.legs[0].spans[0].directedEdgeId).toBe(
      "123",
    );
    const envelope = await getNavigationEnvelopeByToken(route.routeToken!);
    expect(envelope?.schemaVersion).toBe(1);
    expect(envelope?.roadMatching?.legs[0].spans[0].directedEdgeId).toBe("123");
    const publicRoute = await getRouteByToken(route.routeToken!);
    expect(publicRoute?.legs[0]).toMatchObject({
      speedLimits: { status: "available" },
    });
    expect(JSON.stringify(publicRoute)).not.toMatch(
      /directedEdgeId|roadMatching|osmWayId/,
    );
    expect(getRoadMatchingData(publicRoute!)).toBeUndefined();
    expect(JSON.stringify(route)).not.toContain("directedEdgeId");
    expect(evalRedis.mock.calls[0].at(-1)).toBe("1800");
  });
  it.each(["geometry", "legIndex"])(
    "rejects stale %s private data before initial and CAS storage",
    async (kind) => {
      const route = planned();
      const roadMatching = getRoadMatchingData(route)!;
      if (kind === "geometry") route.legs[0].polyline[1][0] += 0.01;
      else roadMatching.legs[0].legIndex = 1;
      const envelope: NavigationRouteEnvelope = {
        schemaVersion: 1,
        route,
        roadMatching,
        navigationId: "nav",
        routeVersion: 1,
        canonicalRequest,
      };
      await storeInitialNavigationEnvelope("first", envelope);
      expect(
        JSON.parse(values.get("voice-nav:route:first")!),
      ).not.toHaveProperty("roadMatching");
      const result = await finalizeReroute(
        1,
        "request",
        "second",
        { ...envelope, routeVersion: 2 },
        {} as RerouteData,
      );
      expect(result).toBe("ok");
      expect(
        JSON.parse(values.get("voice-nav:route:second")!),
      ).not.toHaveProperty("roadMatching");
    },
  );
  it("CAS keeps newly planned data, advances head and rejects an older replacement", async () => {
    const [first] = await attachRouteTokens([planned("123")], canonicalRequest);
    const old = (await getNavigationEnvelopeByToken(first.routeToken!))!;
    const route = planned("789");
    const next = {
      ...old,
      route,
      roadMatching: getRoadMatchingData(route),
      routeVersion: 2,
    };
    expect(
      await finalizeReroute(1, "new", "new-token", next, {} as RerouteData),
    ).toBe("ok");
    expect(await readNavigationVersion(old.navigationId)).toBe(2);
    expect(
      (await getNavigationEnvelopeByToken("new-token"))?.roadMatching?.legs[0]
        .spans[0].directedEdgeId,
    ).toBe("789");
    expect(
      await finalizeReroute(1, "stale", "stale-token", old, {} as RerouteData),
    ).toBe("stale");
    expect(values.has("voice-nav:route:stale-token")).toBe(false);
  });
  it("old envelopes remain usable without matching data", async () => {
    const route = planned();
    const envelope = {
      schemaVersion: 1,
      route,
      navigationId: "old",
      routeVersion: 1,
      canonicalRequest,
    };
    values.set("voice-nav:route:old", JSON.stringify(envelope));
    expect(await getRouteByToken("old")).toMatchObject({ routeId: "road" });
    expect(await getNavigationEnvelopeByToken("old")).not.toHaveProperty(
      "roadMatching",
    );
  });
});
