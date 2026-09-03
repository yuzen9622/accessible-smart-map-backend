import Flatbush from "flatbush";
import type { TrafficSectionGeometry } from "../../types/traffic";
import { calcBearing } from "../../utils/geo";

export interface SegmentIndex {
  /** null indicates zero indexed segments (Flatbush does not allow numItems = 0). */
  flatbush: Flatbush | null;
  /** Start and end coordinates for each atomic segment. [lng, lat] -> [x, y]. */
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  /** Forward azimuth in degrees (0-359, 0 = true north, clockwise). */
  bearing: Float32Array;
  /** Index pointing to `sectionIds`. */
  sectionIdx: Int32Array;
  /** Deduplicated or mapped sectionId string table. */
  sectionIds: string[];
  segmentCount: number;
}

function extractPolylines(geo: TrafficSectionGeometry): [number, number][][] {
  const polylines: [number, number][][] = [];
  if (geo.geometry) {
    if (geo.geometry.type === "LineString") {
      if (geo.geometry.coordinates && geo.geometry.coordinates.length >= 2) {
        polylines.push(geo.geometry.coordinates);
      }
    } else if (geo.geometry.type === "MultiLineString") {
      if (geo.geometry.coordinates) {
        for (const line of geo.geometry.coordinates) {
          if (line && line.length >= 2) {
            polylines.push(line);
          }
        }
      }
    }
  } else if (geo.coordinates && geo.coordinates.length >= 2) {
    polylines.push(geo.coordinates);
  }
  return polylines;
}

/**
 * Builds a flat Structure-of-Arrays atomic segment index with an R-tree (Flatbush)
 * over all section geometries.
 *
 * @param geometries Array of section geometries loaded from DB or cache.
 * @returns Resident SegmentIndex suitable for route corridor matching.
 */
export function buildSegmentIndex(
  geometries: TrafficSectionGeometry[],
): SegmentIndex {
  const sectionIdMap = new Map<string, number>();
  const sectionIds: string[] = [];

  function getOrAddSectionId(id: string): number {
    let idx = sectionIdMap.get(id);
    if (idx === undefined) {
      idx = sectionIds.length;
      sectionIdMap.set(id, idx);
      sectionIds.push(id);
    }
    return idx;
  }

  // Pass 1: count valid atomic segments (filtering out zero-length segments)
  let totalSegments = 0;
  for (const geo of geometries) {
    const polylines = extractPolylines(geo);
    for (const polyline of polylines) {
      for (let i = 0; i < polyline.length - 1; i++) {
        const [ax, ay] = polyline[i];
        const [bx, by] = polyline[i + 1];
        // Skip zero-length segment (bearing undefined)
        if (ax === bx && ay === by) continue;
        totalSegments++;
      }
    }
  }

  if (totalSegments === 0) {
    return {
      flatbush: null,
      ax: new Float64Array(0),
      ay: new Float64Array(0),
      bx: new Float64Array(0),
      by: new Float64Array(0),
      bearing: new Float32Array(0),
      sectionIdx: new Int32Array(0),
      sectionIds: [],
      segmentCount: 0,
    };
  }

  const flatbush = new Flatbush(totalSegments);
  const axArr = new Float64Array(totalSegments);
  const ayArr = new Float64Array(totalSegments);
  const bxArr = new Float64Array(totalSegments);
  const byArr = new Float64Array(totalSegments);
  const bearingArr = new Float32Array(totalSegments);
  const sectionIdxArr = new Int32Array(totalSegments);

  // Pass 2: populate typed arrays and R-tree
  let cursor = 0;
  for (const geo of geometries) {
    const secIdx = getOrAddSectionId(geo.sectionId);
    const polylines = extractPolylines(geo);

    for (const polyline of polylines) {
      for (let i = 0; i < polyline.length - 1; i++) {
        const [ax, ay] = polyline[i];
        const [bx, by] = polyline[i + 1];
        if (ax === bx && ay === by) continue;

        axArr[cursor] = ax;
        ayArr[cursor] = ay;
        bxArr[cursor] = bx;
        byArr[cursor] = by;
        bearingArr[cursor] = calcBearing([ax, ay], [bx, by]);
        sectionIdxArr[cursor] = secIdx;

        flatbush.add(
          Math.min(ax, bx),
          Math.min(ay, by),
          Math.max(ax, bx),
          Math.max(ay, by),
        );
        cursor++;
      }
    }
  }

  flatbush.finish();

  return {
    flatbush,
    ax: axArr,
    ay: ayArr,
    bx: bxArr,
    by: byArr,
    bearing: bearingArr,
    sectionIdx: sectionIdxArr,
    sectionIds,
    segmentCount: totalSegments,
  };
}

/**
 * Queries candidate segment indices intersecting the given bounding box.
 */
export function querySegmentCandidates(
  index: SegmentIndex,
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
  max: number,
): number[] {
  if (!index.flatbush || index.segmentCount === 0) {
    return [];
  }
  const results = index.flatbush.search(minLng, minLat, maxLng, maxLat);
  if (results.length > max) {
    return results.slice(0, max);
  }
  return results;
}

/**
 * Summary statistics for logging and telemetry.
 */
export function segmentIndexStats(index: SegmentIndex): {
  segments: number;
  sections: number;
} {
  return {
    segments: index.segmentCount,
    sections: index.sectionIds.length,
  };
}
