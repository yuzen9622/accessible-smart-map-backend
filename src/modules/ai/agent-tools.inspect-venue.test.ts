import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  inspectVenueByQuery,
  planVenueRoute,
  resolveVenueQuery,
  getConfig,
  getA11yProfile,
} = vi.hoisted(() => ({
  inspectVenueByQuery: vi.fn(),
  planVenueRoute: vi.fn(),
  resolveVenueQuery: vi.fn(),
  getConfig: vi.fn(),
  getA11yProfile: vi.fn(),
}));
vi.mock("../venue/venue.service", () => ({
  inspectVenueByQuery,
  planVenueRoute,
  resolveVenueQuery,
}));
const { attachRouteTokens } = vi.hoisted(() => ({
  attachRouteTokens: vi.fn(),
}));
vi.mock("../accessible-route/route-token.service", () => ({
  attachRouteTokens,
}));
vi.mock("../user/user.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../user/user.service")>()),
  getConfig,
  getA11yProfile,
}));

import { executeLocalTool } from "./agent-tools";
import { projectToolResult } from "../../utils/agent-route-projection";

const OK = {
  ok: true,
  venueId: "nutc-sanmin",
  venueName: "三民校區",
  venueVersion: 6,
  facts: [],
  truncated: false,
};

const call = async (
  args: Record<string, unknown>,
  userId?: string,
  language?: "zh-TW" | "en",
) =>
  JSON.parse(
    await executeLocalTool("inspectVenue", args, undefined, userId, {
      language,
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  inspectVenueByQuery.mockResolvedValue(OK);
});

describe("inspectVenue agent tool", () => {
  it("passes validated arguments through and returns the facts unchanged", async () => {
    expect(
      await call({
        building: " 資訊館 ",
        level: "4樓",
        kinds: ["toilet"],
        extra: 1,
      }),
    ).toEqual(OK);
    expect(inspectVenueByQuery).toHaveBeenCalledWith(
      { building: "資訊館", level: "4樓", kinds: ["toilet"] },
      "normal",
    );
  });

  it("rejects malformed arguments without querying", async () => {
    expect(await call({ limit: 99 })).toMatchObject({
      ok: false,
      reason: "INVALID_ARGUMENTS",
    });
    expect(inspectVenueByQuery).not.toHaveBeenCalled();
  });

  it("prefers an explicit mode over the stored profile", async () => {
    getConfig.mockResolvedValue({
      accessibility: { mobilityAid: "manual_wheelchair" },
    });
    await call({ nearPlaceId: "x", mode: "elderly" }, "user-1");
    expect(inspectVenueByQuery).toHaveBeenCalledWith(
      { nearPlaceId: "x", mode: "elderly" },
      "elderly",
    );
    expect(getConfig).not.toHaveBeenCalled();
  });

  it.each([
    [{ mobilityAid: "power_wheelchair" }, "wheelchair"],
    [{ visualAssistance: true }, "visual_impaired"],
    [{ mobilityAid: null, visualAssistance: null }, "normal"],
    [undefined, "normal"],
  ])(
    "derives the mode from profile %j without writing Config",
    async (accessibility, mode) => {
      getConfig.mockResolvedValue(
        accessibility === undefined ? null : { accessibility },
      );
      await call({ nearPlaceId: "x" }, "user-1");
      expect(inspectVenueByQuery).toHaveBeenCalledWith(
        { nearPlaceId: "x" },
        mode,
      );
      expect(getConfig).toHaveBeenCalledWith("user-1");
      expect(getA11yProfile).not.toHaveBeenCalled();
    },
  );

  it("uses normal for an anonymous caller", async () => {
    await call({ nearPlaceId: "x" });
    expect(inspectVenueByQuery).toHaveBeenCalledWith(
      { nearPlaceId: "x" },
      "normal",
    );
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("adds a localized error to a failure and keeps its candidates", async () => {
    inspectVenueByQuery.mockResolvedValue({
      ok: false,
      reason: "BUILDING_NOT_FOUND",
      candidates: [{ id: "info", name: "資訊館" }],
    });
    expect(await call({ building: "資訊" }, undefined, "en")).toEqual({
      ok: false,
      reason: "BUILDING_NOT_FOUND",
      candidates: [{ id: "info", name: "資訊館" }],
      error: "No single matching building; pick one from candidates",
    });
  });
});

describe("planIndoorRoute agent tool", () => {
  const route = {
    venueId: "nutc-sanmin",
    venueVersion: 1,
    mode: "wheelchair",
    fromPlaceId: "info-2606",
    toPlaceId: "info-2301",
    distanceM: 61.4,
    durationS: 155,
    elevatorRides: 1,
    stairFlights: 0,
    path: {
      coordinates: [[120.68, 24.15, 18]],
      buildingIds: ["info"],
      levelRefs: ["6F"],
    },
    segments: [
      { buildingId: "info", levelRef: "6F", pathStart: 0, pathEnd: 0 },
    ],
    steps: [
      {
        type: "depart",
        instruction: "從 2606 出發",
        distanceM: 0,
        durationS: 0,
        buildingId: "info",
        levelRef: "6F",
        pathStart: 0,
        pathEnd: 0,
      },
      {
        type: "elevator",
        instruction: "搭電梯 A 到 3F",
        distanceM: 0,
        durationS: 40,
        buildingId: "info",
        levelRef: null,
        fromLevelRef: "6F",
        toLevelRef: "3F",
        pathStart: 0,
        pathEnd: 0,
        connectionId: "node/1",
      },
    ],
  };
  const plan = async (args: Record<string, unknown>, userId?: string) =>
    JSON.parse(
      await executeLocalTool("planIndoorRoute", args, undefined, userId, {}),
    );

  beforeEach(() => {
    resolveVenueQuery.mockResolvedValue({ ok: true, venueId: "nutc-sanmin" });
    attachRouteTokens.mockImplementation(async (routes) =>
      routes.map((r: object) => ({ ...r, routeToken: "token-1" })),
    );
  });

  it("plans with the venue planner and returns spoken steps without geometry", async () => {
    planVenueRoute.mockResolvedValue({ ok: true, route });
    const result = await plan({
      fromPlaceId: "info-2606",
      toPlaceId: "info-2301",
      mode: "wheelchair",
    });
    expect(planVenueRoute).toHaveBeenCalledWith({
      venueId: "nutc-sanmin",
      fromPlaceId: "info-2606",
      toPlaceId: "info-2301",
      mode: "wheelchair",
      lang: "zh-TW",
    });
    expect(result).toMatchObject({
      ok: true,
      venueId: "nutc-sanmin",
      venueLeg: route,
      routes: [{ routeToken: "token-1", legs: [] }],
    });
    expect(attachRouteTokens).toHaveBeenCalledWith(
      [expect.objectContaining({ legs: [] })],
      expect.objectContaining({ mode: "wheelchair", travelMode: "walk" }),
      { departure: route },
    );
    const { modelResult } = projectToolResult(result);
    expect(modelResult).toMatchObject({
      venueLeg: {
        fromPlaceId: "info-2606",
        toPlaceId: "info-2301",
        distanceM: 61,
        minutes: 3,
        elevatorRides: 1,
        steps: [
          { type: "depart", instruction: "從 2606 出發", floor: "6F" },
          { type: "elevator", instruction: "搭電梯 A 到 3F", floors: "6F→3F" },
        ],
      },
    });
    expect(JSON.stringify(modelResult)).not.toMatch(/token-1|"path"/);
  });

  it("derives the mode from the stored profile when none is given", async () => {
    planVenueRoute.mockResolvedValue({ ok: true, route });
    getConfig.mockResolvedValue({
      accessibility: { mobilityAid: "manual_wheelchair" },
    });
    await plan({ fromPlaceId: "a", toPlaceId: "b" }, "user-1");
    expect(planVenueRoute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "wheelchair" }),
    );
    expect(getA11yProfile).not.toHaveBeenCalled();
  });

  it("reports an unknown place and an unreachable destination without inventing a route", async () => {
    planVenueRoute.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "查無此場域地點",
    });
    expect(await plan({ fromPlaceId: "x", toPlaceId: "y" })).toMatchObject({
      ok: false,
      reason: "PLACE_NOT_FOUND",
    });
    planVenueRoute.mockResolvedValueOnce({
      ok: false,
      status: 422,
      error: "找不到符合無障礙需求的路線",
      data: {
        reason: "NO_ACCESSIBLE_ROUTE",
        venueAccessibility: { stepFreeReachable: false },
      },
    });
    expect(
      await plan({ fromPlaceId: "x", toPlaceId: "y", mode: "wheelchair" }),
    ).toMatchObject({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
      mode: "wheelchair",
    });
  });

  it("rejects missing place ids and an unknown venue before planning", async () => {
    expect(await plan({ fromPlaceId: "a" })).toMatchObject({
      reason: "INVALID_ARGUMENTS",
    });
    resolveVenueQuery.mockResolvedValue({
      ok: false,
      reason: "VENUE_NOT_FOUND",
      candidates: [{ id: "nutc-sanmin", name: "三民校區" }],
    });
    expect(
      await plan({ venue: "台大", fromPlaceId: "a", toPlaceId: "b" }),
    ).toMatchObject({
      ok: false,
      reason: "VENUE_NOT_FOUND",
    });
    expect(planVenueRoute).not.toHaveBeenCalled();
  });
});
