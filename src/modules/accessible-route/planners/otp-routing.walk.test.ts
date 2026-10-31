import { encode } from "@googlemaps/polyline-codec";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      walkPolicy: {
        version: "sidewalk-priority-v1",
        profile: "NORMAL",
        avoidStairs: false,
        maxSlopePercent: null,
        carriagewayMillimetres: 0,
        generalizedCost: 823,
      },
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
  it("keeps wheelchair capability enabled when stairs are explicitly allowed", async () => {
    post.mockResolvedValue(okResp([]));
    await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
      avoidStairs: false,
    });
    expect(post.mock.calls[0][1].variables).toMatchObject({
      wheelchair: true,
      directWalkProfile: "WHEELCHAIR",
      avoidStairs: false,
    });
  });

  it("does not replan walking after the shared transit deadline is spent", async () => {
    expect(
      await planOtpWalkDetailed(origin, destination, {
        deadline: Date.now() - 1,
      }),
    ).toEqual({ status: "unavailable", routes: [] });
    expect(post).not.toHaveBeenCalled();
  });

  it("caps the policy walk query at the remaining transit request budget", async () => {
    post.mockResolvedValue(okResp([]));
    await planOtpWalkDetailed(origin, destination, {
      deadline: Date.now() + 5000,
    });
    expect(post.mock.calls[0][2]?.timeout).toBeGreaterThan(0);
    expect(post.mock.calls[0][2]?.timeout).toBeLessThanOrEqual(5000);
  });

  it("rejects an itinerary that did not execute the sidewalk policy", async () => {
    const legacy = walkItin();
    Reflect.deleteProperty(legacy.legs[0], "walkPolicy");
    post.mockResolvedValue(okResp([legacy]));
    expect(await planOtpWalkDetailed(origin, destination)).toEqual({
      status: "unavailable",
      routes: [],
    });
  });

  it("rejects mismatched policy conditions and invalid search costs", async () => {
    for (const changed of [
      { version: "legacy" },
      { profile: "WHEELCHAIR" },
      { avoidStairs: true },
      { maxSlopePercent: null, carriagewayMillimetres: -1 },
      { maxSlopePercent: null, carriagewayMillimetres: 1.5 },
      { generalizedCost: Infinity },
    ]) {
      const invalid = walkItin();
      Object.assign(invalid.legs[0].walkPolicy, changed);
      post.mockResolvedValueOnce(okResp([invalid]));
      expect(await planOtpWalkDetailed(origin, destination)).toEqual({
        status: "unavailable",
        routes: [],
      });
      post.mockResolvedValueOnce(okResp([walkItin()]));
      expect((await planOtpWalkDetailed(origin, destination)).status).toBe(
        "ok",
      );
    }
  });

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

  it("rejects native output that violates its executed stair condition", async () => {
    const itinerary = walkItin();
    itinerary.legs[0].walkPolicy.avoidStairs = true;
    Object.assign(itinerary.legs[0].steps[0], {
      feature: { __typename: "StairsUse" },
    });
    post.mockResolvedValue(okResp([itinerary]));
    expect(
      await planOtpWalkDetailed(origin, destination, { avoidStairs: true }),
    ).toEqual({ status: "unavailable", routes: [] });
  });

  it("normalizes an OTP relative-direction token outside the public vocabulary", async () => {
    const itinerary = walkItin();
    itinerary.legs[0].steps[0].relativeDirection = "FOLLOW_SIGNS";
    post.mockResolvedValue(okResp([itinerary]));

    const result = await planOtpWalk(origin, destination);

    const step =
      result[0].legs[0].type === "WALK"
        ? result[0].legs[0].steps?.[0]
        : undefined;
    expect(step?.relativeDirection).toBe("CONTINUE");
  });

  it("accepts independent wheelchair and stair conditions acknowledged by the engine", async () => {
    const itinerary = walkItin();
    itinerary.legs[0].walkPolicy.profile = "WHEELCHAIR";
    itinerary.legs[0].walkPolicy.avoidStairs = true;
    post.mockResolvedValue(okResp([itinerary]));
    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok")
      expect(result.routes[0].walkPolicy).toMatchObject({
        profile: "wheelchair",
        avoidStairs: true,
      });
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

describe("official OTP walking", () => {
  beforeEach(() => {
    vi.stubEnv("ROUTE_WALK_PLANNER", "otp");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { mode: "normal", avoidStairs: false, wheelchair: false },
    { mode: "normal", avoidStairs: true, wheelchair: false },
    { mode: "wheelchair", avoidStairs: false, wheelchair: true },
    { mode: "wheelchair", avoidStairs: true, wheelchair: true },
  ] as const)(
    "keeps mobility independent from stairs for $mode / $avoidStairs",
    async ({ mode, avoidStairs, wheelchair }) => {
      post.mockResolvedValue(okResp([]));
      await planOtpWalkDetailed(origin, destination, { mode, avoidStairs });
      const { query, variables } = post.mock.calls[0][1];
      expect(variables.wheelchair).toBe(wheelchair);
      expect(variables).not.toHaveProperty("directWalkProfile");
      expect(variables).not.toHaveProperty("avoidStairs");
      expect(query).toContain("transportModes: [{ mode: WALK }]");
      expect(query).not.toContain("DirectWalkProfile");
      expect(query).not.toContain("walkPolicy");
    },
  );

  it("accepts standard geometry without inventing a native policy receipt", async () => {
    const itinerary = walkItin();
    Reflect.deleteProperty(itinerary.legs[0], "walkPolicy");
    post.mockResolvedValue(okResp([itinerary]));

    const result = await planOtpWalkDetailed(origin, destination);

    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).not.toHaveProperty("walkPolicy");
    expect(result.routes[0].totalWalkDistanceM).toBe(823);
  });

  it("keeps the official candidate order instead of applying roadway lexicographic ranking", async () => {
    const first = walkItin();
    const faster = walkItin();
    first.duration = 1200;
    faster.duration = 600;
    Reflect.deleteProperty(first.legs[0], "walkPolicy");
    Reflect.deleteProperty(faster.legs[0], "walkPolicy");
    post.mockResolvedValue(okResp([first, faster]));

    const result = await planOtpWalk(origin, destination);

    expect(result.map((route) => route.totalMinutes)).toEqual([20, 10]);
  });

  it("rejects known stairs and keeps a step-free alternative", async () => {
    const stairs = walkItin();
    const stepFree = walkItin();
    Object.assign(stairs.legs[0].steps[0], {
      feature: { __typename: "StairsUse" },
    });
    Reflect.deleteProperty(stairs.legs[0], "walkPolicy");
    Reflect.deleteProperty(stepFree.legs[0], "walkPolicy");
    stepFree.duration = 900;
    post.mockResolvedValue(okResp([stairs, stepFree]));

    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "normal",
      avoidStairs: true,
    });

    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].totalMinutes).toBe(15);
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(false);
  });

  it("reports no route when every official candidate has forbidden stairs", async () => {
    const itinerary = walkItin();
    Object.assign(itinerary.legs[0].steps[0], {
      feature: { __typename: "StairsUse" },
    });
    Reflect.deleteProperty(itinerary.legs[0], "walkPolicy");
    post.mockResolvedValue(okResp([itinerary]));

    expect(
      await planOtpWalkDetailed(origin, destination, { mode: "wheelchair" }),
    ).toEqual({ status: "no_route", routes: [] });
  });

  it("retains wheelchair routing when stairs are explicitly permitted", async () => {
    const itinerary = walkItin();
    Object.assign(itinerary.legs[0].steps[0], {
      feature: { __typename: "StairsUse" },
    });
    Reflect.deleteProperty(itinerary.legs[0], "walkPolicy");
    post.mockResolvedValue(okResp([itinerary]));

    expect(
      (
        await planOtpWalkDetailed(origin, destination, {
          mode: "wheelchair",
          avoidStairs: false,
        })
      ).status,
    ).toBe("ok");
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(true);
  });
});

describe("CSR fallback to the official OTP schema", () => {
  const schemaMismatch = {
    data: {
      errors: [
        "Validation error (UnknownType) : Unknown type 'DirectWalkProfile'",
        "Validation error (UnknownArgument@[plan]) : Unknown field argument 'directWalkProfile'",
        "Validation error (UnknownArgument@[plan]) : Unknown field argument 'avoidStairs'",
        "Validation error (FieldUndefined@[plan/itineraries/legs/walkPolicy]) : Field 'walkPolicy' in type 'Leg' is undefined",
      ].map((message) => ({
        message,
        extensions: { classification: "ValidationError" },
      })),
    },
  };

  beforeEach(() => {
    vi.stubEnv("ROUTE_WALK_PLANNER", "csr");
    post.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses official results after an exact schema mismatch, retaining the stair constraint without a policy receipt", async () => {
    const stairs = walkItin();
    const accessible = walkItin();
    Reflect.deleteProperty(stairs.legs[0], "walkPolicy");
    Reflect.deleteProperty(accessible.legs[0], "walkPolicy");
    Object.assign(stairs.legs[0].steps[0], {
      feature: { __typename: "StairsUse" },
    });
    post
      .mockResolvedValueOnce(schemaMismatch)
      .mockResolvedValueOnce(okResp([stairs, accessible]));

    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
      avoidStairs: true,
      deadline: Date.now() + 5000,
    });

    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).not.toHaveProperty("walkPolicy");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].query).toContain("DirectWalkProfile");
    expect(post.mock.calls[1][1].query).not.toContain("DirectWalkProfile");
    expect(post.mock.calls[1][1].variables.wheelchair).toBe(true);
    expect(post.mock.calls[1][2]?.timeout).toBeGreaterThan(0);
    expect(post.mock.calls[1][2]?.timeout).toBeLessThanOrEqual(5000);
  });

  it("does not retry when schema errors include another validation failure", async () => {
    post.mockResolvedValueOnce({
      data: {
        errors: [
          ...schemaMismatch.data.errors,
          {
            message: "Validation error: another failure",
            extensions: { classification: "ValidationError" },
          },
        ],
      },
    });
    expect(await planOtpWalkDetailed(origin, destination)).toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not retry network or unrelated GraphQL failures", async () => {
    post.mockRejectedValueOnce(new Error("offline"));
    expect(await planOtpWalkDetailed(origin, destination)).toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(1);
    post.mockResolvedValueOnce(okResp([walkItin()]));
    expect((await planOtpWalkDetailed(origin, destination)).status).toBe("ok");
    post.mockClear();
    post.mockResolvedValueOnce({ data: { errors: [{ message: "TIMEOUT!" }] } });
    expect(await planOtpWalkDetailed(origin, destination)).toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("official walk response validation", () => {
  const mismatch = {
    data: {
      errors: [
        "Validation error (UnknownType) : Unknown type 'DirectWalkProfile'",
        "Validation error (UnknownArgument@[plan]) : Unknown field argument 'directWalkProfile'",
        "Validation error (UnknownArgument@[plan]) : Unknown field argument 'avoidStairs'",
        "Validation error (FieldUndefined@[plan/itineraries/legs/walkPolicy]) : Field 'walkPolicy' in type 'Leg' is undefined",
      ].map((message) => ({
        message,
        extensions: { classification: "ValidationError" },
      })),
    },
  };
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["missing data", { data: {} }],
    ["empty data", { data: { data: {} } }],
    ["null plan", { data: { data: { plan: null } } }],
    ["missing itineraries", { data: { data: { plan: {} } } }],
    ["null itineraries", { data: { data: { plan: { itineraries: null } } } }],
    ["invalid itineraries", { data: { data: { plan: { itineraries: {} } } } }],
    ["null itinerary", { data: { data: { plan: { itineraries: [null] } } } }],
    [
      "itinerary missing legs",
      { data: { data: { plan: { itineraries: [{ duration: 20 }] } } } },
    ],
    [
      "null walking leg",
      {
        data: {
          data: { plan: { itineraries: [{ duration: 20, legs: [null] }] } },
        },
      },
    ],
    [
      "null walking step",
      {
        data: {
          data: {
            plan: {
              itineraries: [
                {
                  ...walkItin(),
                  legs: [{ ...walkItin().legs[0], steps: [null] }],
                },
              ],
            },
          },
        },
      },
    ],
  ])(
    "treats %s as unavailable in official and fallback mode",
    async (_label, malformed) => {
      for (const planner of ["otp", "csr"] as const) {
        vi.stubEnv("ROUTE_WALK_PLANNER", planner);
        post.mockReset();
        if (planner === "csr") post.mockResolvedValueOnce(mismatch);
        post.mockResolvedValueOnce(malformed);
        expect(await planOtpWalkDetailed(origin, destination)).toEqual({
          status: "unavailable",
          routes: [],
        });
        expect(post).toHaveBeenCalledTimes(planner === "csr" ? 2 : 1);
        post.mockReset();
        if (planner === "csr") post.mockResolvedValueOnce(mismatch);
        post.mockResolvedValueOnce(okResp([]));
        expect(await planOtpWalkDetailed(origin, destination)).toEqual({
          status: "no_route",
          routes: [],
        });
      }
    },
  );
});
