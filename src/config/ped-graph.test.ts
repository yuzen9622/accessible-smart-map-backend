import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PED_GRAPH_LOAD_TIMEOUT_MS,
  DEFAULT_PED_GRAPH_REFRESH_INTERVAL_MS,
  getPedGraphConfig,
  isWithinPedGraphCoverage,
} from "./ped-graph";

const PED_GRAPH_ENV_KEYS = [
  "PED_GRAPH_DATABASE_URL",
  "PED_GRAPH_CSR_WALK_ENABLED",
  "PED_GRAPH_LOAD_TIMEOUT_MS",
  "PED_GRAPH_REFRESH_INTERVAL_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PED_GRAPH_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PED_GRAPH_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getPedGraphConfig", () => {
  it("keeps CSR disabled without a graph database while retaining safe defaults", () => {
    expect(getPedGraphConfig()).toEqual({
      databaseUrl: null,
      csrWalkEnabled: false,
      loadTimeoutMs: DEFAULT_PED_GRAPH_LOAD_TIMEOUT_MS,
      refreshIntervalMs: DEFAULT_PED_GRAPH_REFRESH_INTERVAL_MS,
    });
  });

  it("keeps CSR disabled when the flag is absent even with a configured graph database", () => {
    process.env.PED_GRAPH_DATABASE_URL =
      " postgresql://example.test/ped_graph ";
    process.env.PED_GRAPH_LOAD_TIMEOUT_MS = "1234";
    process.env.PED_GRAPH_REFRESH_INTERVAL_MS = "5678";

    expect(getPedGraphConfig()).toEqual({
      databaseUrl: "postgresql://example.test/ped_graph",
      csrWalkEnabled: false,
      loadTimeoutMs: 1234,
      refreshIntervalMs: 5678,
    });
  });

  it("enables CSR only with an explicit true flag", () => {
    process.env.PED_GRAPH_DATABASE_URL = "postgresql://example.test/ped_graph";
    process.env.PED_GRAPH_CSR_WALK_ENABLED = "true";

    expect(getPedGraphConfig().csrWalkEnabled).toBe(true);
  });

  it("allows an explicit feature rollback without removing the graph connection", () => {
    process.env.PED_GRAPH_DATABASE_URL = "postgresql://example.test/ped_graph";
    process.env.PED_GRAPH_CSR_WALK_ENABLED = "false";

    expect(getPedGraphConfig().csrWalkEnabled).toBe(false);
  });

  it("rejects invalid feature and timeout configuration instead of silently guessing", () => {
    process.env.PED_GRAPH_CSR_WALK_ENABLED = "sometimes";
    expect(() => getPedGraphConfig()).toThrow("PED_GRAPH_CSR_WALK_ENABLED");

    process.env.PED_GRAPH_CSR_WALK_ENABLED = "true";
    process.env.PED_GRAPH_LOAD_TIMEOUT_MS = "0";
    expect(() => getPedGraphConfig()).toThrow("PED_GRAPH_LOAD_TIMEOUT_MS");

    delete process.env.PED_GRAPH_LOAD_TIMEOUT_MS;
    process.env.PED_GRAPH_REFRESH_INTERVAL_MS = "NaN";
    expect(() => getPedGraphConfig()).toThrow("PED_GRAPH_REFRESH_INTERVAL_MS");
  });
});

describe("isWithinPedGraphCoverage", () => {
  it("includes Taipei bbox boundaries and rejects outside or non-finite coordinates", () => {
    expect(isWithinPedGraphCoverage({ lat: 24.95, lng: 121.43 })).toBe(true);
    expect(isWithinPedGraphCoverage({ lat: 25.22, lng: 121.68 })).toBe(true);
    expect(isWithinPedGraphCoverage({ lat: 25.23, lng: 121.55 })).toBe(false);
    expect(isWithinPedGraphCoverage({ lat: 25.04, lng: Number.NaN })).toBe(
      false,
    );
  });
});
