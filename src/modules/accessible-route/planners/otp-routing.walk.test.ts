import { encode } from "@googlemaps/polyline-codec";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WalkLeg } from "../../../types/route";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: () => ({ post }), isAxiosError: () => false },
}));

import {
  planOtpWalk,
  planOtpWalkDetailed,
  isOtpCircuitOpen,
} from "./otp-routing";

const enc = (pts: [number, number][]) => encode(pts, 5);
const okResp = (itineraries: unknown[]) => ({
  data: { data: { plan: { itineraries } } },
});

const walkItin = () => ({
  duration: 713,
  walkDistance: 823,
  legs: [
    {
      mode: "WALK",
      distance: 823,
      duration: 713,
      startTime: 0,
      endTime: 713000,
      from: { name: "Origin" },
      to: { name: "Destination" },
      legGeometry: {
        points: enc([
          [25.041, 121.565],
          [25.033, 121.564],
        ]),
      },
      steps: [
        {
          distance: 823,
          lon: 121.565,
          lat: 25.041,
          relativeDirection: "DEPART",
          absoluteDirection: "SOUTH",
          streetName: "信義路",
          area: false,
          bogusName: false,
        },
      ],
    },
  ],
});

const origin = { lat: 25.041, lng: 121.565 };
const destination = { lat: 25.033, lng: 121.564 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planOtpWalk", () => {
  it("maps a walk itinerary into an AccessibleRoute", async () => {
    post.mockResolvedValue(okResp([walkItin()]));

    const result = await planOtpWalk(origin, destination);

    expect(result).toHaveLength(1);
    const r = result[0];
    expect(r.routeName).toBe("步行");
    expect(r.transferCount).toBe(0);
    expect(r.legs[0].type).toBe("WALK");
    expect((r.legs[0] as WalkLeg).from).toBe("出發地");
    expect(r.totalWalkDistanceM).toBe(823);
    expect(r.totalMinutes).toBe(12);
    expect(r.attribution).toBe("© OpenStreetMap contributors");
    const step = (r.legs[0] as WalkLeg).steps?.[0];
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
    expect(step?.stairs).toBe(false);
    expect(step?.steepSlope).toBe(false);
    expect(step).not.toHaveProperty("instruction");
    expect(step).not.toHaveProperty("maneuver");
    expect(r.legs[0]).toMatchObject({
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
    });

    const query: string = post.mock.calls[0][1].query;
    expect(query).toContain("transportModes: [{ mode: WALK }]");
    expect(query).toContain("feature { __typename }");
    expect(query).not.toContain("TRANSIT");
  });

  it("maps StairsUse and degrades to the candidate with the fewest stairs", async () => {
    const twoStairs = walkItin() as any;
    twoStairs.duration = 600;
    twoStairs.legs[0].steps = [
      { ...twoStairs.legs[0].steps[0], feature: { __typename: "StairsUse" } },
      {
        ...twoStairs.legs[0].steps[0],
        lon: 121.564,
        feature: { __typename: "StairsUse" },
      },
    ];
    const oneStair = walkItin() as any;
    oneStair.duration = 800;
    oneStair.legs[0].steps[0].feature = { __typename: "StairsUse" };
    post.mockResolvedValue(okResp([twoStairs, oneStair]));

    const result = await planOtpWalkDetailed(origin, destination, {
      avoidStairs: true,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].totalMinutes).toBe(13);
    expect(result.routes[0].degraded).toBe(true);
    expect(result.routes[0].warnings).toContain(
      "目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件",
    );
    const step =
      result.routes[0].legs[0].type === "WALK"
        ? result.routes[0].legs[0].steps?.[0]
        : undefined;
    expect(step?.stairs).toBe(true);
    expect(step?.steepSlope).toBe(false);
    expect(step).not.toHaveProperty("instruction");
    expect(post.mock.calls[0][1].variables.numItineraries).toBe(8);
  });

  it("normalizes an OTP relative-direction token outside the public vocabulary", async () => {
    const itinerary = walkItin() as any;
    itinerary.legs[0].steps[0].relativeDirection = "FOLLOW_SIGNS";
    post.mockResolvedValue(okResp([itinerary]));

    const result = await planOtpWalk(origin, destination);

    const step =
      result[0].legs[0].type === "WALK"
        ? result[0].legs[0].steps?.[0]
        : undefined;
    expect(step?.relativeDirection).toBe("CONTINUE");
  });

  it("prefers every stair-free candidate when avoidStairs is active", async () => {
    const stairs = walkItin() as any;
    stairs.duration = 500;
    stairs.legs[0].steps[0].feature = { __typename: "StairsUse" };
    const stepFree = walkItin() as any;
    stepFree.duration = 900;
    post.mockResolvedValue(okResp([stairs, stepFree]));

    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].totalMinutes).toBe(15);
    expect(result.routes[0].degraded).toBeUndefined();
  });

  it("drops an itinerary with no legs", async () => {
    post.mockResolvedValue(
      okResp([{ duration: 100, walkDistance: 50, legs: [] }]),
    );
    expect(await planOtpWalk(origin, destination)).toEqual([]);
  });

  it("logs when OTP returns no walk itineraries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    post.mockResolvedValue(okResp([]));

    await expect(planOtpWalk(origin, destination)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      "[otp-routing] walk query returned no itineraries (fail-soft to [])",
      expect.stringContaining('"wheelchair":false'),
    );
    warn.mockRestore();
  });

  it("distinguishes no-route from an unavailable OTP walk planner", async () => {
    post.mockResolvedValueOnce(okResp([]));
    await expect(planOtpWalkDetailed(origin, destination)).resolves.toEqual({
      status: "no_route",
      routes: [],
    });

    post.mockRejectedValueOnce(new Error("down"));
    await expect(planOtpWalkDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
  });

  it("drops an itinerary containing a non-WALK leg", async () => {
    const it = walkItin();
    (it.legs as unknown[]).push({
      mode: "BUS",
      distance: 500,
      duration: 300,
      startTime: 0,
      endTime: 300000,
      from: { name: "A" },
      to: { name: "B" },
      legGeometry: {
        points: enc([
          [25.04, 121.56],
          [25.03, 121.55],
        ]),
      },
      steps: [],
    });
    post.mockResolvedValue(okResp([it]));
    expect(await planOtpWalk(origin, destination)).toEqual([]);
  });

  it("drops a leg whose geometry decodes to fewer than 2 points", async () => {
    const it = walkItin();
    it.legs[0].legGeometry.points = enc([[25.04, 121.56]]);
    post.mockResolvedValue(okResp([it]));
    expect(await planOtpWalk(origin, destination)).toEqual([]);
  });

  it("falls back to leg distance sum when walkDistance is missing", async () => {
    const it = walkItin() as { walkDistance?: number };
    delete it.walkDistance;
    post.mockResolvedValue(okResp([it]));

    const result = await planOtpWalk(origin, destination);
    expect(result).toHaveLength(1);
    expect(Number.isFinite(result[0].totalWalkDistanceM)).toBe(true);
    expect(result[0].totalWalkDistanceM).toBe(823);
  });

  it("is fail-soft: resolves [] when the OTP post rejects", async () => {
    post.mockRejectedValue(new Error("boom"));
    await expect(planOtpWalk(origin, destination)).resolves.toEqual([]);
  });

  it("opens the walk breaker without tripping the transit circuit", async () => {
    vi.resetModules();
    const failPost = vi.fn().mockRejectedValue(new Error("down"));
    vi.doMock("axios", () => ({
      default: {
        create: () => ({ post: failPost }),
        isAxiosError: () => false,
      },
    }));
    // A fresh module graph would recompile the mongoose models (OverwriteModelError);
    // the walk path never touches them, so stub them out for the isolated instance.
    vi.doMock("../../../model/gtfs-trip.model", () => ({ GtfsTrip: {} }));
    vi.doMock("../../../model/metro-station.model", () => ({ default: {} }));
    vi.doMock("../../../model/train-station.model", () => ({ default: {} }));
    vi.doMock("../../../model/bus-stop.model", () => ({ default: {} }));
    const mod = await import("./otp-routing");

    for (let i = 0; i < 3; i++) {
      expect(await mod.planOtpWalk(origin, destination)).toEqual([]);
    }
    expect(failPost).toHaveBeenCalledTimes(3);
    expect(mod.isOtpCircuitOpen()).toBe(false);

    // 4th call short-circuits on the open breaker — no further post.
    expect(await mod.planOtpWalk(origin, destination)).toEqual([]);
    expect(failPost).toHaveBeenCalledTimes(3);

    vi.doUnmock("axios");
    vi.doUnmock("../../../model/gtfs-trip.model");
    vi.doUnmock("../../../model/metro-station.model");
    vi.doUnmock("../../../model/train-station.model");
    vi.doUnmock("../../../model/bus-stop.model");
    vi.resetModules();
  });

  it("keeps the transit circuit reported closed after a walk-only success", async () => {
    post.mockResolvedValue(okResp([walkItin()]));
    await planOtpWalk(origin, destination);
    expect(isOtpCircuitOpen()).toBe(false);
  });
});
