import { describe, expect, it } from "vitest";
import { TRAFFIC_LIVE_TARGET_CITIES, TRAFFIC_TARGET_CITIES } from "./traffic";

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
