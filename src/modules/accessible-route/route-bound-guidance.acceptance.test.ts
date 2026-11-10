import axios from "axios";
import request from "supertest";
import { encode } from "@googlemaps/polyline-codec";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { planValhallaRoute } from "./planners/valhalla-routing";
import { getRoadMatchingData } from "../../utils/road-matching-data";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";

const cache = vi.hoisted(() => ({ raw: "" }));
vi.mock("axios", async (original) => {
  const actual = await original<{ default: typeof axios }>();
  return { ...actual, default: { ...actual.default, post: vi.fn() } };
});
vi.mock("../../config/redis", async (original) => ({
  ...(await original<typeof import("../../config/redis")>()),
  redisGet: vi.fn(async () => cache.raw),
}));
vi.mock("../../adapters/valhalla-release.adapter", () => ({
  readValhallaReleaseIdentity: vi.fn(() => "route-bound-instance"),
  getValhallaReleaseSnapshot: vi.fn(async () => ({
    identity: "route-bound-instance",
    roadNetwork: {
      tilesetId: "route-bound-release",
      sourcePbfSha256: null,
      provenance: "unverified",
    },
  })),
  isValhallaReleaseCurrent: vi.fn(async () => true),
}));

const shape = encode(
  [
    [25, 121],
    [25.0001, 121],
    [25.0002, 121],
    [25.0002, 121.0001],
    [25.0002, 121.0002],
  ],
  6,
);
const fourLanes = [
  { directions: 2 },
  { directions: 2 },
  { directions: 64, valid: 64 },
  { directions: 64, active: 64 },
];
const expectedLanes = [
  {
    directions: ["straight"],
    recommendation: "not_recommended",
    maneuverDirection: null,
  },
  {
    directions: ["straight"],
    recommendation: "not_recommended",
    maneuverDirection: null,
  },
  {
    directions: ["right"],
    recommendation: "usable",
    maneuverDirection: "right",
  },
  {
    directions: ["right"],
    recommendation: "preferred",
    maneuverDirection: "right",
  },
];

// Synthetic native response: an explicit four-lane contract, not a captured road.
function nativeRoute(lanes: unknown = fourLanes) {
  return {
    trip: {
      status: 0,
      units: "kilometers",
      summary: { length: 0.04, time: 8 },
      legs: [
        {
          shape,
          summary: { length: 0.04, time: 8 },
          maneuvers: [
            {
              type: 1,
              begin_shape_index: 0,
              end_shape_index: 2,
              length: 0.02,
              time: 4,
            },
            {
              type: 10,
              begin_shape_index: 2,
              end_shape_index: 4,
              length: 0.02,
              time: 4,
              instruction: "Turn right.",
              lanes,
            },
            {
              type: 4,
              begin_shape_index: 4,
              end_shape_index: 4,
              length: 0,
              time: 0,
            },
          ],
        },
      ],
    },
  };
}
function nativeTrace(values = [40, 0, 50, 0]) {
  return {
    shape,
    shape_attributes: { speed_limit: values },
    edges: [
      {
        id: 101,
        way_id: 201,
        forward: true,
        begin_shape_index: 0,
        end_shape_index: 2,
      },
      {
        id: 102,
        way_id: 202,
        forward: true,
        begin_shape_index: 2,
        end_shape_index: 4,
      },
    ],
  };
}

let app: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(app);
});
beforeEach(() => {
  vi.clearAllMocks();
  cache.raw = "";
});

async function planAndRead(
  mode: "drive" | "motorcycle" = "drive",
  raw = nativeRoute(),
  trace = nativeTrace(),
) {
  vi.mocked(axios.post).mockImplementation(async (url) => {
    if (String(url).endsWith("/route")) return { data: raw };
    if (String(url).endsWith("/trace_attributes")) return { data: trace };
    throw new Error(`Unexpected external request: ${url}`);
  });
  const routes = await planValhallaRoute(
    { lat: 25, lng: 121 },
    { lat: 25.0002, lng: 121.0002 },
    { travelMode: mode },
  );
  expect(routes).toHaveLength(1);
  const route = routes[0];
  expect(getRoadMatchingData(route)).toBeUndefined();
  cache.raw = JSON.stringify(route);
  const result = await request(app)
    .post("/api/v1/a11y/route/instructions")
    .send({ routeToken: "route-bound-guidance" });
  expect(result.status).toBe(200);
  const instructions = result.body.data.instructions;
  const turn = instructions.find(
    (item: { roadGuidance?: { maneuverIndex: number } }) =>
      item.roadGuidance?.maneuverIndex === 1,
  );
  expect(turn).toBeDefined();
  expect(JSON.stringify(result.body)).not.toMatch(
    /directedEdgeId|roadMatching|osmWayId/,
  );
  const traceCalls = vi
    .mocked(axios.post)
    .mock.calls.filter(([url]) => String(url).endsWith("/trace_attributes"));
  expect(traceCalls).toHaveLength(1);
  expect(traceCalls[0][1]).toMatchObject({
    shape_match: "edge_walk",
    encoded_polyline: shape,
  });
  return { route, turn, instructions };
}

describe("route-bound lane and speed guidance without GPS road matching", () => {
  it.each(["drive", "motorcycle"] as const)(
    "%s keeps both right-turn choices through real transforms and navigation HTTP",
    async (mode) => {
      const { route, turn, instructions } = await planAndRead(mode);
      expect(turn.polylineIndex).toBe(2);
      expect(turn.maneuver).toBeNull();
      expect(turn.roadGuidance).toMatchObject({
        maneuverIndex: 1,
        maneuver: "TURN_RIGHT",
        endPolylineIndex: 4,
        lanes: expectedLanes,
        laneApproachRange: { fromIndex: 0, toIndex: 2 },
      });
      expect(turn.roadGuidance.lanes).toHaveLength(4);
      expect(
        instructions.filter(
          (item: { roadGuidance?: { lanes?: unknown[] } }) =>
            item.roadGuidance?.lanes,
        ),
      ).toHaveLength(1);
      expect(route.legs[0]).toMatchObject({
        speedLimits: {
          status: "available",
          direction: "along_leg",
          segments: [
            {
              fromIndex: 0,
              toIndex: 1,
              kind: "known",
              limitKph: 40,
              source: "valhalla",
            },
            {
              fromIndex: 1,
              toIndex: 2,
              kind: "unknown",
              limitKph: null,
              source: null,
            },
            {
              fromIndex: 2,
              toIndex: 3,
              kind: "known",
              limitKph: 50,
              source: "valhalla",
            },
            {
              fromIndex: 3,
              toIndex: 4,
              kind: "unknown",
              limitKph: null,
              source: null,
            },
          ],
        },
      });
      expect(JSON.parse(cache.raw).legs[0].speedLimits).toEqual(
        (route.legs[0] as { speedLimits?: unknown }).speedLimits,
      );
    },
  );

  it("keeps unlimited separate from unknown without requiring GPS or private spans", async () => {
    const { route } = await planAndRead(
      "drive",
      nativeRoute(),
      nativeTrace([40, 255, 0, 60]),
    );
    expect(route.legs[0]).toMatchObject({
      speedLimits: {
        status: "available",
        segments: [
          { fromIndex: 0, toIndex: 1, kind: "known", limitKph: 40 },
          { fromIndex: 1, toIndex: 2, kind: "unlimited", limitKph: null },
          { fromIndex: 2, toIndex: 3, kind: "unknown", limitKph: null },
          { fromIndex: 3, toIndex: 4, kind: "known", limitKph: 60 },
        ],
      },
    });
  });

  it.each([
    { name: "missing lanes", lanes: null },
    {
      name: "invalid right-lane direction",
      lanes: [...fourLanes.slice(0, 3), { directions: 2, active: 64 }],
    },
  ])("does not invent guidance for $name", async ({ lanes }) => {
    const { turn } = await planAndRead("drive", nativeRoute(lanes));
    expect(turn.roadGuidance.maneuver).toBe("TURN_RIGHT");
    expect(turn.roadGuidance.lanes).toBeUndefined();
    expect(turn.roadGuidance.laneApproachRange).toBeUndefined();
    expect(turn.text).toBeTruthy();
  });

  it("keeps the lane range on the approach to the turn without relying on trace edges", async () => {
    const trace = nativeTrace();
    trace.edges = [
      {
        id: 101,
        way_id: 201,
        forward: true,
        begin_shape_index: 0,
        end_shape_index: 4,
      },
    ];
    const { turn } = await planAndRead("drive", nativeRoute(), trace);
    expect(turn.roadGuidance.lanes).toEqual(expectedLanes);
    expect(turn.roadGuidance.laneApproachRange).toEqual({
      fromIndex: 0,
      toIndex: 2,
    });
  });
});
