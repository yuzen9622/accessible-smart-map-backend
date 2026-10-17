import { levelRefOf } from "./venue.compile";
import type {
  HeightStatus,
  VenueData,
  VenueEdge,
  VenueNode,
  VenueProvenance,
  VenueWheelchairTag,
} from "./venue.types";

export type VenueConnectionKind =
  "stairs" | "steps" | "ramp" | "escalator" | "elevator";

/**
 * A way between heights (stairs, steps, ramp, escalator) or an elevator
 * shaft, with 3D points, so clients can draw it without the routing graph.
 */
export interface VenueConnection extends VenueProvenance {
  id: string;
  kind: VenueConnectionKind;
  buildingId: string | null;
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

/** @returns The connection kind of an edge, or null for level walking. */
function kindOf(e: VenueEdge): VenueConnectionKind | null {
  if (e.kind === "elevator") return "elevator";
  if (e.kind === "escalator") return "escalator";
  if (e.kind === "steps") return e.indoor ? "stairs" : "steps";
  return e.ramp ? "ramp" : null;
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
    const kind = kindOf(e);
    if (!kind) continue;
    // one group per way instance (`way/-108@span`, `way/-302@0`) or elevator
    const key =
      kind === "elevator"
        ? e.osmRef
        : `${e.osmRef}@${e.id.slice(e.id.lastIndexOf("@") + 1)}`;
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
