import proj4 from "proj4";
import type { IParkArea } from "../types";
import { EPSG_3826 } from "./taipei-ramps-parse";
import type { ParkEntranceDoc } from "./taipei-park-entrance-parse";

/**
 * An entrance this close to an OSM outline (inside it, or off its edge) counts
 * as belonging to it. Surveyed entrances sit on the park edge while OSM traces
 * the fence or kerb, so the two disagree by a few metres; 30 m keeps the
 * neighbouring block's park from claiming them.
 */
export const ENTRANCE_TO_OUTLINE_TOLERANCE_M = 30;

/** A hull below this area is a degenerate sliver (collinear entrances), not a park. */
export const MIN_HULL_AREA_M2 = 100;

export type ParkAreaDoc = Omit<IParkArea, "_id" | "importedAt">;

/** One park's preferred area plus, for an OSM outline, the hull to fall back to if storage rejects it. */
export interface BuiltParkArea {
  area: ParkAreaDoc;
  fallback: ParkAreaDoc | null;
}

/** The subset of an Overpass `out geom` element this build reads. */
export interface OverpassParkElement {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
  members?: {
    type?: string;
    role?: string;
    geometry?: { lat: number; lon: number }[];
  }[];
}

type Xy = [number, number];

interface Outline {
  osmId: string;
  ring: [number, number][];
  tm2: Xy[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  areaM2: number;
}

function toTm2([lng, lat]: [number, number]): Xy {
  const [x, y] = proj4("WGS84", EPSG_3826, [lng, lat]);
  return [x, y];
}

function fromTm2([x, y]: Xy): [number, number] {
  const [lng, lat] = proj4(EPSG_3826, "WGS84", [x, y]);
  return [lng, lat];
}

/** Drop consecutive duplicate vertices, which MongoDB rejects in a 2dsphere loop. */
function dedupeRing(ring: [number, number][]): [number, number][] {
  return ring.filter(
    (p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1],
  );
}

function closedRing(
  geometry: { lat: number; lon: number }[] | undefined,
): [number, number][] | null {
  if (!geometry) return null;
  const ring = dedupeRing(geometry.map((g) => [g.lon, g.lat]));
  if (ring.length < 4) return null;
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return first[0] === last[0] && first[1] === last[1] ? ring : null;
}

function ringArea(tm2: Xy[]): number {
  let sum = 0;
  for (let i = 0; i < tm2.length - 1; i += 1) {
    sum += tm2[i][0] * tm2[i + 1][1] - tm2[i + 1][0] * tm2[i][1];
  }
  return Math.abs(sum) / 2;
}

function makeOutline(osmId: string, ring: [number, number][]): Outline {
  const tm2 = ring.map(toTm2);
  const xs = tm2.map((p) => p[0]);
  const ys = tm2.map((p) => p[1]);
  return {
    osmId,
    ring,
    tm2,
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    areaM2: ringArea(tm2),
  };
}

/**
 * Closed park outlines from Overpass elements. Ways must be closed rings; a
 * relation contributes each closed `outer` member separately. Outer rings
 * split across several ways are skipped rather than stitched.
 *
 * @param elements Overpass `out geom` elements for `leisure=park`.
 * @returns Every usable outline.
 */
export function extractOutlines(
  elements: readonly OverpassParkElement[],
): Outline[] {
  const outlines: Outline[] = [];
  for (const element of elements) {
    if (element.type === "way") {
      const ring = closedRing(element.geometry);
      if (ring) outlines.push(makeOutline(`way/${element.id}`, ring));
    } else if (element.type === "relation") {
      for (const member of element.members ?? []) {
        if (member.role !== "outer") continue;
        const ring = closedRing(member.geometry);
        if (ring) outlines.push(makeOutline(`relation/${element.id}`, ring));
      }
    }
  }
  return outlines;
}

function pointInRing([x, y]: Xy, ring: Xy[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment([px, py]: Xy, [ax, ay]: Xy, [bx, by]: Xy): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * @param point TM2 point.
 * @param outline Outline to test against.
 * @returns Whether the point is inside the outline or within the tolerance of its edge.
 */
function nearOutline(point: Xy, outline: Outline): boolean {
  const tol = ENTRANCE_TO_OUTLINE_TOLERANCE_M;
  if (
    point[0] < outline.minX - tol ||
    point[0] > outline.maxX + tol ||
    point[1] < outline.minY - tol ||
    point[1] > outline.maxY + tol
  ) {
    return false;
  }
  if (pointInRing(point, outline.tm2)) return true;
  for (let i = 0; i < outline.tm2.length - 1; i += 1) {
    if (distanceToSegment(point, outline.tm2[i], outline.tm2[i + 1]) <= tol) {
      return true;
    }
  }
  return false;
}

/**
 * Convex hull (Andrew's monotone chain) of TM2 points.
 *
 * @param points TM2 points.
 * @returns The closed hull ring, or null when it encloses less than {@link MIN_HULL_AREA_M2}.
 */
export function convexHull(points: readonly Xy[]): Xy[] | null {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return null;
  const cross = (o: Xy, a: Xy, b: Xy) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Xy[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Xy[] = [];
  for (const p of [...sorted].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) return null;
  const ring = [...hull, hull[0]];
  return ringArea(ring) >= MIN_HULL_AREA_M2 ? ring : null;
}

function hullArea(parkName: string, tm2: Xy[]): ParkAreaDoc | null {
  const hull = convexHull(tm2);
  if (!hull) return null;
  return {
    parkName,
    source: "entrance_hull",
    osmId: null,
    geometry: { type: "Polygon", coordinates: [hull.map(fromTm2)] },
  };
}

/**
 * One area per park that can have one.
 *
 * A park takes the OSM outline that has at least half of its entrances
 * inside or within {@link ENTRANCE_TO_OUTLINE_TOLERANCE_M} of its edge — the
 * outline with the most such entrances, the smaller one on a tie, since a
 * large outline (a whole riverside strip) can also cover a sub-park. A park
 * no outline matches falls back to the convex hull of its entrances, which
 * needs three or more non-collinear entrances. Parks with neither get no area.
 *
 * @param entrances Every accepted park entrance.
 * @param elements Overpass `leisure=park` elements.
 * @returns One area (and its hull fallback) per covered park.
 */
export function buildParkAreas(
  entrances: readonly ParkEntranceDoc[],
  elements: readonly OverpassParkElement[],
): BuiltParkArea[] {
  const outlines = extractOutlines(elements);
  const byPark = new Map<string, Xy[]>();
  for (const entrance of entrances) {
    const points = byPark.get(entrance.parkName) ?? [];
    points.push(toTm2(entrance.location.coordinates));
    byPark.set(entrance.parkName, points);
  }

  const built: BuiltParkArea[] = [];
  for (const [parkName, points] of byPark) {
    const needed = Math.ceil(points.length / 2);
    let best: { outline: Outline; hits: number } | null = null;
    for (const outline of outlines) {
      const hits = points.filter((p) => nearOutline(p, outline)).length;
      if (hits < needed) continue;
      if (
        !best ||
        hits > best.hits ||
        (hits === best.hits && outline.areaM2 < best.outline.areaM2)
      ) {
        best = { outline, hits };
      }
    }
    const hull = hullArea(parkName, points);
    if (best) {
      built.push({
        area: {
          parkName,
          source: "osm",
          osmId: best.outline.osmId,
          geometry: { type: "Polygon", coordinates: [best.outline.ring] },
        },
        fallback: hull,
      });
    } else if (hull) {
      built.push({ area: hull, fallback: null });
    }
  }
  return built;
}
