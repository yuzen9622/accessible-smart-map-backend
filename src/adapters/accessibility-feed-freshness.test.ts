import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["construction", "metro"] as const)(
  "%s feed freshness",
  (kind) => {
    it("never renews expired closure data on failure and recovers after retry", async () => {
      vi.resetModules();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const metroCsv = Buffer.from(
        "b6b5a6b82ca4e9b4c1aec9b6a12cb8f4bd752ca8aeafb82cbba1a9fa0a312c3230323631303034543038303030302caa4fab6ebd752cb4fab8d5afb82cb971b1e8ac47bbd90a",
        "hex",
      );
      const response = () =>
        new Response(
          kind === "construction"
            ? JSON.stringify({
                features: [{ properties: { Ac_no: "123-1", IsBlock: "是" } }],
              })
            : metroCsv,
        );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockRejectedValue(new Error("upstream unavailable"));
      vi.stubGlobal("fetch", fetchMock);
      const fetchRows =
        kind === "construction"
          ? (await import("./taipei-construction.adapter"))
              .fetchTaipeiPermitIndex
          : (await import("./taipei-metro-notice.adapter"))
              .fetchTaipeiMetroNotices;
      const size = (result: Awaited<ReturnType<typeof fetchRows>>) =>
        Array.isArray(result) ? result.length : result.size;
      const ttl = (kind === "construction" ? 10 : 5) * 60_000;
      expect(size(await fetchRows())).toBe(1);
      vi.advanceTimersByTime(ttl - 1);
      expect(size(await fetchRows())).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      expect(size(await fetchRows())).toBe(0);
      expect(size(await fetchRows())).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(365 * 86_400_000);
      expect(size(await fetchRows())).toBe(0);
      fetchMock.mockResolvedValueOnce(response());
      vi.advanceTimersByTime(ttl + 1);
      expect(size(await fetchRows())).toBe(1);
    });
  },
);
