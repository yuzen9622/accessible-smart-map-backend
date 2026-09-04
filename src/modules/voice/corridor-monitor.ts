/**
 * Corridor monitoring: gathers raw facts about the route still ahead of the
 * user so `nav-advisory.ts` can grade them.
 *
 * Two hard bounds keep this cheap and safe on a long route: only the first
 * `CORRIDOR_LOOKAHEAD_M` of remaining geometry is considered, and a hazard
 * query that comes back at its limit is discarded entirely rather than being
 * read as "nothing ahead".
 *
 * Transit alerts are deliberately NOT probed here — `live-bridge` already
 * feeds them in through the existing alert-store path, and duplicating that
 * would double the TDX call volume.
 */

import { findConfirmedHazardsWithin } from "../hazard-report/hazard-report.service";
import {
  probeMetroElevatorOutages,
  type MetroStationProbe,
} from "../accessible-route/planners/facility-status";
import {
  HAZARD_ROUTE_CORRIDOR_M,
  MAX_HAZARD_QUERY_RADIUS_M,
  pointToSegmentDistanceM,
} from "../accessible-route/planners/hazard-routing";
import type { CorridorFinding } from "./nav-advisory";
import type { RemainingCorridor } from "./navigation-session";

export const CORRIDOR_LOOKAHEAD_M = 3_000;
export const HAZARD_QUERY_LIMIT = 60;

/** Injectable for tests. */
export interface CorridorProbes {
  findHazards: typeof findConfirmedHazardsWithin;
  probeElevators: typeof probeMetroElevatorOutages;
}

type Coord = [number, number];

interface CorridorSegment {
  start: Coord;
  end: Coord;
  /** Along-route distance from the user to this segment's first point. */
  startDistanceM: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

function haversineM(a: Coord, b: Coord): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from a segment's start to the point's projection onto it. */
function alongTrackM(point: Coord, start: Coord, end: Coord): number {
  const lat0 = toRad(start[1]);
  const local = (p: Coord): [number, number] => [
    toRad(p[0] - start[0]) * Math.cos(lat0) * EARTH_RADIUS_M,
    toRad(p[1] - start[1]) * EARTH_RADIUS_M,
  ];
  const [dx, dy] = local(end);
  const [px, py] = local(point);
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return 0;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSq));
  return t * Math.sqrt(lengthSq);
}

/**
 * Flattens the remaining ground geometry into segments, stopping once the
 * lookahead budget is spent.
 */
function truncateGround(corridor: RemainingCorridor): {
  segments: CorridorSegment[];
  points: Coord[];
} {
  const segments: CorridorSegment[] = [];
  const points: Coord[] = [];
  let travelled = 0;
  for (const span of corridor.ground) {
    for (let i = 0; i + 1 < span.coords.length; i++) {
      const start = span.coords[i];
      const end = span.coords[i + 1];
      const segDist = haversineM(start, end);
      if (segDist <= 0) continue;
      if (!points.length) points.push(start);

      if (travelled + segDist > CORRIDOR_LOOKAHEAD_M) {
        const remainingBudget = CORRIDOR_LOOKAHEAD_M - travelled;
        let low = 0;
        let high = 1;
        let bestT = 0;
        for (let iter = 0; iter < 16; iter++) {
          const mid = (low + high) / 2;
          const candidate: Coord = [
            start[0] + mid * (end[0] - start[0]),
            start[1] + mid * (end[1] - start[1]),
          ];
          if (haversineM(start, candidate) <= remainingBudget) {
            bestT = mid;
            low = mid;
          } else {
            high = mid;
          }
        }
        const cutoff: Coord = [
          start[0] + bestT * (end[0] - start[0]),
          start[1] + bestT * (end[1] - start[1]),
        ];
        segments.push({ start, end: cutoff, startDistanceM: travelled });
        points.push(cutoff);
        return { segments, points };
      }

      segments.push({ start, end, startDistanceM: travelled });
      points.push(end);
      travelled += segDist;
      if (travelled >= CORRIDOR_LOOKAHEAD_M) return { segments, points };
    }
  }
  return { segments, points };
}

function envelope(
  points: readonly Coord[],
): { center: { lat: number; lng: number }; radiusM: number } | null {
  if (!points.length) return null;
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const center: Coord = [
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ];
  const farthest = points.reduce(
    (max, point) => Math.max(max, haversineM(center, point)),
    0,
  );
  return {
    center: { lat: center[1], lng: center[0] },
    radiusM: farthest + HAZARD_ROUTE_CORRIDOR_M,
  };
}

async function hazardFindings(
  corridor: RemainingCorridor,
  findHazards: CorridorProbes["findHazards"],
): Promise<CorridorFinding[]> {
  const { segments, points } = truncateGround(corridor);
  if (!segments.length) return [];
  const area = envelope(points);
  if (!area) return [];
  if (area.radiusM > MAX_HAZARD_QUERY_RADIUS_M) {
    console.warn(
      "[corridor-monitor] remaining corridor exceeds the safe hazard query radius; skipping hazard findings",
    );
    return [];
  }

  const hazards = await findHazards(
    area.center,
    area.radiusM,
    HAZARD_QUERY_LIMIT,
  );
  if (!Array.isArray(hazards)) return [];
  if (hazards.length >= HAZARD_QUERY_LIMIT) {
    console.warn(
      "[corridor-monitor] hazard query saturated; skipping hazard findings",
    );
    return [];
  }

  const findings: CorridorFinding[] = [];
  for (const hazard of hazards) {
    const rawCoords = Array.isArray((hazard as any).location?.coordinates)
      ? (hazard as any).location.coordinates
      : Array.isArray((hazard as any).coordinates)
        ? (hazard as any).coordinates
        : Array.isArray((hazard as any).location)
          ? (hazard as any).location
          : null;
    if (
      !rawCoords ||
      !Number.isFinite(rawCoords[0]) ||
      !Number.isFinite(rawCoords[1])
    )
      continue;
    const point: Coord = [rawCoords[0], rawCoords[1]];
    let best: { distanceM: number; segment: CorridorSegment } | null = null;
    for (const segment of segments) {
      const distanceM = pointToSegmentDistanceM(
        point,
        segment.start,
        segment.end,
      );
      if (!best || distanceM < best.distanceM) best = { distanceM, segment };
    }
    if (!best || best.distanceM > HAZARD_ROUTE_CORRIDOR_M) continue;
    findings.push({
      category: "hazard",
      hazardId:
        hazard.id ?? (hazard as any).hazardId ?? String((hazard as any)._id),
      hazardType: hazard.hazardType,
      severity: hazard.severity,
      ...(hazard.description ? { description: hazard.description } : {}),
      location: { latitude: point[1], longitude: point[0] },
      distanceAheadM:
        best.segment.startDistanceM +
        alongTrackM(point, best.segment.start, best.segment.end),
    });
  }
  return findings;
}

async function facilityFindings(
  corridor: RemainingCorridor,
  probeElevators: CorridorProbes["probeElevators"],
): Promise<CorridorFinding[]> {
  const probes: MetroStationProbe[] = [];
  for (const leg of corridor.transit) {
    if (leg.legType !== "METRO" || !leg.railSystem) continue;
    for (const station of leg.stations ?? []) {
      probes.push({
        railSystem: leg.railSystem,
        stationUid: station.stationUid,
        stationName: station.stationName,
      });
    }
  }
  if (!probes.length) return [];
  const outages = await probeElevators(probes);
  return outages.map((outage) => ({
    category: "facility" as const,
    railSystem: outage.railSystem,
    stationId: outage.stationId,
    stationName: outage.stationName,
    elevatorKey: outage.elevatorKey,
    keyword: outage.keyword,
    description: outage.description,
  }));
}

/**
 * Scans the remaining corridor for ungraded facts. Entirely fail-soft: a
 * failing probe only costs its own category, never the whole scan.
 *
 * @param corridor The geometry and modes still ahead of the user.
 * @param probes Injectable data sources; defaults to the live ones.
 * @returns The raw findings, ready for classification.
 */
export async function scanRemainingCorridor(
  corridor: RemainingCorridor,
  probes?: Partial<CorridorProbes>,
): Promise<CorridorFinding[]> {
  const findHazards = probes?.findHazards ?? findConfirmedHazardsWithin;
  const probeElevators = probes?.probeElevators ?? probeMetroElevatorOutages;

  const settled = await Promise.allSettled([
    hazardFindings(corridor, findHazards),
    facilityFindings(corridor, probeElevators),
  ]);

  const findings: CorridorFinding[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") findings.push(...result.value);
    else
      console.warn("[corridor-monitor] corridor probe failed", result.reason);
  }
  return findings;
}
