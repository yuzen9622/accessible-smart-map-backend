import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VenueRoute } from "../accessible-route/venue-leg.types";
import { NavInstructionsDataSchema } from "../../schemas/nav-instructions-data.schema";
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("../accessible-route/route-token.service", () => ({
  getRouteByToken: lookup,
}));
import { generateNavInstructionsFromInput } from "./nav-instructions.service";

const indoor: VenueRoute = {
  venueId: "campus",
  venueVersion: 4,
  mode: "wheelchair",
  fromPlaceId: "gate",
  toPlaceId: "room",
  distanceM: 20,
  durationS: 80,
  elevatorRides: 1,
  stairFlights: 0,
  path: {
    coordinates: [
      [120, 24, 0],
      [120, 24, 3],
    ],
    buildingIds: ["info", "info"],
    levelRefs: ["1F", "2F"],
  },
  segments: [{ buildingId: "info", levelRef: "1F", pathStart: 0, pathEnd: 1 }],
  steps: [
    {
      type: "depart",
      instruction: "從校門出發",
      distanceM: 0,
      durationS: 0,
      buildingId: "info",
      levelRef: "1F",
      pathStart: 0,
      pathEnd: 0,
    },
    {
      type: "elevator",
      instruction: "搭乘電梯至2F",
      distanceM: 20,
      durationS: 80,
      buildingId: "info",
      levelRef: null,
      fromLevelRef: "1F",
      toLevelRef: "2F",
      pathStart: 0,
      pathEnd: 1,
    },
    {
      type: "arrive",
      instruction: "抵達教室",
      distanceM: 0,
      durationS: 0,
      buildingId: "info",
      levelRef: "2F",
      pathStart: 1,
      pathEnd: 1,
    },
  ],
};
const outdoor = {
  legs: [
    {
      type: "WALK",
      from: "車站",
      to: "校門",
      distanceM: 100,
      minutesEst: 2,
      polyline: [
        [119.999, 24],
        [120, 24],
      ],
      a11yFacilities: [],
    },
  ],
};
beforeEach(() => vi.resetAllMocks());

describe("trusted venue navigation instructions", () => {
  it("generates a complete indoor-only trip with manual floor progress and no outdoor leg", async () => {
    lookup.mockResolvedValue({ legs: [], venueLegs: { departure: indoor } });
    const result = await generateNavInstructionsFromInput({
      routeToken: "indoor",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions.map((step) => step.text)).toEqual(
      indoor.steps.map((step) => step.instruction),
    );
    expect(result.data.instructions[1]).toMatchObject({
      legType: "VENUE",
      driver: "manual",
      venueStepType: "elevator",
      buildingId: "info",
      fromLevelRef: "1F",
      toLevelRef: "2F",
    });
    expect(result.data.totalSteps).toBe(3);
    expect(result.data.warnings).toEqual([]);
    expect(NavInstructionsDataSchema.safeParse(result.data).success).toBe(true);
  });

  it("keeps the gate arrival for GPS handoff before the manual indoor destination", async () => {
    lookup.mockResolvedValue({ ...outdoor, venueLegs: { arrival: indoor } });
    const result = await generateNavInstructionsFromInput({
      routeToken: "mixed",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.instructions.some((step) => step.legType === "WALK"),
    ).toBe(true);
    expect(
      result.data.instructions.filter((step) => step.type === "arrive"),
    ).toEqual([
      expect.objectContaining({
        text: "已到達校門，接下來是校內路線",
        legType: "WALK",
      }),
      expect.objectContaining({ text: "抵達教室", driver: "manual" }),
    ]);
    expect(
      result.data.instructions.at(-1)?.cumulativeDistanceM,
    ).toBeGreaterThanOrEqual(20);
    expect(NavInstructionsDataSchema.safeParse(result.data).success).toBe(true);
  });

  it("keeps the original outdoor instruction result when there are no venue legs", async () => {
    lookup.mockResolvedValue(outdoor);
    const result = await generateNavInstructionsFromInput({
      routeToken: "outdoor",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.instructions.every(
        (step) => step.legType === "WALK" && step.driver === undefined,
      ),
    ).toBe(true);
    expect(result.data.instructions.at(-1)?.type).toBe("arrive");
  });
});
