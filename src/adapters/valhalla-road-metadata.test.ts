import axios from "axios";
import { encode } from "@googlemaps/polyline-codec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import airport from "./__fixtures__/road-navigation/airport-native.json";
import {
  computeValhallaRoutes,
  computeValhallaTraceAttributes,
} from "./valhalla.adapter";
vi.mock("axios", () => ({
  default: { post: vi.fn(), isAxiosError: vi.fn(() => false) },
}));
const post = vi.mocked(axios.post);
const params = {
  origin: { lat: 25, lng: 121 },
  destination: { lat: 25.01, lng: 121.01 },
  costing: "auto" as const,
};
const shape = encode(
  [
    [25, 121],
    [25.001, 121],
    [25.002, 121],
  ],
  6,
);
const trace = () => ({
  shape,
  shape_attributes: { speed_limit: [100, 60] },
  edges: [
    {
      id: 123,
      way_id: 456,
      forward: true,
      begin_shape_index: 0,
      end_shape_index: 2,
    },
  ],
});
beforeEach(() => vi.clearAllMocks());
describe("road metadata boundaries", () => {
  it("uses all pinned 3.9.1 lane bits and numeric active/valid", async () => {
    const data = structuredClone(airport);
    Object.assign(data.trip.legs[0].maneuvers[1], {
      lanes: Array.from({ length: 11 }, (_, i) => ({ directions: 2 ** i })),
      bearing_before: 0,
      bearing_after: 359.5,
    });
    post.mockResolvedValue({ data });
    const result = await computeValhallaRoutes(params);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw Error("base route missing");
    expect(
      result.trips[0].legs[0].maneuvers?.[1].lanes?.map((l) => l.directions[0]),
    ).toEqual([
      "none",
      "straight",
      "sharp_left",
      "left",
      "slight_left",
      "slight_right",
      "right",
      "sharp_right",
      "uturn",
      "merge_left",
      "merge_right",
    ]);
  });
  it.each([
    { lanes: [{ directions: 2048 }] },
    { lanes: [{ directions: 16 }, { directions: "32" }] },
    { lanes: [{ directions: 16, active: 32 }] },
    { lanes: [{ directions: 48, active: 48 }] },
    { lanes: [{ directions: 32, active: true }] },
  ])(
    "drops whole malformed lane group without erasing route %j",
    async ({ lanes }) => {
      const data = structuredClone(airport);
      Object.assign(data.trip.legs[0].maneuvers[1], {
        lanes,
        bearing_before: -1,
        bearing_after: 360,
        begin_street_names: [1],
        sign: { exit_number_elements: [{ text: 8 }] },
      });
      post.mockResolvedValue({ data });
      const result = await computeValhallaRoutes(params);
      expect(result.status).toBe("OK");
      if (result.status !== "OK") throw Error("base route missing");
      expect(result.trips[0].legs[0].maneuvers?.[1]).not.toHaveProperty(
        "lanes",
      );
      expect(result.trips[0].legs[0].maneuvers?.[1]).not.toHaveProperty(
        "signs",
      );
      expect(result.trips[0].legs[0].maneuvers?.[1]).not.toHaveProperty(
        "bearingBefore",
      );
      expect(result.trips[0].legs[0].maneuvers?.[1]).not.toHaveProperty(
        "bearingAfter",
      );
    },
  );
  it("does not request lanes for pedestrian", async () => {
    post.mockResolvedValue({ data: airport });
    await computeValhallaRoutes({ ...params, costing: "pedestrian" });
    expect(post.mock.calls[0][1]).not.toHaveProperty("turn_lanes");
  });
  it("edge_walk preserves exact geometry, N−1 speed sentinels, safe string ids", async () => {
    const data = trace();
    data.shape_attributes.speed_limit = [0, 255];
    post.mockResolvedValue({ data });
    expect(
      await computeValhallaTraceAttributes({
        shapePolyline6: shape,
        costing: "motorcycle",
      }),
    ).toMatchObject({
      status: "OK",
      speedLimitValues: [0, 255],
      spans: [{ directedEdgeId: "123", osmWayId: "456", edgeForward: true }],
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      shape_match: "edge_walk",
      encoded_polyline: shape,
      costing: "motorcycle",
    });
    expect(JSON.stringify(post.mock.calls[0][1])).not.toContain("map_snap");
  });
  it.each([
    "count",
    "unsafeId",
    "gap",
    "overlap",
    "direction",
    "speed",
    "missingEdges",
  ])("rejects bad trace %s", async (kind) => {
    const data: any = trace();
    if (kind === "count") data.shape_attributes.speed_limit = [50];
    if (kind === "unsafeId") data.edges[0].id = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "gap") data.edges[0].begin_shape_index = 1;
    if (kind === "overlap") data.edges.push({ ...data.edges[0] });
    if (kind === "direction") data.edges[0].forward = undefined;
    if (kind === "speed") data.shape_attributes.speed_limit = [NaN, 256];
    if (kind === "missingEdges") data.edges = [];
    post.mockResolvedValue({ data });
    expect(
      (
        await computeValhallaTraceAttributes({
          shapePolyline6: shape,
          costing: "auto",
        })
      ).status,
    ).toBe("INVALID_RESPONSE");
  });
  it("rejects nearby but nonidentical geometry", async () => {
    post.mockResolvedValue({
      data: {
        ...trace(),
        shape: encode(
          [
            [25, 121],
            [25.001001, 121],
            [25.002, 121],
          ],
          6,
        ),
      },
    });
    expect(
      (
        await computeValhallaTraceAttributes({
          shapePolyline6: shape,
          costing: "auto",
        })
      ).status,
    ).toBe("NO_MATCH");
  });
  it("downgrades network failure", async () => {
    post.mockRejectedValue(new Error("timeout"));
    expect(
      (
        await computeValhallaTraceAttributes({
          shapePolyline6: shape,
          costing: "auto",
          timeoutMs: 1,
        })
      ).status,
    ).toBe("UPSTREAM_ERROR");
  });
});
