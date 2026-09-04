import {
  congestionToSemanticLevel,
  TDX_CONGESTION_UNKNOWN,
  TRAFFIC_INCIDENT_HARD_EXCLUDE_KEYWORDS,
  TRAFFIC_MATCH,
  TRAFFIC_RATIO,
} from "../../../config/traffic";
import type {
  AccessibleRoute,
  DriveLeg,
  DriveTrafficSegment,
} from "../../../types/route";
import type {
  Bbox,
  CongestionLevel,
  LiveSection,
  RoadIncident,
  RoadIncidentSeverity,
} from "../../../types/traffic";
import { haversineCoords } from "../../../utils/geo";
import type { SegmentIndex } from "../../traffic/traffic-segment-index";
import { matchLegByFreewayLinearReferencing } from "./freeway-linear-referencing";
import {
  matchLegToSegmentIndex,
  type CorridorMatchResult,
} from "./traffic-corridor-match";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface MatchedSection {
  sectionId: string;
  congestionLevel: CongestionLevel;
  speedKmh?: number;
  travelTimeSec?: number;
  coveredM: number;
}

export function bboxOfPolyline(points: [number, number][]): Bbox {
  if (points.length === 0) {
    return [0, 0, 0, 0];
  }
  let minLng = points[0][0];
  let maxLng = points[0][0];
  let minLat = points[0][1];
  let maxLat = points[0][1];

  for (let i = 1; i < points.length; i++) {
    const [lng, lat] = points[i];
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return [minLng, minLat, maxLng, maxLat];
}

export function bboxOfPoints(points: LatLng[], padDeg = 0): Bbox {
  if (points.length === 0) {
    return [0, 0, 0, 0];
  }
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;

  for (let i = 1; i < points.length; i++) {
    const { lat, lng } = points[i];
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return [minLng - padDeg, minLat - padDeg, maxLng + padDeg, maxLat + padDeg];
}

const DEG_TO_METERS = 111_320;

export function pointToSegmentMeters(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
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
    return haversineCoords(p, a);
  }

  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / lenSq));
  const projX = t * vx;
  const projY = t * vy;

  const dx = px - projX;
  const dy = py - projY;

  return Math.sqrt(dx * dx + dy * dy);
}

export function matchSectionsToLeg(
  legPolyline: [number, number][],
  index: SegmentIndex,
  liveSectionsMap: Map<string, LiveSection>,
  precomputed?: CorridorMatchResult,
  unifiedSectionIds?: (string | null)[],
): MatchedSection[] {
  if (legPolyline.length < 2) {
    return [];
  }

  const numSegments = legPolyline.length - 1;

  // Primary path: if unifiedSectionIds provided (from linear referencing + spatial fallback)
  if (unifiedSectionIds && unifiedSectionIds.length === numSegments) {
    const sectionCovered = new Map<string, number>();
    for (let i = 0; i < numSegments; i++) {
      const sid = unifiedSectionIds[i];
      if (sid) {
        const segLen = haversineCoords(legPolyline[i], legPolyline[i + 1]);
        sectionCovered.set(sid, (sectionCovered.get(sid) ?? 0) + segLen);
      }
    }

    const matchedList: MatchedSection[] = [];
    for (const [sectionId, coveredM] of sectionCovered.entries()) {
      const live = liveSectionsMap.get(sectionId);
      matchedList.push({
        sectionId,
        congestionLevel: live?.congestionLevel ?? TDX_CONGESTION_UNKNOWN,
        speedKmh: live?.speedKmh,
        travelTimeSec: live?.travelTimeSec,
        coveredM,
      });
    }

    return matchedList;
  }

  if (index.segmentCount === 0) {
    return [];
  }

  const match =
    precomputed ?? matchLegToSegmentIndex(legPolyline, index, liveSectionsMap);

  const sectionCovered = new Map<number, number>();
  for (let i = 0; i < match.segmentSectionIdx.length; i++) {
    const secIdx = match.segmentSectionIdx[i];
    if (secIdx !== -1) {
      const cur = sectionCovered.get(secIdx) ?? 0;
      sectionCovered.set(secIdx, cur + match.segmentLengthM[i]);
    }
  }

  const matchedList: MatchedSection[] = [];
  for (const [secIdx, coveredM] of sectionCovered.entries()) {
    const sectionId = index.sectionIds[secIdx];
    const live = liveSectionsMap.get(sectionId);
    matchedList.push({
      sectionId,
      congestionLevel: live?.congestionLevel ?? TDX_CONGESTION_UNKNOWN,
      speedKmh: live?.speedKmh,
      travelTimeSec: live?.travelTimeSec,
      coveredM,
    });
  }

  return matchedList;
}

export function deriveLegTraffic(
  leg: DriveLeg,
  matched: MatchedSection[],
): {
  durationInTrafficMin?: number;
  trafficLevel?: "light" | "moderate" | "heavy";
} {
  if (!leg.polyline || leg.polyline.length < 2 || leg.durationMin <= 0) {
    return {};
  }

  let legLengthM = 0;
  for (let i = 0; i < leg.polyline.length - 1; i++) {
    legLengthM += haversineCoords(leg.polyline[i], leg.polyline[i + 1]);
  }

  if (legLengthM <= 0) {
    return {};
  }

  let rawSumCoveredM = 0;
  for (const m of matched) {
    rawSumCoveredM += m.coveredM;
  }
  const matchedM = Math.min(rawSumCoveredM, legLengthM);

  const coverageRatio = matchedM / legLengthM;
  if (coverageRatio < TRAFFIC_MATCH.minCoverageRatio) {
    return {};
  }

  const freeFlowSpeedMps = legLengthM / (leg.durationMin * 60);
  const scale = rawSumCoveredM > 0 ? matchedM / rawSumCoveredM : 1;

  let matchedTimeSec = 0;
  for (const m of matched) {
    let speedMps = freeFlowSpeedMps;

    if (m.speedKmh != null && m.speedKmh > 0) {
      speedMps = Math.max(
        (m.speedKmh * 1000) / 3600,
        TRAFFIC_MATCH.minSpeedMps,
      );
    } else if (m.congestionLevel > 0) {
      switch (m.congestionLevel) {
        case 1:
          speedMps = freeFlowSpeedMps;
          break;
        case 2:
          speedMps = Math.max(
            freeFlowSpeedMps * 0.85,
            TRAFFIC_MATCH.minSpeedMps,
          );
          break;
        case 3:
          speedMps = Math.max(
            freeFlowSpeedMps * 0.7,
            TRAFFIC_MATCH.minSpeedMps,
          );
          break;
        case 4:
          speedMps = Math.max(
            freeFlowSpeedMps * 0.5,
            TRAFFIC_MATCH.minSpeedMps,
          );
          break;
        case 5:
          speedMps = Math.max(
            freeFlowSpeedMps * 0.3,
            TRAFFIC_MATCH.minSpeedMps,
          );
          break;
        case 6:
        case -1:
          speedMps = Math.max(
            freeFlowSpeedMps * 0.15,
            TRAFFIC_MATCH.minSpeedMps,
          );
          break;
        default:
          speedMps = freeFlowSpeedMps;
      }
    }

    const effectiveM = m.coveredM * scale;
    matchedTimeSec += effectiveM / speedMps;
  }

  const unmatchedM = Math.max(0, legLengthM - matchedM);
  const unmatchedTimeSec = unmatchedM / freeFlowSpeedMps;
  const totalTimeSec = matchedTimeSec + unmatchedTimeSec;

  const durationInTrafficMin = Math.max(1, Math.round(totalTimeSec / 60));
  const ratio = totalTimeSec / (leg.durationMin * 60);

  let trafficLevel: "light" | "moderate" | "heavy";
  if (ratio < TRAFFIC_RATIO.moderate) {
    trafficLevel = "light";
  } else if (ratio < TRAFFIC_RATIO.heavy) {
    trafficLevel = "moderate";
  } else {
    trafficLevel = "heavy";
  }

  return {
    durationInTrafficMin,
    trafficLevel,
  };
}

export function classifyIncident(incident: {
  title: string;
  description?: string;
}): RoadIncidentSeverity {
  const text = `${incident.title} ${incident.description ?? ""}`;
  const isClosure = TRAFFIC_INCIDENT_HARD_EXCLUDE_KEYWORDS.some((kw) =>
    text.includes(kw),
  );
  return isClosure ? "closure" : "advisory";
}

export function pickExcludeLocations(
  closures: RoadIncident[],
  origin: LatLng,
  destination: LatLng,
  max = 50,
): LatLng[] {
  const origCoord: [number, number] = [origin.lng, origin.lat];
  const destCoord: [number, number] = [destination.lng, destination.lat];

  const sorted = [...closures].sort((a, b) => {
    const ptA: [number, number] = [a.location.lng, a.location.lat];
    const ptB: [number, number] = [b.location.lng, b.location.lat];
    const distA = pointToSegmentMeters(ptA, origCoord, destCoord);
    const distB = pointToSegmentMeters(ptB, origCoord, destCoord);
    return distA - distB;
  });

  return sorted.slice(0, max).map((c) => ({
    lat: c.location.lat,
    lng: c.location.lng,
  }));
}

export function applyIncidentAdvisories(
  routes: AccessibleRoute[],
  incidents: RoadIncident[],
  toleranceM = 100,
): void {
  if (routes.length === 0 || incidents.length === 0) {
    return;
  }

  for (const route of routes) {
    const routeDriveLegs: DriveLeg[] = [];
    for (const leg of route.legs) {
      if (
        (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") &&
        leg.polyline &&
        leg.polyline.length >= 2
      ) {
        routeDriveLegs.push(leg as DriveLeg);
      }
    }

    if (routeDriveLegs.length === 0) continue;

    for (const inc of incidents) {
      let bestLeg: DriveLeg | null = null;
      let minDistance = Infinity;

      const pt: [number, number] = [inc.location.lng, inc.location.lat];

      for (const leg of routeDriveLegs) {
        for (let i = 0; i < leg.polyline.length - 1; i++) {
          const d = pointToSegmentMeters(
            pt,
            leg.polyline[i],
            leg.polyline[i + 1],
          );
          if (d < minDistance) {
            minDistance = d;
            bestLeg = leg;
          }
        }
      }

      if (bestLeg && minDistance <= toleranceM) {
        if (!bestLeg.incidents) {
          bestLeg.incidents = [];
        }
        if (
          !bestLeg.incidents.some(
            (existing) => existing.incidentId === inc.incidentId,
          )
        ) {
          bestLeg.incidents.push(inc);
        }
      }
    }
  }
}

export const mapCongestionToSemanticLevel = congestionToSemanticLevel;

/**
 * Derives continuous traffic segments along a leg polyline.
 * Each segment maps to an index range [fromIndex, toIndex] of `legPolyline`
 * with its corresponding semantic traffic level.
 */
export function deriveTrafficSegments(
  legPolyline: [number, number][],
  index: SegmentIndex,
  liveSectionsMap: Map<string, LiveSection>,
  precomputed?: CorridorMatchResult,
  unifiedSectionIds?: (string | null)[],
): DriveTrafficSegment[] {
  if (legPolyline.length < 2) {
    return [];
  }

  const numSegments = legPolyline.length - 1;
  if (numSegments <= 0) {
    return [];
  }

  // 1. Get congestion level for each route segment
  const segmentCongestion = new Int8Array(numSegments);

  if (unifiedSectionIds && unifiedSectionIds.length === numSegments) {
    for (let i = 0; i < numSegments; i++) {
      const sid = unifiedSectionIds[i];
      if (!sid) {
        segmentCongestion[i] = TDX_CONGESTION_UNKNOWN;
      } else {
        const live = liveSectionsMap.get(sid);
        segmentCongestion[i] = live?.congestionLevel ?? TDX_CONGESTION_UNKNOWN;
      }
    }
  } else {
    if (index.segmentCount === 0) {
      return [];
    }
    const match =
      precomputed ??
      matchLegToSegmentIndex(legPolyline, index, liveSectionsMap);

    for (let i = 0; i < numSegments; i++) {
      const secIdx = match.segmentSectionIdx[i];
      if (secIdx === -1) {
        segmentCongestion[i] = TDX_CONGESTION_UNKNOWN;
      } else {
        const secId = index.sectionIds[secIdx];
        const live = liveSectionsMap.get(secId);
        segmentCongestion[i] = live?.congestionLevel ?? TDX_CONGESTION_UNKNOWN;
      }
    }
  }

  // 2. Run-length grouping on segments
  // Segment run [curStart..i-1] maps to point indices fromIndex = curStart, toIndex = i
  const rawSegments: DriveTrafficSegment[] = [];
  let curStart = 0;
  let curLevel = segmentCongestion[0];

  for (let i = 1; i < numSegments; i++) {
    const lvl = segmentCongestion[i];
    if (lvl !== curLevel) {
      rawSegments.push({
        fromIndex: curStart,
        toIndex: i,
        trafficLevel: mapCongestionToSemanticLevel(curLevel),
        congestionLevel: curLevel as CongestionLevel,
      });
      curStart = i;
      curLevel = lvl;
    }
  }
  rawSegments.push({
    fromIndex: curStart,
    toIndex: numSegments,
    trafficLevel: mapCongestionToSemanticLevel(curLevel),
    congestionLevel: curLevel as CongestionLevel,
  });

  return rawSegments;
}

export function applyTrafficOverlay(
  routes: AccessibleRoute[],
  liveSectionsMap: Map<string, LiveSection>,
  index: SegmentIndex,
): {
  spatialMatchMs: number;
  aggregateMs: number;
  candidateProbes: number;
  matchedSections: number;
} {
  let spatialMatchMs = 0;
  let aggregateMs = 0;
  let candidateProbes = 0;
  let matchedSections = 0;

  if (routes.length === 0) {
    return { spatialMatchMs, aggregateMs, candidateProbes, matchedSections };
  }

  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type !== "DRIVE" && leg.type !== "MOTORCYCLE") {
        continue;
      }
      const driveLeg = leg as DriveLeg;
      if (!driveLeg.polyline || driveLeg.polyline.length < 2) {
        continue;
      }

      const numSegments = driveLeg.polyline.length - 1;

      // Phase 1: Freeway Linear Referencing (Primary)
      const freewayRes = matchLegByFreewayLinearReferencing(
        driveLeg.polyline,
        driveLeg.maneuvers,
      );

      // Phase 2: Spatial Geometry Matching (Fallback for non-freeway segments)
      let matchResult: CorridorMatchResult | undefined;
      if (index.segmentCount > 0 && index.flatbush) {
        const tMatch0 = performance.now();
        matchResult = matchLegToSegmentIndex(
          driveLeg.polyline,
          index,
          liveSectionsMap,
        );
        spatialMatchMs += performance.now() - tMatch0;
        candidateProbes += matchResult.candidateProbes;
      }

      // Phase 3: Combine into Unified Section IDs array (Freeway > Spatial > Unknown)
      const unifiedSectionIds: (string | null)[] = Array.from<string | null>({
        length: numSegments,
      }).fill(null);
      for (let i = 0; i < numSegments; i++) {
        if (freewayRes.segmentSectionIds[i] !== null) {
          unifiedSectionIds[i] = freewayRes.segmentSectionIds[i];
        } else if (matchResult && matchResult.segmentSectionIdx[i] !== -1) {
          const secIdx = matchResult.segmentSectionIdx[i];
          unifiedSectionIds[i] = index.sectionIds[secIdx];
        }
      }

      // Phase 4: Derive Traffic and Segments
      const tAgg0 = performance.now();
      const matched = matchSectionsToLeg(
        driveLeg.polyline,
        index,
        liveSectionsMap,
        matchResult,
        unifiedSectionIds,
      );
      matchedSections += matched.length;

      const traffic = deriveLegTraffic(driveLeg, matched);

      if (traffic.durationInTrafficMin !== undefined) {
        driveLeg.durationInTrafficMin = traffic.durationInTrafficMin;
      }
      if (traffic.trafficLevel !== undefined) {
        driveLeg.trafficLevel = traffic.trafficLevel;
      }

      const segments = deriveTrafficSegments(
        driveLeg.polyline,
        index,
        liveSectionsMap,
        matchResult,
        unifiedSectionIds,
      );
      if (segments.length > 0) {
        driveLeg.trafficSegments = segments;
      }
      aggregateMs += performance.now() - tAgg0;
    }
  }

  return {
    spatialMatchMs: Math.round(spatialMatchMs),
    aggregateMs: Math.round(aggregateMs),
    candidateProbes,
    matchedSections,
  };
}
