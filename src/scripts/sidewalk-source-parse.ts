import { createHash } from "node:crypto";
import { canonicalCounty } from "../adapters/sidewalk-source.adapter";

type ObjectValue = Record<string, unknown>;
export function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export interface SidewalkPolygon {
  source_id: string;
  county: string;
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
  width_m: number | null;
  effective_width_m: number | null;
  ramp_count: number | null;
  ramp_status: "recorded" | "not_required" | "unknown";
  raw_properties: ObjectValue;
  quality_flags: string[];
}
export interface CountyReport {
  rawFeatureCount: number;
  acceptedFeatureCount: number;
  quarantinedFeatureCount: number;
  attributeIssueFeatureCount: number;
  reasons: Record<string, number>;
  attributeReasons: Record<string, number>;
}
export interface SidewalkReport extends CountyReport {
  archiveSha256: string;
  sourceBatch: string;
  counties: Record<string, CountyReport>;
}
export function emptyCountyReport(): CountyReport {
  return {
    rawFeatureCount: 0,
    acceptedFeatureCount: 0,
    quarantinedFeatureCount: 0,
    attributeIssueFeatureCount: 0,
    reasons: {},
    attributeReasons: {},
  };
}
export function incrementReason(
  reasons: Record<string, number>,
  reason: string,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

export function parseCountyCollection(json: unknown): unknown[] {
  if (
    !isObject(json) ||
    json.type !== "FeatureCollection" ||
    !Array.isArray(json.features)
  )
    throw new Error("invalid county FeatureCollection schema");
  if (json.crs != null) {
    const crs = json.crs;
    const name =
      isObject(crs) && crs.type === "name" && isObject(crs.properties)
        ? crs.properties.name
        : undefined;
    if (
      typeof name !== "string" ||
      ![
        "urn:ogc:def:crs:OGC:1.3:CRS84",
        "urn:ogc:def:crs:EPSG::4326",
        "EPSG:4326",
        "urn:ogc:def:crs:OGC::CRS84",
      ].includes(name)
    )
      throw new Error("unsupported county CRS");
  }
  return json.features;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function geometryCoordinates(geometry: unknown): number[][][][] | undefined {
  if (
    !isObject(geometry) ||
    !["Polygon", "MultiPolygon"].includes(String(geometry.type))
  )
    return undefined;
  const polygons: unknown =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0) return undefined;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) return undefined;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return undefined;
      for (const point of ring) {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every((n) => typeof n === "number" && Number.isFinite(n))
        )
          return undefined;
        if (point[0] < 117 || point[0] > 123 || point[1] < 20 || point[1] > 27)
          return undefined;
      }
      if (
        ring[0][0] !== ring[ring.length - 1][0] ||
        ring[0][1] !== ring[ring.length - 1][1]
      )
        return undefined;
    }
  }
  return polygons as number[][][][];
}

export function cleanSidewalkFeature(
  feature: unknown,
  county: string,
): { polygon: SidewalkPolygon } | { reason: string } {
  if (
    !isObject(feature) ||
    feature.type !== "Feature" ||
    !isObject(feature.properties)
  )
    return { reason: "malformed_feature" };
  const raw = feature.properties;
  if (canonicalCounty(raw.COUNTY_NA) !== county)
    return { reason: "county_mismatch" };
  const coordinates = geometryCoordinates(feature.geometry);
  if (!coordinates) return { reason: "malformed_or_out_of_range_geometry" };
  const source_id = createHash("sha256")
    .update(
      canonicalJson({ county, geometry: feature.geometry, properties: raw }),
    )
    .digest("hex");
  const quality_flags: string[] = [];
  const rawWidth = finiteNumber(raw.SW_WTH);
  let width_m = rawWidth;
  if (width_m === null || width_m <= 0) {
    quality_flags.push("invalid_or_missing_gross_width");
    width_m = null;
  }
  let effective_width_m = finiteNumber(raw.SWW_WTH);
  if (effective_width_m === null || effective_width_m <= 0) {
    quality_flags.push("invalid_or_missing_net_width");
    effective_width_m = null;
  } else if (rawWidth !== null && effective_width_m > rawWidth) {
    quality_flags.push("net_width_exceeds_gross");
    effective_width_m = null;
  }
  let ramp_count = finiteNumber(raw.SW_RAMP);
  let ramp_status: SidewalkPolygon["ramp_status"];
  if (
    typeof raw.SW_RAMP === "string" &&
    raw.SW_RAMP.trim().toUpperCase() === "N"
  ) {
    ramp_count = null;
    ramp_status = "not_required";
  } else if (
    ramp_count !== null &&
    Number.isSafeInteger(ramp_count) &&
    ramp_count >= 0 &&
    ramp_count <= 2147483647
  ) {
    ramp_status = "recorded";
  } else {
    ramp_count = null;
    ramp_status = "unknown";
    quality_flags.push("invalid_or_missing_ramp");
  }
  return {
    polygon: {
      source_id,
      county,
      geometry: { type: "MultiPolygon", coordinates },
      width_m,
      effective_width_m,
      ramp_count,
      ramp_status,
      raw_properties: raw,
      quality_flags,
    },
  };
}
