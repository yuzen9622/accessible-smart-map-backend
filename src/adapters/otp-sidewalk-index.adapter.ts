import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AccessibleRoute, WalkLeg } from "../types/route";
import { haversineCoords } from "../utils/geo";

const CELL = 0.001;
const MAX_OFFSET_M = 1.75;
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
export const OtpSidewalkIndexSchema = z
  .object({
    version: z.literal(1),
    sourcePbfSha256: z.string().regex(/^[a-f0-9]{64}$/),
    segments: z.array(z.unknown()).max(3_000_000),
  })
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
let loaded: Promise<SpatialIndex | null> | undefined;

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
    const sidewalks = spans.filter((s) => s.kind === "sidewalk");
    let ambiguous = false;
    for (const sidewalk of sidewalks) {
      if (
        spans.some(
          (other) =>
            Math.min(sidewalk.end, other.end) -
              Math.max(sidewalk.start, other.start) >
              1e-8 &&
            (other.kind === "other" || other.wayId !== sidewalk.wayId),
        )
      ) {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) continue;
    let covered = 0;
    for (const span of sidewalks.sort((x, y) => x.start - y.start)) {
      if (span.start - covered > 1e-8) break;
      covered = Math.max(covered, span.end);
    }
    if (covered < 1 - 1e-8) continue;
    const last = result[result.length - 1];
    if (last?.endIndex === i) last.endIndex = i + 1;
    else result.push({ startIndex: i, endIndex: i + 1 });
  }
  return result;
}

async function loadIndex(): Promise<SpatialIndex | null> {
  const file = process.env.OTP_SIDEWALK_INDEX_PATH;
  if (!file) return null;
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
    return buildIndex(parsed.segments);
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

export async function annotateSidewalkSegments(
  routes: AccessibleRoute[],
): Promise<void> {
  if (!routes.some((route) => route.legs.some((leg) => leg.type === "WALK")))
    return;
  loaded ??= loadIndex();
  const index = await loaded;
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
        ? matchSidewalkSegments(leg.polyline, index, excluded)
        : [];
    }
  }
}
