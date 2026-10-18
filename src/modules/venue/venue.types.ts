/**
 * Domain types for an indoor/outdoor venue (a campus, a station, a mall).
 *
 * A venue is authored in JOSM as OpenStreetMap Simple Indoor Tagging plus a
 * few `a11ymap:*` keys, compiled once by `import-venue-osm`, and stored as one
 * Mongo document. Levels use the OSM ordinal (`0` = ground floor = 1F,
 * `-1` = B1); `levelRef` is the display name derived from it.
 */

export type LngLat = [number, number];
export type LngLatZ = [number, number, number];

/** How a height or slope value was obtained; only `measured` is surveyed. */
export type HeightStatus = "measured" | "drawing" | "estimated";
/** How a geometry was obtained. */
export type GeometryStatus = "surveyed" | "traced" | "schematic";

export interface VenueLevel {
  /** OSM level ordinal: 0 = 1F, -1 = B1. */
  ordinal: number;
  /** Display name: `1F`, `B1`. */
  ref: string;
  /** Floor surface height above the venue datum, metres. */
  elevationM: number;
}

/** Source annotations retained without treating estimates as site confirmation. */
export interface VenueProvenance {
  geometryStatus: GeometryStatus;
  heightStatus: HeightStatus;
  /** `a11ymap:source`: photo file name or scan id. */
  source?: string;
  /** Height still awaits verification; does not confirm elevator stop floors. */
  heightPending?: boolean;
  /** Author's note, including any qualification of connectivity or stop floors. */
  note?: string;
  /** Outstanding authoring or site-verification work. */
  fixme?: string;
}

export interface VenueLevelCoverage {
  /** A real selectable floor anchor exists. */
  hasAnchor: boolean;
  /** At least one graph edge is incident to a node on this building/floor. */
  hasRouteData: boolean;
  /** A display feature is explicitly associated with this building/floor. */
  hasDisplayGeometry: boolean;
}

export interface VenueBuilding extends VenueProvenance {
  id: string;
  name: string;
  aliases: string[];
  /** Outer ring first, then holes; each ring closed, `[lng, lat]`. */
  footprint: LngLat[][];
  levels: VenueLevel[];
  floorHeightM: number;
  groundOffsetM: number;
  osmRef: string;
  moeRef?: string;
}

export type VenuePlaceKind =
  "room" | "amenity" | "parking" | "entrance" | "gate" | "anchor" | "poi";

export interface VenuePlace {
  id: string;
  name: string;
  ref?: string;
  kind: VenuePlaceKind;
  buildingId: string | null;
  levelRef: string | null;
  /** Graph node this place routes from / to. */
  nodeId: string;
  /** Source-backed alternatives on the same building/floor; unique, includes nodeId, at most 16. */
  arrivalNodeIds?: string[];
  location: LngLat;
  /** Source-verified display feature at this arrival point, if unambiguous. */
  featureId?: string | null;
  arrivalKind?: "door" | "corridor" | "place" | null;
  /** Whether this navigation point is an explicitly authored door. */
  doorKnown?: boolean | null;
  connectionId?: string | null;
  connectionIds?: string[];
  /** Gates only: the gate's own `wheelchair` tag. */
  wheelchair?: VenueWheelchairTag;
  /** Parking only: accessible spaces (`capacity:disabled`). */
  accessibleSpaces?: number;
}

export type VenueNodeKind =
  "path" | "door" | "entrance" | "gate" | "elevator" | "place";

export interface VenueNode {
  id: string;
  lng: number;
  lat: number;
  /** Floor height of this node, metres above the venue datum. */
  z: number;
  buildingId: string | null;
  /** OSM level ordinal; null for an intermediate vertex of a multi-level way. */
  ordinal: number | null;
  indoor: boolean;
  kind: VenueNodeKind;
  /** An observed lowered/flush kerb at a crossing end. */
  kerbRamp: boolean;
}

export type VenueEdgeKind =
  | "corridor"
  | "footway"
  | "path"
  | "pedestrian"
  | "service"
  | "crossing"
  | "steps"
  | "escalator"
  | "elevator";

export type VenueWheelchairTag = "yes" | "no" | "limited" | "unknown";

export interface VenueEdge extends VenueProvenance {
  id: string;
  /** Name/ref of the source way or elevator node, never inferred. */
  name?: string;
  ref?: string;
  from: string;
  to: string;
  kind: VenueEdgeKind;
  indoor: boolean;
  /** Horizontal length, metres (0 for an elevator ride). */
  lengthM: number;
  /** Absolute rise over run as a ratio (0.08 = 8%); omitted when unknown. */
  slopeRatio?: number;
  slopeStatus?: HeightStatus;
  widthM?: number;
  /** Steps on the whole source way, for instructions only. */
  stepCount?: number;
  /** Floors travelled by an elevator edge. */
  levelSpan?: number;
  wheelchair: VenueWheelchairTag;
  /** OSM surface / smoothness values, lower-case, as tagged. */
  surface?: string;
  smoothness?: string;
  /** True when the source way carries an incline, i.e. it is a ramp. */
  ramp: boolean;
  /** Source way, for authoring reports. */
  osmRef: string;
}

export type VenueFeatureKind =
  "room" | "corridor" | "area" | "door" | "elevator" | "stairs";

/** Public source semantics, deliberately limited to renderer-relevant tags. */
export interface VenueFeatureTags {
  indoor?: string;
  amenity?: string;
  "a11ymap:area_type"?: string;
  ref?: string;
}

/** Display-only source geometry; preserve every polygon ring unchanged. */
export interface VenueFeature extends VenueProvenance {
  id: string;
  osmRef?: string;
  tags?: VenueFeatureTags;
  connectionId?: string | null;
  connectionIds?: string[];
  kind: VenueFeatureKind;
  buildingId: string | null;
  levelRef: string | null;
  ordinal: number | null;
  name?: string;
  ref?: string;
  geometry:
    | { type: "Polygon"; coordinates: LngLat[][] }
    | { type: "Point"; coordinates: LngLat };
}

/** Explicit source wall line; unknown thickness is not a measured dimension. */
export interface VenueWall extends VenueProvenance {
  id: string;
  osmRef: string;
  buildingId: string | null;
  ordinal: number | null;
  levelRef: string | null;
  geometry: { type: "LineString"; coordinates: LngLat[] };
  thicknessM?: number | null;
}

export interface VenueData {
  venueId: string;
  name: string;
  center: LngLat;
  buildings: VenueBuilding[];
  places: VenuePlace[];
  nodes: VenueNode[];
  edges: VenueEdge[];
  features: VenueFeature[];
  /** Optional for legacy compiled documents imported before wall support. */
  walls?: VenueWall[];
}

/** Stored document: compiled venue plus import provenance. */
export interface VenueDocument extends VenueData {
  version: number;
  importedAt: Date;
  source: { file: string; sha256: string };
  warnings: string[];
}

export type { VenueArrival } from "../accessible-route/venue-leg.types";
