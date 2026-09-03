import { TRAFFIC_REFRESH } from "../../config/traffic";
import type { TrafficSectionGeometry } from "../../types/traffic";
import { findAllSections } from "./traffic-section.repository";
import {
  buildSegmentIndex,
  segmentIndexStats,
  type SegmentIndex,
} from "./traffic-segment-index";

export interface TrafficGeometrySnapshot {
  index: SegmentIndex;
  sectionCount: number;
  loadedAtMs: number;
}

export type TrafficGeometryLoader = () => Promise<TrafficSectionGeometry[]>;

interface RuntimeState {
  snapshot: TrafficGeometrySnapshot | null;
  inFlight: Promise<TrafficGeometrySnapshot | null> | null;
}

const state: RuntimeState = {
  snapshot: null,
  inFlight: null,
};

let customLoader: TrafficGeometryLoader | null = null;

/**
 * Returns the currently held in-memory segment index snapshot.
 * Sync, memory-only. NEVER queries MongoDB. Returns null while cold.
 */
export function getTrafficGeometrySnapshot(): TrafficGeometrySnapshot | null {
  return state.snapshot;
}

/**
 * Injects a test loader, or null to restore the default repository query.
 */
export function setTrafficGeometryLoader(
  loader: TrafficGeometryLoader | null,
): void {
  customLoader = loader;
}

/**
 * Resets the runtime snapshot, loader, and in-flight promise.
 */
export function resetTrafficGeometryRuntime(): void {
  state.snapshot = null;
  state.inFlight = null;
  customLoader = null;
}

/**
 * Single-flighted loader that fetches all sections and constructs the resident SegmentIndex.
 * Does not bubble exceptions up to caller.
 */
export async function warmTrafficGeometryRuntime(): Promise<TrafficGeometrySnapshot | null> {
  if (state.inFlight) {
    return state.inFlight;
  }

  state.inFlight = (async () => {
    try {
      const loader = customLoader ?? findAllSections;
      const t0 = Date.now();
      const sections = await loader();
      if (!sections || sections.length === 0) {
        return state.snapshot;
      }

      const index = buildSegmentIndex(sections);
      const buildMs = Date.now() - t0;
      const stats = segmentIndexStats(index);

      const snapshot: TrafficGeometrySnapshot = {
        index,
        sectionCount: sections.length,
        loadedAtMs: Date.now(),
      };
      state.snapshot = snapshot;

      console.log(
        "[traffic] geometry index ready",
        JSON.stringify({
          sections: snapshot.sectionCount,
          segments: stats.segments,
          buildMs,
        }),
      );

      return state.snapshot;
    } catch (err) {
      console.warn("[traffic] geometry runtime warm failed:", err);
      return state.snapshot;
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

/**
 * Starts periodic reloading of the geometry index in the background.
 * Timer is unref-ed so it does not block Node process exit.
 */
export function startTrafficGeometryRefreshJob(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void warmTrafficGeometryRuntime();
  }, TRAFFIC_REFRESH.geometryIntervalMs);
  timer.unref();
  return timer;
}
