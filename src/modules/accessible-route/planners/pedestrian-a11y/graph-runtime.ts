import { getPedGraphConfig } from "../../../../config/ped-graph";
import { loadPedGraph, type PedGraphQueryable } from "./graph-loader";
import type { PedGraph } from "./graph.types";
import { buildEdgeIndex, type EdgeIndex } from "./spatial-index";

const ACTIVE_VERSION_ID_QUERY = `
  SELECT id
  FROM ped_graph_version
  WHERE lifecycle_status = 'ACTIVE'
  ORDER BY built_at DESC, id DESC
  LIMIT 1
`;

/** A loaded graph plus its spatial index, reused across requests. */
export interface PedGraphSnapshot {
  graph: PedGraph;
  index: EdgeIndex;
  loadedAtMs: number;
}

export type PedGraphRuntimeResult =
  | { status: "ready"; snapshot: PedGraphSnapshot }
  | { status: "unavailable"; reason: string };

/** Client provider; replaceable so tests never open a real connection. */
export type PedGraphClientProvider = () => Promise<PedGraphQueryable>;

interface RuntimeState {
  snapshot: PedGraphSnapshot | null;
  /** Last time the ACTIVE version identifier was confirmed still current. */
  verifiedAtMs: number;
  inFlight: Promise<PedGraphRuntimeResult> | null;
}

const state: RuntimeState = {
  snapshot: null,
  verifiedAtMs: 0,
  inFlight: null,
};

interface PedGraphPool {
  client: PedGraphQueryable;
  end: () => Promise<void>;
}

let clientProvider: PedGraphClientProvider | null = null;
let pool: PedGraphPool | null = null;

/**
 * Inject a client provider, replacing the default pooled PostGIS connection.
 *
 * @param provider Provider to use, or null to restore the default pool.
 * @returns Nothing.
 */
export function setPedGraphClientProvider(
  provider: PedGraphClientProvider | null,
): void {
  clientProvider = provider;
}

/**
 * Drop the cached graph, index, and single-flight state.
 *
 * @returns Nothing.
 */
export function resetPedGraphRuntime(): void {
  state.snapshot = null;
  state.verifiedAtMs = 0;
  state.inFlight = null;
}

/**
 * Close the pooled PostGIS connection, if the default provider opened one.
 *
 * @returns Nothing.
 */
export async function closePedGraphRuntime(): Promise<void> {
  const current = pool;
  pool = null;
  resetPedGraphRuntime();
  if (current) await current.end();
}

/**
 * @returns A pooled PostGIS client for the configured graph database.
 */
async function defaultClient(): Promise<PedGraphQueryable> {
  if (pool) return pool.client;
  const { databaseUrl } = getPedGraphConfig();
  if (databaseUrl === null) {
    throw new Error("PED_GRAPH_DATABASE_URL is not configured");
  }
  const { Pool } = await import("pg");
  const created = new Pool({ connectionString: databaseUrl });
  const opened: PedGraphPool = {
    client: {
      async query<R>(sql: string, params?: unknown[]) {
        const result = await created.query(sql, params);
        return { rows: result.rows as R[] };
      },
    },
    end: () => created.end(),
  };
  pool = opened;
  return opened.client;
}

/**
 * Resolve the queryable client the runtime plans against.
 *
 * Exposed so callers that need a version-scoped follow-up read (selected edge
 * geometry) use the same injected client as the graph load, and therefore the
 * same test seam, instead of opening a second connection of their own.
 *
 * @returns The injected or pooled PostGIS client.
 */
export function getPedGraphClient(): Promise<PedGraphQueryable> {
  return (clientProvider ?? defaultClient)();
}

/**
 * @param work Promise to bound.
 * @param timeoutMs Wall-clock ceiling in milliseconds.
 * @param label Operation name used in the timeout message.
 * @returns The promise value, or a rejection once the ceiling elapses.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param client Queryable PostGIS client.
 * @returns The ACTIVE graph version identifier, or null when none is promoted.
 */
async function readActiveVersionId(
  client: PedGraphQueryable,
): Promise<number | null> {
  const result = await client.query<{ id: unknown }>(ACTIVE_VERSION_ID_QUERY);
  const raw = result.rows[0]?.id;
  if (raw == null) return null;
  const versionId = Number(raw);
  return Number.isSafeInteger(versionId) ? versionId : null;
}

/**
 * @param reason Human-readable cause recorded for the caller's diagnostics.
 * @returns An unavailable runtime result.
 */
function unavailable(reason: string): PedGraphRuntimeResult {
  return { status: "unavailable", reason };
}

/**
 * @param nowMs Current epoch milliseconds.
 * @returns A freshly loaded snapshot, or an unavailable result.
 */
async function loadSnapshot(nowMs: number): Promise<PedGraphRuntimeResult> {
  const { loadTimeoutMs } = getPedGraphConfig();
  const client = await (clientProvider ?? defaultClient)();
  const graph = await withTimeout(
    loadPedGraph(client),
    loadTimeoutMs,
    "pedestrian graph load",
  );
  const snapshot: PedGraphSnapshot = {
    graph,
    index: buildEdgeIndex(graph),
    loadedAtMs: nowMs,
  };
  state.snapshot = snapshot;
  state.verifiedAtMs = nowMs;
  return { status: "ready", snapshot };
}

/**
 * @param cached Snapshot currently held in the cache.
 * @param nowMs Current epoch milliseconds.
 * @returns The cached snapshot when still ACTIVE, otherwise a reloaded one.
 */
async function refreshSnapshot(
  cached: PedGraphSnapshot,
  nowMs: number,
): Promise<PedGraphRuntimeResult> {
  const { loadTimeoutMs } = getPedGraphConfig();
  const client = await (clientProvider ?? defaultClient)();
  const activeVersionId = await withTimeout(
    readActiveVersionId(client),
    loadTimeoutMs,
    "pedestrian graph active-version check",
  );
  if (activeVersionId === cached.graph.versionId) {
    state.verifiedAtMs = nowMs;
    return { status: "ready", snapshot: cached };
  }
  // A promotion or retirement happened: the cached CSR arrays describe a
  // version that is no longer the one being served, so reload rather than
  // silently keep planning against retired graph data.
  state.snapshot = null;
  return loadSnapshot(nowMs);
}

/**
 * Resolve the ACTIVE CSR pedestrian graph and its spatial index.
 *
 * The graph and its Flatbush index are loaded at most once per version and
 * reused for every later request. Concurrent callers share a single in-flight
 * load (single flight), so a cold start cannot fan out into N parallel full
 * graph reads. Once `refreshIntervalMs` has elapsed the ACTIVE version is
 * re-checked with one cheap query and the CSR arrays are rebuilt only when the
 * promoted version actually changed.
 *
 * Any configuration, connection, timeout, or integrity failure is reported as
 * `unavailable` so the caller can fall back rather than fail the request.
 *
 * @returns The ready snapshot, or an unavailable result with its reason.
 */
export async function getPedGraphRuntime(): Promise<PedGraphRuntimeResult> {
  if (state.inFlight) return state.inFlight;

  const { databaseUrl, refreshIntervalMs } = getPedGraphConfig();
  if (databaseUrl === null && clientProvider === null) {
    return unavailable("PED_GRAPH_DATABASE_URL is not configured");
  }

  const nowMs = Date.now();
  const cached = state.snapshot;
  if (cached && nowMs - state.verifiedAtMs < refreshIntervalMs) {
    return { status: "ready", snapshot: cached };
  }

  const attempt = (
    cached ? refreshSnapshot(cached, nowMs) : loadSnapshot(nowMs)
  )
    .catch((error: unknown) => {
      // A failed refresh must not discard a usable cached graph: serving the
      // previously verified ACTIVE version beats degrading every request to OTP.
      if (state.snapshot) {
        state.verifiedAtMs = nowMs;
        return { status: "ready" as const, snapshot: state.snapshot };
      }
      return unavailable(
        error instanceof Error ? error.message : "pedestrian graph load failed",
      );
    })
    .finally(() => {
      state.inFlight = null;
    });

  state.inFlight = attempt;
  return attempt;
}
