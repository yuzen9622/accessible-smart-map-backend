import { beforeEach, describe, expect, it, vi } from "vitest";

const { inspectVenueByQuery, getConfig, getA11yProfile } = vi.hoisted(() => ({
  inspectVenueByQuery: vi.fn(),
  getConfig: vi.fn(),
  getA11yProfile: vi.fn(),
}));
vi.mock("../venue/venue.service", () => ({ inspectVenueByQuery }));
vi.mock("../user/user.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../user/user.service")>()),
  getConfig,
  getA11yProfile,
}));

import { executeLocalTool } from "./agent-tools";

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
