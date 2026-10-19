import { levelRefOf } from "./venue.compile";
import type {
  LngLatZ,
  VenueBuilding,
  VenueData,
  VenueEdge,
  VenueLevel,
  VenueLevelCoverage,
  VenueNode,
  VenueProvenance,
  VenueWheelchairTag,
} from "./venue.types";

export type VenuePresentedBuilding = Omit<VenueBuilding, "levels"> & {
  levels: (VenueLevel & { coverage: VenueLevelCoverage })[];
};

/** One ordinary walking edge, with endpoint ownership for building boundaries. */
export interface VenueWalkway extends VenueProvenance {
  id: string;
  kind: Exclude<VenueEdge["kind"], "steps" | "escalator" | "elevator">;
  indoor: boolean;
  coordinates: [LngLatZ, LngLatZ];
  /** Compiled source endpoints in the same order as coordinates. */
  nodeIds: [string, string];
  /** Common building/floor only; null when crossing a boundary or outdoors. */
  buildingId: string | null;
  levelRef: string | null;
  /** Building and floor of each point, in the same order as coordinates. */
  buildingIds: [string | null, string | null];
  levelRefs: [string | null, string | null];
  wheelchair: VenueWheelchairTag;
  osmRef: string;
}

const levelOf = (node: VenueNode): string | null =>
  node.buildingId && node.ordinal !== null ? levelRefOf(node.ordinal) : null;

/**
 * Projects existing graph edges without guessing paths or duplicating vertical
 * connections. Two points per item retain exact graph ownership at boundaries.
 */
export function venueWalkways(venue: VenueData): VenueWalkway[] {
  const nodes = new Map(venue.nodes.map((node) => [node.id, node]));
  return venue.edges.flatMap((edge): VenueWalkway[] => {
    if (
      edge.ramp ||
      edge.kind === "steps" ||
      edge.kind === "escalator" ||
      edge.kind === "elevator"
    ) {
      return [];
    }
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return [];
    const buildingId =
      from.buildingId === to.buildingId ? from.buildingId : null;
    const fromLevel = levelOf(from);
    const toLevel = levelOf(to);
    return [
      {
        id: edge.id,
        kind: edge.kind,
        indoor: edge.indoor,
        nodeIds: [edge.from, edge.to],
        coordinates: [
          [from.lng, from.lat, Number.isFinite(from.z) ? from.z : 0],
          [to.lng, to.lat, Number.isFinite(to.z) ? to.z : 0],
        ],
        buildingId,
        levelRef: buildingId && fromLevel === toLevel ? fromLevel : null,
        buildingIds: [from.buildingId, to.buildingId],
        levelRefs: [fromLevel, toLevel],
        wheelchair: edge.wheelchair,
        geometryStatus: edge.geometryStatus ?? "traced",
        heightStatus: edge.heightStatus ?? "estimated",
        ...(edge.source ? { source: edge.source } : {}),
        ...(edge.heightPending !== undefined
          ? { heightPending: edge.heightPending }
          : {}),
        ...(edge.note ? { note: edge.note } : {}),
        ...(edge.fixme ? { fixme: edge.fixme } : {}),
        osmRef: edge.osmRef,
      },
    ];
  });
}

/**
 * Describes authored data presence, not route reachability or surveyed accuracy.
 * Merely declaring building:levels never marks a floor as covered.
 */
export function venueBuildings(venue: VenueData): VenuePresentedBuilding[] {
  const incident = new Set(venue.edges.flatMap((edge) => [edge.from, edge.to]));
  return venue.buildings.map((building) => ({
    ...building,
    levels: building.levels.map((level) => ({
      ...level,
      coverage: {
        hasAnchor: venue.places.some(
          (place) =>
            place.kind === "anchor" &&
            place.buildingId === building.id &&
            place.levelRef === level.ref,
        ),
        hasRouteData: venue.nodes.some(
          (node) =>
            node.buildingId === building.id &&
            node.ordinal === level.ordinal &&
            incident.has(node.id),
        ),
        hasDisplayGeometry:
          venue.features.some(
            (feature) =>
              feature.buildingId === building.id &&
              feature.levelRef === level.ref &&
              feature.ordinal === level.ordinal,
          ) ||
          (venue.walls ?? []).some(
            (wall) =>
              wall.buildingId === building.id &&
              wall.levelRef === level.ref &&
              wall.ordinal === level.ordinal,
          ),
      },
    })),
  }));
}
