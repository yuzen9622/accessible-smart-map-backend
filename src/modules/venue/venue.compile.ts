/**
 * Compiles a JOSM-authored venue (OSM Simple Indoor Tagging + `a11ymap:*`)
 * into the stored venue model: buildings with levels, routable nodes/edges,
 * named places and display features.
 *
 * Topology rules (see .pi/plans/3d-indoor-venue-mvp.md §3.1):
 * - Ways connect only through shared OSM nodes; nothing is snapped.
 * - A graph node is an OSM node on one level: `${osmNodeId}@${ordinal}`. A way
 *   with no `level` tag lies on the ground ordinal 0, so an outdoor footway
 *   and a 1F corridor that share a node are connected.
 * - `highway=steps`, and an inclined way listing several levels, span levels:
 *   both end nodes must carry a single `level`. Every other multi-level way is
 *   repeated once per listed level (`level` ∪ `repeat_on`).
 * - An elevator is a `highway=elevator` node listing every served level; on
 *   each level it must be shared by a routable way of that level.
 * - A place is the node carrying `a11ymap:id`; `a11ymap:anchor=yes` creates
 *   the per-level anchor place `${buildingId}@${levelRef}`.
 *
 * Nothing is auto-connected: missing data surfaces as an error or warning.
 * Pure: no I/O.
 */
import type {
  OsmData,
  OsmNode,
  OsmRelation,
  OsmTags,
  OsmWay,
} from "./venue-osm.parse";
import type {
  GeometryStatus,
  HeightStatus,
  LngLat,
  VenueBuilding,
  VenueData,
  VenueEdge,
  VenueEdgeKind,
  VenueFeature,
  VenueFeatureKind,
  VenueLevel,
  VenueNode,
  VenueNodeKind,
  VenuePlace,
  VenuePlaceKind,
  VenueWheelchairTag,
  VenueFeatureTags,
  VenueWall,
} from "./venue.types";
import { venueConnectionId, venueConnectionKind } from "./venue.connection-id";
import { compileFeatureArrivals } from "./venue.arrivals";

/** Data default when a building does not tag `a11ymap:floor_height`. */
export const DEFAULT_FLOOR_HEIGHT_M = 3.6;

/**
 * Venue, building and place ids; the API's `venueId` path rule is the same.
 * At most 64 characters, so an expanded `${id}@${levelRef}` place id stays
 * well inside the route APIs' 200-character `placeId` limit.
 */
export const VENUE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Steepest numeric `incline` accepted, as a ratio (1000%). */
const MAX_GRADE = 10;
/** Plausible bounds for authored heights, metres. */
const MAX_FLOOR_HEIGHT_M = 20;
const MAX_ABS_HEIGHT_M = 1000;
/** Widest `level` / `repeat_on` range accepted, in floors. */
const MAX_LEVEL_RANGE = 200;
const ID_RE = VENUE_ID_RE;
const LEVEL_REF_RE = /^(B[1-9]\d*|[1-9]\d*F|RF)$/;
const ROUTABLE_HIGHWAYS = new Set([
  "corridor",
  "footway",
  "path",
  "pedestrian",
  "service",
  "living_street",
  "steps",
]);
const FEATURE_INDOOR = new Map<string, VenueFeatureKind>([
  ["room", "room"],
  ["corridor", "corridor"],
  ["area", "area"],
]);
const EARTH_RADIUS_M = 6_371_000;
/** A dead end this close to another way without sharing a node is reported, metres. */
const NEAR_MISS_M = 0.5;
/** ...when the two are at about the same height, metres. */
const NEAR_MISS_DZ_M = 1;

export interface CompileOptions {
  venueId: string;
  name: string;
  /** Publish only these buildings; omitted means the complete source. */
  buildingIds?: readonly string[];
}

export interface CompileResult {
  venue: VenueData;
  errors: string[];
  warnings: string[];
}

/**
 * @param ordinal OSM level ordinal.
 * @returns The display level reference (`1F`, `B1`).
 */
export function levelRefOf(ordinal: number): string {
  return ordinal >= 0 ? `${ordinal + 1}F` : `B${-ordinal}`;
}

/**
 * Parses an OSM `level` / `repeat_on` value: `0`, `-1;0;1`, `0-3`.
 *
 * @param value Raw tag value.
 * @returns Sorted unique ordinals, or null when the value is malformed.
 */
export function parseLevels(value: string | undefined): number[] | null {
  if (value === undefined || value.trim() === "") return [];
  const out = new Set<number>();
  for (const part of value.split(";").map((p) => p.trim())) {
    const range = /^(-?\d+)-(-?\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (
        !Number.isSafeInteger(a) ||
        !Number.isSafeInteger(b) ||
        a > b ||
        b - a > MAX_LEVEL_RANGE
      ) {
        return null;
      }
      for (let l = a; l <= b; l += 1) out.add(l);
    } else if (/^-?\d+$/.test(part) && Number.isSafeInteger(Number(part))) {
      out.add(Number(part));
    } else {
      return null;
    }
    // several ranges together may not exceed one range's limit either
    if (out.size > MAX_LEVEL_RANGE + 1) return null;
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Parses `level` and `repeat_on` together and bounds their union, so two
 * individually valid values cannot add up past the level limit.
 *
 * @param tags Element tags.
 * @returns The element's own levels, its repeats and their sorted union, or
 * null when either value is malformed or the union is too large.
 */
export function levelsOf(
  tags: OsmTags,
): { own: number[]; repeat: number[]; all: number[] } | null {
  const own = parseLevels(tags.level);
  const repeat = parseLevels(tags.repeat_on);
  if (own === null || repeat === null) return null;
  const all = [...new Set([...own, ...repeat])].sort((a, b) => a - b);
  return all.length > MAX_LEVEL_RANGE + 1 ? null : { own, repeat, all };
}

/** Error text for a `level` / `repeat_on` that {@link levelsOf} rejected. */
const badLevels = (what: string) =>
  `${what} 的 level／repeat_on 格式錯誤，或合計超過 ${MAX_LEVEL_RANGE + 1} 層`;

/**
 * Strict numeric tag reader: unlike `Number()`, an empty or blank value is not
 * 0 and only a plain decimal (optionally with an exponent) is accepted.
 *
 * @param value Raw tag value.
 * @returns undefined when the tag is absent, NaN when it is not a number.
 */
export function tagNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v) ? Number(v) : Number.NaN;
}

/** `incline` values that mean "a ramp, grade unknown". */
const DIRECTION_INCLINES = new Set(["up", "down", "yes"]);

/**
 * Classifies an `incline` tag.
 *
 * @param value Raw tag value.
 * @returns `{ inclined, grade? }`, or null when the value is neither absent,
 * `no`, a direction (`up` / `down` / `yes`) nor a finite grade up to 1000%.
 */
export function inclineOf(
  value: string | undefined,
): { inclined: boolean; grade?: number } | null {
  const v = value?.trim();
  if (v === undefined || v === "no") return { inclined: false };
  if (DIRECTION_INCLINES.has(v)) return { inclined: true };
  const grade = parseIncline(v);
  if (grade === undefined || !Number.isFinite(grade) || grade > MAX_GRADE) {
    return null;
  }
  return { inclined: grade > 0, grade };
}

/**
 * @param value Raw `incline` tag.
 * @returns Whether the way is a ramp: a positive grade or a direction-only
 * value; flat, absent and invalid values are not.
 */
export function isInclined(value: string | undefined): boolean {
  return inclineOf(value)?.inclined ?? false;
}

/**
 * Parses an OSM `incline` value into an absolute ratio.
 *
 * @param value Raw tag value (`8%`, `-5%`, `4.5°`, `up`); a bare number is
 * read as a percentage, so `0` is flat.
 * @returns The absolute rise/run ratio, or undefined for a direction-only value.
 */
export function parseIncline(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const pct = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(value);
  if (pct) return Math.abs(Number(pct[1])) / 100;
  const deg = /^\s*(-?\d+(?:\.\d+)?)\s*°\s*$/.exec(value);
  if (deg) return Math.abs(Math.tan((Number(deg[1]) * Math.PI) / 180));
  return undefined;
}

/**
 * @param value Raw `width` tag (`1.5`, `1.5 m`).
 * @returns Width in metres, or undefined when absent or not metric.
 */
function parseWidth(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m)?\s*$/.exec(value);
  return m ? Number(m[1]) : undefined;
}

/**
 * @param a First point.
 * @param b Second point.
 * @returns Great-circle distance in metres.
 */
export function haversineM(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * @param point Test point.
 * @param ring Closed ring.
 * @returns Whether the point lies inside the ring (ray casting).
 */
function inRing(point: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * @param point Test point.
 * @param rings Outer ring followed by holes.
 * @returns Whether the point lies in the polygon.
 */
function inPolygon(point: LngLat, rings: LngLat[][]): boolean {
  if (!inRing(point, rings[0])) return false;
  return !rings.slice(1).some((hole) => inRing(point, hole));
}

/**
 * Joins open member ways end to end into closed rings, as OSM multipolygons
 * often split one outline across several ways.
 *
 * @param ways Member ways of one role.
 * @returns Rings as node-id lists (first id repeated last), or null when a
 * chain cannot be closed.
 */
function stitchRings(ways: OsmWay[]): string[][] | null {
  const pending = ways.map((w) => [...w.nodeIds]);
  const rings: string[][] = [];
  let ring: string[] | undefined = pending.shift();
  while (ring) {
    while (ring[0] !== ring.at(-1)) {
      const end: string | undefined = ring.at(-1);
      const i = pending.findIndex((p) => p[0] === end || p.at(-1) === end);
      if (i < 0) return null;
      const [next] = pending.splice(i, 1);
      const forward: string[] = next[0] === end ? next : next.reverse();
      ring = ring.concat(forward.slice(1));
    }
    if (ring.length < 4) return null;
    rings.push(ring);
    ring = pending.shift();
  }
  return rings;
}

/**
 * @param value Raw `wheelchair` tag.
 * @returns The normalized wheelchair tag.
 */
function wheelchairTag(value: string | undefined): VenueWheelchairTag {
  if (value === "no") return "no";
  if (value === "limited") return "limited";
  if (value === "yes" || value === "designated") return "yes";
  return "unknown";
}

/**
 * @param tags Element tags.
 * @param key Status key.
 * @param fallback Value when untagged.
 * @param allowed Accepted values.
 * @returns The tagged status, or the fallback.
 */
function statusTag<T extends string>(
  tags: OsmTags,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const v = tags[key] as T | undefined;
  return v && allowed.includes(v) ? v : fallback;
}

/** Explicit negative opening tags do not describe a known door or entrance. */
function isAuthoredOpening(value: string | undefined): boolean {
  const tagged = value?.trim();
  return Boolean(tagged && tagged !== "no");
}

function hasAuthoredDoor(tags: OsmTags): boolean {
  return isAuthoredOpening(tags.door) || isAuthoredOpening(tags.entrance);
}

/** @returns `{ source }` from `a11ymap:source`, or nothing. */
function sourceOf(tags: OsmTags): { source?: string } {
  const source = tags["a11ymap:source"]?.trim();
  return source ? { source } : {};
}

/** Public authoring qualifications; do not infer that an estimate is surveyed. */
function authoringOf(tags: OsmTags): {
  heightPending?: boolean;
  note?: string;
  fixme?: string;
} {
  const note = tags.note?.trim();
  const fixme = tags.fixme?.trim();
  return {
    ...(tags["a11ymap:height_pending"] === "yes"
      ? { heightPending: true }
      : {}),
    ...(note ? { note } : {}),
    ...(fixme ? { fixme } : {}),
  };
}

/**
 * @returns How an element was drawn (`a11ymap:geometry_status`, default
 * traced), how its heights are known (`a11ymap:height_status`, default
 * estimated) and where it came from (`a11ymap:source`).
 */
function provenanceOf(tags: OsmTags): {
  geometryStatus: GeometryStatus;
  heightStatus: HeightStatus;
  source?: string;
  heightPending?: boolean;
  note?: string;
  fixme?: string;
} {
  return {
    ...authoringOf(tags),
    geometryStatus: statusTag<GeometryStatus>(
      tags,
      "a11ymap:geometry_status",
      "traced",
      ["surveyed", "traced", "schematic"],
    ),
    heightStatus: statusTag<HeightStatus>(
      tags,
      "a11ymap:height_status",
      "estimated",
      ["measured", "drawing", "estimated"],
    ),
    ...sourceOf(tags),
  };
}

/**
 * @param template Name or ref, optionally containing `{L}`.
 * @param ordinal Level ordinal the instance sits on.
 * @returns The template with `{L}` replaced by the floor number (1F → 1, B1 → B1).
 */
function applyLevelTemplate(template: string, ordinal: number): string {
  const floor = ordinal >= 0 ? String(ordinal + 1) : `B${-ordinal}`;
  return template.split("{L}").join(floor);
}

interface WayInstance {
  way: OsmWay;
  /** Graph node id per OSM node position. */
  nodeKeys: string[];
  /** Ordinal of each position; null for a span-way intermediate vertex. */
  ordinals: (number | null)[];
  indoor: boolean;
  levelSuffix: string;
}

/**
 * Compiles a parsed `.osm` venue.
 *
 * @param osm Parsed OSM data.
 * @param options Venue id and display name.
 * @returns The compiled venue with every validation error and warning.
 */
export function compileVenue(
  osm: OsmData,
  options: CompileOptions,
): CompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const node = (id: string): OsmNode | undefined => osm.nodes.get(id);
  const ll = (n: OsmNode): LngLat => [n.lon, n.lat];
  if (!VENUE_ID_RE.test(options.venueId)) {
    // the API only serves ids matching this rule, so another id is unreachable
    errors.push(
      `場域 id「${options.venueId}」只能用小寫英數、- 與 _，最多 64 字`,
    );
  }

  // ---- buildings -------------------------------------------------------
  const buildings: VenueBuilding[] = [];
  const buildingById = new Map<string, VenueBuilding>();
  const outlineOwner = new Map<string, VenueBuilding>();
  const published = options.buildingIds ? new Set(options.buildingIds) : null;
  if (
    published &&
    (!published.size ||
      published.size !== options.buildingIds?.length ||
      [...published].some((id) => !ID_RE.test(id)))
  ) {
    errors.push("buildingIds 必須是非空、不重複的有效建築 id 清單");
  }
  const excluded: { id: string; rings: LngLat[][] }[] = [];
  const excludedOutline = new Set<string>();
  const outsidePublication = (tags: OsmTags) =>
    Boolean(
      published &&
      tags.building &&
      tags["a11ymap:id"] &&
      !published.has(tags["a11ymap:id"]),
    );
  const excludeBuilding = (
    tags: OsmTags,
    rings: LngLat[][],
    ways: OsmWay[],
  ) => {
    excluded.push({ id: tags["a11ymap:id"], rings });
    for (const way of ways)
      for (const id of way.nodeIds) excludedOutline.add(id);
  };

  const ringOf = (way: OsmWay): LngLat[] | null => {
    const pts = way.nodeIds.map(node);
    if (pts.some((p) => !p)) return null;
    if (way.nodeIds.length < 4 || way.nodeIds[0] !== way.nodeIds.at(-1)) {
      return null;
    }
    return (pts as OsmNode[]).map(ll);
  };

  const addBuilding = (
    osmRef: string,
    tags: OsmTags,
    rings: LngLat[][],
    outlineWays: OsmWay[],
  ) => {
    const id = tags["a11ymap:id"];
    if (!ID_RE.test(id)) {
      errors.push(
        `建築 ${osmRef} 的 a11ymap:id「${id}」只能用小寫英數、- 與 _，最多 64 字`,
      );
      return;
    }
    if (buildingById.has(id)) {
      errors.push(`建築 a11ymap:id「${id}」重複（${osmRef}）`);
      return;
    }
    const above = tagNumber(tags["building:levels"]) ?? Number.NaN;
    if (!Number.isSafeInteger(above) || above < 1) {
      errors.push(`建築「${tags.name ?? id}」缺少有效的 building:levels`);
      return;
    }
    const below = tagNumber(tags["building:levels:underground"]) ?? 0;
    if (!Number.isSafeInteger(below) || below < 0) {
      errors.push(
        `建築「${tags.name ?? id}」的 building:levels:underground 無效`,
      );
      return;
    }
    if (above + below > MAX_LEVEL_RANGE) {
      errors.push(
        `建築「${tags.name ?? id}」總樓層數超過 ${MAX_LEVEL_RANGE} 層，請確認 building:levels`,
      );
      return;
    }
    const floorHeightM =
      tagNumber(tags["a11ymap:floor_height"]) ?? DEFAULT_FLOOR_HEIGHT_M;
    const groundOffsetM = tagNumber(tags["a11ymap:ground_offset"]) ?? 0;
    if (
      !(
        Number.isFinite(floorHeightM) &&
        floorHeightM > 0 &&
        floorHeightM <= MAX_FLOOR_HEIGHT_M
      ) ||
      !(
        Number.isFinite(groundOffsetM) &&
        Math.abs(groundOffsetM) <= MAX_ABS_HEIGHT_M
      )
    ) {
      errors.push(`建築「${tags.name ?? id}」的樓高或地面高差無效`);
      return;
    }
    const levels: VenueLevel[] = [];
    for (let o = -below; o < above; o += 1) {
      levels.push({
        ordinal: o,
        ref: levelRefOf(o),
        elevationM: groundOffsetM + o * floorHeightM,
      });
    }
    const building: VenueBuilding = {
      id,
      name: tags.name ?? id,
      aliases: [tags.alt_name, tags.old_name]
        .filter((v): v is string => !!v)
        .flatMap((v) => v.split(";").map((s) => s.trim()))
        .filter(Boolean),
      footprint: rings,
      levels,
      floorHeightM,
      groundOffsetM,
      // the default floor height is a guess, whatever status is tagged
      heightStatus:
        tags["a11ymap:floor_height"] === undefined
          ? "estimated"
          : statusTag<HeightStatus>(
              tags,
              "a11ymap:height_status",
              "estimated",
              ["measured", "drawing", "estimated"],
            ),
      geometryStatus: statusTag<GeometryStatus>(
        tags,
        "a11ymap:geometry_status",
        "traced",
        ["surveyed", "traced", "schematic"],
      ),
      ...sourceOf(tags),
      ...authoringOf(tags),
      osmRef,
      ...(tags["ref:moe"] ? { moeRef: tags["ref:moe"] } : {}),
    };
    buildings.push(building);
    buildingById.set(id, building);
    for (const w of outlineWays) {
      for (const nid of w.nodeIds) outlineOwner.set(nid, building);
    }
  };

  const unnamed: string[] = [];
  /** A building outside navigation is fine, but it must not vanish silently. */
  const accepts = (osmRef: string, tags: OsmTags) => {
    if (!tags.building || outsidePublication(tags)) return false;
    if (!tags["a11ymap:id"]) {
      unnamed.push(tags.name ? `${osmRef}（${tags.name}）` : osmRef);
      return false;
    }
    if (!tags.name) {
      errors.push(`建築 ${osmRef}（${tags["a11ymap:id"]}）缺少 name`);
      return false;
    }
    return true;
  };

  /** Outer ring then holes of a multipolygon, or null when it cannot close. */
  const relationRings = (rel: OsmRelation) => {
    const outerWays: OsmWay[] = [];
    const innerWays: OsmWay[] = [];
    for (const m of rel.members) {
      if (m.type !== "way") continue;
      const w = osm.ways.get(m.ref);
      if (!w) return null;
      (m.role === "inner" ? innerWays : outerWays).push(w);
    }
    const outer = stitchRings(outerWays);
    const inner = stitchRings(innerWays);
    if (!outer || !inner || outer.length !== 1) return null;
    const rings: LngLat[][] = [];
    for (const ring of [...outer, ...inner]) {
      const pts = ring.map((nid) => node(nid));
      if (pts.some((p) => !p)) return null;
      rings.push((pts as OsmNode[]).map(ll));
    }
    return { rings, members: [...outerWays, ...innerWays] };
  };
  /** Buildings left out of navigation: nothing indoor may be drawn in them. */
  const untagged: { label: string; rings: LngLat[][] }[] = [];
  const isUntagged = (tags: OsmTags) =>
    Boolean(tags.building) && !tags["a11ymap:id"];

  for (const way of osm.ways.values()) {
    if (outsidePublication(way.tags)) {
      const ring = ringOf(way);
      if (ring) excludeBuilding(way.tags, [ring], [way]);
      else errors.push(`無法安全排除建築 way/${way.id}：外框未閉合或缺節點`);
      continue;
    }
    if (!accepts(`way/${way.id}`, way.tags)) {
      const ring = isUntagged(way.tags) ? ringOf(way) : null;
      if (ring) {
        untagged.push({
          label: way.tags.name ?? `way/${way.id}`,
          rings: [ring],
        });
      }
      continue;
    }
    const ring = ringOf(way);
    if (!ring) {
      errors.push(`建築 way ${way.id} 不是封閉外框`);
      continue;
    }
    addBuilding(`way/${way.id}`, way.tags, [ring], [way]);
  }
  for (const rel of osm.relations.values()) {
    if (outsidePublication(rel.tags)) {
      const parsed = relationRings(rel);
      if (parsed) excludeBuilding(rel.tags, parsed.rings, parsed.members);
      else errors.push(`無法安全排除建築 relation/${rel.id}：外框成員不完整`);
      continue;
    }
    if (!accepts(`relation/${rel.id}`, rel.tags)) {
      const parsed = isUntagged(rel.tags) ? relationRings(rel) : null;
      if (parsed) {
        untagged.push({
          label: rel.tags.name ?? `relation/${rel.id}`,
          rings: parsed.rings,
        });
      }
      continue;
    }
    const parsed = relationRings(rel);
    if (!parsed) {
      errors.push(
        `建築 relation ${rel.id} 需要恰好一圈封閉的 outer 外框（成員缺漏或接不起來）`,
      );
      continue;
    }
    addBuilding(`relation/${rel.id}`, rel.tags, parsed.rings, parsed.members);
  }
  if (unnamed.length) {
    warnings.push(
      `${unnamed.length} 棟建築沒標 a11ymap:id，不會納入導航：${unnamed.join("、")}`,
    );
  }

  const buildingAt = (osmNodeId: string): VenueBuilding | null => {
    const owner = outlineOwner.get(osmNodeId);
    if (owner) return owner;
    const n = node(osmNodeId);
    if (!n) return null;
    return buildings.find((b) => inPolygon(ll(n), b.footprint)) ?? null;
  };
  const levelOf = (b: VenueBuilding, ordinal: number) =>
    b.levels.find((l) => l.ordinal === ordinal);
  /**
   * @returns The untagged building a point lies in (and no navigable building
   * covers), or null.
   */
  const untaggedAt = (point: LngLat) =>
    buildings.some((b) => inPolygon(point, b.footprint))
      ? null
      : (untagged.find((u) => inPolygon(point, u.rings)) ?? null);
  const indoorInUntagged = (what: string, point: LngLat) => {
    const u = untaggedAt(point);
    if (u) {
      errors.push(
        `${what} 畫在沒標 a11ymap:id 的建築「${u.label}」裡；要導航請替這棟加 a11ymap:id、name 與 building:levels`,
      );
    }
    return u !== null;
  };
  /** Every vertex and segment midpoint, so a way cannot cut through. */
  const wayInUntagged = (what: string, way: OsmWay) => {
    const pts = way.nodeIds
      .map(node)
      .filter((n): n is OsmNode => !!n)
      .map(ll);
    const probes = [
      ...pts,
      ...pts
        .slice(1)
        .map((p, i): LngLat => [
          (p[0] + pts[i][0]) / 2,
          (p[1] + pts[i][1]) / 2,
        ]),
    ];
    const hit = probes.find((p) => untaggedAt(p));
    return hit ? indoorInUntagged(what, hit) : false;
  };

  // Explicit publication exclusions differ from untagged authoring mistakes:
  // skip their contents before validation, without turning them into outdoors.
  const excludedAt = (point: LngLat) =>
    buildings.some((b) => inPolygon(point, b.footprint))
      ? false
      : excluded.some((b) => inPolygon(point, b.rings));
  const excludedNode = (id: string) => {
    if (buildingAt(id)) return false; // included/shared entrances take priority
    const n = node(id);
    return excludedOutline.has(id) || (n ? excludedAt(ll(n)) : false);
  };
  /** Probe every polygon-boundary interval, including off-centre crossings. */
  const segmentInExcluded = (a: LngLat, b: LngLat) => {
    const ts = [0, 1];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const rings = [
      ...excluded.flatMap((x) => x.rings),
      ...buildings.flatMap((x) => x.footprint),
    ];
    for (const ring of rings)
      for (let i = 1; i < ring.length; i += 1) {
        const c = ring[i - 1],
          d = ring[i];
        const ex = d[0] - c[0],
          ey = d[1] - c[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-20) continue;
        const cx = c[0] - a[0],
          cy = c[1] - a[1];
        const t = (cx * ey - cy * ex) / den;
        const u = (cx * dy - cy * dx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
      }
    ts.sort((x, y) => x - y);
    return ts.slice(1).some((t, i) => {
      const mid = (t + ts[i]) / 2;
      return excludedAt([a[0] + dx * mid, a[1] + dy * mid]);
    });
  };
  const wayInExcluded = (way: OsmWay) => {
    if (!excluded.length) return false;
    if (way.nodeIds.some(excludedNode)) return true;
    return way.nodeIds.slice(1).some((id, i) => {
      const a = node(way.nodeIds[i]),
        b = node(id);
      return a && b ? segmentInExcluded(ll(a), ll(b)) : false;
    });
  };
  if (published) {
    for (const id of published)
      if (!buildingById.has(id)) {
        errors.push(`發布建築「${id}」不存在或無有效外框／樓層資料`);
      }
    if (excluded.length)
      warnings.push(
        `發布範圍排除建築：${excluded.map((b) => b.id).join("、")}`,
      );
  }
  // Unsupported relations outside the publication must not block selected data.
  // Only skip when every member is known to belong to an excluded building.
  const relationInExcluded = (
    rel: OsmRelation,
    seen = new Set<string>(),
  ): boolean => {
    if (!rel.members.length || seen.has(rel.id)) return false;
    const next = new Set([...seen, rel.id]);
    return rel.members.every((member) => {
      if (member.type === "node") return excludedNode(member.ref);
      if (member.type === "way") {
        const way = osm.ways.get(member.ref);
        return Boolean(way?.nodeIds.length && way.nodeIds.every(excludedNode));
      }
      const nested = osm.relations.get(member.ref);
      return nested ? relationInExcluded(nested, next) : false;
    });
  };
  for (const el of [...osm.ways.values(), ...osm.relations.values()]) {
    const rawId = el.tags["a11ymap:id"];
    if (
      !rawId ||
      el.tags.building ||
      ("nodeIds" in el ? wayInExcluded(el) : relationInExcluded(el))
    )
      continue;
    const kind = "nodeIds" in el ? "way" : "relation";
    errors.push(
      `a11ymap:id「${rawId}」標在 ${kind} ${el.id} 上；地點要標在路網節點上（通常是主要門）`,
    );
  }

  // ---- routable way instances -------------------------------------------
  const instances: WayInstance[] = [];
  /** ordinals each OSM node is used on by routable ways */
  const usedOn = new Map<string, Set<number>>();
  /** ramps whose width is unknown: wheelchairs are routed over them anyway */
  const rampsWithoutWidth: string[] = [];
  /** ordinals on which a single-level corridor passes each OSM node */
  const corridorOn = new Map<string, Set<number>>();
  /** span-way vertices without their own level → the way that owns them */
  const spanPrivate = new Map<string, string>();
  const markUsed = (nid: string, ordinal: number) => {
    let s = usedOn.get(nid);
    if (!s) usedOn.set(nid, (s = new Set()));
    s.add(ordinal);
  };

  for (const way of osm.ways.values()) {
    const hw = way.tags.highway;
    if (
      !hw ||
      !ROUTABLE_HIGHWAYS.has(hw) ||
      way.tags.area === "yes" ||
      wayInExcluded(way)
    )
      continue;
    if (way.nodeIds.some((nid) => !node(nid))) {
      errors.push(`way ${way.id} 參照了不存在的節點`);
      continue;
    }
    const lv = levelsOf(way.tags);
    if (!lv) {
      errors.push(badLevels(`way ${way.id}`));
      continue;
    }
    const { own: levelList, repeat } = lv;
    const indoorish =
      hw === "corridor" || "indoor" in way.tags || way.tags.level !== undefined;
    if (indoorish && wayInUntagged(`way ${way.id}`, way)) continue;
    const indoorTagged = hw === "corridor" || "indoor" in way.tags;
    // an unreadable or overflowing grade would read as "unknown slope" and let
    // wheelchairs on; the bound also keeps it finite in the graph's Float32s
    const incline = inclineOf(way.tags.incline);
    if (!incline) {
      errors.push(
        `way ${way.id} 的 incline「${way.tags.incline}」不是有效的坡度（用 8%、4°、up、down 或 no）`,
      );
      continue;
    }
    const inclined = incline.inclined;
    if (hw === "steps") {
      const count = way.tags.step_count;
      if (count === undefined) {
        warnings.push(`樓梯 way ${way.id} 沒標 step_count，指示不會說明階數`);
      } else if (!(
        Number.isSafeInteger(tagNumber(count)) && (tagNumber(count) ?? 0) > 0
      )) {
        errors.push(`樓梯 way ${way.id} 的 step_count「${count}」要是正整數`);
        continue;
      }
      if (way.tags["ramp:wheelchair"] === "yes") {
        warnings.push(
          `樓梯 way ${way.id} 標了 ramp:wheelchair=yes，但輪椅不會走樓梯；旁邊的坡道請另畫一條 footway`,
        );
      }
    } else if (inclined && !way.tags["ramp:wheelchair"]) {
      warnings.push(
        `坡道 way ${way.id} 沒標 ramp:wheelchair；是無障礙坡道請標 yes，不是請標 no`,
      );
    }
    if (
      hw !== "steps" &&
      inclined &&
      parseWidth(way.tags.width) === undefined
    ) {
      rampsWithoutWidth.push(way.id);
    }

    const first = way.nodeIds[0];
    const last = way.nodeIds.at(-1) as string;
    const lf = parseLevels(node(first)?.tags.level);
    const ll2 = parseLevels(node(last)?.tags.level);
    const singleEnds = lf?.length === 1 && ll2?.length === 1;
    const span =
      (hw === "steps" || inclined) &&
      (levelList.length > 1 || (singleEnds && lf[0] !== ll2[0]));

    if (span) {
      if (!lf || lf.length !== 1 || !ll2 || ll2.length !== 1) {
        errors.push(`跨樓層的 way ${way.id}（${hw}）兩端節點都要標單一 level`);
        continue;
      }
      if (
        lf[0] === ll2[0] ||
        (levelList.length > 0 &&
          !(levelList.includes(lf[0]) && levelList.includes(ll2[0])))
      ) {
        errors.push(
          `跨樓層的 way ${way.id}（${hw}）的 level 與兩端節點的 level 不一致`,
        );
        continue;
      }
      if (repeat.length) {
        errors.push(`跨樓層的 way ${way.id} 不能用 repeat_on，請每層各畫一條`);
        continue;
      }
      // a vertex with its own single level (a landing) is a shared node of
      // that level; any other vertex belongs to this way alone
      const ordinals: (number | null)[] = way.nodeIds.map((nid, i) => {
        if (i === 0) return lf[0];
        if (i === way.nodeIds.length - 1) return ll2[0];
        const own = parseLevels(node(nid)?.tags.level);
        return own?.length === 1 ? own[0] : null;
      });
      const nodeKeys = way.nodeIds.map((nid, i) =>
        ordinals[i] === null ? `${nid}@w${way.id}` : `${nid}@${ordinals[i]}`,
      );
      way.nodeIds.forEach((nid, i) => {
        const o = ordinals[i];
        if (o === null) spanPrivate.set(nid, way.id);
        else markUsed(nid, o);
      });
      instances.push({
        way,
        nodeKeys,
        ordinals,
        indoor: indoorTagged || way.nodeIds.some((n) => buildingAt(n) !== null),
        levelSuffix: "span",
      });
      continue;
    }

    const ordinals = [
      ...new Set([...(levelList.length ? levelList : [0]), ...repeat]),
    ];
    const singleLevelCorridor = hw === "corridor" && levelList.length <= 1;
    for (const o of ordinals) {
      const nodeKeys = way.nodeIds.map((nid) => `${nid}@${o}`);
      way.nodeIds.forEach((nid) => {
        markUsed(nid, o);
        if (!singleLevelCorridor) return;
        let set = corridorOn.get(nid);
        if (!set) corridorOn.set(nid, (set = new Set()));
        set.add(o);
      });
      const mid = node(
        way.nodeIds[Math.floor(way.nodeIds.length / 2)],
      ) as OsmNode;
      const inside = buildings.some((b) => inPolygon(ll(mid), b.footprint));
      instances.push({
        way,
        nodeKeys,
        ordinals: way.nodeIds.map(() => o),
        indoor: indoorTagged || (way.tags.level !== undefined && inside),
        levelSuffix: String(o),
      });
    }
  }

  if (rampsWithoutWidth.length) {
    warnings.push(
      `${rampsWithoutWidth.length} 條坡道沒標 width，輪椅以可通過計算，請量測後補上：${rampsWithoutWidth.map((id) => `way ${id}`).join("、")}`,
    );
  }

  for (const [nid, wayId] of spanPrivate) {
    const sharedBy = instances.filter(
      (inst) => inst.way.id !== wayId && inst.way.nodeIds.includes(nid),
    );
    if (sharedBy.length) {
      errors.push(
        `跨樓層的 way ${wayId} 的中間節點 ${nid} 與其他路線共用，請在這個節點標單一 level`,
      );
    }
  }

  // ---- nodes -------------------------------------------------------------
  const validEle = (value: string | undefined) =>
    value !== undefined &&
    Number.isFinite(tagNumber(value)) &&
    Math.abs(tagNumber(value) ?? 0) <= MAX_ABS_HEIGHT_M;
  for (const n of osm.nodes.values()) {
    if (excludedNode(n.id)) continue;
    const ele = n.tags["a11ymap:ele"];
    if (ele !== undefined && !validEle(ele)) {
      errors.push(`node ${n.id} 的 a11ymap:ele「${ele}」不是有效高度`);
    }
  }
  const nodes = new Map<string, VenueNode>();
  const nodeKindOf = (tags: OsmTags): VenueNodeKind => {
    if (tags.highway === "elevator") return "elevator";
    if (tags.barrier === "gate") return "gate";
    if (isAuthoredOpening(tags.entrance)) return "entrance";
    if (isAuthoredOpening(tags.door)) return "door";
    if (tags["a11ymap:id"] || tags["a11ymap:anchor"] === "yes") return "place";
    return "path";
  };
  const zOf = (
    osmId: string,
    ordinal: number | null,
    b: VenueBuilding | null,
  ) => {
    const ele = node(osmId)?.tags["a11ymap:ele"];
    if (validEle(ele)) return tagNumber(ele) as number;
    if (ordinal === null) return Number.NaN; // interpolated along its way
    if (b) {
      const level = levelOf(b, ordinal);
      return level
        ? level.elevationM
        : b.groundOffsetM + ordinal * b.floorHeightM;
    }
    return ordinal * DEFAULT_FLOOR_HEIGHT_M;
  };
  const ensureNode = (
    key: string,
    osmId: string,
    ordinal: number | null,
    indoor: boolean,
  ) => {
    const existing = nodes.get(key);
    if (existing) {
      existing.indoor = existing.indoor || indoor;
      return existing;
    }
    const n = node(osmId) as OsmNode;
    const b = buildingAt(osmId);
    if (b && ordinal !== null && !levelOf(b, ordinal)) {
      errors.push(
        `節點 ${osmId} 在「${b.name}」的 level ${ordinal}（${levelRefOf(ordinal)}），但該棟沒有這一層`,
      );
    }
    const kerb = n.tags.kerb;
    const created: VenueNode = {
      id: key,
      lng: n.lon,
      lat: n.lat,
      z: zOf(osmId, ordinal, b),
      buildingId: b?.id ?? null,
      ordinal,
      indoor,
      kind: nodeKindOf(n.tags),
      kerbRamp: kerb === "lowered" || kerb === "flush" || kerb === "no",
    };
    nodes.set(key, created);
    return created;
  };

  for (const inst of instances) {
    inst.way.nodeIds.forEach((nid, i) =>
      ensureNode(inst.nodeKeys[i], nid, inst.ordinals[i], inst.indoor),
    );
  }

  // interpolate z of span-way vertices and of ramp / bridge vertices, indoor
  // or outdoor, piecewise between the vertices whose height is known: the two
  // ends, `a11ymap:ele`, a landing with its own level, or a junction with
  // another way (which keeps the height that way gives it)
  const instancesUsing = new Map<string, number>();
  for (const inst of instances) {
    for (const key of new Set(inst.nodeKeys)) {
      instancesUsing.set(key, (instancesUsing.get(key) ?? 0) + 1);
    }
  }
  for (const inst of instances) {
    const t = inst.way.tags;
    const isSpan = inst.levelSuffix === "span";
    const interpolate = isSpan || isInclined(t.incline) || t.bridge === "yes";
    if (!interpolate || inst.nodeKeys.length < 3) continue;
    const pts = inst.nodeKeys.map((k) => nodes.get(k) as VenueNode);
    const cum = [0];
    for (let i = 1; i < pts.length; i += 1) {
      cum.push(
        cum[i - 1] +
          haversineM(
            [pts[i - 1].lng, pts[i - 1].lat],
            [pts[i].lng, pts[i].lat],
          ),
      );
    }
    const known = pts.map(
      (p, i) =>
        i === 0 ||
        i === pts.length - 1 ||
        validEle(node(inst.way.nodeIds[i])?.tags["a11ymap:ele"]) ||
        (isSpan
          ? p.ordinal !== null
          : (instancesUsing.get(inst.nodeKeys[i]) ?? 0) > 1),
    );
    let prev = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      if (known[i]) {
        prev = i;
        continue;
      }
      let next = i + 1;
      while (!known[next]) next += 1;
      const run = cum[next] - cum[prev];
      const f = run > 0 ? (cum[i] - cum[prev]) / run : 0;
      pts[i].z = pts[prev].z + (pts[next].z - pts[prev].z) * f;
    }
  }

  // ---- edges -------------------------------------------------------------
  const edges: VenueEdge[] = [];
  const kindOf = (w: OsmWay, indoor: boolean): VenueEdgeKind => {
    const hw = w.tags.highway;
    if (w.tags.conveying) return "escalator";
    if (hw === "steps") return "steps";
    if (w.tags.footway === "crossing" || w.tags.highway === "crossing")
      return "crossing";
    if (hw === "corridor" || indoor) return "corridor";
    if (hw === "path") return "path";
    if (hw === "pedestrian") return "pedestrian";
    if (hw === "service" || hw === "living_street") return "service";
    return "footway";
  };
  for (const inst of instances) {
    const w = inst.way;
    const incline = parseIncline(w.tags.incline);
    const inclined = isInclined(w.tags.incline);
    const width = parseWidth(w.tags.width);
    const wc = wheelchairTag(w.tags.wheelchair);
    const kind = kindOf(w, inst.indoor);
    const stepCount = tagNumber(w.tags.step_count) ?? Number.NaN;
    for (let i = 1; i < inst.nodeKeys.length; i += 1) {
      const a = nodes.get(inst.nodeKeys[i - 1]) as VenueNode;
      const b = nodes.get(inst.nodeKeys[i]) as VenueNode;
      const lengthM = haversineM([a.lng, a.lat], [b.lng, b.lat]);
      let slopeRatio: number | undefined;
      let slopeStatus: HeightStatus | undefined;
      if (incline !== undefined) {
        slopeRatio = incline;
        // a grade nobody vouched for is an estimate (plan §0.3)
        slopeStatus = statusTag<HeightStatus>(
          w.tags,
          "a11ymap:height_status",
          "estimated",
          ["measured", "drawing", "estimated"],
        );
      } else if (
        kind !== "steps" &&
        Number.isFinite(a.z) &&
        Number.isFinite(b.z) &&
        lengthM > 0.5 &&
        Math.abs(b.z - a.z) > 0.01
      ) {
        slopeRatio = Math.abs(b.z - a.z) / lengthM;
        slopeStatus = "estimated";
      }
      edges.push({
        id: `${w.id}:${i - 1}@${inst.levelSuffix}`,
        ...(w.tags.name ? { name: w.tags.name } : {}),
        ...(w.tags.ref ? { ref: w.tags.ref } : {}),
        from: a.id,
        to: b.id,
        kind,
        indoor: inst.indoor,
        lengthM,
        ...(slopeRatio !== undefined ? { slopeRatio, slopeStatus } : {}),
        ...(width !== undefined ? { widthM: width } : {}),
        ...(kind === "steps" && Number.isInteger(stepCount)
          ? { stepCount }
          : {}),
        wheelchair:
          kind === "escalator" ||
          (inclined && w.tags["ramp:wheelchair"] === "no")
            ? "no"
            : wc,
        ...(w.tags.surface ? { surface: w.tags.surface } : {}),
        ...(w.tags.smoothness ? { smoothness: w.tags.smoothness } : {}),
        ramp: inclined,
        ...provenanceOf(w.tags),
        osmRef: `way/${w.id}`,
      });
    }
  }

  // a barrier node (e.g. a door with a step) closes every edge touching it,
  // and a door's clear width narrows every edge through it
  for (const e of edges) {
    for (const key of [e.from, e.to]) {
      const tags = node(key.split("@")[0])?.tags;
      if (tags?.wheelchair === "no") e.wheelchair = "no";
      const doorWidth =
        tags && hasAuthoredDoor(tags) ? parseWidth(tags.width) : undefined;
      if (doorWidth !== undefined) {
        e.widthM = Math.min(e.widthM ?? Number.POSITIVE_INFINITY, doorWidth);
      }
    }
  }

  // ---- elevators ---------------------------------------------------------
  for (const n of osm.nodes.values()) {
    if (n.tags.highway !== "elevator" || excludedNode(n.id)) continue;
    const lv = levelsOf(n.tags);
    if (!lv) {
      errors.push(badLevels(`電梯節點 ${n.id}`));
      continue;
    }
    const served = lv.all;
    const b = buildingAt(n.id);
    const label = n.tags.name ?? n.tags["a11ymap:id"] ?? `node/${n.id}`;
    if (served.length < 2) {
      errors.push(`電梯「${label}」至少要列出兩個停靠樓層（level=0;1;2…）`);
      continue;
    }
    if (!b) {
      errors.push(`電梯「${label}」不在任何已標 a11ymap:id 的建築內`);
      continue;
    }
    const keys: { ordinal: number; key: string }[] = [];
    for (const o of served) {
      const key = `${n.id}@${o}`;
      const landing = nodes.get(key);
      if (!corridorOn.get(n.id)?.has(o) || !landing) {
        errors.push(
          `電梯「${label}」宣告停靠 ${levelRefOf(o)}，但該層沒有走廊（highway=corridor、單一 level）經過這個電梯節點`,
        );
        continue;
      }
      landing.kind = "elevator";
      keys.push({ ordinal: o, key });
    }
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        edges.push({
          id: `elevator/${n.id}:${keys[i].ordinal}-${keys[j].ordinal}`,
          ...(n.tags.name ? { name: n.tags.name } : {}),
          ...(n.tags.ref ? { ref: n.tags.ref } : {}),
          from: keys[i].key,
          to: keys[j].key,
          kind: "elevator",
          indoor: true,
          lengthM: 0,
          levelSpan: Math.abs(keys[j].ordinal - keys[i].ordinal),
          // an untagged elevator is assumed usable; `limited` and `no` stay
          wheelchair:
            wheelchairTag(n.tags.wheelchair) === "unknown"
              ? "yes"
              : wheelchairTag(n.tags.wheelchair),
          ramp: false,
          // a ride's heights are the building's floor heights
          ...provenanceOf(n.tags),
          heightStatus: b.heightStatus,
          osmRef: `node/${n.id}`,
        });
      }
    }
  }

  // ---- places ------------------------------------------------------------
  const places: VenuePlace[] = [];
  const placeIds = new Set<string>();
  const placeKindOf = (tags: OsmTags): VenuePlaceKind => {
    if (tags.barrier === "gate") return "gate";
    if (isAuthoredOpening(tags.entrance)) return "entrance";
    if (tags.indoor === "room") return "room";
    if (tags.amenity === "parking") return "parking";
    if (tags.amenity) return "amenity";
    return "poi";
  };
  const addPlace = (p: VenuePlace, osmId: string) => {
    if (placeIds.has(p.id)) {
      errors.push(`地點 id「${p.id}」重複（node ${osmId}）`);
      return;
    }
    placeIds.add(p.id);
    places.push(p);
  };
  for (const n of osm.nodes.values()) {
    if (excludedNode(n.id)) continue;
    const rawId = n.tags["a11ymap:id"];
    const anchor = n.tags["a11ymap:anchor"] === "yes";
    if (!rawId && !anchor) continue;
    if (n.tags.building) continue;
    if (rawId && !ID_RE.test(rawId)) {
      errors.push(
        `node ${n.id} 的 a11ymap:id「${rawId}」只能用小寫英數、- 與 _，最多 64 字（@ 為保留字）`,
      );
      continue;
    }
    const lv = levelsOf(n.tags);
    if (!lv) {
      errors.push(badLevels(`node ${n.id}`));
      continue;
    }
    const used = [...(usedOn.get(n.id) ?? [])];
    const ordinals = lv.all;
    const indoorPlace =
      anchor ||
      n.tags.indoor !== undefined ||
      (n.tags.level !== undefined &&
        !isAuthoredOpening(n.tags.entrance) &&
        n.tags.barrier !== "gate");
    if (indoorPlace && indoorInUntagged(`地點 node ${n.id}`, ll(n))) continue;
    const levelsForPlace = ordinals.length
      ? ordinals
      : used.length === 1
        ? used
        : [];
    const label = n.tags.name ?? rawId ?? `node/${n.id}`;
    if (
      rawId &&
      n.tags.barrier === "gate" &&
      n.tags.entrance !== "main" &&
      n.tags.entrance !== "yes"
    ) {
      // an outdoor route may end at any gate, so only a real entrance qualifies
      errors.push(
        `校門「${label}」要標 entrance=main 或 entrance=yes；不是出入口的閘門請拿掉 a11ymap:id`,
      );
      continue;
    }
    if (!levelsForPlace.length) {
      errors.push(`地點「${label}」沒有接到任何路網（或接到多層卻沒標 level）`);
      continue;
    }
    const b = buildingAt(n.id);
    if (anchor && !b) {
      errors.push(`樓層錨點 node ${n.id} 不在任何建築內`);
      continue;
    }
    for (const o of levelsForPlace) {
      const key = `${n.id}@${o}`;
      if (!nodes.has(key)) {
        errors.push(`地點「${label}」在 ${levelRefOf(o)} 沒有接到路網`);
        continue;
      }
      const levelRef = b ? levelRefOf(o) : null;
      if (levelRef !== null && !LEVEL_REF_RE.test(levelRef)) {
        errors.push(`地點「${label}」的樓層 ${levelRef} 不符合命名規則`);
        continue;
      }
      if (anchor && b) {
        addPlace(
          {
            id: `${b.id}@${levelRef}`,
            name: `${b.name} ${levelRef}`,
            kind: "anchor",
            buildingId: b.id,
            levelRef,
            nodeId: key,
            location: ll(n),
          },
          n.id,
        );
      }
      if (rawId) {
        const multi = levelsForPlace.length > 1;
        addPlace(
          {
            id: multi ? `${rawId}@${levelRef ?? levelRefOf(o)}` : rawId,
            name: applyLevelTemplate(n.tags.name ?? n.tags.ref ?? rawId, o),
            ...(n.tags.ref ? { ref: applyLevelTemplate(n.tags.ref, o) } : {}),
            kind: placeKindOf(n.tags),
            ...(placeKindOf(n.tags) === "amenity"
              ? { amenity: n.tags.amenity }
              : {}),
            buildingId: b?.id ?? null,
            levelRef,
            nodeId: key,
            location: ll(n),
            ...(placeKindOf(n.tags) === "gate" ||
            (n.tags.amenity === "toilets" && n.tags.wheelchair)
              ? { wheelchair: wheelchairTag(n.tags.wheelchair) }
              : {}),
            ...(placeKindOf(n.tags) === "parking" &&
            Number.isSafeInteger(tagNumber(n.tags["capacity:disabled"])) &&
            (tagNumber(n.tags["capacity:disabled"]) ?? -1) >= 0
              ? { accessibleSpaces: tagNumber(n.tags["capacity:disabled"]) }
              : {}),
          },
          n.id,
        );
      }
    }
  }

  // ---- display features ----------------------------------------------------
  const features: VenueFeature[] = [];
  const featureNodes = new Map<string, Set<string>>();
  const featureKindOf = (tags: OsmTags): VenueFeatureKind | undefined =>
    FEATURE_INDOOR.get(tags.indoor ?? "") ??
    (tags.highway === "elevator" ? "elevator" : undefined) ??
    (tags.highway === "steps" && tags.area === "yes" ? "stairs" : undefined);
  const featureTagsOf = (
    tags: OsmTags,
    ordinal: number,
  ): { tags?: VenueFeatureTags } => {
    const retained: VenueFeatureTags = {
      ...(tags.indoor ? { indoor: tags.indoor } : {}),
      ...(tags.amenity ? { amenity: tags.amenity } : {}),
      ...(tags["a11ymap:area_type"]
        ? { "a11ymap:area_type": tags["a11ymap:area_type"] }
        : {}),
      ...(tags.ref ? { ref: applyLevelTemplate(tags.ref, ordinal) } : {}),
      ...(tags.amenity === "toilets" && tags.wheelchair
        ? { wheelchair: wheelchairTag(tags.wheelchair) }
        : {}),
    };
    return Object.keys(retained).length ? { tags: retained } : {};
  };
  const addPolygonFeatures = (
    osmRef: string,
    tags: OsmTags,
    kind: VenueFeatureKind,
    rings: LngLat[][],
    sourceNodeIds: string[],
  ) => {
    const label = osmRef.replace("/", " ");
    const lv = levelsOf(tags);
    if (!lv) {
      errors.push(badLevels(`外框 ${label}`));
      return;
    }
    const ring = rings[0];
    const centroid: LngLat = [
      ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
      ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
    ];
    // outer ring only: a ring corridor's centroid sits in the courtyard hole
    const b =
      buildings.find((bb) => inPolygon(centroid, [bb.footprint[0]])) ?? null;
    for (const o of lv.all.length ? lv.all : [0]) {
      if (b && !levelOf(b, o)) {
        errors.push(
          `外框 ${label} 在「${b.name}」的 ${levelRefOf(o)}，但該棟沒有這一層`,
        );
        continue;
      }
      const id = `${osmRef}@${o}`;
      features.push({
        id,
        osmRef,
        ...featureTagsOf(tags, o),
        kind,
        buildingId: b?.id ?? null,
        levelRef: b ? levelRefOf(o) : null,
        ordinal: o,
        ...(tags.name ? { name: applyLevelTemplate(tags.name, o) } : {}),
        ...(tags.ref ? { ref: applyLevelTemplate(tags.ref, o) } : {}),
        geometry: { type: "Polygon", coordinates: rings },
        ...provenanceOf(tags),
      });
      featureNodes.set(id, new Set(sourceNodeIds));
    }
  };
  for (const way of osm.ways.values()) {
    const featureKind = featureKindOf(way.tags);
    if (!featureKind || wayInExcluded(way)) continue;
    const ring = ringOf(way);
    if (!ring) {
      errors.push(
        `外框 way ${way.id}（${featureKind}）沒有閉合，請在 JOSM 把頭尾接起來`,
      );
      continue;
    }
    if (wayInUntagged(`外框 way ${way.id}`, way)) continue;
    addPolygonFeatures(
      `way/${way.id}`,
      way.tags,
      featureKind,
      [ring],
      way.nodeIds,
    );
  }
  for (const rel of osm.relations.values()) {
    const featureKind = featureKindOf(rel.tags);
    if (!featureKind || relationInExcluded(rel)) continue;
    const parsed = relationRings(rel);
    if (!parsed) {
      errors.push(
        `外框 relation ${rel.id} 需要一圈封閉 outer 與完整 inner 成員`,
      );
      continue;
    }
    if (parsed.members.some(wayInExcluded)) continue;
    if (
      parsed.members.some((way) =>
        wayInUntagged(`外框 relation ${rel.id}`, way),
      )
    )
      continue;
    addPolygonFeatures(
      `relation/${rel.id}`,
      rel.tags,
      featureKind,
      parsed.rings,
      parsed.members.flatMap((way) => way.nodeIds),
    );
  }
  for (const n of osm.nodes.values()) {
    if (!hasAuthoredDoor(n.tags) || excludedNode(n.id)) continue;
    const lv = levelsOf(n.tags);
    if (!lv) {
      errors.push(badLevels(`門 node ${n.id}`));
      continue;
    }
    const used = [...(usedOn.get(n.id) ?? [])];
    const ordinals = lv.all;
    const b = buildingAt(n.id);
    for (const o of ordinals.length ? ordinals : used.length ? used : [0]) {
      if (b && !levelOf(b, o)) {
        errors.push(
          `門 node ${n.id} 在「${b.name}」的 ${levelRefOf(o)}，但該棟沒有這一層`,
        );
        continue;
      }
      const id = `node/${n.id}@${o}`;
      features.push({
        id,
        osmRef: `node/${n.id}`,
        ...featureTagsOf(n.tags, o),
        kind: "door",
        buildingId: b?.id ?? null,
        levelRef: b ? levelRefOf(o) : null,
        ordinal: o,
        ...(n.tags.name ? { name: n.tags.name } : {}),
        ...(n.tags.ref ? { ref: applyLevelTemplate(n.tags.ref, o) } : {}),
        geometry: { type: "Point", coordinates: ll(n) },
        ...provenanceOf(n.tags),
      });
      featureNodes.set(id, new Set([n.id]));
    }
  }

  // Explicit walls remain open source lines; a display thickness is not a
  // surveyed wall dimension. Apply the same publication/level checks as areas.
  const walls: VenueWall[] = [];
  for (const way of osm.ways.values()) {
    if (way.tags.indoor !== "wall" || wayInExcluded(way)) continue;
    const pts = way.nodeIds.map(node);
    if (pts.length < 2 || pts.some((p) => !p)) {
      errors.push(`牆線 way ${way.id} 需要至少兩個存在的節點`);
      continue;
    }
    if (wayInUntagged(`牆線 way ${way.id}`, way)) continue;
    const lv = levelsOf(way.tags);
    if (!lv) {
      errors.push(badLevels(`牆線 way ${way.id}`));
      continue;
    }
    const coordinates = (pts as OsmNode[]).map(ll);
    const owners = new Set(
      way.nodeIds.map(buildingAt).filter((b): b is VenueBuilding => b !== null),
    );
    const b = owners.size === 1 ? [...owners][0] : null;
    for (const o of lv.all.length ? lv.all : [0]) {
      if (b && !levelOf(b, o)) {
        errors.push(
          `牆線 way ${way.id} 在「${b.name}」的 ${levelRefOf(o)}，但該棟沒有這一層`,
        );
        continue;
      }
      walls.push({
        id: `way/${way.id}@${o}`,
        osmRef: `way/${way.id}`,
        buildingId: b?.id ?? null,
        ordinal: o,
        levelRef: b ? levelRefOf(o) : null,
        geometry: { type: "LineString", coordinates },
        thicknessM: null,
        ...provenanceOf(way.tags),
      });
    }
  }

  // Source identities and containment provide display associations only; no
  // graph node, elevator stop or connection is added by an area polygon.
  const connectionEdges = new Map<string, VenueEdge[]>();
  for (const edge of edges) {
    const id = venueConnectionId(edge);
    if (!id) continue;
    const list = connectionEdges.get(id) ?? [];
    list.push(edge);
    connectionEdges.set(id, list);
  }
  const shaftFeatures = features.filter(
    (f) =>
      f.geometry.type === "Polygon" &&
      (f.kind === "elevator" ||
        f.tags?.["a11ymap:area_type"] === "elevator-shaft"),
  );
  const stairFeatures = features.filter(
    (f) =>
      f.geometry.type === "Polygon" &&
      (f.kind === "stairs" || f.tags?.["a11ymap:area_type"] === "stairwell"),
  );
  const contains = (f: VenueFeature, point: LngLat) =>
    f.geometry.type === "Polygon" && inPolygon(point, f.geometry.coordinates);
  const uniqueContainer = (
    f: VenueFeature,
    point: LngLat,
    candidates: VenueFeature[],
  ) =>
    candidates.filter(
      (other) =>
        other.buildingId === f.buildingId &&
        other.ordinal === f.ordinal &&
        contains(other, point),
    ).length === 1;
  const featureConnections = new Map<string, Set<string>>();
  const associate = (f: VenueFeature, id: string) => {
    const ids = featureConnections.get(f.id) ?? new Set<string>();
    ids.add(id);
    featureConnections.set(f.id, ids);
  };
  for (const f of shaftFeatures) {
    if (!f.buildingId) continue;
    const candidates = [...connectionEdges].filter(([, group]) => {
      const edge = group[0];
      if (edge.kind !== "elevator") return false;
      const original = node(edge.osmRef.slice("node/".length));
      return (
        original &&
        buildingAt(original.id)?.id === f.buildingId &&
        contains(f, ll(original))
      );
    });
    if (candidates.length !== 1) continue;
    const [id, group] = candidates[0];
    const original = node(group[0].osmRef.slice("node/".length)) as OsmNode;
    if (uniqueContainer(f, ll(original), shaftFeatures)) associate(f, id);
  }
  for (const inst of instances) {
    if (inst.levelSuffix !== "span") continue;
    const edge = edges.find((e) => e.id === `${inst.way.id}:0@span`);
    if (
      !edge ||
      !["stairs", "steps", "escalator"].includes(
        venueConnectionKind(edge) ?? "",
      )
    )
      continue;
    const id = venueConnectionId(edge) as string;
    for (const i of [0, inst.nodeKeys.length - 1]) {
      const endpoint = nodes.get(inst.nodeKeys[i]) as VenueNode;
      for (const f of stairFeatures) {
        const point: LngLat = [endpoint.lng, endpoint.lat];
        if (
          f.buildingId &&
          f.buildingId === endpoint.buildingId &&
          f.ordinal === endpoint.ordinal &&
          contains(f, point) &&
          uniqueContainer(f, point, stairFeatures)
        )
          associate(f, id);
      }
    }
  }
  const incidentConnections = (key: string) =>
    [...connectionEdges]
      .filter(([, group]) => group.some((e) => e.from === key || e.to === key))
      .map(([id]) => id);
  const references = (ids: Iterable<string>) => {
    const connectionIds = [...new Set(ids)].sort();
    return {
      connectionId: connectionIds.length === 1 ? connectionIds[0] : null,
      connectionIds,
    };
  };
  for (const f of features) {
    const ids = featureConnections.get(f.id) ?? new Set<string>();
    if (f.kind === "door" && f.osmRef?.startsWith("node/")) {
      for (const id of incidentConnections(`${f.osmRef.slice(5)}@${f.ordinal}`))
        ids.add(id);
    }
    Object.assign(f, references(ids));
  }
  for (const place of places) {
    const navigationNode = nodes.get(place.nodeId) as VenueNode;
    const sourceId = place.nodeId.split("@")[0];
    const tags = node(sourceId)?.tags ?? {};
    const door = hasAuthoredDoor(tags);
    const corridor = edges.some(
      (e) =>
        e.kind === "corridor" &&
        (e.from === place.nodeId || e.to === place.nodeId),
    );
    const sameContext = features.filter(
      (f) =>
        f.buildingId === place.buildingId &&
        f.ordinal === navigationNode.ordinal,
    );
    const polygons = sameContext.filter(
      (f) =>
        f.geometry.type === "Polygon" &&
        (place.kind === "room" ? f.kind === "room" : f.kind !== "corridor"),
    );
    const sharedDoor = door
      ? polygons.filter((f) => featureNodes.get(f.id)?.has(sourceId))
      : [];
    const refMatches =
      place.buildingId && place.ref
        ? polygons.filter((f) => f.ref === place.ref)
        : [];
    const direct = sameContext.filter((f) => f.osmRef === `node/${sourceId}`);
    const match = sharedDoor.length
      ? sharedDoor.length === 1
        ? sharedDoor[0]
        : null
      : refMatches.length
        ? refMatches.length === 1
          ? refMatches[0]
          : null
        : door && direct.length === 1
          ? direct[0]
          : null;
    place.featureId = match?.id ?? null;
    place.arrivalKind = door ? "door" : corridor ? "corridor" : "place";
    place.doorKnown = door ? true : corridor ? false : null;
    Object.assign(place, references(incidentConnections(place.nodeId)));
  }

  compileFeatureArrivals(
    osm,
    nodes,
    edges,
    features,
    places,
    errors,
    contains,
    hasAuthoredDoor,
  );

  // ---- connectivity report -------------------------------------------------
  warnings.push(
    ...connectivityWarnings(nodes, edges, places, buildings),
    ...nearMissWarnings(nodes, edges),
    ...missingAnchorWarnings(buildings, places),
  );

  const allPts = buildings.flatMap((b) => b.footprint[0]);
  const center: LngLat = allPts.length
    ? [
        allPts.reduce((s, p) => s + p[0], 0) / allPts.length,
        allPts.reduce((s, p) => s + p[1], 0) / allPts.length,
      ]
    : [0, 0];
  if (!buildings.length) errors.push("找不到任何標了 a11ymap:id 的建築");

  return {
    venue: {
      venueId: options.venueId,
      name: options.name,
      center,
      buildings,
      places,
      nodes: [...nodes.values()],
      edges,
      features,
      walls,
    },
    errors,
    warnings,
  };
}

/**
 * Hard limits mirrored from the wheelchair cost model: steps, escalators,
 * explicit `wheelchair=no`, slopes over 12% and widths under 0.9 m.
 *
 * @param e Venue edge.
 * @returns Whether a wheelchair could traverse it at the strict level.
 */
function wheelchairPassable(e: VenueEdge): boolean {
  if (e.kind === "steps" || e.kind === "escalator" || e.wheelchair === "no") {
    return false;
  }
  if (e.slopeRatio !== undefined && e.slopeRatio > 0.12) return false;
  if (e.widthM !== undefined && e.widthM < 0.9) return false;
  return true;
}

/**
 * Reports building levels and places that no gate reaches, with and without
 * stairs. Warnings, not errors: an authoring-in-progress venue is expected
 * to be partly disconnected.
 */
function connectivityWarnings(
  nodes: Map<string, VenueNode>,
  edges: VenueEdge[],
  places: VenuePlace[],
  buildings: VenueBuilding[],
): string[] {
  const gates = places.filter((p) => p.kind === "gate");
  if (!gates.length)
    return ["沒有任何校門（barrier=gate + a11ymap:id），無法檢查可達性"];
  const reach = (passable: (e: VenueEdge) => boolean) => {
    const adj = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = adj.get(a);
      if (list) list.push(b);
      else adj.set(a, [b]);
    };
    for (const e of edges) {
      if (!passable(e)) continue;
      link(e.from, e.to);
      link(e.to, e.from);
    }
    const seen = new Set(gates.map((g) => g.nodeId));
    const queue = [...seen];
    while (queue.length) {
      const cur = queue.pop() as string;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return seen;
  };
  const any = reach(() => true);
  const stepFree = reach(wheelchairPassable);
  const out: string[] = [];
  const nameOf = new Map(buildings.map((b) => [b.id, b.name]));
  for (const p of places) {
    if (p.kind === "gate") continue;
    const label =
      p.buildingId && p.kind !== "anchor"
        ? `${nameOf.get(p.buildingId)} ${p.levelRef ?? ""}「${p.name}」`
        : `「${p.name}」`;
    if (!any.has(p.nodeId))
      out.push(`${label}：從任何校門都走不到（路網斷開）`);
    else if (!stepFree.has(p.nodeId))
      out.push(`${label}：輪椅無法抵達（只有樓梯或障礙）`);
  }
  if (!nodes.size) out.push("路網是空的");
  return out;
}

/**
 * Connectivity comes only from shared nodes, so a dead end drawn right next
 * to another way at the same height is most likely a missed join.
 *
 * @returns One warning per dead-end node and nearby way, with its levels.
 */
function nearMissWarnings(
  nodes: Map<string, VenueNode>,
  edges: VenueEdge[],
): string[] {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = neighbours.get(a);
    if (set) set.add(b);
    else neighbours.set(a, new Set([b]));
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const flat = edges.filter((e) => e.kind !== "elevator");
  const rad = Math.PI / 180;
  const found = new Map<string, string[]>();
  for (const [key, near] of neighbours) {
    const n = nodes.get(key);
    if (near.size !== 1 || !n || !Number.isFinite(n.z)) continue;
    const touching = new Set([key, ...near]);
    const kx = Math.cos(n.lat * rad) * EARTH_RADIUS_M * rad;
    const ky = EARTH_RADIUS_M * rad;
    for (const e of flat) {
      if (touching.has(e.from) || touching.has(e.to)) continue;
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const ax = (a.lng - n.lng) * kx;
      const ay = (a.lat - n.lat) * ky;
      const dx = (b.lng - n.lng) * kx - ax;
      const dy = (b.lat - n.lat) * ky - ay;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
      if (Math.hypot(ax + t * dx, ay + t * dy) >= NEAR_MISS_M) continue;
      if (!(Math.abs(a.z + (b.z - a.z) * t - n.z) < NEAR_MISS_DZ_M)) continue;
      const label = `node ${key.split("@")[0]}|${e.osmRef}`;
      const level =
        n.buildingId && n.ordinal !== null ? levelRefOf(n.ordinal) : "戶外";
      const levels = found.get(label);
      if (levels) levels.push(level);
      else found.set(label, [level]);
      break;
    }
  }
  return [...found].map(([label, levels]) => {
    const [nodeRef, wayRef] = label.split("|");
    return `${nodeRef}（${[...new Set(levels)].join("、")}）離 ${wayRef} 不到 ${NEAR_MISS_M} 公尺卻沒共用節點，可能沒接上`;
  });
}

/**
 * @returns One warning per building listing the levels without an anchor;
 * "building + floor" cannot be chosen there, while places with their own
 * `a11ymap:id` on that floor stay routable.
 */
function missingAnchorWarnings(
  buildings: VenueBuilding[],
  places: VenuePlace[],
): string[] {
  const anchors = new Set(
    places.filter((p) => p.kind === "anchor").map((p) => p.id),
  );
  return buildings.flatMap((b) => {
    const missing = b.levels
      .map((l) => l.ref)
      .filter((ref) => !anchors.has(`${b.id}@${ref}`));
    return missing.length
      ? [
          `「${b.name}」缺樓層錨點（a11ymap:anchor=yes）：${missing.join("、")}；這些樓層無法用「建築＋樓層」選為起訖（該層的教室等地點仍可）`,
        ]
      : [];
  });
}
