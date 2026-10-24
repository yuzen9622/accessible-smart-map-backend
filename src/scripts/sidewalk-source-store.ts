import { Client } from "pg";
import {
  readSidewalkCounties,
  SIDEWALK_COUNTIES,
} from "../adapters/sidewalk-source.adapter";
import {
  cleanSidewalkFeature,
  emptyCountyReport,
  incrementReason,
  parseCountyCollection,
  type SidewalkPolygon,
  type SidewalkReport,
} from "./sidewalk-source-parse";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ped_sidewalk_source_version (
  id bigserial PRIMARY KEY,
  archive_sha256 text NOT NULL UNIQUE,
  source_url text NOT NULL,
  source_batch text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('CANDIDATE','ACTIVE','RETIRED')),
  report jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ped_sidewalk_source_one_active
  ON ped_sidewalk_source_version (lifecycle_status) WHERE lifecycle_status='ACTIVE';
CREATE TABLE IF NOT EXISTS ped_sidewalk_polygon (
  source_version_id bigint NOT NULL REFERENCES ped_sidewalk_source_version(id),
  source_id text NOT NULL,
  county text NOT NULL,
  geom geometry(MultiPolygon,4326) NOT NULL,
  width_m double precision,
  effective_width_m double precision,
  ramp_count integer,
  ramp_status text NOT NULL CHECK (ramp_status IN ('recorded','not_required','unknown')),
  raw_properties jsonb NOT NULL,
  quality_flags text[] NOT NULL,
  PRIMARY KEY (source_version_id,source_id)
);
CREATE INDEX IF NOT EXISTS ped_sidewalk_polygon_geom_idx ON ped_sidewalk_polygon USING GIST (geom);
CREATE INDEX IF NOT EXISTS ped_sidewalk_polygon_county_idx ON ped_sidewalk_polygon (source_version_id,county);
CREATE TEMP TABLE sidewalk_stage (LIKE ped_sidewalk_polygon INCLUDING DEFAULTS) ON COMMIT DROP;
ALTER TABLE sidewalk_stage ADD PRIMARY KEY (source_id);
`;

async function stageChunk(
  client: Client,
  polygons: SidewalkPolygon[],
): Promise<Set<string>> {
  const result = await client.query<{ source_id: string }>(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
        source_id text, county text, geometry jsonb, width_m double precision,
        effective_width_m double precision, ramp_count integer, ramp_status text,
        raw_properties jsonb, quality_flags text[])
    ), shapes AS MATERIALIZED (
      SELECT *,ST_SetSRID(ST_GeomFromGeoJSON(geometry),4326) AS geom FROM input
    )
    INSERT INTO sidewalk_stage
      (source_version_id,source_id,county,geom,width_m,effective_width_m,ramp_count,ramp_status,raw_properties,quality_flags)
    SELECT 0,source_id,county,geom,width_m,effective_width_m,ramp_count,ramp_status,raw_properties,quality_flags
    FROM shapes WHERE ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND ST_Area(geom)>0
    RETURNING source_id
  `,
    [JSON.stringify(polygons)],
  );
  return new Set(result.rows.map((row) => row.source_id));
}

export interface StoreSidewalkOptions {
  dbUrl: string;
  file: string;
  sha256: string;
  sourceUrl: string;
  dryRun: boolean;
}
export async function storeSidewalkSource(
  options: StoreSidewalkOptions,
): Promise<{
  report: SidewalkReport;
  idempotent: boolean;
  published: boolean;
}> {
  const client = new Client({
    connectionString: options.dbUrl,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET LOCAL lock_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(724193, 1)");
    await client.query(SCHEMA_SQL);
    const report: SidewalkReport = {
      ...emptyCountyReport(),
      archiveSha256: options.sha256,
      sourceBatch: "",
      counties: {},
    };
    for await (const entry of readSidewalkCounties(options.file)) {
      report.sourceBatch = entry.batch;
      const countyReport = emptyCountyReport();
      report.counties[entry.county] = countyReport;
      const seen = new Set<string>();
      let chunk: SidewalkPolygon[] = [];
      const flush = async () => {
        if (!chunk.length) return;
        const accepted = await stageChunk(client, chunk);
        for (const polygon of chunk) {
          if (!accepted.has(polygon.source_id)) {
            countyReport.quarantinedFeatureCount++;
            incrementReason(
              countyReport.reasons,
              "invalid_or_zero_area_topology",
            );
          } else {
            countyReport.acceptedFeatureCount++;
            if (polygon.quality_flags.length)
              countyReport.attributeIssueFeatureCount++;
            for (const reason of polygon.quality_flags)
              incrementReason(countyReport.attributeReasons, reason);
          }
        }
        chunk = [];
      };
      for (const feature of parseCountyCollection(entry.json)) {
        countyReport.rawFeatureCount++;
        const result = cleanSidewalkFeature(feature, entry.county);
        if ("reason" in result) {
          countyReport.quarantinedFeatureCount++;
          incrementReason(countyReport.reasons, result.reason);
          continue;
        }
        const polygon = result.polygon;
        if (seen.has(polygon.source_id)) {
          countyReport.quarantinedFeatureCount++;
          incrementReason(countyReport.reasons, "duplicate");
          continue;
        }
        seen.add(polygon.source_id);
        chunk.push(polygon);
        if (chunk.length >= 200) await flush();
      }
      await flush();
      if (!countyReport.acceptedFeatureCount)
        throw new Error(`county has no accepted polygons: ${entry.county}`);
      report.rawFeatureCount += countyReport.rawFeatureCount;
      report.acceptedFeatureCount += countyReport.acceptedFeatureCount;
      report.quarantinedFeatureCount += countyReport.quarantinedFeatureCount;
      report.attributeIssueFeatureCount +=
        countyReport.attributeIssueFeatureCount;
      for (const [reason, count] of Object.entries(countyReport.reasons))
        report.reasons[reason] = (report.reasons[reason] ?? 0) + count;
      for (const [reason, count] of Object.entries(
        countyReport.attributeReasons,
      ))
        report.attributeReasons[reason] =
          (report.attributeReasons[reason] ?? 0) + count;
    }
    if (
      Object.keys(report.counties).length !== SIDEWALK_COUNTIES.length ||
      report.rawFeatureCount !==
        report.acceptedFeatureCount + report.quarantinedFeatureCount
    )
      throw new Error("source county/row accounting failed");
    const staged = await client.query<{ count: number }>(
      "SELECT count(*)::int count FROM sidewalk_stage",
    );
    if (staged.rows[0].count !== report.acceptedFeatureCount)
      throw new Error("staged source row accounting failed");
    const existing = await client.query<{
      id: string;
      lifecycle_status: string;
    }>(
      "SELECT id,lifecycle_status FROM ped_sidewalk_source_version WHERE archive_sha256=$1",
      [options.sha256],
    );
    const previous = existing.rows[0];
    const idempotent = previous !== undefined;
    if (previous) {
      const stored = await client.query<{ count: number; counties: number }>(
        "SELECT count(*)::int count,count(DISTINCT county)::int counties FROM ped_sidewalk_polygon WHERE source_version_id=$1",
        [previous.id],
      );
      if (
        stored.rows[0].count !== report.acceptedFeatureCount ||
        stored.rows[0].counties !== SIDEWALK_COUNTIES.length
      )
        throw new Error("stored source snapshot integrity failed");
    }
    let published = false;
    let activateId: string | undefined;
    if (!options.dryRun && !previous) {
      const version = await client.query<{ id: string }>(
        `INSERT INTO ped_sidewalk_source_version (archive_sha256,source_url,source_batch,lifecycle_status,report)
        VALUES ($1,$2,$3,'CANDIDATE',$4::jsonb) RETURNING id`,
        [
          options.sha256,
          options.sourceUrl,
          report.sourceBatch,
          JSON.stringify(report),
        ],
      );
      activateId = version.rows[0].id;
      await client.query(
        `INSERT INTO ped_sidewalk_polygon SELECT $1::bigint,source_id,county,geom,width_m,effective_width_m,ramp_count,ramp_status,raw_properties,quality_flags FROM sidewalk_stage`,
        [activateId],
      );
    } else if (!options.dryRun && previous?.lifecycle_status !== "ACTIVE") {
      activateId = previous?.id;
    }
    if (activateId !== undefined) {
      await client.query(
        "UPDATE ped_sidewalk_source_version SET lifecycle_status='RETIRED' WHERE lifecycle_status='ACTIVE'",
      );
      await client.query(
        "UPDATE ped_sidewalk_source_version SET lifecycle_status='ACTIVE' WHERE id=$1",
        [activateId],
      );
      published = true;
    }
    await client.query(options.dryRun ? "ROLLBACK" : "COMMIT");
    return { report, idempotent, published };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
