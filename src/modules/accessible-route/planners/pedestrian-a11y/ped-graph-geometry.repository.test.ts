import { describe, expect, it, vi } from "vitest";
import type { PedGraphQueryable } from "./graph-loader";
import { findPedEdgeGeometries } from "./ped-graph-geometry.repository";

interface QueryCall {
  sql: string;
  params?: unknown[];
}

/**
 * @param rows Rows the fake client should return, in the given order.
 * @returns A queryable client plus the recorded calls.
 */
function recordingClient(rows: { edge_id: unknown; geojson: unknown }[]): {
  client: PedGraphQueryable;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  return {
    calls,
    client: {
      query: <R>(sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: rows as R[] });
      },
    },
  };
}

/**
 * @param coordinates Ordered longitude/latitude pairs.
 * @returns A `ST_AsGeoJSON` LineString payload.
 */
function lineString(coordinates: [number, number][]): string {
  return JSON.stringify({ type: "LineString", coordinates });
}

describe("findPedEdgeGeometries", () => {
  it("returns nothing and issues no query for an empty edge list", async () => {
    const { client, calls } = recordingClient([]);

    await expect(findPedEdgeGeometries(client, 3, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("scopes the read to the requested graph version", async () => {
    const { client, calls } = recordingClient([]);

    await findPedEdgeGeometries(client, 42, [7n]);

    expect(calls).toHaveLength(1);
    expect(calls[0].params?.[0]).toBe(42);
    expect(calls[0].params?.[1]).toEqual(["7"]);
  });

  it("aligns results to the requested traversal order, not the row order", async () => {
    const first = lineString([
      [121.5, 25],
      [121.51, 25.01],
    ]);
    const second = lineString([
      [121.51, 25.01],
      [121.52, 25.02],
    ]);
    const { client } = recordingClient([
      { edge_id: "20", geojson: second },
      { edge_id: "10", geojson: first },
    ]);

    const result = await findPedEdgeGeometries(client, 1, [10n, 20n]);

    expect(result).toEqual([
      {
        status: "line",
        points: [
          [121.5, 25],
          [121.51, 25.01],
        ],
      },
      {
        status: "line",
        points: [
          [121.51, 25.01],
          [121.52, 25.02],
        ],
      },
    ]);
  });

  it("deduplicates the query parameter while repeating the shared geometry", async () => {
    const geometry = lineString([
      [121.5, 25],
      [121.51, 25.01],
    ]);
    const { client, calls } = recordingClient([
      { edge_id: "10", geojson: geometry },
    ]);

    const result = await findPedEdgeGeometries(client, 1, [10n, 10n]);

    expect(calls[0].params?.[1]).toEqual(["10"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(result[1]);
  });

  it("returns null for an edge the version does not carry", async () => {
    const { client } = recordingClient([]);

    await expect(findPedEdgeGeometries(client, 1, [99n])).resolves.toEqual([
      { status: "missing" },
    ]);
  });

  it("distinguishes an explicit NULL indoor geometry", async () => {
    const { client } = recordingClient([{ edge_id: "10", geojson: null }]);

    await expect(findPedEdgeGeometries(client, 1, [10n])).resolves.toEqual([
      { status: "null" },
    ]);
  });

  it.each([
    ["an empty string", ""],
    ["malformed JSON", "{not json"],
    ["a non-LineString geometry", JSON.stringify({ type: "Point" })],
    [
      "a degenerate single-vertex line",
      JSON.stringify({ type: "LineString", coordinates: [[121.5, 25]] }),
    ],
    [
      "a non-finite ordinate",
      JSON.stringify({
        type: "LineString",
        coordinates: [
          [121.5, 25],
          ["x", 25.01],
        ],
      }),
    ],
  ])(
    "reports malformed rather than fabricating a line for %s",
    async (_label, geojson) => {
      const { client } = recordingClient([{ edge_id: "10", geojson }]);

      await expect(findPedEdgeGeometries(client, 1, [10n])).resolves.toEqual([
        { status: "malformed" },
      ]);
    },
  );

  it("preserves stored coordinate order without reorienting the line", async () => {
    const descending: [number, number][] = [
      [121.52, 25.02],
      [121.51, 25.01],
      [121.5, 25],
    ];
    const { client } = recordingClient([
      { edge_id: "10", geojson: lineString(descending) },
    ]);

    const result = await findPedEdgeGeometries(client, 1, [10n]);

    expect(result[0]).toEqual({ status: "line", points: descending });
  });

  it("propagates a client failure instead of masking it as missing geometry", async () => {
    const client: PedGraphQueryable = {
      query: vi.fn().mockRejectedValue(new Error("connection terminated")),
    };

    await expect(findPedEdgeGeometries(client, 1, [10n])).rejects.toThrow(
      "connection terminated",
    );
  });
});
