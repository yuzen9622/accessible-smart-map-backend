import { EDGE_FLAG, EDGE_TYPE, type PedGraph } from "./graph.types";
import type { CsrWalkA11yFeature, CsrWalkA11ySegment } from "./csr-walk.types";

/** Inclusive polyline index range contributed by one traversed edge. */
export interface EdgeGeometrySpan {
  startIndex: number;
  endIndex: number;
}

/**
 * @param edgeType `PedGraph.edgeType` value of one traversed edge.
 * @param edgeFlags `PedGraph.edgeFlags` value of the same edge.
 * @returns The facility class this edge should be reported as, or null when it
 * carries no classifiable accessibility observation.
 */
export function classifyEdgeFeature(
  edgeType: number,
  edgeFlags: number,
): CsrWalkA11yFeature | null {
  const hasRamp = (edgeFlags & EDGE_FLAG.HAS_RAMP) !== 0;

  if (
    edgeType === EDGE_TYPE.OSM_ELEVATOR ||
    edgeType === EDGE_TYPE.INDOOR_ELEVATOR
  ) {
    return "elevator";
  }
  if (edgeType === EDGE_TYPE.INDOOR_ESCALATOR) return "escalator";
  if (edgeType === EDGE_TYPE.INDOOR_MOVING_WALKWAY) return "moving_walkway";
  if (edgeType === EDGE_TYPE.STEPS || edgeType === EDGE_TYPE.INDOOR_STAIRS) {
    return "stairs";
  }
  if (edgeType === EDGE_TYPE.INDOOR_FARE_GATE) return "fare_gate";
  if (edgeType === EDGE_TYPE.INDOOR_EXIT_GATE) return "exit_gate";
  if (edgeType === EDGE_TYPE.CROSSING) {
    return hasRamp ? "curb_ramp_crossing" : "crossing";
  }
  if (hasRamp) return "ramp";
  return null;
}

interface OpenRun {
  feature: CsrWalkA11yFeature;
  startIndex: number;
  endIndex: number;
  indoor: boolean;
  distanceM: number | null;
  distanceKnown: boolean;
  maxSlopePercent: number | null;
  minWidthCm: number | null;
}

/**
 * @param run Open run accumulator to finalize.
 * @returns The rounded, client-facing segment for that run.
 */
function closeRun(run: OpenRun): CsrWalkA11ySegment {
  return {
    feature: run.feature,
    startIndex: run.startIndex,
    endIndex: run.endIndex,
    indoor: run.indoor,
    distanceM: run.distanceKnown
      ? Math.round((run.distanceM ?? 0) * 10) / 10
      : null,
    maxSlopePercent:
      run.maxSlopePercent === null
        ? null
        : Math.round(run.maxSlopePercent * 10) / 10,
    minWidthCm: run.minWidthCm === null ? null : Math.round(run.minWidthCm),
  };
}

/**
 * @param graph CSR pedestrian graph.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @param spans Polyline index range contributed by each traversed edge, in
 * the same order and length as `edgeAttrPath`.
 * @param indexOffset Amount every span index must be shifted by before it is
 * reported, matching an unshifted origin snap connector prepended to the
 * returned polyline.
 * @returns Ordered, non-overlapping facility runs over that polyline.
 */
export function buildA11ySegments(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
  spans: readonly EdgeGeometrySpan[],
  indexOffset: number,
): CsrWalkA11ySegment[] {
  const segments: CsrWalkA11ySegment[] = [];
  let open: OpenRun | null = null;
  const stepCount = Math.min(spans.length, edgeAttrPath.length);

  for (let step = 0; step < stepCount; step += 1) {
    const attrIdx = edgeAttrPath[step];
    const feature = classifyEdgeFeature(
      graph.edgeType[attrIdx],
      graph.edgeFlags[attrIdx],
    );
    if (feature === null) {
      if (open !== null) {
        segments.push(closeRun(open));
        open = null;
      }
      continue;
    }

    const indoor = (graph.edgeFlags[attrIdx] & EDGE_FLAG.INDOOR) !== 0;
    const startIndex = spans[step].startIndex + indexOffset;
    const endIndex = spans[step].endIndex + indexOffset;

    const lengthM = graph.edgeLengthM[attrIdx];
    const hasLength = Number.isFinite(lengthM) && lengthM >= 0;

    const slopeRatio = graph.edgeSlope[attrIdx];
    const slopePercent = Number.isFinite(slopeRatio)
      ? Math.abs(slopeRatio) * 100
      : null;

    const widthM = graph.edgeWidthM[attrIdx];
    const widthCm = Number.isFinite(widthM) && widthM > 0 ? widthM * 100 : null;

    if (
      open !== null &&
      open.feature === feature &&
      open.indoor === indoor &&
      open.endIndex === startIndex
    ) {
      open.endIndex = endIndex;
      open.distanceKnown = open.distanceKnown && hasLength;
      open.distanceM =
        open.distanceKnown && hasLength
          ? (open.distanceM ?? 0) + lengthM
          : null;
      open.maxSlopePercent =
        slopePercent === null
          ? open.maxSlopePercent
          : open.maxSlopePercent === null
            ? slopePercent
            : Math.max(open.maxSlopePercent, slopePercent);
      open.minWidthCm =
        widthCm === null
          ? open.minWidthCm
          : open.minWidthCm === null
            ? widthCm
            : Math.min(open.minWidthCm, widthCm);
      continue;
    }

    if (open !== null) segments.push(closeRun(open));
    open = {
      feature,
      startIndex,
      endIndex,
      indoor,
      distanceM: hasLength ? lengthM : null,
      distanceKnown: hasLength,
      maxSlopePercent: slopePercent,
      minWidthCm: widthCm,
    };
  }

  if (open !== null) segments.push(closeRun(open));
  return segments;
}
