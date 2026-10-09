import type { DriveStep, WalkStep } from "../types/route";

/** English speech templates use structured maneuvers, never translated free text. */
const FACILITIES: Record<string, string> = {
  ELEVATOR: "Enter the elevator",
  ESCALATOR: "Take the escalator",
  MOVING_WALKWAY: "Take the moving walkway",
  FARE_GATE: "Go through the fare gate",
  ENTER_STATION: "Enter the station",
  EXIT_STATION: "Exit the station",
};

const TURNS: Record<string, string> = {
  LEFT: "Turn left",
  RIGHT: "Turn right",
  SLIGHTLY_LEFT: "Turn slightly left",
  SLIGHTLY_RIGHT: "Turn slightly right",
  HARD_LEFT: "Turn sharply left",
  HARD_RIGHT: "Turn sharply right",
};

export function englishCompass(bearing: number): string {
  return [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ][Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/** Translate planner-generated labels without guessing translations of place names. */
export function englishPlaceLabel(name: string): string {
  const labels: Record<string, string> = {
    起點: "the starting point",
    出發地: "the starting point",
    終點: "your destination",
    目的地: "your destination",
  };
  return labels[name] ?? name.replace(/^中途點 (\d+)$/, "waypoint $1");
}

function distanceSuffix(distanceM: number): string {
  if (!Number.isFinite(distanceM)) return "";
  if (distanceM < 20) return ", then immediately follow the next instruction";
  const distance =
    distanceM < 1000
      ? `about ${Math.round(distanceM / 10) * 10} meters`
      : `about ${(distanceM / 1000).toFixed(1)} kilometers`;
  return `, then continue for ${distance}`;
}

/** Keep source names intact; the route does not carry translated name pairs. */
export function englishWalkInstruction(
  step: WalkStep,
  bearing: number | null,
  targetStreetName: string | null,
): string {
  const dir = step.relativeDirection.toUpperCase();
  const street = !step.bogusName ? step.streetName.trim() : "";
  const along = street ? ` along ${street}` : "";
  const onto = street ? ` onto ${street}` : "";
  let action: string;
  if (FACILITIES[dir]) action = FACILITIES[dir];
  else {
    if (dir === "DEPART") action = `Head${along || " forward"}`;
    else if (TURNS[dir]) action = TURNS[dir] + onto;
    else if (dir === "UTURN_LEFT" || dir === "UTURN_RIGHT")
      action = "Make a U-turn";
    else if (dir === "CIRCLE_CLOCKWISE")
      action = "Enter the roundabout and continue clockwise";
    else if (dir === "CIRCLE_COUNTERCLOCKWISE")
      action = "Enter the roundabout and continue counterclockwise";
    else
      action = `Continue straight${along}${!street && targetStreetName ? ` toward ${targetStreetName}` : ""}`;
    action += distanceSuffix(step.distanceM);
    if (dir === "DEPART" && bearing !== null) {
      action += `, heading approximately ${bearing} degrees (${englishCompass(bearing)})`;
    }
  }
  if (step.steepSlope) action += "; this section has a steep slope";
  if (step.stairs) action += "; this section includes stairs";
  return action;
}

const ROAD_ACTIONS: Record<string, string> = {
  KEEP_LEFT: "Keep left",
  KEEP_RIGHT: "Keep right",
  UTURN_LEFT: "Make a U-turn",
  UTURN_RIGHT: "Make a U-turn",
  RAMP_LEFT: "Take the ramp on the left",
  RAMP_RIGHT: "Take the ramp on the right",
  RAMP_STRAIGHT: "Continue straight onto the ramp",
  EXIT_LEFT: "Take the exit on the left",
  EXIT_RIGHT: "Take the exit on the right",
  MERGE_LEFT: "Merge left",
  MERGE_RIGHT: "Merge right",
  MERGE: "Merge onto the road",
  ROUNDABOUT_ENTER: "Enter the roundabout and follow the road",
  FERRY_ENTER: "Proceed to the ferry boarding point",
  FERRY_EXIT: "Leave the ferry",
  STAIRS: "Take the stairs",
  ARRIVE: "You have arrived at your destination",
  ...FACILITIES,
};

function roadTurn(code: string): string {
  return code
    .replace(/^TURN_/, "")
    .replace("SLIGHT_", "SLIGHTLY_")
    .replace("SHARP_", "HARD_");
}

export function hasEnglishRoadManeuver(step: DriveStep): boolean {
  const code = step.maneuver?.toUpperCase() ?? "";
  return !!(
    TURNS[roadTurn(code)] ||
    ROAD_ACTIONS[code] ||
    ["DEPART", "ROUNDABOUT_EXIT", "STRAIGHT", "CONTINUE"].includes(code)
  );
}

export function englishRoadInstruction(
  step: DriveStep,
  streetName?: string,
): string {
  const code = step.maneuver?.toUpperCase() ?? "";
  const onto = streetName ? ` onto ${streetName}` : "";
  const along = streetName ? ` along ${streetName}` : " along the road";
  const turn = roadTurn(code);
  const action = TURNS[turn]
    ? TURNS[turn] + onto
    : code === "DEPART"
      ? `Head${along}`
      : code === "ROUNDABOUT_EXIT"
        ? `Exit the roundabout${onto}`
        : (ROAD_ACTIONS[code] ??
          `${code === "STRAIGHT" || code === "CONTINUE" ? "Continue straight" : "Continue"}${along}`);
  return action + distanceSuffix(step.distanceM);
}

export const ENGLISH_RAIL_SYSTEMS: Record<string, string> = {
  TRTC: "Taipei Metro",
  KRTC: "Kaohsiung Metro",
  TMRT: "Taichung Metro",
  NTMC: "New Taipei Metro",
  KLRT: "Kaohsiung Light Rail",
  TYMC: "Taoyuan Metro",
};
