import {
  OtpWalkCoordinateSchema,
  OtpWalkEvidenceSchema,
  type OtpWalkCoordinate,
  type OtpWalkEvidence,
} from "../../../types/otp-walk-evidence";
import type { OtpWalkIdentity } from "../../../types/otp-walk-identity";
import { sameOtpWalkIdentity } from "./otp-walk-identity";
import type { OtpDirectWalkProfile } from "../../../types/otp-walk-search";
import { matchesExecutedWalkPolicy } from "./otp-walk-search";

export { OtpWalkEvidenceSchema } from "../../../types/otp-walk-evidence";
export type { OtpWalkEvidence } from "../../../types/otp-walk-evidence";

export interface OtpWalkEvidenceExpectations {
  identity: OtpWalkIdentity;
  origin: OtpWalkCoordinate;
  destination: OtpWalkCoordinate;
  profile: OtpDirectWalkProfile;
  avoidStairs: boolean;
}
type FailureReason =
  | "invalid_evidence"
  | "identity_mismatch"
  | "source_mismatch"
  | "request_mismatch"
  | "fare_gate"
  | "incomplete_geometry"
  | "geometry_mismatch"
  | "geometry_gap";
export type OtpWalkEvidenceResult =
  | {
      status: "ready";
      evidence: OtpWalkEvidence;
      distanceM: number;
      /** One native segment per occurrence, including empty segments. */
      geometrySegments: [number, number][][];
      /** Display coordinates only; does not prove connectors between segments. */
      polyline: [number, number][];
    }
  | { status: "unavailable"; reason: FailureReason };

const streetKinds = new Set([
  "StreetEdge",
  "AreaEdge",
  "TemporaryPartialStreetEdge",
]);
const SNAP_TOLERANCE_M = 0.25;
// Cross-language floating point comparison, distinct from the route's snap allowance.
const METRIC_ROUNDOFF_M = 0.000001;
type Edge = OtpWalkEvidence["edges"][number];
type Source = Pick<
  Edge,
  | "knownWidthM"
  | "sourceRefs"
  | "widthSourceRefs"
  | "sourceBatch"
  | "sourceVersion"
  | "sourceSha256"
>;

function samePoint(
  a: OtpWalkCoordinate | null,
  b: OtpWalkCoordinate | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.lat === b.lat && a.lon === b.lon;
}

function gapM(
  a: OtpWalkCoordinate | null,
  b: OtpWalkCoordinate | null,
): number | null {
  if (a === null || b === null) return null;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.min(
    1,
    Math.max(
      0,
      Math.sin(dp / 2) ** 2 +
        Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2,
    ),
  );
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function sameMetric(a: number | null, b: number | null): boolean {
  return a === null || b === null
    ? a === b
    : Math.abs(a - b) <= METRIC_ROUNDOFF_M;
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  const unique = new Set(a);
  return (
    unique.size === a.length &&
    a.length === b.length &&
    b.every((ref) => unique.has(ref))
  );
}

function emptyLineage(edge: Edge): boolean {
  return (
    edge.osmWayId === null &&
    edge.sourceSegmentIndex === null &&
    edge.reverse === null &&
    edge.sourceRefs.length === 0 &&
    edge.widthSourceRefs.length === 0 &&
    edge.sourceBatch === null &&
    edge.sourceVersion === null &&
    edge.sourceSha256 === null &&
    edge.areaSources.length === 0
  );
}

function validMetadata(edge: Edge): boolean {
  const street = streetKinds.has(edge.edgeKind);
  if (
    (edge.metadataStatus === "GOVERNMENT_ENDPOINT") !==
    (edge.attachment !== null)
  )
    return false;
  if (edge.partial !== (edge.edgeKind === "TemporaryPartialStreetEdge"))
    return false;
  switch (edge.metadataStatus) {
    case "GOVERNMENT_ENDPOINT":
      return (
        edge.edgeKind === "GovernmentEndpointEdge" &&
        edge.osmWayId === null &&
        edge.sourceSegmentIndex === null &&
        edge.reverse === null &&
        edge.sourceRefs.length > 0 &&
        edge.areaSources.length === 0 &&
        edge.pathway === null &&
        edge.unknownReason === null &&
        edge.attachment !== null &&
        (edge.knownWidthM === null) ===
          (edge.attachment.widthCoverageStatus === "UNKNOWN") &&
        new Set(edge.attachment.widthObservationGeometrySha256).size ===
          edge.attachment.widthObservationGeometrySha256.length
      );
    case "OSM_WAY":
      return (
        street &&
        edge.osmWayId !== null &&
        edge.sourceSegmentIndex !== null &&
        edge.reverse !== null &&
        edge.areaSources.length === 0 &&
        edge.pathway === null &&
        edge.unknownReason === null
      );
    case "OSM_AREA": {
      const widths = edge.areaSources.flatMap((area) =>
        area.knownWidthM === null ? [] : [area.knownWidthM],
      );
      return (
        street &&
        edge.osmWayId === null &&
        edge.sourceSegmentIndex === null &&
        edge.reverse !== null &&
        edge.areaSources.length > 0 &&
        edge.pathway === null &&
        edge.unknownReason === null &&
        edge.sourceBatch === null &&
        edge.sourceVersion === null &&
        edge.sourceSha256 === null &&
        edge.knownWidthM === (widths.length ? Math.min(...widths) : null) &&
        new Set(edge.areaSources.map((area) => area.osmId)).size ===
          edge.areaSources.length &&
        sameRefs(edge.sourceRefs, [
          ...new Set(edge.areaSources.flatMap((area) => area.sourceRefs)),
        ]) &&
        sameRefs(edge.widthSourceRefs, [
          ...new Set(edge.areaSources.flatMap((area) => area.widthSourceRefs)),
        ])
      );
    }
    case "GTFS_PATHWAY":
      return (
        edge.edgeKind === "PathwayEdge" &&
        emptyLineage(edge) &&
        edge.pathway !== null &&
        edge.knownWidthM === edge.pathway.knownMinWidthM &&
        edge.unknownReason ===
          (edge.pathway.pathwayId === null ? "PATHWAY_SOURCE_ID_UNKNOWN" : null)
      );
    case "UNKNOWN":
      return (
        emptyLineage(edge) &&
        edge.knownWidthM === null &&
        edge.pathway === null &&
        edge.unknownReason ===
          (street
            ? "STREET_POLICY_METADATA_MISSING"
            : "NON_STREET_METADATA_UNAVAILABLE")
      );
  }
}

function validObservationShape(edge: Edge): boolean {
  const value = edge.policyEvaluation;
  if (streetKinds.has(edge.edgeKind))
    return (
      value.stairs !== null &&
      value.escalator === false &&
      value.nativeWheelchairAccessible !== null
    );
  if (edge.edgeKind === "PathwayEdge") {
    const pathway = edge.pathway;
    return (
      value.stairs !== null &&
      value.escalator === (pathway?.mode === "ESCALATOR") &&
      (pathway?.mode !== "STAIRS" || value.stairs) &&
      value.nativeWheelchairAccessible ===
        (pathway?.knownWheelchairAccessible ?? null) &&
      value.knownMaxSlopeRatio === (pathway?.knownSlopeRatio ?? null) &&
      value.knownWidthM === (pathway?.knownMinWidthM ?? null) &&
      value.knownSmoothness === null &&
      value.captureSchemaVersion === null
    );
  }
  if (
    value.knownMaxSlopeRatio !== null ||
    value.knownSmoothness !== null ||
    value.captureSchemaVersion !== null ||
    value.assistedStairs
  )
    return false;
  if (edge.edgeKind === "EscalatorEdge")
    return (
      value.stairs === false &&
      value.escalator === true &&
      value.nativeWheelchairAccessible === false &&
      value.knownWidthM === null
    );
  if (edge.edgeKind === "ElevatorHopEdge")
    return value.stairs === false && value.escalator === false;
  if (
    edge.edgeKind === "StreetTransitStopLink" ||
    edge.edgeKind === "StreetTransitEntranceLink"
  )
    return (
      value.stairs === false &&
      value.escalator === false &&
      value.knownWidthM === null
    );
  return (
    value.stairs === null &&
    value.escalator === null &&
    value.nativeWheelchairAccessible === null &&
    (edge.edgeKind === "GovernmentEndpointEdge" || value.knownWidthM === null)
  );
}

function validPolicy(edge: Edge, profile: OtpDirectWalkProfile): boolean {
  const observed = edge.policyEvaluation;
  const street = streetKinds.has(edge.edgeKind);
  if (!validObservationShape(edge)) return false;
  if (
    edge.areaSources.some(
      (area) =>
        (area.stairs && observed.stairs !== true) ||
        (!area.wheelchairAccessible &&
          observed.nativeWheelchairAccessible !== false) ||
        (area.knownSmoothness === "impassable" &&
          observed.knownSmoothness !== "impassable"),
    )
  )
    return false;
  if (observed.assistedStairs && !street && edge.edgeKind !== "PathwayEdge")
    return false;
  if (
    (street ||
      edge.metadataStatus === "GOVERNMENT_ENDPOINT" ||
      edge.metadataStatus === "GTFS_PATHWAY") &&
    observed.knownWidthM !== edge.knownWidthM
  )
    return false;
  if (profile === "NORMAL") return !observed.assistedStairs;
  if (street && observed.captureSchemaVersion !== 2) return false;
  const assisted =
    profile === "WHEELCHAIR_STAIRS_ASSISTED" &&
    observed.stairs === true &&
    observed.escalator !== true;
  if (observed.assistedStairs !== assisted || observed.escalator === true)
    return false;
  if (observed.stairs === true && !assisted) return false;
  if (!assisted && observed.nativeWheelchairAccessible === false) return false;
  if (
    !assisted &&
    observed.knownMaxSlopeRatio !== null &&
    Math.round(Math.abs(observed.knownMaxSlopeRatio) * 100_000_000) > 12_000_000
  )
    return false;
  if (
    (edge.knownWidthM !== null &&
      Math.round(edge.knownWidthM * 1_000_000) < 900_000) ||
    (observed.knownWidthM !== null &&
      Math.round(observed.knownWidthM * 1_000_000) < 900_000) ||
    observed.knownSmoothness?.toLowerCase() === "impassable"
  )
    return false;
  return edge.areaSources.every(
    (area) =>
      (area.knownWidthM === null ||
        Math.round(area.knownWidthM * 1_000_000) >= 900_000) &&
      area.knownSmoothness?.toLowerCase() !== "impassable" &&
      (area.wheelchairAccessible || (assisted && area.stairs)),
  );
}

function sourceMatches(source: Source, identity: OtpWalkIdentity): boolean {
  if (
    new Set(source.sourceRefs).size !== source.sourceRefs.length ||
    new Set(source.widthSourceRefs).size !== source.widthSourceRefs.length ||
    (source.widthSourceRefs.length > 0 && source.knownWidthM === null)
  )
    return false;
  const hasIdentity =
    source.sourceBatch !== null ||
    source.sourceVersion !== null ||
    source.sourceSha256 !== null;
  if (
    source.sourceRefs.length === 0 &&
    source.widthSourceRefs.length === 0 &&
    !hasIdentity
  )
    return true;
  const manifest = identity.buildManifestIdentity;
  return (
    source.sourceVersion === manifest.sourceVersion &&
    source.sourceBatch === manifest.sourceBatch &&
    source.sourceSha256 === manifest.sourceArchiveSha256
  );
}

function geometrySource(edge: Edge): string {
  if (streetKinds.has(edge.edgeKind))
    return "NATIVE_STREET_COMPACT_E6_INTERMEDIATES";
  return edge.edgeKind === "PathwayEdge"
    ? "NATIVE_PATHWAY_ENDPOINT_LINE"
    : "NATIVE_EDGE_GET_GEOMETRY";
}

function qualifyGeometry(evidence: OtpWalkEvidence): FailureReason | null {
  const path = evidence.selectedPath;
  const occurrences = path.occurrences;
  let previousEnd: OtpWalkCoordinate | null = null;
  let previousVertex: OtpWalkCoordinate | null = null;
  let first: OtpWalkCoordinate | null = null;
  let missing = 0;
  let positiveMissing = 0;
  let unresolved = 0;
  let totalLength = 0;
  let nativeGaps = false;
  let incomplete = false;
  let exceedsTolerance = false;

  for (const [index, occurrence] of occurrences.entries()) {
    const edge = evidence.edges[index];
    if (
      !edge ||
      occurrence.occurrenceIndex !== index ||
      edge.occurrenceIndex !== index ||
      occurrence.edgeKind !== edge.edgeKind ||
      occurrence.distanceM !== edge.distanceM ||
      occurrence.partial !== edge.partial ||
      occurrence.geometrySource !== geometrySource(edge)
    )
      return "invalid_evidence";
    const points = occurrence.coordinates;
    const start = points[0] ?? null;
    const end = points.at(-1) ?? null;
    if (
      (occurrence.geometryStatus === "PRESENT") !== points.length >= 2 ||
      (occurrence.geometryStatus !== "PRESENT" && points.length > 0)
    )
      return "geometry_mismatch";
    const vertexGap = gapM(occurrence.traversalFrom, occurrence.traversalTo);
    const startGap = gapM(start, occurrence.traversalFrom);
    const endGap = gapM(end, occurrence.traversalTo);
    const previousGap = gapM(previousEnd, start);
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += gapM(points[i - 1], points[i]) ?? 0;
    if (
      !sameMetric(occurrence.vertexGapM, vertexGap) ||
      !sameMetric(occurrence.geometryStartToTraversalFromGapM, startGap) ||
      !sameMetric(occurrence.geometryEndToTraversalToGapM, endGap) ||
      !sameMetric(occurrence.gapFromPreviousGeometryM, previousGap) ||
      !sameMetric(occurrence.geometryLengthM, length)
    )
      return "geometry_mismatch";
    if (index > 0 && !samePoint(previousVertex, occurrence.traversalFrom))
      return "geometry_mismatch";
    if (occurrence.traversalDirection === "UNRESOLVED") unresolved++;
    if (occurrence.traversalFrom === null || occurrence.traversalTo === null)
      incomplete = true;
    previousVertex = occurrence.traversalTo;
    if (start === null) {
      missing++;
      if (edge.distanceM > 0) positiveMissing++;
      if (occurrence.geometryStatus === "INVALID_COORDINATE") incomplete = true;
      if (
        occurrence.geometryStatus === "INVALID_COORDINATE" ||
        occurrence.vertexGapM === null ||
        occurrence.vertexGapM > 0 ||
        edge.distanceM > 0
      )
        nativeGaps = true;
      if (vertexGap === null || vertexGap > SNAP_TOLERANCE_M)
        exceedsTolerance = true;
    } else {
      first ??= start;
      previousEnd = end;
      if (
        (occurrence.gapFromPreviousGeometryM !== null &&
          occurrence.gapFromPreviousGeometryM > 0) ||
        occurrence.geometryStartToTraversalFromGapM === null ||
        occurrence.geometryEndToTraversalToGapM === null ||
        occurrence.geometryStartToTraversalFromGapM > 0 ||
        occurrence.geometryEndToTraversalToGapM > 0
      )
        nativeGaps = true;
      if (
        startGap === null ||
        endGap === null ||
        startGap > SNAP_TOLERANCE_M ||
        endGap > SNAP_TOLERANCE_M ||
        (previousGap !== null && previousGap > SNAP_TOLERANCE_M)
      )
        exceedsTolerance = true;
      totalLength += length;
    }
  }
  const coverage =
    occurrences.length === 0
      ? "EMPTY_PATH"
      : unresolved > 0
        ? "UNRESOLVED_STATE_CHAIN"
        : first === null
          ? "NO_NATIVE_GEOMETRY"
          : nativeGaps
            ? "NATIVE_GEOMETRY_GAPS"
            : "NATIVE_GEOMETRY_COMPLETE";
  if (
    path.missingGeometryCount !== missing ||
    path.positiveDistanceMissingGeometryCount !== positiveMissing ||
    path.stateChainMismatchCount !== unresolved ||
    path.geometryCoverageStatus !== coverage ||
    !sameMetric(path.representedGeometryLengthM, totalLength) ||
    !samePoint(path.firstGeometryPoint, first) ||
    !samePoint(path.lastGeometryPoint, previousEnd) ||
    !samePoint(path.startState, occurrences[0]?.traversalFrom ?? null) ||
    !samePoint(path.endState, occurrences.at(-1)?.traversalTo ?? null)
  )
    return "geometry_mismatch";
  const endpointPairs = [
    {
      reported: path.requestFromToStartStateGapM,
      actual: gapM(path.requestFrom, path.startState),
    },
    {
      reported: path.requestToToEndStateGapM,
      actual: gapM(path.requestTo, path.endState),
    },
    {
      reported: path.requestFromToFirstGeometryGapM,
      actual: gapM(path.requestFrom, first),
    },
    {
      reported: path.requestToToLastGeometryGapM,
      actual: gapM(path.requestTo, previousEnd),
    },
  ];
  if (
    endpointPairs.some(({ reported, actual }) => !sameMetric(reported, actual))
  )
    return "geometry_mismatch";
  if (
    incomplete ||
    positiveMissing > 0 ||
    unresolved > 0 ||
    first === null ||
    !path.startsSearchPath ||
    !path.endsSearchPath
  )
    return "incomplete_geometry";
  if (
    exceedsTolerance ||
    endpointPairs.some(
      ({ actual }) => actual === null || actual > SNAP_TOLERANCE_M,
    )
  )
    return "geometry_gap";
  return null;
}

/** Qualifies one complete direct WALK search; it never supplies missing geometry or metadata. */
export function parseOtpWalkEvidence(
  value: unknown,
  expected: OtpWalkEvidenceExpectations,
): OtpWalkEvidenceResult {
  const parsed = OtpWalkEvidenceSchema.safeParse(value);
  if (!parsed.success)
    return { status: "unavailable", reason: "invalid_evidence" };
  const evidence = parsed.data;
  if (
    !matchesExecutedWalkPolicy(evidence.executedPolicy, expected) ||
    evidence.edges.some((edge) => !validPolicy(edge, expected.profile))
  )
    return { status: "unavailable", reason: "invalid_evidence" };
  if (
    !sameOtpWalkIdentity(
      {
        ...expected.identity,
        graphByteIdentity: evidence.graphByteIdentity,
        buildManifestIdentity: evidence.buildManifestIdentity,
      },
      expected.identity,
    )
  )
    return { status: "unavailable", reason: "identity_mismatch" };
  if (
    evidence.edgeOccurrenceCount !== evidence.edges.length ||
    evidence.selectedPath.occurrences.length !== evidence.edges.length ||
    evidence.nonStreetEdgeCount !==
      evidence.edges.filter((edge) => !streetKinds.has(edge.edgeKind)).length ||
    evidence.unknownMetadataEdgeCount !==
      evidence.edges.filter((edge) => edge.unknownReason !== null).length ||
    evidence.edges.some((edge) => !validMetadata(edge))
  )
    return { status: "unavailable", reason: "invalid_evidence" };
  if (
    evidence.edges.some((edge) =>
      edge.metadataStatus === "OSM_AREA"
        ? edge.areaSources.some(
            (area) => !sourceMatches(area, expected.identity),
          )
        : !sourceMatches(edge, expected.identity),
    )
  )
    return { status: "unavailable", reason: "source_mismatch" };
  if (
    !OtpWalkCoordinateSchema.safeParse(expected.origin).success ||
    !OtpWalkCoordinateSchema.safeParse(expected.destination).success ||
    !samePoint(evidence.selectedPath.requestFrom, expected.origin) ||
    !samePoint(evidence.selectedPath.requestTo, expected.destination)
  )
    return { status: "unavailable", reason: "request_mismatch" };
  if (
    evidence.edges.some(
      (edge) =>
        edge.pathway?.mode === "FARE_GATE" ||
        edge.pathway?.mode === "EXIT_GATE",
    )
  )
    return { status: "unavailable", reason: "fare_gate" };
  const geometryFailure = qualifyGeometry(evidence);
  if (geometryFailure !== null)
    return { status: "unavailable", reason: geometryFailure };
  const distanceM = evidence.edges.reduce(
    (sum, edge) => sum + edge.distanceM,
    0,
  );
  if (!Number.isFinite(distanceM) || distanceM < 0)
    return { status: "unavailable", reason: "invalid_evidence" };
  const geometrySegments = evidence.selectedPath.occurrences.map((occurrence) =>
    occurrence.coordinates.map((point): [number, number] => [
      point.lon,
      point.lat,
    ]),
  );
  return {
    status: "ready",
    evidence,
    distanceM,
    geometrySegments,
    polyline: geometrySegments.flat(),
  };
}
