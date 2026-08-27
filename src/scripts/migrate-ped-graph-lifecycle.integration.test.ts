import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.PED_GRAPH_TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

async function lifecycleMigration(): Promise<string> {
  return readFile(
    path.join(__dirname, "migrate-ped-graph-lifecycle.sql"),
    "utf8",
  );
}

async function withTemporarySchema(
  run: (client: Client, migration: string) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  await client.query("BEGIN");
  try {
    await run(client, await lifecycleMigration());
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function createLegacyTables(
  client: Client,
  withLifecycleColumns: boolean,
): Promise<void> {
  if (withLifecycleColumns) {
    await client.query(`
      CREATE TEMPORARY TABLE ped_graph_version (
        id BIGINT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        node_count INTEGER NOT NULL,
        directed_edge_count INTEGER NOT NULL,
        notes TEXT,
        lifecycle_status TEXT,
        indoor_injection_complete BOOLEAN
      )
    `);
  } else {
    await client.query(`
      CREATE TEMPORARY TABLE ped_graph_version (
        id BIGINT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        node_count INTEGER NOT NULL,
        directed_edge_count INTEGER NOT NULL,
        notes TEXT
      )
    `);
  }
  await client.query(
    "CREATE TEMPORARY TABLE ped_node (version_id BIGINT, source_ref TEXT)",
  );
  await client.query(
    "CREATE TEMPORARY TABLE ped_edge (version_id BIGINT, source_ref TEXT)",
  );
}

async function insertGeneratedRows(
  client: Client,
  versionId: number,
): Promise<void> {
  await client.query(
    "INSERT INTO ped_node (version_id, source_ref) VALUES ($1, 'gtfs_pathways:stop:station-a')",
    [versionId],
  );
  await client.query(
    "INSERT INTO ped_edge (version_id, source_ref) VALUES ($1, 'gtfs_pathways:pathway:station-a:forward')",
    [versionId],
  );
}

describeWithDatabase("pedestrian graph lifecycle SQL migration", () => {
  it("backfills fresh legacy rows to the newest prior-loader version and remains idempotent", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, false);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, built_at, node_count, directed_edge_count
        )
        VALUES
          (1, 'legacy-one', '2024-01-01T00:00:00Z', 10, 12),
          (2, 'legacy-two', '2025-01-01T00:00:00Z', 20, 24)
      `);
      await insertGeneratedRows(client, 2);

      await client.query(migration);

      const initial = await client.query<{
        id: number;
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        SELECT id::integer AS id, lifecycle_status, indoor_injection_complete
        FROM ped_graph_version
        ORDER BY id
      `);
      expect(initial.rows).toEqual([
        {
          id: 1,
          lifecycle_status: "RETIRED",
          indoor_injection_complete: false,
        },
        { id: 2, lifecycle_status: "ACTIVE", indoor_injection_complete: true },
      ]);

      await client.query(migration);
      const rerun = await client.query<{
        id: number;
        lifecycle_status: string;
      }>(`
        SELECT id::integer AS id, lifecycle_status
        FROM ped_graph_version
        ORDER BY id
      `);
      expect(rerun.rows).toEqual([
        { id: 1, lifecycle_status: "RETIRED" },
        { id: 2, lifecycle_status: "ACTIVE" },
      ]);
    });
  });

  it("does not count gtfsXpathways rows as generated migration evidence", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, true);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, node_count, directed_edge_count,
          lifecycle_status, indoor_injection_complete
        )
        VALUES
          (1, 'active', 10, 12, 'ACTIVE', TRUE),
          (2, 'near-match', 20, 24, NULL, NULL)
      `);
      await client.query(
        "INSERT INTO ped_node (version_id, source_ref) VALUES ($1, 'gtfsXpathways:stop:station-a')",
        [2],
      );
      await client.query(
        "INSERT INTO ped_edge (version_id, source_ref) VALUES ($1, 'gtfsXpathways:pathway:station-a:forward')",
        [2],
      );

      await client.query(migration);

      const rows = await client.query<{
        id: number;
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        SELECT id::integer AS id, lifecycle_status, indoor_injection_complete
        FROM ped_graph_version
        ORDER BY id
      `);
      expect(rows.rows).toEqual([
        { id: 1, lifecycle_status: "ACTIVE", indoor_injection_complete: true },
        {
          id: 2,
          lifecycle_status: "RETIRED",
          indoor_injection_complete: false,
        },
      ]);
    });
  });

  it("backfills only status-null legacy rows before enforcing defaults and NOT NULL", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, true);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, built_at, node_count, directed_edge_count,
          lifecycle_status, indoor_injection_complete
        )
        VALUES
          (1, 'legacy-null', '2024-01-01T00:00:00Z', 10, 12, NULL, NULL),
          (2, 'legacy-blank', '2025-01-01T00:00:00Z', 20, 24, ' ', NULL)
      `);
      await insertGeneratedRows(client, 1);
      await insertGeneratedRows(client, 2);

      await client.query(migration);

      const normalized = await client.query<{
        id: number;
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        SELECT id::integer AS id, lifecycle_status, indoor_injection_complete
        FROM ped_graph_version
        ORDER BY id
      `);
      expect(normalized.rows).toEqual([
        { id: 1, lifecycle_status: "RETIRED", indoor_injection_complete: true },
        { id: 2, lifecycle_status: "ACTIVE", indoor_injection_complete: false },
      ]);

      const candidate = await client.query<{
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        INSERT INTO ped_graph_version (id, source_hash, node_count, directed_edge_count)
        VALUES (3, 'new-build', 30, 36)
        RETURNING lifecycle_status, indoor_injection_complete
      `);
      expect(candidate.rows).toEqual([
        { lifecycle_status: "CANDIDATE", indoor_injection_complete: false },
      ]);
      await client.query("SAVEPOINT lifecycle_status_not_null");
      await expect(
        client.query(
          "UPDATE ped_graph_version SET lifecycle_status = NULL WHERE id = 3",
        ),
      ).rejects.toThrow(/not-null/);
      await client.query("ROLLBACK TO SAVEPOINT lifecycle_status_not_null");
      await client.query("SAVEPOINT injection_complete_not_null");
      await expect(
        client.query(
          "UPDATE ped_graph_version SET indoor_injection_complete = NULL WHERE id = 3",
        ),
      ).rejects.toThrow(/not-null/);
      await client.query("ROLLBACK TO SAVEPOINT injection_complete_not_null");
    });
  });

  it("auto-promotes one complete candidate when it is the only possible active version", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, true);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, node_count, directed_edge_count,
          lifecycle_status, indoor_injection_complete
        )
        VALUES (1, 'complete-candidate', 10, 12, 'CANDIDATE', TRUE)
      `);
      await insertGeneratedRows(client, 1);

      await client.query(migration);

      const result = await client.query<{
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        SELECT lifecycle_status, indoor_injection_complete
        FROM ped_graph_version
        WHERE id = 1
      `);
      expect(result.rows).toEqual([
        { lifecycle_status: "ACTIVE", indoor_injection_complete: true },
      ]);
    });
  });

  it("marks an explicit candidate with NULL completion incomplete even when generated rows exist", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, true);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, node_count, directed_edge_count,
          lifecycle_status, indoor_injection_complete
        )
        VALUES
          (1, 'active', 10, 12, 'ACTIVE', TRUE),
          (2, 'known-candidate', 10, 12, 'CANDIDATE', NULL)
      `);
      await insertGeneratedRows(client, 2);

      await client.query(migration);

      const candidate = await client.query<{
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        SELECT lifecycle_status, indoor_injection_complete
        FROM ped_graph_version
        WHERE id = 2
      `);
      expect(candidate.rows).toEqual([
        { lifecycle_status: "CANDIDATE", indoor_injection_complete: false },
      ]);
    });
  });

  it("fails instead of auto-promoting a known candidate with NULL completion", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, true);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, node_count, directed_edge_count,
          lifecycle_status, indoor_injection_complete
        )
        VALUES (1, 'known-candidate', 10, 12, 'CANDIDATE', NULL)
      `);
      await insertGeneratedRows(client, 1);
      await client.query("SAVEPOINT incomplete_candidate");

      await expect(client.query(migration)).rejects.toThrow(
        "will not auto-promote an incomplete candidate",
      );
      await client.query("ROLLBACK TO SAVEPOINT incomplete_candidate");

      const afterFailure = await client.query<{
        indoor_injection_complete: boolean | null;
        lifecycle_status: string;
      }>(`
        SELECT lifecycle_status, indoor_injection_complete
        FROM ped_graph_version
        WHERE id = 1
      `);
      expect(afterFailure.rows).toEqual([
        { lifecycle_status: "CANDIDATE", indoor_injection_complete: null },
      ]);
    });
  });

  it("recreates target lifecycle objects instead of trusting same-named decoys", async () => {
    await withTemporarySchema(async (client, migration) => {
      await createLegacyTables(client, false);
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, node_count, directed_edge_count
        )
        VALUES (1, 'legacy', 10, 12)
      `);
      await client.query(
        "CREATE TEMPORARY TABLE lifecycle_decoy (lifecycle_status TEXT)",
      );
      await client.query(`
        ALTER TABLE lifecycle_decoy
          ADD CONSTRAINT ped_graph_version_lifecycle_status_check
          CHECK (lifecycle_status = 'RETIRED')
      `);
      await client.query(`
        CREATE UNIQUE INDEX ped_graph_version_one_active_idx
          ON lifecycle_decoy ((1))
          WHERE lifecycle_status = 'RETIRED'
      `);

      await client.query(migration);

      const definitions = await client.query<{
        active_predicate: string;
        check_on_target: boolean;
        index_on_target: boolean;
      }>(`
        SELECT
          constraint_definition.conrelid = 'ped_graph_version'::regclass
            AS check_on_target,
          index_definition.indrelid = 'ped_graph_version'::regclass
            AS index_on_target,
          pg_get_expr(index_definition.indpred, index_definition.indrelid)
            AS active_predicate
        FROM pg_constraint AS constraint_definition
        CROSS JOIN pg_index AS index_definition
        INNER JOIN pg_class AS index_relation
          ON index_relation.oid = index_definition.indexrelid
        WHERE constraint_definition.conrelid = 'ped_graph_version'::regclass
          AND constraint_definition.conname =
            'ped_graph_version_lifecycle_status_check'
          AND index_relation.relname = 'ped_graph_version_one_active_idx'
          AND index_relation.relnamespace = pg_my_temp_schema()
      `);
      expect(definitions.rows).toHaveLength(1);
      expect(definitions.rows[0]).toMatchObject({
        check_on_target: true,
        index_on_target: true,
      });
      expect(definitions.rows[0]?.active_predicate).toContain(
        "lifecycle_status",
      );
      expect(definitions.rows[0]?.active_predicate).toContain("ACTIVE");

      await client.query("SAVEPOINT lifecycle_check_definition");
      await expect(
        client.query(
          "UPDATE ped_graph_version SET lifecycle_status = 'BROKEN' WHERE id = 1",
        ),
      ).rejects.toThrow(/check/);
      await client.query("ROLLBACK TO SAVEPOINT lifecycle_check_definition");
      await client.query(`
        INSERT INTO ped_graph_version (
          id, source_hash, node_count, directed_edge_count
        )
        VALUES (2, 'candidate', 20, 24)
      `);
      await client.query("SAVEPOINT one_active_index_definition");
      await expect(
        client.query(
          "UPDATE ped_graph_version SET lifecycle_status = 'ACTIVE' WHERE id = 2",
        ),
      ).rejects.toThrow(/duplicate key/);
      await client.query("ROLLBACK TO SAVEPOINT one_active_index_definition");
    });
  });
});
