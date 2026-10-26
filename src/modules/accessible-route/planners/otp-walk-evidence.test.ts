import { describe, expect, it } from "vitest";
import { OtpWalkIdentitySchema } from "../../../types/otp-walk-identity";
import {
  OtpWalkEvidenceSchema,
  type OtpWalkEvidence,
} from "../../../types/otp-walk-evidence";
import {
  parseOtpWalkEvidence,
  type OtpWalkEvidenceExpectations,
} from "./otp-walk-evidence";

// Exact partial_precision root + leg projection from the frozen B tiny HTTP run.
// The native 0.011 m endpoint gap is acceptable; its E5 display gap exceeds 0.25 m.
import { otpWalkNativeResponses } from "../../../../tests/fixtures/otp-walk-native";
const recorded = {
  requestIdentity: otpWalkNativeResponses.forward.data.requestIdentity,
  walkEvidence:
    otpWalkNativeResponses.forward.data.plan.itineraries[0].legs[0]
      .walkEvidence,
};

function fresh() {
  const evidence = OtpWalkEvidenceSchema.parse(recorded.walkEvidence);
  const expected: OtpWalkEvidenceExpectations = {
    identity: OtpWalkIdentitySchema.parse(recorded.requestIdentity),
    profile: "NORMAL",
    avoidStairs: true,
    origin: { lat: 25.0000001, lon: 121.0034567 },
    destination: { lat: 25.0000001, lon: 121.0154321 },
  };
  return { evidence, expected };
}

function unavailable(
  evidence: unknown,
  expected: OtpWalkEvidenceExpectations,
  reason?: string,
) {
  const result = parseOtpWalkEvidence(evidence, expected);
  expect(result.status).toBe("unavailable");
  if (reason) expect(result).toEqual({ status: "unavailable", reason });
}

describe("native direct WALK evidence", () => {
  it("replays the actual partial HTTP route with unknown fields and zero-distance NULL links preserved", () => {
    const { evidence, expected } = fresh();
    const result = parseOtpWalkEvidence(evidence, expected);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(result.evidence).toEqual(recorded.walkEvidence);
    expect(result.evidence.selectedPath.geometryCoverageStatus).toBe(
      "NATIVE_GEOMETRY_GAPS",
    );
    expect(
      result.evidence.selectedPath.requestFromToFirstGeometryGapM,
    ).toBeCloseTo(0.01111949);
    expect(result.geometrySegments).toHaveLength(5);
    expect(result.geometrySegments[0]).toEqual([]);
    expect(result.geometrySegments[4]).toEqual([]);
    expect(result.polyline).toEqual(
      evidence.selectedPath.occurrences.flatMap((part) =>
        part.coordinates.map((p) => [p.lon, p.lat]),
      ),
    );
    expect(result.polyline[0]).toEqual([121.0034567, 25]);
    expect(result.distanceM).toBeCloseTo(1206.848);
    expect(result.evidence.edges[1].knownWidthM).toBeNull();
    expect(result.evidence.edges[1].sourceRefs).toEqual([]);
    expect(result.evidence.edges[2].sourceRefs).toEqual(["fixture-0"]);
    expect(result.evidence.edges[0].unknownReason).toBe(
      "NON_STREET_METADATA_UNAVAILABLE",
    );
  });

  it.each([null, {}, { schemaVersion: "6" }])(
    "fails closed for incomplete projections: %j",
    (value) => {
      unavailable(value, fresh().expected, "invalid_evidence");
    },
  );

  it.each([
    [
      "schema",
      (e: OtpWalkEvidence) => Object.assign(e, { schemaVersion: "5" }),
    ],
    [
      "capture",
      (e: OtpWalkEvidence) =>
        Object.assign(e, { captureScope: "WHOLE_SEARCH" }),
    ],
    [
      "graph status",
      (e: OtpWalkEvidence) =>
        Object.assign(e, { graphIdentityStatus: "UNVERIFIED" }),
    ],
    [
      "source status",
      (e: OtpWalkEvidence) =>
        Object.assign(e, { sourceManifestIdentityStatus: "UNVERIFIED" }),
    ],
    [
      "runtime status",
      (e: OtpWalkEvidence) =>
        Object.assign(e, { runtimePolicyIdentityStatus: "UNVERIFIED" }),
    ],
    ["edge count", (e: OtpWalkEvidence) => e.edgeOccurrenceCount++],
    ["nonstreet count", (e: OtpWalkEvidence) => e.nonStreetEdgeCount++],
    ["unknown count", (e: OtpWalkEvidence) => e.unknownMetadataEdgeCount--],
    ["edge order", (e: OtpWalkEvidence) => e.edges.reverse()],
    [
      "occurrence order",
      (e: OtpWalkEvidence) => e.selectedPath.occurrences.reverse(),
    ],
    ["edge distance", (e: OtpWalkEvidence) => e.edges[1].distanceM++],
    [
      "geometry distance",
      (e: OtpWalkEvidence) => e.selectedPath.occurrences[1].distanceM++,
    ],
    ["partial flag", (e: OtpWalkEvidence) => (e.edges[1].partial = false)],
    ["kind", (e: OtpWalkEvidence) => (e.edges[1].edgeKind = "PathwayEdge")],
    [
      "metadata",
      (e: OtpWalkEvidence) => (e.edges[1].metadataStatus = "UNKNOWN"),
    ],
    [
      "missing unknown reason",
      (e: OtpWalkEvidence) => (e.edges[0].unknownReason = null),
    ],
    [
      "geometry origin",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.occurrences[1].geometrySource =
          "NATIVE_EDGE_GET_GEOMETRY"),
    ],
  ])("rejects contradictory %s", (_name, mutate) => {
    const { evidence, expected } = fresh();
    mutate(evidence);
    unavailable(evidence, expected, "invalid_evidence");
  });

  it.each([
    [
      "loaded graph",
      (e: OtpWalkEvidence) => (e.graphByteIdentity.sha256 = "a".repeat(64)),
    ],
    [
      "build manifest",
      (e: OtpWalkEvidence) =>
        (e.buildManifestIdentity.manifestSha256 = "a".repeat(64)),
    ],
    [
      "build artifact",
      (e: OtpWalkEvidence) =>
        (e.buildManifestIdentity.compilerArtifacts[0].sha256 = "a".repeat(64)),
    ],
    [
      "graph byte count",
      (e: OtpWalkEvidence) => e.graphByteIdentity.byteCount++,
    ],
  ])("rejects a late or mixed %s identity", (_name, mutate) => {
    const { evidence, expected } = fresh();
    mutate(evidence);
    unavailable(evidence, expected, "identity_mismatch");
  });

  it.each([
    ["version", (e: OtpWalkEvidence) => (e.edges[2].sourceVersion = "later")],
    ["batch", (e: OtpWalkEvidence) => (e.edges[2].sourceBatch = "later")],
    [
      "archive",
      (e: OtpWalkEvidence) => (e.edges[2].sourceSha256 = "a".repeat(64)),
    ],
    ["missing batch", (e: OtpWalkEvidence) => (e.edges[2].sourceBatch = null)],
    [
      "duplicate geometry source",
      (e: OtpWalkEvidence) => e.edges[2].sourceRefs.push("fixture-0"),
    ],
    [
      "duplicate width source",
      (e: OtpWalkEvidence) => e.edges[2].widthSourceRefs.push("fixture-0"),
    ],
    [
      "unknown width promoted",
      (e: OtpWalkEvidence) => {
        e.edges[1].sourceRefs = ["fixture-0"];
        e.edges[1].widthSourceRefs = ["fixture-0"];
        e.edges[1].sourceVersion = "fixture";
        e.edges[1].sourceBatch = "fixture";
        e.edges[1].sourceSha256 = "f".repeat(64);
      },
    ],
  ])("rejects inconsistent government %s", (_name, mutate) => {
    const { evidence, expected } = fresh();
    mutate(evidence);
    unavailable(evidence, expected, "source_mismatch");
  });

  it.each([{ sourceRefs: ["wide"] }, { sourceRefs: [] }])(
    "preserves independent current-source width witnesses with geometry refs %j",
    ({ sourceRefs }) => {
      const { evidence, expected } = fresh();
      Object.assign(evidence.edges[2], {
        sourceRefs,
        widthSourceRefs: ["narrow", "wide"],
        knownWidthM: 0.4,
      });
      evidence.edges[2].policyEvaluation.knownWidthM = 0.4;
      const result = parseOtpWalkEvidence(evidence, expected);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error(JSON.stringify(result));
      expect(result.evidence.edges[2].sourceRefs).toEqual(sourceRefs);
      expect(result.evidence.edges[2].widthSourceRefs).toEqual([
        "narrow",
        "wide",
      ]);
      expect(result.evidence.edges[2].knownWidthM).toBe(0.4);
    },
  );

  it.each([
    { sourceVersion: null },
    { sourceBatch: null },
    { sourceSha256: null },
    { sourceVersion: "later" },
    { sourceBatch: "later" },
    { sourceSha256: "a".repeat(64) },
    { sourceVersion: null, sourceBatch: null, sourceSha256: null },
    { knownWidthM: null },
  ])(
    "requires complete current attribution for width-only evidence: %j",
    (change) => {
      const { evidence, expected } = fresh();
      Object.assign(evidence.edges[2], { sourceRefs: [] }, change);
      evidence.edges[2].policyEvaluation.knownWidthM =
        evidence.edges[2].knownWidthM;
      unavailable(evidence, expected, "source_mismatch");
    },
  );

  it("rejects overflowing aggregate distances even when every occurrence distance is finite", () => {
    const { evidence, expected } = fresh();
    for (const occurrence of evidence.selectedPath.occurrences) {
      if (occurrence.geometryStatus !== "PRESENT") continue;
      occurrence.distanceM = 1e308;
      evidence.edges[occurrence.occurrenceIndex].distanceM = 1e308;
    }
    unavailable(evidence, expected, "invalid_evidence");
  });

  it("retains finite aggregate distances without imposing a route distance cap", () => {
    const { evidence, expected } = fresh();
    evidence.edges[2].distanceM = 1e100;
    evidence.selectedPath.occurrences[2].distanceM = 1e100;
    const result = parseOtpWalkEvidence(evidence, expected);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(result.distanceM).toBe(1e100);
  });

  it.each([NaN, Infinity, -1])(
    "rejects invalid occurrence distance %s",
    (distanceM) => {
      const { evidence, expected } = fresh();
      evidence.edges[2].distanceM = distanceM;
      evidence.selectedPath.occurrences[2].distanceM = distanceM;
      unavailable(evidence, expected, "invalid_evidence");
    },
  );

  it("compares request metadata with the actual caller rather than trusting returned endpoints", () => {
    const { evidence, expected } = fresh();
    expected.origin.lon += 0.000001;
    unavailable(evidence, expected, "request_mismatch");
    expected.origin.lon = NaN;
    unavailable(evidence, expected, "request_mismatch");
  });

  it.each([
    [
      "length",
      (e: OtpWalkEvidence) => e.selectedPath.representedGeometryLengthM++,
    ],
    [
      "per-edge length",
      (e: OtpWalkEvidence) => e.selectedPath.occurrences[2].geometryLengthM++,
    ],
    [
      "reported gap",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.requestFromToFirstGeometryGapM = 0),
    ],
    [
      "vertex gap",
      (e: OtpWalkEvidence) => (e.selectedPath.occurrences[2].vertexGapM = 0),
    ],
    [
      "missing count",
      (e: OtpWalkEvidence) => (e.selectedPath.missingGeometryCount = 0),
    ],
    [
      "positive missing count",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.positiveDistanceMissingGeometryCount = 1),
    ],
    [
      "coverage",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.geometryCoverageStatus = "NATIVE_GEOMETRY_COMPLETE"),
    ],
    [
      "native coordinate",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.occurrences[1].coordinates[0].lon += 0.00001),
    ],
    [
      "first geometry",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.firstGeometryPoint = e.selectedPath.lastGeometryPoint),
    ],
    [
      "empty status",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.occurrences[1].geometryStatus = "EMPTY"),
    ],
    [
      "state chain",
      (e: OtpWalkEvidence) =>
        (e.selectedPath.occurrences[2].traversalFrom =
          e.selectedPath.occurrences[2].traversalTo),
    ],
  ])(
    "recomputes %s rather than trusting claimed measurements",
    (_name, mutate) => {
      const { evidence, expected } = fresh();
      mutate(evidence);
      unavailable(evidence, expected, "geometry_mismatch");
    },
  );

  it("rejects genuine offstreet endpoints even when all reported endpoint gaps agree", () => {
    const { evidence, expected } = fresh();
    expected.origin.lat = 25.0001;
    evidence.selectedPath.requestFrom = expected.origin;
    const metres = (6371000 * (expected.origin.lat - 25) * Math.PI) / 180;
    evidence.selectedPath.requestFromToStartStateGapM =
      (6371000 * (expected.origin.lat - 25.0000001) * Math.PI) / 180;
    evidence.selectedPath.requestFromToFirstGeometryGapM = metres;
    unavailable(evidence, expected, "geometry_gap");
  });

  it.each([0.249, 0.251])(
    "applies the existing 0.25 metre endpoint allowance to %s metres",
    (metres) => {
      const { evidence, expected } = fresh();
      expected.origin.lat = 25 + ((metres / 6371000) * 180) / Math.PI;
      evidence.selectedPath.requestFrom = expected.origin;
      evidence.selectedPath.requestFromToStartStateGapM =
        (6371000 * (expected.origin.lat - 25.0000001) * Math.PI) / 180;
      evidence.selectedPath.requestFromToFirstGeometryGapM = metres;
      expect(parseOtpWalkEvidence(evidence, expected).status).toBe(
        metres < 0.25 ? "ready" : "unavailable",
      );
    },
  );

  it("rejects a zero-distance elevator hop across different coordinates without creating a chord", () => {
    const { evidence, expected } = fresh();
    const original = evidence.selectedPath.occurrences[2];
    const replacement = structuredClone(evidence.selectedPath.occurrences[0]);
    Object.assign(replacement, {
      occurrenceIndex: 2,
      edgeKind: "ElevatorHopEdge",
      traversalFrom: original.traversalFrom,
      traversalTo: original.traversalTo,
      vertexGapM: original.vertexGapM,
    });
    evidence.selectedPath.occurrences[2] = replacement;
    evidence.edges[2] = {
      ...structuredClone(evidence.edges[0]),
      occurrenceIndex: 2,
      edgeKind: "ElevatorHopEdge",
    };
    evidence.edges[2].policyEvaluation.stairs = false;
    evidence.edges[2].policyEvaluation.escalator = false;
    evidence.selectedPath.occurrences[3].gapFromPreviousGeometryM =
      original.vertexGapM;
    evidence.selectedPath.representedGeometryLengthM -=
      original.geometryLengthM;
    evidence.selectedPath.missingGeometryCount++;
    evidence.nonStreetEdgeCount++;
    evidence.unknownMetadataEdgeCount++;
    unavailable(evidence, expected, "geometry_gap");
  });

  it("rejects a missing positive-length interior street even with internally updated gap measurements", () => {
    const { evidence, expected } = fresh();
    const part = evidence.selectedPath.occurrences[2];
    evidence.selectedPath.representedGeometryLengthM -= part.geometryLengthM;
    evidence.selectedPath.occurrences[3].gapFromPreviousGeometryM =
      part.vertexGapM;
    Object.assign(part, {
      geometryStatus: "NULL",
      coordinates: [],
      geometryStartToTraversalFromGapM: null,
      geometryEndToTraversalToGapM: null,
      gapFromPreviousGeometryM: null,
      geometryLengthM: 0,
    });
    evidence.selectedPath.missingGeometryCount++;
    evidence.selectedPath.positiveDistanceMissingGeometryCount++;
    unavailable(evidence, expected, "incomplete_geometry");
  });

  it("retains per-area sources and rejects a mismatching contributor instead of choosing one parent", () => {
    const { evidence, expected } = fresh();
    const edge = evidence.edges[2];
    edge.sourceRefs = ["wide"];
    edge.widthSourceRefs = ["narrow", "wide"];
    edge.knownWidthM = 0.4;
    edge.policyEvaluation.knownWidthM = 0.4;
    edge.areaSources = [
      {
        osmId: "way/100",
        stairs: false,
        knownSmoothness: null,
        wheelchairAccessible: true,
        knownWidthM: edge.knownWidthM,
        sourceRefs: [...edge.sourceRefs],
        widthSourceRefs: [...edge.widthSourceRefs],
        sourceBatch: edge.sourceBatch,
        sourceVersion: edge.sourceVersion,
        sourceSha256: edge.sourceSha256,
      },
      {
        osmId: "relation/101",
        stairs: false,
        knownSmoothness: null,
        wheelchairAccessible: true,
        knownWidthM: null,
        sourceRefs: [],
        widthSourceRefs: [],
        sourceBatch: null,
        sourceVersion: null,
        sourceSha256: null,
      },
    ];
    Object.assign(edge, {
      metadataStatus: "OSM_AREA",
      osmWayId: null,
      sourceSegmentIndex: null,
      sourceBatch: null,
      sourceVersion: null,
      sourceSha256: null,
    });
    const result = parseOtpWalkEvidence(evidence, expected);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(result.evidence.edges[2].areaSources[1].knownWidthM).toBeNull();
    edge.areaSources[0].stairs = true;
    unavailable(evidence, expected, "invalid_evidence");
    edge.areaSources[0].stairs = false;
    edge.areaSources[0].wheelchairAccessible = false;
    unavailable(evidence, expected, "invalid_evidence");
    edge.areaSources[0].wheelchairAccessible = true;
    edge.areaSources[0].knownSmoothness = "impassable";
    unavailable(evidence, expected, "invalid_evidence");
    edge.areaSources[0].knownSmoothness = null;

    edge.areaSources[0].sourceVersion = "late";
    unavailable(evidence, expected, "source_mismatch");
    edge.areaSources[0].sourceVersion = "fixture";
    edge.sourceRefs.push("unrepresented-parent");
    unavailable(evidence, expected, "invalid_evidence");
  });

  it("rejects positive-distance edges without geometry even with consistent counts", () => {
    const { evidence, expected } = fresh();
    evidence.edges[0].distanceM = 1;
    evidence.selectedPath.occurrences[0].distanceM = 1;
    evidence.selectedPath.positiveDistanceMissingGeometryCount = 1;
    unavailable(evidence, expected, "incomplete_geometry");
  });

  it("retains repeated native occurrences without deduplicating their provenance or boundaries", () => {
    const { evidence, expected } = fresh();
    evidence.edges.unshift(structuredClone(evidence.edges[0]));
    evidence.selectedPath.occurrences.unshift(
      structuredClone(evidence.selectedPath.occurrences[0]),
    );
    evidence.selectedPath.occurrences[0].traversalTo =
      evidence.selectedPath.occurrences[0].traversalFrom;
    evidence.selectedPath.occurrences[0].vertexGapM = 0;
    evidence.edges.forEach((edge, index) => (edge.occurrenceIndex = index));
    evidence.selectedPath.occurrences.forEach(
      (part, index) => (part.occurrenceIndex = index),
    );
    evidence.edgeOccurrenceCount++;
    evidence.nonStreetEdgeCount++;
    evidence.unknownMetadataEdgeCount++;
    evidence.selectedPath.missingGeometryCount++;
    const result = parseOtpWalkEvidence(evidence, expected);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(result.evidence.edges).toHaveLength(6);
    expect(result.geometrySegments).toHaveLength(6);
    expect(result.geometrySegments.slice(0, 2)).toEqual([[], []]);
  });

  it.each(["startsSearchPath", "endsSearchPath"])(
    "requires the direct WALK %s endpoint",
    (field) => {
      const { evidence, expected } = fresh();
      Object.assign(evidence.selectedPath, { [field]: false });
      unavailable(evidence, expected, "incomplete_geometry");
    },
  );

  it("rejects an unresolved traversal even when its native count and coverage agree", () => {
    const { evidence, expected } = fresh();
    evidence.selectedPath.occurrences[1].traversalDirection = "UNRESOLVED";
    evidence.selectedPath.stateChainMismatchCount = 1;
    evidence.selectedPath.geometryCoverageStatus = "UNRESOLVED_STATE_CHAIN";
    unavailable(evidence, expected, "incomplete_geometry");
  });

  it.each(["FARE_GATE", "EXIT_GATE"])(
    "rejects known %s under the verified runtime policy",
    (mode) => {
      const { evidence, expected } = fresh();
      Object.assign(evidence.edges[2], {
        edgeKind: "PathwayEdge",
        metadataStatus: "GTFS_PATHWAY",
        osmWayId: null,
        sourceSegmentIndex: null,
        reverse: null,
        sourceRefs: [],
        widthSourceRefs: [],
        sourceBatch: null,
        sourceVersion: null,
        sourceSha256: null,
        knownWidthM: null,
        policyEvaluation: {
          captureSchemaVersion: null,
          stairs: false,
          escalator: false,
          nativeWheelchairAccessible: null,
          knownMaxSlopeRatio: null,
          knownWidthM: null,
          knownSmoothness: null,
          assistedStairs: false,
        },
        pathway: {
          pathwayId: "1:gate",
          sourceFromStopId: "1:a",
          sourceToStopId: "1:b",
          mode,
          knownMinWidthM: null,
          knownSlopeRatio: null,
          knownWheelchairAccessible: null,
        },
      });
      evidence.nonStreetEdgeCount++;
      Object.assign(evidence.selectedPath.occurrences[2], {
        edgeKind: "PathwayEdge",
        geometrySource: "NATIVE_PATHWAY_ENDPOINT_LINE",
      });
      unavailable(evidence, expected, "fare_gate");
    },
  );
  it.each(["stairs", "escalator", "nativeWheelchairAccessible"])(
    "rejects a missing mandatory native street %s observation",
    (field) => {
      const { evidence, expected } = fresh();
      Object.assign(evidence.edges[1].policyEvaluation, { [field]: null });
      unavailable(evidence, expected, "invalid_evidence");
    },
  );

  it.each([
    "PathwayEdge",
    "EscalatorEdge",
    "ElevatorHopEdge",
    "StreetTransitStopLink",
    "StreetTransitEntranceLink",
  ])(
    "rejects missing concrete %s flags even without source metadata",
    (edgeKind) => {
      const { evidence, expected } = fresh();
      evidence.edges[0].edgeKind = edgeKind;
      evidence.selectedPath.occurrences[0].edgeKind = edgeKind;
      if (edgeKind === "PathwayEdge")
        evidence.selectedPath.occurrences[0].geometrySource =
          "NATIVE_PATHWAY_ENDPOINT_LINE";
      unavailable(evidence, expected, "invalid_evidence");
    },
  );
  it("does not invent known observations on a generic native free edge", () => {
    const { evidence, expected } = fresh();
    evidence.edges[0].policyEvaluation.knownMaxSlopeRatio = 0;
    unavailable(evidence, expected, "invalid_evidence");
  });
});
