import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runGenerateMap } from "./generate-tdx-valhalla-map";
import {
  getValhallaReleaseSnapshot,
  isValhallaReleaseCurrent,
} from "../adapters/valhalla-release.adapter";

const data = vi.hoisted(() => ({
  sections: [
    {
      sectionId: "SEC",
      city: "Taipei",
      geometry: {
        type: "LineString",
        coordinates: [
          [121, 25],
          [121.001, 25],
        ],
      },
    },
  ],
}));
vi.mock("mongoose", () => ({
  default: { connection: { readyState: 1 }, connect: vi.fn() },
}));
vi.mock("../model/traffic-section.model", () => ({
  default: {
    find: () => ({ lean: () => ({ exec: async () => data.sections }) }),
  },
}));
vi.mock("../adapters/valhalla-release.adapter", () => ({
  getValhallaReleaseSnapshot: vi.fn(),
  isValhallaReleaseCurrent: vi.fn(),
}));
const snapshot = {
  identity: "boot-1",
  roadNetwork: {
    tilesetId: "release-1",
    sourcePbfSha256: "a".repeat(64),
    provenance: "verified" as const,
  },
};
let directory: string;
let output: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "traffic-map-release-"));
  output = path.join(directory, "map.json");
  vi.stubEnv("DATABASE_URL", "mongodb://not-used");
  vi.mocked(getValhallaReleaseSnapshot).mockResolvedValue(snapshot);
  vi.mocked(isValhallaReleaseCurrent).mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/status")
          ? { tileset_last_modified: 123 }
          : { edges: [{ id: 626595796777, way_id: 137085105, forward: true }] },
    })),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});
it("binds generated graph IDs to immutable serving identity", async () => {
  await runGenerateMap({ cities: ["Taipei"], outPath: output });
  expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
    valhallaTilesetId: "release-1",
    valhallaSourcePbfSha256: "a".repeat(64),
    mappedSections: 1,
  });
});
it("does not publish a mixed-release map when serving changes during matching", async () => {
  vi.mocked(isValhallaReleaseCurrent).mockResolvedValue(false);
  await expect(
    runGenerateMap({ cities: ["Taipei"], outPath: output }),
  ).rejects.toThrow(/release/i);
  await expect(readFile(output)).rejects.toThrow();
});
it("does not collect graph IDs without serving identity", async () => {
  vi.mocked(getValhallaReleaseSnapshot).mockResolvedValue(null);
  await expect(
    runGenerateMap({ cities: ["Taipei"], outPath: output }),
  ).rejects.toThrow(/identity/i);
  expect(fetch).not.toHaveBeenCalled();
});
