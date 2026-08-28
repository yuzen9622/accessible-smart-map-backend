import {
  canTraverseFareGate,
  FORBID_FARE_ACCESS,
  type FareAccessPolicy,
} from "../modules/accessible-route/planners/pedestrian-a11y/fare-access";
import type { PedGraph } from "../modules/accessible-route/planners/pedestrian-a11y/graph.types";

export type EdgeValue = (
  attrIdx: number,
  fromNode: number,
  toNode: number,
) => number;

export interface PlannedPathStep {
  from: number;
  to: number;
  attrIdx: number;
  value: number;
}

/**
 * Resolves the actual adjacency edges selected by a planned node path. Fare-gate
 * candidates use the same policy as the planner; default walking remains fail-closed.
 *
 * @param graph CSR pedestrian graph.
 * @param nodePath Dense node sequence from a search.
 * @param edgeValue Cost function matching the planner.
 * @param fareAccess Fare policy passed to the planner.
 * @returns Ordered selected adjacency edges for the planned node sequence.
 */
export function resolvePlannedPathSteps(
  graph: PedGraph,
  nodePath: Int32Array,
  edgeValue: EdgeValue,
  fareAccess: FareAccessPolicy = FORBID_FARE_ACCESS,
): PlannedPathStep[] {
  const steps: PlannedPathStep[] = [];
  for (let index = 0; index < nodePath.length - 1; index += 1) {
    const from = nodePath[index];
    const to = nodePath[index + 1];
    let selectedAttrIdx = -1;
    let selectedValue = Number.POSITIVE_INFINITY;
    for (
      let adjacencyIndex = graph.adjOffset[from];
      adjacencyIndex < graph.adjOffset[from + 1];
      adjacencyIndex += 1
    ) {
      if (graph.adjTarget[adjacencyIndex] !== to) continue;
      const attrIdx = graph.adjAttr[adjacencyIndex];
      if (!canTraverseFareGate(graph, from, to, attrIdx, fareAccess)) {
        continue;
      }
      const value = edgeValue(attrIdx, from, to);
      if (!Number.isFinite(value) || value >= selectedValue) continue;
      selectedAttrIdx = attrIdx;
      selectedValue = value;
    }
    if (selectedAttrIdx === -1) {
      throw new Error(`route step ${from} -> ${to} has no finite edge`);
    }
    steps.push({ from, to, attrIdx: selectedAttrIdx, value: selectedValue });
  }
  return steps;
}
