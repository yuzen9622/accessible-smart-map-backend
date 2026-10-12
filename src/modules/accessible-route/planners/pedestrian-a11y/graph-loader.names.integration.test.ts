import { execFileSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadPedGraph } from "./graph-loader";

// Never reuse PED_GRAPH_DATABASE_URL: this test requires a dedicated local DB.
const databaseUrl = process.env.PED_NAMES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "source street names with isolated PostGIS",
  () => {
    it("loads legacy/new lookup schemas and idempotent source updates without altering graph facts", async () => {
      if (!databaseUrl)
        throw new Error("A dedicated test database is required");
      const target = new URL(databaseUrl);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
        !/^\/i18n_names_test[a-zA-Z0-9_]*$/.test(target.pathname)
      ) {
        throw new Error(
          "Use a local dedicated database named i18n_names_test* only",
        );
      }
      const script = path.resolve("src/scripts/backfill-osm-way-names.py");
      const sql: { create: string; alter: string; upsert: string } = JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("names", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
print(json.dumps({"create": module.CREATE_TABLE_SQL, "alter": module.ADD_ENGLISH_COLUMN_SQL, "upsert": module.UPSERT_SQL}))
`,
            script,
          ],
          { encoding: "utf8" },
        ),
      );
      const pool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5000,
      });
      try {
        const client = await pool.connect();
        try {
          // Extension must already be provisioned in this disposable test database.
          await client.query("SELECT postgis_version()");
          await client.query(`
          CREATE TEMP TABLE ped_graph_version (
            id integer, node_count integer, directed_edge_count integer,
            lifecycle_status text, built_at timestamptz DEFAULT now()
          );
          INSERT INTO ped_graph_version VALUES (1, 3, 3, 'ACTIVE', now());
          CREATE TEMP TABLE ped_node (
            version_id integer, node_id bigint, geom geometry(Point, 4326),
            proxy_geom geometry(Point, 4326), station_id text,
            station_radius_m real, node_type integer
          );
          INSERT INTO ped_node (version_id,node_id,geom,node_type) VALUES
            (1,1,ST_SetSRID(ST_Point(121.5,25.05),4326),1),
            (1,2,ST_SetSRID(ST_Point(121.501,25.05),4326),1),
            (1,3,ST_SetSRID(ST_Point(121.502,25.05),4326),1);
          CREATE TEMP TABLE ped_edge (
            version_id integer, edge_id bigint, from_node bigint, to_node bigint,
            is_bidirectional boolean, length_m real, edge_type integer,
            slope_longitudinal real, surface integer, smoothness integer,
            effective_width_m real, wheelchair integer, stair_count integer,
            traversal_time_s real, has_ramp boolean, source_ref text, attr_meta jsonb
          );
          INSERT INTO ped_edge (version_id,edge_id,from_node,to_node,is_bidirectional,length_m,edge_type,has_ramp,source_ref) VALUES
            (1,1,1,2,false,100,1,false,'osm:way/101'),
            (1,2,2,3,false,100,1,false,'osm:way/102'),
            (1,3,3,2,false,100,1,false,'gtfs_pathways:pathway:9995:reverse');
          CREATE TEMP TABLE ped_osm_way_name (osm_way_id bigint PRIMARY KEY, name text NOT NULL, source_version text NOT NULL);
          INSERT INTO ped_osm_way_name VALUES (101,'中正路','old'), (102,'中正路','old');
        `);
          // Unqualified script DDL must stay in this connection's temporary schema.
          await client.query("SET search_path TO pg_temp, public");
          const legacy = await loadPedGraph(client, 1);
          expect(legacy.streetNames).toEqual(["中正路"]);
          expect(legacy.streetNamesEn).toEqual([]);
          expect(Array.from(legacy.edgeStreetName)).toEqual([0, 0, -1]);
          const beforeRows = await client.query(
            "SELECT * FROM ped_edge ORDER BY edge_id",
          );
          // These are the script's actual DDL statements, repeated as on a rerun.
          for (let run = 0; run < 2; run += 1) {
            await client.query(sql.create);
            await client.query(sql.alter);
          }
          const upsert = sql.upsert.replace(
            "VALUES %s",
            "VALUES ($1, $2, $3, $4)",
          );
          for (let run = 0; run < 2; run += 1) {
            await client.query(upsert, [
              101,
              "中正路",
              "Zhongzheng Road",
              "new",
            ]);
            await client.query(upsert, [
              102,
              "中正路",
              "Jhongjheng Road",
              "new",
            ]);
          }
          const bilingual = await loadPedGraph(client, 1);
          expect(bilingual.streetNamesEn).toEqual([
            "Zhongzheng Road",
            "Jhongjheng Road",
          ]);
          expect(Array.from(bilingual.edgeStreetNameEn ?? [])).toEqual([
            0, 1, -1,
          ]);
          const {
            edgeStreetNameEn: _oldEn,
            streetNamesEn: _oldNames,
            ...oldFacts
          } = legacy;
          const {
            edgeStreetNameEn: _newEn,
            streetNamesEn: _newNames,
            ...newFacts
          } = bilingual;
          expect(newFacts).toEqual(oldFacts);
          expect(
            (await client.query("SELECT * FROM ped_edge ORDER BY edge_id"))
              .rows,
          ).toEqual(beforeRows.rows);
          expect(
            (
              await client.query(
                "SELECT count(*)::integer AS count FROM ped_osm_way_name",
              )
            ).rows[0].count,
          ).toBe(2);
          await client.query(upsert, [101, "中正路", null, "later"]);
          const refreshed = await loadPedGraph(client, 1);
          expect(refreshed.streetNamesEn).toEqual(["Jhongjheng Road"]);
          expect(Array.from(refreshed.edgeStreetNameEn ?? [])).toEqual([
            -1, 0, -1,
          ]);
          expect(bilingual.streetNamesEn).toEqual([
            "Zhongzheng Road",
            "Jhongjheng Road",
          ]);
          await client.query("DROP TABLE pg_temp.ped_osm_way_name");
          const absent = await loadPedGraph(client, 1);
          expect(absent.streetNames).toEqual([]);
          await client.query(sql.create);
          await client.query(sql.alter);
          await client.query(upsert, [
            101,
            "來源 ' 路",
            "Source ' Road",
            "fresh",
          ]);
          const fresh = await loadPedGraph(client, 1);
          expect(fresh.streetNames).toEqual(["來源 ' 路"]);
          expect(fresh.streetNamesEn).toEqual(["Source ' Road"]);
          expect(
            (await client.query("SELECT * FROM ped_edge ORDER BY edge_id"))
              .rows,
          ).toEqual(beforeRows.rows);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    }, 30_000);
  },
);
