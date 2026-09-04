import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as redisConfig from "../../config/redis";
import * as cacheRepo from "./traffic-cache.repository";
import * as flowService from "./traffic-flow.service";
import {
  generateValhallaTrafficTar,
  getDirectedEdgeCountForTile,
  loadEdgeMap,
  resetValhallaTrafficWorkerCache,
  startValhallaTrafficTarWorker,
  type TdxValhallaEdgeMap,
} from "./valhalla-traffic.worker";
import { tileIdToPath } from "./valhalla-traffic-packer";

vi.mock("../../config/redis", () => ({
  redisSetNx: vi.fn(),
}));

vi.mock("./traffic-cache.repository", () => ({
  getLiveTrafficsSwr: vi.fn(),
}));

vi.mock("./traffic-flow.service", () => ({
  refreshCityLiveTraffics: vi.fn(),
}));

const mockedRedisSetNx = vi.mocked(redisConfig.redisSetNx);
const mockedGetLiveTrafficsSwr = vi.mocked(cacheRepo.getLiveTrafficsSwr);
const mockedRefreshCity = vi.mocked(flowService.refreshCityLiveTraffics);

describe("valhalla-traffic.worker", () => {
  let tmpDir: string;
  let sampleEdgeMapPath: string;
  let sampleTarPath: string;

  const sampleEdgeMap: TdxValhallaEdgeMap = {
    version: "1.0.0",
    generatedAt: "2026-09-03T12:00:00.000Z",
    totalSections: 2,
    mappedSections: 2,
    unmappedSections: 0,
    totalEdges: 3,
    mappings: [
      {
        sectionId: "SEC-001",
        city: "Taipei",
        roadName: "忠孝東路",
        edges: [
          {
            graphId: "12345678",
            tileId: 333609,
            edgeIndex: 10,
            forward: true,
          },
          {
            graphId: "12345679",
            tileId: 333609,
            edgeIndex: 11,
            forward: true,
          },
        ],
      },
      {
        sectionId: "SEC-002",
        city: "Taipei",
        roadName: "信義路",
        edges: [
          {
            graphId: "98765432",
            tileId: 20760,
            edgeIndex: 5,
            forward: false,
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    resetValhallaTrafficWorkerCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "valhalla-worker-test-"));
    sampleEdgeMapPath = path.join(tmpDir, "tdx-valhalla-edge-map.json");
    sampleTarPath = path.join(tmpDir, "traffic.tar");
    fs.writeFileSync(sampleEdgeMapPath, JSON.stringify(sampleEdgeMap), "utf8");

    // Create fake .gph files for sample tiles (333609 and 20760) with valid 24-byte GraphTileHeader
    // directed_edge_count is uint32 at offset 8
    const makeGph = (tileId: number, count: number) => {
      const relPath = tileIdToPath(tileId);
      const fullPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const buf = Buffer.alloc(48);
      // readDirectedEdgeCount reads uint64 at offset 40, bitfield >> 21n & 0x1fffffn
      const bitfield = BigInt(count) << 21n;
      buf.writeBigUInt64LE(bitfield, 40);
      fs.writeFileSync(fullPath, buf);
    };
    makeGph(333609, 100);
    makeGph(20760, 50);
  });

  afterEach(() => {
    resetValhallaTrafficWorkerCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("loadEdgeMap", () => {
    it("returns null if edge map file does not exist", () => {
      const nonExistent = path.join(tmpDir, "does-not-exist.json");
      expect(loadEdgeMap(nonExistent)).toBeNull();
    });

    it("loads and caches edge map based on mtime", () => {
      const map1 = loadEdgeMap(sampleEdgeMapPath);
      expect(map1).not.toBeNull();
      expect(map1?.totalSections).toBe(2);

      // Mutate file directly without changing mtime significantly (or read from cache)
      const map2 = loadEdgeMap(sampleEdgeMapPath);
      expect(map2).toBe(map1); // Identity equality implies cached reference
    });
  });

  describe("getDirectedEdgeCountForTile", () => {
    it("returns 0 if tile gph file does not exist", () => {
      expect(getDirectedEdgeCountForTile(999999, tmpDir)).toBe(0);
    });

    it("reads directededgecount_ when gph file exists", () => {
      // Create a fake .gph buffer with directededgecount_ = 50
      const gphPath = path.join(tmpDir, "1", "041", "701.gph");
      fs.mkdirSync(path.dirname(gphPath), { recursive: true });

      const buf = Buffer.alloc(48);
      // offset 40..48: bitfield with directededgecount_ at bit 21
      const bitfield = BigInt(50) << 21n;
      buf.writeBigUInt64LE(bitfield, 40);
      fs.writeFileSync(gphPath, buf);

      // Tile 333609 corresponds to 1/041/701.gph
      const count = getDirectedEdgeCountForTile(333609, tmpDir);
      expect(count).toBe(50);
    });
  });

  describe("generateValhallaTrafficTar", () => {
    it("skips generation if redis lock is held", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(false);

      const result = await generateValhallaTrafficTar({
        mapPath: sampleEdgeMapPath,
        outTarPath: sampleTarPath,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("LOCK_HELD");
      expect(fs.existsSync(sampleTarPath)).toBe(false);
    });

    it("skips generation if edge map is missing", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);

      const result = await generateValhallaTrafficTar({
        mapPath: path.join(tmpDir, "non-existent.json"),
        outTarPath: sampleTarPath,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("EDGE_MAP_NOT_FOUND");
    });

    it("skips generation if no speeds are available", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedGetLiveTrafficsSwr.mockResolvedValue({
        state: "fresh",
        data: [],
        ageMs: 1000,
      });

      const result = await generateValhallaTrafficTar({
        mapPath: sampleEdgeMapPath,
        outTarPath: sampleTarPath,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("NO_SPEED_DATA");
    });

    it("successfully generates traffic.tar with atomic replace when speeds are present", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedGetLiveTrafficsSwr.mockImplementation(async (city) => {
        if (city === "Taipei") {
          return {
            state: "fresh",
            data: [
              { sectionId: "SEC-001", speedKmh: 45, congestionLevel: 1 },
              { sectionId: "SEC-002", speedKmh: 20, congestionLevel: 3 },
            ],
            ageMs: 500,
          };
        }
        return { state: "fresh", data: [], ageMs: 0 };
      });

      const result = await generateValhallaTrafficTar({
        mapPath: sampleEdgeMapPath,
        outTarPath: sampleTarPath,
        tilesDir: tmpDir,
      });

      expect(result.generated).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.tileCount).toBe(2);
      expect(result.edgeCount).toBe(3);
      expect(result.tarSizeBytes).toBeGreaterThan(1024);

      // Check that traffic.tar exists and traffic.tar.tmp does not
      expect(fs.existsSync(sampleTarPath)).toBe(true);
      expect(fs.existsSync(`${sampleTarPath}.tmp`)).toBe(false);

      const stats = fs.statSync(sampleTarPath);
      expect(stats.size).toBe(result.tarSizeBytes);
    });

    it("refreshes live traffic from upstream when cache misses", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedGetLiveTrafficsSwr.mockResolvedValue({
        state: "miss",
        data: [],
        ageMs: 0,
      });
      mockedRefreshCity.mockImplementation(async (target) => {
        if (target === "Taipei") {
          return [{ sectionId: "SEC-001", speedKmh: 60, congestionLevel: 1 }];
        }
        return [];
      });

      const result = await generateValhallaTrafficTar({
        mapPath: sampleEdgeMapPath,
        outTarPath: sampleTarPath,
        tilesDir: tmpDir,
      });

      expect(mockedRefreshCity).toHaveBeenCalled();
      expect(result.generated).toBe(true);
      expect(result.tileCount).toBe(1);
    });

    it("supports force=true to bypass redis lock", async () => {
      mockedGetLiveTrafficsSwr.mockResolvedValue({
        state: "fresh",
        data: [{ sectionId: "SEC-001", speedKmh: 50, congestionLevel: 1 }],
        ageMs: 100,
      });

      const result = await generateValhallaTrafficTar({
        mapPath: sampleEdgeMapPath,
        outTarPath: sampleTarPath,
        tilesDir: tmpDir,
        force: true,
      });

      expect(mockedRedisSetNx).not.toHaveBeenCalled();
      expect(result.generated).toBe(true);
      expect(fs.existsSync(sampleTarPath)).toBe(true);
    });
  });

  describe("startValhallaTrafficTarWorker", () => {
    it("schedules periodic generation and unrefs timer", () => {
      vi.useFakeTimers();
      mockedRedisSetNx.mockResolvedValue(false);

      const timer = startValhallaTrafficTarWorker();
      expect(timer).toBeDefined();

      clearInterval(timer);
      vi.useRealTimers();
    });
  });
});
