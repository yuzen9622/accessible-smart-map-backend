import { NAV_MSG } from "../../../../constants/messages";
import type { AccessibilityMode, WalkStep } from "../../../../types/route";
import {
  calcBearing,
  degToCompassWord,
  haversineCoords,
} from "../../../../utils/geo";
import type { EdgeGeometrySpan } from "./a11y-segments";
import { EDGE_TYPE, NODE_FLAG, type PedGraph } from "./graph.types";
import type { LngLat } from "./ped-graph-geometry.repository";

/** Steep-slope percentage threshold this engine applies to `wheelchair` mode. */
export const WHEELCHAIR_STEEP_SLOPE_THRESHOLD_PERCENT = 8.3;

/** Steep-slope percentage threshold this engine applies to every other mode. */
export const STANDARD_STEEP_SLOPE_THRESHOLD_PERCENT = 12;

/** Turn-angle boundary, in degrees, below which a heading change reports as `CONTINUE`. */
export const TURN_ANGLE_SLIGHT_DEG = 20;

/** Turn-angle boundary, in degrees, at and above which a turn reports as `LEFT`/`RIGHT`. */
export const TURN_ANGLE_STANDARD_DEG = 45;

/** Turn-angle boundary, in degrees, at and above which a turn reports as `HARD_LEFT`/`HARD_RIGHT`. */
export const TURN_ANGLE_HARD_DEG = 135;

const FACILITY_INSTRUCTION: Record<string, string> = {
  ELEVATOR: NAV_MSG.ELEVATOR,
  ESCALATOR: NAV_MSG.ESCALATOR,
  MOVING_WALKWAY: NAV_MSG.MOVING_WALKWAY,
  FARE_GATE: NAV_MSG.FARE_GATE,
  ENTER_STATION: NAV_MSG.ENTER_STATION,
  EXIT_STATION: NAV_MSG.EXIT_STATION,
};

/**
 * @param mode Requested accessibility mode.
 * @returns The steep-slope percentage threshold this mode observes.
 */
function steepSlopeThresholdPercent(mode: AccessibilityMode): number {
  return mode === "wheelchair"
    ? WHEELCHAIR_STEEP_SLOPE_THRESHOLD_PERCENT
    : STANDARD_STEEP_SLOPE_THRESHOLD_PERCENT;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Dense edge attribute identifier.
 * @param mode Requested accessibility mode.
 * @returns Whether the edge's absolute slope observation is at or above this
 * mode's steep-slope threshold. Always false when the edge has no slope
 * measurement — absence is "not observed", never "confirmed flat".
 */
function isSteepSlope(
  graph: PedGraph,
  attrIdx: number,
  mode: AccessibilityMode,
): boolean {
  const slopeRatio = graph.edgeSlope[attrIdx];
  if (!Number.isFinite(slopeRatio)) return false;
  const slopePercent = Math.abs(slopeRatio) * 100;
  return slopePercent >= steepSlopeThresholdPercent(mode);
}

/**
 * @param edgeType `PedGraph.edgeType` value of the traversed edge.
 * @returns The facility direction token this edge's own type always
 * represents, or null when its direction depends on turn angle or on its
 * node-level indoor/outdoor transition instead.
 */
function facilityDirection(edgeType: number): string | null {
  if (
    edgeType === EDGE_TYPE.OSM_ELEVATOR ||
    edgeType === EDGE_TYPE.INDOOR_ELEVATOR
  ) {
    return "ELEVATOR";
  }
  if (edgeType === EDGE_TYPE.INDOOR_ESCALATOR) return "ESCALATOR";
  if (edgeType === EDGE_TYPE.INDOOR_MOVING_WALKWAY) return "MOVING_WALKWAY";
  if (
    edgeType === EDGE_TYPE.INDOOR_FARE_GATE ||
    edgeType === EDGE_TYPE.INDOOR_EXIT_GATE
  ) {
    return "FARE_GATE";
  }
  return null;
}

/**
 * @param graph CSR pedestrian graph.
 * @param nodePath Traversed dense node identifiers, one longer than `edgeAttrPath`.
 * @param step Position of this edge in the traversal.
 * @returns `ENTER_STATION` when this edge's two endpoints cross from an
 * outdoor node into an indoor one, `EXIT_STATION` for the reverse crossing,
 * or null when both endpoints share the same indoor/outdoor state.
 */
function connectorDirection(
  graph: PedGraph,
  nodePath: Int32Array,
  step: number,
): "ENTER_STATION" | "EXIT_STATION" | null {
  const fromIndoor = (graph.nodeFlags[nodePath[step]] & NODE_FLAG.INDOOR) !== 0;
  const toIndoor =
    (graph.nodeFlags[nodePath[step + 1]] & NODE_FLAG.INDOOR) !== 0;
  if (fromIndoor === toIndoor) return null;
  return toIndoor ? "ENTER_STATION" : "EXIT_STATION";
}

/**
 * @param delta Turn angle in degrees, positive meaning a clockwise (right) turn.
 * @returns The relative-direction token this angle falls into. Boundaries are
 * lower-bound-inclusive, upper-bound-exclusive.
 */
export function turnDirection(delta: number): string {
  const magnitude = Math.abs(delta);
  if (magnitude < TURN_ANGLE_SLIGHT_DEG) return "CONTINUE";
  const isRight = delta > 0;
  if (magnitude < TURN_ANGLE_STANDARD_DEG) {
    return isRight ? "SLIGHTLY_RIGHT" : "SLIGHTLY_LEFT";
  }
  if (magnitude < TURN_ANGLE_HARD_DEG) {
    return isRight ? "RIGHT" : "LEFT";
  }
  return isRight ? "HARD_RIGHT" : "HARD_LEFT";
}

/**
 * @param bearing Normalized to any real number of degrees.
 * @returns The equivalent bearing normalized to [0, 360).
 */
function normalizeBearingDeg(bearing: number): number {
  return ((bearing % 360) + 360) % 360;
}

/**
 * @param current Bearing of the current edge's entry heading, in degrees.
 * @param previous Bearing of the previous edge's exit heading, in degrees.
 * @returns The signed turn angle from `previous` to `current`, normalized to
 * (-180, 180], positive meaning a clockwise (right) turn.
 */
function turnAngleDeg(current: number, previous: number): number {
  const delta = normalizeBearingDeg(current) - normalizeBearingDeg(previous);
  if (delta > 180) return delta - 360;
  if (delta <= -180) return delta + 360;
  return delta;
}

/**
 * @param polyline Assembled walking polyline, including snap connectors.
 * @param startIndex Inclusive polyline index the edge's span starts at.
 * @param endIndex Inclusive polyline index the edge's span ends at.
 * @returns The bearing of the span's first geometry segment and of its last
 * geometry segment, or null for either when the span has no internal segment
 * (a single-point span, such as a facility proxy edge).
 */
function spanBearings(
  polyline: readonly LngLat[],
  startIndex: number,
  endIndex: number,
): { entry: number | null; exit: number | null } {
  if (endIndex <= startIndex) return { entry: null, exit: null };
  return {
    entry: calcBearing(polyline[startIndex], polyline[startIndex + 1]),
    exit: calcBearing(polyline[endIndex - 1], polyline[endIndex]),
  };
}

/**
 * @param polyline Assembled walking polyline, including snap connectors.
 * @param startIndex Inclusive polyline index the edge's span starts at.
 * @param endIndex Inclusive polyline index the edge's span ends at.
 * @returns The cumulative great-circle distance across the span's geometry
 * segments, in metres. Zero for a single-point span.
 */
function spanHaversineM(
  polyline: readonly LngLat[],
  startIndex: number,
  endIndex: number,
): number {
  let total = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const from = polyline[index];
    const to = polyline[index + 1];
    if (!from || !to) continue;
    total += haversineCoords(from, to);
  }
  return total;
}

/**
 * @param degrees Bearing in degrees, or null when unavailable.
 * @returns The eight-point compass word for that bearing, or null when the
 * bearing itself is unavailable.
 */
function absoluteDirectionWord(degrees: number | null): string | null {
  return degrees === null ? null : degToCompassWord(degrees);
}

/**
 * Derive turn-by-turn `WalkStep`s from one CSR-selected walking path.
 *
 * Every step's location and bearing are read from the assembled polyline
 * geometry (never approximated from node coordinates), reusing the same
 * `spans` + `indexOffset` index mapping `buildA11ySegments` establishes. The
 * CSR graph carries no street names, so every step is emitted with
 * `streetName: ""` and `bogusName: true`; downstream text generation already
 * degrades gracefully for that combination.
 *
 * @param graph CSR pedestrian graph.
 * @param nodePath Traversed dense node identifiers, in traversal order (one
 * longer than `edgeAttrPath`).
 * @param edgeAttrPath Selected directed edge attribute identifiers, in
 * traversal order.
 * @param spans Polyline index range contributed by each traversed edge,
 * unshifted by `indexOffset`, in the same order and length as `edgeAttrPath`.
 * @param polyline Assembled walking polyline, including counted snap connectors.
 * @param indexOffset Amount every span index must be shifted by to address
 * `polyline`, matching an unshifted origin snap connector.
 * @param mode Requested accessibility mode, deciding the steep-slope threshold.
 * @returns One `WalkStep` per traversed edge, in traversal order.
 */
export function buildCsrWalkSteps(
  graph: PedGraph,
  nodePath: Int32Array,
  edgeAttrPath: Int32Array,
  spans: readonly EdgeGeometrySpan[],
  polyline: readonly LngLat[],
  indexOffset: number,
  mode: AccessibilityMode,
): WalkStep[] {
  const stepCount = Math.min(spans.length, edgeAttrPath.length);
  const steps: WalkStep[] = [];
  let lastExitBearing: number | null = null;

  for (let step = 0; step < stepCount; step += 1) {
    const attrIdx = edgeAttrPath[step];
    const startIndex = spans[step].startIndex + indexOffset;
    const endIndex = spans[step].endIndex + indexOffset;
    const location = polyline[startIndex] ?? polyline[endIndex];

    const rawLengthM = graph.edgeLengthM[attrIdx];
    const distanceM =
      Number.isFinite(rawLengthM) && rawLengthM >= 0
        ? rawLengthM
        : spanHaversineM(polyline, startIndex, endIndex);

    const stairs =
      graph.edgeType[attrIdx] === EDGE_TYPE.STEPS ||
      graph.edgeType[attrIdx] === EDGE_TYPE.INDOOR_STAIRS;

    const { entry: entryBearing, exit: exitBearing } = spanBearings(
      polyline,
      startIndex,
      endIndex,
    );

    const facility = facilityDirection(graph.edgeType[attrIdx]);
    const connector =
      facility === null ? connectorDirection(graph, nodePath, step) : null;

    let relativeDirection: string;
    if (step === 0) {
      relativeDirection = "DEPART";
    } else if (facility !== null) {
      relativeDirection = facility;
    } else if (connector !== null) {
      relativeDirection = connector;
    } else if (entryBearing === null || lastExitBearing === null) {
      relativeDirection = "CONTINUE";
    } else {
      relativeDirection = turnDirection(
        turnAngleDeg(entryBearing, lastExitBearing),
      );
    }

    const isFacilityStep =
      relativeDirection !== "DEPART" &&
      (facility !== null || connector !== null);

    const walkStep: WalkStep = {
      relativeDirection,
      absoluteDirection: absoluteDirectionWord(entryBearing),
      streetName: "",
      bogusName: true,
      area: false,
      stairs,
      distanceM,
      location,
      steepSlope: isSteepSlope(graph, attrIdx, mode),
      ...(isFacilityStep
        ? { instruction: FACILITY_INSTRUCTION[relativeDirection] }
        : {}),
    };
    steps.push(walkStep);

    if (exitBearing !== null) lastExitBearing = exitBearing;
  }

  return steps;
}
