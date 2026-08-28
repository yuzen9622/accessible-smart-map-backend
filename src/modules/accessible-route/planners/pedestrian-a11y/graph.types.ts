/**
 * The values below are the TypeScript expression of the enum source of truth
 * in src/scripts/ped-graph-schema.sql COMMENT ON COLUMN declarations.
 */
export const EDGE_TYPE = {
  UNKNOWN: 0,
  SIDEWALK: 1,
  FOOTWAY: 2,
  CROSSING: 3,
  PATH: 4,
  PEDESTRIAN: 5,
  STEPS: 6,
  LIVING_STREET: 7,
  TRACK: 8,
  ROAD: 9,
  RESIDENTIAL: 10,
  SERVICE: 11,
  UNCLASSIFIED: 12,
  TERTIARY: 13,
  TERTIARY_LINK: 14,
  SECONDARY: 15,
  SECONDARY_LINK: 16,
  PRIMARY: 17,
  PRIMARY_LINK: 18,
  OSM_ELEVATOR: 19,
  INDOOR_WALKWAY: 20,
  INDOOR_STAIRS: 21,
  INDOOR_MOVING_WALKWAY: 22,
  INDOOR_ESCALATOR: 23,
  INDOOR_ELEVATOR: 24,
  INDOOR_FARE_GATE: 25,
  INDOOR_EXIT_GATE: 26,
  OTHER: 255,
} as const;

export const NODE_TYPE = {
  UNKNOWN: 0,
  OSM_WAYPOINT: 1,
  INTERSECTION: 2,
  CROSSING: 3,
  ENTRANCE: 4,
  ELEVATOR: 5,
  STAIRS_END: 6,
  INDOOR_GENERIC: 7,
  INDOOR_STATION: 8,
  INDOOR_PLATFORM: 9,
  INDOOR_BOARDING_AREA: 10,
  INDOOR_ENTRANCE_EXIT: 11,
  INDOOR_OUTDOOR_CONNECTOR: 12,
  OTHER: 255,
} as const;

export const SURFACE = {
  UNKNOWN: 0,
  ASPHALT: 1,
  CONCRETE: 2,
  CONCRETE_LANES: 3,
  CONCRETE_PLATES: 4,
  PAVING_STONES: 5,
  SETT: 6,
  UNHEWN_COBBLESTONE: 7,
  COBBLESTONE: 8,
  BRICKS: 9,
  TILES: 10,
  METAL: 11,
  WOOD: 12,
  RUBBER: 13,
  PLASTIC: 14,
  GRASS_PAVER: 15,
  COMPACTED: 16,
  FINE_GRAVEL: 17,
  GRAVEL: 18,
  PEBBLESTONE: 19,
  ROCK: 20,
  DIRT: 21,
  EARTH: 22,
  GROUND: 23,
  MUD: 24,
  SAND: 25,
  GRASS: 26,
  CLAY: 27,
  UNPAVED: 28,
  PAVED: 29,
  SOIL: 30,
  CHIPPINGS: 31,
  SHELLS: 32,
  ARTIFICIAL_TURF: 33,
  TARTAN: 34,
  ICE: 35,
  SNOW: 36,
  WOODCHIPS: 37,
  MULCH: 38,
  LEAVES: 39,
  OTHER: 255,
} as const;

export const SMOOTHNESS = {
  UNKNOWN: 0,
  EXCELLENT: 1,
  GOOD: 2,
  INTERMEDIATE: 3,
  BAD: 4,
  VERY_BAD: 5,
  HORRIBLE: 6,
  VERY_HORRIBLE: 7,
  IMPASSABLE: 8,
  OTHER: 255,
} as const;

export const WHEELCHAIR = {
  UNKNOWN: 0,
  YES: 1,
  DESIGNATED: 2,
  LIMITED: 3,
  NO: 4,
  OTHER: 255,
} as const;

export const KERB = {
  UNKNOWN: 0,
  FLUSH: 1,
  LOWERED: 2,
  RAISED: 3,
  ROLLED: 4,
  SLOPED: 5,
  YES: 6,
  NO: 7,
  AT_GRADE: 8,
  DROPPED: 9,
  REGULAR: 10,
  NORMAL: 11,
  LOW: 12,
  NONE: 13,
  FLUSH_AND_LOWERED: 14,
  LOWERED_AND_SLOPED: 15,
  OTHER: 255,
} as const;

export const NODE_FLAG = {
  INDOOR: 1,
  ENTRANCE: 2,
  HAS_REAL_GEOM: 4,
} as const;

export const EDGE_FLAG = {
  HAS_RAMP: 1,
  INDOOR: 2,
} as const;

const GTFS_INDOOR_EDGE_SOURCE_REF_PREFIXES = [
  "gtfs_pathways:pathway:",
  "gtfs_pathways:connector-edge:",
] as const;

/**
 * Decide whether a directed edge is eligible for indoor proxy geometry.
 *
 * The GTFS injector emits pathways as
 * `gtfs_pathways:pathway:<pathway-id>:(forward|reverse)` and connectors as
 * `gtfs_pathways:connector-edge:<entrance-id>:<role>`. A NULL geometry is not
 * provenance: outdoor rows (or other GTFS rows) can legitimately lack one and
 * must remain outdoor. These exact prefixes also match promotion's active-graph
 * provenance aggregate.
 *
 * @param sourceRef Stable edge provenance loaded from `ped_edge.source_ref`.
 * @returns Whether the CSR loader should set `EDGE_FLAG.INDOOR`.
 */
export function isGtfsIndoorEdge(sourceRef: string | null): boolean {
  if (sourceRef === null) return false;
  const normalized = sourceRef.trim();
  return GTFS_INDOOR_EDGE_SOURCE_REF_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export interface PedGraph {
  versionId: number;
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;

  nodeLon: Float64Array;
  nodeLat: Float64Array;
  nodeFlags: Uint8Array;
  nodeStationId: Int32Array;
  readonly stationIds: readonly string[];
  stationRadiusM: Float32Array;
  originalNodeId: BigInt64Array;

  adjOffset: Int32Array;
  adjTarget: Int32Array;
  adjAttr: Int32Array;

  /**
   * `ped_edge.edge_id` per dense edge attribute index. Directed rows keep their
   * own identifier, so a selected traversal maps back to exactly one database
   * row even where parallel edges share both endpoints.
   */
  edgeOriginalId: BigInt64Array;
  edgeLengthM: Float32Array;
  edgeType: Uint8Array;
  edgeSlope: Float32Array;
  edgeSurface: Uint8Array;
  edgeSmoothness: Uint8Array;
  edgeWidthM: Float32Array;
  edgeWheelchair: Uint8Array;
  edgeStairCount: Uint16Array;
  edgeTraversalTimeS: Float32Array;
  edgeFlags: Uint8Array;

  /** Interned index into `sidewalkIds`, or -1 when this edge matched no government sidewalk. */
  edgeSidewalkId: Int32Array;
  readonly sidewalkIds: readonly string[];
  /** Ramps recorded on the matched sidewalk segment, 0 when absent or unmatched. */
  edgeSidewalkRampCount: Uint16Array;

  /** Interned index into `streetNames`, or -1 when this edge's way has no recorded name. */
  edgeStreetName: Int32Array;
  readonly streetNames: readonly string[];

  /**
   * Curb ramp point coordinates recorded near this dense edge, WGS84
   * `[lng, lat]`. A missing key means no recorded ramp matched this edge, not
   * that the ground has none: only ~65% of recorded ramp points fall within
   * snapping distance of a sidewalk/footway/crossing edge.
   */
  edgeRampPoints: ReadonlyMap<number, readonly [number, number][]>;
}
