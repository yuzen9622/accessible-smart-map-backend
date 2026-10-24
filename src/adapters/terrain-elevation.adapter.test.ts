import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sampleTerrain } from "./terrain-elevation.adapter";
import { getElevationDtmPath } from "../config/elevation";

const fixture = (name: string) =>
  path.resolve(`src/modules/accessible-route/fixtures/elevation-${name}.tif`);
const points: [number, number][] = [
  [121.56, 25.04],
  [121.55, 25.03],
];
beforeEach(() => vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", fixture("plane")));
afterEach(() => vi.unstubAllEnvs());

describe("bounded real GeoTIFF worker", () => {
  it("reads the real plane with pixel-centre bilinear interpolation", async () => {
    const result = await sampleTerrain(points);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.elevations[0]).toBeCloseTo(49.85, 3);
      expect(result.elevations[1]).toBeCloseTo(44.85, 3);
    }
  });

  it("preserves nodata and out-of-coverage as null", async () => {
    vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", fixture("nodata"));
    const result = await sampleTerrain([
      [121.555, 25.035],
      [10, 10],
    ]);
    expect(result).toEqual({ ok: true, elevations: [null, null] });
  });

  it("preserves zero and negative values from a real raster", async () => {
    vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", fixture("negative"));
    const result = await sampleTerrain([
      [120.0001, 25.9999],
      [120.0003, 25.9999],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.elevations[0]).toBeCloseTo(-2, 6);
      expect(result.elevations[1]).toBeCloseTo(0, 6);
    }
  });

  it("does not interpret projected coordinates as longitude/latitude", async () => {
    vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", fixture("projected"));
    expect(await sampleTerrain(points)).toEqual({
      ok: false,
      reason: "unsupported_dtm",
    });
  });

  it("returns a controlled error for a missing or invalid file", async () => {
    vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", fixture("missing"));
    expect(await sampleTerrain(points)).toEqual({
      ok: false,
      reason: "data_unavailable",
    });
    const folder = await mkdtemp(path.join(tmpdir(), "elevation-test-"));
    try {
      const file = path.join(folder, "invalid.tif");
      await writeFile(file, "not a GeoTIFF");
      vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", file);
      expect(await sampleTerrain(points)).toEqual({
        ok: false,
        reason: "data_unavailable",
      });
    } finally {
      await rm(folder, { recursive: true });
    }
  });

  it("treats a blank configured path as intentionally unavailable", async () => {
    vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", " ");
    expect(getElevationDtmPath()).toBeUndefined();
    expect(await sampleTerrain(points)).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("rejects oversized/invalid batches and caps distinct read windows", async () => {
    expect(
      await sampleTerrain(Array.from({ length: 7504 }, () => points[0])),
    ).toEqual({ ok: false, reason: "resource_limit" });
    expect(await sampleTerrain([[NaN, 25]])).toEqual({
      ok: false,
      reason: "invalid_geometry",
    });
    vi.stubEnv("ROUTE_ELEVATION_DTM_PATH", fixture("resource"));
    const acrossTiles: [number, number][] = Array.from(
      { length: 257 },
      (_, i) => [118 + (i * 128 + 32) * 0.0002, 25.99],
    );
    expect(await sampleTerrain(acrossTiles)).toEqual({
      ok: false,
      reason: "resource_limit",
    });
  });

  it("terminates an expired worker and makes both concurrency slots reusable", async () => {
    expect(await sampleTerrain(points, 1)).toEqual({
      ok: false,
      reason: "timeout",
    });
    await vi.waitFor(
      async () => expect((await sampleTerrain(points)).ok).toBe(true),
      { timeout: 2000 },
    );
    const a = sampleTerrain(points),
      b = sampleTerrain(points);
    expect(await sampleTerrain(points)).toEqual({ ok: false, reason: "busy" });
    const completed = await Promise.all([a, b]);
    expect(completed.every((result) => result.ok)).toBe(true);
  });
});
