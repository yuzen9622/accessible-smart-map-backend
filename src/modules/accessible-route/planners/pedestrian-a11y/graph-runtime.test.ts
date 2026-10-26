import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./graph-loader", () => ({ loadPedGraph: vi.fn() }));
vi.mock("pg", () => ({ Pool: vi.fn() }));

import { Pool } from "pg";
import { loadPedGraph, type PedGraphQueryable } from "./graph-loader";
import {
  closePedGraphRuntime,
  getPedGraphClient,
  getPedGraphRuntime,
  resetPedGraphRuntime,
  setPedGraphClientProvider,
} from "./graph-runtime";
import { NODE_FLAG, type PedGraph } from "./graph.types";

/**
 * @param versionId Graph version the fake load should report.
 * @returns A minimal two-node CSR graph.
 */
function fakeGraph(versionId: number): PedGraph {
  return {
    versionId,
    nodeCount: 2,
    directedEdgeCount: 1,
    undirectedEdgeCount: 1,
    nodeLon: Float64Array.from([121.55, 121.551]),
    nodeLat: Float64Array.from([25.04, 25.041]),
    nodeFlags: Uint8Array.from([
      NODE_FLAG.HAS_REAL_GEOM,
      NODE_FLAG.HAS_REAL_GEOM,
    ]),
    nodeStationId: Int32Array.from([-1, -1]),
    stationIds: Object.freeze([]),
    stationRadiusM: Float32Array.from([]),
    originalNodeId: BigInt64Array.from([0n, 1n]),
    adjOffset: Int32Array.from([0, 1, 1]),
    adjTarget: Int32Array.from([1]),
    adjAttr: Int32Array.from([0]),
    edgeOriginalId: BigInt64Array.from([1000n]),
    edgeLengthM: Float32Array.from([110]),
    edgeType: Uint8Array.from([1]),
    edgeSlope: Float32Array.from([Number.NaN]),
    edgeSurface: new Uint8Array(1),
    edgeSmoothness: new Uint8Array(1),
    edgeWidthM: Float32Array.from([Number.NaN]),
    edgeWheelchair: new Uint8Array(1),
    edgeStairCount: new Uint16Array(1),
    edgeTraversalTimeS: Float32Array.from([Number.NaN]),
    edgeFlags: new Uint8Array(1),
    edgeSidewalkId: Int32Array.from([-1]),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(1),
    edgeStreetName: Int32Array.from([-1]),
    streetNames: Object.freeze([]),
    edgeRampPoints: new Map(),
  };
}

/**
 * @param activeVersionIds Version to report per ACTIVE-version query, in order.
 * @returns A client plus its recorded query count.
 */
function versionClient(activeVersionIds: (number | null)[]): {
  client: PedGraphQueryable;
  queryCount: () => number;
} {
  let calls = 0;
  return {
    queryCount: () => calls,
    client: {
      query: <R>() => {
        const versionId =
          activeVersionIds[Math.min(calls, activeVersionIds.length - 1)];
        calls += 1;
        return Promise.resolve({
          rows: (versionId === null ? [] : [{ id: versionId }]) as R[],
        });
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Pool).mockReset();
  resetPedGraphRuntime();
  setPedGraphClientProvider(null);
  delete process.env.PED_GRAPH_DATABASE_URL;
  delete process.env.PED_GRAPH_LOAD_TIMEOUT_MS;
  delete process.env.PED_GRAPH_REFRESH_INTERVAL_MS;
});

afterEach(async () => {
  await closePedGraphRuntime();
  setPedGraphClientProvider(null);
  delete process.env.PED_GRAPH_DATABASE_URL;
  delete process.env.PED_GRAPH_LOAD_TIMEOUT_MS;
  delete process.env.PED_GRAPH_REFRESH_INTERVAL_MS;
});

describe("getPedGraphRuntime", () => {
  it("reports unavailable when no database URL and no provider are configured", async () => {
    const result = await getPedGraphRuntime();

    expect(result).toEqual({
      status: "unavailable",
      reason: "PED_GRAPH_DATABASE_URL is not configured",
    });
    expect(loadPedGraph).not.toHaveBeenCalled();
  });

  it("loads the graph once and reuses the snapshot with its spatial index", async () => {
    vi.mocked(loadPedGraph).mockResolvedValue(fakeGraph(4));
    const { client } = versionClient([4]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    const first = await getPedGraphRuntime();
    const second = await getPedGraphRuntime();

    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.snapshot.graph.versionId).toBe(4);
    expect(first.snapshot.index.indexedEdgeCount).toBe(1);
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.snapshot).toBe(first.snapshot);
    expect(loadPedGraph).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    vi.mocked(loadPedGraph).mockResolvedValue(fakeGraph(4));
    const { client } = versionClient([4]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    const [first, second] = await Promise.all([
      getPedGraphRuntime(),
      getPedGraphRuntime(),
    ]);

    expect(first).toEqual(second);
    expect(loadPedGraph).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when the load throws and nothing is cached", async () => {
    vi.mocked(loadPedGraph).mockRejectedValue(new Error("graph integrity"));
    const { client } = versionClient([4]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    await expect(getPedGraphRuntime()).resolves.toEqual({
      status: "unavailable",
      reason: "graph integrity",
    });
  });

  it("reports unavailable when a cold graph load exceeds the configured timeout", async () => {
    process.env.PED_GRAPH_LOAD_TIMEOUT_MS = "1";
    vi.mocked(loadPedGraph).mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const { client } = versionClient([4]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    await expect(getPedGraphRuntime()).resolves.toEqual({
      status: "unavailable",
      reason: "pedestrian graph load exceeded 1ms",
    });
  });

  it("rebuilds the snapshot when the ACTIVE version was promoted away", async () => {
    process.env.PED_GRAPH_REFRESH_INTERVAL_MS = "1";
    vi.mocked(loadPedGraph).mockResolvedValue(fakeGraph(4));
    // The initial load never queries the ACTIVE version (the loader is faked),
    // so the first query this client answers is the freshness check itself.
    const { client } = versionClient([9]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    const first = await getPedGraphRuntime();
    expect(first.status).toBe("ready");

    vi.mocked(loadPedGraph).mockResolvedValue(fakeGraph(9));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await getPedGraphRuntime();

    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.snapshot.graph.versionId).toBe(9);
    expect(loadPedGraph).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the cached graph when a freshness check fails", async () => {
    process.env.PED_GRAPH_REFRESH_INTERVAL_MS = "1";
    vi.mocked(loadPedGraph).mockResolvedValue(fakeGraph(4));
    let freshnessChecks = 0;
    setPedGraphClientProvider(() =>
      Promise.resolve({
        query: () => {
          freshnessChecks += 1;
          return Promise.reject(new Error("connection terminated"));
        },
      }),
    );

    const first = await getPedGraphRuntime();
    expect(first.status).toBe("ready");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await getPedGraphRuntime();

    expect(freshnessChecks).toBe(1);

    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.snapshot.graph.versionId).toBe(4);
  });

  it("reloads after the cache is reset", async () => {
    vi.mocked(loadPedGraph).mockResolvedValue(fakeGraph(4));
    const { client } = versionClient([4]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    await getPedGraphRuntime();
    resetPedGraphRuntime();
    await getPedGraphRuntime();

    expect(loadPedGraph).toHaveBeenCalledTimes(2);
  });
});

describe("closePedGraphRuntime", () => {
  it("ends a default pool once and remains idempotent", async () => {
    process.env.PED_GRAPH_DATABASE_URL = "postgres://ped-graph.test/ped";
    const end = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Pool).mockImplementation(function MockPool() {
      return {
        query: vi.fn(),
        end,
      } as never;
    });

    await getPedGraphClient();
    await closePedGraphRuntime();
    await closePedGraphRuntime();

    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("getPedGraphClient", () => {
  it("returns the injected provider client without opening a pool", async () => {
    const { client } = versionClient([4]);
    setPedGraphClientProvider(() => Promise.resolve(client));

    await expect(getPedGraphClient()).resolves.toBe(client);
  });

  it("rejects when no database URL is configured for the default provider", async () => {
    await expect(getPedGraphClient()).rejects.toThrow(
      "PED_GRAPH_DATABASE_URL is not configured",
    );
  });
});
