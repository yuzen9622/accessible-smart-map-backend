import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import captured from "./planners/fixtures/otp-next-day-elderly.json";

const { post, busLean } = vi.hoisted(() => ({
  post: vi.fn(),
  busLean: vi.fn(),
}));
vi.mock("axios", () => ({
  default: { create: () => ({ post }), isAxiosError: () => false },
}));
vi.mock("../../config/redis", () => ({ redisClient: null }));
vi.mock("../../model/bus-stop.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: busLean }) }) },
}));
vi.mock("../../model/metro-station.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../model/train-station.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../model/gtfs-trip.model", () => ({
  GtfsTrip: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: vi.fn(async () => ({})),
}));
vi.mock("./planners/route-a11y", () => ({
  nearbyA11y: vi.fn(async () => []),
  attachA11yToLeg: vi.fn(),
  deriveHighlights: vi.fn(),
  enrichLegIndoor: vi.fn(),
  buildAccessibilitySummary: vi.fn(() => ""),
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  findConfirmedHazardsWithin: vi.fn(async () => []),
}));
vi.mock("../traffic/road-incident.service", () => ({
  getActiveRoadIncidents: vi.fn(async () => []),
}));
vi.mock("./planners/facility-status", () => ({
  overlayFacilityStatus: vi.fn(async () => new Set()),
}));
vi.mock("./planners/realtime-transit", () => ({
  annotateBusTdxCity: vi.fn(),
  recoverRailTrainNos: vi.fn(async () => {}),
  overlayRealtimeTransit: vi.fn(async () => {}),
}));

import { findAccessibleRoutesDetailed } from "./accessible-route.service";

const fixture = captured.cases[0];
function response(stairs: boolean) {
  const data = structuredClone(fixture.response);
  if (stairs) {
    // OTP can return a least-stairs candidate even with wheelchair enabled;
    // use the same feature union consumed by the production WALK mapper.
    data.data.plan.itineraries[0].legs[0].steps[0].feature = {
      __typename: "StairsUse",
    };
  }
  return { data };
}

function walkResponse(stairs: boolean, delayMs = 0) {
  const result = response(stairs);
  const itinerary = result.data.data.plan.itineraries[0];
  const leg = itinerary.legs[0];
  leg.startTime += delayMs;
  leg.endTime += delayMs;
  itinerary.legs = [leg];
  itinerary.duration = leg.duration;
  itinerary.walkDistance = leg.distance;
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  busLean.mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("OTP candidates satisfy stairs constraints before stopping search", () => {
  it.each(["wide", "continuation"])(
    "replaces a stairs-only walk fallback with the step-free %s answer",
    async (stage) => {
      const empty = {
        data: { data: { plan: { itineraries: [], routingErrors: [] } } },
      };
      const delayMs = 3600000;
      post.mockResolvedValueOnce(walkResponse(true));
      if (stage === "continuation") post.mockResolvedValueOnce(empty);
      post
        .mockResolvedValueOnce(walkResponse(false, delayMs))
        .mockResolvedValue(empty);
      const result = await findAccessibleRoutesDetailed(
        fixture.origin,
        fixture.destination,
        "Tainan",
        {
          mode: "wheelchair",
          departureTime: new Date(fixture.departure),
          maxTransfers: 2,
        },
      );
      expect(result.status).toBe("ok");
      expect(result.routes[0].degraded).not.toBe(true);
      expect(result.routes[0]._scheduledDepartureTime).toBe(
        fixture.response.data.plan.itineraries[0].legs[0].startTime + delayMs,
      );
      expect(
        result.routes[0].legs
          .filter((leg) => leg.type === "WALK")
          .flatMap((leg) => leg.steps ?? [])
          .some((step) => step.stairs),
      ).toBe(false);
    },
  );

  it.each([
    { label: "already step-free", avoidStairs: true, firstStairs: false },
    { label: "stairs permitted", avoidStairs: false, firstStairs: true },
  ])(
    "retains the earliest walk fallback when $label",
    async ({ avoidStairs, firstStairs }) => {
      post
        .mockResolvedValueOnce(walkResponse(firstStairs))
        .mockResolvedValue(walkResponse(false, 3600000));
      const result = await findAccessibleRoutesDetailed(
        fixture.origin,
        fixture.destination,
        "Tainan",
        {
          mode: "normal",
          avoidStairs,
          departureTime: new Date(fixture.departure),
          maxTransfers: 2,
        },
      );
      expect(result.status).toBe("ok");
      expect(result.routes[0]._scheduledDepartureTime).toBe(
        fixture.response.data.plan.itineraries[0].legs[0].startTime,
      );
    },
  );

  it.each(["wheelchair", "elderly"] as const)(
    "does not settle a slow stairs-only first answer for %s",
    async (mode) => {
      post
        .mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + 7000);
          return response(true);
        })
        .mockResolvedValue(response(false));
      const result = await findAccessibleRoutesDetailed(
        fixture.origin,
        fixture.destination,
        "Tainan",
        {
          mode,
          avoidStairs: true,
          departureTime: new Date(fixture.departure),
          maxTransfers: 2,
        },
      );
      expect(post).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("ok");
      expect(result.routes[0].degraded).not.toBe(true);
      expect(
        result.routes[0].legs
          .filter((leg) => leg.type === "WALK")
          .flatMap((leg) => leg.steps ?? [])
          .some((step) => step.stairs),
      ).toBe(false);
    },
  );

  it("continues beyond a stairs-only two-hour answer to find a step-free alternative", async () => {
    post.mockImplementation(async (_url, { variables }) =>
      response(variables.searchWindow < 28800),
    );
    const result = await findAccessibleRoutesDetailed(
      fixture.origin,
      fixture.destination,
      "Tainan",
      {
        mode: "wheelchair",
        departureTime: new Date(fixture.departure),
        maxTransfers: 2,
      },
    );
    expect(
      post.mock.calls.map((call) => call[1].variables.searchWindow),
    ).toEqual([3600, 7200, 28800]);
    expect(result.status).toBe("ok");
    expect(result.routes[0].degraded).not.toBe(true);
    expect(
      result.routes[0].legs
        .filter((leg) => leg.type === "WALK")
        .flatMap((leg) => leg.steps ?? [])
        .some((step) => step.stairs),
    ).toBe(false);
  });

  it("preserves the explicit degraded route when all searched candidates have stairs", async () => {
    post.mockResolvedValue(response(true));
    const result = await findAccessibleRoutesDetailed(
      fixture.origin,
      fixture.destination,
      "Tainan",
      {
        mode: "wheelchair",
        departureTime: new Date(fixture.departure),
        maxTransfers: 2,
      },
    );
    expect(result.status).toBe("ok");
    expect(result.routes[0].degraded).toBe(true);
    expect(result.routes[0].warnings).toContain(
      "目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件",
    );
    expect(post.mock.calls.at(-1)![1].variables).toMatchObject({
      time: "06:30",
      searchWindow: 21600,
    });
  });

  it("keeps the original stairs fallback when every later window is empty", async () => {
    post.mockResolvedValueOnce(response(true)).mockResolvedValue({
      data: { data: { plan: { itineraries: [], routingErrors: [] } } },
    });
    const result = await findAccessibleRoutesDetailed(
      fixture.origin,
      fixture.destination,
      "Tainan",
      {
        mode: "wheelchair",
        departureTime: new Date(fixture.departure),
        maxTransfers: 2,
      },
    );
    expect(result.status).toBe("ok");
    expect(result.routes[0].degraded).toBe(true);
    expect(post).toHaveBeenCalledTimes(5);
  });

  it("honors an explicit avoidStairs=false without forcing extra searches", async () => {
    post.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 7000);
      return response(true);
    });
    const result = await findAccessibleRoutesDetailed(
      fixture.origin,
      fixture.destination,
      "Tainan",
      {
        mode: "wheelchair",
        avoidStairs: false,
        departureTime: new Date(fixture.departure),
        maxTransfers: 2,
      },
    );
    expect(result.status).toBe("ok");
    expect(result.routes[0].degraded).not.toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not attach snap connectors to the original stairs-only fallback", async () => {
    const noRoute = {
      data: { data: { plan: { itineraries: [], routingErrors: [] } } },
    };
    busLean
      .mockResolvedValueOnce([fixture.snaps[0]])
      .mockResolvedValueOnce([fixture.snaps[1]]);
    post
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(noRoute)
      .mockResolvedValueOnce(response(true))
      .mockResolvedValue(noRoute);
    const result = await findAccessibleRoutesDetailed(
      fixture.origin,
      fixture.destination,
      "Tainan",
      {
        mode: "wheelchair",
        departureTime: new Date(fixture.departure),
        maxTransfers: 2,
      },
    );
    expect(result.status).toBe("ok");
    const original = fixture.response.data.plan.itineraries[0];
    expect(result.routes[0].degraded).toBe(true);
    expect(result.routes[0].legs).toHaveLength(original.legs.length);
    expect(result.routes[0].legs[0]).toMatchObject({
      type: "WALK",
      from: "出發地",
    });
    expect(result.routes[0]._scheduledDepartureTime).toBe(
      original.legs[0].startTime,
    );
  });
});
