import { ResponseCode } from "../../types/code";
import { haversineCoords } from "../../utils/geo";
import type {
  BusLeg,
  DriveLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WalkLeg,
  WalkStep,
} from "../../types/route";

import type {
  RelativeDirection,
  NavInstructionType,
  NavLegType,
  NavInstruction,
  NavInstructionsResult,
  NavRouteInput,
  NavInstructionsInput,
  GenerateNavResult,
  NavWarningCode,
} from "./nav-instructions.types";

export type {
  RelativeDirection,
  NavInstructionType,
  NavLegType,
  NavInstruction,
  NavInstructionsResult,
  NavRouteInput,
  NavInstructionsInput,
  GenerateNavResult,
  NavWarningCode,
};

export const WARN_STEPS_UNAVAILABLE = "ORS_STEPS_UNAVAILABLE";
export const WARN_WALK_STEPS_UNAVAILABLE = "WALK_STEPS_UNAVAILABLE";
export const WARN_ROAD_STEPS_UNAVAILABLE = "ROAD_STEPS_UNAVAILABLE";
const BEARING_SAMPLE_DISTANCE_M = 20;
const MAX_WALK_PROMPT_DISTANCE_M = 300;
const STAIRS_NOTICE = "，此路段含樓梯";

type PendingNavInstruction = Omit<
  NavInstruction,
  "legIndex" | "cumulativeDistanceM"
>;

function pushWarning(warnings: NavWarningCode[], warning: NavWarningCode): void {
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

const COMPASS_WORDS = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];

const RAIL_SYSTEM_NAMES: Record<string, string> = {
  TRTC: "台北捷運",
  KRTC: "高雄捷運",
  TMRT: "台中捷運",
  NTMC: "新北捷運",
  KLRT: "高雄輕軌",
  TYMC: "桃園捷運",
};

/**
 * 計算從點 A 到點 B 的初始方位角（forward azimuth，度，0–359，正北 = 0，順時針）。
 * @param from 起點 [lng, lat]
 * @param to 終點 [lng, lat]
 * @returns 方位角（度）
 */
export function calcBearing(
  from: [number, number],
  to: [number, number],
): number {
  const [lng1, lat1] = from.map((v) => (v * Math.PI) / 180);
  const [lng2, lat2] = to.map((v) => (v * Math.PI) / 180);
  const dLng = lng2 - lng1;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * 以使用者當前朝向（heading）與目標方位角（bearing）計算八方位相對方向。
 * @param heading 使用者當前朝向（度，正北 = 0，順時針）
 * @param bearing 目標方位角（度，正北 = 0，順時針）
 * @returns 八方位中文字串
 */
export function calcRelativeDirection(
  heading: number,
  bearing: number,
): RelativeDirection {
  const diff = (bearing - heading + 360) % 360;
  if (diff < 22.5 || diff >= 337.5) return "正前方";
  if (diff < 67.5) return "右前方";
  if (diff < 112.5) return "右側";
  if (diff < 157.5) return "右後方";
  if (diff < 202.5) return "正後方";
  if (diff < 247.5) return "左後方";
  if (diff < 292.5) return "左側";
  return "左前方";
}

/**
 * 將正北方位角（度）轉為八方位中文詞（北 / 東北 / …）。
 * @param deg 方位角（度）
 * @returns 八方位中文詞
 */
export function degToCompassWord(deg: number): string {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_WORDS[idx];
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
  return direction === "ELEVATOR" ||
    direction === "ENTER_STATION" ||
    direction === "EXIT_STATION";
}

function mergeWalkSteps(steps: WalkStep[]): WalkStep[] {
  const merged: WalkStep[] = [];
  for (const step of steps) {
    const direction = step.relativeDirection.toUpperCase();
    const previous = merged.at(-1);
    const previousDirection = previous?.relativeDirection.toUpperCase();
    const mergeableDirection = direction === "CONTINUE" || direction === "STRAIGHT";
    const previousContinues = previousDirection === "CONTINUE" || previousDirection === "STRAIGHT";
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
      previous.distanceM += step.distanceM;
      continue;
    }
    merged.push({ ...step });
  }
  return merged;
}

function splitLongWalkSteps(
  steps: WalkStep[],
  polyline: [number, number][],
): WalkStep[] {
  const expanded: WalkStep[] = [];
  let searchIndex = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const startIndex = nearestPolylineIndex(polyline, step.location, searchIndex);
    if (startIndex !== null) searchIndex = startIndex;
    const nextLocation = steps[index + 1]?.location;
    const endIndex = nextLocation
      ? nearestPolylineIndex(polyline, nextLocation, startIndex ?? searchIndex)
      : polyline.length - 1;
    if (
      step.distanceM <= MAX_WALK_PROMPT_DISTANCE_M ||
      isFacilityDirection(step.relativeDirection) ||
      startIndex === null ||
      endIndex === null ||
      endIndex <= startIndex
    ) {
      expanded.push(step);
      continue;
    }
    const chunkCount = Math.ceil(step.distanceM / MAX_WALK_PROMPT_DISTANCE_M);
    const cumulative = [0];
    for (let pointIndex = startIndex + 1; pointIndex <= endIndex; pointIndex++) {
      cumulative.push(
        cumulative.at(-1)! +
          haversineCoords(polyline[pointIndex - 1], polyline[pointIndex]),
      );
    }
    const geometryDistance = cumulative.at(-1)!;
    if (geometryDistance <= 0) {
      expanded.push(step);
      continue;
    }
    const chunkDistance = step.distanceM / chunkCount;
    expanded.push({ ...step, distanceM: Math.round(chunkDistance) });
    let emitted = 1;
    for (let chunk = 1; chunk < chunkCount; chunk++) {
      const target = (geometryDistance * chunk) / chunkCount;
      const offset = cumulative.findIndex((distance) => distance >= target);
      if (offset <= 0) continue;
      const location = polyline[startIndex + offset];
      if (location[0] === expanded.at(-1)!.location[0] &&
          location[1] === expanded.at(-1)!.location[1]) continue;
      const { instruction: _instruction, maneuver: _maneuver, ...rest } = step;
      expanded.push({
        ...rest,
        relativeDirection: "CONTINUE",
        absoluteDirection: null,
        distanceM: Math.round(chunkDistance),
        location,
      });
      emitted++;
    }
    const emittedDistance = expanded
      .slice(-emitted)
      .reduce((sum, candidate) => sum + candidate.distanceM, 0);
    expanded.at(-1)!.distanceM += Math.round(step.distanceM - emittedDistance);
  }
  return expanded;
}

function prepareWalkSteps(leg: WalkLeg, isFirstLeg: boolean): WalkStep[] {
  const steps = (leg.steps ?? []).map((step, index) => {
    const normalized = { ...step, stairs: step.stairs === true };
    if (
      !isFirstLeg &&
      index === 0 &&
      step.relativeDirection.toUpperCase() === "DEPART"
    ) {
      const { instruction: _instruction, ...rest } = normalized;
      return { ...rest, relativeDirection: "CONTINUE" };
    }
    return normalized;
  });
  return splitLongWalkSteps(mergeWalkSteps(steps), leg.polyline ?? []);
}

function stepType(relativeDirection: string): NavInstructionType {
  const dir = relativeDirection.toUpperCase();
  if (isFacilityDirection(dir)) {
    return "facility";
  }
  if (dir === "DEPART") return "depart";
  return "turn";
}

import { formatWalkStepInstruction } from "../../utils/transit-text";

function walkStepText(
  step: WalkStep,
  bearing: number | null,
  targetStreetName: string | null,
): string {
  const upstreamText = step.instruction?.trim();
  const compass =
    bearing !== null && (step.relativeDirection ?? "").toUpperCase() === "DEPART"
      ? `，方位約 ${bearing} 度（${degToCompassWord(bearing)}）`
      : "";
  const baseText = isFacilityDirection(step.relativeDirection) && upstreamText
    ? upstreamText
    : formatWalkStepInstruction({ ...step, targetStreetName }) + compass;
  const normalizedText = baseText.endsWith(STAIRS_NOTICE)
    ? baseText.slice(0, -STAIRS_NOTICE.length)
    : baseText;
  return step.stairs ? normalizedText + STAIRS_NOTICE : normalizedText;
}

function roadStepType(maneuver: string | undefined): NavInstructionType {
  return maneuver?.toUpperCase() === "DEPART" ? "depart" : "turn";
}

function roadLegToInstructions(
  leg: DriveLeg,
  isFirstLeg: boolean,
  warnings: NavWarningCode[],
): PendingNavInstruction[] {
  const steps = leg.steps ?? [];
  if (!steps.length) {
    pushWarning(warnings, WARN_ROAD_STEPS_UNAVAILABLE);
    const bearing =
      leg.polyline.length >= 2
        ? Math.round(calcBearing(leg.polyline[0], leg.polyline[1]))
        : null;
    return [{
      text: isFirstLeg ? "請沿道路出發，前往目的地" : "請沿道路繼續前往目的地",
      type: isFirstLeg ? "depart" : "turn",
      bearing,
      relativeDirection: null,
      distanceM: leg.distanceM,
      streetName: null,
      legType: leg.type,
      stairs: false,
      polylineIndex: bearing === null ? null : 0,
    }];
  }

  let searchIndex = 0;
  return steps.map((step) => {
    const bearing =
      step.polyline.length >= 2
        ? Math.round(calcBearing(step.polyline[0], step.polyline[1]))
        : null;
    const polylineIndex = step.polyline[0] && leg.polyline.length
      ? nearestPolylineIndex(leg.polyline, step.polyline[0], searchIndex)
      : null;
    if (polylineIndex !== null) searchIndex = polylineIndex;
    return {
      text: step.instruction.trim() || "請沿道路繼續前行",
      type: roadStepType(step.maneuver),
      bearing,
      relativeDirection: null,
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
): PendingNavInstruction {
  const label = exitInfo.exitNumber ? `${exitInfo.exitNumber} 出口` : "出口";
  const text =
    exitInfo.type === "elevator"
      ? `前方為 ${label}電梯，請進入電梯`
      : `前方為 ${label}坡道，請沿坡道前進`;
  return {
    text,
    type: "facility",
    bearing: null,
    relativeDirection: null,
    distanceM: null,
    streetName: null,
    legType: "WALK",
    stairs: false,
    polylineIndex: null,
  };
}

function walkLegToInstructions(
  leg: WalkLeg,
  isFirstLeg: boolean,
  warnings: NavWarningCode[],
): PendingNavInstruction[] {
  const out: PendingNavInstruction[] = [];
  const polyline = leg.polyline ?? [];
  const steps = prepareWalkSteps(leg, isFirstLeg);

  if (steps.length > 0) {
    let searchIndex = 0;
    steps.forEach((step, i) => {
      const polylineIndex = nearestPolylineIndex(polyline, step.location, searchIndex);
      if (polylineIndex !== null) searchIndex = polylineIndex;
      const bearing = stepBearing(step, polyline, polylineIndex);
      const type = stepType(step.relativeDirection ?? "CONTINUE");
      const nextNamed = steps.slice(i + 1).find(hasStreetName)?.streetName.trim() ?? null;
      out.push({
        text: walkStepText(step, bearing, nextNamed),
        type,
        bearing: type === "facility" ? null : bearing,
        relativeDirection: null,
        distanceM: step.distanceM ?? null,
        streetName: hasStreetName(step) ? step.streetName.trim() : null,
        legType: "WALK",
        stairs: step.stairs,
        polylineIndex,
      });
    });
  } else {
    const bearing =
      polyline.length >= 2 ? Math.round(calcBearing(polyline[0], polyline[1])) : null;
    const heading = bearing !== null ? degToCompassWord(bearing) : "前";
    out.push({
      text: isFirstLeg
        ? `請朝${heading}方向出發，沿路前往「${leg.to}」`
        : `請沿路前往「${leg.to}」`,
      type: isFirstLeg ? "depart" : "turn",
      bearing,
      relativeDirection: null,
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
    out.push(exitInfoInstruction(leg.exitInfo));
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
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  return value;
}

function busInstructions(leg: BusLeg): PendingNavInstruction[] {
  const waitText =
    typeof leg.estimatedWaitMinutes === "number" && leg.estimatedWaitMinutes > 0
      ? `，預估等候約 ${leg.estimatedWaitMinutes} 分鐘`
      : "";
  const board = `請在「${leg.departureStop}」站牌等候，搭乘公車「${leg.routeName}」${waitText}。`;
  const alight = `抵達「${leg.arrivalStop}」站後請下車。`;
  return [
    transitInstruction(board, "transit_board", "BUS"),
    transitInstruction(alight, "transit_alight", "BUS"),
  ];
}

function metroInstructions(leg: MetroLeg): PendingNavInstruction[] {
  const system = railSystemName(leg.railSystem);
  const ride = leg.rideMinutes ? `，行駛約 ${leg.rideMinutes} 分鐘` : "";
  const facility = leg.facilityHighlights?.some((f) => f.includes("電梯"))
    ? "請優先使用電梯進站。"
    : "請留意進站無障礙設施狀況。";
  const board = `請搭乘${system}「${leg.lineName}」，在「${leg.departureStation}」站上車，往「${leg.arrivalStation}」方向${ride}。${facility}`;
  const alight = `請在「${leg.arrivalStation}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "METRO"),
    transitInstruction(alight, "transit_alight", "METRO"),
  ];
}

function thsrInstructions(leg: ThsrLeg): PendingNavInstruction[] {
  const dep = displayTime(leg.departureTime);
  const arr = displayTime(leg.arrivalTime);
  const depText = dep ? `預計 ${dep} ` : "";
  const arrText = arr ? `，${arr} 抵達` : "，抵達";
  const board = `請搭乘高鐵 ${leg.trainNo} 次列車，${depText}由「${leg.departureStation}」出發${arrText}「${leg.arrivalStation}」。`;
  const alight = `請在「${leg.arrivalStation}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "THSR"),
    transitInstruction(alight, "transit_alight", "THSR"),
  ];
}

function traInstructions(leg: TraLeg): PendingNavInstruction[] {
  const dep = displayTime(leg.departureTime);
  const arr = displayTime(leg.arrivalTime);
  const depText = dep ? `預計 ${dep} ` : "";
  const arrText = arr ? `，${arr} 抵達` : "，抵達";
  const trainType = leg.trainTypeName ? `${leg.trainTypeName} ` : "";
  const board = `請搭乘台鐵${trainType}${leg.trainNo} 次，${depText}由「${leg.departureStation}」出發${arrText}「${leg.arrivalStation}」。`;
  const alight = `請在「${leg.arrivalStation}」站下車。`;
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
 * @returns 成功時回傳指引結果，失敗時回傳錯誤碼與訊息
 */
export function generateNavInstructions(
  route: NavRouteInput,
  userHeading?: number,
): GenerateNavResult {
  const voiceResult = generateNavStepsWithLegIndex(route);
  if (!voiceResult.ok) return voiceResult;
  const instructions = voiceResult.steps.map(({ instruction }) => ({ ...instruction }));

  if (typeof userHeading === "number") {
    for (const instruction of instructions) {
      if (instruction.bearing !== null) {
        instruction.relativeDirection = calcRelativeDirection(
          userHeading,
          instruction.bearing,
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

/**
 * Resolve the preferred route token or use the compatible inline route before
 * generating instructions.
 * @param input Token/route input plus an optional current heading.
 * @returns Generated instructions or a bounded input error.
 */
export async function generateNavInstructionsFromInput(
  input: NavInstructionsInput,
): Promise<GenerateNavResult> {
  let route = input.route;
  if (input.routeToken) {
    const { getRouteByToken } = await import(
      "../accessible-route/route-token.service"
    );
    route = (await getRouteByToken(input.routeToken)) ?? undefined;
    if (!route) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        reason: "INVALID_ROUTE_TOKEN",
        message: "routeToken 無效或已過期",
      };
    }
  }
  if (!route) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      reason: "INVALID_ROUTE_INPUT",
      message: "請提供 route 或 routeToken",
    };
  }
  return generateNavInstructions(route, input.userHeading);
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
): GenerateVoiceNavStepsResult {
  const legs = route?.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      reason: "INVALID_ROUTE_INPUT",
      message: "route 欄位格式錯誤或 legs 為空",
    };
  }

  for (const leg of legs) {
    const type = (leg as { type?: string })?.type;
    if (!type || !KNOWN_LEG_TYPES.has(type as NavLegType)) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        reason: "UNSUPPORTED_LEG_TYPE",
        message: `legs 含未支援的型別：${type ?? "(未知)"}`,
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
      | WalkLeg
      | DriveLeg
      | BusLeg
      | MetroLeg
      | ThsrLeg
      | TraLeg;
    switch (leg.type) {
      case "WALK":
        pendingSteps.push(...walkLegToInstructions(leg, pendingSteps.length === 0, warnings)
          .map((instruction) => ({ instruction, legIndex })));
        break;
      case "DRIVE":
      case "MOTORCYCLE":
        pendingSteps.push(...roadLegToInstructions(leg, pendingSteps.length === 0, warnings)
          .map((instruction) => ({ instruction, legIndex })));
        break;
      case "BUS":
        pendingSteps.push(...busInstructions(leg).map((instruction) => ({ instruction, legIndex })));
        break;
      case "METRO":
        pendingSteps.push(...metroInstructions(leg).map((instruction) => ({ instruction, legIndex })));
        break;
      case "THSR":
        pendingSteps.push(...thsrInstructions(leg).map((instruction) => ({ instruction, legIndex })));
        break;
      case "TRA":
        pendingSteps.push(...traInstructions(leg).map((instruction) => ({ instruction, legIndex })));
        break;
    }
  });

  pendingSteps.push({
    legIndex: legs.length - 1,
    instruction: {
      text: "您已抵達目的地",
      type: "arrive",
      bearing: null,
      relativeDirection: null,
      distanceM: null,
      streetName: null,
      legType: (legs[legs.length - 1] as { type: NavLegType }).type,
      stairs: false,
      polylineIndex: null,
    },
  });
  let cumulativeDistanceM = 0;
  const steps: VoiceNavStep[] = pendingSteps.map(({ instruction, legIndex }) => {
    const complete: NavInstruction = {
      ...instruction,
      legIndex,
      cumulativeDistanceM: Math.round(cumulativeDistanceM),
    };
    if (instruction.distanceM !== null) {
      cumulativeDistanceM += instruction.distanceM;
    }
    return { instruction: complete, legIndex };
  });
  return { ok: true, steps, warnings };
}
