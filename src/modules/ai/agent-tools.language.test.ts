import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));

import axios from "axios";
import { executeLocalTool } from "./agent-tools";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
});

describe("server-owned tool language", () => {
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
