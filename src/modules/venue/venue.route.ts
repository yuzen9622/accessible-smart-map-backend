/** Venue routing shares the pedestrian search policy and reports raw path metrics. */
import {
  getRoutingConfig,
  type VenueRoutingConfig,
} from "../../config/routing";
import type { SupportedLang } from "../../types/lang";
import type { AccessibilityMode } from "../../types/route";
import type { CostProfile } from "../accessible-route/planners/pedestrian-a11y/cost";
import { profileFor } from "../accessible-route/planners/pedestrian-a11y/csr-walk-planner";
import { searchPedGraph } from "../accessible-route/planners/pedestrian-a11y/astar";
import { ROUTE_WARNING } from "../../constants/messages";
import { presentRouteMessages } from "../../utils/route-messages";
import { levelRefOf } from "./venue.compile";
import { MAX_ARRIVAL_NODES } from "./venue.arrivals";
import { leastCertain } from "./venue.connections";
import { venueConnectionId } from "./venue.connection-id";
import type {
  VenueManeuver,
  VenueRoute,
  VenueRouteSegment,
  VenueRouteStep,
} from "../accessible-route/venue-leg.types";
import type { VenueGraph } from "./venue.graph";
import type {
  VenueBuilding,
  VenueData,
  VenueEdge,
  VenueNode,
  VenuePlace,
} from "./venue.types";

/** A slope this steep on a way not tagged as a ramp is still called a ramp. */
const RAMP_MIN_SLOPE_RATIO = 0.02;
/** Smallest heading change reported as a turn, degrees. */
const TURN_MIN_DEG = 45;
const UTURN_MIN_DEG = 150;
/** Walking shorter than this between turns is merged, metres. */
const TURN_MIN_RUN_M = 3;

export type {
  VenueStepType,
  VenueManeuver,
  VenueRouteStep,
  VenueRouteSegment,
  VenueRoute,
} from "../accessible-route/venue-leg.types";

export type VenuePlanOutcome =
  /** `costM` is the weighted path cost (metres-equivalent), for ranking only. */
  | { ok: true; route: VenueRoute; costM: number }
  | { ok: false; reason: "NO_ACCESSIBLE_ROUTE"; levelRef: string | null }
  | { ok: false; reason: "NO_ROUTE" | "UNAVAILABLE" };

/**
 * @param mode Requested accessibility mode.
 * @param config Venue routing tunables.
 * @returns The strict server-side cost profile for that mode.
 */
export function venueProfileFor(
  mode: AccessibilityMode,
  _config: Pick<VenueRoutingConfig, "stairsAvoidanceMultiplier">,
): CostProfile {
  const base = profileFor(mode);
  return mode === "elderly" || mode === "visual_impaired"
    ? { ...base, forbidStairs: true }
    : base;
}

/**
 * @param a Start node.
 * @param b End node.
 * @returns Compass bearing a → b in degrees clockwise from north.
 */
function bearingDeg(a: VenueNode, b: VenueNode): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) *
      Math.cos(toRad(b.lat)) *
      Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * @param from Heading before the vertex.
 * @param to Heading after the vertex.
 * @returns Signed turn in (-180, 180]; positive is a right turn.
 */
function turnDeg(from: number, to: number): number {
  let d = to - from;
  while (d <= -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

interface PathEdge {
  edge: VenueEdge;
  from: VenueNode;
  to: VenueNode;
  /** Index of `from` in the path. */
  i: number;
  durationS: number;
}

type Phrase = (lang: SupportedLang) => string;
const t =
  (zh: string, en: string): Phrase =>
  (lang) =>
    lang === "en" ? en : zh;

/**
 * Plans the route between two places.
 *
 * @param vg Compiled venue graph.
 * @param venue Venue data the graph was built from.
 * @param from Origin place.
 * @param to Destination place.
 * @param mode Requested accessibility mode.
 * @param config Venue routing tunables.
 * @param lang Instruction language.
 * @returns The route, or why none exists.
 */
export function planVenueRoute(
  vg: VenueGraph,
  venue: VenueData,
  from: VenuePlace,
  to: VenuePlace,
  mode: AccessibilityMode,
  config: VenueRoutingConfig,
  lang: SupportedLang,
  options: { deadlineMs?: number; allowStairsFallback?: boolean } = {},
): VenuePlanOutcome {
  const deadlineMs =
    options.deadlineMs ?? Date.now() + getRoutingConfig().planBudgetMs;
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs)
    return { ok: false, reason: "UNAVAILABLE" };
  const sources = arrivalIndices(vg, from);
  const destinations = arrivalIndices(vg, to);
  if (!sources || !destinations) return { ok: false, reason: "NO_ROUTE" };

  let profile = venueProfileFor(mode, config);
  const bestPath = (costProfile: CostProfile) => {
    const excludedEdges = new Set<number>();
    vg.edgeOfAttr.forEach((edge, attr) => {
      if (
        edge.accessDenied ||
        (costProfile.name === "wheelchair" && edge.wheelchairBarrier)
      )
        excludedEdges.add(attr);
    });
    return searchPedGraph(vg.graph, sources[0], destinations[0], costProfile, {
      deadlineMs,
      sources: sources.map((node) => ({ node, cost: 0 })),
      targets: destinations.map((node) => ({ node, cost: 0 })),
      excludedEdges,
    });
  };
  let search = bestPath(profile);
  let stairsFallback = false;
  if (
    search.status === "unreachable" &&
    mode === "wheelchair" &&
    options.allowStairsFallback !== false
  ) {
    profile = profileFor(mode, "stairs-fallback");
    search = bestPath(profile);
    stairsFallback = search.status === "found";
  }
  if (search.status !== "found") {
    if (search.status !== "unreachable")
      return { ok: false, reason: "UNAVAILABLE" };
    const anyRoute =
      mode === "normal" ? search : bestPath(venueProfileFor("normal", config));
    if (anyRoute.status !== "found" && anyRoute.status !== "unreachable")
      return { ok: false, reason: "UNAVAILABLE" };
    return anyRoute.status === "found"
      ? { ok: false, reason: "NO_ACCESSIBLE_ROUTE", levelRef: to.levelRef }
      : { ok: false, reason: "NO_ROUTE" };
  }
  const result = search.route;
  const warning = ROUTE_WARNING.WHEELCHAIR_STAIRS_FALLBACK;
  const warnings = presentRouteMessages(
    stairsFallback ? [warning] : [],
    stairsFallback
      ? [{ code: "ROUTE_WHEELCHAIR_STAIRS_FALLBACK", legacyMessage: warning }]
      : [],
    lang,
  );
  const pathNodes = Array.from(result.nodePath, (i) => vg.nodes[i]);
  const pathEdges: PathEdge[] = Array.from(result.edgeAttrPath, (attr, i) => {
    const edge = vg.edgeOfAttr[attr];
    const durationS = Number.isFinite(vg.graph.edgeTraversalTimeS[attr])
      ? vg.graph.edgeTraversalTimeS[attr]
      : edge.lengthM / profile.walkSpeedMps;
    return { edge, from: pathNodes[i], to: pathNodes[i + 1], i, durationS };
  });

  const buildingName = new Map(
    venue.buildings.map((b) => [b.id, b] as [string, VenueBuilding]),
  );
  const levelRef = (n: VenueNode) =>
    n.buildingId && n.ordinal !== null ? levelRefOf(n.ordinal) : null;

  const steps = buildSteps(
    pathEdges,
    placeAtNode(from, pathNodes[0]),
    placeAtNode(to, pathNodes[pathNodes.length - 1]),
    buildingName,
    levelRef,
    lang,
  );
  const levelRefs = pathNodes.map(levelRef);
  const distanceM = pathEdges.reduce(
    (s, p) => s + (p.edge.kind === "elevator" ? 0 : p.edge.lengthM),
    0,
  );
  const durationS = pathEdges.reduce((s, p) => s + p.durationS, 0);

  return {
    ok: true,
    costM: result.totalCost,
    route: {
      venueId: venue.venueId,
      venueVersion: vg.version,
      mode,
      stairsFallback,
      warnings: warnings.messages,
      warningDetails: warnings.details ?? [],
      fromPlaceId: from.id,
      toPlaceId: to.id,
      distanceM: Math.round(distanceM),
      durationS: Math.round(durationS),
      elevatorRides: steps.filter((s) => s.type === "elevator").length,
      stairFlights: floorsByStairs(pathEdges),
      path: {
        coordinates: pathNodes.map((n) => [
          n.lng,
          n.lat,
          Number.isFinite(n.z) ? Math.round(n.z * 100) / 100 : 0,
        ]),
        buildingIds: pathNodes.map((n) => n.buildingId),
        levelRefs,
      },
      segments: segmentsOf(pathNodes, levelRefs),
      steps,
    },
  };
}

/** Legacy single-node places retain their original endpoint behavior. */
function arrivalIndices(vg: VenueGraph, place: VenuePlace): number[] | null {
  if (place.arrivalNodeIds === undefined) {
    const index = vg.nodeIndex.get(place.nodeId);
    return index === undefined ? null : [index];
  }
  const ids = place.arrivalNodeIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_ARRIVAL_NODES ||
    new Set(ids).size !== ids.length ||
    !ids.includes(place.nodeId)
  )
    return null;
  const indices: number[] = [];
  for (const id of ids) {
    const index = vg.nodeIndex.get(id);
    if (index === undefined) return null;
    const node = vg.nodes[index];
    const levelRef =
      node.buildingId && node.ordinal !== null
        ? levelRefOf(node.ordinal)
        : null;
    if (node.buildingId !== place.buildingId || levelRef !== place.levelRef)
      return null;
    indices.push(index);
  }
  return indices;
}

/** Keep semantic identity/name, while instructions refer to the chosen real arrival. */
function placeAtNode(place: VenuePlace, node: VenueNode): VenuePlace {
  if (place.nodeId === node.id) return place;
  const door = node.kind === "door" || node.kind === "entrance";
  return {
    ...place,
    nodeId: node.id,
    location: [node.lng, node.lat],
    arrivalKind: door ? "door" : "corridor",
    doorKnown: door,
  };
}

/**
 * @returns Floors between the start of the first edge and the end of the
 * last, or 0 when either end has no floor.
 */
function floorsOf(first: PathEdge, end: PathEdge): number {
  const a = first.from.ordinal;
  const b = end.to.ordinal;
  return a === null || b === null ? 0 : Math.abs(b - a);
}

/**
 * Floors climbed or descended by stairs, counted per continuous stairs run,
 * so a flight drawn with a middle vertex is not counted twice.
 */
function floorsByStairs(pathEdges: PathEdge[]): number {
  let floors = 0;
  let runStart: PathEdge | null = null;
  pathEdges.forEach((p, i) => {
    if (p.edge.kind !== "steps") return;
    runStart ??= p;
    if (
      pathEdges[i + 1]?.edge.kind !== "steps" ||
      venueConnectionId(pathEdges[i + 1].edge) !== venueConnectionId(p.edge)
    ) {
      floors += floorsOf(runStart, p);
      runStart = null;
    }
  });
  return floors;
}

/**
 * Splits the path where its building or floor changes. A stair or ramp
 * vertex between two floors stays with the floor it leaves.
 *
 * @returns Segments covering the whole path, in order.
 */
function segmentsOf(
  pathNodes: VenueNode[],
  levelRefs: (string | null)[],
): VenueRouteSegment[] {
  const segments: VenueRouteSegment[] = [];
  pathNodes.forEach((n, i) => {
    const current = segments.at(-1);
    const betweenFloors = n.buildingId !== null && levelRefs[i] === null;
    if (
      current &&
      (betweenFloors ||
        (current.buildingId === n.buildingId &&
          current.levelRef === levelRefs[i]))
    ) {
      current.pathEnd = i;
      return;
    }
    if (current) current.pathEnd = i;
    segments.push({
      buildingId: n.buildingId,
      levelRef: levelRefs[i],
      pathStart: i,
      pathEnd: i,
    });
  });
  return segments;
}

/**
 * @returns The step class of an edge for grouping.
 */
function classOf(
  e: VenueEdge,
): "elevator" | "escalator" | "stairs" | "steps" | "ramp" | "walk" {
  if (e.kind === "elevator") return "elevator";
  if (e.kind === "escalator") return "escalator";
  if (e.kind === "steps") return e.indoor ? "stairs" : "steps";
  if (e.ramp || (e.slopeRatio ?? 0) >= RAMP_MIN_SLOPE_RATIO) return "ramp";
  return "walk";
}

/**
 * Groups path edges into instructions: building entry/exit, elevator rides,
 * stair flights, ramps and walking runs split at turns.
 */
function buildSteps(
  pathEdges: PathEdge[],
  fromPlace: VenuePlace,
  toPlace: VenuePlace,
  buildings: Map<string, VenueBuilding>,
  levelRef: (n: VenueNode) => string | null,
  lang: SupportedLang,
): VenueRouteStep[] {
  const name = (id: string | null) =>
    id ? (buildings.get(id)?.name ?? id) : "";
  const steps: VenueRouteStep[] = [];
  const last = pathEdges.length;
  steps.push({
    type: "depart",
    instruction: t(
      `從${fromPlace.name}出發`,
      `Start at ${fromPlace.name}`,
    )(lang),
    distanceM: 0,
    durationS: 0,
    buildingId: fromPlace.buildingId,
    levelRef: fromPlace.levelRef,
    pathStart: 0,
    pathEnd: 0,
  });

  const contextOf = (p: PathEdge) =>
    p.edge.indoor ? (p.to.buildingId ?? p.from.buildingId) : null;
  let prevContext =
    fromPlace.buildingId && pathEdges[0]?.edge.indoor
      ? fromPlace.buildingId
      : null;

  let k = 0;
  while (k < last) {
    const p = pathEdges[k];
    const ctx = contextOf(p);
    if (ctx !== prevContext) {
      if (prevContext !== null && ctx === null) {
        steps.push(
          zeroStep(
            "exit",
            t(`離開${name(prevContext)}`, `Exit ${name(prevContext)}`)(lang),
            prevContext,
            levelRef(p.from),
            p.i,
          ),
        );
      } else if (ctx !== null) {
        const lvl = levelRef(p.to) ?? levelRef(p.from);
        steps.push(
          zeroStep(
            "enter",
            t(
              `進入${name(ctx)}${lvl ? `（${lvl}）` : ""}`,
              `Enter ${name(ctx)}${lvl ? ` (${lvl})` : ""}`,
            )(lang),
            ctx,
            lvl,
            p.i,
          ),
        );
      }
      prevContext = ctx;
    }

    const cls = classOf(p.edge);
    let j = k + 1;
    while (
      j < last &&
      classOf(pathEdges[j].edge) === cls &&
      contextOf(pathEdges[j]) === ctx &&
      venueConnectionId(pathEdges[j].edge) === venueConnectionId(p.edge) &&
      (cls !== "walk" || pathEdges[j].from.ordinal === p.from.ordinal)
    ) {
      j += 1;
    }
    const run = pathEdges.slice(k, j);
    const first = run[0];
    const end = run[run.length - 1];
    const dist = run.reduce(
      (s, r) => s + (r.edge.kind === "elevator" ? 0 : r.edge.lengthM),
      0,
    );
    const dur = run.reduce((s, r) => s + r.durationS, 0);
    const base = {
      buildingId: ctx,
      pathStart: first.i,
      pathEnd: end.i + 1,
      distanceM: Math.round(dist),
      durationS: Math.round(dur),
      ...(cls !== "walk"
        ? { connectionId: venueConnectionId(first.edge) }
        : {}),
      ...heightPendingOf(run),
    };
    const l1 = levelRef(first.from);
    const l2 = levelRef(end.to);

    if (cls === "elevator") {
      steps.push({
        ...base,
        type: "elevator",
        levelRef: l1,
        fromLevelRef: l1 ?? undefined,
        toLevelRef: l2 ?? undefined,
        instruction: t(
          `搭電梯從 ${l1} 到 ${l2}`,
          `Take the elevator from ${l1} to ${l2}`,
        )(lang),
      });
    } else if (cls === "escalator") {
      steps.push({
        ...base,
        type: "escalator",
        levelRef: l1,
        fromLevelRef: l1 ?? undefined,
        toLevelRef: l2 ?? undefined,
        instruction:
          l1 && l2 && l1 !== l2
            ? t(
                `搭手扶梯從 ${l1} 到 ${l2}`,
                `Take the escalator from ${l1} to ${l2}`,
              )(lang)
            : t("搭手扶梯", "Take the escalator")(lang),
      });
    } else if (cls === "stairs" && floorsOf(first, end) > 0) {
      const up = (end.to.ordinal ?? 0) > (first.from.ordinal ?? 0);
      const floors = floorsOf(first, end);
      steps.push({
        ...base,
        type: "stairs",
        levelRef: l1,
        fromLevelRef: l1 ?? undefined,
        toLevelRef: l2 ?? undefined,
        instruction: t(
          `走樓梯從 ${l1} ${up ? "上" : "下"}到 ${l2}（${floors} 層）`,
          `Take the stairs ${up ? "up" : "down"} from ${l1} to ${l2} (${floors} ${floors === 1 ? "floor" : "floors"})`,
        )(lang),
      });
    } else if (cls === "steps" || cls === "stairs") {
      // outdoor steps, or a few steps inside one floor
      const count = run.find((r) => r.edge.stepCount)?.edge.stepCount;
      steps.push({
        ...base,
        type: "steps",
        levelRef: cls === "stairs" ? l1 : null,
        instruction: count
          ? t(`走 ${count} 階階梯`, `Take ${count} steps`)(lang)
          : t("走階梯", "Take the steps")(lang),
      });
    } else if (cls === "ramp") {
      const rise = end.to.z - first.from.z;
      const directionZh = rise > 0 ? "上行" : rise < 0 ? "下行" : "";
      const directionEn = rise > 0 ? "up" : rise < 0 ? "down" : "along";
      const grade =
        Math.round(Math.max(...run.map((r) => r.edge.slopeRatio ?? 0)) * 1000) /
        10;
      const status = leastCertain(
        run.map((r) => r.edge.slopeStatus ?? "estimated"),
      );
      // an estimated grade is never stated as a number
      const gradeZh =
        status === "estimated"
          ? "（坡度未實測）"
          : grade > 0
            ? `（坡度約 ${grade}%${status === "measured" ? "" : "，未實測"}）`
            : "";
      const gradeEn =
        status === "estimated"
          ? " (grade not surveyed)"
          : grade > 0
            ? ` (about ${grade}% grade${status === "measured" ? "" : ", not surveyed"})`
            : "";
      steps.push({
        ...base,
        type: "ramp",
        levelRef: l1,
        instruction: t(
          `走坡道${directionZh}約 ${base.distanceM} 公尺${gradeZh}`,
          `Go ${directionEn} the ramp for ${base.distanceM} m${gradeEn}`,
        )(lang),
      });
    } else {
      steps.push(...walkSteps(run, ctx, ctx ? name(ctx) : "", levelRef, lang));
    }
    k = j;
  }

  if (prevContext !== null && toPlace.buildingId === null) {
    steps.push(
      zeroStep(
        "exit",
        t(`離開${name(prevContext)}`, `Exit ${name(prevContext)}`)(lang),
        prevContext,
        null,
        last,
      ),
    );
  }
  steps.push({
    type: "arrive",
    instruction: arrivalInstruction(toPlace, lang),
    distanceM: 0,
    durationS: 0,
    buildingId: toPlace.buildingId,
    levelRef: toPlace.levelRef,
    pathStart: last,
    pathEnd: last,
  });
  return steps;
}

/** Preserve authored unknown-height semantics across an instruction run. */
function heightPendingOf(
  run: PathEdge[],
): Pick<VenueRouteStep, "heightPending"> {
  return run.some((p) => p.edge.heightPending !== undefined)
    ? { heightPending: run.some((p) => p.edge.heightPending === true) }
    : {};
}

/** Arrival wording is based only on typed source semantics. */
function arrivalInstruction(place: VenuePlace, lang: SupportedLang): string {
  if (place.arrivalKind === "corridor") {
    return t(
      `抵達${place.name}附近走廊`,
      `Arrive at the corridor near ${place.name}`,
    )(lang);
  }
  if (place.arrivalKind === "door" && place.doorKnown === true) {
    return t(
      `抵達${place.name}門口`,
      `Arrive at the door of ${place.name}`,
    )(lang);
  }
  return t(`抵達${place.name}`, `Arrive at ${place.name}`)(lang);
}

function zeroStep(
  type: "enter" | "exit",
  instruction: string,
  buildingId: string | null,
  levelRef: string | null,
  at: number,
): VenueRouteStep {
  return {
    type,
    instruction,
    distanceM: 0,
    durationS: 0,
    buildingId,
    levelRef,
    pathStart: at,
    pathEnd: at,
  };
}

/**
 * Splits one walking run at heading changes of at least {@link TURN_MIN_DEG}.
 * The first part never carries a maneuver: a turn is reported on the part
 * that starts after it. A part shorter than {@link TURN_MIN_RUN_M} after the
 * last turn is folded back into the previous part instead of becoming its own
 * instruction.
 */
function walkSteps(
  run: PathEdge[],
  ctx: string | null,
  buildingName: string,
  levelRef: (n: VenueNode) => string | null,
  lang: SupportedLang,
): VenueRouteStep[] {
  const parts: { from: number; to: number; maneuver?: VenueManeuver }[] = [];
  let partStart = 0;
  let pending: VenueManeuver | undefined;
  let runSinceTurn = 0;
  for (let i = 1; i < run.length; i += 1) {
    runSinceTurn += run[i - 1].edge.lengthM;
    if (run[i - 1].edge.lengthM < 0.5 || run[i].edge.lengthM < 0.5) continue;
    const d = turnDeg(
      bearingDeg(run[i - 1].from, run[i - 1].to),
      bearingDeg(run[i].from, run[i].to),
    );
    if (Math.abs(d) >= TURN_MIN_DEG && runSinceTurn >= TURN_MIN_RUN_M) {
      parts.push({
        from: partStart,
        to: i,
        ...(pending ? { maneuver: pending } : {}),
      });
      partStart = i;
      pending =
        Math.abs(d) >= UTURN_MIN_DEG ? "uturn" : d > 0 ? "right" : "left";
      runSinceTurn = 0;
    }
  }
  parts.push({
    from: partStart,
    to: run.length,
    ...(pending ? { maneuver: pending } : {}),
  });
  const lengthOf = (pt: { from: number; to: number }) =>
    run.slice(pt.from, pt.to).reduce((s, r) => s + r.edge.lengthM, 0);
  if (parts.length > 1 && lengthOf(parts[parts.length - 1]) < TURN_MIN_RUN_M) {
    const tail = parts.pop() as { from: number; to: number };
    parts[parts.length - 1].to = tail.to;
  }

  return parts.map((pt) => {
    const part = run.slice(pt.from, pt.to);
    const dist = Math.round(part.reduce((s, r) => s + r.edge.lengthM, 0));
    const dur = Math.round(part.reduce((s, r) => s + r.durationS, 0));
    const lvl = levelRef(part[0].from) ?? "";
    const m = pt.maneuver;
    const turnZh =
      m === "left"
        ? "左轉，"
        : m === "right"
          ? "右轉，"
          : m === "uturn"
            ? "迴轉，"
            : "";
    const turnEn =
      m === "left"
        ? "Turn left, then w"
        : m === "right"
          ? "Turn right, then w"
          : m === "uturn"
            ? "Turn around, then w"
            : "W";
    const zh = ctx
      ? `${turnZh}沿${buildingName} ${lvl} 走廊前進約 ${dist} 公尺`
      : `${turnZh}沿步道前進約 ${dist} 公尺`;
    const en = ctx
      ? `${turnEn}alk about ${dist} m along the ${lvl} corridor of ${buildingName}`
      : `${turnEn}alk about ${dist} m along the path`;
    return {
      type: "walk" as const,
      instruction: t(zh, en)(lang),
      ...(m ? { maneuver: m } : {}),
      distanceM: dist,
      durationS: dur,
      buildingId: ctx,
      levelRef: levelRef(part[0].from),
      pathStart: part[0].i,
      pathEnd: part[part.length - 1].i + 1,
      ...heightPendingOf(part),
    };
  });
}
