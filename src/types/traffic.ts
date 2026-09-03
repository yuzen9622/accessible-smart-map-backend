import type { GeoJsonLineString, GeoJsonMultiLineString } from "../utils/wkt";

/**
 * Types for the TDX Road/Traffic domain: the raw upstream row shapes (field
 * names verified by `pnpm smoke:tdx-traffic`) and the normalized shapes the
 * rest of the codebase consumes.
 */

/**
 * TDX live congestion code. `1..6` are the TDX level names A..F (1 = free
 * flowing, 6 = severe), `-1` is a closed road and `-99` means no data. Codes
 * outside this domain are normalized to `-99` by the adapter.
 */
export type CongestionLevel = -99 | -1 | 1 | 2 | 3 | 4 | 5 | 6;

/** Every TDX Road/Traffic response wraps its rows in an update-time envelope. */
export interface TdxTrafficEnvelope {
  UpdateTime?: string;
  SrcUpdateTime?: string;
  AuthorityCode?: string;
}

export interface TdxLiveTrafficRow {
  SectionID?: string;
  /** Seconds to traverse the section, or `-99` when not measured. */
  TravelTime?: number;
  /** km/h across the section, or `-99` when not measured. */
  TravelSpeed?: number;
  /** Identifier of the congestion definition used for this section. */
  CongestionLevelID?: string;
  /** Congestion code, delivered as a string (e.g. `"2"`, `"-99"`). */
  CongestionLevel?: string;
  DataCollectTime?: string;
}

export interface TdxSectionRow {
  SectionID?: string;
  SectionName?: string;
  RoadID?: string;
  RoadName?: string;
  RoadClass?: number;
  RoadDirection?: string;
  SectionLength?: number;
}

export interface TdxSectionShapeRow {
  SectionID?: string;
  /** WKT `LINESTRING` covering the section centreline. */
  Geometry?: string;
}

export interface TdxCongestionLevelRow {
  CongestionLevelID?: string;
  CongestionLevelName?: string;
  MeasureIndex?: string;
  Levels?: {
    Level?: number;
    LevelName?: string;
    LowValue?: number;
    TopValue?: number;
  }[];
}

export interface TdxLiveEventRow {
  EventID?: string;
  EventTitle?: string;
  Description?: string;
  EventType?: number;
  EventSubType?: number;
  EventStep?: number;
  EffectiveTime?: string;
  ExpireTime?: string;
  /** WKT `POINT(lon lat)` for the event location. */
  Positions?: string;
  Location?: { Other?: string; RoadName?: string };
  PublishTime?: string;
  LastUpdateTime?: string;
}

/** One section's live congestion reading, normalized from TDX. */
export interface LiveSection {
  sectionId: string;
  congestionLevel: CongestionLevel;
  /** Seconds to traverse the section, or `undefined` when not measured. */
  travelTimeSec?: number;
  /** km/h across the section, or `undefined` when not measured. */
  speedKmh?: number;
  updatedAt?: string;
}

/** `[minLng, minLat, maxLng, maxLat]`, matching the query-string order. */
export type Bbox = [number, number, number, number];

/** Descriptive attributes of a section, from the TDX `Section` endpoint. */
export interface TrafficSectionMeta {
  sectionId: string;
  roadName?: string;
  roadClass?: number;
  lengthM?: number;
}

/** A section centreline from the TDX `SectionShape` endpoint, parsed from WKT. */
export interface TrafficSectionShape {
  sectionId: string;
  geometry: GeoJsonLineString | GeoJsonMultiLineString;
}

export type TrafficGeometry =
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] };

/** A section centreline as stored after the offline geometry import. */
export interface TrafficSectionGeometry {
  sectionId: string;
  roadName?: string;
  roadClass?: number;
  city: string;
  geometry: TrafficGeometry;
  coordinates?: [number, number][];
}

export type SemanticTrafficLevel =
  "light" | "moderate" | "heavy" | "severe" | "closed" | "unknown";

export interface TrafficFlowFeature {
  type: "Feature";
  geometry: TrafficGeometry;
  properties: {
    sectionId: string;
    roadName?: string;
    city: string;
    trafficLevel: SemanticTrafficLevel;
    congestionLevel: CongestionLevel;
    congestionLabel: string;
    speedKmh?: number;
    travelTimeSec?: number;
  };
}

export interface TrafficFlowCollection {
  type: "FeatureCollection";
  features: TrafficFlowFeature[];
  meta: {
    cities: string[];
    bbox: [number, number, number, number];
    count: number;
    levelCounts: Record<string, number>;
    /** `null` when every live fetch failed and the network is shown as grey. */
    liveUpdatedAt: string | null;
    geometryImportedAt: string | null;
  };
}

/** Whether an incident forces a detour or is only reported to the user. */
export type RoadIncidentSeverity = "closure" | "advisory";

/**
 * A live road event, normalized from TDX and filtered to the active ones. The
 * same shape is what gets attached to a route leg, so there is no separate
 * advisory type.
 */
export interface RoadIncident {
  incidentId: string;
  title: string;
  description?: string;
  severity: RoadIncidentSeverity;
  roadName?: string;
  location: { lat: number; lng: number };
  startTime?: string;
  /** Absent means the event has no published end and is treated as active. */
  endTime?: string;
}

/**
 * A live road event as the adapter normalizes it. Severity is decided by the
 * traffic module rather than the transport boundary, so it is absent here.
 */
export type RawRoadIncident = Omit<RoadIncident, "severity">;
