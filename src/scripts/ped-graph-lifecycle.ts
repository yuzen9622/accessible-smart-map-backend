export const PED_GRAPH_LIFECYCLE_STATUSES = [
  "CANDIDATE",
  "ACTIVE",
  "RETIRED",
] as const;

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export type PedGraphLifecycleStatus =
  (typeof PED_GRAPH_LIFECYCLE_STATUSES)[number];

export interface GraphVersionCounts {
  directedEdgeCount: number;
  nodeCount: number;
}

export interface GraphIntegritySnapshot extends GraphVersionCounts {
  connectorEdgeCount: number;
  invalidEdgeBooleanCount: number;
  invalidEdgeLengthCount: number;
  invalidEdgeSlopeCount: number;
  invalidEdgeSmoothnessCount: number;
  invalidEdgeStairCount: number;
  invalidEdgeSurfaceCount: number;
  invalidEdgeTraversalTimeCount: number;
  invalidEdgeTypeCount: number;
  invalidEdgeWheelchairCount: number;
  invalidEdgeWidthCount: number;
  invalidNodeCoordinateCount: number;
  invalidNodeTypeCount: number;
  invalidStationRadiusCount: number;
  connectorNodeCount: number;
  crossVersionFromNodeCount: number;
  crossVersionToNodeCount: number;
  generatedConnectorEdgeLoaderMismatchCount: number;
  generatedConnectorEndpointMismatchCount: number;
  generatedConnectorNodeLoaderMismatchCount: number;
  generatedEdgeCount: number;
  /** Generated pathway and connector rows eligible for the CSR indoor flag. */
  loaderIndoorEdgeCount: number;
  generatedNodeCount: number;
  generatedPathwayEdgeLoaderMismatchCount: number;
  generatedPathwayEndpointMismatchCount: number;
  generatedStopNodeLoaderMismatchCount: number;
  indoorEdgeCount: number;
  indoorNodeCount: number;
  invalidGeneratedEdgeMetadataCount: number;
  invalidGeneratedNodeMetadataCount: number;
  missingEdgeSourceRefCount: number;
  missingFromNodeCount: number;
  missingNodeSourceRefCount: number;
  missingToNodeCount: number;
  outdoorEdgeCount: number;
  outdoorEdgeLoaderMismatchCount: number;
  outdoorNodeCount: number;
  outdoorNodeLoaderMismatchCount: number;
  routableOutdoorRealGeometryEdgeCount: number;
  routableOutdoorRealGeometryNodeCount: number;
  unknownGeneratedEdgeSourceCount: number;
  unknownGeneratedNodeSourceCount: number;
  unpairedBidirectionalSelfLoopCount: number;
}

export interface GraphVersionSnapshot extends GraphVersionCounts {
  id: number;
  indoorInjectionComplete: boolean;
  lifecycleStatus: PedGraphLifecycleStatus;
  notes: unknown;
  sourceHash: string;
}

export interface PromotionValidationInput {
  activeVersionIds: readonly number[];
  allowRetired: boolean;
  integrity: GraphIntegritySnapshot;
  target: GraphVersionSnapshot;
}

export interface PromotionDecision {
  activeVersionId: number;
  kind: "activate" | "already-active";
}

export class PedGraphPromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PedGraphPromotionError";
  }
}

/**
 * @param value Raw lifecycle status from PostgreSQL.
 * @returns A supported graph lifecycle status.
 */
export function parsePedGraphLifecycleStatus(
  value: unknown,
): PedGraphLifecycleStatus {
  if (
    typeof value === "string" &&
    PED_GRAPH_LIFECYCLE_STATUSES.includes(value as PedGraphLifecycleStatus)
  ) {
    return value as PedGraphLifecycleStatus;
  }
  throw new PedGraphPromotionError(
    "pedestrian graph lifecycle status is invalid",
  );
}

/**
 * @param value Version identifier or count to validate.
 * @param label Database field label.
 * @param minimum Lowest permitted value.
 * @returns Nothing.
 */
function requireSafeInteger(
  value: number,
  label: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new PedGraphPromotionError(
      `pedestrian graph ${label} is not a valid integer`,
    );
  }
}

/**
 * @param value Persisted graph-version notes value.
 * @returns The parsed notes object.
 */
function parseGraphNotes(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PedGraphPromotionError("pedestrian graph notes are missing");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new PedGraphPromotionError(
        "pedestrian graph notes are not an object",
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PedGraphPromotionError) {
      throw error;
    }
    throw new PedGraphPromotionError(
      "pedestrian graph notes are not valid JSON",
    );
  }
}

/**
 * @param notes Persisted generated-graph notes.
 * @param key Required count key.
 * @param expected Actual aggregate count.
 * @returns Nothing.
 */
function requireMatchingNoteCount(
  notes: Record<string, unknown>,
  key: string,
  expected: number,
): void {
  const value = notes[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value !== expected
  ) {
    throw new PedGraphPromotionError(
      `pedestrian graph notes ${key} does not match actual rows`,
    );
  }
}

/**
 * @param integrity Aggregate integrity facts queried for the target version.
 * @returns Nothing.
 */
function validateIntegrityCountTypes(integrity: GraphIntegritySnapshot): void {
  const counts: readonly (readonly [number, string])[] = [
    [integrity.nodeCount, "actual node_count"],
    [integrity.directedEdgeCount, "actual directed_edge_count"],
    [integrity.outdoorNodeCount, "outdoor node count"],
    [integrity.indoorNodeCount, "indoor node count"],
    [integrity.connectorNodeCount, "connector node count"],
    [integrity.generatedNodeCount, "generated node count"],
    [integrity.outdoorEdgeCount, "outdoor directed edge count"],
    [integrity.indoorEdgeCount, "indoor directed edge count"],
    [integrity.connectorEdgeCount, "connector edge count"],
    [integrity.generatedEdgeCount, "generated directed edge count"],
    [integrity.loaderIndoorEdgeCount, "loader indoor directed edge count"],
    [integrity.invalidNodeCoordinateCount, "invalid node coordinate count"],
    [integrity.invalidStationRadiusCount, "invalid station radius count"],
    [integrity.invalidNodeTypeCount, "invalid node type count"],
    [integrity.invalidEdgeLengthCount, "invalid edge length count"],
    [integrity.invalidEdgeSlopeCount, "invalid edge slope count"],
    [integrity.invalidEdgeWidthCount, "invalid edge width count"],
    [
      integrity.invalidEdgeTraversalTimeCount,
      "invalid edge traversal time count",
    ],
    [integrity.invalidEdgeStairCount, "invalid edge stair count"],
    [integrity.invalidEdgeTypeCount, "invalid edge type count"],
    [integrity.invalidEdgeSurfaceCount, "invalid edge surface count"],
    [integrity.invalidEdgeSmoothnessCount, "invalid edge smoothness count"],
    [integrity.invalidEdgeWheelchairCount, "invalid edge wheelchair count"],
    [integrity.invalidEdgeBooleanCount, "invalid edge boolean count"],
    [
      integrity.unpairedBidirectionalSelfLoopCount,
      "unpaired bidirectional self-loop count",
    ],
    [
      integrity.outdoorNodeLoaderMismatchCount,
      "outdoor node loader mismatch count",
    ],
    [
      integrity.outdoorEdgeLoaderMismatchCount,
      "outdoor edge loader mismatch count",
    ],
    [
      integrity.generatedStopNodeLoaderMismatchCount,
      "generated stop-node loader mismatch count",
    ],
    [
      integrity.generatedConnectorNodeLoaderMismatchCount,
      "generated connector-node loader mismatch count",
    ],
    [
      integrity.generatedPathwayEdgeLoaderMismatchCount,
      "generated pathway-edge loader mismatch count",
    ],
    [
      integrity.generatedConnectorEdgeLoaderMismatchCount,
      "generated connector-edge loader mismatch count",
    ],
    [
      integrity.generatedPathwayEndpointMismatchCount,
      "generated pathway endpoint mismatch count",
    ],
    [
      integrity.generatedConnectorEndpointMismatchCount,
      "generated connector endpoint mismatch count",
    ],
    [integrity.missingNodeSourceRefCount, "missing node source_ref count"],
    [integrity.missingEdgeSourceRefCount, "missing edge source_ref count"],
    [integrity.missingFromNodeCount, "missing from_node count"],
    [integrity.missingToNodeCount, "missing to_node count"],
    [integrity.crossVersionFromNodeCount, "cross-version from_node count"],
    [integrity.crossVersionToNodeCount, "cross-version to_node count"],
    [
      integrity.invalidGeneratedNodeMetadataCount,
      "invalid generated node metadata count",
    ],
    [
      integrity.invalidGeneratedEdgeMetadataCount,
      "invalid generated edge metadata count",
    ],
    [
      integrity.unknownGeneratedNodeSourceCount,
      "unknown generated node source count",
    ],
    [
      integrity.unknownGeneratedEdgeSourceCount,
      "unknown generated edge source count",
    ],
    [
      integrity.routableOutdoorRealGeometryNodeCount,
      "routable outdoor real-geometry node count",
    ],
    [
      integrity.routableOutdoorRealGeometryEdgeCount,
      "routable outdoor real-geometry edge count",
    ],
  ];
  for (const [value, label] of counts) {
    requireSafeInteger(value, label, 0);
  }
}

/**
 * @param value Aggregate corruption count that must be zero.
 * @param label Integrity invariant description.
 * @returns Nothing.
 */
function requireNoIntegrityFailures(value: number, label: string): void {
  if (value !== 0) {
    throw new PedGraphPromotionError(`pedestrian graph has ${label}`);
  }
}

/**
 * @param target Locked target version record.
 * @param integrity Bounded aggregate facts for the same target version.
 * @returns Nothing.
 */
function validateGraphIntegrity(
  target: GraphVersionSnapshot,
  integrity: GraphIntegritySnapshot,
): void {
  validateIntegrityCountTypes(integrity);
  if (!SHA256_HEX.test(target.sourceHash)) {
    throw new PedGraphPromotionError(
      "pedestrian graph source_hash is not a SHA-256 hex string",
    );
  }
  if (target.nodeCount !== integrity.nodeCount) {
    throw new PedGraphPromotionError(
      "pedestrian graph node_count does not match actual rows",
    );
  }
  if (target.directedEdgeCount !== integrity.directedEdgeCount) {
    throw new PedGraphPromotionError(
      "pedestrian graph directed_edge_count does not match actual rows",
    );
  }
  requireNoIntegrityFailures(
    integrity.invalidNodeCoordinateCount,
    "nodes with invalid proxy coordinates",
  );
  requireNoIntegrityFailures(
    integrity.invalidStationRadiusCount,
    "nodes with invalid station_radius_m",
  );
  requireNoIntegrityFailures(
    integrity.invalidNodeTypeCount,
    "nodes with invalid node_type",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeLengthCount,
    "edges with invalid length_m",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeSlopeCount,
    "edges with invalid slope_longitudinal",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeWidthCount,
    "edges with invalid effective_width_m",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeTraversalTimeCount,
    "edges with invalid traversal_time_s",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeStairCount,
    "edges with invalid stair_count",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeTypeCount,
    "edges with invalid edge_type",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeSurfaceCount,
    "edges with invalid surface",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeSmoothnessCount,
    "edges with invalid smoothness",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeWheelchairCount,
    "edges with invalid wheelchair",
  );
  requireNoIntegrityFailures(
    integrity.invalidEdgeBooleanCount,
    "edges with invalid boolean fields",
  );
  requireNoIntegrityFailures(
    integrity.unpairedBidirectionalSelfLoopCount,
    "unpaired bidirectional self-loop edges",
  );
  requireNoIntegrityFailures(
    integrity.missingNodeSourceRefCount,
    "nodes without source_ref",
  );
  requireNoIntegrityFailures(
    integrity.missingEdgeSourceRefCount,
    "edges without source_ref",
  );
  requireNoIntegrityFailures(
    integrity.missingFromNodeCount,
    "edges with missing from_node endpoints",
  );
  requireNoIntegrityFailures(
    integrity.missingToNodeCount,
    "edges with missing to_node endpoints",
  );
  requireNoIntegrityFailures(
    integrity.crossVersionFromNodeCount,
    "edges with cross-version from_node endpoints",
  );
  requireNoIntegrityFailures(
    integrity.crossVersionToNodeCount,
    "edges with cross-version to_node endpoints",
  );
  requireNoIntegrityFailures(
    integrity.unknownGeneratedNodeSourceCount,
    "nodes with unknown generated provenance",
  );
  requireNoIntegrityFailures(
    integrity.unknownGeneratedEdgeSourceCount,
    "edges with unknown generated provenance",
  );
  requireNoIntegrityFailures(
    integrity.invalidGeneratedNodeMetadataCount,
    "generated node metadata without GTFS provenance",
  );
  requireNoIntegrityFailures(
    integrity.invalidGeneratedEdgeMetadataCount,
    "generated edge metadata without GTFS provenance",
  );
  requireNoIntegrityFailures(
    integrity.outdoorNodeLoaderMismatchCount,
    "outdoor nodes with incompatible loader fields",
  );
  requireNoIntegrityFailures(
    integrity.outdoorEdgeLoaderMismatchCount,
    "outdoor edges with incompatible loader fields",
  );
  requireNoIntegrityFailures(
    integrity.generatedStopNodeLoaderMismatchCount,
    "generated stop nodes with incompatible loader fields",
  );
  requireNoIntegrityFailures(
    integrity.generatedConnectorNodeLoaderMismatchCount,
    "generated connector nodes with incompatible loader fields",
  );
  requireNoIntegrityFailures(
    integrity.generatedPathwayEdgeLoaderMismatchCount,
    "generated pathway edges with incompatible loader fields",
  );
  requireNoIntegrityFailures(
    integrity.generatedConnectorEdgeLoaderMismatchCount,
    "generated connector edges with incompatible loader fields",
  );
  requireNoIntegrityFailures(
    integrity.generatedPathwayEndpointMismatchCount,
    "generated pathway edges with incompatible endpoints",
  );
  requireNoIntegrityFailures(
    integrity.generatedConnectorEndpointMismatchCount,
    "generated connector edges with incompatible endpoints",
  );
  if (integrity.nodeCount === 0 || integrity.directedEdgeCount === 0) {
    throw new PedGraphPromotionError(
      "pedestrian graph must contain nodes and edges",
    );
  }
  if (integrity.loaderIndoorEdgeCount !== integrity.generatedEdgeCount) {
    throw new PedGraphPromotionError(
      "pedestrian graph generated edge provenance is incompatible with CSR indoor classification",
    );
  }
  if (
    integrity.generatedNodeCount === 0 ||
    integrity.generatedEdgeCount === 0 ||
    integrity.generatedNodeCount !==
      integrity.indoorNodeCount + integrity.connectorNodeCount ||
    integrity.generatedEdgeCount !==
      integrity.indoorEdgeCount + integrity.connectorEdgeCount ||
    integrity.nodeCount !==
      integrity.outdoorNodeCount + integrity.generatedNodeCount ||
    integrity.directedEdgeCount !==
      integrity.outdoorEdgeCount + integrity.generatedEdgeCount
  ) {
    throw new PedGraphPromotionError(
      "pedestrian graph generated counts are internally inconsistent",
    );
  }
  if (
    integrity.routableOutdoorRealGeometryNodeCount === 0 ||
    integrity.routableOutdoorRealGeometryEdgeCount === 0
  ) {
    throw new PedGraphPromotionError(
      "pedestrian graph has no routable outdoor real-geometry node and edge",
    );
  }

  const notes = parseGraphNotes(target.notes);
  for (const [key, expected] of [
    ["outdoor_node_count", integrity.outdoorNodeCount],
    ["indoor_node_count", integrity.indoorNodeCount],
    ["connector_node_count", integrity.connectorNodeCount],
    ["node_count", integrity.nodeCount],
    ["outdoor_directed_edge_count", integrity.outdoorEdgeCount],
    ["indoor_directed_edge_count", integrity.indoorEdgeCount],
    ["connector_edge_count", integrity.connectorEdgeCount],
    ["directed_edge_count", integrity.directedEdgeCount],
  ] as const) {
    requireMatchingNoteCount(notes, key, expected);
  }
}

/**
 * @param input Requested promotion state and independently queried integrity facts.
 * @returns The permitted transition, or throws before any lifecycle write.
 */
export function validatePromotion(
  input: PromotionValidationInput,
): PromotionDecision {
  const { activeVersionIds, allowRetired, integrity, target } = input;
  if (activeVersionIds.length !== 1) {
    throw new PedGraphPromotionError(
      "pedestrian graph requires exactly one active version",
    );
  }
  for (const activeVersionId of activeVersionIds) {
    requireSafeInteger(activeVersionId, "active version id", 1);
  }
  requireSafeInteger(target.id, "version id", 1);
  requireSafeInteger(target.nodeCount, "node_count", 0);
  requireSafeInteger(target.directedEdgeCount, "directed_edge_count", 0);
  if (!target.indoorInjectionComplete) {
    throw new PedGraphPromotionError(
      "pedestrian graph indoor injection is not complete",
    );
  }
  validateGraphIntegrity(target, integrity);

  const activeVersionId = activeVersionIds[0];
  if (target.lifecycleStatus === "ACTIVE") {
    if (target.id !== activeVersionId) {
      throw new PedGraphPromotionError(
        "pedestrian graph active target does not match the active version",
      );
    }
    return { kind: "already-active", activeVersionId };
  }
  if (target.lifecycleStatus === "CANDIDATE") {
    return { kind: "activate", activeVersionId };
  }
  if (target.lifecycleStatus === "RETIRED" && allowRetired) {
    return { kind: "activate", activeVersionId };
  }
  throw new PedGraphPromotionError(
    "retired graph versions require --allow-retired for explicit rollback",
  );
}
