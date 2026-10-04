import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { RAMP_POINTS_QUERY } from "./graph-loader";
import { HAZARD_EDGES_QUERY } from "./hazard-edges.repository";

const databaseUrl = process.env.PED_GRAPH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "ramp points on the same physical corridor",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: databaseUrl });
    });
    afterAll(async () => {
      await pool.end();
    });

    it("adds the reverse direction without crossing parallel geometry, source or version boundaries", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Temporary relations shadow application tables on this connection only.
        await client.query(`
        CREATE TEMP TABLE ped_edge (edge_id bigint, version_id bigint, from_node bigint,
          to_node bigint, source_ref text, edge_type int, geom geometry(LineString,4326));
        CREATE TEMP TABLE ped_ramp_edge (version_id bigint, edge_id bigint, objectid bigint);
        CREATE TEMP TABLE ped_ramp_point (objectid bigint, geom geometry(Point,4326));
        INSERT INTO ped_edge VALUES
          (10,1,1,2,'osm:way/1',3,ST_GeomFromText('LINESTRING(121.5 25,121.501 25)',4326)),
          (11,1,2,1,'osm:way/1',3,ST_GeomFromText('LINESTRING(121.501 25,121.5 25)',4326)),
          (12,1,2,1,'osm:way/1',3,ST_GeomFromText('LINESTRING(121.501 25,121.5005 25.001,121.5 25)',4326)),
          (13,1,2,1,'osm:way/2',3,ST_GeomFromText('LINESTRING(121.501 25,121.5 25)',4326)),
          (14,2,2,1,'osm:way/1',3,ST_GeomFromText('LINESTRING(121.501 25,121.5 25)',4326)),
          (15,1,3,4,'osm:way/3',2,ST_GeomFromText('LINESTRING(121.6 25,121.601 25)',4326));
        INSERT INTO ped_ramp_point VALUES (1,ST_GeomFromText('POINT(121.5 25)',4326)),
          (2,ST_GeomFromText('POINT(121.6 25)',4326));
        INSERT INTO ped_ramp_edge VALUES (1,10,1),(1,11,1),(1,15,2);
      `);
        const hazardEdges = await client.query(HAZARD_EDGES_QUERY, [
          1,
          [121.5005],
          [25],
          5,
        ]);
        expect(hazardEdges.rows.map((row) => row.edge_id).sort()).toEqual([
          "10",
          "11",
          "13",
        ]);
        const result = await client.query(RAMP_POINTS_QUERY, [1]);
        expect(result.rows.map((row) => row.edge_id).sort()).toEqual([
          "10",
          "11",
          "15",
        ]);
        await client.query("DELETE FROM ped_ramp_edge WHERE edge_id=11");
        const reverseMissing = await client.query(RAMP_POINTS_QUERY, [1]);
        expect(reverseMissing.rows.map((row) => row.edge_id).sort()).toEqual([
          "10",
          "11",
          "15",
        ]);
        expect((await client.query(RAMP_POINTS_QUERY, [2])).rows).toEqual([]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
