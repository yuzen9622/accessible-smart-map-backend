import { describe, it, expect } from "vitest";
import {
  FACILITY_NEUTRAL,
  scoreFacilitySet,
  scoreOsmNode,
  slopeContribution,
  widthContribution,
  crossSlopeContribution,
  walkPenaltyScore,
  transferPenaltyScore,
  walkSpeedMps,
  dataConfidenceFromRatio,
  routeCost,
  prerankCost,
  scoreRoute,
  environmentPenalty,
  ENV_PENALTY_CAP,
  resolveA11yConstraints,
} from "./scoring";
import type { IOsmA11y } from "../../types";

// Minimal IOsmA11y factory — scoring only reads `category` and `tags`.
const node = (category: string, tags: Record<string, string> = {}): IOsmA11y =>
  ({ category, tags }) as unknown as IOsmA11y;

describe("slope / width / cross-slope contributions", () => {
  it("slope: free below 5%, capped at -35", () => {
    expect(slopeContribution(3)).toBe(0);
    expect(slopeContribution(7)).toBe(-8);
    expect(slopeContribution(20)).toBe(-35);
    expect(slopeContribution(-7)).toBe(-8); // sign-insensitive
  });
  it("width: penalised below wheelchair minimum, bonus when wide", () => {
    expect(widthContribution(0.8)).toBe(-30);
    expect(widthContribution(1.0)).toBe(-10);
    expect(widthContribution(1.4)).toBe(0);
    expect(widthContribution(2.5)).toBe(15);
  });
  it("cross-slope: free below 2.08%, capped at -20", () => {
    expect(crossSlopeContribution(1)).toBe(0);
    expect(crossSlopeContribution(5)).toBe(-20);
  });
});

describe("scoreFacilitySet — neutral baseline", () => {
  it("returns the neutral baseline (70) for NO data, not 0", () => {
    expect(scoreFacilitySet([])).toBe(FACILITY_NEUTRAL);
    expect(FACILITY_NEUTRAL).toBe(70);
  });
  it("scores an elevator node above the neutral baseline", () => {
    const score = scoreFacilitySet([node("elevator", { elevator: "yes" })]);
    expect(score).toBeGreaterThan(FACILITY_NEUTRAL);
  });
  it("scores stairs below the neutral baseline", () => {
    const score = scoreFacilitySet([node("stairs", { highway: "steps" })]);
    expect(score).toBeLessThan(FACILITY_NEUTRAL);
  });
  it("scoreOsmNode rewards a wheelchair=yes elevator", () => {
    expect(
      scoreOsmNode(node("elevator", { wheelchair: "yes" })),
    ).toBeGreaterThan(0);
  });
});

describe("walkPenaltyScore — mode-aware, monotonic, capped", () => {
  it("is zero within the free distance", () => {
    expect(walkPenaltyScore(150, "wheelchair")).toBe(0);
    expect(walkPenaltyScore(400, "normal")).toBe(0);
  });
  it("grows linearly past the free distance", () => {
    expect(walkPenaltyScore(500, "wheelchair")).toBeCloseTo(
      (500 - 150) * 0.03,
      5,
    );
    expect(walkPenaltyScore(1400, "normal")).toBeCloseTo(1000 * 0.01, 5);
  });
  it("is capped per mode", () => {
    expect(walkPenaltyScore(100000, "wheelchair")).toBe(35);
    expect(walkPenaltyScore(100000, "elderly")).toBe(30);
    expect(walkPenaltyScore(100000, "visual_impaired")).toBe(25);
    expect(walkPenaltyScore(100000, "normal")).toBe(15);
  });
  it("penalises a long walk far more than a short one (wheelchair)", () => {
    expect(walkPenaltyScore(1444, "wheelchair")).toBeGreaterThan(
      walkPenaltyScore(425, "wheelchair"),
    );
  });
});

describe("dataConfidenceFromRatio — thirds", () => {
  it("maps coverage ratio to a confidence label", () => {
    expect(dataConfidenceFromRatio(1)).toBe("high");
    expect(dataConfidenceFromRatio(2 / 3)).toBe("high");
    expect(dataConfidenceFromRatio(0.5)).toBe("medium");
    expect(dataConfidenceFromRatio(1 / 3)).toBe("medium");
    expect(dataConfidenceFromRatio(0.2)).toBe("low");
    expect(dataConfidenceFromRatio(0)).toBe("low");
  });
});

describe("routeCost / prerankCost — walk distance & transfers count", () => {
  it("routeCost rises with walk distance (wheelchair)", () => {
    expect(routeCost(30, 0, 50, "wheelchair", 1444)).toBeGreaterThan(
      routeCost(30, 0, 50, "wheelchair", 425),
    );
  });
  it("prerankCost rises with transfers and walk distance", () => {
    expect(prerankCost(30, 1, 0, "wheelchair")).toBeGreaterThan(
      prerankCost(30, 0, 0, "wheelchair"),
    );
    expect(prerankCost(30, 0, 1444, "wheelchair")).toBeGreaterThan(
      prerankCost(30, 0, 425, "wheelchair"),
    );
  });
});

describe("scoreRoute — walk penalty, confidence, warnings, neutral baseline, and factors", () => {
  it("a long walk lowers the total score", () => {
    const short = scoreRoute([], 30, 40, 30, 0, "wheelchair", 425, 1);
    const long = scoreRoute([], 30, 40, 30, 0, "wheelchair", 1444, 1);
    expect(long.totalScore).toBeLessThan(short.totalScore);
    expect(long.components.walkPenalty).toBeGreaterThan(
      short.components.walkPenalty,
    );
  });
  it("flags low data confidence + warning when no a11y data on the route", () => {
    const r = scoreRoute([], 30, 40, 30, 0, "wheelchair", 0, 0);
    expect(r.dataConfidence).toBe("low");
    expect(r.warnings).toContain("沿途無障礙資料不足，分數為保守估計");
  });
  it("provides neutral baseline (65~70 a11y baseline) when no OSM facility data is present", () => {
    const r = scoreRoute([], 30, 40, 30, 0, "wheelchair", 0, 0);
    // components.facilityScore = 70, criticalFeatureScore = 65
    // a11yScore = 70*(40/65) + 65*(25/65) = 68.08
    expect(r.components.facilityScore).toBe(70);
    expect(r.components.criticalFeatureScore).toBe(65);
    expect(r.totalScore).toBeGreaterThanOrEqual(65);
    expect(r.factors).toBeDefined();
    expect(r.factors?.some((f) => f.icon === "sparse_data")).toBe(true);
  });
  it("produces structured explainability factors for positive, negative, and info signals", () => {
    const positiveNodes = [
      node("elevator", { elevator: "yes" }),
      node("kerb_cut", { kerb: "flush" }),
    ];
    const posRoute = scoreRoute(
      positiveNodes,
      30,
      40,
      30,
      2,
      "wheelchair",
      0,
      1,
    );
    expect(posRoute.factors).toBeDefined();
    expect(
      posRoute.factors?.some(
        (f) => f.icon === "elevator" && f.type === "positive",
      ),
    ).toBe(true);
    expect(
      posRoute.factors?.some((f) => f.icon === "ramp" && f.type === "positive"),
    ).toBe(true);
    expect(
      posRoute.factors?.some(
        (f) => f.icon === "bus_accessible" && f.type === "positive",
      ),
    ).toBe(true);

    const negativeNodes = [
      node("stairs", { highway: "steps" }),
      node("crossing", { incline: "12%" }),
    ];
    const negRoute = scoreRoute(
      negativeNodes,
      30,
      40,
      30,
      0,
      "wheelchair",
      1200,
      1,
    );
    expect(
      negRoute.factors?.some(
        (f) => f.icon === "stairs" && f.type === "negative",
      ),
    ).toBe(true);
    expect(
      negRoute.factors?.some(
        (f) => f.icon === "slope" && f.type === "negative",
      ),
    ).toBe(true);
    expect(
      negRoute.factors?.some(
        (f) => f.icon === "long_walk" && f.type === "negative",
      ),
    ).toBe(true);
  });
  it("keeps totalScore within 0–100", () => {
    const r = scoreRoute([], 200, 40, 30, 0, "wheelchair", 100000, 0);
    expect(r.totalScore).toBeGreaterThanOrEqual(0);
    expect(r.totalScore).toBeLessThanOrEqual(100);
  });
});

describe("政大 → 台北車站 regression (the original complaint)", () => {
  // Route 2 (251):      34 min, 0 transfers, 1444 m walk
  // Route 3 (66→TRA):   38 min, 1 transfer,   425 m walk
  // The complaint: route 2 ranked ABOVE route 3 because the 1.4 km walk was
  // effectively free — ranking had degenerated to travel time.
  const cost251 = (walkDist: number) =>
    routeCost(34, 0, 50, "wheelchair", walkDist);
  const costTRA = (walkDist: number) =>
    routeCost(38, 1, 50, "wheelchair", walkDist);

  it("WITHOUT walk distance, the faster 1.4 km route wins (the old bug)", () => {
    // equal score, no walk term → pure time + transfer → 251 ranks first
    expect(cost251(0)).toBeLessThan(costTRA(0));
  });

  it("WITH real walk distances, the 425 m route now out-ranks the 1.4 km route", () => {
    expect(costTRA(425)).toBeLessThan(cost251(1444));
  });
});

describe("mode profiles — P5: elderly / visual_impaired actually bite", () => {
  it("visual_impaired scores tactile paving + audio signals far above wheelchair", () => {
    const facilities = [
      node("crossing", {
        tactile_paving: "yes",
        "traffic_signals:sound": "yes",
      }),
    ];
    const visual = scoreRoute(facilities, 20, 20, 20, 0, "visual_impaired");
    const wheelchair = scoreRoute(facilities, 20, 20, 20, 0, "wheelchair");
    // visual weights: tactile 30 + audio 25 = 55; wheelchair: tactile 0 + audio 4
    expect(visual.components.criticalFeatureScore).toBeGreaterThan(
      wheelchair.components.criticalFeatureScore,
    );
    expect(visual.components.criticalFeatureScore).toBeGreaterThanOrEqual(50);
  });

  it("elderly weights accessible toilets above wheelchair", () => {
    const facilities = [node("toilet", { "toilets:wheelchair": "yes" })];
    const elderly = scoreRoute(facilities, 20, 20, 20, 0, "elderly");
    const wheelchair = scoreRoute(facilities, 20, 20, 20, 0, "wheelchair");
    // elderly toilet weight 14 vs wheelchair 6
    expect(elderly.components.criticalFeatureScore).toBeGreaterThan(
      wheelchair.components.criticalFeatureScore,
    );
  });

  it("transfer penalty scales by mode: wheelchair > elderly > normal", () => {
    const wc = routeCost(30, 1, 50, "wheelchair", 0);
    const eld = routeCost(30, 1, 50, "elderly", 0);
    const norm = routeCost(30, 1, 50, "normal", 0);
    expect(wc).toBeGreaterThan(eld);
    expect(eld).toBeGreaterThan(norm);
  });

  it("walk penalty is strictest for wheelchair, loosest for normal (same 1 km walk)", () => {
    const d = 1000;
    expect(walkPenaltyScore(d, "wheelchair")).toBeGreaterThan(
      walkPenaltyScore(d, "elderly"),
    );
    expect(walkPenaltyScore(d, "elderly")).toBeGreaterThan(
      walkPenaltyScore(d, "visual_impaired"),
    );
    expect(walkPenaltyScore(d, "visual_impaired")).toBeGreaterThan(
      walkPenaltyScore(d, "normal"),
    );
  });

  it("the SAME route scores differently per mode (the profile is not cosmetic)", () => {
    const facilities = [
      node("elevator", { elevator: "yes" }),
      node("crossing", {
        tactile_paving: "yes",
        "traffic_signals:sound": "yes",
      }),
    ];
    const scores = (
      ["wheelchair", "elderly", "visual_impaired", "normal"] as const
    ).map((m) => scoreRoute(facilities, 25, 30, 25, 0, m, 600).totalScore);
    // not all four identical
    expect(new Set(scores).size).toBeGreaterThan(1);
  });
});

describe("walkSpeedMps — E2 mode-aware walk speed", () => {
  it("returns the per-mode m/s", () => {
    expect(walkSpeedMps("wheelchair")).toBe(0.8);
    expect(walkSpeedMps("elderly")).toBe(0.9);
    expect(walkSpeedMps("visual_impaired")).toBe(1.0);
    expect(walkSpeedMps("normal")).toBe(1.3);
  });
  it("defaults to the conservative wheelchair speed", () => {
    expect(walkSpeedMps()).toBe(0.8);
  });
  it("a 685 m walk is ~14 min for a wheelchair, not ~8 (the original symptom)", () => {
    const wheelchairMin = 685 / walkSpeedMps("wheelchair") / 60;
    const footWalkMin = 685 / 1.33 / 60; // OTP foot-walking default ≈ the old 8 min
    expect(wheelchairMin).toBeGreaterThan(13);
    expect(wheelchairMin).toBeLessThan(15);
    expect(footWalkMin).toBeLessThan(9);
  });
});

describe("environmentPenalty", () => {
  it("returns 0 for empty conditions", () => {
    expect(environmentPenalty({}, "wheelchair", 500)).toBe(0);
  });

  it("applies rain tiers scaled by mode factor", () => {
    expect(
      environmentPenalty({ precipitationProbability: 70 }, "wheelchair", 0),
    ).toBe(12);
    expect(
      environmentPenalty({ precipitationProbability: 40 }, "wheelchair", 0),
    ).toBe(6);
    expect(
      environmentPenalty({ precipitationProbability: 39 }, "wheelchair", 0),
    ).toBe(0);
    // normal mode factor 0.5
    expect(
      environmentPenalty({ precipitationProbability: 40 }, "normal", 0),
    ).toBe(3);
  });

  it("gates heat penalty on walk distance exceeding the mode free distance", () => {
    // wheelchair freeM = 150; below → no heat penalty
    expect(environmentPenalty({ temperature: 36 }, "wheelchair", 100)).toBe(0);
    // above → 10 * factor 1.0
    expect(environmentPenalty({ temperature: 36 }, "wheelchair", 500)).toBe(10);
    expect(environmentPenalty({ temperature: 32 }, "wheelchair", 500)).toBe(5);
    expect(environmentPenalty({ temperature: 31 }, "wheelchair", 500)).toBe(0);
  });

  it("applies air-quality penalty unscaled by mode", () => {
    expect(environmentPenalty({ airQuality: "非常不健康" }, "normal", 0)).toBe(
      12,
    );
    expect(environmentPenalty({ airQuality: "不健康" }, "normal", 0)).toBe(8);
    expect(
      environmentPenalty({ airQuality: "對敏感族群不健康" }, "normal", 0),
    ).toBe(4);
    expect(environmentPenalty({ airQuality: "良好" }, "normal", 0)).toBe(0);
  });

  it("clamps the combined penalty to ENV_PENALTY_CAP", () => {
    const p = environmentPenalty(
      {
        precipitationProbability: 90,
        temperature: 40,
        airQuality: "非常不健康",
      },
      "wheelchair",
      1000,
    );
    expect(p).toBe(ENV_PENALTY_CAP);
  });
});

describe("scoreRoute environment factor", () => {
  const nodes = [node("elevator", { elevator: "yes" })];

  it("omits environmentScore and is unchanged when env is undefined", () => {
    const r = scoreRoute(nodes, 20, 30, 10, 1, "wheelchair", 300, 1);
    expect(r.components.environmentScore).toBeUndefined();
  });

  it("adds environmentScore and lowers totalScore when conditions are poor", () => {
    const base = scoreRoute(nodes, 20, 30, 10, 1, "wheelchair", 300, 1);
    const withEnv = scoreRoute(nodes, 20, 30, 10, 1, "wheelchair", 300, 1, {
      airQuality: "非常不健康",
      precipitationProbability: 80,
    });
    expect(withEnv.components.environmentScore).toBeDefined();
    expect(withEnv.components.environmentScore!).toBeLessThan(100);
    expect(withEnv.totalScore).toBeLessThan(base.totalScore);
  });

  it("environmentScore is 100 when conditions are ideal", () => {
    const r = scoreRoute(nodes, 20, 30, 10, 1, "wheelchair", 300, 1, {
      airQuality: "良好",
      precipitationProbability: 0,
      temperature: 24,
    });
    expect(r.components.environmentScore).toBe(100);
  });
});

describe("resolveA11yConstraints", () => {
  it("defaults both flags from the mode profile's tier1Required", () => {
    expect(resolveA11yConstraints("wheelchair")).toEqual({
      avoidStairs: true,
      requireElevator: true,
    });
    for (const mode of ["elderly", "visual_impaired", "normal"] as const) {
      expect(resolveA11yConstraints(mode)).toEqual({
        avoidStairs: false,
        requireElevator: false,
      });
    }
  });

  it("treats an undefined override as absent, not as false", () => {
    expect(
      resolveA11yConstraints("wheelchair", {
        avoidStairs: undefined,
        requireElevator: undefined,
      }),
    ).toEqual({ avoidStairs: true, requireElevator: true });
  });

  it("lets explicit flags raise the constraints for a non-wheelchair mode", () => {
    expect(
      resolveA11yConstraints("elderly", {
        avoidStairs: true,
        requireElevator: true,
      }),
    ).toEqual({ avoidStairs: true, requireElevator: true });
  });

  it("lets explicit false relax wheelchair mode, per flag", () => {
    expect(
      resolveA11yConstraints("wheelchair", { avoidStairs: false }),
    ).toEqual({ avoidStairs: false, requireElevator: true });
    expect(
      resolveA11yConstraints("wheelchair", { requireElevator: false }),
    ).toEqual({ avoidStairs: true, requireElevator: false });
  });

  it("falls back to the normal profile for an unknown mode", () => {
    expect(
      resolveA11yConstraints(
        "bogus" as Parameters<typeof resolveA11yConstraints>[0],
      ),
    ).toEqual({ avoidStairs: false, requireElevator: false });
  });
});

describe("transferPenaltyScore & transfer integration in scoreRoute", () => {
  it("transferPenaltyScore: 0 for direct routes, scaled by mode", () => {
    expect(transferPenaltyScore(0, "wheelchair")).toBe(0);
    expect(transferPenaltyScore(1, "wheelchair")).toBe(10); // 1 * 5 * 2 = 10
    expect(transferPenaltyScore(2, "wheelchair")).toBe(20); // 2 * 5 * 2 = 20 (capped at 20)
    expect(transferPenaltyScore(3, "wheelchair")).toBe(20); // capped at 20
    expect(transferPenaltyScore(1, "elderly")).toBe(8); // 1 * 5 * 1.5 = 7.5 -> 8
    expect(transferPenaltyScore(1, "normal")).toBe(5); // 1 * 5 * 1 = 5
  });

  it("scoreRoute penalizes routes with transfers compared to direct routes", () => {
    const direct = scoreRoute(
      [],
      20,
      30,
      10,
      1,
      "wheelchair",
      150,
      1,
      undefined,
      0,
    );
    const with1Transfer = scoreRoute(
      [],
      20,
      30,
      10,
      1,
      "wheelchair",
      150,
      1,
      undefined,
      1,
    );
    const with2Transfers = scoreRoute(
      [],
      20,
      30,
      10,
      1,
      "wheelchair",
      150,
      1,
      undefined,
      2,
    );

    expect(direct.components.transferPenalty).toBe(0);
    expect(with1Transfer.components.transferPenalty).toBe(10);
    expect(with2Transfers.components.transferPenalty).toBe(20);

    expect(direct.totalScore).toBeGreaterThan(with1Transfer.totalScore);
    expect(with1Transfer.totalScore).toBeGreaterThan(with2Transfers.totalScore);

    // Factors verification
    expect(direct.factors?.some((f) => f.text.includes("一車直達"))).toBe(true);
    expect(
      with1Transfer.factors?.some((f) => f.text.includes("需轉乘 1 次")),
    ).toBe(true);
    expect(
      with2Transfers.factors?.some((f) => f.text.includes("需轉乘 2 次")),
    ).toBe(true);
  });
});
