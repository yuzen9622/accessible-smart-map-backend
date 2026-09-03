import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficSectionGeometry } from "../../types/traffic";
import {
  getTrafficGeometrySnapshot,
  resetTrafficGeometryRuntime,
  setTrafficGeometryLoader,
  warmTrafficGeometryRuntime,
} from "./traffic-geometry.runtime";

const MOCK_SECTION: TrafficSectionGeometry = {
  sectionId: "sec-mock",
  city: "Taipei",
  geometry: {
    type: "LineString",
    coordinates: [
      [121.5, 25.0],
      [121.51, 25.01],
    ],
  },
};

describe("traffic-geometry.runtime", () => {
  beforeEach(() => {
    resetTrafficGeometryRuntime();
    vi.restoreAllMocks();
  });

  it("returns null while cold without calling loader", () => {
    const loader = vi.fn().mockResolvedValue([MOCK_SECTION]);
    setTrafficGeometryLoader(loader);

    const snapshot = getTrafficGeometrySnapshot();
    expect(snapshot).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("loads and builds snapshot when warmed via custom loader", async () => {
    const loader = vi.fn().mockResolvedValue([MOCK_SECTION]);
    setTrafficGeometryLoader(loader);

    const warmed = await warmTrafficGeometryRuntime();
    expect(warmed).not.toBeNull();
    expect(warmed?.sectionCount).toBe(1);
    expect(warmed?.index.segmentCount).toBe(1);

    const syncSnapshot = getTrafficGeometrySnapshot();
    expect(syncSnapshot).toBe(warmed);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("preserves previous snapshot when loader throws and does not bubble error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initialLoader = vi.fn().mockResolvedValue([MOCK_SECTION]);
    setTrafficGeometryLoader(initialLoader);
    const initial = await warmTrafficGeometryRuntime();
    expect(initial).not.toBeNull();

    const failingLoader = vi
      .fn()
      .mockRejectedValue(new Error("Mongo network error"));
    setTrafficGeometryLoader(failingLoader);

    const second = await warmTrafficGeometryRuntime();
    expect(second).toBe(initial);
    expect(getTrafficGeometrySnapshot()).toBe(initial);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("preserves previous snapshot when loader returns empty array", async () => {
    const initialLoader = vi.fn().mockResolvedValue([MOCK_SECTION]);
    setTrafficGeometryLoader(initialLoader);
    const initial = await warmTrafficGeometryRuntime();
    expect(initial).not.toBeNull();

    const emptyLoader = vi.fn().mockResolvedValue([]);
    setTrafficGeometryLoader(emptyLoader);

    const second = await warmTrafficGeometryRuntime();
    expect(second).toBe(initial);
    expect(getTrafficGeometrySnapshot()).toBe(initial);
  });

  it("single-flights concurrent warming calls so loader is called only once", async () => {
    let resolveLoader: (v: TrafficSectionGeometry[]) => void = () => {};
    const pendingPromise = new Promise<TrafficSectionGeometry[]>((resolve) => {
      resolveLoader = resolve;
    });
    const loader = vi.fn().mockReturnValue(pendingPromise);
    setTrafficGeometryLoader(loader);

    const warmPromise1 = warmTrafficGeometryRuntime();
    const warmPromise2 = warmTrafficGeometryRuntime();

    resolveLoader([MOCK_SECTION]);
    const [res1, res2] = await Promise.all([warmPromise1, warmPromise2]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(res1).toBe(res2);
    expect(res1?.sectionCount).toBe(1);
  });
});
