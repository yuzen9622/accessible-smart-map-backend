import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import airport from "./__fixtures__/road-navigation/airport-native.json";
import jiachang from "./__fixtures__/road-navigation/jiachang-native.json";
import { computeValhallaRoutes } from "./valhalla.adapter";

vi.mock("axios", () => ({ default: { post: vi.fn(), isAxiosError: vi.fn() } }));
const post = vi.mocked(axios.post);
const params = {
  origin: { lat: 25.007901, lng: 121.281634 },
  destination: { lat: 25.0171293, lng: 121.2764722 },
  costing: "auto" as const,
};

describe("frozen backend road metadata acceptance", () => {
  beforeEach(() => vi.resetAllMocks());

  it("A02 preserves the real airport sign and approach bearings", async () => {
    post.mockResolvedValue({ data: airport });
    const result = await computeValhallaRoutes(params);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("Expected base road route");
    expect(result.trips[0].legs[0].maneuvers?.[1]).toMatchObject({
      beginShapeIndex: 7,
      bearingBefore: 322,
      bearingAfter: 330,
      signs: {
        exitNumbers: ["8"],
        branches: ["1"],
        destinations: ["台北（北）", "中壢（南）"],
        exitNames: ["機場系統交流道"],
      },
    });
  });

  it("A03 preserves real lane order and right preferred direction", async () => {
    post.mockResolvedValue({ data: jiachang });
    const result = await computeValhallaRoutes(params);
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("Expected base road route");
    expect(result.trips[0].legs[0].maneuvers?.[1]).toMatchObject({
      beginShapeIndex: 8,
      lanes: [
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
      ],
    });
  });

  it.each(["auto", "motorcycle"] as const)(
    "requests lanes for %s without changing route costing",
    async (costing) => {
      post.mockResolvedValue({ data: airport });
      await computeValhallaRoutes({ ...params, costing });
      expect(post.mock.calls[0][1]).toMatchObject({
        costing,
        turn_lanes: true,
      });
    },
  );
});
