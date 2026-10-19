import { levelRefOf } from "./venue.compile";
import {
  venueConnectionId,
  venueConnectionKind,
  type VenueConnectionKind,
} from "./venue.connection-id";
export type { VenueConnectionKind } from "./venue.connection-id";
import type {
  HeightStatus,
  VenueData,
  VenueEdge,
  VenueNode,
  VenueProvenance,
  VenueWheelchairTag,
} from "./venue.types";

/**
 * A way between heights (stairs, steps, ramp, escalator) or an elevator
 * shaft, with 3D points, so clients can draw it without the routing graph.
 */
export interface VenueConnection extends VenueProvenance {
  id: string;
  kind: VenueConnectionKind;
  buildingId: string | null;
  /** Source name/ref; null when not authored in the stored snapshot. */
  name: string | null;
  ref: string | null;
  /** Compiled source node IDs in the same order as coordinates/levelRefs. */
  nodeIds: string[];
  /** Display features that explicitly refer to this connection. */
  featureIds: string[];
  /** `[lng, lat, z]` along the way; one point per stop for an elevator. */
  coordinates: [number, number, number][];
  /** Floor of each point; null outdoors or between floors. */
  levelRefs: (string | null)[];
  wheelchair: VenueWheelchairTag;
  /** Steepest grade along a ramp, as a ratio. */
  slopeRatio?: number;
  stepCount?: number;
  osmRef: string;
}

const CERTAINTY: HeightStatus[] = ["estimated", "drawing", "measured"];

/** @returns The least certain of the statuses. */
export function leastCertain(statuses: HeightStatus[]): HeightStatus {
  return statuses.reduce<HeightStatus>(
    (worst, s) => (CERTAINTY.indexOf(s) < CERTAINTY.indexOf(worst) ? s : worst),
    "measured",
  );
}

/**
 * Groups the compiled edges back into one connection per drawn way instance
 * (`${wayId}@${level or span}`) and one per elevator.
 *
 * @param venue Compiled venue.
 * @returns Stairs, steps, ramps, escalators and elevators.
 */
export function venueConnections(venue: VenueData): VenueConnection[] {
  const nodeById = new Map(venue.nodes.map((n) => [n.id, n]));
  const groups = new Map<
    string,
    { kind: VenueConnectionKind; edges: VenueEdge[] }
  >();
  for (const e of venue.edges) {
    const kind = venueConnectionKind(e);
    const key = venueConnectionId(e);
    if (!kind || !key) continue;
    const group = groups.get(key);
    if (group) group.edges.push(e);
    else groups.set(key, { kind, edges: [e] });
  }

  const point = (n: VenueNode): [number, number, number] => [
    n.lng,
    n.lat,
    Number.isFinite(n.z) ? Math.round(n.z * 100) / 100 : 0,
  ];
  const levelOf = (n: VenueNode) =>
    n.buildingId && n.ordinal !== null ? levelRefOf(n.ordinal) : null;

  return [...groups].map(([id, { kind, edges }]) => {
    const chain =
      kind === "elevator"
        ? [...new Set(edges.flatMap((e) => [e.from, e.to]))]
            .map((key) => nodeById.get(key) as VenueNode)
            .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
        : [edges[0].from, ...edges.map((e) => e.to)].map(
            (key) => nodeById.get(key) as VenueNode,
          );
    const grades = edges.flatMap((e) =>
      e.slopeRatio === undefined ? [] : [e.slopeRatio],
    );
    const stepCount = edges.find((e) => e.stepCount)?.stepCount;
    return {
      id,
      kind,
      buildingId: chain.find((n) => n.buildingId)?.buildingId ?? null,
      name: edges.find((edge) => edge.name)?.name ?? null,
      ref: edges.find((edge) => edge.ref)?.ref ?? null,
      nodeIds: chain.map((node) => node.id),
      featureIds: venue.features
        .filter(
          (feature) =>
            feature.connectionId === id || feature.connectionIds?.includes(id),
        )
        .map((feature) => feature.id),
      coordinates: chain.map(point),
      levelRefs: chain.map(levelOf),
      // stairs and escalators are never wheelchair-passable, whatever the tag
      wheelchair:
        kind === "stairs" ||
        kind === "steps" ||
        kind === "escalator" ||
        edges.some((e) => e.wheelchair === "no")
          ? "no"
          : edges[0].wheelchair,
      ...(kind === "ramp" && grades.length
        ? { slopeRatio: Math.max(...grades) }
        : {}),
      ...(stepCount ? { stepCount } : {}),
      geometryStatus: edges[0].geometryStatus ?? "traced",
      heightStatus: leastCertain(
        edges.map(
          (e) =>
            (kind === "ramp" ? e.slopeStatus : undefined) ??
            e.heightStatus ??
            "estimated",
        ),
      ),
      ...(edges.find((e) => e.source)?.source
        ? { source: edges.find((e) => e.source)?.source }
        : {}),
      ...(edges.some((e) => e.heightPending !== undefined)
        ? { heightPending: edges.some((e) => e.heightPending === true) }
        : {}),
      ...joinedAnnotations(edges),
      osmRef: edges[0].osmRef,
    };
  });
}

/** Preserve distinct author annotations when a connection spans many edges. */
function joinedAnnotations(
  edges: VenueEdge[],
): Pick<VenueProvenance, "note" | "fixme"> {
  const result: Pick<VenueProvenance, "note" | "fixme"> = {};
  for (const key of ["note", "fixme"] as const) {
    const values = [
      ...new Set(edges.map((edge) => edge[key]?.trim()).filter(Boolean)),
    ];
    if (values.length) result[key] = values.join("\n");
  }
  return result;
}
