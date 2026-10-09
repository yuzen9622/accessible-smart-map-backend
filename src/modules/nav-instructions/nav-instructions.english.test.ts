import { describe, expect, it } from "vitest";
import {
  generateNavInstructions,
  generateNavStepsWithLegIndex,
  calcRelativeDirection,
} from "../../utils/nav-instructions-engine";
import { NavInstructionsDataSchema } from "../../schemas/nav-instructions-data.schema";
import type { WalkLeg, WalkStep } from "../../types/route";

const step = (
  relativeDirection: string,
  overrides: Partial<WalkStep> = {},
): WalkStep => ({
  relativeDirection,
  absoluteDirection: "EAST",
  streetName: "Main Road",
  bogusName: false,
  area: false,
  stairs: false,
  steepSlope: false,
  distanceM: 80,
  location: [121.5, 25],
  ...overrides,
});

const walk = (steps?: WalkStep[]): WalkLeg => ({
  type: "WALK",
  from: "起點",
  to: "終點",
  distanceM: 80,
  minutesEst: 2,
  polyline: [
    [121.5, 25],
    [121.501, 25],
  ],
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
  steps,
});

function instructions(legs: unknown[]) {
  const result = generateNavInstructions({ legs }, 0, "en");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(NavInstructionsDataSchema.safeParse(result.data).success).toBe(true);
  return result.data;
}

describe("English navigation", () => {
  it.each([
    ["DEPART", "Head along Main Road"],
    ["CONTINUE", "Continue straight"],
    ["STRAIGHT", "Continue straight"],
    ["LEFT", "Turn left"],
    ["RIGHT", "Turn right"],
    ["SLIGHTLY_LEFT", "Turn slightly left"],
    ["SLIGHTLY_RIGHT", "Turn slightly right"],
    ["HARD_LEFT", "Turn sharply left"],
    ["HARD_RIGHT", "Turn sharply right"],
    ["UTURN_LEFT", "Make a U-turn"],
    ["UTURN_RIGHT", "Make a U-turn"],
    ["CIRCLE_CLOCKWISE", "continue clockwise"],
    ["CIRCLE_COUNTERCLOCKWISE", "continue counterclockwise"],
  ])("renders %s with post-maneuver distance", (direction, expected) => {
    const first = instructions([walk([step(direction)])]).instructions[0];
    expect(first.text).toContain(expected);
    expect(first.text).toContain("then continue for about 80 meters");
    expect(first.relativeDirection).toBe("right");
    expect(first.text).not.toMatch(/\p{Script=Han}/u);
  });

  it.each([
    ["ELEVATOR", "Enter the elevator"],
    ["ESCALATOR", "Take the escalator"],
    ["MOVING_WALKWAY", "Take the moving walkway"],
    ["FARE_GATE", "Go through the fare gate"],
    ["ENTER_STATION", "Enter the station"],
    ["EXIT_STATION", "Exit the station"],
  ])("renders %s with accessibility notices", (direction, expected) => {
    const first = instructions([
      walk([step(direction, { stairs: true, steepSlope: true })]),
    ]).instructions[0];
    expect(first).toMatchObject({
      type: "facility",
      bearing: null,
      relativeDirection: null,
      stairs: true,
    });
    expect(first.text).toBe(
      `${expected}; this section has a steep slope; this section includes stairs`,
    );
  });

  it("preserves route geometry, machine fields and source names across language changes", () => {
    const route = {
      legs: [
        walk([
          step("DEPART", {
            streetName: "中山路",
            stairs: true,
            steepSlope: true,
          }),
        ]),
      ],
    };
    const before = JSON.stringify(route);
    const zh = generateNavInstructions(route);
    const en = generateNavInstructions(route, undefined, "en");
    expect(zh.ok && en.ok).toBe(true);
    if (!zh.ok || !en.ok) return;
    const geometry = (data: typeof en.data) => ({
      ...data,
      instructions: data.instructions.map(({ text, ...rest }) => rest),
    });
    expect(geometry(en.data)).toEqual(geometry(zh.data));
    expect(en.data.instructions[0].text).toContain("中山路");
    expect(en.data.instructions[0].text).toContain("degrees (east)");
    expect(en.data.instructions.at(-1)?.text).toBe(
      "You have arrived at your destination",
    );
    expect(JSON.stringify(route)).toBe(before);
    const voice = generateNavStepsWithLegIndex(route, "en");
    expect(voice.ok && voice.steps.map((s) => s.instruction)).toEqual(
      en.data.instructions,
    );
  });

  it("keeps missing-step warnings and translates planner destination labels", () => {
    const result = instructions([walk()]);
    expect(result.warnings).toEqual([
      "WALK_STEPS_UNAVAILABLE",
      "ORS_STEPS_UNAVAILABLE",
    ]);
    expect(result.instructions[0].text).toBe(
      "Head east toward your destination",
    );
  });

  it.each(["elevator", "ramp"] as const)("renders %s exits", (type) => {
    const leg = walk([step("CONTINUE")]);
    leg.exitInfo = { type, exitNumber: "2" } as NonNullable<
      WalkLeg["exitInfo"]
    >;
    const result = instructions([leg]);
    expect(result.instructions[1].text).toContain(
      `The ${type} for exit 2 is ahead`,
    );
  });

  it.each(["DRIVE", "MOTORCYCLE"])(
    "regenerates %s guidance from maneuvers without copying Chinese instructions",
    (type) => {
      const result = instructions([
        {
          type,
          distanceM: 150,
          polyline: [
            [121.5, 25],
            [121.501, 25],
          ],
          steps: [
            {
              instruction: "向左转",
              maneuver: "TURN_LEFT",
              distanceM: 150,
              polyline: [
                [121.5, 25],
                [121.501, 25],
              ],
            },
          ],
          maneuvers: [{ type: 15, streetNames: ["Main Road"] }, { type: 4 }],
        },
      ]);
      expect(result.instructions[0].text).toBe(
        "Turn left onto Main Road, then continue for about 150 meters",
      );
      expect(JSON.stringify(result)).not.toMatch(/\p{Script=Han}/u);
      const fallback = instructions([{ type, distanceM: 150, polyline: [] }]);
      expect(fallback.warnings).toEqual(["ROAD_STEPS_UNAVAILABLE"]);
      expect(fallback.instructions[0].text).toBe(
        "Head along the road toward your destination",
      );
    },
  );

  it.each([
    ["TURN_SLIGHT_LEFT", "Turn slightly left"],
    ["TURN_SLIGHT_RIGHT", "Turn slightly right"],
    ["TURN_SHARP_LEFT", "Turn sharply left"],
    ["TURN_SHARP_RIGHT", "Turn sharply right"],
    ["KEEP_LEFT", "Keep left"],
    ["KEEP_RIGHT", "Keep right"],
    ["RAMP_LEFT", "Take the ramp on the left"],
    ["RAMP_RIGHT", "Take the ramp on the right"],
    ["RAMP_STRAIGHT", "Continue straight onto the ramp"],
    ["EXIT_LEFT", "Take the exit on the left"],
    ["EXIT_RIGHT", "Take the exit on the right"],
    ["MERGE", "Merge onto the road"],
    ["MERGE_LEFT", "Merge left"],
    ["MERGE_RIGHT", "Merge right"],
    ["ROUNDABOUT_ENTER", "Enter the roundabout"],
    ["ROUNDABOUT_EXIT", "Exit the roundabout"],
    ["UTURN_LEFT", "Make a U-turn"],
    ["UTURN_RIGHT", "Make a U-turn"],
  ])("retains road maneuver semantics for %s", (maneuver, expected) => {
    const result = instructions([
      {
        type: "DRIVE",
        distanceM: 1200,
        polyline: [],
        steps: [
          {
            instruction: "中文上游文案",
            maneuver,
            distanceM: 1200,
            polyline: [],
          },
        ],
      },
    ]);
    expect(result.instructions[0].text).toContain(expected);
    expect(result.instructions[0].text).toContain(
      "then continue for about 1.2 kilometers",
    );
    expect(result.warnings).toEqual([]);
  });

  it("reports unavailable guidance for a legacy road step without a structured maneuver", () => {
    const result = instructions([
      {
        type: "DRIVE",
        distanceM: 10,
        polyline: [],
        steps: [{ instruction: "向左轉", distanceM: 10, polyline: [] }],
      },
    ]);
    expect(result.warnings).toEqual(["ROAD_STEPS_UNAVAILABLE"]);
    expect(result.instructions[0].text).toBe(
      "Continue along the road, then immediately follow the next instruction",
    );
  });

  it("localizes mixed transit instructions and formats rail schedules in Taipei time", () => {
    const result = instructions([
      {
        type: "BUS",
        departureStop: "City Hall",
        arrivalStop: "Central Station",
        routeName: "307",
        estimatedWaitMinutes: 3,
      },
      {
        type: "METRO",
        railSystem: "TRTC",
        lineName: "Blue Line",
        departureStation: "Central Station",
        arrivalStation: "Nangang",
        rideMinutes: 8,
        facilityHighlights: ["電梯"],
      },
      {
        type: "THSR",
        trainNo: "123",
        departureStation: "Nangang",
        arrivalStation: "Taipei",
        departureTime: "2026-10-09T15:55:00Z",
        arrivalTime: "2026-10-09T16:05:00Z",
      },
      {
        type: "TRA",
        trainNo: "456",
        trainTypeName: "Local",
        departureStation: "Taipei",
        arrivalStation: "Banqiao",
        departureTime: "00:20",
        arrivalTime: "00:35",
      },
    ]);
    expect(result.instructions.map((s) => s.text)).toEqual([
      "Wait at City Hall and board bus 307. Estimated wait: about 3 minutes.",
      "Get off at Central Station.",
      "Take Taipei Metro Blue Line from Central Station toward Nangang. The ride takes about 8 minutes. Use the elevator to enter the station.",
      "Get off at Nangang.",
      "Take Taiwan High Speed Rail train 123 from Nangang at 23:55 to Taipei, arriving at 00:05.",
      "Get off at Taipei.",
      "Take Taiwan Railways Local train 456 from Taipei at 00:20 to Banqiao, arriving at 00:35.",
      "Get off at Banqiao.",
      "You have arrived at your destination",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/\p{Script=Han}/u);
  });

  it.each([
    [0, "ahead"],
    [45, "ahead-right"],
    [90, "right"],
    [135, "behind-right"],
    [180, "behind"],
    [225, "behind-left"],
    [270, "left"],
    [315, "ahead-left"],
    [337.5, "ahead"],
  ] as const)("localizes bearing %s", (bearing, expected) => {
    expect(calcRelativeDirection(0, bearing, "en")).toBe(expected);
  });

  it("localizes invalid route and unsupported leg errors", () => {
    expect(
      generateNavInstructions({ legs: [] }, undefined, "en"),
    ).toMatchObject({
      ok: false,
      reason: "INVALID_ROUTE_INPUT",
      message: "The route is invalid or has no legs",
    });
    expect(
      generateNavInstructions({ legs: [{ type: "FERRY" }] }, undefined, "en"),
    ).toMatchObject({
      ok: false,
      reason: "UNSUPPORTED_LEG_TYPE",
      message: "Unsupported route leg type: FERRY",
    });
  });
});
