import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./graph-loader", () => ({
  loadPedGraph: vi.fn(),
  parseGraphQualification: vi.fn(),
}));

import { loadPedGraph, type PedGraphQueryable } from "./graph-loader";
import { setPedGraphClientProvider } from "./graph-runtime";
import { readCurrentSidewalkSourceIdentity } from "./sidewalk-source.repository";

const source = {
  sourceVersionId: "9223372036854775806",
  sourceBatch: "202606",
  archiveSha256: "a".repeat(64),
};
const client: PedGraphQueryable = {
  async query() {
    throw new Error("source query was not configured for this test");
  },
};
const query = vi.spyOn(client, "query");
const provider = vi.fn(async () => client);
const budget = () => ({ deadlineMs: Date.now() + 1000, timeoutMs: 100 });

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  provider.mockReset().mockResolvedValue(client);
  setPedGraphClientProvider(provider);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
});

afterEach(() => {
  expect(loadPedGraph).not.toHaveBeenCalled();
  setPedGraphClientProvider(null);
  vi.useRealTimers();
});

describe("readCurrentSidewalkSourceIdentity", () => {
  it("reads only ACTIVE source metadata and preserves a bigint identity as text", async () => {
    query.mockResolvedValue({ rows: [source] });

    await expect(readCurrentSidewalkSourceIdentity(budget())).resolves.toEqual({
      status: "ready",
      identity: source,
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    const sql = query.mock.calls[0]?.[0];
    expect(sql).toContain('id::text AS "sourceVersionId"');
    expect(sql).toContain("FROM ped_sidewalk_source_version");
    expect(sql).toContain("WHERE lifecycle_status = 'ACTIVE'");
    expect(sql).toContain("LIMIT 2");
    expect(sql).not.toMatch(/ped_graph_version|ped_node|ped_edge/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reuse a previous identity after a promotion or retirement", async () => {
    const next = { ...source, sourceVersionId: "2", sourceBatch: "202607" };
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [next] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await readCurrentSidewalkSourceIdentity(budget())).toEqual({
      status: "ready",
      identity: source,
    });
    expect(await readCurrentSidewalkSourceIdentity(budget())).toEqual({
      status: "ready",
      identity: next,
    });
    expect(await readCurrentSidewalkSourceIdentity(budget())).toEqual({
      status: "unavailable",
      reason: "no_active_source",
    });
  });

  it("rejects two ACTIVE rows even if their reported identity is identical", async () => {
    query.mockResolvedValue({ rows: [source, source] });
    await expect(readCurrentSidewalkSourceIdentity(budget())).resolves.toEqual({
      status: "unavailable",
      reason: "ambiguous_active_source",
    });
  });

  it.each([
    null,
    {},
    { ...source, sourceVersionId: 1 },
    { ...source, sourceVersionId: "01" },
    { ...source, sourceVersionId: "0" },
    { ...source, sourceVersionId: "-1" },
    { ...source, sourceBatch: null },
    { ...source, sourceBatch: "" },
    { ...source, sourceBatch: " " },
    { ...source, sourceBatch: "202606 " },
    { ...source, archiveSha256: "a".repeat(63) },
    { ...source, archiveSha256: "G".repeat(64) },
    { ...source, archiveSha256: null },
  ])("rejects malformed source metadata %j", async (row) => {
    query.mockResolvedValue({ rows: [row] });
    await expect(readCurrentSidewalkSourceIdentity(budget())).resolves.toEqual({
      status: "unavailable",
      reason: "malformed_source",
    });
  });

  it("reports an acquisition failure without querying or exposing the DB error", async () => {
    provider.mockRejectedValue(new Error("private connection diagnostics"));
    await expect(readCurrentSidewalkSourceIdentity(budget())).resolves.toEqual({
      status: "unavailable",
      reason: "query_failed",
    });
    expect(query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a query failure instead of returning the previous successful identity", async () => {
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockRejectedValueOnce(new Error("connection terminated"));
    expect((await readCurrentSidewalkSourceIdentity(budget())).status).toBe(
      "ready",
    );
    await expect(readCurrentSidewalkSourceIdentity(budget())).resolves.toEqual({
      status: "unavailable",
      reason: "query_failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not acquire a client when the caller's deadline has expired", async () => {
    await expect(
      readCurrentSidewalkSourceIdentity({
        ...budget(),
        deadlineMs: Date.now(),
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "deadline_exceeded" });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Infinity },
    { timeoutMs: 2_147_483_648 },
    { deadlineMs: Number.NaN },
    { deadlineMs: Infinity },
  ])("rejects an invalid budget %j before I/O", async (override) => {
    await expect(
      readCurrentSidewalkSourceIdentity({ ...budget(), ...override }),
    ).resolves.toEqual({ status: "unavailable", reason: "invalid_budget" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("bounds client acquisition and never starts a query after it times out", async () => {
    provider.mockReturnValue(
      new Promise((resolve) => {
        setTimeout(() => resolve(client), 150);
      }),
    );
    const pending = readCurrentSidewalkSourceIdentity(budget());
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    expect(query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the remaining caller deadline rather than refreshing the timeout", async () => {
    provider.mockReturnValue(
      new Promise((resolve) => {
        setTimeout(() => resolve(client), 20);
      }),
    );
    query.mockImplementation(() => new Promise<never>(() => undefined));
    const pending = readCurrentSidewalkSourceIdentity({
      deadlineMs: Date.now() + 30,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(query).toHaveBeenCalledOnce();
    expect(await pending).toEqual({
      status: "unavailable",
      reason: "deadline_exceeded",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn a timed-out query into a ready identity when it later completes", async () => {
    query.mockReturnValue(
      new Promise((resolve) => {
        setTimeout(() => resolve({ rows: [source] }), 150);
      }),
    );
    const pending = readCurrentSidewalkSourceIdentity(budget());
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a late query rejection after the caller has already timed out", async () => {
    query.mockReturnValue(
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("late failure")), 150);
      }),
    );
    const pending = readCurrentSidewalkSourceIdentity(budget());
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
  });
});
