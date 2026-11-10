import { decode, encode } from "@googlemaps/polyline-codec";
import {
  computeValhallaTraceAttributes,
  type ValhallaCosting,
  type NormalizedRoadTraceSpan,
} from "../../../adapters/valhalla.adapter";
import {
  isValhallaReleaseCurrent,
  type ValhallaReleaseSnapshot,
} from "../../../adapters/valhalla-release.adapter";
import {
  VALHALLA_METADATA_BUDGET_MS,
  VALHALLA_METADATA_CONCURRENCY,
  VALHALLA_MAX_ORIENTATION_COMPARISONS,
  VALHALLA_LANE_PREP_DISTANCE_M,
} from "../../../config/valhalla";
import { haversineCoords } from "../../../utils/geo";
import type { AccessibleRoute, DriveLeg } from "../../../types/route";
import type {
  DirectedRoadSpan,
  RoadMatchingData,
  RoadSpeedLimitSegment,
  RoadSpeedLimits,
  RoadSpeedRules,
} from "../../../types/road-guidance";
import {
  attachRoadMatchingData,
  geometrySha256,
} from "../../../utils/road-matching-data";

type OrientedSpan = Omit<DirectedRoadSpan, "osmForward"> & {
  osmForward?: boolean;
};

export function osmTraversalDirection(
  trace: [number, number][],
  way: [number, number][],
): boolean | undefined {
  if (
    trace.length < 2 ||
    way.length < 2 ||
    trace.length * way.length > VALHALLA_MAX_ORIENTATION_COMPARISONS
  )
    return undefined;
  const quantize = (points: [number, number][]) =>
    points.map(
      ([x, y]) =>
        [Math.round(x * 1e6), Math.round(y * 1e6)] as [number, number],
    );
  const input = quantize(trace),
    source = quantize(way);
  let direction: boolean | undefined;
  for (let i = 1; i < input.length; i++) {
    const a = input[i - 1],
      b = input[i];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const candidates: (boolean | undefined)[] = [];
    for (let j = 1; j < source.length; j++) {
      const start = source[j - 1],
        end = source[j];
      const dx = end[0] - start[0],
        dy = end[1] - start[1],
        length = Math.hypot(dx, dy);
      if (!length) continue;
      // At most one polyline6 grid unit of rounding, never a road-distance snap.
      const contains = (point: [number, number]) => {
        const px = point[0] - start[0],
          py = point[1] - start[1];
        const projection = (px * dx + py * dy) / length;
        return (
          Math.abs(px * dy - py * dx) / length <= 1 &&
          projection >= -1 &&
          projection <= length + 1
        );
      };
      if (contains(a) && contains(b)) {
        const dot = (b[0] - a[0]) * dx + (b[1] - a[1]) * dy;
        // Two endpoints can differ by two grid units per axis from rounding alone.
        candidates.push(
          Math.abs(dot) / length > 2 * Math.SQRT2 ? dot > 0 : undefined,
        );
      }
    }
    if (candidates.length !== 1) return undefined;
    const evidence = candidates[0];
    if (evidence === undefined) continue;
    if (direction !== undefined && direction !== evidence) return undefined;
    direction = evidence;
  }
  return direction;
}
function orientSpans(
  polyline: [number, number][],
  spans: NormalizedRoadTraceSpan[],
  rules?: RoadSpeedRules,
): OrientedSpan[] {
  return spans.map((span) => {
    const geometry = rules?.ways[span.osmWayId]?.osmGeometry;
    const osmForward =
      geometry &&
      osmTraversalDirection(
        polyline.slice(span.fromIndex, span.toIndex + 1),
        geometry,
      );
    return {
      fromIndex: span.fromIndex,
      toIndex: span.toIndex,
      directedEdgeId: span.directedEdgeId,
      osmWayId: span.osmWayId,
      ...(osmForward !== undefined ? { osmForward } : {}),
    };
  });
}
type SpeedValue = Pick<RoadSpeedLimitSegment, "kind" | "limitKph" | "source">;
const unknownSpeed = (): SpeedValue => ({
  kind: "unknown",
  limitKph: null,
  source: null,
});
export function buildRoadSpeedLimits(
  values: number[],
  spans: OrientedSpan[],
  rules?: RoadSpeedRules,
): RoadSpeedLimits {
  const perSegment: SpeedValue[] = values.map((value) =>
    value === 0
      ? unknownSpeed()
      : value === 255
        ? { kind: "unlimited", limitKph: null, source: "valhalla" }
        : { kind: "known", limitKph: value, source: "valhalla" },
  );
  for (const span of spans) {
    const way = rules?.ways[span.osmWayId];
    if (!way) continue;
    const rule =
      span.osmForward === undefined
        ? undefined
        : span.osmForward
          ? way.forward
          : way.backward;
    let replacement: SpeedValue | undefined;
    if (
      (span.osmForward === undefined &&
        (way.forward !== undefined || way.backward !== undefined)) ||
      way.unresolvedConditional ||
      way.unresolvedLaneSpecific ||
      rule?.kind === "invalid"
    )
      replacement = unknownSpeed();
    else if (rule?.kind === "known")
      replacement = {
        kind: "known",
        limitKph: rule.limitKph,
        source: "osm_directional",
      };
    else if (rule?.kind === "unlimited")
      replacement = {
        kind: "unlimited",
        limitKph: null,
        source: "osm_directional",
      };
    if (replacement)
      for (let i = span.fromIndex; i < span.toIndex; i++)
        perSegment[i] = replacement;
  }
  const segments: RoadSpeedLimitSegment[] = [];
  perSegment.forEach((value, index) => {
    const previous = segments.at(-1);
    if (
      previous &&
      previous.kind === value.kind &&
      previous.limitKph === value.limitKph &&
      previous.source === value.source
    )
      previous.toIndex = index + 1;
    else
      segments.push({
        fromIndex: index,
        toIndex: index + 1,
        ...value,
      } as RoadSpeedLimitSegment);
  });
  return { status: "available", direction: "along_leg", segments };
}
/**
 * Lanes are shown on the approach to their maneuver: up to `prepM` metres of
 * this leg's own polyline before the turn, never before the previous
 * maneuver, so the range always lies on the road leading into the turn.
 */
export function applyLaneApproachRanges(
  leg: DriveLeg,
  prepM = VALHALLA_LANE_PREP_DISTANCE_M,
): void {
  const maneuvers = leg.maneuvers ?? [];
  maneuvers.forEach((maneuver, index) => {
    delete maneuver.laneApproachRange;
    const toIndex = maneuver.beginShapeIndex;
    if (!maneuver.lanes?.length || toIndex >= leg.polyline.length) return;
    const floor = index > 0 ? maneuvers[index - 1].beginShapeIndex : 0;
    let fromIndex = toIndex;
    let coveredM = 0;
    while (fromIndex > floor && coveredM < prepM) {
      coveredM += haversineCoords(
        leg.polyline[fromIndex - 1],
        leg.polyline[fromIndex],
      );
      fromIndex--;
    }
    if (fromIndex < toIndex)
      maneuver.laneApproachRange = { fromIndex, toIndex };
  });
}
export function unavailableSpeedLimits(
  reason: Extract<RoadSpeedLimits, { status: "unavailable" }>["reason"],
): RoadSpeedLimits {
  return {
    status: "unavailable",
    direction: "along_leg",
    segments: [],
    reason,
  };
}
async function withinDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Metadata deadline")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function enrichRoadRoutes(
  routes: AccessibleRoute[],
  costing: ValhallaCosting,
  snapshot: ValhallaReleaseSnapshot | null,
  callerDeadline?: number,
  budgetMs = VALHALLA_METADATA_BUDGET_MS,
): Promise<void> {
  const deadline = Math.min(
    Date.now() + Math.min(VALHALLA_METADATA_BUDGET_MS, Math.max(0, budgetMs)),
    callerDeadline ?? Infinity,
  );
  const jobs: { route: AccessibleRoute; leg: DriveLeg; legIndex: number }[] =
    [];
  const matching = new Map<AccessibleRoute, RoadMatchingData>();
  for (const route of routes) {
    if (snapshot) route.roadNetwork = { ...snapshot.roadNetwork };
    matching.set(route, {
      tilesetId: snapshot?.roadNetwork.tilesetId ?? "",
      legs: [],
    });
    route.legs.forEach((leg, legIndex) => {
      if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") {
        // Lanes and their shape indices come from this leg's own /route
        // response, so the approach range needs no trace or release check.
        applyLaneApproachRanges(leg);
        jobs.push({ route, leg, legIndex });
      }
    });
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const { route, leg, legIndex } = jobs[cursor++];
      leg.speedLimits = unavailableSpeedLimits("budget_exhausted");
      if (deadline <= Date.now()) continue;
      if (!snapshot) {
        leg.speedLimits = unavailableSpeedLimits("tileset_changed");
        continue;
      }
      try {
        if (
          !(await isValhallaReleaseCurrent(snapshot, deadline - Date.now()))
        ) {
          leg.speedLimits = unavailableSpeedLimits("tileset_changed");
          continue;
        }
        if (deadline <= Date.now()) continue;
        const shape = encode(
          leg.polyline.map(([lng, lat]) => [lat, lng]),
          6,
        );
        const roundTrip = decode(shape, 6).map(([lat, lng]) => [lng, lat]);
        if (JSON.stringify(roundTrip) !== JSON.stringify(leg.polyline)) {
          leg.speedLimits = unavailableSpeedLimits("geometry_mismatch");
          continue;
        }
        const trace = await withinDeadline(
          computeValhallaTraceAttributes({
            shapePolyline6: shape,
            costing,
            timeoutMs: deadline - Date.now(),
            dateTime: { type: 0 },
          }),
          deadline,
        );
        if (deadline <= Date.now()) continue;
        if (
          !(await isValhallaReleaseCurrent(snapshot, deadline - Date.now()))
        ) {
          leg.speedLimits = unavailableSpeedLimits("tileset_changed");
          continue;
        }
        if (trace.status !== "OK") {
          leg.speedLimits = unavailableSpeedLimits(
            trace.status === "NO_MATCH"
              ? "geometry_mismatch"
              : trace.status === "INVALID_RESPONSE"
                ? "invalid_response"
                : "upstream_error",
          );
          continue;
        }
        const rules =
          snapshot.roadNetwork.provenance === "verified" &&
          snapshot.rules?.sourcePbfSha256 ===
            snapshot.roadNetwork.sourcePbfSha256
            ? snapshot.rules
            : undefined;
        const oriented = orientSpans(leg.polyline, trace.spans, rules);
        leg.speedLimits = buildRoadSpeedLimits(
          trace.speedLimitValues,
          oriented,
          rules,
        );
        if (
          oriented.every(
            (span): span is DirectedRoadSpan =>
              typeof span.osmForward === "boolean",
          )
        ) {
          matching.get(route)!.legs.push({
            legIndex,
            geometrySha256: geometrySha256(leg.polyline),
            spans: oriented,
          });
        }
      } catch {
        leg.speedLimits = unavailableSpeedLimits(
          deadline <= Date.now() ? "budget_exhausted" : "upstream_error",
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: VALHALLA_METADATA_CONCURRENCY }, worker),
  );
  const current =
    snapshot &&
    deadline > Date.now() &&
    (await isValhallaReleaseCurrent(snapshot, deadline - Date.now()));
  for (const route of routes) {
    if (!current) {
      for (const leg of route.legs)
        if (
          (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") &&
          leg.speedLimits?.status === "available"
        )
          leg.speedLimits = unavailableSpeedLimits(
            deadline <= Date.now() ? "budget_exhausted" : "tileset_changed",
          );
    } else {
      const data = matching.get(route)!;
      data.legs.sort((a, b) => a.legIndex - b.legIndex);
      attachRoadMatchingData(route, data);
    }
  }
}
