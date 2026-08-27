import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.PED_GRAPH_TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("pedestrian graph schema", () => {
  it("creates candidate defaults and the database-level one-active guard in temporary tables", async () => {
    const schema = await readFile(
      path.join(__dirname, "ped-graph-schema.sql"),
      "utf8",
    );
    const temporarySchema = schema
      .replace("CREATE EXTENSION IF NOT EXISTS postgis;\n\n", "")
      .replace(/CREATE TABLE/g, "CREATE TEMPORARY TABLE");
    const client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
    await client.query("BEGIN");

    try {
      await client.query(temporarySchema);
      const candidate = await client.query<{
        id: number;
        indoor_injection_complete: boolean;
        lifecycle_status: string;
      }>(`
        INSERT INTO ped_graph_version (source_hash, node_count, directed_edge_count)
        VALUES ('candidate', 0, 0)
        RETURNING
          id::integer AS id,
          lifecycle_status,
          indoor_injection_complete
      `);
      expect(candidate.rows).toEqual([
        {
          id: 1,
          lifecycle_status: "CANDIDATE",
          indoor_injection_complete: false,
        },
      ]);

      await client.query(
        "UPDATE ped_graph_version SET lifecycle_status = 'ACTIVE' WHERE id = 1",
      );
      await client.query(`
        INSERT INTO ped_graph_version
          (id, source_hash, node_count, directed_edge_count, lifecycle_status)
        VALUES (2, 'second', 0, 0, 'CANDIDATE')
      `);
      await expect(
        client.query(
          "UPDATE ped_graph_version SET lifecycle_status = 'ACTIVE' WHERE id = 2",
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
