/**
 * Indoor venue facts for the AI `inspectVenue` tool: which floors an elevator
 * serves, where the toilets and ramps are, where a room is, and which
 * facility is cheapest to reach from a known place.
 *
 * Everything is read from the compiled venue. Identity is never inferred from
 * a name or a straight-line distance: buildings and floors must match
 * exactly (after text normalization) or the caller gets the candidates back,
 * and "nearest" is the venue planner's own weighted cost on the graph.
 */
import { z } from "zod";
import {
  VENUE_INSPECT_DEFAULT_RESULTS,
  VENUE_INSPECT_MAX_RESULTS,
  VENUE_INSPECT_NEAR_MAX_WEIGHTED_COST,
  VENUE_LANDMARK_MAX,
  VENUE_LANDMARK_MAX_WEIGHTED_COST,
  type VenueRoutingConfig,
} from "../../config/routing";
import type { AccessibilityMode } from "../../types/route";
import { BinaryMinHeap } from "../accessible-route/planners/pedestrian-a11y/astar";
import {
  edgeCost,
  type CostProfile,
} from "../accessible-route/planners/pedestrian-a11y/cost";
import {
  FORBID_FARE_ACCESS,
  canTraverseFareGate,
} from "../accessible-route/planners/pedestrian-a11y/fare-access";
import type { VenueConnection } from "./venue.connections";
import type { VenueGraph } from "./venue.graph";
import { arrivalIndices, venueProfileFor } from "./venue.route";
import type {
  VenueBuilding,
  VenueData,
  VenuePlace,
  VenueWheelchairTag,
} from "./venue.types";

export const VENUE_FACT_KINDS = [
  "room",
  "toilet",
  "entrance",
  "gate",
  "parking",
  "elevator",
  "stairs",
  "ramp",
  "escalator",
  "other",
] as const;
export type VenueFactKind = (typeof VENUE_FACT_KINDS)[number];

const VENUE_MODES = [
  "wheelchair",
  "elderly",
  "visual_impaired",
  "normal",
] as const;

const optionalText = z.string().trim().min(1).max(100).optional();

export const InspectVenueArgsSchema = z.object({
  venue: optionalText,
  building: optionalText,
  level: z.string().trim().min(1).max(20).optional(),
  room: z.string().trim().min(1).max(40).optional(),
  kinds: z
    .array(z.enum(VENUE_FACT_KINDS))
    .max(VENUE_FACT_KINDS.length)
    .optional(),
  accessibleOnly: z.boolean().optional(),
  nearPlaceId: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(VENUE_MODES).optional(),
  limit: z.number().int().min(1).max(VENUE_INSPECT_MAX_RESULTS).optional(),
});
export type InspectVenueArgs = z.infer<typeof InspectVenueArgsSchema>;

export interface VenueFact {
  kind: VenueFactKind;
  name: string | null;
  ref: string | null;
  buildingId: string | null;
  buildingName: string | null;
  /** A place's floor; an elevator's served floors; a stair/ramp's end floors. */
  levelRefs: string[];
  placeId?: string;
  connectionId?: string;
  wheelchair: VenueWheelchairTag;
  slopeRatio?: number;
  /** False when the slope comes from an estimated height. */
  slopeMeasured?: boolean;
  stepCount?: number;
  heightPending?: boolean;
  note?: string;
  fixme?: string;
  /** Room refs nearest by route on the requested floor; descriptive only. */
  landmarks?: string[];
  /** Walking metres on the chosen path from `nearPlaceId`; elevators add 0. */
  distanceM?: number;
  elevatorRides?: number;
}

export type InspectVenueFailureReason =
  | "VENUE_NOT_FOUND"
  | "BUILDING_NOT_FOUND"
  | "LEVEL_NOT_FOUND"
  | "PLACE_NOT_FOUND";

export type InspectVenueResult =
  | {
      ok: true;
      venueId: string;
      venueName: string;
      venueVersion: number;
      effectiveMode?: AccessibilityMode;
      facts: VenueFact[];
      truncated: boolean;
    }
  | {
      ok: false;
      reason: InspectVenueFailureReason;
      candidates: { id: string; name: string }[];
    };

/** What the inspection reads from a compiled venue. */
export interface VenueInspectSource {
  version: number;
  venue: VenueData;
  graph: VenueGraph;
  connections: VenueConnection[];
}

/** @returns Text folded for exact matching: width, 臺/台, spacing and case. */
export function normalizeVenueText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/臺/g, "台")
    .replace(/\s+/g, "")
    .toLowerCase();
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** @returns 1–99 from Arabic digits or simple Chinese numerals, else null. */
function parseFloorNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const match =
    /^([一二兩三四五六七八九])?(十)?([零〇一二三四五六七八九])?$/.exec(text);
  if (!match || text === "") return null;
  const [, tens, ten, ones] = match;
  if (!ten) return tens && !ones ? CHINESE_DIGITS[tens] : null;
  return (
    (tens ? CHINESE_DIGITS[tens] : 1) * 10 + (ones ? CHINESE_DIGITS[ones] : 0)
  );
}

/**
 * @param input Spoken or typed floor: 4樓, 四樓, 4F, 4, B1, 地下一樓, RF, 頂樓.
 * @returns The compiled level ref (`4F`, `B1`, `RF`), or null when unparseable.
 */
export function normalizeLevelRef(input: string): string | null {
  const text = input.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  if (text === "RF" || text === "R" || text === "頂樓") return "RF";
  const basement = /^(?:B|地下)(.+?)(?:F|樓|層)?$/.exec(text);
  if (basement) {
    const n = parseFloorNumber(basement[1]);
    return n && n >= 1 ? `B${n}` : null;
  }
  const above = /^(.+?)(?:F|樓|層)?$/.exec(text);
  const n = above ? parseFloorNumber(above[1]) : null;
  return n && n >= 1 ? `${n}F` : null;
}

type Candidate = { id: string; name: string };

/**
 * @returns The single item whose id or a normalized name matches exactly, or
 * the candidates when nothing or more than one item matches.
 */
function selectExact<T>(
  items: T[],
  query: string,
  idOf: (item: T) => string,
  namesOf: (item: T) => string[],
  candidateOf: (item: T) => Candidate,
): { ok: true; item: T } | { ok: false; candidates: Candidate[] } {
  const byId = items.filter((item) => idOf(item) === query);
  if (byId.length === 1) return { ok: true, item: byId[0] };
  const wanted = normalizeVenueText(query);
  const byName = items.filter((item) =>
    namesOf(item).some((name) => normalizeVenueText(name) === wanted),
  );
  return byName.length === 1
    ? { ok: true, item: byName[0] }
    : {
        ok: false,
        candidates: (byName.length ? byName : items).map(candidateOf),
      };
}

/**
 * Picks the venue a query names. A venue matches by id, by its own name or by
 * the name of one of its buildings; omitting it is fine only when exactly
 * one venue exists.
 */
export function selectVenue(
  venues: { venueId: string; name: string; buildings: { name: string }[] }[],
  query: string | undefined,
): { ok: true; venueId: string } | { ok: false; candidates: Candidate[] } {
  const candidateOf = (v: { venueId: string; name: string }) => ({
    id: v.venueId,
    name: v.name,
  });
  if (query === undefined)
    return venues.length === 1
      ? { ok: true, venueId: venues[0].venueId }
      : { ok: false, candidates: venues.map(candidateOf) };
  const picked = selectExact(
    venues,
    query,
    (v) => v.venueId,
    (v) => [v.name, ...v.buildings.map((b) => b.name)],
    candidateOf,
  );
  return picked.ok ? { ok: true, venueId: picked.item.venueId } : picked;
}

/** Dense node costs and parents from a bounded multi-source search. */
interface CostField {
  cost: Float64Array;
  parent: Int32Array;
  parentAttr: Int32Array;
}

/**
 * One Dijkstra from every source at once, the same edge rules and costs as
 * the venue planner, stopping once the cheapest open node exceeds the cap.
 */
export function boundedCostsFrom(
  vg: VenueGraph,
  sources: number[],
  profile: CostProfile,
  maxWeightedCost: number,
): CostField {
  const graph = vg.graph;
  const cost = new Float64Array(graph.nodeCount).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(graph.nodeCount).fill(-1);
  const parentAttr = new Int32Array(graph.nodeCount).fill(-1);
  const closed = new Uint8Array(graph.nodeCount);
  const open = new BinaryMinHeap();
  for (const source of sources) {
    cost[source] = 0;
    open.push(source, 0);
  }
  while (open.size > 0) {
    const node = open.pop();
    const key = open.lastKey;
    if (node === -1 || key > maxWeightedCost) break;
    if (key !== cost[node] || closed[node] !== 0) continue;
    closed[node] = 1;
    for (let i = graph.adjOffset[node]; i < graph.adjOffset[node + 1]; i += 1) {
      const attr = graph.adjAttr[i];
      const target = graph.adjTarget[i];
      if (!canTraverseFareGate(graph, node, target, attr, FORBID_FARE_ACCESS))
        continue;
      const step = edgeCost(graph, attr, profile, node, target);
      if (!Number.isFinite(step)) continue;
      const next = cost[node] + step;
      if (!Number.isFinite(next) || next >= cost[target]) continue;
      cost[target] = next;
      parent[target] = node;
      parentAttr[target] = attr;
      closed[target] = 0;
      open.push(target, next);
    }
  }
  return { cost, parent, parentAttr };
}

/** Walking metres (an elevator edge has no length) and elevator rides back to `node`. */
function pathTotals(
  vg: VenueGraph,
  field: CostField,
  node: number,
): { distanceM: number; elevatorRides: number } {
  let distanceM = 0;
  let elevatorRides = 0;
  for (let at = node; field.parent[at] !== -1; at = field.parent[at]) {
    const edge = vg.edgeOfAttr[field.parentAttr[at]];
    if (edge.kind === "elevator") elevatorRides += 1;
    distanceM += edge.lengthM;
  }
  return { distanceM: Math.round(distanceM), elevatorRides };
}

/** @returns The cheapest reachable index among `targets`, or null. */
function cheapest(
  field: CostField,
  targets: number[],
  maxWeightedCost: number,
): number | null {
  let best: number | null = null;
  for (const target of targets)
    if (
      field.cost[target] <= maxWeightedCost &&
      (best === null || field.cost[target] < field.cost[best])
    )
      best = target;
  return best;
}

/**
 * A `poi` whose source-linked display feature is a room is that room: some
 * authored room nodes carry the ref but not `indoor=room` themselves.
 */
function placeKind(
  place: VenuePlace,
  roomFeatureIds: ReadonlySet<string>,
): VenueFactKind | null {
  switch (place.kind) {
    case "room":
    case "entrance":
    case "gate":
    case "parking":
      return place.kind;
    case "amenity":
      return place.amenity === "toilets" ? "toilet" : "other";
    case "poi":
      return place.featureId && roomFeatureIds.has(place.featureId)
        ? "room"
        : "other";
    case "anchor":
      return null;
  }
}

function connectionKind(connection: VenueConnection): VenueFactKind {
  return connection.kind === "steps" ? "stairs" : connection.kind;
}

/** One fact plus what ordering and the near/landmark lookups need. */
interface Row {
  fact: VenueFact;
  /** Dense graph indices the facility is reached at. */
  targets: number[];
  /** Targets on each floor, for landmarks. */
  targetsByLevel: Map<string, number[]>;
  sortOrdinal: number;
}

function ordinalOf(
  building: VenueBuilding | undefined,
  levelRef: string,
): number {
  return (
    building?.levels.find((l) => l.ref === levelRef)?.ordinal ??
    Number.MAX_SAFE_INTEGER
  );
}

function placeRow(
  vg: VenueGraph,
  place: VenuePlace,
  kind: VenueFactKind,
  building: VenueBuilding | undefined,
): Row {
  const targets = arrivalIndices(vg, place) ?? [];
  return {
    fact: {
      kind,
      name: place.name,
      ref: place.ref ?? null,
      buildingId: place.buildingId,
      buildingName: building?.name ?? null,
      levelRefs: place.levelRef ? [place.levelRef] : [],
      placeId: place.id,
      wheelchair: place.wheelchair ?? "unknown",
    },
    targets,
    targetsByLevel: new Map(place.levelRef ? [[place.levelRef, targets]] : []),
    sortOrdinal: place.levelRef ? ordinalOf(building, place.levelRef) : 0,
  };
}

function connectionRow(
  vg: VenueGraph,
  connection: VenueConnection,
  building: VenueBuilding | undefined,
): Row {
  const targetsByLevel = new Map<string, number[]>();
  const targets: number[] = [];
  let complete = true;
  connection.nodeIds.forEach((nodeId, i) => {
    const index = vg.nodeIndex.get(nodeId);
    if (index === undefined) {
      complete = false;
      return;
    }
    targets.push(index);
    const levelRef = connection.levelRefs[i];
    if (levelRef)
      targetsByLevel.set(levelRef, [
        ...(targetsByLevel.get(levelRef) ?? []),
        index,
      ]);
  });
  const levelRefs = [
    ...new Set(connection.levelRefs.filter((l): l is string => l !== null)),
  ].sort((a, b) => ordinalOf(building, a) - ordinalOf(building, b));
  const estimated = connection.heightStatus === "estimated";
  return {
    fact: {
      kind: connectionKind(connection),
      name: connection.name,
      ref: connection.ref,
      buildingId: connection.buildingId,
      buildingName: building?.name ?? null,
      levelRefs,
      connectionId: connection.id,
      wheelchair: connection.wheelchair,
      ...(connection.slopeRatio !== undefined && !estimated
        ? { slopeRatio: connection.slopeRatio }
        : {}),
      ...(connection.slopeRatio !== undefined
        ? { slopeMeasured: !estimated }
        : {}),
      ...(connection.stepCount !== undefined
        ? { stepCount: connection.stepCount }
        : {}),
      ...(connection.heightPending ? { heightPending: true } : {}),
      ...(connection.note ? { note: connection.note } : {}),
      ...(connection.fixme ? { fixme: connection.fixme } : {}),
    },
    targets: complete ? targets : [],
    targetsByLevel: complete ? targetsByLevel : new Map(),
    sortOrdinal: levelRefs.length ? ordinalOf(building, levelRefs[0]) : 0,
  };
}

const LANDMARK_KINDS = new Set<VenueFactKind>([
  "elevator",
  "stairs",
  "ramp",
  "escalator",
  "toilet",
]);

/**
 * Answers one `inspectVenue` query against a compiled venue.
 *
 * @param source The compiled venue (data, graph and presented connections).
 * @param args Validated tool arguments; `args.venue` was already resolved.
 * @param mode Effective mode for `nearPlaceId` costs.
 * @param config Venue routing tunables, for the mode's cost profile.
 */
export function inspectVenue(
  source: VenueInspectSource,
  args: InspectVenueArgs,
  mode: AccessibilityMode,
  config: Pick<VenueRoutingConfig, "stairsAvoidanceMultiplier">,
): InspectVenueResult {
  const { venue, graph: vg } = source;
  const buildings = new Map(venue.buildings.map((b) => [b.id, b]));
  const buildingCandidate = (b: VenueBuilding) => ({ id: b.id, name: b.name });

  let building: VenueBuilding | undefined;
  if (args.building !== undefined) {
    const picked = selectExact(
      venue.buildings,
      args.building,
      (b) => b.id,
      (b) => [b.name, ...b.aliases],
      buildingCandidate,
    );
    if (!picked.ok)
      return {
        ok: false,
        reason: "BUILDING_NOT_FOUND",
        candidates: picked.candidates,
      };
    building = picked.item;
  }

  let levelRef: string | undefined;
  if (args.level !== undefined) {
    const normalized = normalizeLevelRef(args.level);
    const scope = building ? [building] : venue.buildings;
    const known = new Map(
      scope.flatMap((b) => b.levels.map((l) => [l.ref, l.ordinal] as const)),
    );
    if (!normalized || !known.has(normalized)) {
      const levels = [...known].sort((a, b) => a[1] - b[1]);
      return {
        ok: false,
        reason: "LEVEL_NOT_FOUND",
        candidates: levels.map(([ref]) => ({ id: ref, name: ref })),
      };
    }
    levelRef = normalized;
  }

  let near: { place: VenuePlace; field: CostField } | undefined;
  if (args.nearPlaceId !== undefined) {
    const place = venue.places.find((p) => p.id === args.nearPlaceId);
    const sources = place ? arrivalIndices(vg, place) : null;
    if (!place || !sources)
      return { ok: false, reason: "PLACE_NOT_FOUND", candidates: [] };
    near = {
      place,
      field: boundedCostsFrom(
        vg,
        sources,
        venueProfileFor(mode, config),
        VENUE_INSPECT_NEAR_MAX_WEIGHTED_COST,
      ),
    };
  }

  const roomFeatureIds = new Set(
    venue.features.filter((f) => f.kind === "room").map((f) => f.id),
  );
  const kinds = args.kinds?.length ? new Set(args.kinds) : null;
  const room =
    args.room === undefined ? undefined : normalizeVenueText(args.room);
  const rows: Row[] = [];
  for (const place of venue.places) {
    const kind = placeKind(place, roomFeatureIds);
    if (!kind || place.id === near?.place.id) continue;
    if (
      room !== undefined &&
      (place.ref === undefined || normalizeVenueText(place.ref) !== room)
    )
      continue;
    rows.push(
      placeRow(
        vg,
        place,
        kind,
        place.buildingId ? buildings.get(place.buildingId) : undefined,
      ),
    );
  }
  if (room === undefined)
    for (const connection of source.connections)
      rows.push(
        connectionRow(
          vg,
          connection,
          connection.buildingId
            ? buildings.get(connection.buildingId)
            : undefined,
        ),
      );

  const matching = rows.filter(
    ({ fact }) =>
      (!kinds || kinds.has(fact.kind)) &&
      (!building || fact.buildingId === building.id) &&
      (!levelRef || fact.levelRefs.includes(levelRef)) &&
      (!args.accessibleOnly || fact.wheelchair === "yes"),
  );

  let ordered: Row[];
  if (near) {
    const field = near.field;
    const reached = matching.flatMap((row) => {
      const best = cheapest(
        field,
        row.targets,
        VENUE_INSPECT_NEAR_MAX_WEIGHTED_COST,
      );
      return best === null ? [] : [{ row, best, cost: field.cost[best] }];
    });
    reached.sort(
      (a, b) =>
        a.cost - b.cost ||
        a.row.fact.kind.localeCompare(b.row.fact.kind) ||
        factId(a.row.fact).localeCompare(factId(b.row.fact)),
    );
    for (const { row, best } of reached)
      Object.assign(row.fact, pathTotals(vg, field, best));
    ordered = reached.map(({ row }) => row);
  } else {
    ordered = [...matching].sort(
      (a, b) =>
        (a.fact.buildingName ?? "").localeCompare(b.fact.buildingName ?? "") ||
        a.sortOrdinal - b.sortOrdinal ||
        (a.fact.ref ?? "").localeCompare(b.fact.ref ?? "") ||
        factId(a.fact).localeCompare(factId(b.fact)),
    );
  }

  const limit = args.limit ?? VENUE_INSPECT_DEFAULT_RESULTS;
  const shown = ordered.slice(0, limit);
  if (levelRef) addLandmarks(source, shown, levelRef, config);

  return {
    ok: true,
    venueId: venue.venueId,
    venueName: venue.name,
    venueVersion: source.version,
    ...(near ? { effectiveMode: mode } : {}),
    facts: shown.map((row) => row.fact),
    truncated: ordered.length > limit,
  };
}

function factId(fact: VenueFact): string {
  return fact.placeId ?? fact.connectionId ?? "";
}

/** Names up to `VENUE_LANDMARK_MAX` rooms closest by route on `levelRef`. */
function addLandmarks(
  source: VenueInspectSource,
  rows: Row[],
  levelRef: string,
  config: Pick<VenueRoutingConfig, "stairsAvoidanceMultiplier">,
): void {
  const { venue, graph: vg } = source;
  const profile = venueProfileFor("normal", config);
  const roomFeatureIds = new Set(
    venue.features.filter((f) => f.kind === "room").map((f) => f.id),
  );
  for (const row of rows) {
    if (!LANDMARK_KINDS.has(row.fact.kind) || row.fact.buildingId === null)
      continue;
    const starts = row.targetsByLevel.get(levelRef);
    if (!starts?.length) continue;
    const field = boundedCostsFrom(
      vg,
      starts,
      profile,
      VENUE_LANDMARK_MAX_WEIGHTED_COST,
    );
    const rooms = venue.places.flatMap((place) => {
      if (
        placeKind(place, roomFeatureIds) !== "room" ||
        !place.ref ||
        place.buildingId !== row.fact.buildingId ||
        place.levelRef !== levelRef
      )
        return [];
      const targets = arrivalIndices(vg, place);
      const best =
        targets && cheapest(field, targets, VENUE_LANDMARK_MAX_WEIGHTED_COST);
      return best === null || best === undefined
        ? []
        : [{ ref: place.ref, cost: field.cost[best] }];
    });
    rooms.sort((a, b) => a.cost - b.cost || a.ref.localeCompare(b.ref));
    const refs = [...new Set(rooms.map((r) => r.ref))].slice(
      0,
      VENUE_LANDMARK_MAX,
    );
    if (refs.length) row.fact.landmarks = refs;
  }
}
