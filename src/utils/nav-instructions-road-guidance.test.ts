import { describe, expect, it } from "vitest";
import { generateNavInstructions } from "./nav-instructions-engine";
import { NavInstructionsDataSchema } from "../schemas/nav-instructions-data.schema";
import type { DriveLeg } from "../types/route";

const roadLeg: DriveLeg = {
  type: "DRIVE",
  from: { lat: 25, lng: 121 },
  to: { lat: 25, lng: 121.002 },
  distanceM: 200,
  durationMin: 1,
  polyline: [
    [121, 25],
    [121.001, 25],
    [121, 25],
    [121.002, 25],
  ],
  maneuvers: [
    {
      type: 4,
      lengthKm: 0,
      timeSec: 0,
      instruction: "arrive",
      streetNames: [],
      beginShapeIndex: 0,
      endShapeIndex: 0,
    },
    {
      type: 20,
      lengthKm: 0.1,
      timeSec: 20,
      instruction: "exit",
      streetNames: ["國道1"],
      beginShapeIndex: 2,
      endShapeIndex: 3,
      beginStreetNames: ["機場"],
      bearingBefore: 90,
      bearingAfter: 120,
      signs: {
        exitNumbers: ["8"],
        branches: ["1"],
        destinations: ["台北（北）", "中壢（南）"],
        exitNames: [],
      },
      lanes: [
        {
          directions: ["slight_right"],
          recommendation: "preferred",
          maneuverDirection: "slight_right",
        },
      ],
      laneApproachRange: { fromIndex: 1, toIndex: 2 },
    },
  ],
  steps: [
    {
      instruction: "右側出口",
      maneuver: "EXIT_RIGHT",
      maneuverIndex: 1,
      distanceM: 100,
      durationMin: 1,
      polyline: [
        [121, 25],
        [121.002, 25],
      ],
    },
  ],
};

describe("road navigation metadata", () => {
  it.each(["zh-TW", "en"] as const)(
    "uses original maneuver and direct loop anchor (%s)",
    (language) => {
      const result = generateNavInstructions(
        { legs: [roadLeg] },
        undefined,
        language,
      );
      if (!result.ok) throw new Error("instructions missing");
      const instruction = result.data.instructions.find(
        (step) => step.roadGuidance,
      );
      expect(instruction).toMatchObject({
        polylineIndex: 2,
        maneuver: null,
        roadGuidance: {
          maneuverIndex: 1,
          maneuver: "EXIT_RIGHT",
          endPolylineIndex: 3,
          streetNames: ["國道1"],
          beginStreetNames: ["機場"],
          bearingBefore: 90,
          bearingAfter: 120,
          signs: roadLeg.maneuvers![1].signs,
          lanes: roadLeg.maneuvers![1].lanes,
          laneApproachRange: { fromIndex: 1, toIndex: 2 },
        },
      });
      expect(instruction!.text).toContain("8");
      expect(instruction!.text).toContain("台北（北）");
      expect(instruction!.text).toContain("中壢（南）");
      expect(NavInstructionsDataSchema.parse(result.data)).toEqual(result.data);
    },
  );
  it("puts the lane hint before the signs once, for new and pre-hint cached step text", () => {
    const lanes = [
      {
        directions: ["straight"],
        recommendation: "not_recommended",
        maneuverDirection: null,
      },
      {
        directions: ["slight_right"],
        recommendation: "preferred",
        maneuverDirection: "slight_right",
      },
    ] as const;
    const signs = "（原始路牌：出口 8；1；台北（北）、中壢（南））";
    const expected = `右側出口，請靠最右側車道${signs}`;
    for (const cached of [`右側出口${signs}`, expected]) {
      const leg: DriveLeg = {
        ...roadLeg,
        maneuvers: roadLeg.maneuvers!.map((m, i) =>
          i === 1 ? { ...m, lanes: lanes.map((l) => ({ ...l })) } : m,
        ),
        steps: roadLeg.steps!.map((step) => ({ ...step, instruction: cached })),
      };
      const result = generateNavInstructions({ legs: [leg] });
      if (!result.ok) throw new Error("instructions missing");
      const step = result.data.instructions.find((s) => s.roadGuidance)!;
      expect(step.text).toBe(expected);
      expect(step.roadGuidance?.laneHint).toBe("靠最右側車道");
    }
  });
  it("keeps anchors leg-local after a WALK connector", () => {
    const result = generateNavInstructions({
      legs: [
        {
          type: "WALK",
          from: "start",
          to: "road",
          distanceM: 5,
          polyline: [
            [120.999, 25],
            [121, 25],
          ],
        },
        roadLeg,
      ],
    });
    if (!result.ok) throw new Error("instructions missing");
    expect(
      result.data.instructions.find((step) => step.roadGuidance),
    ).toMatchObject({
      legIndex: 1,
      polylineIndex: 2,
      roadGuidance: {
        endPolylineIndex: 3,
        laneApproachRange: { fromIndex: 1, toIndex: 2 },
      },
    });
  });
  it("keeps legacy nearest point fallback without fabricated guidance", () => {
    const legacy = {
      ...roadLeg,
      steps: roadLeg.steps!.map(({ maneuverIndex: _, ...step }) => step),
    };
    const result = generateNavInstructions({ legs: [legacy] });
    if (!result.ok) throw new Error("instructions missing");
    expect(result.data.instructions[0].polylineIndex).toBe(0);
    expect(result.data.instructions[0].roadGuidance).toBeUndefined();
  });
});
