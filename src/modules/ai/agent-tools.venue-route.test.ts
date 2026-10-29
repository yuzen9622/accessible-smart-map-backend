import { beforeEach, describe, expect, it, vi } from "vitest";

const { planAccessibleRouteFromRequest, resolveVenueQuery } = vi.hoisted(
  () => ({
    planAccessibleRouteFromRequest: vi.fn(),
    resolveVenueQuery: vi.fn(),
  }),
);
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest,
}));
vi.mock("../venue/venue.service", () => ({
  resolveVenueQuery,
  inspectVenueByQuery: vi.fn(),
  planVenueRoute: vi.fn(),
}));
vi.mock("../accessible-route/route-token.service", () => ({
  attachRouteTokens: vi.fn(async (routes) => routes),
}));

import { executeLocalTool } from "./agent-tools";
import { projectToolResult } from "../../utils/agent-route-projection";

const plan = async (args: Record<string, unknown>) =>
  JSON.parse(
    (await executeLocalTool("planAccessibleRoute", args, {
      latitude: 24.137,
      longitude: 120.686,
    })) as string,
  );

const venueLeg = {
  venueId: "nutc-sanmin",
  venueVersion: 1,
  mode: "normal",
  fromPlaceId: "gate-main",
  toPlaceId: "info-2301",
  distanceM: 120.4,
  durationS: 200,
  elevatorRides: 1,
  stairFlights: 0,
  path: {
    coordinates: [[120.68, 24.15, 0]],
    buildingIds: [null],
    levelRefs: [null],
  },
  segments: [],
  steps: [
    {
      type: "enter",
      instruction: "進入資訊館",
      levelRef: "1F",
      buildingId: "info",
      distanceM: 0,
      durationS: 0,
      pathStart: 0,
      pathEnd: 0,
    },
    {
      type: "elevator",
      instruction: "搭電梯到 3F",
      levelRef: null,
      fromLevelRef: "1F",
      toLevelRef: "3F",
      buildingId: "info",
      distanceM: 0,
      durationS: 40,
      pathStart: 0,
      pathEnd: 0,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  resolveVenueQuery.mockResolvedValue({ ok: true, venueId: "nutc-sanmin" });
  planAccessibleRouteFromRequest.mockResolvedValue({
    ok: true,
    data: {
      origin: { lat: 24.137, lng: 120.686 },
      destination: { lat: 24.15, lng: 120.684 },
      routes: [
        {
          routeId: "r1",
          legs: [
            {
              type: "WALK",
              polyline: [
                [1, 2],
                [3, 4],
              ],
            },
          ],
        },
      ],
      venueArrival: {
        venueId: "nutc-sanmin",
        placeId: "info-2301",
        gateId: "gate-main",
      },
      venueLeg,
      _canonicalRequest: { origin: { latitude: 24.137, longitude: 120.686 } },
    },
  });
});

describe("planAccessibleRoute with venue places", () => {
  it("sends an indoor destination as destinationVenuePlace and names it by place id", async () => {
    const result = await plan({
      origin: "臺中車站",
      destinationPlaceId: "info-2301",
    });
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "臺中車站",
        destinationVenuePlace: { venueId: "nutc-sanmin", placeId: "info-2301" },
      }),
    );
    expect(planAccessibleRouteFromRequest.mock.calls[0][0]).not.toHaveProperty(
      "destination",
    );
    expect(result).toMatchObject({
      ok: true,
      destination: { name: "info-2301" },
    });
  });

  it("sends an indoor origin as originVenuePlace", async () => {
    await plan({ originPlaceId: "info@4F", destination: "臺中車站" });
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        originVenuePlace: { venueId: "nutc-sanmin", placeId: "info@4F" },
        destination: "臺中車站",
      }),
    );
    expect(planAccessibleRouteFromRequest.mock.calls[0][0]).not.toHaveProperty(
      "origin",
    );
  });

  it("refuses both ends inside the venue and points to planIndoorRoute", async () => {
    expect(
      await plan({
        originPlaceId: "info-2606",
        destinationPlaceId: "info-2301",
      }),
    ).toMatchObject({
      ok: false,
      reason: "INVALID_ROUTE_ARGUMENTS",
      error: expect.stringContaining("planIndoorRoute"),
    });
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });

  it("refuses a missing end and an unknown venue before planning", async () => {
    expect(await plan({ origin: "臺中車站" })).toMatchObject({
      reason: "INVALID_ROUTE_ARGUMENTS",
    });
    resolveVenueQuery.mockResolvedValue({
      ok: false,
      reason: "VENUE_NOT_FOUND",
      candidates: [{ id: "nutc-sanmin", name: "三民校區" }],
    });
    expect(
      await plan({
        origin: "臺中車站",
        destinationPlaceId: "x",
        venue: "台大",
      }),
    ).toMatchObject({ ok: false, reason: "VENUE_NOT_FOUND" });
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });

  it("shows the model the indoor steps but not the indoor path", async () => {
    const result = await plan({
      origin: "臺中車站",
      destinationPlaceId: "info-2301",
    });
    const { modelResult } = projectToolResult(result);
    expect(modelResult).toMatchObject({
      venueLeg: {
        toPlaceId: "info-2301",
        distanceM: 120,
        elevatorRides: 1,
        steps: [
          { type: "enter", instruction: "進入資訊館", floor: "1F" },
          { type: "elevator", instruction: "搭電梯到 3F", floors: "1F→3F" },
        ],
      },
    });
    expect(JSON.stringify(modelResult)).not.toMatch(/"path"|"segments"/);
  });
});
