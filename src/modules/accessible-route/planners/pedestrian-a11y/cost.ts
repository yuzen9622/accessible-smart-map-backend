import {
  EDGE_FLAG,
  EDGE_TYPE,
  NODE_FLAG,
  SMOOTHNESS,
  SURFACE,
  WHEELCHAIR,
  type PedGraph,
} from "./graph.types";

export const INFEASIBLE = Number.POSITIVE_INFINITY;
/**
 * A finite last-resort search cost for an indoor edge that has neither a usable
 * traversal time nor a stored length. It lets the planner reach geometry
 * assembly, which returns `unavailable` instead of misclassifying an unknown
 * indoor distance as an accessibility refusal.
 */
export const UNMEASURABLE_INDOOR_PROXY_COST_M = 1_000_000_000;
export const WHEELCHAIR_WALK_SPEED_MPS = 0.8;
export const SLOPE_PERCENT_SCALE = 100;
export const SLOPE_COMPARISON_PRECISION = 1_000_000;
export const WIDTH_COMPARISON_PRECISION = 1_000_000;
export const WHEELCHAIR_MODERATE_SLOPE_PERCENT = 5;
export const WHEELCHAIR_STEEP_SLOPE_PERCENT = 8;
export const WHEELCHAIR_EXTREME_SLOPE_PERCENT = 12;
export const WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M = 0.9;
export const WHEELCHAIR_NARROW_WIDTH_M = 1.2;
export const WHEELCHAIR_MEDIUM_WIDTH_M = 1.5;
export const WHEELCHAIR_WIDE_WIDTH_M = 2;
export const WHEELCHAIR_RELAX_EXTREME_SLOPE_LEVEL = 1;
export const WHEELCHAIR_RELAX_NARROW_WIDTH_LEVEL = 2;
export const WHEELCHAIR_RELAX_STEPS_LEVEL = 3;
export const WHEELCHAIR_MAX_RELAXATION_LEVEL = 3;
export const MINIMUM_PENALTY_MULTIPLIER = 1;
export const MINIMUM_ADDITIVE_PENALTY_M = 0;
export const WHEELCHAIR_MODERATE_SLOPE_PENALTY_MULTIPLIER = 1.5;
export const WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER = 5;
export const WHEELCHAIR_RELAXED_EXTREME_SLOPE_PENALTY_MULTIPLIER = 8;
export const WHEELCHAIR_NARROW_WIDTH_PENALTY_MULTIPLIER = 2;
export const WHEELCHAIR_MEDIUM_WIDTH_PENALTY_MULTIPLIER = 1.5;
export const WHEELCHAIR_WIDE_WIDTH_PENALTY_MULTIPLIER = 1.15;
export const WHEELCHAIR_RELAXED_MIN_WIDTH_PENALTY_MULTIPLIER = 4;
export const WHEELCHAIR_LIMITED_TAG_PENALTY_MULTIPLIER = 1.5;
export const WHEELCHAIR_LOOSE_SURFACE_PENALTY_MULTIPLIER = 1.25;
export const WHEELCHAIR_UNSTABLE_SURFACE_PENALTY_MULTIPLIER = 1.75;
export const WHEELCHAIR_INTERMEDIATE_SMOOTHNESS_PENALTY_MULTIPLIER = 1.15;
export const WHEELCHAIR_BAD_SMOOTHNESS_PENALTY_MULTIPLIER = 1.5;
export const WHEELCHAIR_VERY_BAD_SMOOTHNESS_PENALTY_MULTIPLIER = 2;
export const WHEELCHAIR_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER = 3;
export const WHEELCHAIR_VERY_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER = 4;
export const WHEELCHAIR_RELAXED_STEPS_PENALTY_MULTIPLIER = 12;
export const WHEELCHAIR_ESCALATOR_PENALTY_MULTIPLIER = 8;
/**
 * Node-level matching (a curb ramp physically sits at the corner, i.e. the
 * crossing's endpoint node) found neither endpoint ramped for 36.8% of
 * crossings, so a missing observation means "not observed", not "no ramp
 * exists". This multiplier must stay finite: treating that 36.8% as
 * INFEASIBLE would collapse wheelchair routing across the graph.
 */
export const WHEELCHAIR_UNRAMPED_CROSSING_PENALTY_MULTIPLIER = 3;
/**
 * Applied when exactly one endpoint of a crossing has an observed curb ramp.
 * A wheelchair user who can descend one side but not climb the other still
 * cannot complete the crossing, so this stays strictly between the neutral
 * multiplier (both ends ramped) and {@link WHEELCHAIR_UNRAMPED_CROSSING_PENALTY_MULTIPLIER}
 * (neither end observed) rather than matching either extreme.
 */
export const WHEELCHAIR_ONE_SIDED_KERB_RAMP_PENALTY_MULTIPLIER = 2;

export interface CostProfile {
  name: "wheelchair" | "elderly" | "visual_impaired" | "normal";
  walkSpeedMps: number;
  relaxationLevel: number;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @returns Whether the index addresses a graph edge attribute.
 */
function isValidAttributeIndex(graph: PedGraph, attrIdx: number): boolean {
  return (
    Number.isInteger(attrIdx) &&
    attrIdx >= 0 &&
    attrIdx < graph.directedEdgeCount
  );
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @param profile Requested accessibility cost profile.
 * @returns The unpenalized edge cost in metres, a finite diagnostic cost for an
 * unmeasurable indoor proxy, or INFEASIBLE when its base is otherwise invalid.
 */
function baseCost(
  graph: PedGraph,
  attrIdx: number,
  profile: CostProfile,
): number {
  const isIndoor = (graph.edgeFlags[attrIdx] & EDGE_FLAG.INDOOR) !== 0;
  const lengthM = graph.edgeLengthM[attrIdx];
  if (!isIndoor) {
    return Number.isFinite(lengthM) && lengthM >= 0 ? lengthM : INFEASIBLE;
  }
  if (!Number.isFinite(profile.walkSpeedMps) || profile.walkSpeedMps <= 0) {
    return INFEASIBLE;
  }

  const traversalTimeS = graph.edgeTraversalTimeS[attrIdx];
  const traversalDistanceM = traversalTimeS * profile.walkSpeedMps;
  if (Number.isFinite(traversalDistanceM) && traversalDistanceM > 0) {
    return traversalDistanceM;
  }
  // Injector connectors have real length but no GTFS pathway traversal time.
  // They are explicitly indoor provenance for geometry proxy policy, yet their
  // physical connector length remains the correct cost basis.
  if (Number.isFinite(lengthM) && lengthM >= 0) {
    return lengthM;
  }
  return UNMEASURABLE_INDOOR_PROXY_COST_M;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @param profile Requested accessibility cost profile.
 * @returns The wheelchair slope multiplier, or INFEASIBLE for a hard limit.
 */
function slopePenalty(
  graph: PedGraph,
  attrIdx: number,
  profile: CostProfile,
): number {
  const slopeRatio = graph.edgeSlope[attrIdx];
  if (!Number.isFinite(slopeRatio)) {
    return MINIMUM_PENALTY_MULTIPLIER;
  }
  const slopePercent =
    Math.round(
      Math.abs(slopeRatio) * SLOPE_PERCENT_SCALE * SLOPE_COMPARISON_PRECISION,
    ) / SLOPE_COMPARISON_PRECISION;
  if (slopePercent > WHEELCHAIR_EXTREME_SLOPE_PERCENT) {
    return profile.relaxationLevel >= WHEELCHAIR_RELAX_EXTREME_SLOPE_LEVEL
      ? WHEELCHAIR_RELAXED_EXTREME_SLOPE_PENALTY_MULTIPLIER
      : INFEASIBLE;
  }
  if (slopePercent >= WHEELCHAIR_STEEP_SLOPE_PERCENT) {
    return WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER;
  }
  if (slopePercent >= WHEELCHAIR_MODERATE_SLOPE_PERCENT) {
    return WHEELCHAIR_MODERATE_SLOPE_PENALTY_MULTIPLIER;
  }
  return MINIMUM_PENALTY_MULTIPLIER;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @param profile Requested accessibility cost profile.
 * @returns The wheelchair effective-width multiplier, or INFEASIBLE for a hard limit.
 */
function widthPenalty(
  graph: PedGraph,
  attrIdx: number,
  profile: CostProfile,
): number {
  const widthM = graph.edgeWidthM[attrIdx];
  if (!Number.isFinite(widthM)) {
    return MINIMUM_PENALTY_MULTIPLIER;
  }
  const normalizedWidthM =
    Math.round(widthM * WIDTH_COMPARISON_PRECISION) /
    WIDTH_COMPARISON_PRECISION;
  if (normalizedWidthM < WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M) {
    return profile.relaxationLevel >= WHEELCHAIR_RELAX_NARROW_WIDTH_LEVEL
      ? WHEELCHAIR_RELAXED_MIN_WIDTH_PENALTY_MULTIPLIER
      : INFEASIBLE;
  }
  if (normalizedWidthM < WHEELCHAIR_NARROW_WIDTH_M) {
    return WHEELCHAIR_NARROW_WIDTH_PENALTY_MULTIPLIER;
  }
  if (normalizedWidthM < WHEELCHAIR_MEDIUM_WIDTH_M) {
    return WHEELCHAIR_MEDIUM_WIDTH_PENALTY_MULTIPLIER;
  }
  if (normalizedWidthM < WHEELCHAIR_WIDE_WIDTH_M) {
    return WHEELCHAIR_WIDE_WIDTH_PENALTY_MULTIPLIER;
  }
  return MINIMUM_PENALTY_MULTIPLIER;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @returns The wheelchair surface multiplier, with unknown values neutral.
 */
function surfacePenalty(graph: PedGraph, attrIdx: number): number {
  switch (graph.edgeSurface[attrIdx]) {
    case SURFACE.SETT:
    case SURFACE.UNHEWN_COBBLESTONE:
    case SURFACE.COBBLESTONE:
    case SURFACE.BRICKS:
    case SURFACE.METAL:
    case SURFACE.WOOD:
    case SURFACE.GRASS_PAVER:
    case SURFACE.COMPACTED:
    case SURFACE.FINE_GRAVEL:
    case SURFACE.WOODCHIPS:
    case SURFACE.MULCH:
    case SURFACE.LEAVES:
    case SURFACE.SHELLS:
      return WHEELCHAIR_LOOSE_SURFACE_PENALTY_MULTIPLIER;
    case SURFACE.GRAVEL:
    case SURFACE.PEBBLESTONE:
    case SURFACE.ROCK:
    case SURFACE.DIRT:
    case SURFACE.EARTH:
    case SURFACE.GROUND:
    case SURFACE.MUD:
    case SURFACE.SAND:
    case SURFACE.GRASS:
    case SURFACE.CLAY:
    case SURFACE.UNPAVED:
    case SURFACE.SOIL:
    case SURFACE.ICE:
    case SURFACE.SNOW:
      return WHEELCHAIR_UNSTABLE_SURFACE_PENALTY_MULTIPLIER;
    default:
      return MINIMUM_PENALTY_MULTIPLIER;
  }
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @returns The wheelchair smoothness multiplier, or INFEASIBLE for impassable ground.
 */
function smoothnessPenalty(graph: PedGraph, attrIdx: number): number {
  switch (graph.edgeSmoothness[attrIdx]) {
    case SMOOTHNESS.IMPASSABLE:
      return INFEASIBLE;
    case SMOOTHNESS.VERY_HORRIBLE:
      return WHEELCHAIR_VERY_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER;
    case SMOOTHNESS.HORRIBLE:
      return WHEELCHAIR_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER;
    case SMOOTHNESS.VERY_BAD:
      return WHEELCHAIR_VERY_BAD_SMOOTHNESS_PENALTY_MULTIPLIER;
    case SMOOTHNESS.BAD:
      return WHEELCHAIR_BAD_SMOOTHNESS_PENALTY_MULTIPLIER;
    case SMOOTHNESS.INTERMEDIATE:
      return WHEELCHAIR_INTERMEDIATE_SMOOTHNESS_PENALTY_MULTIPLIER;
    default:
      return MINIMUM_PENALTY_MULTIPLIER;
  }
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @returns The wheelchair-tag multiplier, or INFEASIBLE for an explicit denial.
 */
function wheelchairTagPenalty(graph: PedGraph, attrIdx: number): number {
  switch (graph.edgeWheelchair[attrIdx]) {
    case WHEELCHAIR.NO:
      return INFEASIBLE;
    case WHEELCHAIR.LIMITED:
      return WHEELCHAIR_LIMITED_TAG_PENALTY_MULTIPLIER;
    default:
      return MINIMUM_PENALTY_MULTIPLIER;
  }
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @param profile Requested accessibility cost profile.
 * @returns The steps multiplier, or INFEASIBLE for unramped stairs. GTFS indoor
 * stairs carry no ramp attribute, so they are always treated as unramped.
 */
function stepsPenalty(
  graph: PedGraph,
  attrIdx: number,
  profile: CostProfile,
): number {
  const edgeType = graph.edgeType[attrIdx];
  const isIndoorStairs = edgeType === EDGE_TYPE.INDOOR_STAIRS;
  const isSteps = edgeType === EDGE_TYPE.STEPS;
  const hasRamp = (graph.edgeFlags[attrIdx] & EDGE_FLAG.HAS_RAMP) !== 0;
  if (!isIndoorStairs && (!isSteps || hasRamp)) {
    return MINIMUM_PENALTY_MULTIPLIER;
  }
  return profile.relaxationLevel >= WHEELCHAIR_RELAX_STEPS_LEVEL
    ? WHEELCHAIR_RELAXED_STEPS_PENALTY_MULTIPLIER
    : INFEASIBLE;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @param fromNode Dense node index of the edge's start endpoint.
 * @param toNode Dense node index of the edge's end endpoint.
 * @returns A finite penalty multiplier keyed on how many endpoints of a
 * crossing carry an observed curb ramp: neutral when both do, a middle
 * multiplier when only one does, and the full unramped multiplier when
 * neither does. The neutral multiplier applies to every non-`CROSSING` edge
 * type. Never INFEASIBLE: missing curb ramp data means the corner was not
 * observed, not that it is impassable.
 */
function kerbRampPenalty(
  graph: PedGraph,
  attrIdx: number,
  fromNode: number,
  toNode: number,
): number {
  if (graph.edgeType[attrIdx] !== EDGE_TYPE.CROSSING) {
    return MINIMUM_PENALTY_MULTIPLIER;
  }
  const fromHasKerbRamp =
    (graph.nodeFlags[fromNode] & NODE_FLAG.HAS_KERB_RAMP) !== 0;
  const toHasKerbRamp =
    (graph.nodeFlags[toNode] & NODE_FLAG.HAS_KERB_RAMP) !== 0;
  if (fromHasKerbRamp && toHasKerbRamp) {
    return MINIMUM_PENALTY_MULTIPLIER;
  }
  if (fromHasKerbRamp || toHasKerbRamp) {
    return WHEELCHAIR_ONE_SIDED_KERB_RAMP_PENALTY_MULTIPLIER;
  }
  return WHEELCHAIR_UNRAMPED_CROSSING_PENALTY_MULTIPLIER;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @returns The escalator multiplier, high but finite so the edge stays usable.
 */
function escalatorPenalty(graph: PedGraph, attrIdx: number): number {
  return graph.edgeType[attrIdx] === EDGE_TYPE.INDOOR_ESCALATOR
    ? WHEELCHAIR_ESCALATOR_PENALTY_MULTIPLIER
    : MINIMUM_PENALTY_MULTIPLIER;
}

/**
 * @param cost Current finite edge cost in weighted metres.
 * @param multiplier Penalty multiplier to apply.
 * @returns The cost after applying the multiplier.
 */
function applyMultiplier(cost: number, multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier < MINIMUM_PENALTY_MULTIPLIER) {
    throw new Error("edge cost multiplier must be finite and at least 1");
  }
  return cost * multiplier;
}

/**
 * @param cost Current finite edge cost in weighted metres.
 * @param penaltyM Additive penalty in weighted metres.
 * @returns The cost after applying the additive penalty.
 */
function applyAdditivePenalty(cost: number, penaltyM: number): number {
  if (!Number.isFinite(penaltyM) || penaltyM < MINIMUM_ADDITIVE_PENALTY_M) {
    throw new Error(
      "edge cost additive penalty must be finite and non-negative",
    );
  }
  return cost + penaltyM;
}

/**
 * Returns an edge cost in weighted metres.
 *
 * The wheelchair profile applies the full penalty model. `normal`, `elderly`
 * and `visual_impaired` are deliberately NEUTRAL in this phase: base traversal
 * only, with no invented per-mode penalty, because no source-backed elderly or
 * visual-impairment edge attribute exists in the graph yet. Selection for those
 * modes is therefore shortest-path; the fare-gate policy still applies to all
 * four modes because it is enforced in the search, not in this cost model.
 *
 * All multipliers are checked before application to remain at least 1.0 and all
 * additive penalties are checked to remain non-negative. Those invariants keep
 * edge costs non-negative for the Dijkstra-equivalent production search; they
 * do not prove a non-zero coordinate-based lower bound across indoor proxies.
 *
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @param profile Requested accessibility cost profile.
 * @param fromNode Dense node index of the edge's start endpoint, used only by
 * the node-level {@link kerbRampPenalty}.
 * @param toNode Dense node index of the edge's end endpoint, used only by the
 * node-level {@link kerbRampPenalty}.
 * @returns A finite weighted-metre cost or INFEASIBLE when the edge cannot be used.
 */
export function edgeCost(
  graph: PedGraph,
  attrIdx: number,
  profile: CostProfile,
  fromNode: number,
  toNode: number,
): number {
  if (!isValidAttributeIndex(graph, attrIdx)) {
    return INFEASIBLE;
  }
  const unpenalizedCost = baseCost(graph, attrIdx, profile);
  if (unpenalizedCost === INFEASIBLE) {
    return INFEASIBLE;
  }
  if (profile.name !== "wheelchair") {
    return applyAdditivePenalty(unpenalizedCost, MINIMUM_ADDITIVE_PENALTY_M);
  }
  const multipliers = [
    slopePenalty(graph, attrIdx, profile),
    widthPenalty(graph, attrIdx, profile),
    surfacePenalty(graph, attrIdx),
    smoothnessPenalty(graph, attrIdx),
    wheelchairTagPenalty(graph, attrIdx),
    stepsPenalty(graph, attrIdx, profile),
    escalatorPenalty(graph, attrIdx),
    kerbRampPenalty(graph, attrIdx, fromNode, toNode),
  ];
  let cost = unpenalizedCost;
  for (const multiplier of multipliers) {
    if (multiplier === INFEASIBLE) {
      return INFEASIBLE;
    }
    cost = applyMultiplier(cost, multiplier);
  }
  return applyAdditivePenalty(cost, MINIMUM_ADDITIVE_PENALTY_M);
}
