/**
 * Import Taipei painted (marked) sidewalks → PostGIS.
 *
 *  - `ped_painted_sidewalk_polygon`: graph-version-independent source table,
 *    replaced as one snapshot per run (keyed by 交工處 `keyid`).
 *  - `ped_painted_node`: graph-version-bound mapping from each pedestrian graph
 *    node to the painted strip it sits on. A painted sidewalk is level with the
 *    carriageway, so a crossing that ends on one needs no curb ramp; the CSR
 *    loader turns this into `NODE_FLAG.STEP_FREE_KERB`.
 *
 * The polygons also feed the OTP PBF compile (build-otp-graph.sh step 2c/2d).
 *
 * Run: pnpm import:taipei-painted-sidewalks -- [--zip <path> | --url <endpoint>]
 *        [--version-id <id>] [--mappings-only]
 *
 * The mapping is rebuilt only for an explicit `--version-id` (CSR release step,
 * before promotion); a routine `data:sync` only refreshes the source polygons.
 */

import "dotenv/config";
import * as shapefile from "shapefile";
import { Client } from "pg";
import {
  acquireSidewalkArchive,
  readShapefileMembers,
} from "../adapters/sidewalk-source.adapter";
import {
  isTwd97Tm2Prj,
  parsePaintedSidewalkFeature,
  type ParsedPaintedSidewalk,
  type PaintedSidewalkFeature,
} from "./taipei-painted-sidewalk-parse";
import {
  graphMappingsAvailable,
  requireMappingVersion,
  type QueryableClient,
} from "./ped-graph-mapping-target";

export const DEFAULT_PAINTED_SIDEWALK_URL =
  "https://data.taipei/api/dataset/d647b3af-4bbd-4e8f-b420-8f6c1bc1b597/resource/2d82d5f1-8f97-45db-89df-162ba161dedb/download";

/**
 * A graph node within this distance of a painted strip is on that strip.
 * Strips are ~1.3 m wide and OSM crossing ends sit at the road edge, so the
 * tolerance covers the strip plus OSM positional noise without reaching the
 * far side of a street.
 */
export const PAINTED_NODE_TOLERANCE_M = 3;

/**
 * Degree-space prefilter for `ST_DWithin` on `ped_node.geom` (kept in raw
 * degrees so the GiST index stays usable — see import-taipei-ramps.ts).
 * 0.00004° ≈ 4.4 m latitude / 4.0 m longitude at 25°N, both above
 * {@link PAINTED_NODE_TOLERANCE_M}.
 */
export const PAINTED_NODE_PREFILTER_DEGREES = 0.00004;

const INSERT_CHUNK_SIZE = 200;

const CREATE_POLYGON_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ped_painted_sidewalk_polygon (
    keyid          BIGINT PRIMARY KEY,
    geom           geometry(MultiPolygon,4326) NOT NULL,
    width_m        DOUBLE PRECISION,
    source_sha256  TEXT NOT NULL,
    imported_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS ped_painted_sidewalk_polygon_geom_idx
    ON ped_painted_sidewalk_polygon USING GIST (geom);
`;

const CREATE_NODE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ped_painted_node (
    version_id BIGINT NOT NULL,
    node_id    BIGINT NOT NULL,
    keyid      BIGINT NOT NULL,
    PRIMARY KEY (version_id, node_id, keyid)
  );
`;

/** One set-based statement, like `REBUILD_RAMP_NODE_SQL`. */
export const REBUILD_PAINTED_NODE_SQL = `
  INSERT INTO ped_painted_node (version_id, node_id, keyid)
  SELECT $1, node.node_id, strip.keyid
  FROM ped_painted_sidewalk_polygon AS strip
  JOIN ped_node AS node
    ON node.version_id = $1
   AND node.geom IS NOT NULL
   AND ST_DWithin(node.geom, strip.geom, $3)
   AND ST_Distance(node.geom::geography, strip.geom::geography) <= $2
  ON CONFLICT DO NOTHING
`;

interface ImportOptions {
  zip?: string;
  url: string;
  dbUrl: string;
  versionId?: number;
  mappingsOnly: boolean;
}

/**
 * @param argv Command-line arguments after the executable.
 * @param env Process environment.
 * @returns Parsed options.
 */
export function parsePaintedImportArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ImportOptions {
  const options: ImportOptions = {
    url: DEFAULT_PAINTED_SIDEWALK_URL,
    dbUrl: env.PED_GRAPH_DATABASE_URL ?? "",
    mappingsOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--mappings-only") {
      options.mappingsOnly = true;
      continue;
    }
    if (!["--zip", "--url", "--db-url", "--version-id"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--zip") options.zip = value;
    else if (argument === "--url") options.url = value;
    else if (argument === "--db-url") options.dbUrl = value;
    else {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("--version-id must be a positive integer");
      }
      options.versionId = id;
    }
  }
  if (!options.dbUrl) {
    throw new Error("--db-url or PED_GRAPH_DATABASE_URL is required");
  }
  return options;
}

interface ReadSummary {
  sha256: string;
  total: number;
  otherMarkings: number;
  removed: number;
  malformed: number;
  sidewalks: ParsedPaintedSidewalk[];
}

async function readSource(options: ImportOptions): Promise<ReadSummary> {
  const archive = await acquireSidewalkArchive(
    options.zip ? { zip: options.zip } : { url: options.url },
  );
  try {
    const members = await readShapefileMembers(archive.file);
    if (!isTwd97Tm2Prj(members.prj)) {
      throw new Error(`${members.name}.prj is not TWD97 / TM2 (EPSG:3826)`);
    }
    const collection = await shapefile.read(members.shp, members.dbf, {
      encoding: "utf-8",
    });
    const summary: ReadSummary = {
      sha256: archive.sha256,
      total: 0,
      otherMarkings: 0,
      removed: 0,
      malformed: 0,
      sidewalks: [],
    };
    for (const feature of collection.features) {
      summary.total += 1;
      const result = parsePaintedSidewalkFeature(
        feature as unknown as PaintedSidewalkFeature,
      );
      if (result.status === "ok") summary.sidewalks.push(result.sidewalk);
      else if (result.status === "other_marking") summary.otherMarkings += 1;
      else if (result.status === "removed") summary.removed += 1;
      else summary.malformed += 1;
    }
    return summary;
  } finally {
    await archive.cleanup();
  }
}

async function replacePolygons(
  client: QueryableClient,
  sidewalks: readonly ParsedPaintedSidewalk[],
  sha256: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM ped_painted_sidewalk_polygon");
    for (let start = 0; start < sidewalks.length; start += INSERT_CHUNK_SIZE) {
      const chunk = sidewalks.slice(start, start + INSERT_CHUNK_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((sidewalk, index) => {
        const base = index * 4;
        values.push(
          `($${base + 1}, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($${base + 2}), 4326))), $${base + 3}, $${base + 4})`,
        );
        params.push(
          sidewalk.keyid,
          JSON.stringify({
            type: "MultiPolygon",
            coordinates: sidewalk.coordinates,
          }),
          sidewalk.widthM,
          sha256,
        );
      });
      await client.query(
        `INSERT INTO ped_painted_sidewalk_polygon (keyid, geom, width_m, source_sha256)
         VALUES ${values.join(", ")}
         ON CONFLICT (keyid) DO UPDATE SET geom = EXCLUDED.geom,
           width_m = EXCLUDED.width_m, source_sha256 = EXCLUDED.source_sha256`,
        params,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * @param client PostGIS client.
 * @param versionId Graph version to rebuild the mapping for.
 * @returns Distinct graph nodes now mapped onto a painted strip.
 */
export async function rebuildPaintedNodes(
  client: QueryableClient,
  versionId: number,
): Promise<number> {
  // DELETE + INSERT commit together, so a concurrent promotion check never
  // sees this version with an empty mapping.
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM ped_painted_node WHERE version_id = $1", [
      versionId,
    ]);
    await client.query(`SET LOCAL statement_timeout = '300s'`);
    await client.query(REBUILD_PAINTED_NODE_SQL, [
      versionId,
      PAINTED_NODE_TOLERANCE_M,
      PAINTED_NODE_PREFILTER_DEGREES,
    ]);
    const result = await client.query<{ count: unknown }>(
      "SELECT count(DISTINCT node_id) FROM ped_painted_node WHERE version_id = $1",
      [versionId],
    );
    await client.query("COMMIT");
    return Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parsePaintedImportArgs(process.argv.slice(2));
  const client = new Client({ connectionString: options.dbUrl });
  await client.connect();
  try {
    await client.query(CREATE_POLYGON_TABLE_SQL);
    await client.query(CREATE_NODE_TABLE_SQL);
    if (!options.mappingsOnly) {
      const summary = await readSource(options);
      console.log(
        `[import-taipei-painted-sidewalks] features=${summary.total} ` +
          `other_markings=${summary.otherMarkings} removed=${summary.removed} ` +
          `malformed=${summary.malformed} accepted=${summary.sidewalks.length} ` +
          `sha256=${summary.sha256}`,
      );
      if (summary.sidewalks.length === 0) {
        throw new Error(
          "no painted sidewalk polygons accepted; keeping the previous table",
        );
      }
      await replacePolygons(client, summary.sidewalks, summary.sha256);
    }
    if (options.versionId === undefined) {
      if (options.mappingsOnly) {
        throw new Error("--mappings-only needs --version-id <graph version>");
      }
      console.log(
        "[import-taipei-painted-sidewalks] source updated; ped_painted_node is rebuilt per graph release with --version-id",
      );
      return;
    }
    if (!(await graphMappingsAvailable(client))) {
      throw new Error("no pedestrian graph schema; cannot map --version-id");
    }
    const versionId = await requireMappingVersion(client, options.versionId);
    const nodes = await rebuildPaintedNodes(client, versionId);
    console.log(
      `[import-taipei-painted-sidewalks] version_id=${versionId} painted nodes=${nodes}`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[import-taipei-painted-sidewalks] ${message}`);
    process.exitCode = 1;
  });
}
