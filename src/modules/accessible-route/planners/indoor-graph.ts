/**
 * Indoor Graph Layer (system-agnostic).
 *
 * Upgrades indoor navigation from the TRTC-only `A11y` collection to the GTFS
 * `pathways.txt` graph, which covers EVERY system that ships indoor data in this
 * feed — TRTC, NTMC, KLRT, TMRT, KRTC, TYMC, THSR, TRA — with a single
 * traversal.
 *
 * Data model (two disjoint stop namespaces in this feed):
 *   • Routing nodes — `TRTC_R28`, no parent_station, referenced by stop_times.
 *   • Indoor nodes  — numeric ids, linked by parent_station to a location_type=1
 *                     station node, referenced by pathways (NOT stop_times).
 * The two are bridged by stop_name + proximity (same trick the GTFS router uses
 * for transfer hubs), since they share no ids.
 *
 * Indoor node taxonomy under a station (location_type=1):
 *   0 = platform   2 = entrance/exit   3 = generic node (gate / elevator landing)
 *
 * Pathway modes: 1 walkway · 2 stairs · 3 moving sidewalk · 4 escalator ·
 *   5 elevator · 6 fare gate · 7 exit gate.
 * Wheelchair traversal excludes stairs (2) and prefers elevators (5).
 *
 * All coordinates are [lng, lat] (GeoJSON order); no conversion is performed.
 */

import { GtfsStop } from "../../../model/gtfs-stop.model";
import { GtfsPathway } from "../../../model/gtfs-pathway.model";
import { GtfsLevel } from "../../../model/gtfs-level.model";
import type { IGtfsStop, IGtfsPathway } from "../../../types";
import type { AccessibilityMode } from "../../../types/route";
import { equalStopName } from "../../../utils/transit-text";
import { haversineCoords } from "../../../utils/geo";
import type {
  IndoorStation,
  Edge,
  IndoorPathStep,
  IndoorPath,
  FindIndoorPathOptions,
  StationAccess,
} from "./indoor-graph.types";
export type {
  IndoorStation,
  IndoorPathStep,
  IndoorPath,
  FindIndoorPathOptions,
  StationAccess,
};

const DEFAULT_TRAVERSAL_SEC: Record<number, number> = {
  1: 15,
  2: 20,
  3: 15,
  4: 20,
  5: 30,
  6: 5,
  7: 5,
};

const ESCALATOR_WHEELCHAIR_PENALTY = 120;

const STATION_MATCH_RADIUS_M = 600;

/**
 * Resolve the indoor station node (location_type=1) that corresponds to a
 * routing station, matching by stop_name + proximity. Returns null when this
 * feed carries no indoor data for the station (e.g. most bus stops, TRA halts).
 *
 * @param name The routing station's stop name.
 * @param coords The routing station's [lng, lat] coordinates.
 * @returns The matched indoor station, or null when no indoor data exists.
 */
export async function findIndoorStation(
  name: string,
  coords: [number, number],
): Promise<IndoorStation | null> {
  let candidates = await GtfsStop.find({
    locationType: 1,
    stopName: name,
  }).lean<IGtfsStop[]>();
  if (!candidates.length) {
    const core = name.replace(/[站台臺]+$/u, "").trim();
    if (core) {
      candidates = await GtfsStop.find({
        locationType: 1,
        stopName: { $regex: escapeRegExp(core) },
      }).lean<IGtfsStop[]>();
    }
  }
  if (!candidates.length) return null;

  let best: IGtfsStop | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!equalStopName(c.stopName, name)) continue;
    const cc = c.location?.coordinates as [number, number] | undefined;
    const dist =
      cc && (cc[0] !== 0 || cc[1] !== 0) ? haversineCoords(coords, cc) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (!best) return null;
  if (bestDist > STATION_MATCH_RADIUS_M) return null;

  return {
    stationId: best.stopId,
    stopName: best.stopName,
    coords: best.location.coordinates as [number, number],
  };
}

function edgeCost(p: IGtfsPathway, opts: FindIndoorPathOptions): number | null {
  const exclude = new Set(opts.excludePathwayModes ?? []);
  if (exclude.has(p.pathwayMode)) return null;

  let cost = p.traversalTime ?? DEFAULT_TRAVERSAL_SEC[p.pathwayMode] ?? 15;

  if (opts.mode === "wheelchair" && p.pathwayMode === 4) {
    cost += ESCALATOR_WHEELCHAIR_PENALTY;
  }
  return cost;
}

/**
 * Build the adjacency list for a set of indoor node ids. Bidirectional pathways
 * yield edges in both directions; one-directional escalators/gates only forward.
 *
 * @param nodeIds The set of indoor node ids to include.
 * @param opts Traversal options controlling edge cost and exclusions.
 * @returns The adjacency list keyed by node id.
 */
async function buildAdjacency(
  nodeIds: Set<string>,
  opts: FindIndoorPathOptions,
): Promise<Map<string, Edge[]>> {
  const ids = [...nodeIds];
  const pathways = await GtfsPathway.find({
    $or: [{ fromStopId: { $in: ids } }, { toStopId: { $in: ids } }],
  }).lean<IGtfsPathway[]>();

  const adj = new Map<string, Edge[]>();
  const push = (from: string, e: Edge) => {
    const arr = adj.get(from);
    if (arr) arr.push(e);
    else adj.set(from, [e]);
  };

  for (const p of pathways) {
    if (!nodeIds.has(p.fromStopId) || !nodeIds.has(p.toStopId)) continue;
    const cost = edgeCost(p, opts);
    if (cost === null) continue;
    push(p.fromStopId, { to: p.toStopId, mode: p.pathwayMode, cost });
    if (p.isBidirectional === 1) {
      push(p.toStopId, { to: p.fromStopId, mode: p.pathwayMode, cost });
    }
  }
  return adj;
}

/**
 * Dijkstra over a prebuilt adjacency list. Pure (no I/O), so callers that probe
 * many origin/destination pairs within one station build the graph once and
 * reuse it.
 *
 * @param adj The prebuilt adjacency list.
 * @param fromStopId The start node id.
 * @param toStopId The target node id.
 * @returns The shortest indoor path, or null when `toStopId` is unreachable.
 */
function dijkstraPath(
  adj: Map<string, Edge[]>,
  fromStopId: string,
  toStopId: string,
): IndoorPath | null {
  if (fromStopId === toStopId) {
    return {
      steps: [{ stopId: fromStopId }],
      totalSeconds: 0,
      usesElevator: false,
      usesStairs: false,
    };
  }

  const dist = new Map<string, number>([[fromStopId, 0]]);
  const prev = new Map<string, { from: string; mode: number }>();
  const visited = new Set<string>();

  while (true) {
    let cur: string | null = null;
    let curDist = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < curDist) {
        curDist = d;
        cur = node;
      }
    }
    if (cur === null) break;
    if (cur === toStopId) break;
    visited.add(cur);

    for (const e of adj.get(cur) ?? []) {
      if (visited.has(e.to)) continue;
      const nd = curDist + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: cur, mode: e.mode });
      }
    }
  }

  if (!dist.has(toStopId)) return null;

  const steps: IndoorPathStep[] = [];
  let node: string | undefined = toStopId;
  let usesElevator = false;
  let usesStairs = false;
  while (node) {
    const p = prev.get(node);
    steps.unshift({ stopId: node, viaMode: p?.mode });
    if (p?.mode === 5) usesElevator = true;
    if (p?.mode === 2) usesStairs = true;
    node = p?.from;
  }

  return {
    steps,
    totalSeconds: dist.get(toStopId) ?? 0,
    usesElevator,
    usesStairs,
  };
}

/**
 * Collect every node id belonging to a station (children + the station node).
 *
 * @param stationId The station node id.
 * @returns The set of node ids belonging to the station.
 */
export async function getStationNodeIds(
  stationId: string,
): Promise<Set<string>> {
  const kids = await GtfsStop.find({ parentStation: stationId })
    .select("stopId")
    .lean<{ stopId: string }[]>();
  const set = new Set(kids.map((k) => k.stopId));
  set.add(stationId);
  return set;
}

/**
 * Shortest accessible indoor path between two nodes within a station, via
 * Dijkstra over the pathway graph.
 *
 * @param fromStopId The start node id.
 * @param toStopId The target node id.
 * @param opts Traversal options controlling exclusions and node scope.
 * @returns The shortest permitted path, or null when none exists (e.g. wheelchair user and every route needs stairs).
 */
export async function findIndoorPath(
  fromStopId: string,
  toStopId: string,
  opts: FindIndoorPathOptions = {},
): Promise<IndoorPath | null> {
  if (fromStopId === toStopId) {
    return {
      steps: [{ stopId: fromStopId }],
      totalSeconds: 0,
      usesElevator: false,
      usesStairs: false,
    };
  }

  const nodeIds =
    opts.allowedNodeIds ??
    (await (async () => {
      const set = new Set<string>([fromStopId, toStopId]);
      const ends = await GtfsStop.find({
        stopId: { $in: [fromStopId, toStopId] },
      })
        .select("parentStation")
        .lean<{ parentStation?: string }[]>();
      for (const e of ends) {
        if (e.parentStation) {
          const sub = await getStationNodeIds(e.parentStation);
          sub.forEach((id) => set.add(id));
        }
      }
      return set;
    })());
  nodeIds.add(fromStopId);
  nodeIds.add(toStopId);

  const adj = await buildAdjacency(nodeIds, opts);
  return dijkstraPath(adj, fromStopId, toStopId);
}

/**
 * Entrance nodes (location_type=2) of a station, with usable coordinates.
 *
 * @param stationId The station node id.
 * @returns The station's entrance nodes that have usable coordinates.
 */
export async function getStationEntrances(
  stationId: string,
): Promise<IGtfsStop[]> {
  const docs = await GtfsStop.find({
    parentStation: stationId,
    locationType: 2,
  }).lean<IGtfsStop[]>();
  return docs.filter((d) => {
    const c = d.location?.coordinates;
    return c && (c[0] !== 0 || c[1] !== 0);
  });
}

/**
 * Platform nodes (location_type=0) of a station.
 *
 * @param stationId The station node id.
 * @returns The station's platform nodes.
 */
export async function getStationPlatforms(
  stationId: string,
): Promise<IGtfsStop[]> {
  return GtfsStop.find({ parentStation: stationId, locationType: 0 }).lean<
    IGtfsStop[]
  >();
}

/**
 * Entrance nearest the user, by Haversine distance.
 *
 * @param userCoords The user's [lng, lat] coordinates.
 * @param entrances Candidate entrance nodes.
 * @returns The nearest entrance, or null when none are given.
 */
export function selectNearestEntrance(
  userCoords: [number, number],
  entrances: IGtfsStop[],
): IGtfsStop | null {
  let best: IGtfsStop | null = null;
  let bestDist = Infinity;
  for (const e of entrances) {
    const d = haversineCoords(
      userCoords,
      e.location.coordinates as [number, number],
    );
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/**
 * Derive step-free accessibility from the indoor graph: a station is
 * wheelchair-accessible iff at least one elevator pathway (mode 5) connects its
 * nodes. Cheap existence check; never throws.
 *
 * @param stationId The station node id.
 * @returns True when the station has at least one elevator pathway.
 */
export async function stationHasElevator(stationId: string): Promise<boolean> {
  try {
    const nodeIds = [...(await getStationNodeIds(stationId))];
    if (!nodeIds.length) return false;
    const count = await GtfsPathway.countDocuments({
      fromStopId: { $in: nodeIds },
      pathwayMode: 5,
    });
    return count > 0;
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseExitNumber(name: string): string {
  const m = name.match(/(\d+)/);
  return m ? m[1] : "";
}

/**
 * Resolve indoor access for a station from the routing node's name + coords.
 * Picks the entrance nearest the user, then the shortest mode-appropriate path
 * to any platform. Never throws — any failure degrades to null.
 *
 * @param station The routing station with name and [lng, lat] coords.
 * @param userCoords The user's [lng, lat] coordinates.
 * @param mode The accessibility mode for traversal constraints.
 * @returns The resolved station access, or null when the feed has no indoor graph for the station (caller should fall back to the TRTC A11y collection / station-centroid walk).
 */
export async function getStationAccess(
  station: { name: string; coords: [number, number] },
  userCoords: [number, number],
  mode: AccessibilityMode = "wheelchair",
): Promise<StationAccess | null> {
  try {
    const indoor = await findIndoorStation(station.name, station.coords);
    if (!indoor) return null;

    const [entrances, platforms, hasElevator] = await Promise.all([
      getStationEntrances(indoor.stationId),
      getStationPlatforms(indoor.stationId),
      stationHasElevator(indoor.stationId),
    ]);

    const toEntrance = (e: IGtfsStop) => ({
      stopId: e.stopId,
      name: e.stopName,
      exitNumber: parseExitNumber(e.stopName),
      coords: e.location.coordinates as [number, number],
    });

    const nearest = selectNearestEntrance(userCoords, entrances);
    const base: StationAccess = {
      stationId: indoor.stationId,
      stationName: indoor.stopName,
      entrance: nearest ? toEntrance(nearest) : null,
      hasElevator,
      stepFree: null,
      usesElevator: false,
    };

    if (!nearest || !platforms.length) return base;

    const allowed = await getStationNodeIds(indoor.stationId);
    const adj = await buildAdjacency(allowed, {
      mode,
      excludePathwayModes: mode === "wheelchair" ? [2] : [],
      preferPathwayModes: mode === "wheelchair" ? [5] : [],
    });

    const bestPathFrom = (entranceId: string): IndoorPath | null => {
      let best: IndoorPath | null = null;
      for (const plat of platforms) {
        const path = dijkstraPath(adj, entranceId, plat.stopId);
        if (path && (!best || path.totalSeconds < best.totalSeconds))
          best = path;
      }
      return best;
    };

    const entrancesByDistance = [...entrances].sort(
      (a, b) =>
        haversineCoords(
          userCoords,
          a.location.coordinates as [number, number],
        ) -
        haversineCoords(userCoords, b.location.coordinates as [number, number]),
    );

    let chosen: IGtfsStop | null = null;
    let chosenPath: IndoorPath | null = null;
    for (const e of entrancesByDistance) {
      const path = bestPathFrom(e.stopId);
      if (path) {
        chosen = e;
        chosenPath = path;
        break;
      }
    }

    if (chosen && chosenPath) {
      base.entrance = toEntrance(chosen);
      base.stepFree = true;
      base.usesElevator = chosenPath.usesElevator;

      if (chosenPath.usesElevator) {
        const elevStep = chosenPath.steps.find((s) => s.viaMode === 5);
        if (elevStep) {
          const node = await GtfsStop.findOne({ stopId: elevStep.stopId })
            .select("levelId")
            .lean<{ levelId?: string }>();
          if (node?.levelId) {
            const lvl = await GtfsLevel.findOne({ levelId: node.levelId })
              .select("levelName")
              .lean<{ levelName?: string }>();
            if (lvl?.levelName) base.elevatorLevelName = lvl.levelName;
          }
        }
      }
    } else {
      base.stepFree = false;
    }

    return base;
  } catch (err) {
    console.warn("[indoor-graph] getStationAccess failed:", err);
    return null;
  }
}
