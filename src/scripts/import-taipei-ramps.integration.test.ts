import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { rebuildRampEdges } from "./import-taipei-ramps";

const testDatabaseUrl = process.env.PED_GRAPH_TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("rebuildRampEdges against PostGIS", () => {
  let pool: Pool;
  let versionId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ped_ramp_point (
        objectid       BIGINT PRIMARY KEY,
        geom           geometry(Point,4326) NOT NULL,
        town           TEXT,
        source_version TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ped_ramp_edge (
        version_id BIGINT NOT NULL,
        edge_id    BIGINT NOT NULL,
        objectid   BIGINT NOT NULL,
        PRIMARY KEY (version_id, edge_id, objectid)
      )
    `);
    const versionResult = await pool.query<{ id: string }>(
      `INSERT INTO ped_graph_version (source_hash, node_count, directed_edge_count)
       VALUES ('import-taipei-ramps.integration.test', 0, 0)
       RETURNING id`,
    );
    versionId = Number(versionResult.rows[0]?.id);
    await pool.query(
      `INSERT INTO ped_edge
         (edge_id, version_id, from_node, to_node, geom, length_m, edge_type)
       VALUES
         (990001, $1, 1, 2,
          ST_SetSRID(ST_MakeLine(ST_MakePoint(121.5000, 25.0500), ST_MakePoint(121.5010, 25.0500)), 4326),
          100, 3),
         (990002, $1, 3, 4,
          ST_SetSRID(ST_MakeLine(ST_MakePoint(121.6000, 25.1500), ST_MakePoint(121.6010, 25.1500)), 4326),
          100, 3)`,
      [versionId],
    );
    await pool.query(
      `INSERT INTO ped_ramp_point (objectid, geom, town, source_version)
       VALUES
         (1, ST_SetSRID(ST_MakePoint(121.5005, 25.0500), 4326), 'test', 'fixture'),
         (2, ST_SetSRID(ST_MakePoint(121.6005, 25.1500), 4326), 'test', 'fixture')`,
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ped_ramp_edge WHERE version_id = $1`, [
      versionId,
    ]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM ped_ramp_point WHERE objectid IN (1, 2)`);
    await pool.query(`DELETE FROM ped_edge WHERE edge_id IN (990001, 990002)`);
    await pool.query(`DELETE FROM ped_graph_version WHERE id = $1`, [
      versionId,
    ]);
    await pool.end();
  });

  it("maps each synthetic point to exactly its nearest edge", async () => {
    const matchedCount = await rebuildRampEdges(pool, versionId);

    expect(matchedCount).toBe(2);

    const rows = await pool.query<{ objectid: string; edge_id: string }>(
      `SELECT objectid, edge_id FROM ped_ramp_edge WHERE version_id = $1 ORDER BY objectid`,
      [versionId],
    );
    expect(rows.rows).toEqual([
      { objectid: "1", edge_id: "990001" },
      { objectid: "2", edge_id: "990002" },
    ]);
  });

  it("maps a single point to exactly one edge even with a candidate on both sides", async () => {
    await pool.query(
      `INSERT INTO ped_edge
         (edge_id, version_id, from_node, to_node, geom, length_m, edge_type)
       VALUES
         (990003, $1, 5, 6,
          ST_SetSRID(ST_MakeLine(ST_MakePoint(121.5000, 25.0501), ST_MakePoint(121.5010, 25.0501)), 4326),
          100, 3)`,
      [versionId],
    );

    await rebuildRampEdges(pool, versionId);

    const rows = await pool.query<{ edge_id: string }>(
      `SELECT edge_id FROM ped_ramp_edge WHERE version_id = $1 AND objectid = 1`,
      [versionId],
    );
    expect(rows.rows).toHaveLength(1);

    await pool.query(`DELETE FROM ped_edge WHERE edge_id = 990003`);
  });
});
