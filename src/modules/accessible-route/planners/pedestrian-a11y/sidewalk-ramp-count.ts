import type { PedGraph } from "./graph.types";

/**
 * Total ramps recorded on the distinct government sidewalk segments this path travels along.
 *
 * The source count is a per-sidewalk-polygon attribute copied onto every edge derived from
 * that polygon, so each sidewalk segment contributes its count exactly once no matter how
 * many of its edges the path traverses.
 *
 * @param graph CSR pedestrian graph.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @returns The de-duplicated ramp total; 0 when no traversed edge matched a sidewalk.
 */
export function sumSidewalkRampCount(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
): number {
  const countedSidewalkIds = new Set<number>();
  let total = 0;
  for (const attrIdx of edgeAttrPath) {
    const sidewalkId = graph.edgeSidewalkId[attrIdx];
    if (sidewalkId === -1) continue;
    if (countedSidewalkIds.has(sidewalkId)) continue;
    countedSidewalkIds.add(sidewalkId);
    total += graph.edgeSidewalkRampCount[attrIdx];
  }
  return total;
}
