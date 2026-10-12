import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock("../a11y/a11y.repository");
vi.mock("../transit/bus.repository");
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));

import axios from "axios";
import type { IOsmA11y } from "../../types";
import { findOsmByIds } from "../a11y/a11y.repository";
import { findRoutesByName, type BusRouteDoc } from "../transit/bus.repository";
import { executeLocalTool } from "./agent-tools";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
});

describe("server-owned tool language", () => {
  const busRoute: BusRouteDoc = {
    routeUid: "TPE42",
    subRouteUid: "TPE42A",
    direction: 0,
    routeName: { Zh_tw: "42", En: "Route 42" },
    subRouteName: { Zh_tw: "42副線", En: "Route 42 branch" },
    stops: [
      {
        seq: 1,
        stopUID: "TPE001",
        stopName: { Zh_tw: "原站", En: "Source Station" },
        lat: 25.05,
        lng: 121.5,
      },
    ],
  };
  Object.freeze(busRoute);

  it.each(["en", "zh-TW", undefined] as const)(
    "uses trusted %s through real transit service while preserving canonical query inputs",
    async (language) => {
      vi.mocked(findRoutesByName).mockResolvedValue([busRoute]);
      const before = JSON.stringify(busRoute);
      const result = JSON.parse(
        await executeLocalTool(
          "getBusRoute",
          { routeName: "42", city: "Taipei", language: "zh-TW", lang: "zh-TW" },
          undefined,
          undefined,
          { language },
        ),
      );
      expect(result.ok).toBe(true);
      expect(findRoutesByName).toHaveBeenCalledWith("Taipei", ["42"]);
      expect(result.routeName).toBe("42");
      expect(result.directions[0].stops[0]).toMatchObject({
        name: "原站",
        stopUid: "TPE001",
      });
      if (language === undefined)
        expect(result).not.toHaveProperty("routeDisplayName");
      else {
        expect(result.routeDisplayName).toBe(
          language === "en" ? "Route 42" : "42",
        );
        expect(result.directions[0].stops[0].displayName).toBe(
          language === "en" ? "Source Station" : "原站",
        );
      }
      expect(JSON.stringify(busRoute)).toBe(before);
    },
  );

  const facility: IOsmA11y = Object.freeze({
    osmId: "123",
    name: "原始電梯",
    category: "elevator",
    importedAt: new Date(0),
    tags: Object.freeze({ "name:en": "Source Elevator" }),
    location: {
      type: "Point",
      coordinates: [121.5, 25.05],
    } as IOsmA11y["location"],
  });

  it.each(["en", "zh-TW", undefined] as const)(
    "uses trusted %s through real facility service and slim projection",
    async (language) => {
      vi.mocked(findOsmByIds).mockResolvedValue([facility]);
      const result = JSON.parse(
        await executeLocalTool(
          "getA11yFacilityDetails",
          { osmId: "123", language: "en" },
          undefined,
          undefined,
          { language },
        ),
      );
      expect(findOsmByIds).toHaveBeenCalledWith(["123"]);
      expect(result.facilities[0]).toMatchObject({
        osmId: "123",
        name: "原始電梯",
        category: "elevator",
      });
      if (language === undefined)
        expect(result.facilities[0]).not.toHaveProperty("displayName");
      else
        expect(result.facilities[0].displayName).toBe(
          language === "en" ? "Source Elevator" : "原始電梯",
        );
      expect(facility).not.toHaveProperty("displayName");
    },
  );

  it("does not mutate shared facility sources across concurrent locale requests", async () => {
    vi.mocked(findOsmByIds).mockResolvedValue([facility]);
    const results = await Promise.all(
      (["en", "zh-TW"] as const).map((language) =>
        executeLocalTool(
          "getA11yFacilityDetails",
          { osmId: "123", language: "fr" },
          undefined,
          undefined,
          { language },
        ),
      ),
    );
    expect(
      results.map((raw) => JSON.parse(raw).facilities[0].displayName),
    ).toEqual(["Source Elevator", "原始電梯"]);
    expect(facility.name).toBe("原始電梯");
  });

  it.each(["en", "zh-TW", undefined] as const)(
    "sends session %s through the real Google adapter, not model-supplied language",
    async (language) => {
      vi.mocked(axios.post).mockImplementation(async (_url, body: any) => ({
        data: {
          places: [
            {
              id: "same-place-id",
              displayName: {
                text:
                  body.languageCode === "en"
                    ? "Taipei Main Station"
                    : "臺北車站",
              },
              formattedAddress:
                body.languageCode === "en" ? "Beiping West Road" : "北平西路",
              location: { latitude: 25.0478, longitude: 121.517 },
            },
          ],
        },
      }));
      const raw = await executeLocalTool(
        "findGooglePlaces",
        { query: "台北車站", language: language === "en" ? "zh-TW" : "en" },
        undefined,
        undefined,
        { language },
      );
      expect(axios.post).toHaveBeenCalledWith(
        "https://places.googleapis.com/v1/places:searchText",
        expect.objectContaining({
          textQuery: "台北車站",
          languageCode: language ?? "zh-TW",
        }),
        expect.any(Object),
      );
      expect(JSON.parse(raw).places[0]).toMatchObject({
        name: language === "en" ? "Taipei Main Station" : "臺北車站",
      });
    },
  );

  it("does not mix languages between concurrent tool calls", async () => {
    const requested: string[] = [];
    vi.mocked(axios.post).mockImplementation(async (_url, body: any) => {
      requested.push(body.languageCode);
      await Promise.resolve();
      return { data: { places: [] } };
    });
    await Promise.all(
      (["en", "zh-TW"] as const).map((language) =>
        executeLocalTool(
          "findGooglePlaces",
          { query: "公園" },
          undefined,
          undefined,
          { language },
        ),
      ),
    );
    expect(requested).toEqual(["en", "zh-TW"]);
  });

  it("does not expose planner exception text to tool clients", async () => {
    vi.mocked(planAccessibleRouteFromRequest).mockRejectedValue(
      new Error("internal host secret: 10.0.0.1"),
    );
    const raw = await executeLocalTool(
      "planAccessibleRoute",
      { origin: "A", destination: "B" },
      undefined,
      undefined,
      { language: "en" },
    );
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      reason: "ROUTE_PLANNING_FAILED",
      error: "Route planning failed. Please try again later.",
    });
    expect(raw).not.toContain("10.0.0.1");
  });

  it("keeps missing-location failure distinct from no-route in English", async () => {
    const raw = await executeLocalTool(
      "planAccessibleRoute",
      { origin: "current_location", destination: "B" },
      undefined,
      undefined,
      { language: "en" },
    );
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      reason: "LOCATION_REQUIRED",
    });
    expect(JSON.parse(raw).error).toContain(
      "The current location is unavailable",
    );
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });

  it("passes the request language to planning and preserves its structured failure", async () => {
    vi.mocked(planAccessibleRouteFromRequest).mockResolvedValue({
      ok: false,
      status: 422,
      error: "Outside coverage",
      data: { reason: "OUT_OF_COVERAGE" },
    });
    const raw = await executeLocalTool(
      "planAccessibleRoute",
      { origin: "A", destination: "B", language: "zh-TW" },
      undefined,
      undefined,
      { language: "en" },
    );
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "A",
        destination: "B",
        language: "en",
      }),
    );
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      error: "Outside coverage",
      reason: "OUT_OF_COVERAGE",
    });
  });
});
