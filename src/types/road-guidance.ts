export type RoadLaneDirection =
  | "none"
  | "straight"
  | "left"
  | "slight_left"
  | "sharp_left"
  | "right"
  | "slight_right"
  | "sharp_right"
  | "uturn"
  | "merge_left"
  | "merge_right";
export interface RoadSigns {
  exitNumbers: string[];
  branches: string[];
  destinations: string[];
  exitNames: string[];
}
export interface RoadLane {
  directions: RoadLaneDirection[];
  recommendation: "preferred" | "usable" | "not_recommended";
  maneuverDirection: RoadLaneDirection | null;
}
export interface RoadRange {
  fromIndex: number;
  toIndex: number;
}
export interface RoadNetworkInfo {
  tilesetId: string;
  sourcePbfSha256: string | null;
  provenance: "verified" | "unverified";
}
export type RoadSpeedLimitSegment = RoadRange &
  (
    | {
        kind: "known";
        limitKph: number;
        source: "valhalla" | "osm_directional";
      }
    | {
        kind: "unlimited";
        limitKph: null;
        source: "valhalla" | "osm_directional";
      }
    | { kind: "unknown"; limitKph: null; source: null }
  );
export type RoadSpeedLimits =
  | {
      status: "available";
      direction: "along_leg";
      segments: RoadSpeedLimitSegment[];
    }
  | {
      status: "unavailable";
      direction: "along_leg";
      segments: [];
      reason:
        | "upstream_error"
        | "budget_exhausted"
        | "geometry_mismatch"
        | "invalid_response"
        | "tileset_changed";
    };
export interface RoadGuidance {
  maneuverIndex: number;
  maneuver: string;
  endPolylineIndex: number;
  streetNames: string[];
  beginStreetNames?: string[];
  bearingBefore?: number;
  bearingAfter?: number;
  signs?: RoadSigns;
  lanes?: RoadLane[];
  laneApproachRange?: RoadRange;
  laneHint?: string;
}
export interface DirectedRoadSpan extends RoadRange {
  directedEdgeId: string;
  osmWayId: string;
  osmForward: boolean;
}
export interface RoadMatchingData {
  tilesetId: string;
  legs: {
    legIndex: number;
    geometrySha256: string;
    spans: DirectedRoadSpan[];
  }[];
}
export type ParsedSpeedRule =
  | { kind: "known"; limitKph: number; rawValue: string }
  | { kind: "unlimited" | "invalid"; limitKph: null; rawValue: string };
export interface RoadSpeedRules {
  schemaVersion: 1;
  sourcePbfSha256: string;
  ways: Record<
    string,
    {
      forward?: ParsedSpeedRule;
      backward?: ParsedSpeedRule;
      unresolvedConditional: boolean;
      unresolvedLaneSpecific: boolean;
      osmGeometry?: [number, number][];
    }
  >;
}
