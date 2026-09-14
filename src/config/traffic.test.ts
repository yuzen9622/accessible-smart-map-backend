import { describe, expect, it } from "vitest";
import {
  TRAFFIC_LIVE_BASE_TICK_MS,
  TRAFFIC_LIVE_PRIMARY_TARGETS,
  TRAFFIC_LIVE_TARGET_CITIES,
  TRAFFIC_LIVE_TIERS,
  TRAFFIC_REFRESH,
  TRAFFIC_TARGET_CITIES,
  tierForTarget,
} from "./traffic";

describe("TRAFFIC_LIVE_TARGET_CITIES", () => {
  it("drops cities the TDX live endpoint rejects and keeps the ones it serves", () => {
    expect(TRAFFIC_LIVE_TARGET_CITIES).not.toContain("NewTaipei");
    expect(TRAFFIC_LIVE_TARGET_CITIES).toContain("Taichung");
    expect(TRAFFIC_LIVE_TARGET_CITIES).toContain("Taipei");
  });

  it("is a subset of TRAFFIC_TARGET_CITIES", () => {
    for (const city of TRAFFIC_LIVE_TARGET_CITIES) {
      expect(TRAFFIC_TARGET_CITIES).toContain(city);
    }
  });
});

describe("TRAFFIC_LIVE_TIERS", () => {
  const tiers = Object.entries(TRAFFIC_LIVE_TIERS);

  it.each(tiers)(
    "%s keeps the soft TTL above its refresh interval",
    (_name, tier) => {
      // Violating this makes every SWR read report `stale`, so the request path
      // fires an on-demand refresh per request and upstream calls go UP, not down.
      expect(tier.softTtlSec * 1000).toBeGreaterThan(tier.intervalMs);
    },
  );

  it.each(tiers)(
    "%s survives several consecutive failed rounds before the cache expires",
    (_name, tier) => {
      expect(tier.hardTtlSec * 1000).toBeGreaterThanOrEqual(
        tier.intervalMs * 3,
      );
    },
  );

  it("ticks at least as often as the fastest tier needs", () => {
    for (const [, tier] of tiers) {
      expect(TRAFFIC_LIVE_BASE_TICK_MS).toBeLessThanOrEqual(tier.intervalMs);
    }
  });

  it("releases the round lock before the next tick starts", () => {
    expect(TRAFFIC_REFRESH.lockTtlSec * 1000).toBeLessThan(
      TRAFFIC_LIVE_BASE_TICK_MS,
    );
  });
});

describe("tierForTarget", () => {
  it("puts configured primary targets on the fast tier", () => {
    for (const target of TRAFFIC_LIVE_PRIMARY_TARGETS) {
      expect(tierForTarget(target)).toBe(TRAFFIC_LIVE_TIERS.primary);
    }
  });

  it("falls back to the standard tier for everything else", () => {
    expect(tierForTarget("Highway")).toBe(TRAFFIC_LIVE_TIERS.standard);
    expect(tierForTarget("Freeway")).toBe(TRAFFIC_LIVE_TIERS.standard);
    expect(tierForTarget("PingtungCounty")).toBe(TRAFFIC_LIVE_TIERS.standard);
  });
});
