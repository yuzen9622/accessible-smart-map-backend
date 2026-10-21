import { selectDisplayText } from "./source-display";
import { validStreetNames } from "./route-source-names";
import type { WalkStepStreetName } from "../types/route";
import { ResponseCode } from "../types/code";
import { taipeiHHmm } from "../config/taipei-time";
import { calcBearing, degToCompassWord, haversineCoords } from "./geo";
import type {
  BusLeg,
  DriveLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WalkAbsoluteDirection,
  WalkLeg,
  WalkStep,
} from "../types/route";

import type {
  RelativeDirection,
  NavInstructionType,
  NavLegType,
  NavInstruction,
  NavRouteInput,
  GenerateNavResult,
  NavWarningCode,
} from "../modules/nav-instructions/nav-instructions.types";

import { formatWalkStepInstruction } from "./transit-text";
import { DEFAULT_LANG, type SupportedLang } from "../types/lang";
import {
  englishPlaceLabel,
  englishCompass,
  englishWalkInstruction,
  englishRoadInstruction,
  hasEnglishRoadManeuver,
  ENGLISH_RAIL_SYSTEMS,
} from "./nav-instructions-english";
import { NAV_API_MSG, NAV_MSG } from "../constants/messages";

/**
 * Pure route-step normalization and route-to-instructions engine shared by
 * `accessible-route` and `nav-instructions` (the
 * `POST /a11y/route/instructions` endpoint). Lives outside `src/modules/`
 * — the same neutral-layer convention as `src/schemas/route-intent.schema.ts`
 * — because owning it inside either module would force the other to import
 * upward and close a module dependency cycle (nav-instructions already
 * depends on accessible-route's `route-token.service` for token resolution).
 */

export { calcBearing, degToCompassWord };

export const WARN_STEPS_UNAVAILABLE = "ORS_STEPS_UNAVAILABLE";
export const WARN_WALK_STEPS_UNAVAILABLE = "WALK_STEPS_UNAVAILABLE";
export const WARN_ROAD_STEPS_UNAVAILABLE = "ROAD_STEPS_UNAVAILABLE";

export const WALK_RELATIVE_DIRECTION_VALUES = [
  "DEPART",
  "CONTINUE",
  "STRAIGHT",
  "LEFT",
  "RIGHT",
  "SLIGHTLY_LEFT",
  "SLIGHTLY_RIGHT",
  "HARD_LEFT",
  "HARD_RIGHT",
  "UTURN_LEFT",
  "UTURN_RIGHT",
  "CIRCLE_CLOCKWISE",
  "CIRCLE_COUNTERCLOCKWISE",
  "ELEVATOR",
  "ESCALATOR",
  "MOVING_WALKWAY",
  "FARE_GATE",
  "ENTER_STATION",
  "EXIT_STATION",
] as const;

export type WalkRelativeDirection =
  (typeof WALK_RELATIVE_DIRECTION_VALUES)[number];

export const WALK_ABSOLUTE_DIRECTION_VALUES = [
  "NORTH",
  "NORTHEAST",
  "EAST",
  "SOUTHEAST",
  "SOUTH",
  "SOUTHWEST",
  "WEST",
  "NORTHWEST",
] as const;

const WALK_RELATIVE_DIRECTION_SET = new Set<string>(
  WALK_RELATIVE_DIRECTION_VALUES,
);
const WALK_ABSOLUTE_DIRECTION_SET = new Set<string>(
  WALK_ABSOLUTE_DIRECTION_VALUES,
);

/** Normalizes arbitrary upstream turn tokens to the public walk-step vocabulary. */
export function normalizeRelativeDirection(
  raw: string | null | undefined,
): WalkRelativeDirection {
  const value = raw?.trim().toUpperCase();
  return value && WALK_RELATIVE_DIRECTION_SET.has(value)
    ? (value as WalkRelativeDirection)
    : "CONTINUE";
}

/** Normalizes an upstream compass token to the public eight-point vocabulary. */
export function normalizeAbsoluteDirection(
  raw: string | null | undefined,
): WalkAbsoluteDirection | null {
  const value = raw?.trim().toUpperCase();
  return value && WALK_ABSOLUTE_DIRECTION_SET.has(value)
    ? (value as WalkAbsoluteDirection)
    : null;
}

const BEARING_SAMPLE_DISTANCE_M = 20;
const STAIRS_NOTICE = "，此路段含樓梯";

type PendingNavInstruction = Omit<
  NavInstruction,
  "legIndex" | "cumulativeDistanceM"
>;

function pushWarning(
  warnings: NavWarningCode[],
  warning: NavWarningCode,
): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

const KNOWN_LEG_TYPES = new Set<NavLegType>([
  "WALK",
  "DRIVE",
  "MOTORCYCLE",
  "BUS",
  "METRO",
  "THSR",
  "TRA",
]);

const COMPASS_TO_DEG: Record<string, number> = {
  NORTH: 0,
  NORTHEAST: 45,
  EAST: 90,
  SOUTHEAST: 135,
  SOUTH: 180,
  SOUTHWEST: 225,
  WEST: 270,
  NORTHWEST: 315,
};

const RAIL_SYSTEM_NAMES: Record<string, string> = {
  TRTC: "台北捷運",
  KRTC: "高雄捷運",
  TMRT: "台中捷運",
  NTMC: "新北捷運",
  KLRT: "高雄輕軌",
  TYMC: "桃園捷運",
};

/**
 * 以使用者當前朝向（heading）與目標方位角（bearing）計算八方位相對方向。
 * @param heading 使用者當前朝向（度，正北 = 0，順時針）
 * @param bearing 目標方位角（度，正北 = 0，順時針）
 * @returns 八方位文字，預設繁體中文，英文由 language 選擇
 */
export function calcRelativeDirection(
  heading: number,
  bearing: number,
  language: SupportedLang = DEFAULT_LANG,
): RelativeDirection {
  const diff = (bearing - heading + 360) % 360;
  if (language === "en") {
    const directions: RelativeDirection[] = [
      "ahead",
      "ahead-right",
      "right",
      "behind-right",
      "behind",
      "behind-left",
      "left",
      "ahead-left",
    ];
    return directions[Math.round(diff / 45) % 8];
  }
  if (diff < 22.5 || diff >= 337.5) return "正前方";
  if (diff < 67.5) return "右前方";
  if (diff < 112.5) return "右側";
  if (diff < 157.5) return "右後方";
  if (diff < 202.5) return "正後方";
  if (diff < 247.5) return "左後方";
  if (diff < 292.5) return "左側";
  return "左前方";
}

function absoluteDirectionToDeg(dir: string | null): number | null {
  if (!dir) return null;
  const deg = COMPASS_TO_DEG[dir.toUpperCase()];
  return deg ?? null;
}

function hasStreetName(step: WalkStep): boolean {
  return !step.bogusName && !!step.streetName && step.streetName.trim() !== "";
}

function stepBearing(
  step: WalkStep,
  polyline: [number, number][],
  polylineIndex: number | null,
): number | null {
  if (polylineIndex !== null && polylineIndex < polyline.length - 1) {
    const start = polyline[polylineIndex];
    let accumulated = 0;
    let target: [number, number] | null = null;
    for (let index = polylineIndex + 1; index < polyline.length; index++) {
      accumulated += haversineCoords(polyline[index - 1], polyline[index]);
      if (polyline[index][0] !== start[0] || polyline[index][1] !== start[1]) {
        target = polyline[index];
      }
      if (accumulated >= BEARING_SAMPLE_DISTANCE_M) break;
    }
    if (target) return Math.round(calcBearing(start, target));
  }
  return absoluteDirectionToDeg(step.absoluteDirection);
}

export function nearestPolylineIndex(
  polyline: [number, number][],
  loc: [number, number],
  startIndex = 0,
): number | null {
  if (!polyline.length) return null;
  const first = Math.min(Math.max(0, startIndex), polyline.length - 1);
  let best = first;
  let bestDist = Infinity;
  const cosLat = Math.cos((loc[1] * Math.PI) / 180);
  for (let i = first; i < polyline.length; i++) {
    const dx = (polyline[i][0] - loc[0]) * cosLat;
    const dy = polyline[i][1] - loc[1];
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function isFacilityDirection(relativeDirection: string): boolean {
  const direction = relativeDirection.toUpperCase();
  return (
    direction === "ELEVATOR" ||
    direction === "ENTER_STATION" ||
    direction === "EXIT_STATION" ||
    direction === "ESCALATOR" ||
    direction === "MOVING_WALKWAY" ||
    direction === "FARE_GATE"
  );
}

const stepOrigins = new WeakMap<WalkStep, number[]>();
function inheritStep(step: WalkStep, source: WalkStep): WalkStep {
  stepOrigins.set(step, stepOrigins.get(source) ?? []);
  return step;
}

/** Remap only validated source provenance through canonical merge operations. */
export function normalizedStreetNames(
  leg: WalkLeg,
  steps: WalkStep[],
  language?: SupportedLang,
): WalkStepStreetName[] {
  const valid = validStreetNames(leg);
  return steps.flatMap((step, index) => {
    const origins = stepOrigins.get(step) ?? [];
    const entries = origins.map((origin) => valid.get(origin));
    const first = entries[0];
    if (
      !first ||
      entries.some(
        (e) =>
          !e || e.nameEn !== first.nameEn || e.streetName !== step.streetName,
      )
    )
      return [];
    return [
      {
        index,
        streetName: step.streetName,
        nameEn: first.nameEn,
        displayName: selectDisplayText(step.streetName, first.nameEn, language),
      },
    ];
  });
}

function mergeWalkSteps(steps: WalkStep[]): WalkStep[] {
  const merged: WalkStep[] = [];
  for (const step of steps) {
    const direction = step.relativeDirection.toUpperCase();
    const previous = merged.at(-1);
    const previousDirection = previous?.relativeDirection.toUpperCase();
    const mergeableDirection =
      direction === "CONTINUE" || direction === "STRAIGHT";
    const previousContinues =
      previousDirection === "CONTINUE" || previousDirection === "STRAIGHT";
    const streetName = step.streetName?.trim() ?? "";
    const startsDifferentNamedStreet =
      !step.bogusName &&
      streetName !== "" &&
      streetName !== (previous?.streetName?.trim() ?? "");
    if (
      previous &&
      mergeableDirection &&
      previous.stairs === step.stairs &&
      !startsDifferentNamedStreet &&
      !isFacilityDirection(previous.relativeDirection) &&
      (previousContinues || step.distanceM < 15)
    ) {
      stepOrigins.set(previous, [
        ...(stepOrigins.get(previous) ?? []),
        ...(stepOrigins.get(step) ?? []),
      ]);
      previous.distanceM += step.distanceM;
      previous.steepSlope = previous.steepSlope || step.steepSlope;
      continue;
    }
    merged.push(inheritStep({ ...step }, step));
  }
  return merged;
}

function prepareWalkSteps(leg: WalkLeg, isFirstLeg: boolean): WalkStep[] {
  const steps = (leg.steps ?? []).map((step, index): WalkStep => {
    const initialDirection = normalizeRelativeDirection(step.relativeDirection);
    const relativeDirection =
      !isFirstLeg && index === 0 && initialDirection === "DEPART"
        ? "CONTINUE"
        : initialDirection;
    const prepared: WalkStep = {
      relativeDirection,
      absoluteDirection: normalizeAbsoluteDirection(step.absoluteDirection),
      streetName: typeof step.streetName === "string" ? step.streetName : "",
      bogusName: step.bogusName === true,
      area: step.area === true,
      stairs: step.stairs === true,
      steepSlope: step.steepSlope === true,
      distanceM:
        typeof step.distanceM === "number" && Number.isFinite(step.distanceM)
          ? step.distanceM
          : 0,
      location: step.location,
    };
    stepOrigins.set(prepared, [index]);
    return prepared;
  });
  return mergeWalkSteps(steps);
}

/**
 * Merges one WALK leg's steps while emitting only the public machine fields.
 * An empty result means the leg had no usable source steps.
 */
export function normalizeWalkLegSteps(
  leg: WalkLeg,
  isFirstLeg: boolean,
): WalkStep[] {
  return prepareWalkSteps(leg, isFirstLeg);
}

function stepType(relativeDirection: string): NavInstructionType {
  const dir = relativeDirection.toUpperCase();
  if (isFacilityDirection(dir)) {
    return "facility";
  }
  if (dir === "DEPART") return "depart";
  return "turn";
}

function stripTrailingNotice(text: string, notice: string): string {
  return text.endsWith(notice) ? text.slice(0, -notice.length) : text;
}

function walkStepText(
  step: WalkStep,
  bearing: number | null,
  targetStreetName: string | null,
  language: SupportedLang,
): string {
  if (language === "en")
    return englishWalkInstruction(step, bearing, targetStreetName);
  const compass =
    bearing !== null &&
    (step.relativeDirection ?? "").toUpperCase() === "DEPART"
      ? `，方位約 ${bearing} 度（${degToCompassWord(bearing)}）`
      : "";
  const facilityText: Record<string, string> = {
    ELEVATOR: NAV_MSG.ELEVATOR,
    ESCALATOR: NAV_MSG.ESCALATOR,
    MOVING_WALKWAY: NAV_MSG.MOVING_WALKWAY,
    FARE_GATE: NAV_MSG.FARE_GATE,
    ENTER_STATION: NAV_MSG.ENTER_STATION,
    EXIT_STATION: NAV_MSG.EXIT_STATION,
  };
  const baseText =
    facilityText[step.relativeDirection] ??
    formatWalkStepInstruction({ ...step, targetStreetName }) + compass;
  let normalizedText = stripTrailingNotice(baseText, STAIRS_NOTICE);
  normalizedText = stripTrailingNotice(normalizedText, NAV_MSG.SLOPE_NOTICE);
  if (step.steepSlope) normalizedText += NAV_MSG.SLOPE_NOTICE;
  if (step.stairs) normalizedText += STAIRS_NOTICE;
  return normalizedText;
}

function roadStepType(maneuver: string | undefined): NavInstructionType {
  return maneuver?.toUpperCase() === "DEPART" ? "depart" : "turn";
}

function roadLegToInstructions(
  leg: DriveLeg,
  isFirstLeg: boolean,
  warnings: NavWarningCode[],
  language: SupportedLang,
): PendingNavInstruction[] {
  const steps = leg.steps ?? [];
  if (!steps.length) {
    pushWarning(warnings, WARN_ROAD_STEPS_UNAVAILABLE);
    const bearing =
      leg.polyline.length >= 2
        ? Math.round(calcBearing(leg.polyline[0], leg.polyline[1]))
        : null;
    return [
      {
        text:
          language === "en"
            ? isFirstLeg
              ? "Head along the road toward your destination"
              : "Continue along the road toward your destination"
            : isFirstLeg
              ? "請沿道路出發，前往目的地"
              : "請沿道路繼續前往目的地",
        type: isFirstLeg ? "depart" : "turn",
        bearing,
        relativeDirection: null,
        maneuver: null,
        distanceM: leg.distanceM,
        streetName: null,
        legType: leg.type,
        stairs: false,
        polylineIndex: bearing === null ? null : 0,
      },
    ];
  }

  let searchIndex = 0;
  // The road planner builds steps from this same list, excluding arrival maneuvers.
  const maneuvers = leg.maneuvers?.filter(
    (maneuver) => ![4, 5, 6].includes(maneuver.type),
  );
  return steps.map((step, index) => {
    if (language === "en" && !hasEnglishRoadManeuver(step)) {
      pushWarning(warnings, WARN_ROAD_STEPS_UNAVAILABLE);
    }
    const bearing =
      step.polyline.length >= 2
        ? Math.round(calcBearing(step.polyline[0], step.polyline[1]))
        : null;
    const polylineIndex =
      step.polyline[0] && leg.polyline.length
        ? nearestPolylineIndex(leg.polyline, step.polyline[0], searchIndex)
        : null;
    if (polylineIndex !== null) searchIndex = polylineIndex;
    return {
      text:
        language === "en"
          ? englishRoadInstruction(
              step,
              maneuvers?.[index]?.streetNames?.[0]?.trim(),
            )
          : step.instruction.trim() || "請沿道路繼續前行",
      type: roadStepType(step.maneuver),
      bearing,
      relativeDirection: null,
      maneuver: null,
      distanceM: step.distanceM,
      streetName: null,
      legType: leg.type,
      stairs: false,
      polylineIndex,
    };
  });
}

function exitInfoInstruction(
  exitInfo: NonNullable<WalkLeg["exitInfo"]>,
  language: SupportedLang,
): PendingNavInstruction {
  const label = exitInfo.exitNumber ? `${exitInfo.exitNumber} 出口` : "出口";
  const englishLabel = exitInfo.exitNumber
    ? `exit ${exitInfo.exitNumber}`
    : "the exit";
  const text =
    language === "en"
      ? exitInfo.type === "elevator"
        ? `The elevator for ${englishLabel} is ahead. Enter the elevator`
        : `The ramp for ${englishLabel} is ahead. Follow the ramp`
      : exitInfo.type === "elevator"
        ? `前方為 ${label}電梯，請進入電梯`
        : `前方為 ${label}坡道，請沿坡道前進`;
  return {
    text,
    type: "facility",
    bearing: null,
    relativeDirection: null,
    maneuver: null,
    distanceM: null,
    streetName: null,
    legType: "WALK",
    stairs: false,
    polylineIndex: null,
  };
}

interface BuiltWalkStep {
  step: WalkStep;
  text: string;
  type: NavInstructionType;
  bearing: number | null;
  polylineIndex: number | null;
}

/**
 * Merges and turns one WALK leg's raw `steps` into a flat,
 * ordered list — the single computation shared by `walkLegToInstructions`
 * (feeding `POST /a11y/route/instructions` and the voice engine) and
 * `normalizeWalkLegSteps` (feeding `leg.steps` itself). Returns `[]` when the
 * leg has no usable raw steps, letting
 * callers fall back to their own leg-level guidance.
 */
function buildWalkInstructionSteps(
  leg: WalkLeg,
  isFirstLeg: boolean,
  language: SupportedLang,
): BuiltWalkStep[] {
  const polyline = leg.polyline ?? [];
  const steps = normalizeWalkLegSteps(leg, isFirstLeg);
  if (steps.length === 0) return [];
  const names = new Map(
    normalizedStreetNames(leg, steps, language).map((entry) => [
      entry.index,
      entry.displayName,
    ]),
  );
  let searchIndex = 0;
  return steps.map((step, i) => {
    const polylineIndex = nearestPolylineIndex(
      polyline,
      step.location,
      searchIndex,
    );
    if (polylineIndex !== null) searchIndex = polylineIndex;
    const bearing = stepBearing(step, polyline, polylineIndex);
    const type = stepType(step.relativeDirection ?? "CONTINUE");
    const nextIndex = steps.findIndex(
      (candidate, index) => index > i && hasStreetName(candidate),
    );
    const nextNamed =
      nextIndex < 0
        ? null
        : (names.get(nextIndex) ?? steps[nextIndex].streetName.trim());
    return {
      step,
      text: walkStepText(
        { ...step, streetName: names.get(i) ?? step.streetName },
        bearing,
        nextNamed,
        language,
      ),
      type,
      bearing,
      polylineIndex,
    };
  });
}

function walkLegToInstructions(
  leg: WalkLeg,
  isFirstLeg: boolean,
  warnings: NavWarningCode[],
  language: SupportedLang,
): PendingNavInstruction[] {
  const out: PendingNavInstruction[] = [];
  const polyline = leg.polyline ?? [];
  const built = buildWalkInstructionSteps(leg, isFirstLeg, language);

  if (built.length > 0) {
    built.forEach(({ step, text, type, bearing, polylineIndex }) => {
      out.push({
        text,
        type,
        bearing: type === "facility" ? null : bearing,
        relativeDirection: null,
        maneuver: normalizeRelativeDirection(step.relativeDirection),
        distanceM: step.distanceM ?? null,
        streetName: hasStreetName(step) ? step.streetName.trim() : null,
        legType: "WALK",
        stairs: step.stairs,
        polylineIndex,
      });
    });
  } else {
    const bearing =
      polyline.length >= 2
        ? Math.round(calcBearing(polyline[0], polyline[1]))
        : null;
    const heading = bearing !== null ? degToCompassWord(bearing) : "前";
    out.push({
      text:
        language === "en"
          ? isFirstLeg
            ? `Head ${bearing !== null ? englishCompass(bearing) : "forward"} toward ${englishPlaceLabel(selectDisplayText(leg.to, leg.toNameEn, language))}`
            : `Continue toward ${englishPlaceLabel(selectDisplayText(leg.to, leg.toNameEn, language))}`
          : isFirstLeg
            ? `請朝${heading}方向出發，沿路前往「${selectDisplayText(leg.to, leg.toNameEn, language)}」`
            : `請沿路前往「${selectDisplayText(leg.to, leg.toNameEn, language)}」`,
      type: isFirstLeg ? "depart" : "turn",
      bearing,
      relativeDirection: null,
      maneuver: null,
      distanceM: leg.distanceM ?? null,
      streetName: null,
      legType: "WALK",
      stairs: false,
      polylineIndex: bearing !== null ? 0 : null,
    });
    pushWarning(warnings, WARN_WALK_STEPS_UNAVAILABLE);
    pushWarning(warnings, WARN_STEPS_UNAVAILABLE);
  }

  if (leg.exitInfo) {
    out.push(exitInfoInstruction(leg.exitInfo, language));
  }
  return out;
}

function transitInstruction(
  text: string,
  type: NavInstructionType,
  legType: NavLegType,
): PendingNavInstruction {
  return {
    text,
    type,
    bearing: null,
    relativeDirection: null,
    maneuver: null,
    distanceM: null,
    streetName: null,
    legType,
    stairs: false,
    polylineIndex: null,
  };
}

function railSystemName(code: string): string {
  return RAIL_SYSTEM_NAMES[code?.toUpperCase()] ?? code ?? "捷運";
}

function displayTime(value?: string): string {
  if (!value) return "";
  const hhmm = /^\d{1,2}:\d{2}/.exec(value);
  if (hhmm) return hhmm[0];
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return taipeiHHmm(date);
  }
  return value;
}

function busInstructions(
  leg: BusLeg,
  language: SupportedLang,
): PendingNavInstruction[] {
  if (language === "en") {
    const wait =
      typeof leg.estimatedWaitMinutes === "number" &&
      leg.estimatedWaitMinutes > 0
        ? ` Estimated wait: about ${leg.estimatedWaitMinutes} minutes.`
        : "";
    return [
      transitInstruction(
        `Wait at ${selectDisplayText(leg.departureStop, leg.fromNameEn, language)} and board bus ${selectDisplayText(leg.routeName, leg.routeNameEn, language)}.${wait}`,
        "transit_board",
        "BUS",
      ),
      transitInstruction(
        `Get off at ${selectDisplayText(leg.arrivalStop, leg.toNameEn, language)}.`,
        "transit_alight",
        "BUS",
      ),
    ];
  }
  const waitText =
    typeof leg.estimatedWaitMinutes === "number" && leg.estimatedWaitMinutes > 0
      ? `，預估等候約 ${leg.estimatedWaitMinutes} 分鐘`
      : "";
  const board = `請在「${selectDisplayText(leg.departureStop, leg.fromNameEn, language)}」站牌等候，搭乘公車「${selectDisplayText(leg.routeName, leg.routeNameEn, language)}」${waitText}。`;
  const alight = `抵達「${selectDisplayText(leg.arrivalStop, leg.toNameEn, language)}」站後請下車。`;
  return [
    transitInstruction(board, "transit_board", "BUS"),
    transitInstruction(alight, "transit_alight", "BUS"),
  ];
}

function metroInstructions(
  leg: MetroLeg,
  language: SupportedLang,
): PendingNavInstruction[] {
  if (language === "en") {
    const system =
      ENGLISH_RAIL_SYSTEMS[leg.railSystem?.toUpperCase()] ??
      leg.railSystem ??
      "Metro";
    const ride = leg.rideMinutes
      ? ` The ride takes about ${leg.rideMinutes} minutes.`
      : "";
    const facility = leg.facilityHighlights?.some((f) =>
      /電梯|elevator/i.test(f),
    )
      ? " Use the elevator to enter the station."
      : " Check the station's accessible facilities before entering.";
    return [
      transitInstruction(
        `Take ${system} ${selectDisplayText(leg.lineName, leg.routeNameEn, language)} from ${selectDisplayText(leg.departureStation, leg.fromNameEn, language)} toward ${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}.${ride}${facility}`,
        "transit_board",
        "METRO",
      ),
      transitInstruction(
        `Get off at ${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}.`,
        "transit_alight",
        "METRO",
      ),
    ];
  }
  const system = railSystemName(leg.railSystem);
  const ride = leg.rideMinutes ? `，行駛約 ${leg.rideMinutes} 分鐘` : "";
  const facility = leg.facilityHighlights?.some((f) => f.includes("電梯"))
    ? "請優先使用電梯進站。"
    : "請留意進站無障礙設施狀況。";
  const board = `請搭乘${system}「${selectDisplayText(leg.lineName, leg.routeNameEn, language)}」，在「${selectDisplayText(leg.departureStation, leg.fromNameEn, language)}」站上車，往「${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}」方向${ride}。${facility}`;
  const alight = `請在「${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "METRO"),
    transitInstruction(alight, "transit_alight", "METRO"),
  ];
}

function thsrInstructions(
  leg: ThsrLeg,
  language: SupportedLang,
): PendingNavInstruction[] {
  const dep = displayTime(leg.departureTime);
  const arr = displayTime(leg.arrivalTime);
  if (language === "en") {
    return [
      transitInstruction(
        `Take Taiwan High Speed Rail train ${leg.trainNo} from ${selectDisplayText(leg.departureStation, leg.fromNameEn, language)}${dep ? ` at ${dep}` : ""} to ${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}${arr ? `, arriving at ${arr}` : ""}.`,
        "transit_board",
        "THSR",
      ),
      transitInstruction(
        `Get off at ${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}.`,
        "transit_alight",
        "THSR",
      ),
    ];
  }
  const depText = dep ? `預計 ${dep} ` : "";
  const arrText = arr ? `，${arr} 抵達` : "，抵達";
  const board = `請搭乘高鐵 ${leg.trainNo} 次列車，${depText}由「${selectDisplayText(leg.departureStation, leg.fromNameEn, language)}」出發${arrText}「${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}」。`;
  const alight = `請在「${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "THSR"),
    transitInstruction(alight, "transit_alight", "THSR"),
  ];
}

function traInstructions(
  leg: TraLeg,
  language: SupportedLang,
): PendingNavInstruction[] {
  const dep = displayTime(leg.departureTime);
  const arr = displayTime(leg.arrivalTime);
  if (language === "en") {
    return [
      transitInstruction(
        `Take Taiwan Railways ${selectDisplayText(leg.trainTypeName, leg.routeNameEn, language) ? `${selectDisplayText(leg.trainTypeName, leg.routeNameEn, language)} ` : ""}train ${leg.trainNo} from ${selectDisplayText(leg.departureStation, leg.fromNameEn, language)}${dep ? ` at ${dep}` : ""} to ${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}${arr ? `, arriving at ${arr}` : ""}.`,
        "transit_board",
        "TRA",
      ),
      transitInstruction(
        `Get off at ${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}.`,
        "transit_alight",
        "TRA",
      ),
    ];
  }
  const depText = dep ? `預計 ${dep} ` : "";
  const arrText = arr ? `，${arr} 抵達` : "，抵達";
  const trainType = selectDisplayText(
    leg.trainTypeName,
    leg.routeNameEn,
    language,
  )
    ? `${selectDisplayText(leg.trainTypeName, leg.routeNameEn, language)} `
    : "";
  const board = `請搭乘台鐵${trainType}${leg.trainNo} 次，${depText}由「${selectDisplayText(leg.departureStation, leg.fromNameEn, language)}」出發${arrText}「${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}」。`;
  const alight = `請在「${selectDisplayText(leg.arrivalStation, leg.toNameEn, language)}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "TRA"),
    transitInstruction(alight, "transit_alight", "TRA"),
  ];
}

/**
 * 將一條 AccessibleRoute 攤平為有序的逐步導航指引陣列。步行段優先採用路由
 * 引擎回傳的 steps（OTP `WalkLeg.steps`）；無 steps 時降級為簡化指引並回報警告。
 * 提供 `userHeading` 時，為每個含 bearing 的步驟填入八方位相對方向。
 * @param route 含 legs 的路線物件（由 /accessible-route passthrough）
 * @param userHeading 使用者當前朝向（度，正北 = 0，順時針），選用
 * @param language 指引文字語言，預設 zh-TW
 * @returns 成功時回傳指引結果，失敗時回傳錯誤碼與訊息
 */
export function generateNavInstructions(
  route: NavRouteInput,
  userHeading?: number,
  language: SupportedLang = DEFAULT_LANG,
): GenerateNavResult {
  const voiceResult = generateNavStepsWithLegIndex(route, language);
  if (!voiceResult.ok) return voiceResult;
  const instructions = voiceResult.steps.map(({ instruction }) => ({
    ...instruction,
  }));

  if (typeof userHeading === "number") {
    for (const instruction of instructions) {
      if (instruction.bearing !== null) {
        instruction.relativeDirection = calcRelativeDirection(
          userHeading,
          instruction.bearing,
          language,
        );
      }
    }
  }

  const initialBearing =
    instructions.find((i) => i.bearing !== null)?.bearing ?? 0;

  return {
    ok: true,
    data: {
      instructions,
      initialBearing,
      totalSteps: instructions.length,
      warnings: voiceResult.warnings,
    },
  };
}

export interface VoiceNavStep {
  instruction: NavInstruction;
  legIndex: number;
}

export type GenerateVoiceNavStepsResult =
  | { ok: true; steps: VoiceNavStep[]; warnings: NavWarningCode[] }
  | Extract<GenerateNavResult, { ok: false }>;

/**
 * Voice-only internal mapping that preserves each flattened instruction's
 * source leg without changing the public NavInstruction/OpenAPI contract.
 */
export function generateNavStepsWithLegIndex(
  route: NavRouteInput,
  language: SupportedLang = DEFAULT_LANG,
): GenerateVoiceNavStepsResult {
  const legs = route?.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      reason: "INVALID_ROUTE_INPUT",
      message: NAV_API_MSG[language].INVALID_ROUTE,
    };
  }

  for (const leg of legs) {
    const type = (leg as { type?: string })?.type;
    if (!type || !KNOWN_LEG_TYPES.has(type as NavLegType)) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        reason: "UNSUPPORTED_LEG_TYPE",
        message: NAV_API_MSG[language].UNSUPPORTED_LEG(type),
      };
    }
  }

  const warnings: NavWarningCode[] = [];
  const pendingSteps: Array<{
    instruction: PendingNavInstruction;
    legIndex: number;
  }> = [];

  legs.forEach((rawLeg, legIndex) => {
    const leg = rawLeg as
      WalkLeg | DriveLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg;
    switch (leg.type) {
      case "WALK":
        pendingSteps.push(
          ...walkLegToInstructions(
            leg,
            pendingSteps.length === 0,
            warnings,
            language,
          ).map((instruction) => ({ instruction, legIndex })),
        );
        break;
      case "DRIVE":
      case "MOTORCYCLE":
        pendingSteps.push(
          ...roadLegToInstructions(
            leg,
            pendingSteps.length === 0,
            warnings,
            language,
          ).map((instruction) => ({ instruction, legIndex })),
        );
        break;
      case "BUS":
        pendingSteps.push(
          ...busInstructions(leg, language).map((instruction) => ({
            instruction,
            legIndex,
          })),
        );
        break;
      case "METRO":
        pendingSteps.push(
          ...metroInstructions(leg, language).map((instruction) => ({
            instruction,
            legIndex,
          })),
        );
        break;
      case "THSR":
        pendingSteps.push(
          ...thsrInstructions(leg, language).map((instruction) => ({
            instruction,
            legIndex,
          })),
        );
        break;
      case "TRA":
        pendingSteps.push(
          ...traInstructions(leg, language).map((instruction) => ({
            instruction,
            legIndex,
          })),
        );
        break;
    }
  });

  pendingSteps.push({
    legIndex: legs.length - 1,
    instruction: {
      text: NAV_API_MSG[language].ARRIVE,
      type: "arrive",
      bearing: null,
      relativeDirection: null,
      maneuver: null,
      distanceM: null,
      streetName: null,
      legType: (legs[legs.length - 1] as { type: NavLegType }).type,
      stairs: false,
      polylineIndex: null,
    },
  });
  let cumulativeDistanceM = 0;
  const steps: VoiceNavStep[] = pendingSteps.map(
    ({ instruction, legIndex }) => {
      const complete: NavInstruction = {
        ...instruction,
        legIndex,
        cumulativeDistanceM: Math.round(cumulativeDistanceM),
      };
      if (instruction.distanceM !== null) {
        cumulativeDistanceM += instruction.distanceM;
      }
      return { instruction: complete, legIndex };
    },
  );
  return { ok: true, steps, warnings };
}
