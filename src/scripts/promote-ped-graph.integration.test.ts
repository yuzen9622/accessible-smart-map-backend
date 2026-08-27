import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  promotePedGraph,
  type PedGraphPromotionClient,
} from "./promote-ped-graph";

const testDatabaseUrl = process.env.PED_GRAPH_TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const VALID_SOURCE_HASH = "a".repeat(64);
const LOCK_TEST_SCHEMA = "ped_graph_promotion_lock_test";

type DatabaseRow = Record<string, unknown>;

function promotionClient(client: Client): PedGraphPromotionClient {
  return {
    query(sql: string, params?: unknown[]) {
      return client.query<DatabaseRow>(sql, params);
    },
  };
}

function generatedMetadata(field: string): string {
  return JSON.stringify({ [field]: { source: "gtfs_pathways" } });
}

function injectedNotes(): string {
  return JSON.stringify({
    outdoor_node_count: 2,
    indoor_node_count: 2,
    connector_node_count: 1,
    node_count: 5,
    outdoor_directed_edge_count: 1,
    indoor_directed_edge_count: 1,
    connector_edge_count: 4,
    directed_edge_count: 6,
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function within<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMilliseconds}ms`));
    }, timeoutMilliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitForPendingTransactionLock(
  observer: Client,
  processId: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE pid = $1
            AND locktype = 'transactionid'
            AND NOT granted
        ) AS waiting
      `,
      [processId],
    );
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await sleep(20);
  }
  throw new Error("promotion did not enter a bounded lifecycle row lock wait");
}

async function setSearchPath(client: Client, schema: string): Promise<void> {
  await client.query("SELECT set_config('search_path', $1, FALSE)", [
    `${schema}, public`,
  ]);
}

async function createTemporaryPromotionTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TEMPORARY TABLE ped_graph_version (
      id BIGINT PRIMARY KEY,
      lifecycle_status TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      directed_edge_count INTEGER NOT NULL,
      indoor_injection_complete BOOLEAN NOT NULL,
      source_hash TEXT NOT NULL,
      notes TEXT
    )
  `);
  await client.query(`
    CREATE TEMPORARY TABLE ped_node (
      node_id BIGINT PRIMARY KEY,
      version_id BIGINT NOT NULL,
      geom TEXT,
      proxy_geom GEOMETRY(Point, 4326) NOT NULL,
      station_id TEXT,
      station_radius_m REAL,
      node_type SMALLINT,
      source_ref TEXT,
      attr_meta JSONB
    )
  `);
  await client.query(`
    CREATE TEMPORARY TABLE ped_edge (
      edge_id BIGINT PRIMARY KEY,
      version_id BIGINT NOT NULL,
      from_node BIGINT NOT NULL,
      to_node BIGINT NOT NULL,
      geom TEXT,
      length_m REAL,
      edge_type SMALLINT,
      slope_longitudinal REAL,
      surface SMALLINT,
      smoothness SMALLINT,
      effective_width_m REAL,
      wheelchair SMALLINT,
      stair_count SMALLINT,
      traversal_time_s REAL,
      has_ramp BOOLEAN,
      is_bidirectional BOOLEAN,
      source_ref TEXT,
      attr_meta JSONB
    )
  `);
}

async function createPersistentPromotionTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE ped_graph_version (
      id BIGINT PRIMARY KEY,
      lifecycle_status TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      directed_edge_count INTEGER NOT NULL,
      indoor_injection_complete BOOLEAN NOT NULL,
      source_hash TEXT NOT NULL,
      notes TEXT
    )
  `);
  await client.query(`
    CREATE TABLE ped_node (
      node_id BIGINT PRIMARY KEY,
      version_id BIGINT NOT NULL,
      geom TEXT,
      proxy_geom GEOMETRY(Point, 4326) NOT NULL,
      station_id TEXT,
      station_radius_m REAL,
      node_type SMALLINT,
      source_ref TEXT,
      attr_meta JSONB
    )
  `);
  await client.query(`
    CREATE TABLE ped_edge (
      edge_id BIGINT PRIMARY KEY,
      version_id BIGINT NOT NULL,
      from_node BIGINT NOT NULL,
      to_node BIGINT NOT NULL,
      geom TEXT,
      length_m REAL,
      edge_type SMALLINT,
      slope_longitudinal REAL,
      surface SMALLINT,
      smoothness SMALLINT,
      effective_width_m REAL,
      wheelchair SMALLINT,
      stair_count SMALLINT,
      traversal_time_s REAL,
      has_ramp BOOLEAN,
      is_bidirectional BOOLEAN,
      source_ref TEXT,
      attr_meta JSONB
    )
  `);
}

async function insertCompleteCandidateRows(
  client: Client,
  versionId: number,
  outdoorTargetNodeId: number,
): Promise<void> {
  const baseNodeId = versionId * 100;
  const baseEdgeId = versionId * 100;
  await client.query(
    `
      INSERT INTO ped_node (
        node_id, version_id, geom, proxy_geom, station_id, station_radius_m,
        node_type, source_ref, attr_meta
      )
      VALUES
        ($1, $2, 'POINT', ST_GeomFromText('POINT(121.5 25)', 4326), NULL, NULL, 1, 'osm:node/outdoor-a', '{}'::jsonb),
        ($3, $2, 'POINT', ST_GeomFromText('POINT(121.501 25)', 4326), NULL, NULL, 4, 'osm:node/outdoor-entrance', '{}'::jsonb),
        ($4, $2, NULL, ST_GeomFromText('POINT(121.502 25)', 4326), 'station-a', 10, 9, 'gtfs_pathways:stop:platform-a', $5::jsonb),
        ($6, $2, 'POINT', ST_GeomFromText('POINT(121.503 25)', 4326), 'station-a', 10, 11, 'gtfs_pathways:stop:entrance-a', $7::jsonb),
        ($8, $2, 'POINT', ST_GeomFromText('POINT(121.504 25)', 4326), 'station-a', 10, 12, 'gtfs_pathways:connector:entrance-a', $9::jsonb)
    `,
    [
      baseNodeId + 1,
      versionId,
      baseNodeId + 2,
      baseNodeId + 3,
      generatedMetadata("node_type"),
      baseNodeId + 4,
      generatedMetadata("node_type"),
      baseNodeId + 5,
      generatedMetadata("connector"),
    ],
  );
  await client.query(
    `
      INSERT INTO ped_edge (
        edge_id, version_id, from_node, to_node, geom, length_m, edge_type,
        traversal_time_s, has_ramp, is_bidirectional, source_ref, attr_meta
      )
      VALUES
        ($1, $2, $3, $4, 'LINE', 12, 2, NULL, FALSE, TRUE, 'osm:way/outdoor', '{}'::jsonb),
        ($5, $2, $6, $7, NULL, NULL, 20, 30, FALSE, FALSE, 'gtfs_pathways:pathway:station-a:forward', $8::jsonb),
        ($9, $2, $7, $10, 'LINE', 5, 2, NULL, FALSE, TRUE, 'gtfs_pathways:connector-edge:entrance-a:forward', $11::jsonb),
        ($12, $2, $10, $7, 'LINE', 5, 2, NULL, FALSE, TRUE, 'gtfs_pathways:connector-edge:entrance-a:reverse', $11::jsonb),
        ($13, $2, $10, $4, 'LINE', 1, 2, NULL, FALSE, TRUE, 'gtfs_pathways:connector-edge:outdoor-a:forward', $11::jsonb),
        ($14, $2, $4, $10, 'LINE', 1, 2, NULL, FALSE, TRUE, 'gtfs_pathways:connector-edge:outdoor-a:reverse', $11::jsonb)
    `,
    [
      baseEdgeId + 1,
      versionId,
      baseNodeId + 1,
      outdoorTargetNodeId,
      baseEdgeId + 2,
      baseNodeId + 3,
      baseNodeId + 4,
      generatedMetadata("edge_type"),
      baseEdgeId + 3,
      baseNodeId + 5,
      generatedMetadata("connector"),
      baseEdgeId + 4,
      baseEdgeId + 5,
      baseEdgeId + 6,
    ],
  );
}

describeWithDatabase("promotePedGraph PostgreSQL transaction", () => {
  it("activates a proxy-eligible NULL GTFS connector and rejects matching-count provenance or loader-semantic corruption", async () => {
    const client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();

    try {
      await createTemporaryPromotionTables(client);
      await client.query(
        `
          INSERT INTO ped_graph_version (
            id, lifecycle_status, node_count, directed_edge_count,
            indoor_injection_complete, source_hash, notes
          )
          VALUES
            (1, 'ACTIVE', 1, 1, TRUE, $1, '{}'),
            (2, 'CANDIDATE', 5, 6, TRUE, $1, $2)
        `,
        [VALID_SOURCE_HASH, injectedNotes()],
      );
      await client.query(
        "INSERT INTO ped_node (node_id, version_id, geom, proxy_geom, node_type, source_ref, attr_meta) VALUES (101, 1, 'POINT', ST_GeomFromText('POINT(121.49 25)', 4326), 1, 'osm:node/active', '{}'::jsonb)",
      );
      await insertCompleteCandidateRows(client, 2, 202);
      // Connector rows are explicitly GTFS-generated indoor provenance. A
      // missing stored geometry is proxy-eligible, unlike an outdoor NULL edge.
      await client.query(`
        UPDATE ped_edge
        SET geom = NULL
        WHERE version_id = 2
          AND starts_with(source_ref, 'gtfs_pathways:connector-edge:')
      `);

      await expect(
        promotePedGraph(promotionClient(client), {
          versionId: 2,
          allowRetired: false,
        }),
      ).resolves.toEqual({
        activeVersionId: 2,
        outcome: "activated",
        previousActiveVersionId: 1,
      });

      const statuses = await client.query<{
        id: number;
        lifecycle_status: string;
      }>(`
        SELECT id::integer AS id, lifecycle_status
        FROM ped_graph_version
        ORDER BY id
      `);
      expect(statuses.rows).toEqual([
        { id: 1, lifecycle_status: "RETIRED" },
        { id: 2, lifecycle_status: "ACTIVE" },
      ]);

      await client.query(
        `
          INSERT INTO ped_graph_version (
            id, lifecycle_status, node_count, directed_edge_count,
            indoor_injection_complete, source_hash, notes
          )
          VALUES (3, 'CANDIDATE', 5, 6, TRUE, $1, $2)
        `,
        [VALID_SOURCE_HASH, injectedNotes()],
      );
      await insertCompleteCandidateRows(client, 3, 101);

      await expect(
        promotePedGraph(promotionClient(client), {
          versionId: 3,
          allowRetired: false,
        }),
      ).rejects.toThrow("cross-version");

      await client.query(
        `
          INSERT INTO ped_graph_version (
            id, lifecycle_status, node_count, directed_edge_count,
            indoor_injection_complete, source_hash, notes
          )
          VALUES (4, 'CANDIDATE', 5, 6, TRUE, $1, $2)
        `,
        [VALID_SOURCE_HASH, injectedNotes()],
      );
      await insertCompleteCandidateRows(client, 4, 402);
      await client.query(`
        UPDATE ped_edge
        SET geom = 'LINE'
        WHERE version_id = 4
          AND starts_with(source_ref, 'gtfs_pathways:pathway:')
      `);

      await expect(
        promotePedGraph(promotionClient(client), {
          versionId: 4,
          allowRetired: false,
        }),
      ).rejects.toThrow(
        "generated pathway edges with incompatible loader fields",
      );

      for (const invalidCandidate of [
        {
          versionId: 5,
          mutation: `
            UPDATE ped_edge
            SET stair_count = -1
            WHERE version_id = $1
              AND starts_with(source_ref, 'gtfs_pathways:pathway:')
          `,
          expectedError: "edges with invalid stair_count",
        },
        {
          versionId: 6,
          mutation: `
            UPDATE ped_node
            SET station_radius_m = 'NaN'::real
            WHERE version_id = $1
              AND starts_with(source_ref, 'gtfs_pathways:stop:')
          `,
          expectedError: "nodes with invalid station_radius_m",
        },
      ]) {
        await client.query(
          `
            INSERT INTO ped_graph_version (
              id, lifecycle_status, node_count, directed_edge_count,
              indoor_injection_complete, source_hash, notes
            )
            VALUES ($1, 'CANDIDATE', 5, 6, TRUE, $2, $3)
          `,
          [invalidCandidate.versionId, VALID_SOURCE_HASH, injectedNotes()],
        );
        await insertCompleteCandidateRows(
          client,
          invalidCandidate.versionId,
          invalidCandidate.versionId * 100 + 2,
        );
        await client.query(invalidCandidate.mutation, [
          invalidCandidate.versionId,
        ]);

        await expect(
          promotePedGraph(promotionClient(client), {
            versionId: invalidCandidate.versionId,
            allowRetired: false,
          }),
        ).rejects.toThrow(invalidCandidate.expectedError);
      }

      await client.query(
        `
          INSERT INTO ped_graph_version (
            id, lifecycle_status, node_count, directed_edge_count,
            indoor_injection_complete, source_hash, notes
          )
          VALUES (7, 'CANDIDATE', 5, 6, TRUE, $1, $2)
        `,
        [VALID_SOURCE_HASH, injectedNotes()],
      );
      await insertCompleteCandidateRows(client, 7, 702);
      const adversarialSource = await client.query(`
        UPDATE ped_node
        SET source_ref = 'gtfsXpathways:stop:platform-a'
        WHERE version_id = 7
          AND starts_with(source_ref, 'gtfs_pathways:stop:')
          AND node_type = 9
      `);
      expect(adversarialSource.rowCount).toBe(1);

      // `gtfsXpathways` differs at the `_` position. It must be classified as
      // outdoor, so its generated-only fields cannot count as valid or promote.
      await expect(
        promotePedGraph(promotionClient(client), {
          versionId: 7,
          allowRetired: false,
        }),
      ).rejects.toThrow("outdoor nodes with incompatible loader fields");

      const afterRollback = await client.query<{
        id: number;
        lifecycle_status: string;
      }>(`
        SELECT id::integer AS id, lifecycle_status
        FROM ped_graph_version
        ORDER BY id
      `);
      expect(afterRollback.rows).toEqual([
        { id: 1, lifecycle_status: "RETIRED" },
        { id: 2, lifecycle_status: "ACTIVE" },
        { id: 3, lifecycle_status: "CANDIDATE" },
        { id: 4, lifecycle_status: "CANDIDATE" },
        { id: 5, lifecycle_status: "CANDIDATE" },
        { id: 6, lifecycle_status: "CANDIDATE" },
        { id: 7, lifecycle_status: "CANDIDATE" },
      ]);
    } finally {
      await client.end();
    }
  });

  it("serializes an injector-like version-row lock and child DML without deadlock", async () => {
    const schema = LOCK_TEST_SCHEMA;
    const setup = new Client({ connectionString: testDatabaseUrl });
    const promoter = new Client({ connectionString: testDatabaseUrl });
    const injector = new Client({ connectionString: testDatabaseUrl });
    const reader = new Client({ connectionString: testDatabaseUrl });
    const observer = new Client({ connectionString: testDatabaseUrl });
    let injectorTransactionStarted = false;
    let promotion: Promise<unknown> | undefined;
    let childDml: Promise<unknown> | undefined;

    await setup.connect();
    try {
      await setup.query(
        "DROP SCHEMA IF EXISTS ped_graph_promotion_lock_test CASCADE",
      );
      await setup.query("CREATE SCHEMA ped_graph_promotion_lock_test");
      await setSearchPath(setup, schema);
      await createPersistentPromotionTables(setup);
      await setup.query(
        `
          INSERT INTO ped_graph_version (
            id, lifecycle_status, node_count, directed_edge_count,
            indoor_injection_complete, source_hash, notes
          )
          VALUES
            (1, 'ACTIVE', 1, 1, TRUE, $1, '{}'),
            (2, 'CANDIDATE', 5, 6, TRUE, $1, $2)
        `,
        [VALID_SOURCE_HASH, injectedNotes()],
      );
      await setup.query(
        "INSERT INTO ped_node (node_id, version_id, geom, proxy_geom, node_type, source_ref, attr_meta) VALUES (101, 1, 'POINT', ST_GeomFromText('POINT(121.49 25)', 4326), 1, 'osm:node/active', '{}'::jsonb)",
      );
      await insertCompleteCandidateRows(setup, 2, 202);

      await Promise.all(
        [promoter, injector, reader, observer].map(async (client) => {
          await client.connect();
          await setSearchPath(client, schema);
        }),
      );
      const processIdResult = await promoter.query<{ process_id: number }>(
        "SELECT pg_backend_pid()::integer AS process_id",
      );
      const promoterProcessId = processIdResult.rows[0]?.process_id;
      expect(Number.isSafeInteger(promoterProcessId)).toBe(true);

      await injector.query("BEGIN");
      injectorTransactionStarted = true;
      await injector.query(
        "SELECT id FROM ped_graph_version WHERE id = $1 FOR UPDATE",
        [2],
      );

      promotion = promotePedGraph(promotionClient(promoter), {
        versionId: 2,
        allowRetired: false,
      });
      await waitForPendingTransactionLock(
        observer,
        promoterProcessId as number,
      );

      await expect(
        within(
          reader.query<{ node_count: number }>(
            "SELECT count(*)::integer AS node_count FROM ped_node",
          ),
          500,
          "reader while promotion waits on the injector lifecycle row",
        ),
      ).resolves.toMatchObject({ rows: [{ node_count: 6 }] });

      childDml = injector.query(
        "UPDATE ped_node SET source_ref = source_ref WHERE node_id = $1",
        [203],
      );
      await expect(
        within(
          childDml,
          750,
          "injector-like child DML before lifecycle row release",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      await injector.query("COMMIT");
      injectorTransactionStarted = false;
      await expect(
        within(promotion, 2_000, "serialized promotion commit"),
      ).resolves.toEqual({
        activeVersionId: 2,
        outcome: "activated",
        previousActiveVersionId: 1,
      });
      await expect(
        reader.query<{
          id: number;
          lifecycle_status: string;
        }>(`
          SELECT id::integer AS id, lifecycle_status
          FROM ped_graph_version
          ORDER BY id
        `),
      ).resolves.toMatchObject({
        rows: [
          { id: 1, lifecycle_status: "RETIRED" },
          { id: 2, lifecycle_status: "ACTIVE" },
        ],
      });
    } finally {
      if (injectorTransactionStarted) {
        await injector.query("ROLLBACK").catch(() => undefined);
      }
      if (promotion !== undefined) {
        await within(
          promotion.catch(() => undefined),
          2_000,
          "promotion cleanup",
        ).catch(() => undefined);
      }
      if (childDml !== undefined) {
        await within(
          childDml.catch(() => undefined),
          2_000,
          "injector child DML cleanup",
        ).catch(() => undefined);
      }
      await Promise.allSettled(
        [promoter, injector, reader, observer].map((client) => client.end()),
      );
      await setup
        .query("DROP SCHEMA IF EXISTS ped_graph_promotion_lock_test CASCADE")
        .catch(() => undefined);
      await setup.end();
    }
  }, 15_000);
});
