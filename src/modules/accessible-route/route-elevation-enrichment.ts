import { sampleTerrain } from "../../adapters/terrain-elevation.adapter";
import { ELEVATION_LIMITS } from "../../config/elevation";
import type { AccessibleRoute, TravelMode } from "../../types/route";
import {
  makeElevationProfile,
  sampleWalkingRoute,
} from "../../utils/route-elevation";
import type { SampledWalkLine } from "../../utils/route-elevation";

export async function attachWalkElevationProfiles(
  routes: AccessibleRoute[],
  travelMode: TravelMode,
): Promise<void> {
  if (travelMode !== "walk") return;
  const pending: { route: AccessibleRoute; line: SampledWalkLine }[] = [];
  try {
    for (const [index, route] of routes.entries()) {
      route.elevationProfile = {
        status: "unavailable",
        reason: "data_unavailable",
      };
      if (index >= ELEVATION_LIMITS.maxCandidates) {
        route.elevationProfile = {
          status: "unavailable",
          reason: "resource_limit",
        };
        continue;
      }
      const line = sampleWalkingRoute(route.legs);
      if ("status" in line) route.elevationProfile = line;
      else pending.push({ route, line });
    }
    if (!pending.length) return;
    const points = pending.flatMap(({ line }) =>
      line.samples.map((point) => point.coordinates),
    );
    const result = await sampleTerrain(points);
    let offset = 0;
    for (const { route, line } of pending) {
      route.elevationProfile = result.ok
        ? makeElevationProfile(
            line,
            result.elevations.slice(offset, offset + line.samples.length),
          )
        : { status: "unavailable", reason: result.reason };
      offset += line.samples.length;
    }
  } catch {
    for (const route of routes) {
      route.elevationProfile ??= {
        status: "unavailable",
        reason: "data_unavailable",
      };
    }
  }
}
