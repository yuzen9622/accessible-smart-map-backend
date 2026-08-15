import { describe, it, expect } from "vitest";
import { scoreAndRank } from "./accessible-route.service";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  TraLeg,
} from "../../types/route";

// Reproduces the original 政大 → 台北車站 complaint with the REAL ranking
// function (scoreAndRank: collectRouteFacilities + walk distance + dataConfidence
// + scoreRoute + routeCost). a11y arrays are left EMPTY on purpose — that is the
// exact scenario the user hit (facilityScore=0 everywhere), now handled by the
// P3 neutral baseline. No TDX / OTP / Mongo needed: scoreAndRank is pure over
// the candidate route objects.

const walk = (distanceM: number): WalkLeg => ({
  type: "WALK",
  from: "",
  to: "",
  distanceM,
  minutesEst: Math.max(1, Math.round(distanceM / 48)),
  polyline: [],
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
});

const bus = (routeName: string): BusLeg => ({
  type: "BUS",
  routeName,
  departureStop: "",
  arrivalStop: "",
  waitInfo: { time: null, source: "unavailable" },
  estimatedWaitMinutes: 0,
  direction: 0,
  polyline: [],
  departureStopA11y: [],
  arrivalStopA11y: [],
});

const tra = (): TraLeg => ({
  type: "TRA",
  trainNo: "1273",
  trainTypeName: "區間車",
  departureStation: "松山",
  arrivalStation: "臺北",
  departureStationUID: "",
  arrivalStationUID: "",
  departureTime: "",
  arrivalTime: "",
  rideMinutes: 8,
  waitInfo: { time: null, source: "unavailable" },
  estimatedWaitMinutes: 0,
  polyline: [],
  departureStationA11y: [],
  arrivalStationA11y: [],
  facilityHighlights: [],
});

// Route 1 羅斯福路幹線: 30 min, 0 transfer, walk 51 + 685 = 736 m
const route1: AccessibleRoute = {
  routeId: "r1-roosevelt",
  routeName: "羅斯福路幹線",
  totalMinutes: 30,
  transferCount: 0,
  legs: [walk(51), bus("羅斯福路幹線"), walk(685)],
  accessibilityHighlights: [],
};
// Route 2 251: 34 min, 0 transfer, walk 759 + 685 = 1444 m  ← the offender
const route2: AccessibleRoute = {
  routeId: "r2-251",
  routeName: "251",
  totalMinutes: 34,
  transferCount: 0,
  legs: [walk(759), bus("251"), walk(685)],
  accessibilityHighlights: [],
};
// Route 3 66 → 台鐵: 38 min, 1 transfer, walk 51 + 207 + 167 = 425 m
const route3: AccessibleRoute = {
  routeId: "r3-66-tra",
  routeName: "66 → 1273(台鐵)",
  totalMinutes: 38,
  transferCount: 1,
  legs: [walk(51), bus("66"), walk(207), tra(), walk(167)],
  accessibilityHighlights: [],
};

describe("政大 → 台北車站 ranking flip (wheelchair, real scoreAndRank)", () => {
  const ranked = scoreAndRank([route1, route2, route3], "wheelchair");
  const ids = ranked.map((r) => r.routeId);

  it("prints the resulting ranking", () => {
    // Visible in the vitest output — a readable before/after.
    for (const [i, r] of ranked.entries()) {
      console.log(
        `#${i + 1} ${r.routeName}` +
          ` | score=${r.accessibilityScore}` +
          ` walk=${r.totalWalkDistanceM}m` +
          ` walkPenalty=${r.scoreComponents?.walkPenalty}` +
          ` conf=${r.dataConfidence}`,
      );
    }
    expect(ranked).toHaveLength(3);
  });

  it("the 425 m route now out-ranks the 1.4 km route (the complaint)", () => {
    expect(ids.indexOf("r3-66-tra")).toBeLessThan(ids.indexOf("r2-251"));
  });

  it("the 1.4 km walk route drops to LAST", () => {
    expect(ids[ids.length - 1]).toBe("r2-251");
  });

  it("the 1.4 km route hits the wheelchair walk-penalty cap (35) and exceeds the 425 m route's", () => {
    const penalty = (id: string) =>
      ranked.find((r) => r.routeId === id)!.scoreComponents!.walkPenalty;
    expect(penalty("r2-251")).toBe(35);
    expect(penalty("r2-251")).toBeGreaterThan(penalty("r3-66-tra"));
  });

  it("flags low data confidence (no a11y data on any leg) instead of scoring it as worst", () => {
    for (const r of ranked) {
      expect(r.dataConfidence).toBe("low");
      // P3: empty facilities now score the neutral baseline, not 0.
      expect(r.scoreComponents!.facilityScore).toBeGreaterThan(0);
    }
  });
});
