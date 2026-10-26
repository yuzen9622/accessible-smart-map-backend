import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// This integration fixture exercises the real CSR stairs search.
vi.mock("../../config/otp-walk", () => ({
  getReviewedOtpWalkPolicies: () => [],
}));
vi.mock("../../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn(async () => []),
}));
vi.mock("../../config/fetch", () => ({
  tdxFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: vi.fn().mockResolvedValue({}),
}));

vi.mock("./planners/route-a11y", () => ({
  nearbyA11y: vi.fn().mockResolvedValue([]),
  attachA11yToLeg: vi.fn(),
  deriveHighlights: vi.fn(),
  enrichLegIndoor: vi.fn(),
  buildAccessibilitySummary: vi.fn().mockReturnValue(""),
}));

vi.mock("./planners/otp-routing", async (importActual) => {
  const actual = await importActual<typeof import("./planners/otp-routing")>();
  return {
    ...actual,
    planOtpRoute: vi.fn(),
    planOtpRouteDetailed: vi.fn(),
    planOtpWalkDetailed: vi.fn(),
    isOtpCircuitOpen: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../a11y/a11y.service", async (importActual) => {
  const actual = await importActual<typeof import("../a11y/a11y.service")>();
  return {
    ...actual,
    findNearbyParking: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../a11y/a11y.orchestration", async (importActual) => {
  const actual =
    await importActual<typeof import("../a11y/a11y.orchestration")>();
  return {
    ...actual,
    findNearby: vi.fn().mockResolvedValue({ nearbyOsm: [] }),
  };
});

vi.mock("../../model/bus-stop.model", () => ({
  default: {
    findOne: () => ({
      select: () => ({ lean: () => Promise.resolve({ city: "Taipei" }) }),
    }),
  },
}));

vi.mock("../../adapters/nlsc.adapter", () => ({
  getNlscAdministrativeArea: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../adapters/google.adapter", async (importActual) => {
  const actual =
    await importActual<typeof import("../../adapters/google.adapter")>();
  return { ...actual, getCity: vi.fn(), getCoordinates: vi.fn() };
});

vi.mock("./route-token.service", async (importActual) => {
  const actual = await importActual<typeof import("./route-token.service")>();
  return {
    ...actual,
    attachRouteTokens: vi.fn(async (routes) => routes),
  };
});

vi.mock("../hazard-report/hazard-report.service", () => ({
  findConfirmedHazardsWithin: vi.fn(),
}));

vi.mock("./planners/pedestrian-a11y/graph-runtime", () => ({
  getPedGraphRuntime: vi.fn(async () => ({
    status: "ready",
    snapshot: {
      graph: stairsGraph,
      index: buildEdgeIndex(stairsGraph),
      loadedAtMs: 0,
    },
  })),
  getPedGraphClient: vi.fn(async () => ({
    query: async (sql: string) => ({
      rows: sql.includes("WITH p AS")
        ? ["origin", "destination"].map((side, index) => ({
            side,
            edge_id: "1000",
            from_node: "0",
            to_node: "1",
            node_id: String(index),
            plane: JSON.stringify(["0", "0", "no", "no"]),
            geojson: JSON.stringify({
              type: "LineString",
              coordinates: [stairsLine[index], stairsLine[index]],
            }),
            distance_m: 0,
            fraction: 0,
          }))
        : [
            {
              edge_id: "1000",
              geojson: JSON.stringify({
                type: "LineString",
                coordinates: stairsLine,
              }),
            },
          ],
    }),
  })),
}));
import { buildEdgeIndex } from "./planners/pedestrian-a11y/spatial-index";
import {
  EDGE_TYPE,
  NODE_FLAG,
  WHEELCHAIR,
  type PedGraph,
} from "./planners/pedestrian-a11y/graph.types";
const stairsLine = [
  [121.56, 25.04],
  [121.55, 25.03],
];
const stairsGraph: PedGraph = {
  qualification: {
    version: "sidewalk-v1",
    schemaVersion: 1,
    sourceVersionId: "1",
    sourceArchiveSha256: "a".repeat(64),
    osmSha256: "b".repeat(64),
    extent: [118, 21, 123, 27],
  },
  versionId: 7,
  nodeCount: 2,
  directedEdgeCount: 1,
  undirectedEdgeCount: 1,
  nodeLon: Float64Array.from([121.56, 121.55]),
  nodeLat: Float64Array.from([25.04, 25.03]),
  nodeFlags: Uint8Array.from([
    NODE_FLAG.HAS_REAL_GEOM,
    NODE_FLAG.HAS_REAL_GEOM,
  ]),
  nodeStationId: Int32Array.from([-1, -1]),
  stationIds: [],
  stationRadiusM: new Float32Array(),
  originalNodeId: BigInt64Array.from([0n, 1n]),
  adjOffset: Int32Array.from([0, 1, 1]),
  adjTarget: Int32Array.from([1]),
  adjAttr: Int32Array.from([0]),
  edgeOriginalId: BigInt64Array.from([1000n]),
  edgeLengthM: Float32Array.from([1500]),
  edgeType: Uint8Array.from([EDGE_TYPE.STEPS]),
  edgeSlope: Float32Array.from([0.6]),
  edgeSurface: new Uint8Array(1),
  edgeSmoothness: new Uint8Array(1),
  edgeWidthM: Float32Array.from([1.5]),
  edgeWheelchair: Uint8Array.from([WHEELCHAIR.NO]),
  edgeStairCount: Uint16Array.from([60]),
  edgeTraversalTimeS: Float32Array.from([1200]),
  edgeFlags: new Uint8Array(1),
  edgeSidewalkId: Int32Array.from([-1]),
  sidewalkIds: [],
  edgeSidewalkRampCount: new Uint16Array(1),
  edgeStreetName: Int32Array.from([-1]),
  streetNames: [],
  edgeRampPoints: new Map(),
};

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { planOtpWalkDetailed } from "./planners/otp-routing";
import { findConfirmedHazardsWithin } from "../hazard-report/hazard-report.service";

const app = buildTestApp();
const URL = "/api/v1/a11y/accessible-route";
const otpWalk = vi.mocked(planOtpWalkDetailed);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findConfirmedHazardsWithin).mockResolvedValue([]);
  otpWalk.mockResolvedValue({
    status: "ok",
    routes: [
      {
        routeId: "walk-stairs",
        routeName: "步行",
        totalMinutes: 7,
        transferCount: 0,
        totalWalkDistanceM: 420,
        degraded: true,
        warnings: ["目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件"],
        accessibilityHighlights: [],
        legs: [
          {
            type: "WALK",
            from: "出發地",
            to: "目的地",
            distanceM: 420,
            minutesEst: 7,
            polyline: [
              [121.56, 25.04],
              [121.55, 25.03],
            ],
            a11yFacilities: [],
            maxSlopePercent: null,
            crossings: null,
            crossingsWithCurbRamp: null,
            minPathWidthCm: null,
            surfaceType: "unknown",
            restPoints: [],
            steps: [
              {
                relativeDirection: "CONTINUE",
                absoluteDirection: "NORTH",
                streetName: "圓山市景步道",
                bogusName: false,
                area: false,
                stairs: true,
                steepSlope: false,
                distanceM: 420,
                location: [121.56, 25.04],
              },
            ],
          },
        ],
      },
    ],
  });
});

describe("POST /api/v1/a11y/accessible-route stairs degradation", () => {
  it("carries wheelchair avoidStairs through real CSR search and exposes the stairs warning", async () => {
    const response = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25.04, longitude: 121.56 },
        destination: { latitude: 25.03, longitude: 121.55 },
        travelMode: "walk",
        mode: "wheelchair",
        avoidStairs: true,
      });

    expect(response.status).toBe(200);
    expect(otpWalk).not.toHaveBeenCalled();
    expect(response.body.data.routes[0]).toMatchObject({
      walkingPolicy: {
        graphVersionId: 7,
        stairsFallback: true,
        selectedEdgeIds: ["1000"],
      },
      warningDetails: expect.arrayContaining([
        expect.objectContaining({ code: "ROUTE_WHEELCHAIR_STAIRS_FALLBACK" }),
      ]),
    });
    expect(response.body.data.routes[0].legs[0].steps[0].stairs).toBe(true);
  });

  it("publishes degraded and stairs in the generated OpenAPI schemas", async () => {
    const response = await request(app).get("/api/v1/openapi.json");

    expect(response.status).toBe(200);
    expect(
      response.body.components.schemas.AccessibleRoute.properties.degraded,
    ).toMatchObject({ type: "boolean" });
    expect(
      response.body.components.schemas.WalkStep.properties.stairs,
    ).toMatchObject({ type: "boolean" });
  });
});
