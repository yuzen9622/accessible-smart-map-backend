import type { OsmData, OsmTags } from "./venue-osm.parse";
import { venueConnectionId, venueConnectionKind } from "./venue.connection-id";
import type {
  LngLat,
  VenueEdge,
  VenueFeature,
  VenueNode,
  VenuePlace,
} from "./venue.types";

/** Bounds the number of real endpoint pairs considered by the venue planner. */
export const MAX_ARRIVAL_NODES = 16;

type VerticalArea = "vertical-core" | "stairwell" | "elevator-shaft";
function verticalAreaOf(feature: VenueFeature): VerticalArea | null {
  const area = feature.tags?.["a11ymap:area_type"];
  if (
    area === "vertical-core" ||
    area === "stairwell" ||
    area === "elevator-shaft"
  )
    return area;
  if (feature.kind === "stairs") return "stairwell";
  if (feature.kind === "elevator") return "elevator-shaft";
  return null;
}

function fallbackName(feature: VenueFeature): string {
  if (feature.kind === "room") return "未標房號空間";
  if (feature.tags?.amenity === "toilets") return "廁所";
  const area = verticalAreaOf(feature);
  if (area === "vertical-core") return "電梯／樓梯核心";
  if (area === "stairwell") return "樓梯間";
  if (area === "elevator-shaft") return "電梯井";
  return feature.kind === "corridor" ? "走廊" : "未命名空間";
}

/**
 * Adds selectable destinations backed only by existing source graph nodes.
 * Explicit annotations may point to the nearby corridor outside a room;
 * automatic association is limited to unique real vertical-facility landings.
 * Neither operation changes graph nodes, edges, elevator stops or geometry.
 */
export function compileFeatureArrivals(
  osm: OsmData,
  nodes: Map<string, VenueNode>,
  edges: VenueEdge[],
  features: VenueFeature[],
  places: VenuePlace[],
  errors: string[],
  contains: (feature: VenueFeature, point: LngLat) => boolean,
  hasAuthoredDoor: (tags: OsmTags) => boolean,
): void {
  const ordinary = new Set<string>();
  const incident = new Map<string, Set<string>>();
  for (const edge of edges) {
    const a = nodes.get(edge.from);
    const b = nodes.get(edge.to);
    if (!a || !b) continue;
    if (
      !["steps", "escalator", "elevator"].includes(edge.kind) &&
      a.buildingId !== null &&
      a.buildingId === b.buildingId &&
      a.ordinal !== null &&
      a.ordinal === b.ordinal
    ) {
      ordinary.add(a.id);
      ordinary.add(b.id);
    }
    const id = venueConnectionId(edge);
    if (id)
      for (const key of [a.id, b.id]) {
        const ids = incident.get(key) ?? new Set<string>();
        ids.add(id);
        incident.set(key, ids);
      }
  }
  const sameContext = (feature: VenueFeature, node: VenueNode) =>
    feature.buildingId !== null &&
    node.buildingId === feature.buildingId &&
    feature.ordinal !== null &&
    node.ordinal === feature.ordinal;
  const sourceTags = (feature: VenueFeature): OsmTags => {
    const ref = feature.osmRef;
    if (ref?.startsWith("way/")) return osm.ways.get(ref.slice(4))?.tags ?? {};
    if (ref?.startsWith("relation/"))
      return osm.relations.get(ref.slice(9))?.tags ?? {};
    return {};
  };
  const refs = (ids: Iterable<string>) => {
    const connectionIds = [...new Set(ids)].sort();
    return {
      connectionId: connectionIds.length === 1 ? connectionIds[0] : null,
      connectionIds,
    };
  };
  const bound = new Set(
    places.flatMap((place) => (place.featureId ? [place.featureId] : [])),
  );
  const ids = new Set(places.map((place) => place.id));
  for (const feature of features) {
    if (feature.geometry.type !== "Polygon") continue;
    const explicit = sourceTags(feature)["a11ymap:arrival_node"];
    const candidates = new Set<string>();
    const associated = new Set<string>();
    if (explicit !== undefined) {
      const sourceId = explicit.trim();
      const node = nodes.get(`${sourceId}@${feature.ordinal}`);
      if (
        !sourceId ||
        !osm.nodes.has(sourceId) ||
        !node ||
        !sameContext(feature, node) ||
        !ordinary.has(node.id)
      ) {
        errors.push(
          `${feature.id} 的 a11ymap:arrival_node「${explicit}」必須是相同建築、樓層且已接同層普通路徑的原始 node ID`,
        );
        continue;
      }
      if (
        verticalAreaOf(feature) === "elevator-shaft" &&
        (!contains(feature, [node.lng, node.lat]) ||
          !edges.some(
            (edge) =>
              edge.kind === "elevator" &&
              (edge.from === node.id || edge.to === node.id),
          ))
      ) {
        errors.push(
          `${feature.id} 的 a11ymap:arrival_node 必須是井道內本層實際停靠的電梯 node`,
        );
        continue;
      }
      candidates.add(node.id);
    } else {
      const area = verticalAreaOf(feature);
      if (!area || !feature.buildingId) continue;
      const peers = features.filter(
        (other) =>
          verticalAreaOf(other) === area &&
          other.buildingId === feature.buildingId &&
          other.ordinal === feature.ordinal,
      );
      for (const edge of edges) {
        const kind = venueConnectionKind(edge);
        const accepted =
          area === "stairwell"
            ? kind === "stairs" || kind === "steps"
            : area === "elevator-shaft"
              ? kind === "elevator"
              : kind === "stairs" || kind === "steps" || kind === "elevator";
        if (!accepted) continue;
        for (const key of [edge.from, edge.to]) {
          const node = nodes.get(key);
          if (!node || !sameContext(feature, node) || !ordinary.has(key))
            continue;
          const point: LngLat = [node.lng, node.lat];
          if (
            !contains(feature, point) ||
            peers.filter((other) => contains(other, point)).length !== 1
          )
            continue;
          candidates.add(key);
          const connection = venueConnectionId(edge);
          if (connection) associated.add(connection);
        }
      }
    }
    // One shaft cannot identify several elevator facilities; a shared core can.
    if (verticalAreaOf(feature) === "elevator-shaft" && associated.size > 1)
      continue;
    if (associated.size)
      Object.assign(
        feature,
        refs([...(feature.connectionIds ?? []), ...associated]),
      );
    if (bound.has(feature.id) || candidates.size === 0) continue;
    if (candidates.size > MAX_ARRIVAL_NODES) {
      errors.push(
        `${feature.id} 的到達點超過 ${MAX_ARRIVAL_NODES} 個，請明確標註 a11ymap:arrival_node`,
      );
      continue;
    }
    const id = `arrival:${feature.id}`;
    if (id.length > 200 || ids.has(id)) {
      errors.push(`自動到達點 id「${id}」重複或超過 200 字`);
      continue;
    }
    const arrivalNodeIds = [...candidates].sort();
    const primary = nodes.get(arrivalNodeIds[0]) as VenueNode;
    const door = hasAuthoredDoor(
      osm.nodes.get(primary.id.split("@")[0])?.tags ?? {},
    );
    places.push({
      id,
      name: feature.name ?? feature.ref ?? fallbackName(feature),
      ...(feature.ref ? { ref: feature.ref } : {}),
      kind:
        feature.kind === "room"
          ? "room"
          : feature.tags?.amenity
            ? "amenity"
            : "poi",
      ...(feature.kind !== "room" && feature.tags?.amenity
        ? { amenity: feature.tags.amenity }
        : {}),
      buildingId: feature.buildingId,
      levelRef: feature.levelRef,
      nodeId: primary.id,
      ...(arrivalNodeIds.length > 1 ? { arrivalNodeIds } : {}),
      location: [primary.lng, primary.lat],
      featureId: feature.id,
      ...(feature.tags?.wheelchair
        ? { wheelchair: feature.tags.wheelchair }
        : {}),
      arrivalKind: door ? "door" : "corridor",
      doorKnown: door,
      ...refs(arrivalNodeIds.flatMap((key) => [...(incident.get(key) ?? [])])),
    });
    bound.add(feature.id);
    ids.add(id);
  }
}
