import axios from "axios";
import request from "supertest";
import { decode } from "@googlemaps/polyline-codec";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import airport from "../../adapters/__fixtures__/road-navigation/airport-native.json";
import jiachang from "../../adapters/__fixtures__/road-navigation/jiachang-native.json";
import { planValhallaRoute } from "./planners/valhalla-routing";
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
  readValhallaReleaseIdentity: vi.fn(() => null),
  getValhallaReleaseSnapshot: vi.fn(async () => null),
  isValhallaReleaseCurrent: vi.fn(async () => false),
}));
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

describe("captured engine → actual adapter/planner → cache JSON → real navigation HTTP", () => {
  it.each(["airport", "jiachang"] as const)(
    "preserves %s structural guidance without pretending legacy tiles are verified",
    async (name) => {
      const raw = name === "airport" ? airport : jiachang;
      vi.mocked(axios.post).mockResolvedValue({ data: raw });
      const points = decode(raw.trip.legs[0].shape, 6);
      const [lat, lng] = points[0],
        last = points[points.length - 1];
      const routes = await planValhallaRoute(
        { lat, lng },
        { lat: last[0], lng: last[1] },
        { travelMode: "drive" },
      );
      expect(routes).toHaveLength(1);
      cache.raw = JSON.stringify(routes[0]);
      const result = await request(app)
        .post("/api/v1/a11y/route/instructions")
        .send({ routeToken: "captured-route" });
      expect(result.status).toBe(200);
      const step = result.body.data.instructions.find(
        (item: { roadGuidance?: { maneuverIndex: number } }) =>
          item.roadGuidance?.maneuverIndex === 1,
      );
      expect(step).toBeDefined();
      expect(step.maneuver).toBeNull();
      if (name === "airport") {
        expect(step.polylineIndex).toBe(7);
        expect(step.roadGuidance).toMatchObject({
          maneuver: "EXIT_RIGHT",
          bearingBefore: 322,
          bearingAfter: 330,
          signs: {
            exitNumbers: ["8"],
            branches: ["1"],
            destinations: ["台北（北）", "中壢（南）"],
          },
        });
        expect(step.text).toContain("出口 8");
        expect(step.text.split("台北（北）")).toHaveLength(2);
      } else {
        expect(step.polylineIndex).toBe(8);
        expect(step.roadGuidance.lanes).toEqual([
          {
            directions: ["slight_left"],
            recommendation: "not_recommended",
            maneuverDirection: null,
          },
          {
            directions: ["slight_right"],
            recommendation: "preferred",
            maneuverDirection: "slight_right",
          },
        ]);
        // The lanes sit on a short final edge; the approach reaches back to
        // the departure (~229 m), within the lane-prep distance.
        expect(step.roadGuidance.laneApproachRange).toEqual({
          fromIndex: 0,
          toIndex: 8,
        });
        expect(step.roadGuidance.laneHint).toBe("靠最右側車道");
        expect(step.text).toContain("，請靠最右側車道");
      }
      expect(JSON.stringify(result.body)).not.toContain("directedEdgeId");
      expect(routes[0].legs[0]).toMatchObject({
        speedLimits: { status: "unavailable" },
      });
    },
  );

  it("publishes optional guidance schemas without advertising a blocked matching endpoint", async () => {
    const result = await request(app).get("/api/v1/openapi.json");
    expect(result.status).toBe(200);
    expect(result.body.paths["/a11y/route/match"]).toBeUndefined();
    const document = JSON.stringify(result.body);
    expect(document).toContain("roadGuidance");
    expect(document).toContain("speedLimits");
  });
});
