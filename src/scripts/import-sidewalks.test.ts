import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sourceAdapter from "../adapters/sidewalk-source.adapter";
import * as sourceStore from "./sidewalk-source-store";
import { emptyCountyReport } from "./sidewalk-source-parse";
import {
  DEFAULT_SIDEWALK_SOURCE_URL,
  importSidewalks,
  parseSidewalkArgs,
} from "./import-sidewalks";

afterEach(() => vi.restoreAllMocks());

describe("sidewalk import CLI", () => {
  it("defaults to the authorized official source", () => {
    expect(
      parseSidewalkArgs([], { PED_GRAPH_DATABASE_URL: "isolated" }),
    ).toEqual({
      zip: undefined,
      url: DEFAULT_SIDEWALK_SOURCE_URL,
      dbUrl: "isolated",
      dryRun: false,
    });
    expect(DEFAULT_SIDEWALK_SOURCE_URL).toBe(
      "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/11D38E3D-F980-40BF-B714-4E0DB8AA1252/resource/673E16B8-66BC-4DD6-BA39-767BE3324F5C/download",
    );
  });
  it("gives source flags precedence over env and local ZIP precedence over env URL", () => {
    const env = {
      PED_GRAPH_DATABASE_URL: "old-db",
      SIDEWALK_SOURCE_URL: "old-url",
    };
    expect(
      parseSidewalkArgs(["--url", "explicit", "--dry-run"], env),
    ).toMatchObject({ url: "explicit", dbUrl: "old-db", dryRun: true });
    expect(parseSidewalkArgs(["--zip", "local.zip"], env)).toMatchObject({
      zip: "local.zip",
      url: undefined,
    });
    expect(parseSidewalkArgs([], env).url).toBe("old-url");
  });
  it.each([
    { args: ["--zip", "x", "--url", "y"] },
    { args: ["--zip"] },
    { args: ["--url", "--dry-run"] },
    { args: ["--bad"] },
    { args: ["--db-url", "postgres://test:canary@localhost/test"] },
  ])("rejects malformed arguments %#", ({ args }) => {
    expect(() =>
      parseSidewalkArgs(args, { PED_GRAPH_DATABASE_URL: "isolated" }),
    ).toThrow();
  });
  it("requires an explicit database configuration", () => {
    expect(() => parseSidewalkArgs([], {})).toThrow(/PED_GRAPH_DATABASE_URL/);
  });
  it("keeps environment credentials out of the real pnpm entry output", () => {
    const secret = "sidewalk-environment-secret-canary";
    const child = spawnSync(
      "pnpm",
      [
        "import:sidewalks",
        "--zip",
        path.join(os.tmpdir(), `sidewalk-missing-${process.pid}.zip`),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PED_GRAPH_DATABASE_URL: `postgres://test:${secret}@127.0.0.1:1/test`,
        },
        timeout: 30_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const output = child.stdout + child.stderr;
    expect(output).toContain("Sidewalk import failed");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("postgres://");
  }, 35_000);
  it("does not turn a committed import into failure when temp cleanup fails", async () => {
    const result = {
      report: {
        ...emptyCountyReport(),
        archiveSha256: "fixture-hash",
        sourceBatch: "202606",
        counties: {},
      },
      idempotent: false,
      published: true,
    };
    vi.spyOn(sourceAdapter, "acquireSidewalkArchive").mockResolvedValue({
      file: "task-owned.zip",
      sha256: "fixture-hash",
      cleanup: vi.fn().mockRejectedValue(new Error("sensitive-temp-path")),
    });
    vi.spyOn(sourceStore, "storeSidewalkSource").mockResolvedValue(result);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importSidewalks([], { PED_GRAPH_DATABASE_URL: "isolated-test" }),
    ).resolves.toEqual(result);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "sensitive-temp-path",
    );
  });
  it("preserves the import failure when temp cleanup also fails", async () => {
    const failure = new Error("source validation failed");
    vi.spyOn(sourceAdapter, "acquireSidewalkArchive").mockResolvedValue({
      file: "task-owned.zip",
      sha256: "fixture-hash",
      cleanup: vi.fn().mockRejectedValue(new Error("sensitive-temp-path")),
    });
    vi.spyOn(sourceStore, "storeSidewalkSource").mockRejectedValue(failure);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importSidewalks([], { PED_GRAPH_DATABASE_URL: "isolated-test" }),
    ).rejects.toBe(failure);
  });
});
