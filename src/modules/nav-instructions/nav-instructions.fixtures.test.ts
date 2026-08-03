import { describe, expect, it } from "vitest";
import { generateNavInstructions } from "./nav-instructions.service";
import type { NavRouteInput } from "./nav-instructions.types";

const WALK_POLYLINE: [number, number][] = [
  [121.5654, 25.0418],
  [121.5651, 25.0417],
  [121.5648, 25.0421],
  [121.5641, 25.0426],
  [121.5633, 25.0432],
  [121.5620, 25.0455],
];

const OTP_STEP_DISTANCES = [40, 120, 480];

const otpWalkLeg = () => ({
  type: "WALK" as const,
  from: { lat: 25.0418, lng: 121.5654 },
  to: "終點",
  distanceM: 640,
  minutesEst: 9,
  polyline: WALK_POLYLINE,
  a11yFacilities: [],
  steps: [
    {
      relativeDirection: "DEPART",
      absoluteDirection: "NORTHWEST",
      streetName: "open area",
      bogusName: true,
      area: true,
      stairs: false,
      distanceM: OTP_STEP_DISTANCES[0],
      location: WALK_POLYLINE[0],
    },
    {
      relativeDirection: "RIGHT",
      absoluteDirection: "NORTHEAST",
      streetName: "基隆路一段147巷",
      bogusName: false,
      area: false,
      stairs: false,
      distanceM: OTP_STEP_DISTANCES[1],
      location: WALK_POLYLINE[2],
    },
    {
      relativeDirection: "LEFT",
      absoluteDirection: "WEST",
      streetName: "基隆路一段",
      bogusName: false,
      area: false,
      stairs: false,
      distanceM: OTP_STEP_DISTANCES[2],
      location: WALK_POLYLINE[4],
    },
  ],
});

const valhallaWalkLeg = () => ({
  type: "WALK" as const,
  from: { lat: 25.0418, lng: 121.5654 },
  to: "終點",
  distanceM: 1040,
  minutesEst: 14,
  polyline: WALK_POLYLINE,
  a11yFacilities: [],
  steps: [
    {
      instruction: "沿目前道路出發",
      maneuver: "DEPART",
      relativeDirection: "DEPART",
      absoluteDirection: null,
      streetName: "",
      bogusName: true,
      area: false,
      stairs: false,
      distanceM: 40,
      location: WALK_POLYLINE[0],
    },
    {
      instruction: "向左轉進入「庫倫街」",
      maneuver: "TURN_LEFT",
      relativeDirection: "LEFT",
      absoluteDirection: null,
      streetName: "庫倫街",
      bogusName: false,
      area: false,
      stairs: false,
      distanceM: 1000,
      location: WALK_POLYLINE[3],
    },
  ],
});

const otpRoute = (): NavRouteInput => ({
  routeId: "walk-0",
  legs: [otpWalkLeg()],
}) as unknown as NavRouteInput;

const valhallaRoute = (): NavRouteInput => ({
  routeId: "walk-1",
  legs: [valhallaWalkLeg()],
}) as unknown as NavRouteInput;

describe("walk-quality regression contracts", () => {
  it("uses OTP geometry bearings instead of the former eight-direction values", () => {
    const result = generateNavInstructions(otpRoute());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bearings = result.data.instructions
      .map((instruction) => instruction.bearing)
      .filter((bearing): bearing is number => bearing !== null);
    expect(bearings.some((bearing) => bearing % 45 !== 0)).toBe(true);
    expect(result.data.initialBearing % 45).not.toBe(0);
    expect(result.data.instructions.every(
      (instruction) => instruction.legIndex === 0,
    )).toBe(true);
  });

  it("rewrites Valhalla maneuvers as distance-bearing TTS sentences", () => {
    const result = generateNavInstructions(valhallaRoute());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const moving = result.data.instructions.filter(
      (instruction) => instruction.type !== "arrive" && instruction.distanceM !== null,
    );
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.every((instruction) => /馬上|公尺|公里/.test(instruction.text))).toBe(true);
    expect(result.data.instructions.at(-1)?.cumulativeDistanceM).toBe(1040);
  });

  it("keeps waypoint walk legs separate and reclassifies the later DEPART", () => {
    const route: NavRouteInput = {
      routeId: "walk-waypoints",
      legs: [otpWalkLeg(), otpWalkLeg()],
    } as unknown as NavRouteInput;
    const result = generateNavInstructions(route);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secondLeg = result.data.instructions.filter(
      (instruction) => instruction.legIndex === 1,
    );
    expect(secondLeg.length).toBeGreaterThan(0);
    expect(secondLeg[0].type).toBe("turn");
    expect(secondLeg[0].text).not.toContain("出發");
    expect(result.data.instructions.filter((instruction) => instruction.type === "depart"))
      .toHaveLength(1);
  });
});
