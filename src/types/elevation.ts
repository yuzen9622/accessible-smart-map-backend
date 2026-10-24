export type ElevationUnavailableReason =
  | "not_configured"
  | "data_unavailable"
  | "unsupported_dtm"
  | "no_coverage"
  | "invalid_geometry"
  | "route_too_long"
  | "resource_limit"
  | "busy"
  | "timeout";

export interface ElevationSample {
  distanceM: number;
  coordinates: [number, number];
  elevationM: number | null;
}

export interface AvailableElevationProfile {
  status: "complete" | "partial";
  source: {
    dataset: "MOI_DTM_20M";
    kind: "terrain";
    resolutionM: 20;
    samplingIntervalM: 20;
    interpolation: "bilinear";
    smoothing: "none";
  };
  distanceM: number;
  samples: ElevationSample[];
  summary: {
    ascentM: number | null;
    descentM: number | null;
    minElevationM: number;
    maxElevationM: number;
    netElevationM: number | null;
    validSamples: number;
    sampleCount: number;
  };
}

export interface UnavailableElevationProfile {
  status: "unavailable";
  reason: ElevationUnavailableReason;
}

export type ElevationProfile =
  AvailableElevationProfile | UnavailableElevationProfile;
