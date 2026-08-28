/**
 * One-shot import: Taipei New Construction Office curb ramp points → PostGIS.
 *
 * Two tables are maintained:
 *  - `ped_ramp_point`: a graph-version-independent reference table (like
 *    `ped_osm_way_name`), upserted by `objectid`.
 *  - `ped_ramp_edge`: a graph-version-bound mapping from each ramp point to
 *    its nearest sidewalk/footway/crossing edge, rebuilt for the ACTIVE
 *    version on every run.
 *
 * Run: npm run import:taipei-ramps -- [--file <path> | --url <endpoint>] [--db-url <url>]
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  CAR_RAMP_NAME,
  parseRampFeature,
  type RampFeature,
} from "./taipei-ramps-parse";

const DEFAULT_SOURCE_URL =
  "https://data.taipei/api/dataset/8ab0c662-b560-4310-a825-001ae7fdc524/resource/ee522d94-daa7-4118-b52a-4bf144af2744/download";

/**
 * Snapping tolerance for matching a ramp point to its nearest routable edge.
 * Measured p50 is 2.4m; the ≤3/5/8/15m cumulative counts flatten out past 8m,
 * so widening this would risk snapping a point to the wrong side of a street
 * for a negligible coverage gain. Named and exported so tests assert the
 * import script actually uses this value rather than a re-typed literal.
 */
export const RAMP_SNAP_TOLERANCE_M = 8;

const UPSERT_CHUNK_SIZE = 500;

const CREATE_RAMP_POINT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ped_ramp_point (
    objectid       BIGINT PRIMARY KEY,
    geom           geometry(Point,4326) NOT NULL,
    town           TEXT,
    source_version TEXT NOT NULL
  );
`;

const CREATE_RAMP_POINT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS ped_ramp_point_geom_idx ON ped_ramp_point USING GIST (geom);
`;

const CREATE_RAMP_EDGE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ped_ramp_edge (
    version_id BIGINT NOT NULL,
    edge_id    BIGINT NOT NULL,
    objectid   BIGINT NOT NULL,
    PRIMARY KEY (version_id, edge_id, objectid)
  );
`;

const ACTIVE_VERSION_ID_QUERY = `
  SELECT id
  FROM ped_graph_version
  WHERE lifecycle_status = 'ACTIVE'
  ORDER BY built_at DESC, id DESC
  LIMIT 1
`;

const DELETE_RAMP_EDGE_SQL = `
  DELETE FROM ped_ramp_edge WHERE version_id = $1
`;

const REBUILD_RAMP_EDGE_SQL = `
  INSERT INTO ped_ramp_edge (version_id, edge_id, objectid)
  SELECT $1, nearest.edge_id, point.objectid
  FROM ped_ramp_point AS point
  CROSS JOIN LATERAL (
    SELECT edge.edge_id
    FROM ped_edge AS edge
    WHERE edge.version_id = $1
      AND edge.edge_type IN (1, 2, 3)
      AND edge.geom IS NOT NULL
      AND ST_DWithin(edge.geom::geography, point.geom::geography, $2)
    ORDER BY edge.geom::geography <-> point.geom::geography
    LIMIT 1
  ) AS nearest
`;

interface ImportOptions {
  filePath?: string;
  url: string;
  dbUrl: string;
}

interface QueryableClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * @param argv Command-line arguments after the executable.
 * @returns Parsed import command options.
 */
export function parseImportArgs(argv: readonly string[]): ImportOptions {
  let filePath: string | undefined;
  let url = DEFAULT_SOURCE_URL;
  let dbUrl = process.env.PED_GRAPH_DATABASE_URL;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--file" ||
      argument === "--url" ||
      argument === "--db-url"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--file") filePath = value;
      else if (argument === "--url") url = value;
      else dbUrl = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (!dbUrl) {
    throw new Error("--db-url or PED_GRAPH_DATABASE_URL is required");
  }
  return { filePath, url, dbUrl };
}

/**
 * @param options Resolved import command options.
 * @returns The raw GeoJSON response body, from `--file` when given, else `--url`.
 */
async function loadRawGeoJson(options: ImportOptions): Promise<string> {
  if (options.filePath !== undefined) {
    return readFile(options.filePath, "utf-8");
  }
  const response = await fetch(options.url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * @param raw Raw response body, expected to be a GeoJSON FeatureCollection.
 * @returns The collection's features.
 */
function parseFeatureCollection(raw: string): RampFeature[] {
  const parsed: unknown = JSON.parse(raw);
  const features = (parsed as { features?: unknown }).features;
  if (!Array.isArray(features)) {
    throw new Error("response is not a GeoJSON FeatureCollection");
  }
  return features as RampFeature[];
}

interface FilterSummary {
  totalFeatures: number;
  excludedCarRamps: number;
  discardedCoordinateMismatch: number;
  discardedMalformed: number;
  points: { objectid: number; lng: number; lat: number; town: string | null }[];
}

/**
 * @param features Raw GeoJSON features from the source FeatureCollection.
 * @returns Accepted points plus counts for every rejection reason.
 */
function filterRampFeatures(features: readonly RampFeature[]): FilterSummary {
  const summary: FilterSummary = {
    totalFeatures: features.length,
    excludedCarRamps: 0,
    discardedCoordinateMismatch: 0,
    discardedMalformed: 0,
    points: [],
  };
  for (const rawFeature of features) {
    const result = parseRampFeature(rawFeature);
    switch (result.status) {
      case "ok":
        summary.points.push(result.point);
        break;
      case "not_accessible_ramp":
        if (rawFeature.properties?.Name === CAR_RAMP_NAME) {
          summary.excludedCarRamps += 1;
        }
        break;
      case "coordinate_mismatch":
        summary.discardedCoordinateMismatch += 1;
        break;
      case "malformed":
        summary.discardedMalformed += 1;
        break;
    }
  }
  return summary;
}

/**
 * @param client PostGIS client.
 * @param points Accepted ramp points.
 * @param sourceVersion Label stamped onto every upserted row.
 * @returns Nothing.
 */
async function upsertRampPoints(
  client: QueryableClient,
  points: readonly {
    objectid: number;
    lng: number;
    lat: number;
    town: string | null;
  }[],
  sourceVersion: string,
): Promise<void> {
  for (let start = 0; start < points.length; start += UPSERT_CHUNK_SIZE) {
    const chunk = points.slice(start, start + UPSERT_CHUNK_SIZE);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((point, index) => {
      const base = index * 5;
      values.push(
        `($${base + 1}, ST_SetSRID(ST_MakePoint($${base + 2}, $${base + 3}), 4326), $${base + 4}, $${base + 5})`,
      );
      params.push(
        point.objectid,
        point.lng,
        point.lat,
        point.town,
        sourceVersion,
      );
    });
    await client.query(
      `INSERT INTO ped_ramp_point (objectid, geom, town, source_version)
       VALUES ${values.join(", ")}
       ON CONFLICT (objectid) DO UPDATE SET
         geom = EXCLUDED.geom,
         town = EXCLUDED.town,
         source_version = EXCLUDED.source_version`,
      params,
    );
  }
}

/**
 * @param client PostGIS client.
 * @returns The ACTIVE graph version id, or null when none exists yet.
 */
async function loadActiveVersionId(
  client: QueryableClient,
): Promise<number | null> {
  const result = await client.query<{ id: unknown }>(ACTIVE_VERSION_ID_QUERY);
  const row = result.rows[0];
  if (row === undefined) return null;
  return Number(row.id);
}

/**
 * @returns Process exit status.
 */
async function main(): Promise<void> {
  const options = parseImportArgs(process.argv.slice(2));
  const raw = await loadRawGeoJson(options);
  const features = parseFeatureCollection(raw);
  const summary = filterRampFeatures(features);

  console.log(
    `[import-taipei-ramps] features=${summary.totalFeatures} ` +
      `excluded_car_ramps=${summary.excludedCarRamps} ` +
      `discarded_coordinate_mismatch=${summary.discardedCoordinateMismatch} ` +
      `discarded_malformed=${summary.discardedMalformed} ` +
      `accepted=${summary.points.length}`,
  );

  const client = new Client({ connectionString: options.dbUrl });
  await client.connect();
  try {
    await client.query(CREATE_RAMP_POINT_TABLE_SQL);
    await client.query(CREATE_RAMP_POINT_INDEX_SQL);
    await client.query(CREATE_RAMP_EDGE_TABLE_SQL);

    const sourceVersion = new Date().toISOString();
    await upsertRampPoints(client, summary.points, sourceVersion);
    console.log(
      `[import-taipei-ramps] upserted ${summary.points.length} ramp points`,
    );

    const activeVersionId = await loadActiveVersionId(client);
    if (activeVersionId === null) {
      console.log(
        "[import-taipei-ramps] no ACTIVE ped_graph_version yet; skipping ped_ramp_edge rebuild",
      );
      return;
    }

    await client.query(DELETE_RAMP_EDGE_SQL, [activeVersionId]);
    await client.query(REBUILD_RAMP_EDGE_SQL, [
      activeVersionId,
      RAMP_SNAP_TOLERANCE_M,
    ]);
    const matched = await client.query<{ count: unknown }>(
      "SELECT count(*) FROM ped_ramp_edge WHERE version_id = $1",
      [activeVersionId],
    );
    const matchedCount = Number(matched.rows[0]?.count ?? 0);
    const ratio =
      summary.points.length === 0
        ? 0
        : (matchedCount / summary.points.length) * 100;
    console.log(
      `[import-taipei-ramps] version_id=${activeVersionId} ` +
        `matched=${matchedCount}/${summary.points.length} (${ratio.toFixed(1)}%)`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[import-taipei-ramps] ${message}`);
    process.exitCode = 1;
  });
}
