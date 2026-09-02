import type { AccessibleRoute } from "../../types/route";
import type { MatchedAlert, TaiwanCityEn } from "../../types/transit";
import type { TransitContext } from "../transit/alert.service";
import type {
  NavInstruction,
  NavInstructionType,
  NavLegType,
  NavRouteInput,
} from "../nav-instructions/nav-instructions.types";
import {
  generateNavStepsWithLegIndex,
  type GenerateVoiceNavStepsResult,
} from "../nav-instructions/nav-instructions.service";
import type { NavPosition } from "./navigation.schema";
import type { NavProgressEvent } from "./voice.ws.schema";

const ARRIVE_RADIUS_M = 30;
const RESUME_RADIUS_M = 60;
const OFFROUTE_RADIUS_M = 50;
const OFFROUTE_CONSECUTIVE = 3;
const OFFROUTE_RECOVER_CONSECUTIVE = 2;
const ACCURACY_CAP_M = 30;
export const MAX_LOOKAHEAD_STEPS = 2;
const MAX_SKIP_DIST_M = 60;
const TRANSFER_SNAP_M = 15;
export const SPEECH_QUEUE_MAX = 8;
const DEFAULT_WALK_SPEED_MPS = 1;
const MIN_WALK_SPEED_MPS = 0.3;
const MAX_WALK_SPEED_MPS = 2.5;
/** ~30 km/h, used only when a transit leg carries no timetable at all. */
const DEFAULT_TRANSIT_SPEED_MPS = 8.3;

type Coord = [number, number];
type StopReason = "user_voice" | "user_ui" | "arrived" | "session_end";
type StepKind = NavInstructionType | "walk_leg_end";

export interface NavStepDto {
  index: number;
  instruction: string;
  legType: NavLegType;
  distanceM: number | null;
  isTransit: boolean;
}

export type NavServerEvent =
  | {
      type: "nav.start";
      steps: NavStepDto[];
      currentStepIndex: 0;
      totalSteps: number;
    }
  | {
      type: "nav.step";
      currentStepIndex: number;
      instruction: string;
      remainingM: number | null;
    }
  | {
      type: "nav.transit";
      leg: { mode: NavLegType; from: string; to: string; routeName?: string };
    }
  | { type: "nav.arrived" }
  | { type: "nav.stop"; reason: StopReason }
  | { type: "nav.offroute"; distanceM: number }
  | {
      type: "nav.error";
      code: "NAV_ROUTE_INVALID" | "NO_ROUTE_ARMED";
      message: string;
    }
  | {
      type: "nav.transit_alert";
      alerts: MatchedAlert[];
    }
  | NavProgressEvent;

export interface NavEffect {
  ok: boolean;
  events: NavServerEvent[];
}

export interface NavigationTransitContext {
  relation: "current" | "upcoming";
  mode: Extract<NavLegType, "BUS" | "METRO" | "THSR" | "TRA">;
  routeName?: string;
  from: string;
  to: string;
  direction?: 0 | 1;
}

export interface NavigationConversationContext {
  active: boolean;
  currentStep?: {
    index: number;
    instruction: string;
    legType: NavLegType;
  };
  destination?: string;
  transit?: NavigationTransitContext;
}

export interface ResolvedStep {
  instruction: string;
  legIndex: number;
  legType: NavLegType;
  polylineIndex: number | null;
  coord: Coord | null;
  isTransit: boolean;
  distanceM: number | null;
  kind: StepKind;
}

type StepGenerator = (route: NavRouteInput) => GenerateVoiceNavStepsResult;

const emptyEffect = (ok = true): NavEffect => ({ ok, events: [] });
const isTransitType = (type: NavLegType): boolean =>
  type === "BUS" || type === "METRO" || type === "THSR" || type === "TRA";
const sameCoord = (a: Coord, b: Coord): boolean =>
  a[0] === b[0] && a[1] === b[1];

/** Great-circle distance for GeoJSON-order [lng, lat] tuples. */
export function haversineLngLat(a: Coord, b: Coord): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function distanceToSegmentM(point: Coord, a: Coord, b: Coord): number {
  const lat0 = (point[1] * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_540;
  const px = (point[0] - a[0]) * mx;
  const py = (point[1] - a[1]) * my;
  const bx = (b[0] - a[0]) * mx;
  const by = (b[1] - a[1]) * my;
  const denom = bx * bx + by * by;
  const t =
    denom === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / denom));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Minimum point-to-polyline distance for [lng, lat] geometry. */
export function distanceToPolylineM(point: Coord, polyline: Coord[]): number {
  if (!polyline.length) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return haversineLngLat(point, polyline[0]);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i++) {
    min = Math.min(
      min,
      distanceToSegmentM(point, polyline[i - 1], polyline[i]),
    );
  }
  return min;
}

/** Geodesic length of `polyline` between two of its vertices, inclusive. */
function polylineLengthM(polyline: Coord[], from = 0, to = -1): number {
  const last = polyline.length - 1;
  const start = Math.max(0, Math.min(from, to < 0 ? last : to));
  const end = Math.min(last, Math.max(from, to < 0 ? last : to));
  let total = 0;
  for (let i = start + 1; i <= end; i++) {
    total += haversineLngLat(polyline[i - 1], polyline[i]);
  }
  return total;
}

/** Minutes past midnight for an `HH:MM` departure/arrival stamp. */
function clockMinutes(value?: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

type RouteLeg = AccessibleRoute["legs"][number];
type TransitLeg = Extract<RouteLeg, { waitInfo: unknown }>;

const isTransitLeg = (leg: RouteLeg): leg is TransitLeg =>
  isTransitType(leg.type);

function walkSpeedMpsOf(leg: RouteLeg): number {
  if (leg.type !== "WALK") return DEFAULT_WALK_SPEED_MPS;
  const seconds = leg.minutesEst * 60;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_WALK_SPEED_MPS;
  if (!Number.isFinite(leg.distanceM) || leg.distanceM <= 0)
    return DEFAULT_WALK_SPEED_MPS;
  return Math.min(
    MAX_WALK_SPEED_MPS,
    Math.max(MIN_WALK_SPEED_MPS, leg.distanceM / seconds),
  );
}

/** In-vehicle seconds for one transit leg, ignoring the wait before boarding. */
function transitRideSec(leg: TransitLeg): number {
  if (leg.type !== "BUS" && Number.isFinite(leg.rideMinutes)) {
    if (leg.rideMinutes > 0) return leg.rideMinutes * 60;
  }
  const departure = clockMinutes(leg.departureTime);
  const arrival = clockMinutes(leg.arrivalTime);
  if (departure !== null && arrival !== null) {
    const minutes = (arrival - departure + 1440) % 1440;
    if (minutes > 0) return minutes * 60;
  }
  return polylineLengthM(leg.polyline) / DEFAULT_TRANSIT_SPEED_MPS;
}

/** Seconds still to be spent waiting before boarding a not-yet-boarded leg. */
function transitWaitSec(leg: TransitLeg, nowMs: number = Date.now()): number {
  const estimated = leg.estimatedWaitMinutes;
  if (
    typeof estimated === "number" &&
    Number.isFinite(estimated) &&
    estimated > 0
  ) {
    return estimated * 60;
  }
  const scheduled = leg.waitInfo?.time;
  if (
    typeof scheduled === "number" &&
    Number.isFinite(scheduled) &&
    scheduled > 0
  ) {
    return scheduled * 60;
  }
  const depStr = typeof scheduled === "string" ? scheduled : leg.departureTime;
  if (depStr) {
    const depMins = clockMinutes(depStr);
    if (depMins !== null) {
      const now = new Date(nowMs);
      const nowSecFromMidnight =
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const depSecFromMidnight = depMins * 60;
      const waitSec = (depSecFromMidnight - nowSecFromMidnight + 86400) % 86400;
      return waitSec;
    }
    const parsed = Number(depStr);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 60;
  }
  return 0;
}

/** Travel cost from one coord-bearing step to the next one. */
interface StepSpan {
  distanceM: number;
  durationSec: number;
  speedMps: number;
  transitLeg: TransitLeg | null;
}

const emptySpan = (): StepSpan => ({
  distanceM: 0,
  durationSec: 0,
  speedMps: DEFAULT_WALK_SPEED_MPS,
  transitLeg: null,
});

export class NavigationSession {
  private armedRoute: AccessibleRoute | null = null;
  private activeRoute: AccessibleRoute | null = null;
  private active = false;
  private disposed = false;
  private steps: ResolvedStep[] = [];
  private announcedIndex = -1;
  private onVehicle = false;
  private offrouteWarned = false;
  private offrouteCount = 0;
  private recoverCount = 0;
  private terminalCoordIndex = -1;
  private latestPosition: NavPosition | null = null;
  private spans: StepSpan[] = [];
  private currentSpeechText: string | null = null;
  private speechQueue: string[] = [];
  private seenAlertIds = new Set<string>();

  constructor(
    private readonly generateSteps: StepGenerator = generateNavStepsWithLegIndex,
  ) {}

  armRoute(route: AccessibleRoute): NavEffect {
    if (
      this.disposed ||
      !route ||
      !Array.isArray(route.legs) ||
      route.legs.length === 0
    ) {
      return this.invalidRoute();
    }
    this.armedRoute = route;
    this.seenAlertIds.clear();
    return emptyEffect();
  }

  start(seedPosition?: NavPosition): NavEffect {
    if (this.disposed) return emptyEffect(false);
    if (this.active) {
      this.enqueueSpeech("導航進行中");
      return emptyEffect();
    }
    if (!this.armedRoute) {
      return {
        ok: false,
        events: [
          {
            type: "nav.error",
            code: "NO_ROUTE_ARMED",
            message: "尚未選擇路線",
          },
        ],
      };
    }
    if (
      this.armedRoute.legs.some(
        (leg) => leg.type === "DRIVE" || leg.type === "MOTORCYCLE",
      )
    ) {
      return this.invalidRoute("語音逐步導航目前僅支援步行與大眾運輸");
    }
    const built = this.buildResolvedSteps(this.armedRoute);
    if (!built) return this.invalidRoute();
    this.activeRoute = this.armedRoute;
    this.steps = built;
    this.spans = this.buildSpans(this.armedRoute, built);
    this.terminalCoordIndex = built
      .map((s) => s.coord)
      .lastIndexOf([...built].reverse().find((s) => s.coord)?.coord ?? null);
    this.active = true;
    this.announcedIndex = -1;
    this.onVehicle = false;
    this.offrouteWarned = false;
    this.offrouteCount = 0;
    this.recoverCount = 0;
    const events: NavServerEvent[] = [
      {
        type: "nav.start",
        steps: this.steps.map((step, index) => ({
          index,
          instruction: step.instruction,
          legType: step.legType,
          distanceM: step.distanceM,
          isTransit: step.isTransit,
        })),
        currentStepIndex: 0,
        totalSteps: this.steps.length,
      },
    ];
    const seed = seedPosition ?? this.latestPosition;
    if (seed) events.push(...this.onPosition(seed).events);
    return { ok: true, events };
  }

  onPosition(position: NavPosition): NavEffect {
    this.latestPosition = position;
    if (this.disposed || !this.active) return emptyEffect();
    const advanced = this.advanceFrom(position);
    const offroute = this.checkOffRoute(position);
    const speech = [...advanced.speech, ...offroute.speech]
      .filter(Boolean)
      .join(" ");
    if (speech) this.enqueueSpeech(speech);
    const events = [...advanced.events, ...offroute.events];
    const progress = this.active ? this.progressEvent(position) : null;
    if (progress) events.push(progress);
    return { ok: true, events };
  }

  stop(reason: StopReason): NavEffect {
    if (this.disposed || !this.active) return emptyEffect();
    this.active = false;
    this.activeRoute = null;
    this.steps = [];
    this.spans = [];
    this.announcedIndex = -1;
    this.onVehicle = false;
    this.seenAlertIds.clear();
    this.clearSpeech();
    return { ok: true, events: [{ type: "nav.stop", reason }] };
  }

  cancel(): NavEffect {
    return this.stop("user_ui");
  }

  repeatCurrent(): NavEffect {
    if (this.active && this.announcedIndex >= 0) {
      this.enqueueSpeech(this.steps[this.announcedIndex].instruction);
    }
    return emptyEffect();
  }

  /** Minimal trusted route context exposed to the Live conversation tool. */
  getConversationContext(): NavigationConversationContext {
    if (this.disposed || !this.active || !this.activeRoute)
      return { active: false };
    const currentIndex =
      this.announcedIndex >= 0 ? this.announcedIndex : this.nextCoordIndex(0);
    const current =
      currentIndex === null ? undefined : this.steps[currentIndex];
    const currentTransitIndex =
      this.onVehicle && current?.kind === "transit_board" ? currentIndex : null;
    const upcomingTransitIndex =
      currentTransitIndex === null
        ? this.steps.findIndex(
            (step, index) =>
              index > this.announcedIndex && step.kind === "transit_board",
          )
        : -1;
    const transitIndex =
      currentTransitIndex ??
      (upcomingTransitIndex >= 0 ? upcomingTransitIndex : null);
    return {
      active: true,
      ...(current && currentIndex !== null
        ? {
            currentStep: {
              index: currentIndex,
              instruction: current.instruction,
              legType: current.legType,
            },
          }
        : {}),
      destination: this.routeDestination(this.activeRoute),
      ...(transitIndex !== null
        ? {
            transit: this.conversationTransit(
              this.steps[transitIndex].legIndex,
              currentTransitIndex !== null ? "current" : "upcoming",
            ),
          }
        : {}),
    };
  }

  takeNextSpeech(): string | null {
    if (this.disposed || this.currentSpeechText || !this.speechQueue.length)
      return null;
    this.currentSpeechText = this.speechQueue.shift() ?? null;
    return this.currentSpeechText;
  }

  onTurnComplete(): void {
    this.currentSpeechText = null;
  }

  onInterrupted(): void {
    if (this.currentSpeechText)
      this.speechQueue.unshift(this.currentSpeechText);
    this.currentSpeechText = null;
  }

  dispose(): void {
    this.disposed = true;
    this.armedRoute = null;
    this.activeRoute = null;
    this.latestPosition = null;
    this.active = false;
    this.steps = [];
    this.spans = [];
    this.seenAlertIds.clear();
    this.clearSpeech();
  }

  /**
   * Returns the TransitContext for the active or upcoming transit leg in this session,
   * or null if no active transit leg is present.
   */
  getCurrentTransitAlertContext(): TransitContext | null {
    if (this.disposed || !this.active || !this.activeRoute) return null;
    const currentIndex =
      this.announcedIndex >= 0 ? this.announcedIndex : this.nextCoordIndex(0);
    const current =
      currentIndex === null ? undefined : this.steps[currentIndex];
    const currentTransitIndex =
      this.onVehicle && current?.kind === "transit_board" ? currentIndex : null;
    const upcomingTransitIndex =
      currentTransitIndex === null
        ? this.steps.findIndex(
            (step, index) =>
              index > this.announcedIndex && step.kind === "transit_board",
          )
        : -1;
    const transitIndex =
      currentTransitIndex ??
      (upcomingTransitIndex >= 0 ? upcomingTransitIndex : null);
    if (transitIndex === null) return null;

    const legIndex = this.steps[transitIndex].legIndex;
    const leg = this.activeRoute.legs[legIndex];
    if (leg.type === "BUS") {
      return {
        mode: "bus",
        city: (leg.tdxCity || leg.cityCode || "Taipei") as TaiwanCityEn,
        routeName: leg.routeName,
        direction: leg.direction,
        stopName: leg.departureStop,
      };
    }
    if (leg.type === "METRO") {
      const validSystems = [
        "TRTC",
        "KRTC",
        "TYMC",
        "TMRT",
        "NTMC",
        "KLRT",
      ] as const;
      const rawSystem = (leg.railSystem || "TRTC").toUpperCase();
      const railSystem = (validSystems as readonly string[]).includes(rawSystem)
        ? (rawSystem as (typeof validSystems)[number])
        : "TRTC";
      return {
        mode: "metro",
        railSystem,
        lineCode: leg.lineId || leg.lineUid || undefined,
        stationIds: [leg.departureStationUid, leg.arrivalStationUid].flatMap(
          (id) => (id ? [id.replace(/^[A-Za-z]+[-_]/, "")] : []),
        ),
      };
    }
    if (leg.type === "TRA") {
      return {
        mode: "tra",
        trainNo: leg.trainNo,
        stationIds: [leg.departureStationUID, leg.arrivalStationUID].flatMap(
          (id) => (id ? [id.replace(/^[A-Za-z]+[-_]/, "")] : []),
        ),
      };
    }
    if (leg.type === "THSR") {
      return {
        mode: "thsr",
        fromStationId: (leg.departureStationUID || "").replace(
          /^[A-Za-z]+[-_]/,
          "",
        ),
        toStationId: (leg.arrivalStationUID || "").replace(
          /^[A-Za-z]+[-_]/,
          "",
        ),
      };
    }
    return null;
  }

  /**
   * Processes new transit alerts, deduping previously announced alerts,
   * enqueuing a proactive speech prompt and returning server events.
   */
  onTransitAlerts(alerts: MatchedAlert[]): NavEffect {
    if (this.disposed || !this.active || !alerts.length) return emptyEffect();
    const newAlerts = alerts.filter((a) => !this.seenAlertIds.has(a.alertId));
    if (!newAlerts.length) return emptyEffect();

    for (const a of newAlerts) {
      this.seenAlertIds.add(a.alertId);
    }

    const voiceAlert = newAlerts[0];
    const speech = `注意，即時通阻警報：${voiceAlert.title}`;
    this.enqueueSpeech(speech);

    return {
      ok: true,
      events: [
        {
          type: "nav.transit_alert",
          alerts: newAlerts,
        },
      ],
    };
  }

  private invalidRoute(message = "路線資料無效，請重新規劃"): NavEffect {
    return {
      ok: false,
      events: [{ type: "nav.error", code: "NAV_ROUTE_INVALID", message }],
    };
  }

  private buildResolvedSteps(route: AccessibleRoute): ResolvedStep[] | null {
    for (const leg of route.legs) {
      if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") return null;
      if (isTransitType(leg.type)) {
        if (
          leg.polyline.length < 2 ||
          sameCoord(leg.polyline[0], leg.polyline.at(-1)!)
        )
          return null;
      } else if (leg.type === "WALK") {
        if (!leg.polyline.length) return null;
        if (
          !leg.steps?.length &&
          (leg.polyline.length < 2 ||
            sameCoord(leg.polyline[0], leg.polyline.at(-1)!))
        )
          return null;
      }
    }
    const generated = this.generateSteps(route);
    if (!generated.ok) return null;
    const byLeg = new Map<number, VoiceStepLike[]>();
    for (const item of generated.steps) {
      const list = byLeg.get(item.legIndex) ?? [];
      list.push(item);
      byLeg.set(item.legIndex, list);
    }
    const resolved: ResolvedStep[] = [];
    route.legs.forEach((leg, legIndex) => {
      for (const item of byLeg.get(legIndex) ?? []) {
        if (item.instruction.type === "arrive") continue;
        resolved.push(
          this.resolveInstruction(item.instruction, legIndex, route),
        );
      }
      const walkEnd =
        leg.type === "WALK" ? (leg.polyline.at(-1) ?? null) : null;
      const lastLegCoord =
        [...resolved]
          .reverse()
          .find((step) => step.legIndex === legIndex && step.coord)?.coord ??
        null;
      if (
        leg.type === "WALK" &&
        walkEnd &&
        (!lastLegCoord || !sameCoord(lastLegCoord, walkEnd))
      ) {
        resolved.push({
          instruction: `抵達「${leg.to}」`,
          legIndex,
          legType: "WALK",
          polylineIndex: leg.polyline.length - 1,
          coord: walkEnd,
          isTransit: false,
          distanceM: null,
          kind: "walk_leg_end",
        });
      }
    });
    const arrive = generated.steps.find(
      (item) => item.instruction.type === "arrive",
    );
    if (arrive)
      resolved.push(
        this.resolveInstruction(arrive.instruction, arrive.legIndex, route),
      );
    const coords = resolved.filter((step) => step.coord);
    if (!coords.length) return null;
    const lastLegIndex = route.legs.length - 1;
    const lastCoordStep = [...resolved].reverse().find((step) => step.coord);
    const lastLeg = route.legs[lastLegIndex];
    if (!lastCoordStep || lastCoordStep.legIndex !== lastLegIndex) return null;
    if (sameCoord(lastCoordStep.coord!, lastLeg.polyline[0])) return null;
    return resolved;
  }

  private resolveInstruction(
    instruction: NavInstruction,
    legIndex: number,
    route: AccessibleRoute,
  ): ResolvedStep {
    const leg = route.legs[legIndex];
    let coord: Coord | null = null;
    if (instruction.type === "transit_board") coord = leg.polyline[0] ?? null;
    else if (instruction.type === "transit_alight")
      coord = leg.polyline.at(-1) ?? null;
    else if (leg.type === "WALK" && instruction.polylineIndex !== null) {
      coord = leg.polyline[instruction.polylineIndex] ?? null;
    }
    return {
      instruction: instruction.text,
      legIndex,
      legType: instruction.legType,
      polylineIndex: instruction.polylineIndex,
      coord,
      isTransit: isTransitType(instruction.legType),
      distanceM: instruction.distanceM,
      kind: instruction.type,
    };
  }

  private advanceFrom(position: NavPosition): {
    events: NavServerEvent[];
    speech: string[];
  } {
    const point: Coord = [position.longitude, position.latitude];
    const radius = this.onVehicle ? RESUME_RADIUS_M : ARRIVE_RADIUS_M;
    const effectiveRadius =
      radius + Math.min(position.accuracy ?? 0, ACCURACY_CAP_M);
    const candidates: number[] = [];
    let previous: Coord | null = null;
    let pathDistance = 0;
    for (let i = this.announcedIndex + 1; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (!step.coord) continue;
      if (
        candidates.length &&
        (step.kind === "transit_board" || step.kind === "transit_alight")
      )
        break;
      if (previous) pathDistance += haversineLngLat(previous, step.coord);
      if (
        candidates.length >= MAX_LOOKAHEAD_STEPS ||
        pathDistance > MAX_SKIP_DIST_M
      )
        break;
      candidates.push(i);
      previous = step.coord;
      if (step.kind === "transit_board" || step.kind === "transit_alight")
        break;
    }
    const hit = candidates
      .filter(
        (i) => haversineLngLat(point, this.steps[i].coord!) < effectiveRadius,
      )
      .at(-1);
    if (hit == null) return { events: [], speech: [] };
    const result = this.processThrough(hit);
    if (this.steps[hit].kind === "transit_alight") {
      const next = this.nextCoordIndex(hit + 1);
      if (
        next !== null &&
        this.steps[next].kind === "transit_board" &&
        haversineLngLat(this.steps[hit].coord!, this.steps[next].coord!) <
          TRANSFER_SNAP_M &&
        haversineLngLat(point, this.steps[next].coord!) < effectiveRadius
      ) {
        const transfer = this.processThrough(next);
        result.events.push(...transfer.events);
        result.speech.push(...transfer.speech);
      }
    }
    return result;
  }

  private processThrough(targetIndex: number): {
    events: NavServerEvent[];
    speech: string[];
  } {
    const events: NavServerEvent[] = [];
    const speech: string[] = [];
    for (let i = this.announcedIndex + 1; i <= targetIndex; i++) {
      const step = this.steps[i];
      speech.push(step.instruction);
      if (step.kind === "transit_board") {
        this.onVehicle = true;
        events.push({
          type: "nav.transit",
          leg: this.transitSummary(step.legIndex),
        });
      } else if (step.kind === "transit_alight") {
        this.onVehicle = false;
      }
    }
    this.announcedIndex = targetIndex;
    const target = this.steps[targetIndex];
    events.push({
      type: "nav.step",
      currentStepIndex: targetIndex,
      instruction: target.instruction,
      remainingM: target.distanceM,
    });
    if (targetIndex === this.terminalCoordIndex) {
      for (
        let i = targetIndex + 1;
        i < this.steps.length && !this.steps[i].coord;
        i++
      ) {
        speech.push(this.steps[i].instruction);
        this.announcedIndex = i;
      }
      this.active = false;
      events.push(
        { type: "nav.arrived" },
        { type: "nav.stop", reason: "arrived" },
      );
    }
    return { events, speech };
  }

  /**
   * Precomputes, for every coord-bearing step, the travel cost to the next
   * coord-bearing step. Walking spans are measured along the leg geometry, a
   * transit ride spans the whole vehicle polyline, and anything crossing a leg
   * boundary is a short transfer walk.
   */
  private buildSpans(
    route: AccessibleRoute,
    steps: ResolvedStep[],
  ): StepSpan[] {
    const spans = steps.map(() => emptySpan());
    for (let i = 0; i < steps.length; i++) {
      const from = steps[i];
      if (!from.coord) continue;
      const leg = route.legs[from.legIndex];
      const boarding = from.kind === "transit_board" && isTransitLeg(leg);
      spans[i].transitLeg = boarding ? (leg as TransitLeg) : null;
      let next: ResolvedStep | null = null;
      for (let j = i + 1; j < steps.length && !next; j++) {
        if (steps[j].coord) next = steps[j];
      }
      if (!next) continue;
      if (boarding) {
        spans[i].distanceM = polylineLengthM(leg.polyline);
        spans[i].durationSec = transitRideSec(leg as TransitLeg);
      } else if (
        from.legIndex === next.legIndex &&
        from.polylineIndex !== null &&
        next.polylineIndex !== null
      ) {
        spans[i].distanceM = polylineLengthM(
          leg.polyline,
          from.polylineIndex,
          next.polylineIndex,
        );
        spans[i].durationSec = spans[i].distanceM / walkSpeedMpsOf(leg);
      } else {
        spans[i].distanceM = haversineLngLat(from.coord, next.coord!);
        spans[i].durationSec = spans[i].distanceM / DEFAULT_WALK_SPEED_MPS;
      }
      if (spans[i].distanceM > 0 && spans[i].durationSec > 0) {
        spans[i].speedMps = spans[i].distanceM / spans[i].durationSec;
      }
    }
    return spans;
  }

  /**
   * Remaining distance/time push for the current fix. Returns null for routes
   * that carry no navigation identity, because the frame is correlated to a
   * navigationId and routeVersion the client can match against its route.
   */
  private progressEvent(position: NavPosition): NavProgressEvent | null {
    const route = this.activeRoute;
    const navigationId = route?.navigationId;
    const routeVersion = route?.routeVersion;
    if (!route || !navigationId) return null;
    if (!Number.isInteger(routeVersion) || (routeVersion as number) <= 0)
      return null;

    const nextIndex = this.nextCoordIndex(this.announcedIndex + 1);
    const distanceToNextM =
      nextIndex === null
        ? null
        : haversineLngLat(
            [position.longitude, position.latitude],
            this.steps[nextIndex].coord!,
          );
    let remainingDistanceM = distanceToNextM ?? 0;
    let remainingDurationSec =
      distanceToNextM === null
        ? 0
        : distanceToNextM / this.currentSpeedMps(nextIndex!);
    const now = Date.now();
    for (let i = nextIndex ?? this.steps.length; i < this.steps.length; i++) {
      remainingDistanceM += this.spans[i].distanceM;
      const leg = this.spans[i].transitLeg;
      const waitSec = leg ? transitWaitSec(leg, now) : 0;
      remainingDurationSec += this.spans[i].durationSec + waitSec;
    }
    const durationSec = Math.max(0, Math.round(remainingDurationSec));
    return {
      type: "nav.progress",
      navigationId,
      routeVersion: routeVersion as number,
      currentStepIndex: Math.max(0, this.announcedIndex),
      remainingDistanceM: Math.max(0, Math.round(remainingDistanceM)),
      remainingDurationSec: durationSec,
      estimatedArrivalAt: new Date(
        Date.now() + durationSec * 1000,
      ).toISOString(),
      etaSource: this.etaSource(Math.max(0, this.announcedIndex)),
      distanceToNextM:
        distanceToNextM === null ? null : Math.round(distanceToNextM),
    };
  }

  /** Speed of the span currently being traversed, for the partial remainder. */
  private currentSpeedMps(nextIndex: number): number {
    const traversing =
      this.announcedIndex >= 0 ? this.spans[this.announcedIndex] : null;
    if (traversing && traversing.speedMps > 0) return traversing.speedMps;
    return walkSpeedMpsOf(
      this.activeRoute!.legs[this.steps[nextIndex].legIndex],
    );
  }

  private etaSource(currentStepIndex: number): NavProgressEvent["etaSource"] {
    const route = this.activeRoute;
    if (!route) return "estimated";
    const remainingSteps = this.steps.slice(Math.max(0, currentStepIndex));
    const remainingTransitLegIndices = new Set<number>();
    let driving = false;
    for (const step of remainingSteps) {
      if (step.kind === "transit_board") {
        remainingTransitLegIndices.add(step.legIndex);
      } else if (
        step.legType === "DRIVE" ||
        step.legType === "MOTORCYCLE" ||
        route.legs[step.legIndex]?.type === "DRIVE" ||
        route.legs[step.legIndex]?.type === "MOTORCYCLE"
      ) {
        driving = true;
      }
    }
    let scheduled = false;
    for (const legIndex of remainingTransitLegIndices) {
      const leg = route.legs[legIndex];
      if (!leg || !isTransitLeg(leg)) continue;
      const source = leg.waitInfo?.source;
      if (source === "realtime") return "realtime";
      if (source === "schedule") {
        scheduled = true;
      }
    }
    if (scheduled) return "schedule";
    if (driving) return "free_flow";
    return "estimated";
  }

  private nextCoordIndex(from: number): number | null {
    for (let i = from; i < this.steps.length; i++)
      if (this.steps[i].coord) return i;
    return null;
  }

  private transitSummary(legIndex: number) {
    const leg = this.activeRoute!.legs[legIndex];
    if (leg.type === "BUS") {
      return {
        mode: leg.type,
        from: leg.departureStop,
        to: leg.arrivalStop,
        routeName: leg.routeName,
      };
    }
    if (leg.type === "METRO") {
      return {
        mode: leg.type,
        from: leg.departureStation,
        to: leg.arrivalStation,
        routeName: leg.lineName,
      };
    }
    if (leg.type === "THSR" || leg.type === "TRA") {
      return {
        mode: leg.type,
        from: leg.departureStation,
        to: leg.arrivalStation,
        routeName: leg.trainNo,
      };
    }
    return { mode: leg.type, from: "", to: "" };
  }

  private conversationTransit(
    legIndex: number,
    relation: NavigationTransitContext["relation"],
  ): NavigationTransitContext {
    const leg = this.activeRoute!.legs[legIndex];
    if (leg.type === "BUS") {
      return {
        relation,
        mode: "BUS",
        routeName: leg.routeName,
        from: leg.departureStop,
        to: leg.arrivalStop,
        direction: leg.direction,
      };
    }
    if (leg.type === "METRO") {
      return {
        relation,
        mode: "METRO",
        routeName: leg.lineName,
        from: leg.departureStation,
        to: leg.arrivalStation,
        direction: leg.direction,
      };
    }
    if (leg.type === "THSR" || leg.type === "TRA") {
      return {
        relation,
        mode: leg.type,
        routeName: leg.trainNo,
        from: leg.departureStation,
        to: leg.arrivalStation,
      };
    }
    throw new Error(
      "navigation transit context requested for a non-transit leg",
    );
  }

  private routeDestination(route: AccessibleRoute): string | undefined {
    const lastLeg = route.legs.at(-1);
    if (!lastLeg) return undefined;
    if (lastLeg.type === "WALK") return lastLeg.to;
    if (lastLeg.type === "BUS") return lastLeg.arrivalStop;
    if (
      lastLeg.type === "METRO" ||
      lastLeg.type === "THSR" ||
      lastLeg.type === "TRA"
    ) {
      return lastLeg.arrivalStation;
    }
    return undefined;
  }

  private checkOffRoute(position: NavPosition): {
    events: NavServerEvent[];
    speech: string[];
  } {
    if (!this.active || this.onVehicle || !this.activeRoute)
      return { events: [], speech: [] };
    const next = this.nextCoordIndex(this.announcedIndex + 1);
    const reference =
      next !== null ? this.steps[next] : this.steps[this.announcedIndex];
    if (!reference || reference.legType !== "WALK")
      return { events: [], speech: [] };
    const leg = this.activeRoute.legs[reference.legIndex];
    if (leg.type !== "WALK") return { events: [], speech: [] };
    const distance = distanceToPolylineM(
      [position.longitude, position.latitude],
      leg.polyline,
    );
    const threshold =
      OFFROUTE_RADIUS_M + Math.min(position.accuracy ?? 0, ACCURACY_CAP_M);
    if (distance > threshold) {
      this.recoverCount = 0;
      this.offrouteCount++;
      if (this.offrouteCount >= OFFROUTE_CONSECUTIVE && !this.offrouteWarned) {
        this.offrouteWarned = true;
        return {
          events: [{ type: "nav.offroute", distanceM: Math.round(distance) }],
          speech: ["您似乎偏離路線，請確認目前位置"],
        };
      }
    } else {
      this.offrouteCount = 0;
      if (
        this.offrouteWarned &&
        ++this.recoverCount >= OFFROUTE_RECOVER_CONSECUTIVE
      ) {
        this.offrouteWarned = false;
        this.recoverCount = 0;
      }
    }
    return { events: [], speech: [] };
  }

  private enqueueSpeech(text: string): void {
    if (!text || this.disposed) return;
    if (this.speechQueue.length < SPEECH_QUEUE_MAX) this.speechQueue.push(text);
    else this.speechQueue[this.speechQueue.length - 1] += ` ${text}`;
  }

  private clearSpeech(): void {
    this.currentSpeechText = null;
    this.speechQueue = [];
  }
}

interface VoiceStepLike {
  instruction: NavInstruction;
  legIndex: number;
}
