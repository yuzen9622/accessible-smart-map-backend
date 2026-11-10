import { encode } from "@googlemaps/polyline-codec";
import { beforeEach, expect, it, vi } from "vitest";
import {
  computeValhallaRoutes,
  computeValhallaTraceAttributes,
} from "../../../adapters/valhalla.adapter";
import {
  getValhallaReleaseSnapshot,
  isValhallaReleaseCurrent,
  readValhallaReleaseIdentity,
} from "../../../adapters/valhalla-release.adapter";
import { planValhallaRoute } from "./valhalla-routing";
import { getRoadMatchingData } from "../../../utils/road-matching-data";
vi.mock("../../../adapters/valhalla.adapter", () => ({
  computeValhallaRoutes: vi.fn(),
  computeValhallaTraceAttributes: vi.fn(),
}));
vi.mock("../../../adapters/valhalla-release.adapter", () => ({
  getValhallaReleaseSnapshot: vi.fn(),
  isValhallaReleaseCurrent: vi.fn(),
  readValhallaReleaseIdentity: vi.fn(),
}));
vi.mock("./otp-routing", () => ({ planOtpWalkDetailed: vi.fn() }));
const compute = vi.mocked(computeValhallaRoutes),
  trace = vi.mocked(computeValhallaTraceAttributes),
  release = vi.mocked(getValhallaReleaseSnapshot),
  fence = vi.mocked(readValhallaReleaseIdentity),
  current = vi.mocked(isValhallaReleaseCurrent);
const points: [number, number][] = [
  [25, 121],
  [25.0001, 121],
  [25.0002, 121],
];
const trip = {
  summary: { lengthKm: 0.02, timeSec: 5 },
  legs: [
    {
      shapePolyline6: encode(points, 6),
      summary: { lengthKm: 0.02, timeSec: 5 },
      maneuvers: [
        {
          type: 4,
          lengthKm: 0,
          timeSec: 0,
          beginShapeIndex: 0,
          endShapeIndex: 0,
          stairs: false,
        },
        {
          type: 20,
          lengthKm: 0.02,
          timeSec: 5,
          beginShapeIndex: 0,
          endShapeIndex: 2,
          stairs: false,
          signs: {
            exitNumbers: ["8"],
            branches: ["1"],
            destinations: ["台北（北）", "中壢（南）"],
            exitNames: ["機場系統交流道"],
          },
        },
      ],
    },
  ],
};
const source = {
  roadNetwork: {
    tilesetId: "release1",
    sourcePbfSha256: null,
    provenance: "unverified" as const,
  },
  identity: "instance1",
};
beforeEach(() => {
  vi.clearAllMocks();
  fence.mockReturnValue(source.identity);
  release.mockResolvedValue(source);
  current.mockResolvedValue(true);
  compute.mockResolvedValue({ status: "OK", trips: [structuredClone(trip)] });
  trace.mockResolvedValue({
    status: "OK",
    shapePolyline6: trip.legs[0].shapePolyline6,
    speedLimitValues: [100, 60],
    spans: [
      {
        fromIndex: 0,
        toIndex: 2,
        directedEdgeId: "123",
        osmWayId: "456",
        edgeForward: false,
      },
    ],
  });
});
it("acquires immutable source before first route, enriches only deduped final candidate, and keeps original maneuver index", async () => {
  const sequence: string[] = [];
  fence.mockImplementation(() => {
    sequence.push("fence");
    return source.identity;
  });
  release.mockImplementation(async () => {
    sequence.push("snapshot");
    return source;
  });
  compute.mockImplementation(async () => {
    sequence.push("route");
    return { status: "OK", trips: [structuredClone(trip)] };
  });
  trace.mockImplementation(async () => {
    sequence.push("trace");
    return {
      status: "OK",
      shapePolyline6: trip.legs[0].shapePolyline6,
      speedLimitValues: [100, 60],
      spans: [
        {
          fromIndex: 0,
          toIndex: 2,
          directedEdgeId: "123",
          osmWayId: "456",
          edgeForward: false,
        },
      ],
    };
  });
  const routes = await planValhallaRoute(
    { lat: 25, lng: 121 },
    { lat: 25.0002, lng: 121 },
    { travelMode: "drive" },
  );
  expect(sequence[0]).toBe("fence");
  expect(fence).toHaveBeenCalledTimes(1);
  expect(sequence.lastIndexOf("route")).toBeLessThan(sequence.indexOf("trace"));
  expect(trace).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(routes).toHaveLength(1);
  const leg = routes[0].legs[0];
  expect(leg.type).toBe("DRIVE");
  if (leg.type !== "DRIVE") throw Error("road missing");
  expect(leg.steps?.[0].maneuverIndex).toBe(1);
  expect(leg.steps?.[0].instruction).toContain("出口 8");
  expect(leg.steps?.[0].instruction).toContain("原始路牌");
  expect(leg.steps?.[0].instruction).toContain("台北（北）、中壢（南）");
  expect(getRoadMatchingData(routes[0])).toBeUndefined();
});
it.each([400, 900])(
  "stalled release status cannot erase a valid base route with %ims caller budget",
  async (budget) => {
    vi.useFakeTimers();
    try {
      release.mockImplementation(async (timeoutMs = 1000) => {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(10_000, timeoutMs)),
        );
        return null;
      });
      const planned = planValhallaRoute(
        { lat: 25, lng: 121 },
        { lat: 25.0002, lng: 121 },
        { travelMode: "drive", deadline: Date.now() + budget },
      );
      expect(compute).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(budget);
      const routes = await planned;
      expect(routes).toHaveLength(1);
      expect(routes[0].legs[0]).toMatchObject({
        type: "DRIVE",
        speedLimits: { status: "unavailable" },
      });
      expect(compute).toHaveBeenCalled();
      expect(trace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);
it("deducts concurrent snapshot duration from the shared metadata remainder", async () => {
  vi.useFakeTimers();
  try {
    release.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return source;
    });
    compute.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: "OK", trips: [structuredClone(trip)] };
    });
    const planned = planValhallaRoute(
      { lat: 25, lng: 121 },
      { lat: 25.0002, lng: 121 },
      { travelMode: "drive", deadline: Date.now() + 5000 },
    );
    await vi.advanceTimersByTimeAsync(600);
    const routes = await planned;
    expect(routes).toHaveLength(1);
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 900 }),
    );
  } finally {
    vi.useRealTimers();
  }
});
it("snapshot rejection cannot erase an already valid basic route", async () => {
  release.mockRejectedValue(new Error("status failure"));
  const routes = await planValhallaRoute(
    { lat: 25, lng: 121 },
    { lat: 25.0002, lng: 121 },
    { travelMode: "drive" },
  );
  expect(routes).toHaveLength(1);
  expect(trace).not.toHaveBeenCalled();
  expect(routes[0].legs[0]).toMatchObject({
    speedLimits: { status: "unavailable", reason: "tileset_changed" },
  });
});
it("does not capture a new full release after the initial identity fence", async () => {
  release.mockResolvedValue({ ...source, identity: "replacement-instance" });
  const routes = await planValhallaRoute(
    { lat: 25, lng: 121 },
    { lat: 25.0002, lng: 121 },
    { travelMode: "drive" },
  );
  expect(routes).toHaveLength(1);
  expect(trace).not.toHaveBeenCalled();
  expect(routes[0].legs[0]).toMatchObject({
    speedLimits: { status: "unavailable", reason: "tileset_changed" },
  });
  expect(routes[0].roadNetwork).toBeUndefined();
});
it("missing initial fence skips expensive snapshot loading without blocking routing", async () => {
  fence.mockReturnValue(null);
  const routes = await planValhallaRoute(
    { lat: 25, lng: 121 },
    { lat: 25.0002, lng: 121 },
    { travelMode: "drive" },
  );
  expect(routes).toHaveLength(1);
  expect(release).not.toHaveBeenCalled();
  expect(trace).not.toHaveBeenCalled();
  expect(routes[0].legs[0]).toMatchObject({
    speedLimits: { status: "unavailable", reason: "tileset_changed" },
  });
});
it("rejects source switched while original route was awaited without losing base route", async () => {
  compute.mockImplementation(async () => {
    current.mockResolvedValue(false);
    return { status: "OK", trips: [structuredClone(trip)] };
  });
  const routes = await planValhallaRoute(
    { lat: 25, lng: 121 },
    { lat: 25.0002, lng: 121 },
    { travelMode: "drive" },
  );
  expect(routes).toHaveLength(1);
  expect(trace).not.toHaveBeenCalled();
  expect(routes[0].legs[0]).toMatchObject({
    type: "DRIVE",
    speedLimits: { status: "unavailable", reason: "tileset_changed" },
  });
  expect(getRoadMatchingData(routes[0])).toBeUndefined();
});
