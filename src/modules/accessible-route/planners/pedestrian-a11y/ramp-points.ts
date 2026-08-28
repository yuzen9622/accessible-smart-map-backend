import type { WalkA11yPoint } from "../../../../types/route";
import type { PedGraph } from "./graph.types";

/**
 * Curb-ramp facilities recorded on the traversed edges, in path order and
 * de-duplicated by coordinate.
 *
 * The same government ramp point can be attached to both the forward and
 * reverse directed edge of one physical corridor, so a path that traverses
 * either direction (or the same corridor twice) must still report it once.
 *
 * @param graph CSR pedestrian graph.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @returns The de-duplicated, path-ordered ramp points; empty when no
 * traversed edge matched a recorded ramp point.
 */
export function collectRampPoints(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
): WalkA11yPoint[] {
  const seen = new Set<string>();
  const points: WalkA11yPoint[] = [];
  for (const attrIdx of edgeAttrPath) {
    const edgePoints = graph.edgeRampPoints.get(attrIdx);
    if (edgePoints === undefined) continue;
    for (const [lng, lat] of edgePoints) {
      const key = `${lng},${lat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({ type: "curb_ramp", location: [lng, lat] });
    }
  }
  return points;
}
