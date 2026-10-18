import type { VenueEdge } from "./venue.types";

export type VenueConnectionKind =
  "stairs" | "steps" | "ramp" | "escalator" | "elevator";

/** Authored facility kind; slope alone does not identify a source facility. */
export function venueConnectionKind(
  edge: VenueEdge,
): VenueConnectionKind | null {
  if (edge.kind === "elevator") return "elevator";
  if (edge.kind === "escalator") return "escalator";
  if (edge.kind === "steps") return edge.indoor ? "stairs" : "steps";
  return edge.ramp ? "ramp" : null;
}

/** Stable source identity shared by compilation, display and navigation. */
export function venueConnectionId(edge: VenueEdge): string | null {
  const kind = venueConnectionKind(edge);
  if (!kind) return null;
  return kind === "elevator"
    ? edge.osmRef
    : `${edge.osmRef}@${edge.id.slice(edge.id.lastIndexOf("@") + 1)}`;
}
