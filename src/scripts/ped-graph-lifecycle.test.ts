import { describe, expect, it } from "vitest";
import {
  PedGraphPromotionError,
  validatePromotion,
  type GraphIntegritySnapshot,
  type GraphVersionSnapshot,
  type PromotionValidationInput,
} from "./ped-graph-lifecycle";

const VALID_SOURCE_HASH = "a".repeat(64);

interface ValidationOverrides {
  activeVersionIds?: readonly number[];
  allowRetired?: boolean;
  integrity?: Partial<GraphIntegritySnapshot>;
  target?: Partial<GraphVersionSnapshot>;
}

function validIntegrity(): GraphIntegritySnapshot {
  return {
    nodeCount: 4,
    directedEdgeCount: 3,
    invalidNodeCoordinateCount: 0,
    invalidStationRadiusCount: 0,
    invalidNodeTypeCount: 0,
    invalidEdgeLengthCount: 0,
    invalidEdgeSlopeCount: 0,
    invalidEdgeWidthCount: 0,
    invalidEdgeTraversalTimeCount: 0,
    invalidEdgeStairCount: 0,
    invalidEdgeTypeCount: 0,
    invalidEdgeSurfaceCount: 0,
    invalidEdgeSmoothnessCount: 0,
    invalidEdgeWheelchairCount: 0,
    invalidEdgeBooleanCount: 0,
    unpairedBidirectionalSelfLoopCount: 0,
    outdoorNodeCount: 2,
    indoorNodeCount: 1,
    connectorNodeCount: 1,
    generatedNodeCount: 2,
    outdoorEdgeCount: 1,
    indoorEdgeCount: 1,
    connectorEdgeCount: 1,
    generatedEdgeCount: 2,
    loaderIndoorEdgeCount: 2,
    missingNodeSourceRefCount: 0,
    missingEdgeSourceRefCount: 0,
    missingFromNodeCount: 0,
    missingToNodeCount: 0,
    crossVersionFromNodeCount: 0,
    crossVersionToNodeCount: 0,
    generatedStopNodeLoaderMismatchCount: 0,
    generatedConnectorNodeLoaderMismatchCount: 0,
    generatedPathwayEdgeLoaderMismatchCount: 0,
    generatedConnectorEdgeLoaderMismatchCount: 0,
    generatedPathwayEndpointMismatchCount: 0,
    generatedConnectorEndpointMismatchCount: 0,
    outdoorNodeLoaderMismatchCount: 0,
    outdoorEdgeLoaderMismatchCount: 0,
    invalidGeneratedNodeMetadataCount: 0,
    invalidGeneratedEdgeMetadataCount: 0,
    unknownGeneratedNodeSourceCount: 0,
    unknownGeneratedEdgeSourceCount: 0,
    routableOutdoorRealGeometryNodeCount: 2,
    routableOutdoorRealGeometryEdgeCount: 1,
  };
}

function validNotes(integrity: GraphIntegritySnapshot): string {
  return JSON.stringify({
    outdoor_node_count: integrity.outdoorNodeCount,
    indoor_node_count: integrity.indoorNodeCount,
    connector_node_count: integrity.connectorNodeCount,
    node_count: integrity.nodeCount,
    outdoor_directed_edge_count: integrity.outdoorEdgeCount,
    indoor_directed_edge_count: integrity.indoorEdgeCount,
    connector_edge_count: integrity.connectorEdgeCount,
    directed_edge_count: integrity.directedEdgeCount,
  });
}

function candidateInput(
  overrides: ValidationOverrides = {},
): PromotionValidationInput {
  const integrity = { ...validIntegrity(), ...overrides.integrity };
  return {
    activeVersionIds: overrides.activeVersionIds ?? [1],
    target: {
      id: 2,
      lifecycleStatus: "CANDIDATE",
      nodeCount: 4,
      directedEdgeCount: 3,
      indoorInjectionComplete: true,
      sourceHash: VALID_SOURCE_HASH,
      notes: validNotes(integrity),
      ...overrides.target,
    },
    integrity,
    allowRetired: overrides.allowRetired ?? false,
  };
}

describe("validatePromotion", () => {
  it("allows a complete candidate whose stored counts match actual rows", () => {
    expect(validatePromotion(candidateInput())).toEqual({
      kind: "activate",
      activeVersionId: 1,
    });
  });

  it("allows an already-active target only as an idempotent no-op", () => {
    expect(
      validatePromotion(
        candidateInput({
          target: { id: 1, lifecycleStatus: "ACTIVE" },
        }),
      ),
    ).toEqual({ kind: "already-active", activeVersionId: 1 });
  });

  it("fails closed when the active-version invariant is absent or corrupted", () => {
    for (const activeVersionIds of [[], [1, 3]]) {
      expect(() =>
        validatePromotion(candidateInput({ activeVersionIds })),
      ).toThrow(PedGraphPromotionError);
    }
  });

  it("rejects incomplete candidates and mismatched stored counts", () => {
    expect(() =>
      validatePromotion(
        candidateInput({ target: { indoorInjectionComplete: false } }),
      ),
    ).toThrow("indoor injection is not complete");
    expect(() =>
      validatePromotion(candidateInput({ integrity: { nodeCount: 3 } })),
    ).toThrow("node_count does not match");
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { directedEdgeCount: 2 } }),
      ),
    ).toThrow("directed_edge_count does not match");
  });

  it("rejects matching-count candidates with corrupt topology or provenance", () => {
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { crossVersionToNodeCount: 1 } }),
      ),
    ).toThrow("cross-version to_node");
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { missingEdgeSourceRefCount: 1 } }),
      ),
    ).toThrow("edges without source_ref");
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { loaderIndoorEdgeCount: 1 } }),
      ),
    ).toThrow(
      "generated edge provenance is incompatible with CSR indoor classification",
    );
    expect(() =>
      validatePromotion(
        candidateInput({
          integrity: { invalidGeneratedNodeMetadataCount: 1 },
        }),
      ),
    ).toThrow("generated node metadata");
    expect(() =>
      validatePromotion(
        candidateInput({
          integrity: { generatedPathwayEdgeLoaderMismatchCount: 1 },
        }),
      ),
    ).toThrow("generated pathway edges with incompatible loader fields");
    // All GTFS fare and exit gates are generated pathway edges. A blank or
    // mismatched parent-station identity increments this count, so it cannot
    // become ACTIVE even if all aggregate node/edge counts still match.
    expect(() =>
      validatePromotion(
        candidateInput({
          integrity: { generatedPathwayEndpointMismatchCount: 1 },
        }),
      ),
    ).toThrow("generated pathway edges with incompatible endpoints");
    expect(() =>
      validatePromotion(
        candidateInput({
          integrity: { generatedConnectorEndpointMismatchCount: 1 },
        }),
      ),
    ).toThrow("generated connector edges with incompatible endpoints");
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { outdoorNodeLoaderMismatchCount: 1 } }),
      ),
    ).toThrow("outdoor nodes with incompatible loader fields");
  });

  it("rejects matching-count candidates with loader-invalid numeric values", () => {
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { invalidEdgeStairCount: 1 } }),
      ),
    ).toThrow("edges with invalid stair_count");
    expect(() =>
      validatePromotion(
        candidateInput({ integrity: { invalidStationRadiusCount: 1 } }),
      ),
    ).toThrow("nodes with invalid station_radius_m");
  });

  it("requires a SHA-256 source hash, internally consistent notes, and outdoor geometry", () => {
    expect(
      validatePromotion(
        candidateInput({ target: { sourceHash: "A".repeat(64) } }),
      ),
    ).toEqual({ kind: "activate", activeVersionId: 1 });
    expect(() =>
      validatePromotion(
        candidateInput({ target: { sourceHash: "not-a-hash" } }),
      ),
    ).toThrow("source_hash is not a SHA-256");
    expect(() =>
      validatePromotion(candidateInput({ target: { notes: "{}" } })),
    ).toThrow("notes outdoor_node_count does not match");
    expect(() =>
      validatePromotion(
        candidateInput({
          integrity: { routableOutdoorRealGeometryEdgeCount: 0 },
        }),
      ),
    ).toThrow("no routable outdoor real-geometry");
  });

  it("requires explicit opt-in before a complete retired version can roll back", () => {
    const retired = {
      target: { lifecycleStatus: "RETIRED" as const },
    };

    expect(() => validatePromotion(candidateInput(retired))).toThrow(
      "--allow-retired",
    );
    expect(
      validatePromotion(candidateInput({ ...retired, allowRetired: true })),
    ).toEqual({ kind: "activate", activeVersionId: 1 });
  });
});
