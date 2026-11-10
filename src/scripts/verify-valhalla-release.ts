import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { decode } from "@googlemaps/polyline-codec";
import type {
  NormalizedValhallaLeg,
  ValhallaCosting,
} from "../adapters/valhalla.adapter";
import type { DriveLeg } from "../types/route";
import type { RoadSpeedLimits, RoadSpeedRules } from "../types/road-guidance";

const AIRPORT = [
  { lat: 25.007901, lng: 121.281634 },
  { lat: 25.017129, lng: 121.276472 },
];
const LANES = [
  { lat: 22.735, lng: 120.2929 },
  { lat: 22.738, lng: 120.295 },
];
// Fixed OSM-way-forward reference, independent of EdgeInfo.forward and artifact ordering.
const DIRECTION = [
  { lat: 25.0258893, lng: 121.4445444 },
  { lat: 25.0244344, lng: 121.443164 },
];
const WAY = "137085105";

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Candidate verification failed: ${message}`);
}
function coordinates(leg: NormalizedValhallaLeg): [number, number][] {
  return decode(leg.shapePolyline6, 6).map(([lat, lng]) => [lng, lat]);
}
function assertPartition(limits: RoadSpeedLimits, count: number) {
  requireCheck(limits.status === "available", "speed partition unavailable");
  let next = 0;
  for (const segment of limits.segments) {
    requireCheck(
      segment.fromIndex === next &&
        segment.toIndex > next &&
        segment.toIndex <= count,
      "invalid speed partition",
    );
    next = segment.toIndex;
  }
  requireCheck(next === count, "incomplete speed partition");
}

export async function verifyCandidate(
  candidateUrl: string,
  rules: RoadSpeedRules,
  sourceHash: string,
) {
  requireCheck(/^https?:\/\//.test(candidateUrl), "candidate URL is required");
  requireCheck(
    rules?.schemaVersion === 1 &&
      /^[0-9a-f]{64}$/.test(sourceHash) &&
      rules.sourcePbfSha256 === sourceHash,
    "rules source mismatch",
  );
  const geometry = rules.ways?.[WAY]?.osmGeometry;
  requireCheck(
    Array.isArray(geometry) &&
      geometry.length >= 2 &&
      geometry.every(
        (point) =>
          Array.isArray(point) &&
          point.length === 2 &&
          Number.isFinite(point[0]) &&
          Number.isFinite(point[1]) &&
          Math.abs(point[0]) <= 180 &&
          Math.abs(point[1]) <= 90,
      ),
    "missing or invalid OSM geometry",
  );
  const adapter = await import("../adapters/valhalla.adapter");
  const guidance =
    await import("../modules/accessible-route/planners/road-guidance");
  const config = await import("../config/valhalla");
  requireCheck(
    config.VALHALLA_BASE_URL === candidateUrl,
    "adapter must be loaded with the explicit candidate URL",
  );
  async function route(
    points: { lat: number; lng: number }[],
    costing: ValhallaCosting,
  ) {
    const result = await adapter.computeValhallaRoutes({
      origin: points[0],
      destination: points[1],
      costing,
      computeAlternatives: false,
    });
    requireCheck(
      result.status === "OK" &&
        result.trips.length === 1 &&
        result.trips[0].legs.length === 1,
      "native route failed",
    );
    return result.trips[0].legs[0];
  }
  async function trace(leg: NormalizedValhallaLeg, costing: ValhallaCosting) {
    const result = await adapter.computeValhallaTraceAttributes({
      shapePolyline6: leg.shapePolyline6,
      costing,
    });
    requireCheck(
      result.status === "OK",
      "edge_walk geometry, spans or N−1 values invalid",
    );
    requireCheck(
      result.shapePolyline6 === leg.shapePolyline6 &&
        result.speedLimitValues.length === coordinates(leg).length - 1,
      "edge_walk shape/count mismatch",
    );
    const polyline = coordinates(leg);
    const spans = result.spans.map((span) => {
      const wayGeometry = rules.ways[span.osmWayId]?.osmGeometry;
      return {
        ...span,
        osmForward: wayGeometry
          ? guidance.osmTraversalDirection(
              polyline.slice(span.fromIndex, span.toIndex + 1),
              wayGeometry,
            )
          : undefined,
      };
    });
    const limits = guidance.buildRoadSpeedLimits(
      result.speedLimitValues,
      spans,
      rules,
    );
    assertPartition(limits, polyline.length - 1);
    return { spans, limits, polyline };
  }
  for (const costing of ["auto", "motorcycle"] as const) {
    const airport = await route(AIRPORT, costing);
    const exit = airport.maneuvers?.filter((maneuver) =>
      maneuver.signs?.exitNumbers.includes("8"),
    );
    requireCheck(exit?.length === 1, "airport exit 8 missing or ambiguous");
    const boundary = exit[0].beginShapeIndex;
    const airportTrace = await trace(airport, costing);
    requireCheck(
      boundary > 0 && boundary < airportTrace.polyline.length - 1,
      "invalid airport exit boundary",
    );
    requireCheck(
      airportTrace.limits.status === "available" &&
        airportTrace.limits.segments.length === 2,
      "airport must have exactly 100→60 partition",
    );
    const [before, after] = airportTrace.limits.segments;
    requireCheck(
      before.fromIndex === 0 &&
        before.toIndex === boundary &&
        before.kind === "known" &&
        before.limitKph === 100 &&
        after.fromIndex === boundary &&
        after.toIndex === airportTrace.polyline.length - 1 &&
        after.kind === "known" &&
        after.limitKph === 60,
      "100→60 must change at the candidate exit maneuver boundary",
    );

    const laneLeg = await route(LANES, costing);
    const laneTrace = await trace(laneLeg, costing);
    const leg: DriveLeg = {
      type: costing === "auto" ? "DRIVE" : "MOTORCYCLE",
      from: LANES[0],
      to: LANES[1],
      distanceM: laneLeg.summary.lengthKm * 1000,
      durationMin: laneLeg.summary.timeSec / 60,
      polyline: laneTrace.polyline,
      maneuvers: laneLeg.maneuvers,
    };
    guidance.applyLaneApproachRanges(leg);
    const laneManeuvers = leg.maneuvers?.filter(
      (maneuver) => maneuver.lanes?.length,
    );
    requireCheck(
      laneManeuvers?.length === 1,
      "lane maneuver missing or ambiguous",
    );
    const maneuver = laneManeuvers[0];
    const lanes = maneuver.lanes;
    requireCheck(
      lanes?.length === 2 &&
        lanes[0].directions.length === 1 &&
        lanes[0].directions[0] === "slight_left" &&
        lanes[1].directions.length === 1 &&
        lanes[1].directions[0] === "slight_right" &&
        lanes[1].recommendation === "preferred",
      "ordered lane directions/preference invalid",
    );
    requireCheck(
      maneuver.laneApproachRange !== undefined &&
        maneuver.laneApproachRange.fromIndex <
          maneuver.laneApproachRange.toIndex &&
        maneuver.laneApproachRange.toIndex === maneuver.beginShapeIndex,
      "lane approach range invalid",
    );

    for (const forward of [true, false]) {
      const directional = await route(
        forward ? DIRECTION : [DIRECTION[1], DIRECTION[0]],
        costing,
      );
      const result = await trace(directional, costing);
      requireCheck(
        result.spans.length > 0 &&
          result.spans.every(
            (span) => span.osmWayId === WAY && span.osmForward === forward,
          ),
        "OSM direction missing, reversed, ambiguous or wrong way",
      );
      requireCheck(
        result.limits.status === "available" &&
          result.limits.segments.every(
            (segment) =>
              segment.kind === "known" &&
              segment.limitKph === (forward ? 30 : 50) &&
              segment.source === "osm_directional",
          ),
        "actual directional legal limits must be 30/50 from osm_directional",
      );
    }
  }
  return {
    candidateRouting: true,
    airportSigns: true,
    exactGeometry: true,
    speedPartition: true,
    speedTransition: true,
    lanes: true,
    laneApproach: true,
    directionalLimits: true,
  };
}

export async function verifyReleaseFile(
  candidateUrl: string,
  rulesPath: string,
  sourceHash: string,
  outputPath: string,
) {
  const content = await readFile(rulesPath);
  let rules: RoadSpeedRules;
  try {
    rules = JSON.parse(content.toString()) as RoadSpeedRules;
  } catch {
    throw new Error("Candidate rules are not valid JSON");
  }
  const checks = await verifyCandidate(candidateUrl, rules, sourceHash);
  requireCheck(
    content.equals(await readFile(rulesPath)),
    "rules changed during verification",
  );
  const result = {
    schemaVersion: 1,
    sourcePbfSha256: sourceHash,
    speedRulesSha256: createHash("sha256").update(content).digest("hex"),
    checks,
  };
  await writeFile(outputPath + ".tmp", JSON.stringify(result) + "\n");
  await rename(outputPath + ".tmp", outputPath);
  return result;
}

if (require.main === module) {
  const [candidateUrl, rulesPath, sourceHash, outputPath] =
    process.argv.slice(2);
  if (
    !candidateUrl ||
    !rulesPath ||
    !sourceHash ||
    !outputPath ||
    process.argv.length !== 6
  ) {
    console.error(
      "Usage: verify-valhalla-release.ts candidate-url rules.json source-sha256 output.json",
    );
    process.exitCode = 64;
  } else {
    process.env.VALHALLA_BASE_URL = candidateUrl;
    void verifyReleaseFile(
      candidateUrl,
      rulesPath,
      sourceHash,
      outputPath,
    ).catch((error: unknown) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Candidate verification failed",
      );
      process.exitCode = 1;
    });
  }
}
