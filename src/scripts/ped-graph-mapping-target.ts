/**
 * Shared target selection for the graph-version-bound mapping tables
 * (`ped_ramp_edge`, `ped_ramp_node`, `ped_painted_node`).
 *
 * Mappings belong to a graph release: they are rebuilt only for an explicit
 * `--version-id` (a CANDIDATE before promotion, or a version being rolled back
 * to), never implicitly for whatever is ACTIVE.
 */

export interface QueryableClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const SCHEMA_PRESENT_QUERY = `
  SELECT to_regclass('ped_graph_version') IS NOT NULL
     AND to_regclass('ped_node') IS NOT NULL
     AND to_regclass('ped_edge') IS NOT NULL AS present
`;

const VERSION_EXISTS_QUERY = `SELECT id FROM ped_graph_version WHERE id = $1`;

/**
 * @param client PostGIS client.
 * @returns Whether the pedestrian graph tables exist, so mappings can be built.
 */
export async function graphMappingsAvailable(
  client: QueryableClient,
): Promise<boolean> {
  const result = await client.query<{ present: unknown }>(SCHEMA_PRESENT_QUERY);
  return result.rows[0]?.present === true;
}

/**
 * @param client PostGIS client.
 * @param versionId `--version-id`.
 * @returns The id, after checking that graph version exists.
 */
export async function requireMappingVersion(
  client: QueryableClient,
  versionId: number,
): Promise<number> {
  const found = await client.query<{ id: unknown }>(VERSION_EXISTS_QUERY, [
    versionId,
  ]);
  if (found.rows.length === 0) {
    throw new Error(`ped_graph_version ${versionId} does not exist`);
  }
  return versionId;
}
