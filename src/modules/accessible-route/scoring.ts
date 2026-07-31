/**
 * Evidence-based accessibility scoring for wheelchair route planning.
 *
 * Produces a per-node score and a route-level score from OSM a11y tags, using a
 * tier hierarchy (critical curb ramps/elevators, high surface/slope/width,
 * moderate toilets/crossings/tactile paving, minor shelter/bench/lighting) with
 * a route-level accessibility 65% / travel-time 35% split. Factor weights are
 * derived from peer-reviewed accessibility literature and Taiwan/ADA standards.
 */

import type { IOsmA11y } from "../../types";
import type { AccessibilityMode } from "../../types/route";
import type {
  TagWeightMap,
  ScoreLabel,
  ModeProfile,
  DataConfidence,
  RouteAccessibilityScore,
  A11yConstraints,
  A11yConstraintOverrides,
} from "./accessible-route.types";

export type {
  ScoreLabel,
  ModeProfile,
  DataConfidence,
  RouteAccessibilityScore,
  A11yConstraints,
  A11yConstraintOverrides,
};

const TIER1_WEIGHTS: TagWeightMap = {
  wheelchair: {
    yes: 40,
    designated: 35,
    limited: 15,
    no: -20,
  },
  elevator: {
    yes: 38,
    wheelchair: 40,
  },
  highway: {
    elevator: 38,
    dropped_kerb: 30,
  },
  "ramp:wheelchair": {
    yes: 28,
  },
  ramp: {
    yes: 22,
  },
  kerb: {
    flush: 28,
    lowered: 18,
    no: 15,
    raised: -15,
  },
};

const TIER2_WEIGHTS: TagWeightMap = {
  smoothness: {
    excellent: 20,
    good: 16,
    intermediate: 10,
    bad: -8,
    very_bad: -18,
    horrible: -25,
    very_horrible: -30,
    impassable: -35,
  },
  surface: {
    asphalt: 12,
    concrete: 10,
    paving_stones: 5,
    sett: -5,
    cobblestone: -12,
    gravel: -15,
    grass: -20,
    sand: -20,
    mud: -25,
    dirt: -18,
  },
  "width:lanes": {},
};

const TIER3_WEIGHTS: TagWeightMap = {
  "toilets:wheelchair": {
    yes: 12,
    designated: 12,
    limited: 5,
    no: 0,
  },
  "traffic_signals:sound": {
    yes: 8,
  },
  "traffic_signals:vibration": {
    yes: 5,
  },
  tactile_paving: {
    yes: 8,
    no: 0,
  },
  crossing: {
    traffic_signals: 8,
    "marked;traffic_signals": 10,
    zebra: 6,
    marked: 4,
    uncontrolled: 0,
    unmarked: -2,
  },
  "pedestrian arcade:wheelchair": {
    yes: 6,
    limited: 2,
    no: -4,
  },
};

const TIER4_WEIGHTS: TagWeightMap = {
  shelter: { yes: 4 },
  bench: { yes: 3 },
  automatic_door: { yes: 5 },
  door: {
    automatic: 5,
    sliding: 3,
    hinged: 0,
  },
  lit: { yes: 3, "24/7": 4 },
  "capacity:disabled": {},
};

const ALL_TAG_WEIGHTS: TagWeightMap = {
  ...TIER4_WEIGHTS,
  ...TIER3_WEIGHTS,
  ...TIER2_WEIGHTS,
  ...TIER1_WEIGHTS,
};

/**
 * Convert a slope percentage (running grade) to a signed score contribution
 * (0 to -35; only a penalty, since slope is always a cost).
 *
 * @param gradePercent Running grade as a percentage (sign ignored).
 * @returns The slope penalty contribution.
 */
export function slopeContribution(gradePercent: number): number {
  const g = Math.abs(gradePercent);
  if (g <= 5) return 0;
  if (g <= 8.33) return -8;
  if (g <= 10) return -18;
  if (g <= 12.5) return -28;
  return -35;
}

/**
 * Convert a numeric path width in metres to a score contribution.
 *
 * @param widthMetres Path width in metres.
 * @returns The width contribution (penalty when below wheelchair minimum,
 *   bonus when wide enough to pass).
 */
export function widthContribution(widthMetres: number): number {
  if (widthMetres < 0.9) return -30;
  if (widthMetres < 1.3) return -10;
  if (widthMetres < 1.5) return 0;
  if (widthMetres < 2.0) return 8;
  return 15;
}

/**
 * Transverse (cross) slope penalty.
 *
 * @param crossSlopePercent Cross slope as a percentage (sign ignored).
 * @returns The cross-slope penalty contribution (0 to -20).
 */
export function crossSlopeContribution(crossSlopePercent: number): number {
  const g = Math.abs(crossSlopePercent);
  if (g <= 2.08) return 0;
  if (g <= 2.5) return -5;
  if (g <= 4) return -12;
  return -20;
}

const NODE_SCORE_DENOM = 100;

/**
 * Score for a stop/station with NO accessibility data — "fair / unknown", not
 * "critical". Treating unknown as 0 collapsed the accessibility budget on
 * Taiwan's sparse OSM coverage (every data-less route scored the same), so the
 * ranking degenerated to pure travel time. A neutral baseline keeps unknown from
 * masquerading as bad; dataConfidence / warnings carry the uncertainty instead.
 */
export const FACILITY_NEUTRAL = 40;

/**
 * Score a single OsmA11y node on a 0–100 scale, representing how much the
 * facility improves wheelchair accessibility at its location. A category-level
 * base bonus is added (elevator +15, kerb_cut +10, ramp +8, toilet +5) plus
 * tag-level contributions and numeric width/incline penalties.
 *
 * @param node OSM a11y node to score.
 * @returns The node score on a 0–100 scale.
 */
export function scoreOsmNode(node: IOsmA11y): number {
  let raw = 0;

  switch (node.category) {
    case "elevator":
      raw += 15;
      break;
    case "kerb_cut":
      raw += 10;
      break;
    case "ramp":
      raw += 8;
      break;
    case "toilet":
      raw += 5;
      break;
    default:
      break;
  }

  const tags = node.tags ?? {};
  for (const [tagKey, valueMap] of Object.entries(ALL_TAG_WEIGHTS)) {
    const val = tags[tagKey];
    if (val === undefined) continue;
    const contribution = valueMap[val] ?? 0;
    raw += contribution;
  }

  const widthRaw = tags["width"];
  if (widthRaw) {
    const widthM = parseFloat(widthRaw);
    if (!isNaN(widthM)) raw += widthContribution(widthM);
  }

  const inclineRaw = tags["incline"];
  if (inclineRaw) {
    const cleaned = inclineRaw.replace("%", "").replace("°", "");
    const grade = parseFloat(cleaned);
    if (!isNaN(grade)) raw += slopeContribution(grade);
  }

  const clamped = Math.max(0, Math.min(raw, NODE_SCORE_DENOM));
  return (clamped / NODE_SCORE_DENOM) * 100;
}

/**
 * Score a collection of OSM nodes around a stop/station on 0–100.
 *
 * Combines the MAX node score (best single asset) with the average (environment
 * density), then adds binary bonuses for Tier 1 presence (elevator, flush kerb,
 * ramp, accessible toilet). An empty node set returns 0 (unknown = worst case).
 *
 * @param nodes OSM a11y nodes near the stop/station.
 * @returns The facility-set score on a 0–100 scale.
 */
export function scoreFacilitySet(nodes: IOsmA11y[]): number {
  if (!nodes.length) return FACILITY_NEUTRAL;

  const maxNodeScore = Math.max(...nodes.map(scoreOsmNode));

  const avgNodeScore =
    nodes.reduce((sum, n) => sum + scoreOsmNode(n), 0) / nodes.length;

  const hasElevator = nodes.some(
    (n) =>
      n.category === "elevator" ||
      n.tags?.["elevator"] === "yes" ||
      n.tags?.["highway"] === "elevator"
  );
  const hasFlushKerb = nodes.some(
    (n) =>
      n.category === "kerb_cut" ||
      n.tags?.["kerb"] === "flush" ||
      n.tags?.["kerb"] === "lowered" ||
      n.tags?.["highway"] === "dropped_kerb"
  );
  const hasRamp = nodes.some(
    (n) => n.category === "ramp" || n.tags?.["ramp:wheelchair"] === "yes"
  );
  const hasAccessibleToilet = nodes.some(
    (n) => n.tags?.["toilets:wheelchair"] === "yes"
  );

  let score = maxNodeScore * 0.6 + avgNodeScore * 0.4;

  if (hasElevator) score = Math.min(score + 15, 95);
  if (hasFlushKerb) score = Math.min(score + 8, 95);
  if (hasRamp) score = Math.min(score + 5, 95);
  if (hasAccessibleToilet) score = Math.min(score + 4, 95);

  return Math.min(score, 100);
}

export function scoreLabel(score: number): ScoreLabel {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  if (score >= 20) return "poor";
  return "critical";
}

export const MODE_PROFILES: Record<AccessibilityMode, ModeProfile> = {
  wheelchair: {
    a11yWeight: 0.65,
    timeWeight: 0.35,
    transferPenaltyMultiplier: 2,
    tier1Required: true,
    criticalWeights: {
      elevator: 35,
      flushKerb: 30,
      ramp: 15,
      wheelchairYes: 10,
      accessibleToilet: 6,
      audioSignal: 4,
      tactilePaving: 0,
    },
  },
  elderly: {
    a11yWeight: 0.7,
    timeWeight: 0.3,
    transferPenaltyMultiplier: 1.5,
    tier1Required: false,
    criticalWeights: {
      elevator: 32,
      flushKerb: 22,
      ramp: 14,
      wheelchairYes: 8,
      accessibleToilet: 14,
      audioSignal: 5,
      tactilePaving: 5,
    },
  },
  visual_impaired: {
    a11yWeight: 0.65,
    timeWeight: 0.35,
    transferPenaltyMultiplier: 1,
    tier1Required: false,
    criticalWeights: {
      elevator: 15,
      flushKerb: 12,
      ramp: 8,
      wheelchairYes: 5,
      accessibleToilet: 5,
      audioSignal: 25,
      tactilePaving: 30,
    },
  },
  normal: {
    a11yWeight: 0.65,
    timeWeight: 0.35,
    transferPenaltyMultiplier: 1,
    tier1Required: false,
    criticalWeights: {
      elevator: 35,
      flushKerb: 30,
      ramp: 15,
      wheelchairYes: 10,
      accessibleToilet: 6,
      audioSignal: 4,
      tactilePaving: 0,
    },
  },
};

/**
 * Resolve the hard accessibility constraints for a request. Explicit caller
 * values always win; an omitted field falls back to the mode profile's
 * `tier1Required`, so a request that sends neither flag behaves exactly as it
 * did before the flags existed (wheelchair → both on, others → both off).
 *
 * @param mode Accessibility mode supplying the defaults.
 * @param overrides Caller-supplied flags; `undefined` fields take the default.
 * @returns The fully resolved constraints.
 */
export function resolveA11yConstraints(
  mode: AccessibilityMode = "normal",
  overrides?: A11yConstraintOverrides,
): A11yConstraints {
  const tier1Required = (MODE_PROFILES[mode] ?? MODE_PROFILES.normal)
    .tier1Required;
  return {
    avoidStairs: overrides?.avoidStairs ?? tier1Required,
    requireElevator: overrides?.requireElevator ?? tier1Required,
  };
}

/**
 * Per-mode walk-distance penalty params: distance up to `freeM` is free, then a
 * linear penalty of `slope` points/metre accrues up to `cap`. A long walk is the
 * single biggest barrier for wheelchair/elderly users, so it must lower the
 * user-facing score AND the ranking cost — not merely leak in via travel time.
 */
const WALK_PENALTY: Record<
  AccessibilityMode,
  { freeM: number; slope: number; cap: number }
> = {
  wheelchair: { freeM: 150, slope: 0.03, cap: 35 },
  elderly: { freeM: 200, slope: 0.025, cap: 30 },
  visual_impaired: { freeM: 250, slope: 0.02, cap: 25 },
  normal: { freeM: 400, slope: 0.01, cap: 15 },
};

/**
 * Walk-distance penalty as a positive magnitude (callers subtract it from a
 * score or add it to a ranking cost). Zero up to the mode's free distance, then
 * linear to the mode's cap.
 *
 * @param walkDistanceM Total walking distance of the route in metres.
 * @param mode Accessibility mode driving the thresholds. Default "normal".
 * @returns The penalty magnitude (0 to the mode's cap).
 */
export function walkPenaltyScore(
  walkDistanceM: number,
  mode: AccessibilityMode = "normal"
): number {
  const { freeM, slope, cap } = WALK_PENALTY[mode] ?? WALK_PENALTY.normal;
  const over = Math.max(0, walkDistanceM - freeM);
  return Math.min(over * slope, cap);
}

/**
 * Mode-specific walking speed (m/s) for converting walk DISTANCE to duration.
 * Wheelchair self-propulsion is ~0.8 m/s; OTP's foot-walking default (~1.33 m/s)
 * badly underestimates wheelchair/elderly walk times (the "685 m = 8 min"
 * symptom). Consumed by the ORS client and passed to OTP as the `walkSpeed`
 * request parameter.
 */
const WALK_SPEED_MPS: Record<AccessibilityMode, number> = {
  wheelchair: 0.8,
  elderly: 0.9,
  visual_impaired: 1.0,
  normal: 1.3,
};

/**
 * Walking speed in metres/second for a mode.
 *
 * @param mode Accessibility mode. Default "wheelchair" — the conservative choice
 *   for an accessibility-first planner when the caller has no mode.
 * @returns Walking speed in m/s.
 */
export function walkSpeedMps(mode: AccessibilityMode = "wheelchair"): number {
  return WALK_SPEED_MPS[mode] ?? WALK_SPEED_MPS.wheelchair;
}

/**
 * Map an accessibility-data coverage ratio (fraction of legs carrying any a11y
 * evidence) to a confidence label. Kept separate from the score so missing data
 * surfaces as uncertainty rather than being silently scored as bad.
 *
 * @param ratio Coverage ratio in [0, 1].
 * @returns "high" (≥ 2/3), "medium" (≥ 1/3) or "low".
 */
export function dataConfidenceFromRatio(ratio: number): DataConfidence {
  if (ratio >= 2 / 3) return "high";
  if (ratio >= 1 / 3) return "medium";
  return "low";
}

/**
 * Weather + air-quality conditions for a journey, resolved once per request. All
 * fields optional so a partially-available upstream (e.g. weather ok, air down)
 * still contributes what it has. `airQuality` holds the Chinese category string
 * produced by `classifyPm25` (良好 / 普通 / 對敏感族群不健康 / 不健康 / 非常不健康).
 */
export interface EnvConditions {
  precipitationProbability?: number;
  temperature?: number;
  airQuality?: string;
}

/**
 * Mode multiplier for weather penalties (rain/heat). Wheelchair and elderly
 * users are most affected by wet slopes and heat over long walks; a fully-abled
 * traveller far less so. Air-quality penalty is NOT scaled (respiratory impact
 * is broadly mode-independent).
 */
const ENV_MODE_FACTOR: Record<AccessibilityMode, number> = {
  wheelchair: 1.0,
  elderly: 1.0,
  visual_impaired: 0.7,
  normal: 0.5,
};

/**
 * Maximum total environment penalty (points subtracted from the route score);
 * also bounds `environmentScore` to the effective range 75–100.
 */
export const ENV_PENALTY_CAP = 25;

/**
 * Environment penalty magnitude (0 to ENV_PENALTY_CAP) from weather + air
 * quality. Rain and heat are mode-scaled; heat only bites when the walk exceeds
 * the mode's free distance; air quality applies unscaled to every mode. Missing
 * factors contribute 0, so an empty/unavailable `env` yields 0.
 *
 * @param env Resolved weather/air conditions (any field may be absent).
 * @param mode Accessibility mode driving the mode factor and heat gating.
 * @param walkDistanceM Total walking distance in metres (gates the heat penalty).
 * @returns The penalty magnitude, clamped to [0, ENV_PENALTY_CAP].
 */
export function environmentPenalty(
  env: EnvConditions,
  mode: AccessibilityMode = "normal",
  walkDistanceM = 0,
): number {
  const factor = ENV_MODE_FACTOR[mode] ?? ENV_MODE_FACTOR.normal;

  let rain = 0;
  const pop = env.precipitationProbability;
  if (typeof pop === "number") {
    if (pop >= 70) rain = 12;
    else if (pop >= 40) rain = 6;
  }

  let heat = 0;
  const temp = env.temperature;
  const freeM = (WALK_PENALTY[mode] ?? WALK_PENALTY.normal).freeM;
  if (typeof temp === "number" && walkDistanceM > freeM) {
    if (temp >= 36) heat = 10;
    else if (temp >= 32) heat = 5;
  }

  let air = 0;
  switch (env.airQuality) {
    case "非常不健康":
      air = 12;
      break;
    case "不健康":
      air = 8;
      break;
    case "對敏感族群不健康":
      air = 4;
      break;
    default:
      air = 0;
  }

  const penalty = (rain + heat) * factor + air;
  return Math.max(0, Math.min(ENV_PENALTY_CAP, penalty));
}

/**
 * Route-ranking cost — lower is better. NOT the user-facing score:
 * cost = travelTime + transferCount × 5 × modePenalty + (100 − a11yScore) × 0.3
 *        + walkPenalty.
 *
 * @param totalMinutes Total journey time in minutes.
 * @param transferCount Number of transfers in the route.
 * @param accessibilityScore Route accessibility score (0–100).
 * @param mode Accessibility mode driving the transfer/walk penalties. Default "normal".
 * @param walkDistanceM Total walking distance in metres (drives the walk penalty).
 * @returns The route-ranking cost.
 */
export function routeCost(
  totalMinutes: number,
  transferCount: number,
  accessibilityScore: number,
  mode: AccessibilityMode = "normal",
  walkDistanceM = 0
): number {
  const profile = MODE_PROFILES[mode] ?? MODE_PROFILES.normal;
  return (
    totalMinutes +
    transferCount * 5 * profile.transferPenaltyMultiplier +
    (100 - accessibilityScore) * 0.3 +
    walkPenaltyScore(walkDistanceM, mode)
  );
}

/**
 * Stage-1 pre-ranking cost for the two-stage pipeline — a cheap,
 * accessibility-aware proxy that needs NO OSM/facility data (used to pick the
 * top-N candidates to enrich before the real scoreRoute runs). Same shape as
 * routeCost minus the facility term: travelTime + transferPenalty + walkPenalty.
 *
 * @param totalMinutes Total journey time in minutes.
 * @param transferCount Number of transfers in the route.
 * @param walkDistanceM Total walking distance in metres.
 * @param mode Accessibility mode driving the penalties. Default "normal".
 * @returns The pre-ranking cost.
 */
export function prerankCost(
  totalMinutes: number,
  transferCount: number,
  walkDistanceM: number,
  mode: AccessibilityMode = "normal"
): number {
  const profile = MODE_PROFILES[mode] ?? MODE_PROFILES.normal;
  return (
    totalMinutes +
    transferCount * 5 * profile.transferPenaltyMultiplier +
    walkPenaltyScore(walkDistanceM, mode)
  );
}

/**
 * Score an AccessibleRoute object on a 0–100 scale, combining facility quality,
 * critical-feature presence and normalized travel time per the mode profile
 * (default accessibility 65% / time 35%).
 *
 * @param facilityNodes All OSM a11y nodes from all legs (walk + transit endpoints).
 * @param totalMinutes Total journey time in minutes.
 * @param maxMinutes Maximum journey time among all candidates (for normalization).
 * @param highlightCount Number of generated accessibility highlight strings.
 * @param mode Accessibility mode driving the weights. Default "normal".
 * @returns The route accessibility score, label and component breakdown.
 */
export function scoreRoute(
  facilityNodes: IOsmA11y[],
  totalMinutes: number,
  maxMinutes: number,
  minMinutes: number,
  highlightCount: number,
  mode: AccessibilityMode = "normal",
  walkDistanceM = 0,
  dataCoverageRatio = 1,
  env?: EnvConditions
): RouteAccessibilityScore {
  const profile = MODE_PROFILES[mode] ?? MODE_PROFILES.normal;
  const facilityScore = scoreFacilitySet(facilityNodes);

  const hasElevator = facilityNodes.some(
    (n) =>
      n.category === "elevator" ||
      n.tags?.["elevator"] === "yes" ||
      n.tags?.["highway"] === "elevator"
  );
  const hasFlushKerb = facilityNodes.some(
    (n) =>
      n.category === "kerb_cut" ||
      n.tags?.["kerb"] === "flush" ||
      n.tags?.["kerb"] === "lowered" ||
      n.tags?.["highway"] === "dropped_kerb"
  );
  const hasRamp = facilityNodes.some(
    (n) => n.category === "ramp" || n.tags?.["ramp:wheelchair"] === "yes"
  );
  const hasAccessibleToilet = facilityNodes.some(
    (n) => n.tags?.["toilets:wheelchair"] === "yes"
  );
  const hasWheelchairYes = facilityNodes.some(
    (n) =>
      n.tags?.["wheelchair"] === "yes" ||
      n.tags?.["wheelchair"] === "designated"
  );
  const hasAudioSignal = facilityNodes.some(
    (n) => n.tags?.["traffic_signals:sound"] === "yes"
  );
  const hasTactilePaving = facilityNodes.some(
    (n) => n.tags?.["tactile_paving"] === "yes"
  );

  const w = profile.criticalWeights;
  const criticalRaw =
    (hasElevator ? w.elevator : 0) +
    (hasFlushKerb ? w.flushKerb : 0) +
    (hasRamp ? w.ramp : 0) +
    (hasWheelchairYes ? w.wheelchairYes : 0) +
    (hasAccessibleToilet ? w.accessibleToilet : 0) +
    (hasAudioSignal ? w.audioSignal : 0) +
    (hasTactilePaving ? w.tactilePaving : 0);
  const criticalFeatureScore = Math.min(criticalRaw, 100);

  const timeRange = maxMinutes - minMinutes;
  const timeScore = timeRange > 0
    ? ((maxMinutes - totalMinutes) / timeRange) * 100
    : 100; // 唯一候選或等時路線不給予時間懲罰

  const highlightBonus = Math.min(highlightCount * 1.5, 5);
  const adjustedFacilityScore = Math.min(facilityScore + highlightBonus, 100);

  const a11yScore =
    adjustedFacilityScore * (40 / 65) + criticalFeatureScore * (25 / 65);

  const walkPenalty = walkPenaltyScore(walkDistanceM, mode);

  const envPenalty = env ? environmentPenalty(env, mode, walkDistanceM) : 0;

  const rawTotal =
    a11yScore * profile.a11yWeight +
    timeScore * profile.timeWeight -
    walkPenalty -
    envPenalty;
  const totalScore = Math.max(0, Math.min(100, Math.round(rawTotal)));

  const dataConfidence = dataConfidenceFromRatio(dataCoverageRatio);
  const warnings: string[] = [];
  if (dataConfidence === "low")
    warnings.push("沿途無障礙資料不足，分數為保守估計");
  if (walkPenalty >= 20) warnings.push("步行距離較長，行動不便者請留意");
  if (envPenalty >= 10) warnings.push("天候或空氣品質不佳，通行較費力");

  const components: RouteAccessibilityScore["components"] = {
    facilityScore: Math.round(adjustedFacilityScore),
    timeScore: Math.round(timeScore),
    criticalFeatureScore: Math.round(criticalFeatureScore),
    walkPenalty: Math.round(walkPenalty),
  };
  if (env) components.environmentScore = Math.round(100 - envPenalty);

  return {
    totalScore,
    label: scoreLabel(totalScore),
    dataConfidence,
    warnings,
    components,
  };
}

/**
 * Derive a surface quality penalty multiplier for a walk leg from the aggregate
 * OSM features along the leg — a lightweight environment-quality signal layered
 * on top of the already wheelchair-optimized ORS route.
 *
 * @param nodes OSM a11y nodes along the walk leg.
 * @returns A multiplier in [0.5, 1.0] applied to the walk leg's a11y score
 *   (1.0 = no penalty; 0.5 = severe surface degradation nearby).
 */
export function walkLegSurfaceMultiplier(nodes: IOsmA11y[]): number {
  if (!nodes.length) return 0.85;

  const surfacePenalties = nodes
    .map((n) => {
      const smoothness = n.tags?.["smoothness"];
      const surface = n.tags?.["surface"];
      let penalty = 0;
      if (smoothness) {
        const w = (TIER2_WEIGHTS.smoothness ?? {})[smoothness] ?? 0;
        penalty += w < 0 ? Math.abs(w) : 0;
      }
      if (surface) {
        const w = (TIER2_WEIGHTS.surface ?? {})[surface] ?? 0;
        penalty += w < 0 ? Math.abs(w) : 0;
      }
      return penalty;
    });

  const maxPenalty = Math.max(...surfacePenalties, 0);
  const multiplier = 1.0 - (Math.min(maxPenalty, 35) / 35) * 0.5;
  return Math.round(multiplier * 100) / 100;
}
