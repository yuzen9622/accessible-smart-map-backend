import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const probe = String.raw`
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const net = require("node:net");
const indexFile = process.argv[1];
const scenario = process.argv[2];
let phase = "startup";
const reads = [];
const readSync = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file) === indexFile) reads.push(phase);
  return readSync.call(this, file, ...args);
};
const readAsync = fsp.readFile;
fsp.readFile = function(file, ...args) {
  if (String(file) === indexFile) reads.push(phase);
  return readAsync.call(this, file, ...args);
};
net.Socket.prototype.connect = function() { throw new Error("Unexpected network during application construction"); };
let client;
client = new Proxy({ isReady: true, isOpen: true, on: () => client }, {
  get: (target, key) => key in target ? target[key] : async () => null,
});
const load = Module._load;
Module._load = function(request, ...args) {
  const value = load.call(this, request, ...args);
  return request === "redis" ? { ...value, createClient: () => client } : value;
};
(async () => {
  require(process.cwd() + "/src/app.ts");
  phase = "request";
  if (scenario === "recover") {
    const before = fs.statSync(indexFile);
    const data = JSON.parse(readSync(indexFile, "utf8"));
    data.sourcePbfSha256 = process.env.EXPECTED_FIXTURE_HASH;
    fs.writeFileSync(indexFile, JSON.stringify(data));
    fs.utimesSync(indexFile, before.atime, before.mtime);
  } else if (scenario === "changed") {
    const data = JSON.parse(readSync(indexFile, "utf8"));
    data.segments[0][0] = "other";
    fs.writeFileSync(indexFile, JSON.stringify(data));
  }
  const { annotateSidewalkSegments } = require(process.cwd() + "/src/adapters/otp-sidewalk-index.adapter.ts");
  const routes = [{ routeId: "startup", engine: "pedestrian-a11y", legs: [{
    type: "WALK", polyline: [[121.5, 25], [121.5005, 25]],
  }] }];
  await annotateSidewalkSegments(routes);
  console.log("__SIDEWALK_STARTUP__" + JSON.stringify({ reads, spans: routes[0].legs[0].sidewalkSegments }));
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
`;

function inspectStartup(scenario: "ready" | "recover" | "changed") {
  const directory = mkdtempSync(join(tmpdir(), "sidewalk-startup-"));
  directories.push(directory);
  const pbf = Buffer.from("sidewalk startup checksum fixture");
  const hash = createHash("sha256").update(pbf).digest("hex");
  const indexFile = join(directory, "index.json");
  writeFileSync(join(directory, "taiwan-otp.osm.pbf"), pbf);
  writeFileSync(
    indexFile,
    JSON.stringify({
      version: 2,
      sourcePbfSha256: scenario === "recover" ? "0".repeat(64) : hash,
      segments: [["sidewalk", 121.5, 25, 121.5005, 25, 1]],
      crossings: [],
    }),
  );
  const timestamp = new Date("2026-01-01T00:00:00Z");
  utimesSync(indexFile, timestamp, timestamp);
  const output = execFileSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", "-e", probe, indexFile, scenario],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        OTP_SIDEWALK_INDEX_PATH: indexFile,
        EXPECTED_FIXTURE_HASH: hash,
        JWT_ACCESS_SECRET: "startup-test-access",
        JWT_REFRESH_SECRET: "startup-test-refresh",
        GEMINI_API_KEY: "startup-test-key",
      },
    },
  );
  const result = output
    .split("\n")
    .find((line) => line.startsWith("__SIDEWALK_STARTUP__"));
  if (!result) throw new Error("Missing application startup observation");
  return JSON.parse(result.slice("__SIDEWALK_STARTUP__".length)) as {
    reads: string[];
    spans: { startIndex: number; endIndex: number }[];
  };
}

describe("real application sidewalk-index startup", () => {
  it("validates the index before the app can serve its first routing request", () => {
    expect(inspectStartup("ready")).toEqual({
      reads: ["startup"],
      spans: [{ startIndex: 0, endIndex: 1 }],
    });
  }, 20000);

  it("does not retain a failed preload when the first request can read valid data", () => {
    expect(inspectStartup("recover").spans).toEqual([
      { startIndex: 0, endIndex: 1 },
    ]);
  }, 20000);

  it("still reloads an index changed after application construction", () => {
    expect(inspectStartup("changed").spans).toEqual([]);
  }, 20000);
});
