import { EDGE_TYPE, type PedGraph } from "./graph.types";

export interface ForbidFareAccessPolicy {
  readonly mode: "forbid";
}

export interface TransitAuthorizedFareAccessPolicy {
  readonly mode: "transit_authorized";
  readonly authorizedStationIds: readonly string[];
}

/**
 * Diagnostic-only policy that opens every fare and exit gate.
 *
 * It exists so a planner can ask "would this succeed if no gate blocked it?"
 * and therefore report a gate obstruction as a deliberate fare-policy refusal
 * instead of misattributing it to accessibility. It must never reach a served
 * route: nothing parses it from a request, no factory builds it from caller
 * input, and the only legitimate use is a probe whose path is discarded.
 *
 * Authorizing every *known station* is not sufficient for that probe, because a
 * gate edge whose endpoints carry a blank or mismatched station identity is
 * unauthorizable by any station list yet is still gate-blocked.
 */
export interface DiagnosticAllowAllFareAccessPolicy {
  readonly mode: "diagnostic_allow_all";
}

/** Immutable authorization context for indoor fare-gate traversal. */
export type FareAccessPolicy =
  | ForbidFareAccessPolicy
  | TransitAuthorizedFareAccessPolicy
  | DiagnosticAllowAllFareAccessPolicy;

/** Frozen fail-closed default for pure walking and omitted authorization context. */
export const FORBID_FARE_ACCESS: ForbidFareAccessPolicy = Object.freeze({
  mode: "forbid",
});

/** Frozen probe policy; see {@link DiagnosticAllowAllFareAccessPolicy}. */
export const DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS: DiagnosticAllowAllFareAccessPolicy =
  Object.freeze({ mode: "diagnostic_allow_all" });

/**
 * @returns The shared frozen policy that forbids every fare and exit gate.
 */
export function createForbidFareAccess(): ForbidFareAccessPolicy {
  return FORBID_FARE_ACCESS;
}

/**
 * @param stationId Raw stable parent-station identifier.
 * @returns A trimmed stable parent-station identifier.
 */
function normalizeStationId(stationId: string): string {
  if (typeof stationId !== "string") {
    throw new Error("fare access station IDs must be strings");
  }
  const normalizedStationId = stationId.trim();
  if (normalizedStationId.length === 0) {
    throw new Error("fare access station IDs must not be empty");
  }
  return normalizedStationId;
}

/**
 * @param left First stable parent-station identifier.
 * @param right Second stable parent-station identifier.
 * @returns A locale-independent code-unit ordering for deterministic lookup.
 */
function compareStationIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * @param stationIds Stable parent-station identifiers from an authorization context.
 * @returns A sorted, deduplicated, frozen transit authorization policy.
 */
export function createTransitAuthorizedFareAccess(
  stationIds: Iterable<string>,
): TransitAuthorizedFareAccessPolicy {
  const normalizedStationIds = Array.from(stationIds, normalizeStationId).sort(
    compareStationIds,
  );
  const authorizedStationIds = normalizedStationIds.filter(
    (stationId, index) =>
      index === 0 || stationId !== normalizedStationIds[index - 1],
  );

  return Object.freeze({
    mode: "transit_authorized" as const,
    authorizedStationIds: Object.freeze(authorizedStationIds),
  });
}

/**
 * @param policy Caller-provided fare access context.
 * @returns A frozen policy with deterministic station-ID ordering.
 */
export function normalizeFareAccessPolicy(
  policy: FareAccessPolicy,
): FareAccessPolicy {
  if (policy.mode === "diagnostic_allow_all") {
    return DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS;
  }
  if (policy.mode !== "transit_authorized") {
    return FORBID_FARE_ACCESS;
  }
  return createTransitAuthorizedFareAccess(policy.authorizedStationIds);
}

/**
 * @param policy Fare access context to key.
 * @returns A primitive deterministic key suitable for a future compiled lookup.
 */
export function fareAccessPolicyKey(policy: FareAccessPolicy): string {
  const normalizedPolicy = normalizeFareAccessPolicy(policy);
  if (normalizedPolicy.mode === "forbid") return '["forbid"]';
  if (normalizedPolicy.mode === "diagnostic_allow_all") {
    return '["diagnostic_allow_all"]';
  }
  return JSON.stringify([
    normalizedPolicy.mode,
    ...normalizedPolicy.authorizedStationIds,
  ]);
}

/**
 * @param stationIds Sorted stable parent-station identifiers.
 * @param stationId Stable parent-station identifier to find.
 * @returns Whether the identifier is present without exposing a mutable lookup Set.
 */
function hasAuthorizedStationId(
  stationIds: readonly string[],
  stationId: string,
): boolean {
  let lowerBound = 0;
  let upperBound = stationIds.length;
  while (lowerBound < upperBound) {
    const middle = lowerBound + Math.floor((upperBound - lowerBound) / 2);
    const candidate = stationIds[middle];
    if (candidate === stationId) {
      return true;
    }
    if (candidate < stationId) {
      lowerBound = middle + 1;
    } else {
      upperBound = middle;
    }
  }
  return false;
}

/**
 * @param graph CSR pedestrian graph.
 * @param node Dense node identifier.
 * @returns The known stable parent-station ID for this node, if any.
 */
function stationIdForNode(graph: PedGraph, node: number): string | undefined {
  if (!Number.isInteger(node) || node < 0 || node >= graph.nodeCount) {
    return undefined;
  }
  const stationIndex = graph.nodeStationId[node];
  if (
    !Number.isInteger(stationIndex) ||
    stationIndex < 0 ||
    stationIndex >= graph.stationIds.length
  ) {
    return undefined;
  }
  const stationId = graph.stationIds[stationIndex];
  return typeof stationId === "string" && stationId.length > 0
    ? stationId
    : undefined;
}

/**
 * @param edgeType Dense edge type.
 * @returns Whether this edge crosses an indoor fare-control boundary.
 */
function isFareGateEdge(edgeType: number | undefined): boolean {
  return (
    edgeType === EDGE_TYPE.INDOOR_FARE_GATE ||
    edgeType === EDGE_TYPE.INDOOR_EXIT_GATE
  );
}

/**
 * Determines whether an adjacency may be traversed under a normalized fare policy.
 * Non-gate edges are always allowed. Both fare-gate types fail closed unless the
 * endpoints share a valid stable parent-station ID authorized by transit context.
 *
 * @param graph CSR pedestrian graph.
 * @param fromNode Dense source node identifier.
 * @param toNode Dense target node identifier.
 * @param attrIdx Dense edge attribute identifier.
 * @param policy Immutable fare access policy.
 * @returns Whether the adjacency is eligible before cost evaluation.
 */
export function canTraverseFareGate(
  graph: PedGraph,
  fromNode: number,
  toNode: number,
  attrIdx: number,
  policy: FareAccessPolicy = FORBID_FARE_ACCESS,
): boolean {
  if (
    !Number.isInteger(attrIdx) ||
    attrIdx < 0 ||
    attrIdx >= graph.edgeType.length
  ) {
    return false;
  }
  if (!isFareGateEdge(graph.edgeType[attrIdx])) {
    return true;
  }
  if (policy.mode === "diagnostic_allow_all") {
    return true;
  }
  if (policy.mode !== "transit_authorized") {
    return false;
  }

  const fromStationIndex = graph.nodeStationId[fromNode];
  const toStationIndex = graph.nodeStationId[toNode];
  if (
    !Number.isInteger(fromStationIndex) ||
    fromStationIndex < 0 ||
    fromStationIndex !== toStationIndex
  ) {
    return false;
  }
  const stationId = stationIdForNode(graph, fromNode);
  if (
    stationId === undefined ||
    stationIdForNode(graph, toNode) !== stationId
  ) {
    return false;
  }
  return hasAuthorizedStationId(policy.authorizedStationIds, stationId);
}
