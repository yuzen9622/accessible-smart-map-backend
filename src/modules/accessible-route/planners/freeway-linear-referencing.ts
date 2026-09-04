/**
 * Freeway Linear Referencing / Milepost Referencing Engine
 *
 * NOTE on Architecture:
 * This module implements Linear Referencing / Milepost Referencing along Taiwan National
 * Freeways. It matches Valhalla navigation route polylines to TDX Freeway Sections using
 * sequential constrained anchor projection, piecewise geodesic KM interpolation, and
 * midpoint mileage section assignment.
 *
 * It DOES NOT establish a permanent topological Graph Edge ID mapping to Valhalla/OSM.
 */

import type { DriveManeuver } from "../../../types/route";
import {
  bearingDiffDeg,
  calcBearing,
  haversineCoords,
} from "../../../utils/geo";
import {
  CORRIDOR_CONFIGS,
  getCorridorConfig,
  getFreewayCorridorRegistry,
  type FreewayDirection,
  type FreewaySectionMeta,
} from "../../traffic/freeway-corridor.registry";

export interface FreewayLinearReferencingResult {
  /** Length = polyline.length - 1; value is TDX sectionId or null if not on freeway. */
  segmentSectionIds: (string | null)[];
  /** Unique section IDs matched. */
  matchedSectionIds: Set<string>;
  /** Covered distance in meters for each matched section. */
  sectionCoveredM: Map<string, number>;
  /** Total number of segments assigned via linear referencing. */
  coveredSegmentCount: number;
}

export interface MatchedAnchor {
  sectionId: string;
  km: number;
  shapeIdx: number;
  t: number;
  distanceAlongRouteM: number;
  perpendicularDistM: number;
  sectionBearing?: number;
}

/** Maximum perpendicular distance in meters for an anchor to be considered valid. */
export const MAX_ANCHOR_DISTANCE_METERS = 35;

/** Maximum forward window size (number of points) to look for the next anchor. */
export const MAX_FORWARD_WINDOW_POINTS = 300;

/** Maximum distance in meters to extrapolate beyond the first or last anchor on a freeway. */
export const MAX_EXTRAPOLATION_METERS = 3_000;

const DEG_TO_METERS = 111_320;

/**
 * Projects point `p` onto line segment `[a, b]`.
 * Returns perpendicular distance in meters, parameter `t` in [0, 1], and projected coordinates.
 */
export function pointToSegmentProj(
  p: readonly [number, number] | [number, number],
  a: readonly [number, number] | [number, number],
  b: readonly [number, number] | [number, number],
): { distM: number; t: number; proj: [number, number] } {
  const [pLng, pLat] = p;
  const [aLng, aLat] = a;
  const [bLng, bLat] = b;

  const midLatRad = (((aLat + bLat) / 2) * Math.PI) / 180;
  const cosLat = Math.cos(midLatRad);

  const vx = (bLng - aLng) * cosLat * DEG_TO_METERS;
  const vy = (bLat - aLat) * DEG_TO_METERS;
  const px = (pLng - aLng) * cosLat * DEG_TO_METERS;
  const py = (pLat - aLat) * DEG_TO_METERS;

  const lenSq = vx * vx + vy * vy;
  if (lenSq === 0) {
    return {
      distM: haversineCoords([pLng, pLat], [aLng, aLat]),
      t: 0,
      proj: [aLng, aLat],
    };
  }

  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / lenSq));
  const projX = aLng + t * (bLng - aLng);
  const projY = aLat + t * (bLat - aLat);
  const proj: [number, number] = [projX, projY];

  const dx = px - t * vx;
  const dy = py - t * vy;
  const distM = Math.sqrt(dx * dx + dy * dy);

  return { distM, t, proj };
}

function matchesAlias(s: string, alias: string): boolean {
  if (s === alias) return true;
  // If alias is purely digits (e.g. "1", "2", "3", "10", "76"), only match exact token
  if (/^\d+$/.test(alias)) {
    return s === alias;
  }
  return s.includes(alias);
}

/**
 * Normalizes street names into candidate TDX RoadName(s) and sub-corridor constraints
 * driven by the canonical CORRIDOR_CONFIGS registry.
 */
export function resolveCandidateCorridors(streetNames?: string[]): {
  roadNames: string[];
  kmMin?: number;
  kmMax?: number;
} {
  if (!streetNames || streetNames.length === 0) {
    return { roadNames: [] };
  }

  const joined = streetNames.join(" ");

  // 1. Check elevated road specifically (汐五高架 / 五楊高架 sub-corridors)
  if (joined.includes("汐止五股高架") || joined.includes("汐五高架")) {
    return {
      roadNames: ["國道1號汐止五股高架道路"],
      kmMin: 13.08,
      kmMax: 32.1,
    };
  }
  if (joined.includes("五股楊梅高架") || joined.includes("五楊高架")) {
    return {
      roadNames: ["國道1號汐止五股高架道路"],
      kmMin: 32.1,
      kmMax: 71.35,
    };
  }

  // 2. Match against canonical aliases in ordered CORRIDOR_CONFIGS
  for (const cfg of CORRIDOR_CONFIGS) {
    for (const alias of cfg.aliases) {
      if (streetNames.some((s) => matchesAlias(s, alias))) {
        // Guard: if "1" matched, make sure it's not elevated
        if (
          cfg.roadName === "國道1號" &&
          (joined.includes("高架") ||
            joined.includes("汐五") ||
            joined.includes("五楊"))
        ) {
          continue;
        }
        return { roadNames: [cfg.roadName] };
      }
    }
  }

  return { roadNames: [] };
}

/**
 * Sequential Constrained Anchor Matching:
 * Sequentially projects TDX Section start points onto the route polyline within
 * the maneuver range. Anchors must be monotonic along the route index and within tolerance.
 */
export function matchAnchorsSequentially(
  corridorSections: readonly FreewaySectionMeta[],
  polyline: [number, number][],
  beginIdx: number,
  endIdx: number,
  cumDistM: number[],
  toleranceM: number = MAX_ANCHOR_DISTANCE_METERS,
): MatchedAnchor[] {
  const anchors: MatchedAnchor[] = [];
  let lastShapeIdx = beginIdx;

  for (const sec of corridorSections) {
    if (!sec.startPoint) continue;

    const searchEndIdx = Math.min(
      endIdx,
      lastShapeIdx + MAX_FORWARD_WINDOW_POINTS,
    );

    let bestDist = Infinity;
    let bestIdx = -1;
    let bestT = 0;

    for (let i = lastShapeIdx; i < searchEndIdx; i++) {
      const { distM, t } = pointToSegmentProj(
        sec.startPoint,
        polyline[i],
        polyline[i + 1],
      );
      if (distM < bestDist) {
        bestDist = distM;
        bestIdx = i;
        bestT = t;
      }
    }

    // Must satisfy: distance <= toleranceM and shapeIdx >= lastShapeIdx
    if (bestDist <= toleranceM && bestIdx >= lastShapeIdx) {
      const segLen = haversineCoords(polyline[bestIdx], polyline[bestIdx + 1]);
      const distAlongRoute = cumDistM[bestIdx] + bestT * segLen;

      // Reject if distance along route breaks forward progression
      if (
        anchors.length > 0 &&
        distAlongRoute < anchors.at(-1)!.distanceAlongRouteM
      ) {
        continue;
      }

      let sectionBearing: number | undefined;
      if (sec.startPoint && sec.endPoint) {
        sectionBearing = calcBearing(
          [sec.startPoint[0], sec.startPoint[1]],
          [sec.endPoint[0], sec.endPoint[1]],
        );
      }

      anchors.push({
        sectionId: sec.sectionId,
        km: sec.startKm,
        shapeIdx: bestIdx,
        t: bestT,
        distanceAlongRouteM: distAlongRoute,
        perpendicularDistM: bestDist,
        sectionBearing,
      });

      lastShapeIdx = bestIdx;
    }
  }

  return anchors;
}

/**
 * Determines travel direction (S/N/E/W) based primarily on KM Monotonicity,
 * with hard rejection for reverse bearings and tie-breaking based on perpendicular distance.
 * Returns null if direction is ambiguous, allowing safe fallback to spatial matching.
 */
export function determineDirectionFromAnchors(
  anchorsPos: MatchedAnchor[],
  anchorsNeg: MatchedAnchor[],
  isEastWest: boolean,
  routeBearing?: number,
): FreewayDirection | null {
  const dirPos: FreewayDirection = isEastWest ? "E" : "S";
  const dirNeg: FreewayDirection = isEastWest ? "W" : "N";

  let posEligible = anchorsPos.length > 0;
  let negEligible = anchorsNeg.length > 0;

  // Step 1: Hard filter by forward bearing if routeBearing is provided.
  // Any candidate whose section has bearing difference > 90° is strictly traveling backward.
  if (routeBearing !== undefined) {
    const bPos = anchorsPos[0]?.sectionBearing;
    const bNeg = anchorsNeg[0]?.sectionBearing;

    if (bPos !== undefined && bearingDiffDeg(routeBearing, bPos) > 90) {
      posEligible = false;
    }
    if (bNeg !== undefined && bearingDiffDeg(routeBearing, bNeg) > 90) {
      negEligible = false;
    }
  }

  // If both eliminated by bearing, direction is invalid
  if (!posEligible && !negEligible) {
    return null;
  }
  // If only one survived hard bearing rejection
  if (posEligible && !negEligible) {
    return dirPos;
  }
  if (negEligible && !posEligible) {
    return dirNeg;
  }

  // Step 2: Both survived bearing check. Use KM progression monotonicity
  let posMonotonicScore = 0;
  for (let i = 0; i < anchorsPos.length - 1; i++) {
    if (anchorsPos[i + 1].km > anchorsPos[i].km) posMonotonicScore++;
  }

  let negMonotonicScore = 0;
  for (let i = 0; i < anchorsNeg.length - 1; i++) {
    if (anchorsNeg[i + 1].km < anchorsNeg[i].km) negMonotonicScore++;
  }

  if (posMonotonicScore > negMonotonicScore) return dirPos;
  if (negMonotonicScore > posMonotonicScore) return dirNeg;

  // Step 3: Tied on monotonicity. Compare bearing alignment first (smaller delta is better aligned)
  if (routeBearing !== undefined) {
    const bPos = anchorsPos[0]?.sectionBearing;
    const bNeg = anchorsNeg[0]?.sectionBearing;
    if (bPos !== undefined && bNeg !== undefined) {
      const diffPos = bearingDiffDeg(routeBearing, bPos);
      const diffNeg = bearingDiffDeg(routeBearing, bNeg);
      if (diffPos < diffNeg - 15) return dirPos;
      if (diffNeg < diffPos - 15) return dirNeg;
    }
  }

  // Step 4: Compare average perpendicular distance (closest carriageway)
  const avgDistPos =
    anchorsPos.reduce((sum, a) => sum + a.perpendicularDistM, 0) /
    anchorsPos.length;
  const avgDistNeg =
    anchorsNeg.reduce((sum, a) => sum + a.perpendicularDistM, 0) /
    anchorsNeg.length;

  if (avgDistPos < avgDistNeg - 5) return dirPos;
  if (avgDistNeg < avgDistPos - 5) return dirNeg;

  return null; // Ambiguous: fallback to spatial matching
}

/**
 * Piecewise Geodesic KM Interpolation with Bounded Extrapolation.
 * Calculates highway KM for each polyline point in [beginIdx..endIdx] in O(N) time.
 */
export function interpolateKm(
  beginIdx: number,
  endIdx: number,
  anchors: MatchedAnchor[],
  cumDistM: number[],
  direction: FreewayDirection,
): Float64Array {
  const numPoints = endIdx - beginIdx + 1;
  const pointKm = new Float64Array(numPoints);
  const isIncreasing = direction === "S" || direction === "E";

  if (anchors.length === 0) {
    pointKm.fill(NaN);
    return pointKm;
  }

  const firstAnchor = anchors[0];
  const lastAnchor = anchors.at(-1)!;
  const defaultRate = isIncreasing ? 0.001 : -0.001;

  // Single anchor scenario
  if (anchors.length === 1) {
    for (let i = beginIdx; i <= endIdx; i++) {
      const localIdx = i - beginIdx;
      const d = cumDistM[i];
      const delta = Math.abs(d - firstAnchor.distanceAlongRouteM);
      if (delta <= MAX_EXTRAPOLATION_METERS) {
        pointKm[localIdx] =
          firstAnchor.km + (d - firstAnchor.distanceAlongRouteM) * defaultRate;
      } else {
        pointKm[localIdx] = NaN;
      }
    }
    return pointKm;
  }

  // Precompute extrapolation slopes
  const firstDeltaDist =
    anchors[1].distanceAlongRouteM - firstAnchor.distanceAlongRouteM;
  const startSlope =
    firstDeltaDist > 0
      ? (anchors[1].km - firstAnchor.km) / firstDeltaDist
      : defaultRate;

  const prevLastAnchor = anchors[anchors.length - 2];
  const lastDeltaDist =
    lastAnchor.distanceAlongRouteM - prevLastAnchor.distanceAlongRouteM;
  const endSlope =
    lastDeltaDist > 0
      ? (lastAnchor.km - prevLastAnchor.km) / lastDeltaDist
      : defaultRate;

  // O(N) single-pass interpolation using monotonic pointer `k`
  let k = 0;
  for (let i = beginIdx; i <= endIdx; i++) {
    const localIdx = i - beginIdx;
    const d = cumDistM[i];

    if (d <= firstAnchor.distanceAlongRouteM) {
      // Bounded backward extrapolation
      const distDiff = firstAnchor.distanceAlongRouteM - d;
      if (distDiff <= MAX_EXTRAPOLATION_METERS) {
        pointKm[localIdx] =
          firstAnchor.km + (d - firstAnchor.distanceAlongRouteM) * startSlope;
      } else {
        pointKm[localIdx] = NaN;
      }
    } else if (d >= lastAnchor.distanceAlongRouteM) {
      // Bounded forward extrapolation
      const distDiff = d - lastAnchor.distanceAlongRouteM;
      if (distDiff <= MAX_EXTRAPOLATION_METERS) {
        pointKm[localIdx] =
          lastAnchor.km + (d - lastAnchor.distanceAlongRouteM) * endSlope;
      } else {
        pointKm[localIdx] = NaN;
      }
    } else {
      // Monotonically advance k
      while (k < anchors.length - 2 && anchors[k + 1].distanceAlongRouteM < d) {
        k++;
      }
      const a0 = anchors[k];
      const a1 = anchors[k + 1];
      const deltaDist = a1.distanceAlongRouteM - a0.distanceAlongRouteM;
      const factor =
        deltaDist > 0 ? (d - a0.distanceAlongRouteM) / deltaDist : 0;
      pointKm[localIdx] = a0.km + factor * (a1.km - a0.km);
    }
  }

  return pointKm;
}

/**
 * Midpoint Section Assignment:
 * For each polyline segment (P_i, P_i+1), computes midpoint KM and assigns matching SectionID.
 * Strictly O(N) single-pass using monotonic secIdx pointer.
 */
export function assignMidpointSections(
  polyline: [number, number][],
  beginIdx: number,
  endIdx: number,
  pointKm: Float64Array,
  corridorSections: readonly FreewaySectionMeta[],
  direction: FreewayDirection,
  segmentSectionIds: (string | null)[],
  sectionCoveredM: Map<string, number>,
): number {
  if (corridorSections.length === 0) return 0;
  let assignedCount = 0;
  let secIdx = 0;
  const isIncreasing = direction === "S" || direction === "E";

  for (let i = beginIdx; i < endIdx; i++) {
    const kmA = pointKm[i - beginIdx];
    const kmB = pointKm[i + 1 - beginIdx];

    if (Number.isNaN(kmA) || Number.isNaN(kmB)) {
      continue;
    }

    const kmMid = (kmA + kmB) / 2;

    // Advance secIdx monotonically
    while (secIdx < corridorSections.length - 1) {
      const cur = corridorSections[secIdx];
      const hasPassed = isIncreasing ? kmMid >= cur.endKm : kmMid <= cur.endKm;
      if (hasPassed) {
        secIdx++;
      } else {
        break;
      }
    }

    const curSec = corridorSections[secIdx];
    const isCovered = isIncreasing
      ? kmMid >= curSec.startKm &&
        (secIdx === corridorSections.length - 1
          ? kmMid <= curSec.endKm
          : kmMid < curSec.endKm)
      : kmMid <= curSec.startKm &&
        (secIdx === corridorSections.length - 1
          ? kmMid >= curSec.endKm
          : kmMid > curSec.endKm);

    if (isCovered) {
      segmentSectionIds[i] = curSec.sectionId;
      const segLen = haversineCoords(polyline[i], polyline[i + 1]);
      sectionCoveredM.set(
        curSec.sectionId,
        (sectionCoveredM.get(curSec.sectionId) ?? 0) + segLen,
      );
      assignedCount++;
    }
  }

  return assignedCount;
}

/**
 * Entry point: matches a full route leg polyline against all national freeway corridors.
 */
export function matchLegByFreewayLinearReferencing(
  legPolyline: [number, number][],
  maneuvers?: DriveManeuver[],
): FreewayLinearReferencingResult {
  const numSegments = Math.max(0, legPolyline.length - 1);
  const segmentSectionIds: (string | null)[] = Array.from<string | null>({
    length: numSegments,
  }).fill(null);
  const matchedSectionIds = new Set<string>();
  const sectionCoveredM = new Map<string, number>();

  if (numSegments === 0 || !maneuvers || maneuvers.length === 0) {
    return {
      segmentSectionIds,
      matchedSectionIds,
      sectionCoveredM,
      coveredSegmentCount: 0,
    };
  }

  // Precompute cumulative distance array
  const cumDistM: number[] = [0];
  for (let i = 0; i < legPolyline.length - 1; i++) {
    cumDistM.push(
      cumDistM[i] + haversineCoords(legPolyline[i], legPolyline[i + 1]),
    );
  }

  const registry = getFreewayCorridorRegistry();
  let totalAssigned = 0;

  for (const m of maneuvers) {
    if (
      !m.highway &&
      !m.streetNames?.some(
        (s) =>
          s.includes("國道") || s.includes("高速公路") || s.includes("高架"),
      )
    ) {
      continue;
    }

    const { roadNames, kmMin, kmMax } = resolveCandidateCorridors(
      m.streetNames,
    );
    if (roadNames.length === 0) continue;

    const beginIdx = Math.max(0, m.beginShapeIndex);
    const endIdx = Math.min(legPolyline.length - 1, m.endShapeIndex);
    if (endIdx <= beginIdx) continue;

    // Calculate route bearing across the maneuver
    const routeBearing = calcBearing(
      legPolyline[beginIdx],
      legPolyline[endIdx],
    );

    for (const roadName of roadNames) {
      const cfg = getCorridorConfig(roadName);
      if (!cfg) continue;

      const dirPos: FreewayDirection = cfg.posDir;
      const dirNeg: FreewayDirection = cfg.negDir;
      const isEastWest = cfg.axis === "EW";

      let sectionsPos = registry.getCorridor(roadName, dirPos);
      let sectionsNeg = registry.getCorridor(roadName, dirNeg);

      if (kmMin !== undefined || kmMax !== undefined) {
        sectionsPos = sectionsPos.filter(
          (s) =>
            (kmMin === undefined || s.endKm >= kmMin) &&
            (kmMax === undefined || s.startKm <= kmMax),
        );
        sectionsNeg = sectionsNeg.filter(
          (s) =>
            (kmMin === undefined || s.startKm >= kmMin) &&
            (kmMax === undefined || s.endKm <= kmMax),
        );
      }

      // Match anchors sequentially for both directions
      const anchorsPos = matchAnchorsSequentially(
        sectionsPos,
        legPolyline,
        beginIdx,
        endIdx,
        cumDistM,
      );
      const anchorsNeg = matchAnchorsSequentially(
        sectionsNeg,
        legPolyline,
        beginIdx,
        endIdx,
        cumDistM,
      );

      if (anchorsPos.length === 0 && anchorsNeg.length === 0) {
        continue;
      }

      // Decide direction by KM monotonicity, perpendicular error and bearing alignment
      const decidedDir = determineDirectionFromAnchors(
        anchorsPos,
        anchorsNeg,
        isEastWest,
        routeBearing,
      );

      if (decidedDir === null) {
        // Ambiguous: leave for spatial matching fallback
        continue;
      }

      const selectedAnchors = decidedDir === dirPos ? anchorsPos : anchorsNeg;
      const selectedSections =
        decidedDir === dirPos ? sectionsPos : sectionsNeg;
      if (selectedAnchors.length === 0) {
        continue;
      }

      // Interpolate KM values for points in the maneuver range
      const pointKm = interpolateKm(
        beginIdx,
        endIdx,
        selectedAnchors,
        cumDistM,
        decidedDir,
      );

      // Assign sections by segment midpoint (strictly O(N))
      const assigned = assignMidpointSections(
        legPolyline,
        beginIdx,
        endIdx,
        pointKm,
        selectedSections,
        decidedDir,
        segmentSectionIds,
        sectionCoveredM,
      );

      totalAssigned += assigned;
      for (const a of selectedAnchors) {
        matchedSectionIds.add(a.sectionId);
      }

      if (assigned > 0) {
        break;
      }
    }
  }

  // Update matchedSectionIds from actual assigned segments
  for (const sid of segmentSectionIds) {
    if (sid !== null) {
      matchedSectionIds.add(sid);
    }
  }

  return {
    segmentSectionIds,
    matchedSectionIds,
    sectionCoveredM,
    coveredSegmentCount: totalAssigned,
  };
}
