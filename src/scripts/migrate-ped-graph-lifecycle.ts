import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

/**
 * @param dbUrl PostGIS connection URI.
 * @returns Nothing after applying the lifecycle migration atomically.
 */
export async function applyPedGraphLifecycleMigration(
  dbUrl: string,
): Promise<void> {
  const sql = await readFile(
    path.join(__dirname, "migrate-ped-graph-lifecycle.sql"),
    "utf8",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(sql);
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * @returns Process exit status.
 */
async function main(): Promise<void> {
  const dbUrl = process.env.PED_GRAPH_DATABASE_URL;
  if (!dbUrl) {
    throw new Error("PED_GRAPH_DATABASE_URL is required");
  }
  await applyPedGraphLifecycleMigration(dbUrl);
  console.log("[migrate-ped-graph-lifecycle] applied");
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[migrate-ped-graph-lifecycle] ${message}`);
    process.exitCode = 1;
  });
}
