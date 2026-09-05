/**
 * Valhalla Native Live Traffic Worker.
 *
 * Periodically generates `traffic.tar` for Valhalla 3.8.2 dynamic cost-aware routing:
 * 1. Coordinates across multi-instance deployments using Redis distributed lock (`traffic:tar:lock`).
 * 2. Reads the offline-generated TDX Section -> Valhalla Directed Edge mapping.
 * 3. Collects latest speed observations from Redis SWR cache (and TDX if empty).
 * 4. Encodes binary `.traffic` tiles adhering to `traffictile.h` specification.
 * 5. Packages all tiles with `index.bin` into `traffic.tar.tmp` and performs an atomic
 *    rename (`traffic.tar.tmp` -> `traffic.tar`) for zero-downtime hot reloading by Valhalla.
 */

import fs from "node:fs";
import path from "node:path";
import { redisSetNx } from "../../config/redis";
import {
  TRAFFIC_LIVE_TARGET_CITIES,
  TRAFFIC_REFRESH,
  TRAFFIC_TAR_LOCK_KEY,
  TRAFFIC_TAR_LOCK_TTL_SEC,
  VALHALLA_EDGE_MAP_PATH,
  VALHALLA_TILES_DIR,
  VALHALLA_TRAFFIC_EXTRACT_PATH,
} from "../../config/traffic";
import { getLiveTrafficsSwr } from "./traffic-cache.repository";
import { refreshCityLiveTraffics } from "./traffic-flow.service";
import {
  encodeTrafficTile,
  packTrafficTar,
  readDirectedEdgeCount,
  tileIdToPath,
  type EdgeSpeedInput,
} from "./valhalla-traffic-packer";

export interface MappedEdge {
  graphId: string;
  tileId: number;
  edgeIndex: number;
  forward: boolean;
  lengthKm?: number;
  wayId?: number;
}

export interface SectionEdgeMapping {
  sectionId: string;
  city: string;
  roadName?: string;
  edges: MappedEdge[];
}

export interface TdxValhallaEdgeMap {
  version: string;
  generatedAt: string;
  valhallaTilesetVersion?: number | string;
  totalSections: number;
  mappedSections: number;
  unmappedSections: number;
  totalEdges: number;
  mappings: SectionEdgeMapping[];
}

export interface ValhallaTrafficWorkerResult {
  generated: boolean;
  skipped: boolean;
  reason?: string;
  tileCount?: number;
  edgeCount?: number;
  tarSizeBytes?: number;
  durationMs?: number;
}

interface CachedEdgeMap {
  mtimeMs: number;
  map: TdxValhallaEdgeMap;
}

let edgeMapCache: CachedEdgeMap | null = null;
const tileEdgeCountCache = new Map<number, number>();

/**
 * Resets in-memory caches (used in unit tests).
 */
export function resetValhallaTrafficWorkerCache(): void {
  edgeMapCache = null;
  tileEdgeCountCache.clear();
}

/**
 * Safely loads the persistent Section -> Edge mapping file with mtime caching.
 */
export function loadEdgeMap(
  mapPath = VALHALLA_EDGE_MAP_PATH,
): TdxValhallaEdgeMap | null {
  try {
    const resolvedPath = path.resolve(process.cwd(), mapPath);
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }
    const stat = fs.statSync(resolvedPath);
    if (edgeMapCache && edgeMapCache.mtimeMs === stat.mtimeMs) {
      return edgeMapCache.map;
    }
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as TdxValhallaEdgeMap;
    if (!parsed || !Array.isArray(parsed.mappings)) {
      console.warn(
        `[valhalla-traffic-worker] Invalid edge map payload at ${mapPath}`,
      );
      return null;
    }
    edgeMapCache = {
      mtimeMs: stat.mtimeMs,
      map: parsed,
    };
    return parsed;
  } catch (err) {
    console.warn(
      `[valhalla-traffic-worker] Failed loading edge map at ${mapPath}:`,
      err,
    );
    return null;
  }
}

/**
 * Reads directededgecount_ from the corresponding .gph graph tile buffer.
 * Falls back to 0 if the tile file is missing or unreadable.
 */
export function getDirectedEdgeCountForTile(
  tileId: number,
  tilesDir = VALHALLA_TILES_DIR,
): number {
  const cached = tileEdgeCountCache.get(tileId);
  if (cached !== undefined) return cached;

  const tileRelPath = tileIdToPath(tileId);
  const fullPath = path.resolve(process.cwd(), tilesDir, tileRelPath);
  try {
    if (fs.existsSync(fullPath)) {
      const fd = fs.openSync(fullPath, "r");
      const buf = Buffer.alloc(48);
      fs.readSync(fd, buf, 0, 48, 0);
      fs.closeSync(fd);
      const count = readDirectedEdgeCount(buf);
      tileEdgeCountCache.set(tileId, count);
      return count;
    }
  } catch (err) {
    console.warn(
      `[valhalla-traffic-worker] Failed reading tile header for tileId ${tileId} at ${fullPath}:`,
      err,
    );
  }
  return 0;
}

/**
 * Collects latest section speeds across all configured target networks.
 */
async function collectSectionSpeeds(): Promise<Map<string, number>> {
  const targets = Array.from(
    new Set([...TRAFFIC_LIVE_TARGET_CITIES, "Freeway", "Highway"]),
  );
  const hits = await Promise.all(
    targets.map(async (target) => {
      let hit = await getLiveTrafficsSwr(target);
      if (!hit || hit.state === "miss" || hit.state === "failed") {
        try {
          const refreshed = await refreshCityLiveTraffics(target);
          hit = {
            state: "fresh",
            data: Array.isArray(refreshed) ? refreshed : [],
            ageMs: 0,
          };
        } catch {
          hit = { state: "failed", data: [], ageMs: 0 };
        }
      }
      return hit;
    }),
  );

  const speedMap = new Map<string, number>();
  for (const hit of hits) {
    if (hit && Array.isArray(hit.data)) {
      for (const section of hit.data) {
        if (section.speedKmh != null && section.speedKmh >= 0) {
          speedMap.set(section.sectionId, section.speedKmh);
        }
      }
    }
  }
  return speedMap;
}

export interface GenerateTrafficTarOptions {
  mapPath?: string;
  tilesDir?: string;
  outTarPath?: string;
  /** If true, bypasses the distributed Redis lock check. Useful for testing and CLI. */
  force?: boolean;
}

/**
 * Performs one generation cycle for `traffic.tar`.
 */
export async function generateValhallaTrafficTar(
  options: GenerateTrafficTarOptions = {},
): Promise<ValhallaTrafficWorkerResult> {
  const t0 = performance.now();

  if (!options.force) {
    const acquired = await redisSetNx(
      TRAFFIC_TAR_LOCK_KEY,
      TRAFFIC_TAR_LOCK_TTL_SEC,
    );
    if (!acquired) {
      return {
        generated: false,
        skipped: true,
        reason: "LOCK_HELD",
      };
    }
  }

  const mapPath = options.mapPath ?? VALHALLA_EDGE_MAP_PATH;
  const edgeMap = loadEdgeMap(mapPath);
  if (!edgeMap || edgeMap.mappings.length === 0) {
    console.warn(
      `[valhalla-traffic-worker] generation skipped: edge map missing or empty at ${mapPath}`,
    );
    return {
      generated: false,
      skipped: true,
      reason: "EDGE_MAP_NOT_FOUND",
    };
  }

  const speedMap = await collectSectionSpeeds();
  const tileEdgesMap = new Map<number, EdgeSpeedInput[]>();
  let totalUpdatedEdges = 0;

  for (const mapping of edgeMap.mappings) {
    const speed = speedMap.get(mapping.sectionId);
    if (speed === undefined) {
      continue;
    }

    for (const edge of mapping.edges) {
      let list = tileEdgesMap.get(edge.tileId);
      if (!list) {
        list = [];
        tileEdgesMap.set(edge.tileId, list);
      }
      list.push({
        edgeIndex: edge.edgeIndex,
        speedKmh: speed,
      });
      totalUpdatedEdges++;
    }
  }

  if (tileEdgesMap.size === 0) {
    return {
      generated: false,
      skipped: true,
      reason: "NO_SPEED_DATA",
    };
  }

  const epochNowSec = Math.floor(Date.now() / 1000);
  const tileBuffers = new Map<number, Buffer>();

  for (const [tileId, edges] of tileEdgesMap) {
    const edgeCount = getDirectedEdgeCountForTile(tileId, options.tilesDir);
    if (edgeCount <= 0) {
      console.warn(
        `[valhalla-traffic-worker] Skip tile ${tileId}: .gph file missing or cannot determine directed edge count.`,
      );
      continue;
    }

    // Deduplicate edges within the same tile (if mapped by multiple sections, pick the minimum speed conservatively)
    const dedupedMap = new Map<number, number>();
    for (const e of edges) {
      if (e.edgeIndex >= edgeCount) continue; // Out of bounds defense
      const existing = dedupedMap.get(e.edgeIndex);
      if (existing === undefined || e.speedKmh < existing) {
        dedupedMap.set(e.edgeIndex, e.speedKmh);
      }
    }

    const dedupedEdges = Array.from(dedupedMap.entries()).map(
      ([edgeIndex, speedKmh]) => ({
        edgeIndex,
        speedKmh,
      }),
    );

    const tileBuf = encodeTrafficTile(
      tileId,
      epochNowSec,
      dedupedEdges,
      edgeCount,
    );
    tileBuffers.set(tileId, tileBuf);
  }

  if (tileBuffers.size === 0) {
    return {
      generated: false,
      skipped: true,
      reason: "ALL_TILES_SKIPPED_DUE_TO_MISSING_GRAPH",
    };
  }

  const tarBuffer = packTrafficTar(tileBuffers);
  const outPath = path.resolve(
    process.cwd(),
    options.outTarPath ?? VALHALLA_TRAFFIC_EXTRACT_PATH,
  );
  const uniqueId = Math.random().toString(36).slice(2, 8);
  const tmpPath = `${outPath}.${process.pid}.${Date.now()}.${uniqueId}.tmp`;

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(tmpPath, tarBuffer);
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    console.error(
      `[valhalla-traffic-worker] Failed writing traffic.tar to ${outPath}:`,
      err,
    );
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
    return {
      generated: false,
      skipped: false,
      reason: `WRITE_ERROR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const durationMs = Math.round(performance.now() - t0);
  console.log(
    `[valhalla-traffic-worker] traffic.tar generated successfully: ${tileBuffers.size} tiles, ${totalUpdatedEdges} edges, ${tarBuffer.length} bytes in ${durationMs}ms`,
  );

  return {
    generated: true,
    skipped: false,
    tileCount: tileBuffers.size,
    edgeCount: totalUpdatedEdges,
    tarSizeBytes: tarBuffer.length,
    durationMs,
  };
}

/**
 * Starts periodic background traffic.tar generation.
 * Performs an immediate warm-up tick, then schedules ticks every interval.
 * Timer is unref-ed so it does not prevent graceful Node process shutdown.
 */
export function startValhallaTrafficTarWorker(): NodeJS.Timeout {
  void generateValhallaTrafficTar().catch((err) => {
    console.warn("[valhalla-traffic-worker] Warm-up generation failed:", err);
  });

  const timer = setInterval(() => {
    void generateValhallaTrafficTar().catch((err) => {
      console.warn(
        "[valhalla-traffic-worker] Periodic generation failed:",
        err,
      );
    });
  }, TRAFFIC_REFRESH.liveIntervalMs);

  timer.unref();
  return timer;
}
