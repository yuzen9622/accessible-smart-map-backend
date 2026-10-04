/** Real graph comparison at fixed coordinates. Does not promote or modify data. */
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { loadPedGraph } from "../modules/accessible-route/planners/pedestrian-a11y/graph-loader";
import {
  buildEdgeIndex,
  snapToGraph,
} from "../modules/accessible-route/planners/pedestrian-a11y/spatial-index";
import { findHazardEdgeIndexes } from "../modules/accessible-route/planners/pedestrian-a11y/hazard-edges.repository";
import { aStar } from "../modules/accessible-route/planners/pedestrian-a11y/astar";
import type { CostProfile } from "../modules/accessible-route/planners/pedestrian-a11y/cost";
import { findPedEdgeGeometries } from "../modules/accessible-route/planners/pedestrian-a11y/ped-graph-geometry.repository";
import { haversineMeters } from "../utils/geo";

const places: [string, number, number][] = [
  ["臺北車站", 121.5171, 25.0478],
  ["中山站", 121.5203, 25.0525],
  ["西門站", 121.5081, 25.0421],
  ["大安森林公園", 121.5359, 25.0332],
  ["市政府站", 121.5651, 25.0412],
  ["國父紀念館", 121.5579, 25.0413],
  ["北投站", 121.4986, 25.1318],
  ["新北投站", 121.5026, 25.1375],
  ["臺北動物園", 121.5807, 24.9983],
  ["萬芳社區", 121.5685, 24.9986],
  ["南港展覽館", 121.617, 25.0553],
  ["南港站", 121.6065, 25.0521],
];
const pairs = [
  [0, 1],
  [0, 2],
  [3, 4],
  [4, 5],
  [6, 7],
  [8, 9],
  [10, 11],
  [6, 8],
  [0, 10],
  [2, 4],
];
const profiles: CostProfile[] = [
  { name: "normal", walkSpeedMps: 1.3, relaxationLevel: 0 },
  { name: "elderly", walkSpeedMps: 1.0, relaxationLevel: 0 },
  { name: "wheelchair", walkSpeedMps: 0.8, relaxationLevel: 0 },
];

async function main() {
  const [databaseUrl, versionArg, output] = process.argv.slice(2);
  if (!databaseUrl || !output || !Number.isInteger(Number(versionArg)))
    throw new Error("Usage: database-url version-id output.json");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const started = performance.now();
    const graph = await loadPedGraph(pool, Number(versionArg));
    const loadMs = performance.now() - started;
    const index = buildEdgeIndex(graph);
    const results = [];
    let simulatedHazardCheck: unknown = null;
    for (const [a, b] of pairs)
      for (const profile of profiles) {
        const from = places[a],
          to = places[b];
        const origin = snapToGraph(index, from[2], from[1], 50);
        const destination = snapToGraph(index, to[2], to[1], 50);
        const base = { from: from[0], to: to[0], mode: profile.name };
        if (!origin || !destination) {
          results.push({ ...base, status: "snap_unavailable" });
          continue;
        }
        const start = performance.now();
        const route = aStar(graph, origin.nodeId, destination.nodeId, profile);
        const searchMs = performance.now() - start;
        if (!route) {
          results.push({ ...base, status: "no_route", searchMs });
          continue;
        }
        const attrs = Array.from(route.edgeAttrPath);
        const geometries = await findPedEdgeGeometries(
          pool,
          graph.versionId,
          attrs.map((i) => graph.edgeOriginalId[i]),
        );
        if (a === 4 && b === 5 && profile.name === "wheelchair") {
          const middle = geometries[Math.floor(geometries.length / 2)];
          if (middle?.status === "line") {
            const observedPoint =
              middle.points[Math.floor(middle.points.length / 2)];
            const excluded = await findHazardEdgeIndexes(pool, graph, [
              observedPoint,
            ]);
            const alternative = aStar(
              graph,
              origin.nodeId,
              destination.nodeId,
              profile,
              undefined,
              excluded,
            );
            const repeated = aStar(
              graph,
              origin.nodeId,
              destination.nodeId,
              profile,
            );
            simulatedHazardCheck = {
              simulatedObservation: true,
              observedPoint,
              excludedEdgeCount: excluded.size,
              alternativeFound: alternative !== null,
              alternativeUsesExcludedEdge: alternative
                ? Array.from(alternative.edgeAttrPath).some((i) =>
                    excluded.has(i),
                  )
                : null,
              subsequentRequestUnchanged:
                JSON.stringify(Array.from(repeated?.edgeAttrPath ?? [])) ===
                JSON.stringify(attrs),
            };
          }
        }
        let maxJoinGapM = 0,
          distanceM = 0;
        let previous: [number, number] | undefined;
        let missingGeometry = 0;
        for (const geometry of geometries) {
          if (geometry.status !== "line") {
            missingGeometry++;
            previous = undefined;
            continue;
          }
          if (previous)
            maxJoinGapM = Math.max(
              maxJoinGapM,
              haversineMeters(
                previous[1],
                previous[0],
                geometry.points[0][1],
                geometry.points[0][0],
              ),
            );
          previous = geometry.points.at(-1);
        }
        for (const i of attrs)
          if (Number.isFinite(graph.edgeLengthM[i]))
            distanceM += graph.edgeLengthM[i];
        results.push({
          ...base,
          status: "ok",
          searchMs,
          distanceM,
          edgeCount: attrs.length,
          maxJoinGapM,
          missingGeometry,
          unknownWidthEdges: attrs.filter(
            (i) => !Number.isFinite(graph.edgeWidthM[i]),
          ).length,
          unknownSlopeEdges: attrs.filter(
            (i) => !Number.isFinite(graph.edgeSlope[i]),
          ).length,
          originSnapM: origin.distanceM,
          destinationSnapM: destination.distanceM,
        });
      }
    const result = {
      observedAt: new Date().toISOString(),
      versionId: graph.versionId,
      nodes: graph.nodeCount,
      edges: graph.directedEdgeCount,
      loadMs,
      simulatedHazardCheck,
      results,
    };
    writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        output,
        loadMs,
        counts: results.reduce(
          (a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }),
          {} as Record<string, number>,
        ),
      }),
    );
  } finally {
    await pool.end();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "validation failed");
  process.exitCode = 1;
});
