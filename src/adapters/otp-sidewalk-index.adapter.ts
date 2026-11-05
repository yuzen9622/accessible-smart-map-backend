import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AccessibleRoute, WalkLeg } from "../types/route";
import { haversineCoords } from "../utils/geo";

const CELL = 0.001;
const MAX_OFFSET_M = 1.75;
// OTP encodes legGeometry at 1e-5°, so each vertex can sit ~0.75 m off its OSM node.
const POLYLINE_TOLERANCE_M = 0.8;
/**
 * A walk leg crosses a classified crossing when BOTH of the crossing's end
 * points lie this close to the leg's polyline: walking along the kerb past a
 * crossing touches one end only. Covers OTP's 1e-5° rounding plus the street
 * linker snapping a leg a couple of metres off the OSM node.
 */
export const CROSSING_END_MATCH_M = 3;
const Longitude = z.number().finite().min(-180).max(180);
const Latitude = z.number().finite().min(-90).max(90);
const Segment = z
  .tuple([
    z.enum(["sidewalk", "other"]),
    Longitude,
    Latitude,
    Longitude,
    Latitude,
    z.number().int().nonnegative(),
  ])
  .refine(
    ([, ax, ay, bx, by]) =>
      haversineCoords([ax, ay], [bx, by]) <= 110 &&
      Math.abs(Math.floor(ax / CELL) - Math.floor(bx / CELL)) <= 2 &&
      Math.abs(Math.floor(ay / CELL) - Math.floor(by / CELL)) <= 2,
    "Source segments must fit the exporter's 100m fragments and bounded grid",
  );
const EndCount = z.number().int().min(0).max(2);
/**
 * `[wayId, ramped, unramped, unknown, coordinates]` — one row per crossing way
 * that otp-kerb-ramps.py classified (index version 2).
 */
const Crossing = z
  .tuple([
    z.number().int().nonnegative(),
    EndCount,
    EndCount,
    EndCount,
    z
      .array(z.tuple([Longitude, Latitude]))
      .min(2)
      .max(1000),
  ])
  .refine(
    ([, ramped, unramped, unknown]) => ramped + unramped + unknown === 2,
    "A crossing has exactly two classified ends",
  );
export type IndexedCrossing = z.infer<typeof Crossing>;

const IndexBase = {
  sourcePbfSha256: z.string().regex(/^[a-f0-9]{64}$/),
  segments: z.array(z.unknown()).max(3_000_000),
};
/** v1 has no crossing evidence; v2 must carry its crossings (an empty list is a real "none classified"). */
export const OtpSidewalkIndexSchema = z
  .discriminatedUnion("version", [
    z.object({ version: z.literal(1), ...IndexBase }),
    z.object({
      version: z.literal(2),
      ...IndexBase,
      crossings: z.array(Crossing).max(500_000),
    }),
  ])
  .transform((value, context) => {
    const segments: z.infer<typeof Segment>[] = [];
    for (const row of value.segments) {
      const parsed = Segment.safeParse(row);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          message: "Invalid sidewalk index fragment",
        });
        return z.NEVER;
      }
      segments.push(parsed.data);
    }
    return { ...value, segments };
  });
type IndexedSegment = z.infer<typeof Segment>;
type SidewalkSegment = NonNullable<WalkLeg["sidewalkSegments"]>[number];
type SpatialIndex = Map<string, IndexedSegment[]>;
type CrossingIndex = Map<string, IndexedCrossing[]>;
interface LoadedIndex {
  segments: SpatialIndex;
  crossings: CrossingIndex;
}
/**
 * A failed load (unreadable file, SHA mismatch, bad shape) is retried after this
 * long even when the files did not change: fixing permissions, for example,
 * leaves mtime and size alone.
 */
export const INDEX_RETRY_AFTER_FAILURE_MS = 60_000;
let cache:
  | { key: string; index: Promise<LoadedIndex | null>; failedAt?: number }
  | undefined;

function cellKey([lng, lat]:
  readonly [number, number] | readonly number[]): string {
  return Math.floor(lng / CELL) + "," + Math.floor(lat / CELL);
}

/** Crossings bucketed by the grid cell of their first end point. */
export function buildCrossingIndex(
  crossings: readonly IndexedCrossing[],
): CrossingIndex {
  const index: CrossingIndex = new Map();
  for (const crossing of crossings) {
    const key = cellKey(crossing[4][0]);
    const bucket = index.get(key);
    if (bucket) bucket.push(crossing);
    else index.set(key, [crossing]);
  }
  return index;
}

function pointToPolylineM(
  point: readonly [number, number],
  polyline: WalkLeg["polyline"],
): number {
  const scale = 111320 * Math.cos((point[1] * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const ax = (polyline[i][0] - point[0]) * scale;
    const ay = (polyline[i][1] - point[1]) * 111320;
    const bx = (polyline[i + 1][0] - point[0]) * scale;
    const by = (polyline[i + 1][1] - point[1]) * 111320;
    const dx = bx - ax;
    const dy = by - ay;
    const squared = dx * dx + dy * dy;
    const t =
      squared === 0
        ? 0
        : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / squared));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  if (polyline.length === 1) {
    best = Math.hypot(
      (polyline[0][0] - point[0]) * scale,
      (polyline[0][1] - point[1]) * 111320,
    );
  }
  return best;
}

/**
 * @param polyline Walk leg geometry in [lng, lat].
 * @param index Crossings from the deployed index.
 * @returns Each classified crossing the leg walks across, once per OSM way.
 */
export function matchCrossings(
  polyline: WalkLeg["polyline"],
  index: CrossingIndex | readonly IndexedCrossing[],
): IndexedCrossing[] {
  const grid = index instanceof Map ? index : buildCrossingIndex(index);
  const candidates = new Map<number, IndexedCrossing>();
  const visited = new Set<string>();
  // Every cell each polyline segment passes over (plus one cell of margin), so a
  // long two-point leg still finds a crossing it walks across mid-segment.
  for (let k = 0; k < polyline.length; k++) {
    const a = polyline[k];
    const b = polyline[Math.min(k + 1, polyline.length - 1)];
    for (
      let i = Math.floor(Math.min(a[0], b[0]) / CELL) - 1;
      i <= Math.floor(Math.max(a[0], b[0]) / CELL) + 1;
      i++
    ) {
      for (
        let j = Math.floor(Math.min(a[1], b[1]) / CELL) - 1;
        j <= Math.floor(Math.max(a[1], b[1]) / CELL) + 1;
        j++
      ) {
        const key = i + "," + j;
        if (visited.has(key)) continue;
        visited.add(key);
        for (const crossing of grid.get(key) ?? []) {
          candidates.set(crossing[0], crossing);
        }
      }
    }
  }
  return [...candidates.values()].filter((crossing) => {
    const points = crossing[4];
    return (
      pointToPolylineM(points[0], polyline) <= CROSSING_END_MATCH_M &&
      pointToPolylineM(points[points.length - 1], polyline) <=
        CROSSING_END_MATCH_M
    );
  });
}

function buildIndex(segments: IndexedSegment[]): SpatialIndex {
  const index: SpatialIndex = new Map();
  for (const segment of segments) {
    const [, ax, ay, bx, by] = segment;
    for (
      let x = Math.floor(Math.min(ax, bx) / CELL);
      x <= Math.floor(Math.max(ax, bx) / CELL);
      x++
    ) {
      for (
        let y = Math.floor(Math.min(ay, by) / CELL);
        y <= Math.floor(Math.max(ay, by) / CELL);
        y++
      ) {
        const key = x + "," + y;
        const bucket = index.get(key);
        if (bucket) bucket.push(segment);
        else index.set(key, [segment]);
      }
    }
  }
  return index;
}

interface Coverage {
  kind: "sidewalk" | "other";
  wayId: number;
  start: number;
  end: number;
}

function coverage(
  a: [number, number],
  b: [number, number],
  segment: IndexedSegment,
): Coverage | null {
  const [kind, ax, ay, bx, by, wayId] = segment;
  const scale = 111320 * Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  const dx = (b[0] - a[0]) * scale;
  const dy = (b[1] - a[1]) * 111320;
  const sx = (bx - ax) * scale;
  const sy = (by - ay) * 111320;
  const squared = sx * sx + sy * sy;
  const length = Math.sqrt(squared);
  if (
    length === 0 ||
    Math.abs((dx * sx + dy * sy) / (Math.hypot(dx, dy) * length)) <
      Math.cos(Math.PI / 6)
  )
    return null;
  const px = (a[0] - ax) * scale;
  const py = (a[1] - ay) * 111320;
  const projection = (px * sx + py * sy) / squared;
  const projectionDelta = (dx * sx + dy * sy) / squared;
  const offset = (px * sy - py * sx) / length;
  const offsetDelta = (dx * sy - dy * sx) / length;
  let start = 0;
  let end = 1;
  for (const [base, delta, low, high] of [
    [projection, projectionDelta, 0, 1],
    [offset, offsetDelta, -MAX_OFFSET_M, MAX_OFFSET_M],
  ]) {
    if (Math.abs(delta) < 1e-12) {
      if (base < low || base > high) return null;
    } else {
      const first = (low - base) / delta;
      const last = (high - base) / delta;
      start = Math.max(start, Math.min(first, last));
      end = Math.min(end, Math.max(first, last));
    }
  }
  if (end - start <= 1e-9) return null;
  return {
    kind,
    wayId,
    start,
    end,
  };
}

/** Only intervals whose complete geometry has unambiguous sidewalk coverage are returned. */
export function matchSidewalkSegments(
  points: WalkLeg["polyline"],
  segments: IndexedSegment[] | SpatialIndex,
  excluded: SidewalkSegment[] = [],
): SidewalkSegment[] {
  const index = Array.isArray(segments) ? buildIndex(segments) : segments;
  const result: SidewalkSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (
      haversineCoords(a, b) < 0.5 ||
      excluded.some((s) => s.startIndex < i + 1 && s.endIndex > i)
    )
      continue;
    const nearby = new Set<IndexedSegment>();
    for (
      let x = Math.floor(Math.min(a[0], b[0]) / CELL) - 1;
      x <= Math.floor(Math.max(a[0], b[0]) / CELL) + 1;
      x++
    ) {
      for (
        let y = Math.floor(Math.min(a[1], b[1]) / CELL) - 1;
        y <= Math.floor(Math.max(a[1], b[1]) / CELL) + 1;
        y++
      ) {
        for (const segment of index.get(x + "," + y) ?? []) nearby.add(segment);
      }
    }
    const spans = Array.from(nearby, (s) => coverage(a, b, s)).filter(
      (s) => s !== null,
    );
    // Shorter overlaps and gaps are polyline quantization, not evidence.
    const tolerance = Math.max(
      POLYLINE_TOLERANCE_M / haversineCoords(a, b),
      1e-8,
    );
    const sidewalks = spans.filter((s) => s.kind === "sidewalk");
    const others = spans.filter((s) => s.kind === "other");
    if (
      sidewalks.some((sidewalk) =>
        others.some(
          (other) =>
            Math.min(sidewalk.end, other.end) -
              Math.max(sidewalk.start, other.start) >
            tolerance,
        ),
      )
    )
      continue;
    let covered = 0;
    for (const span of sidewalks.sort((x, y) => x.start - y.start)) {
      if (span.start - covered > tolerance) break;
      covered = Math.max(covered, span.end);
    }
    if (covered < 1 - tolerance) continue;
    const last = result[result.length - 1];
    if (last?.endIndex === i) last.endIndex = i + 1;
    else result.push({ startIndex: i, endIndex: i + 1 });
  }
  return result;
}

async function loadIndex(file: string): Promise<LoadedIndex | null> {
  try {
    if ((await stat(file)).size > 256 * 1024 * 1024)
      throw new Error("Index exceeds size limit");
    const parsed = OtpSidewalkIndexSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(
      join(dirname(file), "taiwan-otp.osm.pbf"),
    ))
      hash.update(chunk);
    if (hash.digest("hex") !== parsed.sourcePbfSha256)
      throw new Error("Index source differs from the deployed PBF");
    return {
      segments: buildIndex(parsed.segments),
      crossings: buildCrossingIndex(
        parsed.version === 2 ? parsed.crossings : [],
      ),
    };
  } catch (error) {
    console.warn(
      "[otp-sidewalk-index] unavailable; sidewalk coverage remains unknown",
      error instanceof z.ZodError
        ? "invalid index shape"
        : error instanceof Error
          ? error.message.slice(0, 200)
          : "invalid index",
    );
    return null;
  }
}

/**
 * The index is re-read whenever it or its PBF changes on disk, so an OTP
 * release (PBF + graph + index swapped together) takes effect without
 * restarting the backend.
 */
async function currentIndex(): Promise<LoadedIndex | null> {
  const file = process.env.OTP_SIDEWALK_INDEX_PATH;
  if (!file) return null;
  let key = "missing";
  try {
    const [index, pbf] = await Promise.all([
      stat(file),
      stat(join(dirname(file), "taiwan-otp.osm.pbf")),
    ]);
    key = `${index.mtimeMs}:${index.size}:${pbf.mtimeMs}:${pbf.size}`;
  } catch {
    // loadIndex reports the missing file.
  }
  const retry =
    cache?.failedAt !== undefined &&
    Date.now() - cache.failedAt >= INDEX_RETRY_AFTER_FAILURE_MS;
  if (cache?.key !== key || retry) {
    const entry: NonNullable<typeof cache> = { key, index: loadIndex(file) };
    cache = entry;
    void entry.index.then((loaded) => {
      if (loaded === null) entry.failedAt = Date.now();
    });
  }
  return cache.index;
}

/**
 * Government curb-ramp evidence for OTP-planned walk legs. CSR legs keep the
 * counts their own graph produced. When the leg walks across at least one
 * classified crossing, the counts come from that evidence (a crossing counts
 * as ramped only with ramps at both ends, matching the CSR planner); otherwise
 * the OSM-facility counts already on the leg stay.
 */
function applyCrossingEvidence(leg: WalkLeg, crossings: CrossingIndex): void {
  if (crossings.size === 0) return;
  const matched = matchCrossings(leg.polyline, crossings);
  if (matched.length === 0) return;
  leg.crossings = matched.length;
  leg.crossingsWithCurbRamp = matched.filter(
    ([, ramped]) => ramped === 2,
  ).length;
}

export async function annotateSidewalkSegments(
  routes: AccessibleRoute[],
): Promise<void> {
  if (!routes.some((route) => route.legs.some((leg) => leg.type === "WALK")))
    return;
  const index = await currentIndex();
  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type !== "WALK") continue;
      const excluded = (leg.a11ySegments ?? []).filter(
        (s) =>
          s.indoor ||
          [
            "stairs",
            "crossing",
            "curb_ramp_crossing",
            "elevator",
            "escalator",
          ].includes(s.feature),
      );
      leg.sidewalkSegments = index
        ? matchSidewalkSegments(leg.polyline, index.segments, excluded)
        : [];
      if (index && route.engine !== "pedestrian-a11y") {
        applyCrossingEvidence(leg, index.crossings);
      }
    }
  }
}
