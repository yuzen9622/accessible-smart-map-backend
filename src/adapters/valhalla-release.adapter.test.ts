import axios from "axios";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getValhallaReleaseSnapshot,
  isValhallaReleaseCurrent,
  readValhallaReleaseIdentity,
} from "./valhalla-release.adapter";
vi.mock("axios", () => ({ default: { get: vi.fn() } }));
const status = { version: "3.9.1", tileset_last_modified: 123 };
const verification = {
  expectedServingStatus: status,
  validation: {
    candidateRouting: true,
    airportSigns: true,
    lanes: true,
    speedTransition: true,
    directionalSourceRules: true,
    sourceIntegrity: true,
    tileFilesPresent: true,
  },
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let root: string;
let marker: {
  buildId: string;
  manifestSha256: string | null;
  valhallaImageDigest: string;
  instanceId: string;
  startedAt: string;
};
const source = "a".repeat(64);
async function artifacts() {
  const rules = JSON.stringify({
    schemaVersion: 1,
    sourcePbfSha256: source,
    ways: {
      "123": {
        forward: { kind: "known", limitKph: 30, rawValue: "30" },
        backward: { kind: "known", limitKph: 50, rawValue: "50" },
        unresolvedConditional: false,
        unresolvedLaneSpecific: false,
      },
    },
  });
  const manifest = JSON.stringify({
    schemaVersion: 1,
    buildId: "release1",
    sourcePbfSha256: source,
    valhallaImageDigest: marker.valhallaImageDigest,
    speedRulesSha256: hash(rules),
    speedRulesSchemaVersion: 1,
    ...verification,
  });
  await writeFile(path.join(root, "releases/release1/manifest.json"), manifest);
  await writeFile(
    path.join(root, "releases/release1/road-speed-rules.json"),
    rules,
  );
  marker.manifestSha256 = hash(manifest);
  await writeFile(
    path.join(root, "serving-release.json"),
    JSON.stringify(marker),
  );
}
beforeEach(async () => {
  vi.mocked(axios.get).mockReset().mockResolvedValue({ data: status });
  root = await mkdtemp(
    path.resolve(".pi/notes/driving-navigation-backend-20261108/release-test-"),
  );
  vi.stubEnv("VALHALLA_DATA_DIR", root);
  await mkdir(path.join(root, "releases/release1"), { recursive: true });
  await symlink("releases/release1", path.join(root, "active"));
  marker = {
    buildId: "release1",
    manifestSha256: null,
    valhallaImageDigest: "sha256:" + "b".repeat(64),
    instanceId: "process1",
    startedAt: new Date().toISOString(),
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
describe("immutable serving release loader", () => {
  it("captures a synchronous marker-only identity without status or artifact work", async () => {
    await artifacts();
    const identity = readValhallaReleaseIdentity();
    expect(identity).toBe(hash(JSON.stringify(marker)));
    expect(axios.get).not.toHaveBeenCalled();
    expect((await getValhallaReleaseSnapshot())?.identity).toBe(identity);
    marker.instanceId = "replacement";
    await writeFile(
      path.join(root, "serving-release.json"),
      JSON.stringify(marker),
    );
    expect(readValhallaReleaseIdentity()).not.toBe(identity);
  });
  it("fails soft for missing, oversized, and non-regular marker fences", async () => {
    const file = path.join(root, "serving-release.json");
    expect(readValhallaReleaseIdentity()).toBeNull();
    await writeFile(file, "x".repeat(4097));
    expect(readValhallaReleaseIdentity()).toBeNull();
    expect(await getValhallaReleaseSnapshot()).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
    await rm(file);
    await symlink("active", file);
    expect(readValhallaReleaseIdentity()).toBeNull();
  });
  it.each([
    "missingValidation",
    "failedValidation",
    "missingStatus",
    "badStatus",
  ])("does not verify manifest with %s", async (kind) => {
    await artifacts();
    const file = path.join(root, "releases/release1/manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (kind === "missingValidation") delete manifest.validation;
    if (kind === "failedValidation")
      manifest.validation.sourceIntegrity = false;
    if (kind === "missingStatus") delete manifest.expectedServingStatus;
    if (kind === "badStatus")
      manifest.expectedServingStatus.tileset_last_modified = "123";
    const bytes = JSON.stringify(manifest);
    await writeFile(file, bytes);
    marker.manifestSha256 = hash(bytes);
    await writeFile(
      path.join(root, "serving-release.json"),
      JSON.stringify(marker),
    );
    const result = await getValhallaReleaseSnapshot();
    expect(result?.roadNetwork.provenance).toBe("unverified");
    expect(result?.rules).toBeUndefined();
  });
  it("reuses parsed immutable rules but invalidates cache when artifact changes", async () => {
    await artifacts();
    const first = await getValhallaReleaseSnapshot();
    const second = await getValhallaReleaseSnapshot();
    expect(first?.rules).toBeDefined();
    expect(second?.rules).toBe(first?.rules);
    await writeFile(
      path.join(root, "releases/release1/road-speed-rules.json"),
      "{}",
    );
    const changed = await getValhallaReleaseSnapshot();
    expect(changed?.roadNetwork.provenance).toBe("unverified");
    expect(changed?.rules).toBeUndefined();
  });
  it("checks configured upstream status and fails closed on drift/error", async () => {
    await artifacts();
    const snapshot = await getValhallaReleaseSnapshot();
    expect(snapshot?.roadNetwork.provenance).toBe("verified");
    vi.mocked(axios.get).mockResolvedValue({
      data: { ...status, tileset_last_modified: 124 },
    });
    expect(await isValhallaReleaseCurrent(snapshot!)).toBe(false);
    vi.mocked(axios.get).mockRejectedValue(new Error("unreachable"));
    expect(await getValhallaReleaseSnapshot()).toBeNull();
  });
  it("respects one snapshot deadline even if upstream does not settle", async () => {
    await artifacts();
    vi.useFakeTimers();
    try {
      vi.mocked(axios.get).mockReturnValue(new Promise(() => {}));
      const result = getValhallaReleaseSnapshot(20);
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("never identifies serving from active symlink alone", async () => {
    expect(await getValhallaReleaseSnapshot()).toBeNull();
  });
  it("loads legacy runtime as unverified without source or rules", async () => {
    await writeFile(
      path.join(root, "serving-release.json"),
      JSON.stringify(marker),
    );
    expect(await getValhallaReleaseSnapshot()).toMatchObject({
      roadNetwork: {
        tilesetId: "release1",
        sourcePbfSha256: null,
        provenance: "unverified",
      },
    });
  });
  it("validates runtime manifest/rules hashes and image/source association", async () => {
    await artifacts();
    expect(await getValhallaReleaseSnapshot()).toMatchObject({
      roadNetwork: { sourcePbfSha256: source, provenance: "verified" },
      rules: {
        ways: {
          "123": { forward: { limitKph: 30 }, backward: { limitKph: 50 } },
        },
      },
    });
  });
  it.each(["manifest", "rules", "source", "image"])(
    "downgrades mismatched %s",
    async (kind) => {
      await artifacts();
      const dir = path.join(root, "releases/release1");
      if (kind === "manifest")
        await writeFile(path.join(dir, "manifest.json"), "{}");
      if (kind === "rules")
        await writeFile(path.join(dir, "road-speed-rules.json"), "{}");
      if (kind === "source") {
        const rules = JSON.stringify({
          schemaVersion: 1,
          sourcePbfSha256: "c".repeat(64),
          ways: {},
        });
        const manifest = JSON.stringify({
          schemaVersion: 1,
          buildId: "release1",
          sourcePbfSha256: source,
          valhallaImageDigest: marker.valhallaImageDigest,
          speedRulesSha256: hash(rules),
          speedRulesSchemaVersion: 1,
        });
        await writeFile(path.join(dir, "manifest.json"), manifest);
        await writeFile(path.join(dir, "road-speed-rules.json"), rules);
        marker.manifestSha256 = hash(manifest);
      }
      if (kind === "image")
        marker.valhallaImageDigest = "sha256:" + "c".repeat(64);
      await writeFile(
        path.join(root, "serving-release.json"),
        JSON.stringify(marker),
      );
      const result = await getValhallaReleaseSnapshot();
      expect(result?.roadNetwork.provenance).toBe("unverified");
      expect(result?.rules).toBeUndefined();
    },
  );
  it("instance replacement invalidates an in-flight snapshot", async () => {
    await artifacts();
    const snapshot = await getValhallaReleaseSnapshot();
    expect(snapshot).not.toBeNull();
    marker.instanceId = "process2";
    await writeFile(
      path.join(root, "serving-release.json"),
      JSON.stringify(marker),
    );
    expect(await isValhallaReleaseCurrent(snapshot!)).toBe(false);
  });
  it("active switching away from loaded runtime fails closed", async () => {
    await artifacts();
    await mkdir(path.join(root, "releases/release2"));
    await rm(path.join(root, "active"));
    await symlink("releases/release2", path.join(root, "active"));
    expect(await getValhallaReleaseSnapshot()).toBeNull();
  });
  it("malformed marker and expired budgets never throw", async () => {
    await writeFile(path.join(root, "serving-release.json"), "{bad");
    expect(await getValhallaReleaseSnapshot()).toBeNull();
    expect(await getValhallaReleaseSnapshot(0)).toBeNull();
  });
});
