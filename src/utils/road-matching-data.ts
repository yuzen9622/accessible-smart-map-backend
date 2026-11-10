import { createHash } from "node:crypto";
import type { AccessibleRoute } from "../types/route";
import type { RoadMatchingData } from "../types/road-guidance";

// Existing presentation copies preserve nonenumerable string descriptors, not symbols.
const ROAD_MATCHING = "__roadMatchingData";
export function geometrySha256(polyline: [number, number][]): string {
  return createHash("sha256").update(JSON.stringify(polyline)).digest("hex");
}
export function validateRoadMatchingData(
  route: AccessibleRoute,
  data: RoadMatchingData,
): boolean {
  if (
    !data ||
    typeof data.tilesetId !== "string" ||
    !data.tilesetId ||
    data.tilesetId !== route.roadNetwork?.tilesetId ||
    !Array.isArray(data.legs) ||
    !data.legs.length
  )
    return false;
  const indices = new Set<number>();
  return data.legs.every((entry) => {
    if (
      !entry ||
      !Number.isSafeInteger(entry.legIndex) ||
      indices.has(entry.legIndex)
    )
      return false;
    indices.add(entry.legIndex);
    const leg = route.legs[entry.legIndex];
    if (
      !leg ||
      (leg.type !== "DRIVE" && leg.type !== "MOTORCYCLE") ||
      leg.polyline.length < 2 ||
      geometrySha256(leg.polyline) !== entry.geometrySha256 ||
      !Array.isArray(entry.spans) ||
      !entry.spans.length
    )
      return false;
    let next = 0;
    for (const span of entry.spans) {
      if (
        !span ||
        !Number.isSafeInteger(span.fromIndex) ||
        !Number.isSafeInteger(span.toIndex) ||
        span.fromIndex !== next ||
        span.toIndex <= span.fromIndex ||
        span.toIndex >= leg.polyline.length ||
        typeof span.directedEdgeId !== "string" ||
        typeof span.osmWayId !== "string" ||
        !/^[1-9]\d*$/.test(span.directedEdgeId) ||
        !/^[1-9]\d*$/.test(span.osmWayId) ||
        typeof span.osmForward !== "boolean"
      )
        return false;
      next = span.toIndex;
    }
    return next === leg.polyline.length - 1;
  });
}
export function attachRoadMatchingData(
  route: AccessibleRoute,
  data: RoadMatchingData,
): void {
  if (!validateRoadMatchingData(route, data)) return;
  Object.defineProperty(route, ROAD_MATCHING, {
    value: data,
    enumerable: false,
    configurable: true,
  });
}
export function getRoadMatchingData(
  route: AccessibleRoute,
): RoadMatchingData | undefined {
  const data = (
    route as AccessibleRoute & { [ROAD_MATCHING]?: RoadMatchingData }
  )[ROAD_MATCHING];
  return data && validateRoadMatchingData(route, data) ? data : undefined;
}
