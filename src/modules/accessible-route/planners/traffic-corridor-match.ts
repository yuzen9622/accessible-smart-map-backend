import { TRAFFIC_MATCH } from "../../../config/traffic";
import type { LiveSection } from "../../../types/traffic";
import {
  calcBearing,
  haversineCoords,
  bearingDiffDeg,
} from "../../../utils/geo";
import {
  querySegmentCandidates,
  type SegmentIndex,
} from "../../traffic/traffic-segment-index";
import { pointToSegmentMeters } from "./traffic-overlay";

export interface CorridorMatchResult {
  /** Length = polyline.length - 1; value is index into SegmentIndex.sectionIds, -1 = unmatched. */
  segmentSectionIdx: Int32Array;
  /** Distance in meters; unmatched is Infinity. */
  segmentDistanceM: Float64Array;
  /** Actual length of each route segment in meters, for coverage weighting. */
  segmentLengthM: Float64Array;
  /** Observation counter for telemetry. */
  candidateProbes: number;
}

const DEG_TO_METERS = 111_320;

export { bearingDiffDeg } from "../../../utils/geo";

/**
 * Computes symmetric approximate distance between two line segments AB and CD.
 * Takes the minimum of 6 point-to-segment distances: {A, mid(A,B), B} against CD
 * and {C, mid(C,D), D} against AB.
 */
export function segmentToSegmentApproxMeters(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): number {
  const midAB: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const midCD: [number, number] = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2];

  const d1 = pointToSegmentMeters(a, c, d);
  const d2 = pointToSegmentMeters(midAB, c, d);
  const d3 = pointToSegmentMeters(b, c, d);
  const d4 = pointToSegmentMeters(c, a, b);
  const d5 = pointToSegmentMeters(midCD, a, b);
  const d6 = pointToSegmentMeters(d, a, b);

  return Math.min(d1, d2, d3, d4, d5, d6);
}

/**
 * Matches a route leg polyline against the resident segment index using corridor search
 * and dual filtering: perpendicular distance <= toleranceM AND directed bearing diff <= bearingToleranceDeg.
 */
export function matchLegToSegmentIndex(
  legPolyline: [number, number][],
  index: SegmentIndex,
  liveSectionsMap: Map<string, LiveSection>,
): CorridorMatchResult {
  if (legPolyline.length < 2 || index.segmentCount === 0 || !index.flatbush) {
    return {
      segmentSectionIdx: new Int32Array(0),
      segmentDistanceM: new Float64Array(0),
      segmentLengthM: new Float64Array(0),
      candidateProbes: 0,
    };
  }

  const numSegments = legPolyline.length - 1;
  const segmentSectionIdx = new Int32Array(numSegments);
  segmentSectionIdx.fill(-1);
  const segmentDistanceM = new Float64Array(numSegments);
  segmentDistanceM.fill(Infinity);
  const segmentLengthM = new Float64Array(numSegments);

  let candidateProbes = 0;
  const toleranceM = TRAFFIC_MATCH.toleranceM;
  const corridorPadM = TRAFFIC_MATCH.corridorPadM;
  const bearingToleranceDeg = TRAFFIC_MATCH.bearingToleranceDeg;
  const maxCandidates = TRAFFIC_MATCH.maxCandidatesPerSegment;

  for (let i = 0; i < numSegments; i++) {
    const p1 = legPolyline[i];
    const p2 = legPolyline[i + 1];

    const segLen = haversineCoords(p1, p2);
    segmentLengthM[i] = segLen;

    const routeBearing = calcBearing(p1, p2);

    const minLng = Math.min(p1[0], p2[0]);
    const maxLng = Math.max(p1[0], p2[0]);
    const minLat = Math.min(p1[1], p2[1]);
    const maxLat = Math.max(p1[1], p2[1]);

    const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
    const padLatDeg = corridorPadM / DEG_TO_METERS;
    const padLngDeg =
      corridorPadM / (DEG_TO_METERS * Math.max(Math.cos(midLatRad), 0.01));

    const candidates = querySegmentCandidates(
      index,
      minLng - padLngDeg,
      minLat - padLatDeg,
      maxLng + padLngDeg,
      maxLat + padLatDeg,
      maxCandidates,
    );

    let bestDist = Infinity;
    let bestSecIdx = -1;
    let bestHasLive = false;

    for (const candIdx of candidates) {
      candidateProbes++;

      // Directed bearing filter
      const candBearing = index.bearing[candIdx];
      const bDiff = bearingDiffDeg(routeBearing, candBearing);
      if (bDiff > bearingToleranceDeg) {
        continue;
      }

      // Distance filter
      const c: [number, number] = [index.ax[candIdx], index.ay[candIdx]];
      const d: [number, number] = [index.bx[candIdx], index.by[candIdx]];
      const distM = segmentToSegmentApproxMeters(p1, p2, c, d);
      if (distM > toleranceM) {
        continue;
      }

      const secIdx = index.sectionIdx[candIdx];
      const secId = index.sectionIds[secIdx];
      const hasLive = liveSectionsMap.has(secId);

      if (distM < bestDist) {
        bestDist = distM;
        bestSecIdx = secIdx;
        bestHasLive = hasLive;
      } else if (distM === bestDist) {
        if (hasLive && !bestHasLive) {
          bestDist = distM;
          bestSecIdx = secIdx;
          bestHasLive = true;
        }
      }
    }

    if (bestSecIdx !== -1) {
      segmentSectionIdx[i] = bestSecIdx;
      segmentDistanceM[i] = bestDist;
    }
  }

  return {
    segmentSectionIdx,
    segmentDistanceM,
    segmentLengthM,
    candidateProbes,
  };
}
