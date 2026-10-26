import { execFile, spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sourceAdapter from "../adapters/sidewalk-source.adapter";
import * as sourceStore from "./sidewalk-source-store";
import { emptyCountyReport } from "./sidewalk-source-parse";
import {
  DEFAULT_SIDEWALK_SOURCE_URL,
  formatSidewalkImportError,
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
  it.each([
    { args: [], dryRun: false, idempotent: false },
    { args: ["--dry-run"], dryRun: true, idempotent: false },
    { args: [], dryRun: false, idempotent: true },
  ])(
    "imports with only source prerequisites %#",
    async ({ args, dryRun, idempotent }) => {
      const result = {
        report: {
          ...emptyCountyReport(),
          archiveSha256: "fixture-hash",
          sourceBatch: "202606",
          counties: {},
        },
        idempotent,
        published: !dryRun && !idempotent,
      };
      const cleanup = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(sourceAdapter, "acquireSidewalkArchive").mockResolvedValue({
        file: "task-owned.zip",
        sha256: "fixture-hash",
        cleanup,
      });
      const store = vi
        .spyOn(sourceStore, "storeSidewalkSource")
        .mockResolvedValue(result);

      await expect(
        importSidewalks(args, { PED_GRAPH_DATABASE_URL: "isolated-test" }),
      ).resolves.toEqual(result);
      expect(store).toHaveBeenCalledExactlyOnceWith({
        zip: undefined,
        url: DEFAULT_SIDEWALK_SOURCE_URL,
        sourceUrl: DEFAULT_SIDEWALK_SOURCE_URL,
        dbUrl: "isolated-test",
        file: "task-owned.zip",
        sha256: "fixture-hash",
        dryRun,
      });
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );
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
    expect(output).toContain("[local-zip]: ENOENT:");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("postgres://");
  }, 35_000);
  it("reports an upstream HTTP failure through the real pnpm entry without printing its response body", async () => {
    const secret = "sidewalk-http-secret-canary";
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/html" });
      res.end(secret);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no HTTP port");
      const failure = await promisify(execFile)("pnpm", ["import:sidewalks"], {
        env: {
          ...process.env,
          SIDEWALK_SOURCE_URL: `http://127.0.0.1:${address.port}/source.zip`,
          PED_GRAPH_DATABASE_URL: `postgres://test:${secret}@127.0.0.1:1/test`,
        },
        timeout: 30_000,
      }).then(
        () => {
          throw new Error("Expected HTTP 503 to fail the import");
        },
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain(
        "[download]: Source server returned HTTP 503",
      );
      expect(failure.stderr).not.toContain("[sidewalk-import] validating");
      expect(failure.stdout + failure.stderr).not.toContain(secret);
      expect(failure.stdout + failure.stderr).not.toContain("postgres://");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
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

describe("safe sidewalk import diagnostics", () => {
  it.each([
    {
      stage: "download" as const,
      error: Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("secret-canary"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
      expected: "UND_ERR_CONNECT_TIMEOUT",
    },
    {
      stage: "store" as const,
      error: Object.assign(new Error("secret-canary"), {
        code: "28P01",
        detail: "secret-canary",
      }),
      expected: "PostGIS authentication failed",
    },
    {
      stage: "download" as const,
      error: Object.assign(new Error("secret-canary"), {
        name: "TimeoutError",
      }),
      expected: "180-second limit",
    },
    {
      stage: "store" as const,
      error: new SyntaxError("raw GeoJSON secret-canary"),
      expected: "invalid JSON",
    },
  ])(
    "explains $expected without exposing raw errors",
    ({ stage, error, expected }) => {
      const output = formatSidewalkImportError(stage, error);
      expect(output).toContain(`[${stage}]`);
      expect(output).toContain(expected);
      expect(output).not.toContain("secret-canary");
    },
  );

  it("only prints exact known validation messages", () => {
    expect(
      formatSidewalkImportError(
        "store",
        new Error("missing WGS84 counties: all 22 required"),
      ),
    ).toContain("missing WGS84 counties: all 22 required");
    for (const message of [
      "source download HTTP 503\nsecret-canary",
      "stored source snapshot integrity failed: secret-canary",
      "postgres://user:secret-canary@host/database",
    ]) {
      expect(
        formatSidewalkImportError("store", new Error(message)),
      ).not.toContain("secret-canary");
    }
  });

  it("bounds cyclic causes and rejects arbitrary error codes", () => {
    const error: { code: string; message: string; cause?: unknown } = {
      code: "secret-canary",
      message: "secret-canary",
    };
    error.cause = error;
    const output = formatSidewalkImportError("store", error);
    expect(output).toContain("Unexpected import error");
    expect(output).not.toContain("secret-canary");
    expect(output).toContain("Verify source snapshot status");
  });

  it("explains the pg driver's untagged connection failures without matching arbitrary text", () => {
    expect(
      formatSidewalkImportError("store", new Error("timeout expired")),
    ).toContain("PostGIS connection timed out after 10 seconds");
    expect(
      formatSidewalkImportError(
        "store",
        new Error("Connection terminated unexpectedly"),
      ),
    ).toContain("PostGIS connection was terminated");
    expect(
      formatSidewalkImportError(
        "store",
        new Error("timeout expired: secret-canary"),
      ),
    ).not.toContain("secret-canary");
    expect(
      formatSidewalkImportError("store", new Error("unsupported county CRS")),
    ).toContain("unsupported county CRS");
  });
});
