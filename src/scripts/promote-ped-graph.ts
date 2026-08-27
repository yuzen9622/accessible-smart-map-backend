import { Client } from "pg";
import {
  parsePedGraphLifecycleStatus,
  validatePromotion,
  type GraphIntegritySnapshot,
  type GraphVersionSnapshot,
} from "./ped-graph-lifecycle";

const PROMOTION_ADVISORY_LOCK = 7_346_219_941;

const GRAPH_CHILD_TABLE_LOCK_QUERY = `
  LOCK TABLE ped_node, ped_edge IN SHARE MODE
`;

const LIFECYCLE_ROWS_QUERY = `
  SELECT
    id,
    lifecycle_status,
    node_count,
    directed_edge_count,
    indoor_injection_complete,
    source_hash,
    notes
  FROM ped_graph_version
  WHERE id = $1 OR lifecycle_status = 'ACTIVE'
  ORDER BY id ASC
  FOR UPDATE
`;

const PROMOTION_INTEGRITY_QUERY = `
  WITH target_version AS (
    SELECT id
    FROM ped_graph_version
    WHERE id = $1
  ),
  node_integrity AS (
    SELECT
      count(*) AS actual_node_count,
      count(*) FILTER (
        WHERE node.proxy_geom IS NULL
          OR ST_X(node.proxy_geom) IS NULL
          OR ST_Y(node.proxy_geom) IS NULL
          OR ST_X(node.proxy_geom) < -180
          OR ST_X(node.proxy_geom) > 180
          OR ST_Y(node.proxy_geom) < -90
          OR ST_Y(node.proxy_geom) > 90
          OR ST_X(node.proxy_geom) IN (
            'NaN'::double precision,
            'Infinity'::double precision,
            '-Infinity'::double precision
          )
          OR ST_Y(node.proxy_geom) IN (
            'NaN'::double precision,
            'Infinity'::double precision,
            '-Infinity'::double precision
          )
      ) AS invalid_node_coordinate_count,
      count(*) FILTER (
        WHERE node.station_radius_m IS NOT NULL
          AND (
            node.station_radius_m < 0
            OR node.station_radius_m IN (
              'NaN'::real,
              'Infinity'::real,
              '-Infinity'::real
            )
          )
      ) AS invalid_station_radius_count,
      count(*) FILTER (
        WHERE node.node_type IS NOT NULL
          AND node.node_type NOT IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 255)
      ) AS invalid_node_type_count,
      count(*) FILTER (
        WHERE node.source_ref IS NULL OR btrim(node.source_ref) = ''
      ) AS missing_node_source_ref_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:')
      ) AS generated_node_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:stop:')
      ) AS indoor_node_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:connector:')
      ) AS connector_node_count,
      count(*) FILTER (
        WHERE NOT starts_with(COALESCE(node.source_ref, ''), 'gtfs_pathways:')
      ) AS outdoor_node_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:')
          AND NOT starts_with(node.source_ref, 'gtfs_pathways:stop:')
          AND NOT starts_with(node.source_ref, 'gtfs_pathways:connector:')
      ) AS unknown_generated_node_source_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:')
          AND (
            node.attr_meta IS NULL
            OR jsonb_typeof(node.attr_meta) <> 'object'
            OR node.attr_meta = '{}'::jsonb
            OR EXISTS (
              SELECT 1
              FROM jsonb_each(
                CASE
                  WHEN jsonb_typeof(node.attr_meta) = 'object'
                    THEN node.attr_meta
                  ELSE '{}'::jsonb
                END
              ) AS attribute
              WHERE COALESCE(attribute.value ->> 'source', '') <> 'gtfs_pathways'
            )
          )
      ) AS invalid_generated_node_metadata_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:stop:')
          AND (
            node.node_type IS NULL
            OR node.node_type NOT IN (7, 8, 9, 10, 11, 255)
            OR node.station_id IS NULL
            OR btrim(node.station_id) = ''
            OR (node.node_type = 11 AND node.geom IS NULL)
            OR (node.node_type <> 11 AND node.geom IS NOT NULL)
          )
      ) AS generated_stop_node_loader_mismatch_count,
      count(*) FILTER (
        WHERE starts_with(node.source_ref, 'gtfs_pathways:connector:')
          AND (
            node.node_type IS DISTINCT FROM 12
            OR node.station_id IS NULL
            OR btrim(node.station_id) = ''
            OR node.geom IS NULL
          )
      ) AS generated_connector_node_loader_mismatch_count,
      count(*) FILTER (
        WHERE NOT starts_with(COALESCE(node.source_ref, ''), 'gtfs_pathways:')
          AND (
            node.geom IS NULL
            OR node.station_id IS NOT NULL
            OR node.node_type BETWEEN 7 AND 12
          )
      ) AS outdoor_node_loader_mismatch_count,
      count(*) FILTER (
        WHERE NOT starts_with(COALESCE(node.source_ref, ''), 'gtfs_pathways:')
          AND node.geom IS NOT NULL
      ) AS routable_outdoor_real_geometry_node_count
    FROM ped_node AS node
    INNER JOIN target_version ON target_version.id = node.version_id
  ),
  edge_integrity AS (
    SELECT
      count(*) AS actual_directed_edge_count,
      count(*) FILTER (
        WHERE edge.length_m IS NOT NULL
          AND (
            edge.length_m < 0
            OR edge.length_m IN ('NaN'::real, 'Infinity'::real, '-Infinity'::real)
          )
      ) AS invalid_edge_length_count,
      count(*) FILTER (
        WHERE edge.slope_longitudinal IS NOT NULL
          AND edge.slope_longitudinal IN (
            'NaN'::real,
            'Infinity'::real,
            '-Infinity'::real
          )
      ) AS invalid_edge_slope_count,
      count(*) FILTER (
        WHERE edge.effective_width_m IS NOT NULL
          AND (
            edge.effective_width_m < 0
            OR edge.effective_width_m IN (
              'NaN'::real,
              'Infinity'::real,
              '-Infinity'::real
            )
          )
      ) AS invalid_edge_width_count,
      count(*) FILTER (
        WHERE edge.traversal_time_s IS NOT NULL
          AND (
            edge.traversal_time_s < 0
            OR edge.traversal_time_s IN (
              'NaN'::real,
              'Infinity'::real,
              '-Infinity'::real
            )
          )
      ) AS invalid_edge_traversal_time_count,
      count(*) FILTER (
        WHERE edge.stair_count IS NOT NULL
          AND (edge.stair_count < 0 OR edge.stair_count > 65535)
      ) AS invalid_edge_stair_count,
      count(*) FILTER (
        WHERE edge.edge_type IS NOT NULL
          AND edge.edge_type NOT IN (
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
            16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 255
          )
      ) AS invalid_edge_type_count,
      count(*) FILTER (
        WHERE edge.surface IS NOT NULL
          AND NOT (edge.surface BETWEEN 0 AND 39 OR edge.surface = 255)
      ) AS invalid_edge_surface_count,
      count(*) FILTER (
        WHERE edge.smoothness IS NOT NULL
          AND NOT (edge.smoothness BETWEEN 0 AND 8 OR edge.smoothness = 255)
      ) AS invalid_edge_smoothness_count,
      count(*) FILTER (
        WHERE edge.wheelchair IS NOT NULL
          AND NOT (edge.wheelchair BETWEEN 0 AND 4 OR edge.wheelchair = 255)
      ) AS invalid_edge_wheelchair_count,
      count(*) FILTER (
        WHERE edge.has_ramp IS NULL OR edge.is_bidirectional IS NULL
      ) AS invalid_edge_boolean_count,
      (
        count(*) FILTER (
          WHERE edge.is_bidirectional IS TRUE AND edge.from_node = edge.to_node
        ) % 2
      ) AS unpaired_bidirectional_self_loop_count,
      count(*) FILTER (
        WHERE edge.source_ref IS NULL OR btrim(edge.source_ref) = ''
      ) AS missing_edge_source_ref_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:')
      ) AS generated_edge_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:pathway:')
           OR starts_with(edge.source_ref, 'gtfs_pathways:connector-edge:')
      ) AS loader_indoor_edge_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:pathway:')
      ) AS indoor_edge_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:connector-edge:')
      ) AS connector_edge_count,
      count(*) FILTER (
        WHERE NOT starts_with(COALESCE(edge.source_ref, ''), 'gtfs_pathways:')
      ) AS outdoor_edge_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:')
          AND NOT starts_with(edge.source_ref, 'gtfs_pathways:pathway:')
          AND NOT starts_with(edge.source_ref, 'gtfs_pathways:connector-edge:')
      ) AS unknown_generated_edge_source_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:')
          AND (
            edge.attr_meta IS NULL
            OR jsonb_typeof(edge.attr_meta) <> 'object'
            OR edge.attr_meta = '{}'::jsonb
            OR EXISTS (
              SELECT 1
              FROM jsonb_each(
                CASE
                  WHEN jsonb_typeof(edge.attr_meta) = 'object'
                    THEN edge.attr_meta
                  ELSE '{}'::jsonb
                END
              ) AS attribute
              WHERE COALESCE(attribute.value ->> 'source', '') <> 'gtfs_pathways'
            )
          )
      ) AS invalid_generated_edge_metadata_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:pathway:')
          AND (
            edge.geom IS NOT NULL
            OR edge.edge_type IS NULL
            OR edge.edge_type NOT IN (20, 21, 22, 23, 24, 25, 26, 255)
            OR edge.has_ramp IS DISTINCT FROM FALSE
            OR edge.is_bidirectional IS NULL
            OR (
              edge.traversal_time_s IS NOT NULL
              AND (
                edge.traversal_time_s < 0
                OR edge.traversal_time_s IN (
                  'NaN'::real,
                  'Infinity'::real,
                  '-Infinity'::real
                )
              )
            )
          )
      ) AS generated_pathway_edge_loader_mismatch_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:connector-edge:')
          AND (
            edge.edge_type IS DISTINCT FROM 2
            OR edge.length_m IS NULL
            OR edge.length_m < 0
            OR edge.length_m IN ('NaN'::real, 'Infinity'::real, '-Infinity'::real)
            OR edge.traversal_time_s IS NOT NULL
            OR edge.has_ramp IS DISTINCT FROM FALSE
            OR edge.is_bidirectional IS NULL
          )
      ) AS generated_connector_edge_loader_mismatch_count,
      count(*) FILTER (
        WHERE NOT starts_with(COALESCE(edge.source_ref, ''), 'gtfs_pathways:')
          AND (
            edge.geom IS NULL
            OR edge.edge_type IS NULL
            OR edge.edge_type BETWEEN 20 AND 26
            OR edge.length_m IS NULL
            OR edge.length_m < 0
            OR edge.length_m IN ('NaN'::real, 'Infinity'::real, '-Infinity'::real)
          )
      ) AS outdoor_edge_loader_mismatch_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:pathway:')
          AND (
            from_same.node_id IS NULL
            OR to_same.node_id IS NULL
            OR NOT starts_with(COALESCE(from_same.source_ref, ''), 'gtfs_pathways:stop:')
            OR NOT starts_with(COALESCE(to_same.source_ref, ''), 'gtfs_pathways:stop:')
            OR from_same.station_id IS NULL
            OR to_same.station_id IS NULL
            OR btrim(from_same.station_id) = ''
            OR btrim(to_same.station_id) = ''
            OR from_same.station_id <> to_same.station_id
          )
      ) AS generated_pathway_endpoint_mismatch_count,
      count(*) FILTER (
        WHERE starts_with(edge.source_ref, 'gtfs_pathways:connector-edge:')
          AND NOT COALESCE(
            (
              starts_with(from_same.source_ref, 'gtfs_pathways:connector:')
              AND from_same.node_type = 12
              AND from_same.station_id IS NOT NULL
              AND btrim(from_same.station_id) <> ''
              AND (
                (
                  starts_with(to_same.source_ref, 'gtfs_pathways:stop:')
                  AND to_same.node_type = 11
                  AND to_same.geom IS NOT NULL
                  AND to_same.station_id IS NOT NULL
                  AND btrim(to_same.station_id) <> ''
                  AND to_same.station_id = from_same.station_id
                )
                OR (
                  NOT starts_with(COALESCE(to_same.source_ref, ''), 'gtfs_pathways:')
                  AND to_same.geom IS NOT NULL
                )
              )
            )
            OR (
              starts_with(to_same.source_ref, 'gtfs_pathways:connector:')
              AND to_same.node_type = 12
              AND to_same.station_id IS NOT NULL
              AND btrim(to_same.station_id) <> ''
              AND (
                (
                  starts_with(from_same.source_ref, 'gtfs_pathways:stop:')
                  AND from_same.node_type = 11
                  AND from_same.geom IS NOT NULL
                  AND from_same.station_id IS NOT NULL
                  AND btrim(from_same.station_id) <> ''
                  AND from_same.station_id = to_same.station_id
                )
                OR (
                  NOT starts_with(COALESCE(from_same.source_ref, ''), 'gtfs_pathways:')
                  AND from_same.geom IS NOT NULL
                )
              )
            ),
            FALSE
          )
      ) AS generated_connector_endpoint_mismatch_count,
      count(*) FILTER (
        WHERE from_any.node_id IS NULL
      ) AS missing_from_node_count,
      count(*) FILTER (
        WHERE to_any.node_id IS NULL
      ) AS missing_to_node_count,
      count(*) FILTER (
        WHERE from_any.node_id IS NOT NULL
          AND from_any.version_id <> edge.version_id
      ) AS cross_version_from_node_count,
      count(*) FILTER (
        WHERE to_any.node_id IS NOT NULL
          AND to_any.version_id <> edge.version_id
      ) AS cross_version_to_node_count,
      count(*) FILTER (
        WHERE NOT starts_with(COALESCE(edge.source_ref, ''), 'gtfs_pathways:')
          AND edge.geom IS NOT NULL
          AND from_same.node_id IS NOT NULL
          AND to_same.node_id IS NOT NULL
          AND from_same.geom IS NOT NULL
          AND to_same.geom IS NOT NULL
          AND NOT starts_with(COALESCE(from_same.source_ref, ''), 'gtfs_pathways:')
          AND NOT starts_with(COALESCE(to_same.source_ref, ''), 'gtfs_pathways:')
      ) AS routable_outdoor_real_geometry_edge_count
    FROM ped_edge AS edge
    INNER JOIN target_version ON target_version.id = edge.version_id
    LEFT JOIN ped_node AS from_any ON from_any.node_id = edge.from_node
    LEFT JOIN ped_node AS to_any ON to_any.node_id = edge.to_node
    LEFT JOIN ped_node AS from_same
      ON from_same.node_id = edge.from_node
      AND from_same.version_id = edge.version_id
    LEFT JOIN ped_node AS to_same
      ON to_same.node_id = edge.to_node
      AND to_same.version_id = edge.version_id
  )
  SELECT
    node_integrity.actual_node_count,
    node_integrity.invalid_node_coordinate_count,
    node_integrity.invalid_station_radius_count,
    node_integrity.invalid_node_type_count,
    node_integrity.missing_node_source_ref_count,
    node_integrity.generated_node_count,
    node_integrity.indoor_node_count,
    node_integrity.connector_node_count,
    node_integrity.outdoor_node_count,
    node_integrity.unknown_generated_node_source_count,
    node_integrity.invalid_generated_node_metadata_count,
    node_integrity.generated_stop_node_loader_mismatch_count,
    node_integrity.generated_connector_node_loader_mismatch_count,
    node_integrity.outdoor_node_loader_mismatch_count,
    node_integrity.routable_outdoor_real_geometry_node_count,
    edge_integrity.actual_directed_edge_count,
    edge_integrity.invalid_edge_length_count,
    edge_integrity.invalid_edge_slope_count,
    edge_integrity.invalid_edge_width_count,
    edge_integrity.invalid_edge_traversal_time_count,
    edge_integrity.invalid_edge_stair_count,
    edge_integrity.invalid_edge_type_count,
    edge_integrity.invalid_edge_surface_count,
    edge_integrity.invalid_edge_smoothness_count,
    edge_integrity.invalid_edge_wheelchair_count,
    edge_integrity.invalid_edge_boolean_count,
    edge_integrity.unpaired_bidirectional_self_loop_count,
    edge_integrity.missing_edge_source_ref_count,
    edge_integrity.generated_edge_count,
    edge_integrity.loader_indoor_edge_count,
    edge_integrity.indoor_edge_count,
    edge_integrity.connector_edge_count,
    edge_integrity.outdoor_edge_count,
    edge_integrity.unknown_generated_edge_source_count,
    edge_integrity.invalid_generated_edge_metadata_count,
    edge_integrity.generated_pathway_edge_loader_mismatch_count,
    edge_integrity.generated_connector_edge_loader_mismatch_count,
    edge_integrity.outdoor_edge_loader_mismatch_count,
    edge_integrity.generated_pathway_endpoint_mismatch_count,
    edge_integrity.generated_connector_endpoint_mismatch_count,
    edge_integrity.missing_from_node_count,
    edge_integrity.missing_to_node_count,
    edge_integrity.cross_version_from_node_count,
    edge_integrity.cross_version_to_node_count,
    edge_integrity.routable_outdoor_real_geometry_edge_count
  FROM node_integrity
  CROSS JOIN edge_integrity
`;

const RETIRE_ACTIVE_QUERY = `
  UPDATE ped_graph_version
  SET lifecycle_status = 'RETIRED'
  WHERE lifecycle_status = 'ACTIVE'
`;

const ACTIVATE_CANDIDATE_QUERY = `
  UPDATE ped_graph_version
  SET lifecycle_status = 'ACTIVE'
  WHERE id = $1 AND lifecycle_status = 'CANDIDATE'
`;

const ACTIVATE_RETIRED_QUERY = `
  UPDATE ped_graph_version
  SET lifecycle_status = 'ACTIVE'
  WHERE id = $1 AND lifecycle_status = 'RETIRED'
`;

const ACTIVE_COUNT_QUERY = `
  SELECT count(*) AS active_count
  FROM ped_graph_version
  WHERE lifecycle_status = 'ACTIVE'
`;

type DatabaseRow = Record<string, unknown>;

export interface PedGraphPromotionClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount: number | null; rows: DatabaseRow[] }>;
}

export interface PromotionOptions {
  allowRetired: boolean;
  versionId: number;
}

export interface PromotionResult {
  activeVersionId: number;
  outcome: "activated" | "already-active";
  previousActiveVersionId: number;
}

interface PromotionCommandOptions extends PromotionOptions {
  dbUrl: string;
}

/**
 * @param value Raw PostgreSQL integer value.
 * @param label Database field label.
 * @param minimum Lowest permitted value.
 * @returns A validated integer.
 */
function databaseInteger(
  value: unknown,
  label: string,
  minimum: number,
): number {
  if (value === null || value === undefined || value === "") {
    throw new Error(`pedestrian graph ${label} is missing`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`pedestrian graph ${label} is not a valid integer`);
  }
  return parsed;
}

/**
 * @param value Raw PostgreSQL boolean value.
 * @param label Database field label.
 * @returns The decoded boolean.
 */
function databaseBoolean(value: unknown, label: string): boolean {
  if (value === true || value === "true" || value === "t" || value === 1) {
    return true;
  }
  if (value === false || value === "false" || value === "f" || value === 0) {
    return false;
  }
  throw new Error(`pedestrian graph ${label} is not a boolean`);
}

/**
 * @param value Raw PostgreSQL text value.
 * @param label Database field label.
 * @returns The required text value.
 */
function databaseString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`pedestrian graph ${label} is missing`);
  }
  return value;
}

/**
 * @param row Stored graph-version database row.
 * @param versionId Requested graph version identifier.
 * @returns Parsed promotion target state.
 */
function graphVersionFromRow(
  row: DatabaseRow | undefined,
  versionId: number,
): GraphVersionSnapshot {
  if (row === undefined) {
    throw new Error(`pedestrian graph version ${versionId} was not found`);
  }
  return {
    id: databaseInteger(row.id, "version id", 1),
    lifecycleStatus: parsePedGraphLifecycleStatus(row.lifecycle_status),
    nodeCount: databaseInteger(row.node_count, "node_count", 0),
    directedEdgeCount: databaseInteger(
      row.directed_edge_count,
      "directed_edge_count",
      0,
    ),
    indoorInjectionComplete: databaseBoolean(
      row.indoor_injection_complete,
      "indoor_injection_complete",
    ),
    sourceHash: databaseString(row.source_hash, "source_hash"),
    notes: row.notes,
  };
}

/**
 * @param row Bounded aggregate integrity result for the requested version.
 * @returns Parsed graph integrity facts.
 */
function integrityFromRow(
  row: DatabaseRow | undefined,
): GraphIntegritySnapshot {
  if (row === undefined) {
    throw new Error("pedestrian graph integrity query returned no row");
  }
  const count = (column: string): number =>
    databaseInteger(row[column], column, 0);
  return {
    nodeCount: count("actual_node_count"),
    directedEdgeCount: count("actual_directed_edge_count"),
    invalidNodeCoordinateCount: count("invalid_node_coordinate_count"),
    invalidStationRadiusCount: count("invalid_station_radius_count"),
    invalidNodeTypeCount: count("invalid_node_type_count"),
    invalidEdgeLengthCount: count("invalid_edge_length_count"),
    invalidEdgeSlopeCount: count("invalid_edge_slope_count"),
    invalidEdgeWidthCount: count("invalid_edge_width_count"),
    invalidEdgeTraversalTimeCount: count("invalid_edge_traversal_time_count"),
    invalidEdgeStairCount: count("invalid_edge_stair_count"),
    invalidEdgeTypeCount: count("invalid_edge_type_count"),
    invalidEdgeSurfaceCount: count("invalid_edge_surface_count"),
    invalidEdgeSmoothnessCount: count("invalid_edge_smoothness_count"),
    invalidEdgeWheelchairCount: count("invalid_edge_wheelchair_count"),
    invalidEdgeBooleanCount: count("invalid_edge_boolean_count"),
    unpairedBidirectionalSelfLoopCount: count(
      "unpaired_bidirectional_self_loop_count",
    ),
    outdoorNodeCount: count("outdoor_node_count"),
    indoorNodeCount: count("indoor_node_count"),
    connectorNodeCount: count("connector_node_count"),
    generatedNodeCount: count("generated_node_count"),
    outdoorEdgeCount: count("outdoor_edge_count"),
    indoorEdgeCount: count("indoor_edge_count"),
    connectorEdgeCount: count("connector_edge_count"),
    generatedEdgeCount: count("generated_edge_count"),
    loaderIndoorEdgeCount: count("loader_indoor_edge_count"),
    generatedStopNodeLoaderMismatchCount: count(
      "generated_stop_node_loader_mismatch_count",
    ),
    generatedConnectorNodeLoaderMismatchCount: count(
      "generated_connector_node_loader_mismatch_count",
    ),
    generatedPathwayEdgeLoaderMismatchCount: count(
      "generated_pathway_edge_loader_mismatch_count",
    ),
    generatedConnectorEdgeLoaderMismatchCount: count(
      "generated_connector_edge_loader_mismatch_count",
    ),
    generatedPathwayEndpointMismatchCount: count(
      "generated_pathway_endpoint_mismatch_count",
    ),
    generatedConnectorEndpointMismatchCount: count(
      "generated_connector_endpoint_mismatch_count",
    ),
    outdoorNodeLoaderMismatchCount: count("outdoor_node_loader_mismatch_count"),
    outdoorEdgeLoaderMismatchCount: count("outdoor_edge_loader_mismatch_count"),
    missingNodeSourceRefCount: count("missing_node_source_ref_count"),
    missingEdgeSourceRefCount: count("missing_edge_source_ref_count"),
    missingFromNodeCount: count("missing_from_node_count"),
    missingToNodeCount: count("missing_to_node_count"),
    crossVersionFromNodeCount: count("cross_version_from_node_count"),
    crossVersionToNodeCount: count("cross_version_to_node_count"),
    invalidGeneratedNodeMetadataCount: count(
      "invalid_generated_node_metadata_count",
    ),
    invalidGeneratedEdgeMetadataCount: count(
      "invalid_generated_edge_metadata_count",
    ),
    unknownGeneratedNodeSourceCount: count(
      "unknown_generated_node_source_count",
    ),
    unknownGeneratedEdgeSourceCount: count(
      "unknown_generated_edge_source_count",
    ),
    routableOutdoorRealGeometryNodeCount: count(
      "routable_outdoor_real_geometry_node_count",
    ),
    routableOutdoorRealGeometryEdgeCount: count(
      "routable_outdoor_real_geometry_edge_count",
    ),
  };
}

/**
 * @param result Mutation result expected to affect exactly one version row.
 * @param label Mutation description.
 * @returns Nothing.
 */
function requireOneChanged(
  result: { rowCount: number | null },
  label: string,
): void {
  if (result.rowCount !== 1) {
    throw new Error(`pedestrian graph ${label} did not affect exactly one row`);
  }
}

/**
 * @param client Transaction-capable PostgreSQL client.
 * @param options Explicit target and rollback permission.
 * @returns The committed lifecycle transition outcome.
 */
export async function promotePedGraph(
  client: PedGraphPromotionClient,
  options: PromotionOptions,
): Promise<PromotionResult> {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      PROMOTION_ADVISORY_LOCK,
    ]);
    const lifecycleRows = await client.query(LIFECYCLE_ROWS_QUERY, [
      options.versionId,
    ]);
    await client.query(GRAPH_CHILD_TABLE_LOCK_QUERY);

    const integrityRows = await client.query(PROMOTION_INTEGRITY_QUERY, [
      options.versionId,
    ]);
    const target = graphVersionFromRow(
      lifecycleRows.rows.find(
        (row) => databaseInteger(row.id, "version id", 1) === options.versionId,
      ),
      options.versionId,
    );
    const integrity = integrityFromRow(integrityRows.rows[0]);
    const activeVersionIds = lifecycleRows.rows
      .filter(
        (row) =>
          parsePedGraphLifecycleStatus(row.lifecycle_status) === "ACTIVE",
      )
      .map((row) => databaseInteger(row.id, "active version id", 1));
    const decision = validatePromotion({
      activeVersionIds,
      integrity,
      allowRetired: options.allowRetired,
      target,
    });

    if (decision.kind === "already-active") {
      await client.query("COMMIT");
      transactionStarted = false;
      return {
        activeVersionId: target.id,
        outcome: "already-active",
        previousActiveVersionId: decision.activeVersionId,
      };
    }

    requireOneChanged(
      await client.query(RETIRE_ACTIVE_QUERY),
      "retire active version",
    );
    const activationQuery =
      target.lifecycleStatus === "CANDIDATE"
        ? ACTIVATE_CANDIDATE_QUERY
        : ACTIVATE_RETIRED_QUERY;
    requireOneChanged(
      await client.query(activationQuery, [target.id]),
      "activate target version",
    );
    const activeCountRows = await client.query(ACTIVE_COUNT_QUERY);
    const activeCount = databaseInteger(
      activeCountRows.rows[0]?.active_count,
      "active_count",
      0,
    );
    if (activeCount !== 1) {
      throw new Error(
        "pedestrian graph promotion did not leave one active version",
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;
    return {
      activeVersionId: target.id,
      outcome: "activated",
      previousActiveVersionId: decision.activeVersionId,
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  }
}

/**
 * @param client PostgreSQL client from the pg package.
 * @returns The narrowed query interface used by promotion logic.
 */
function promotionClient(client: Client): PedGraphPromotionClient {
  return {
    query(sql: string, params?: unknown[]) {
      return client.query<DatabaseRow>(sql, params);
    },
  };
}

/**
 * @param argv Command-line arguments after the executable.
 * @returns Parsed promotion command options.
 */
export function parsePromotionArgs(
  argv: readonly string[],
): PromotionCommandOptions {
  let allowRetired = false;
  let dbUrl = process.env.PED_GRAPH_DATABASE_URL;
  let versionId: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-retired") {
      allowRetired = true;
      continue;
    }
    if (argument === "--version-id" || argument === "--db-url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--version-id") {
        versionId = databaseInteger(value, "version id", 1);
      } else {
        dbUrl = value;
      }
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (versionId === undefined) {
    throw new Error("--version-id is required");
  }
  if (!dbUrl) {
    throw new Error("--db-url or PED_GRAPH_DATABASE_URL is required");
  }
  return { allowRetired, dbUrl, versionId };
}

/**
 * @returns Process exit status.
 */
async function main(): Promise<void> {
  const options = parsePromotionArgs(process.argv.slice(2));
  const client = new Client({ connectionString: options.dbUrl });
  await client.connect();
  try {
    const result = await promotePedGraph(promotionClient(client), options);
    console.log(
      `[promote-ped-graph] version_id=${result.activeVersionId} ` +
        `outcome=${result.outcome} previous_active_version_id=` +
        `${result.previousActiveVersionId}`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[promote-ped-graph] ${message}`);
    process.exitCode = 1;
  });
}
