import { findNearestStopCity } from "./accessible-route.repository";
import { getCity, getCoordinates } from "../../adapters/google.adapter";
import { parseRouteIntent } from "./route-intent.port";
import { getA11yProfile } from "../user/user.service";
import type { RouteIntent } from "../../types/ai";
import { ResponseCode } from "../../types/code";
import { getServiceCoverageConfig } from "../../config/coverage";
import {
  ERROR_MESSAGE,
  ROUTE_REASON,
  ROUTE_WARNING,
} from "../../constants/messages";
import type {
  A11yConstraints,
  FindAccessibleRoutesOptions,
  FindAccessibleRoutesResult,
  FindDrivingRoutesOptions,
  LatLng,
  PlanRouteRequest,
  PlanRouteResult,
  RoadTravelMode,
} from "./accessible-route.types";
export type {
  FindAccessibleRoutesOptions,
  FindAccessibleRoutesResult,
  PlanRouteRequest,
  PlanRouteResult,
};

import type { IOsmA11y } from "../../types";
import type { TaiwanCityEn } from "../../types/transit";
import { slimRoutes, compactRoutes } from "./facility-slim";
import {
  scoreRoute,
  routeCost,
  prerankCost,
  resolveA11yConstraints,
  type EnvConditions,
} from "./scoring";
import { buildAccessibilitySummary } from "./planners/route-a11y";
import {
  deriveWalkA11yDetails,
  unknownWalkA11yDetails,
  type WalkA11yFacility,
} from "./planners/walk-a11y";
import { getWeatherAndAirQuality } from "../environment/environment.service";
import { getMetroAlerts } from "../transit/metro.service";
import { getTransitAlerts } from "../transit/alert.service";
import type {
  MatchedAlert,
  MetroAlert,
  MetroAlertResult,
} from "../../types/transit";
import { haversineMeters } from "../../utils/geo";
import { attachRouteTokens } from "./route-token.service";
import {
  attachInternalSchedule,
  retainEarliestFutureRoute,
} from "./route-schedule";
import {
  buildHazardQueryArea,
  planConfirmedHazardRoutes,
  type ConfirmedHazardInput,
  type HazardRoutePlan,
} from "./planners/hazard-routing";
import {
  preflightAccessibleRoute,
  routeFailure,
} from "./accessible-route.failure";

import type {
  AccessibilityMode,
  SlimA11y,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  AccessibleRoute,
  TravelMode,
} from "../../types/route";
export type {
  SlimA11y,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  AccessibleRoute,
} from "../../types/route";

/** Search radius for the destination disabled-parking arrival anchor. */
const PARKING_ARRIVAL_RADIUS_M = 200;
const MAX_WALK_SEGMENT_CONCURRENCY = 4;

/**
 * Limit concurrent tasks without changing their result order.
 * @param limit Maximum tasks allowed to run simultaneously.
 * @returns A function that schedules one async task.
 */
function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task().then(resolve, reject).finally(release);
      };
      if (active < limit) start();
      else queue.push(start);
    });
  };
}

function collectRouteFacilities(r: AccessibleRoute): IOsmA11y[] {
  return r.legs.flatMap((leg) => {
    if (leg.type === "WALK") return leg.a11yFacilities;
    if (leg.type === "BUS")
      return [...leg.departureStopA11y, ...leg.arrivalStopA11y];
    if (leg.type === "METRO")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "THSR")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    if (leg.type === "TRA")
      return [...leg.departureStationA11y, ...leg.arrivalStationA11y];
    return [];
  });
}

/**
 * Resolve WALK facility evidence before response projection. In compact output
 * the leg array is deliberately empty and its source is moved to
 * `route.facilities`, so a re-finalized/pre-compacted route must follow refs
 * rather than erase a previously derived B12 detail shape.
 */
function walkFacilitiesForDetails(
  route: AccessibleRoute,
  leg: WalkLeg,
): WalkA11yFacility[] {
  if (leg.a11yFacilities.length) return leg.a11yFacilities;
  if (!leg.a11yRefs?.length || !route.facilities) return [];
  return leg.a11yRefs
    .map((id) => route.facilities?.[id])
    .filter((facility): facility is SlimA11y => Boolean(facility));
}

function hasWalkA11yDetails(leg: WalkLeg): boolean {
  const candidate = leg as Partial<WalkLeg>;
  return (
    Object.getOwnPropertyDescriptor(candidate, "maxSlopePercent") !==
      undefined &&
    Object.getOwnPropertyDescriptor(candidate, "crossings") !== undefined &&
    Object.getOwnPropertyDescriptor(candidate, "crossingsWithCurbRamp") !==
      undefined &&
    Object.getOwnPropertyDescriptor(candidate, "minPathWidthCm") !==
      undefined &&
    Object.getOwnPropertyDescriptor(candidate, "surfaceType") !== undefined &&
    Array.isArray(candidate.restPoints)
  );
}

/**
 * Populate all B12 WALK details from facilities already on the route. This is
 * intentionally pure-data only: no per-leg query is introduced, and missing
 * source data stays explicit unknown rather than a fabricated zero.
 */
function attachWalkA11yDetails(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type !== "WALK") continue;
      const facilities = walkFacilitiesForDetails(route, leg);
      if (facilities.length) {
        Object.assign(leg, deriveWalkA11yDetails(facilities, leg.polyline));
      } else if (!hasWalkA11yDetails(leg)) {
        Object.assign(leg, unknownWalkA11yDetails());
      }
    }
  }
}

/**
 * Total walking distance across all WALK legs, in metres — drives the
 * walk-distance penalty in scoring/ranking and is surfaced on the route.
 *
 * @param r Route to measure.
 * @returns Total walk distance in metres.
 */
function totalWalkDistanceM(r: AccessibleRoute): number {
  return r.legs.reduce(
    (sum, leg) => (leg.type === "WALK" ? sum + leg.distanceM : sum),
    0,
  );
}

/**
 * Fraction of legs that carry ANY accessibility evidence (OSM a11y nodes or
 * facility highlights) — feeds dataConfidence so missing data is flagged as
 * uncertainty, not scored as bad.
 *
 * @param r Route to inspect.
 * @returns Coverage ratio in [0, 1].
 */
function legDataCoverageRatio(r: AccessibleRoute): number {
  if (!r.legs.length) return 1;
  let withData = 0;
  for (const leg of r.legs) {
    if (leg.type === "WALK") {
      if (leg.a11yFacilities.length) withData++;
    } else if (leg.type === "BUS") {
      if (leg.departureStopA11y.length || leg.arrivalStopA11y.length)
        withData++;
    } else if (
      leg.type === "METRO" ||
      leg.type === "THSR" ||
      leg.type === "TRA"
    ) {
      if (
        leg.departureStationA11y.length ||
        leg.arrivalStationA11y.length ||
        leg.facilityHighlights.length
      )
        withData++;
    }
  }
  return withData / r.legs.length;
}

/**
 * Score every candidate route with the evidence-based scoring engine
 * (accessibility 65% / travel time 35%) and rank them by mode-aware route cost.
 *
 * @param routes Candidate routes to score and rank.
 * @param mode Accessibility mode driving the cost weights. Default "normal".
 * @returns The routes sorted by ascending cost (best first), with score
 *   metadata attached to each.
 */
export function scoreAndRank(
  routes: AccessibleRoute[],
  mode: AccessibilityMode = "normal",
  env?: EnvConditions,
): AccessibleRoute[] {
  const maxTime = Math.max(...routes.map((r) => r.totalMinutes), 1);
  const minTime = Math.min(...routes.map((r) => r.totalMinutes), maxTime);

  return routes
    .map((r) => {
      const facilities = collectRouteFacilities(r);
      const walkDistanceM = totalWalkDistanceM(r);
      const result = scoreRoute(
        facilities,
        r.totalMinutes,
        maxTime,
        minTime,
        r.accessibilityHighlights?.length ?? 0,
        mode,
        walkDistanceM,
        legDataCoverageRatio(r),
        env,
      );
      r.accessibilityScore = result.totalScore;
      r.accessibilityLabel = result.label;
      r.scoreComponents = result.components;
      r.dataConfidence = result.dataConfidence;
      r.scoreWarnings = result.warnings;
      r.totalWalkDistanceM = walkDistanceM;
      r.accessibilitySummary = buildAccessibilitySummary({
        mode,
        walkDistanceM,
        transferCount: r.transferCount,
        facilities,
        label: result.label,
      });
      return {
        route: r,
        cost: routeCost(
          r.totalMinutes,
          r.transferCount,
          result.totalScore,
          mode,
          walkDistanceM,
        ),
      };
    })
    .sort((a, b) => a.cost - b.cost)
    .map((s) => s.route);
}

/**
 * Stage-1 pre-ranking for the two-stage pipeline: order candidates by a cheap,
 * accessibility-aware proxy (time + transfers + walk distance) that needs NO OSM
 * data, so the top-N can be enriched before the real scoreRoute runs. Without
 * this, scoring ran on the un-enriched candidate set (facility data still empty)
 * and the accessibility budget collapsed to pure travel time.
 *
 * @param routes Candidate routes.
 * @param mode Accessibility mode driving the proxy penalties.
 * @returns Routes sorted by ascending proxy cost (best first).
 */
function prerankByProxy(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): AccessibleRoute[] {
  return routes
    .map((r) => ({
      route: r,
      cost: prerankCost(
        r.totalMinutes,
        r.transferCount,
        totalWalkDistanceM(r),
        mode,
      ),
    }))
    .sort((a, b) => a.cost - b.cost)
    .map((s) => s.route);
}

/**
 * Count confirmed stairs-only features in a walk leg while preserving explicit
 * wheelchair-ramp exceptions. OTP can merge consecutive OSM ways into one step,
 * and streetName reflects only the first way; string matching therefore creates
 * both false positives and false negatives, including the observed 1201-metre
 * sidewalk step that was mislabeled as steps.
 *
 * @param leg Walk leg to inspect.
 * @returns The number of confirmed stair features that are not ramp-accessible.
 */
function walkLegStairsCount(leg: WalkLeg): number {
  const hasAccessibleRamp = leg.a11yFacilities.some(
    (f) =>
      f.tags?.["highway"] === "steps" &&
      (f.tags?.["ramp:wheelchair"] === "yes" ||
        f.tags?.["wheelchair"] === "yes"),
  );
  if (hasAccessibleRamp) return 0;
  return (leg.steps ?? []).filter((step) => step.stairs).length;
}

/**
 * Determine whether a walk leg contains a confirmed stairs-only barrier.
 * @param leg Walk leg to inspect.
 * @returns Whether at least one non-exempt stair feature is present.
 */
function walkLegHasStairsBarrier(leg: WalkLeg): boolean {
  return walkLegStairsCount(leg) > 0;
}

/**
 * Whether a walk leg's stairs feature is explicitly OSM-tagged with a handrail.
 * OSM `handrail` tagging is sparse, so this can only ever confirm presence —
 * a leg without a confirmed handrail may still have one; it's simply unknown.
 * @param leg Walk leg to inspect.
 */
function walkLegHasConfirmedHandrail(
  route: AccessibleRoute,
  leg: WalkLeg,
): boolean {
  return legFacilitiesEvenAfterCompacting(route, leg).some(
    (f) => f.tags?.["highway"] === "steps" && f.tags?.["handrail"] === "yes",
  );
}

/**
 * Same barrier check as `walkLegHasStairsBarrier`, but resolving the
 * wheelchair-ramp exemption through `legFacilitiesEvenAfterCompacting` so it
 * still sees the exemption tag after `compactRoutes` has emptied
 * `leg.a11yFacilities`. Used only by the post-finalization needsHandrail
 * check; the pre-slim `avoidStairs` filtering keeps using the plain version
 * since it always runs before any slimming happens.
 *
 * @param route The route `leg` belongs to.
 * @param leg Walk leg to inspect.
 */
function walkLegHasStairsBarrierAfterCompacting(
  route: AccessibleRoute,
  leg: WalkLeg,
): boolean {
  const hasAccessibleRamp = legFacilitiesEvenAfterCompacting(route, leg).some(
    (f) =>
      f.tags?.["highway"] === "steps" &&
      (f.tags?.["ramp:wheelchair"] === "yes" ||
        f.tags?.["wheelchair"] === "yes"),
  );
  if (hasAccessibleRamp) return false;
  return (leg.steps ?? []).some((step) => step.stairs);
}

/**
 * `compactRoutes` (opt-in `format: "compact"`) empties every leg's
 * `a11yFacilities` and moves the documents into `route.facilities`, keyed by
 * osmId, leaving `leg.a11yRefs` as the pointer back. Any check that runs
 * after finalization (like the handrail check above) must resolve through
 * that indirection or it will only ever see an empty array.
 *
 * @param route The route `leg` belongs to (source of `facilities` when compacted).
 * @param leg Walk leg to resolve facilities for.
 */
function legFacilitiesEvenAfterCompacting(
  route: AccessibleRoute,
  leg: WalkLeg,
): Array<{ tags?: Record<string, string> }> {
  if (leg.a11yFacilities.length) return leg.a11yFacilities;
  const refs = (leg as unknown as { a11yRefs?: string[] }).a11yRefs;
  if (!refs?.length || !route.facilities) return [];
  return refs
    .map((id) => route.facilities?.[id])
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
}

const OTP_SERVER_MAX_SLOPE_PERCENT = 8.3;

/**
 * Best-effort annotation pass for the three account-profile fields that have
 * no dedicated routing-engine input: accessible-toilet proximity at the
 * destination, stairs-handrail confirmation, and a maxSlopePercent request.
 * Never fails the request — a lookup error is logged and skipped.
 *
 * @param routes Routes to annotate in place with highlights/warnings.
 * @param dest Journey destination, used for the toilet proximity check.
 * @param travelMode The engine that produced `routes` — determines whether any
 *   slope enforcement is even possible.
 * @param mode Resolved accessibility mode (drives the OTP wheelchair flag).
 * @param avoidStairs Resolved avoidStairs/wheelchair flag actually sent to the engine.
 * @param opts The three profile-only preferences to check.
 * @returns `slopeConstraint` metadata when `maxSlopePercent` was requested.
 */
async function applyExtraA11yAnnotations(
  routes: AccessibleRoute[],
  dest: LatLng,
  travelMode: TravelMode,
  mode: AccessibilityMode | undefined,
  avoidStairs: boolean | undefined,
  opts: {
    needsAccessibleToilet?: boolean;
    needsHandrail?: boolean;
    maxSlopePercent?: number;
    /** True when a nominal "walk" request actually got routed via Valhalla (no elevation data) instead of OTP. */
    routedByEngineWithNoElevationData?: boolean;
  },
): Promise<{
  slopeConstraint?: {
    requestedMaxPercent: number;
    enforced: boolean;
    note: string;
  };
}> {
  if (!routes.length) return {};

  if (opts.needsAccessibleToilet) {
    try {
      const { findNearby } = await import("../a11y/a11y.orchestration");
      const near = await findNearby(dest.lat, dest.lng, 300);
      const osmToiletCount = (near.nearbyOsm ?? []).filter(
        (p: IOsmA11y) => p.category === "toilet",
      ).length;
      const total = (near.nearbyBathroom?.length ?? 0) + osmToiletCount;
      const note =
        total > 0
          ? `目的地附近有 ${total} 處無障礙廁所`
          : ROUTE_WARNING.NO_ACCESSIBLE_TOILET_NEARBY;
      for (const r of routes) {
        if (total > 0) {
          r.accessibilityHighlights = [...r.accessibilityHighlights, note];
        } else {
          r.warnings = [...new Set([...(r.warnings ?? []), note])];
        }
      }
    } catch (err) {
      console.error(
        "[accessible-route] accessible-toilet lookup failed, skipping",
        err,
      );
    }
  }

  if (opts.needsHandrail) {
    for (const r of routes) {
      const hasUnconfirmedHandrailStairs = r.legs.some(
        (leg) =>
          leg.type === "WALK" &&
          walkLegHasStairsBarrierAfterCompacting(r, leg) &&
          !walkLegHasConfirmedHandrail(r, leg),
      );
      if (hasUnconfirmedHandrailStairs) {
        r.warnings = [
          ...new Set([
            ...(r.warnings ?? []),
            ROUTE_WARNING.STAIRS_HANDRAIL_UNKNOWN,
          ]),
        ];
      }
    }
  }

  let slopeConstraint:
    | { requestedMaxPercent: number; enforced: boolean; note: string }
    | undefined;
  if (opts.maxSlopePercent !== undefined) {
    const requestedMaxPercent = opts.maxSlopePercent;
    if (
      travelMode === "drive" ||
      travelMode === "motorcycle" ||
      opts.routedByEngineWithNoElevationData
    ) {
      slopeConstraint = {
        requestedMaxPercent,
        enforced: false,
        note: ROUTE_WARNING.SLOPE_LIMIT_NOT_ENFORCED_NO_ELEVATION,
      };
    } else {
      const wheelchairEngaged = avoidStairs ?? mode === "wheelchair";
      const enforced =
        wheelchairEngaged &&
        requestedMaxPercent >= OTP_SERVER_MAX_SLOPE_PERCENT;
      slopeConstraint = {
        requestedMaxPercent,
        enforced,
        note: wheelchairEngaged
          ? enforced
            ? `伺服器已套用 ${OTP_SERVER_MAX_SLOPE_PERCENT}% 上限（等於或寬於您的設定）`
            : ROUTE_WARNING.SLOPE_LIMIT_STRICTER_THAN_SERVER_DEFAULT
          : "此路線未啟用輪椅模式（avoidStairs 為 false），伺服器未套用任何坡度限制",
      };
    }
    for (const r of routes) {
      r.warnings = [...new Set([...(r.warnings ?? []), slopeConstraint!.note])];
    }
  }

  return { slopeConstraint };
}

/**
 * Count confirmed non-exempt stair features across a route's walking legs.
 * @param route Route to inspect.
 * @returns Total confirmed stair feature count.
 */
function routeStairsCount(route: AccessibleRoute): number {
  return route.legs.reduce(
    (count, leg) =>
      leg.type === "WALK" ? count + walkLegStairsCount(leg) : count,
    0,
  );
}

/**
 * Place confirmed step-free routes before stair-bearing routes while retaining
 * the existing accessibility proxy order within each group.
 * @param routes Proxy-ranked candidate routes.
 * @returns Candidates ordered to keep step-free options inside the enrichment window.
 */
function prioritizeStepFreeRoutes(
  routes: AccessibleRoute[],
): AccessibleRoute[] {
  const stepFree = routes.filter((route) => routeStairsCount(route) === 0);
  const withStairs = routes
    .filter((route) => routeStairsCount(route) > 0)
    .sort((a, b) => routeStairsCount(a) - routeStairsCount(b));
  return [...stepFree, ...withStairs];
}

/**
 * Hard-constraint exclusion: with `requireElevator` a route is excluded when a
 * rail leg has facility data but no working elevator, and with `avoidStairs` when
 * a walk leg passes a stairs-only barrier. Legs with NO facility data are
 * tolerated (unknown ≠ inaccessible) — over-excluding on missing data would 404
 * most queries.
 *
 * @param route Route to evaluate.
 * @param constraints Resolved accessibility constraints for the request.
 * @returns Whether the route should be excluded.
 */
function isRouteExcluded(
  route: AccessibleRoute,
  constraints: A11yConstraints,
): boolean {
  if (!constraints.avoidStairs && !constraints.requireElevator) return false;

  for (const leg of route.legs) {
    if (leg.type === "WALK") {
      if (constraints.avoidStairs && walkLegHasStairsBarrier(leg)) return true;
      continue;
    }
    if (leg.type === "METRO" || leg.type === "THSR" || leg.type === "TRA") {
      if (constraints.requireElevator && leg.facilityHighlights.length > 0) {
        const text = leg.facilityHighlights.join("|");
        if (!text.includes("電梯")) return true;
        if (/電梯[^|]*(維修|故障|暫停)/.test(text)) return true;
      }
    }
  }
  return false;
}

/**
 * Apply the hard accessibility constraints with a graceful fallback. When every
 * candidate still contains stairs, retain only the least-stairs route and mark
 * it degraded; other all-excluded cases retain the original candidates.
 *
 * @param routes Candidate routes to filter.
 * @param constraints Resolved accessibility constraints driving the exclusion.
 * @returns Eligible routes or the appropriate marked fallback candidates.
 */
function applyA11yExclusion(
  routes: AccessibleRoute[],
  constraints: A11yConstraints,
): AccessibleRoute[] {
  const kept = routes.filter((r) => !isRouteExcluded(r, constraints));
  if (kept.length) return kept;
  if (routes.length) {
    if (
      constraints.avoidStairs &&
      routes.every((route) => routeStairsCount(route) > 0)
    ) {
      const leastStairs = routes.reduce((best, route) =>
        routeStairsCount(route) < routeStairsCount(best) ? route : best,
      );
      leastStairs.degraded = true;
      leastStairs.warnings = [
        ...new Set([
          ...(leastStairs.warnings ?? []),
          ROUTE_WARNING.STAIRS_CONSTRAINT_UNSATISFIED,
        ]),
      ];
      console.warn(
        "[accessible-route] every candidate contains stairs; returning the least-stairs route",
        JSON.stringify({
          ...constraints,
          stairs: routeStairsCount(leastStairs),
        }),
      );
      return [leastStairs];
    }
    console.warn(
      "[accessible-route] every candidate failed the a11y constraints; returning them anyway",
      JSON.stringify(constraints),
    );
  }
  return routes;
}

function transitLegKey(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): string {
  switch (leg.type) {
    case "BUS":
      return `BUS|${leg.routeName}|${leg.departureStop}|${leg.arrivalStop}|${leg.direction}`;
    case "METRO":
      return `METRO|${leg.railSystem}|${leg.departureStationUid}|${leg.arrivalStationUid}`;
    case "THSR":
      return `THSR|${leg.departureStationUID}|${leg.arrivalStationUID}`;
    case "TRA":
      return `TRA|${leg.departureStationUID}|${leg.arrivalStationUID}`;
  }
}

function buildRouteKey(r: AccessibleRoute): string {
  const transitLegs = r.legs.filter(
    (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
  );
  if (transitLegs.length === 0) return "";
  return transitLegs.map(transitLegKey).join("::");
}

function deduplicateRoutes(routes: AccessibleRoute[]): AccessibleRoute[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = buildRouteKey(r);
    if (key === "") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cross-planner normalization key: the GTFS graph and the TDX hosted engine can
 * emit the SAME bus line snapped to different stop pairs, which survives the
 * stop-level dedup above as two near-identical candidates. Keys a bus leg at the
 * line level (routeName + direction); rail legs keep their stop-pair identity.
 *
 * @param leg Transit leg to derive a logical key for.
 * @returns The logical leg key.
 */
function logicalLegKey(leg: BusLeg | MetroLeg | ThsrLeg | TraLeg): string {
  return leg.type === "BUS"
    ? `BUS|${leg.routeName}|${leg.direction}`
    : transitLegKey(leg);
}

function collapseLogicalDuplicates(
  routes: AccessibleRoute[],
): AccessibleRoute[] {
  const best = new Map<string, AccessibleRoute>();
  const walkOnly: AccessibleRoute[] = [];
  for (const r of routes) {
    const transitLegs = r.legs.filter(
      (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
    );
    if (!transitLegs.length) {
      walkOnly.push(r);
      continue;
    }
    const key = transitLegs.map(logicalLegKey).join("::");
    const prev = best.get(key);
    if (!prev) {
      best.set(key, r);
      continue;
    }
    const prevFuture =
      prev._isFutureScheduled &&
      typeof prev._scheduledDepartureTime === "number";
    const routeFuture =
      r._isFutureScheduled && typeof r._scheduledDepartureTime === "number";
    if (
      (routeFuture &&
        (!prevFuture ||
          (r._scheduledDepartureTime as number) <
            (prev._scheduledDepartureTime as number))) ||
      (!routeFuture && !prevFuture && r.totalMinutes < prev.totalMinutes)
    ) {
      best.set(key, r);
    }
  }
  return [...best.values(), ...walkOnly];
}

/**
 * Unified a11y enrichment over the FINAL top routes. Planners that skip internal
 * enrichment (OTP) get their transit legs' OsmA11y arrays, route highlights and
 * rail-leg indoor guidance filled here, so per-request Mongo work is top-3 ×
 * stops instead of every-candidate × stops. Legs already enriched by their
 * planner are left untouched. Best-effort and non-throwing.
 *
 * @param routes Top routes to enrich in place.
 * @param origin Journey origin coordinates.
 * @param destination Journey destination coordinates.
 * @param mode Accessibility mode used for indoor guidance.
 */
async function enrichTopRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
): Promise<void> {
  const { nearbyA11y, attachA11yToLeg, deriveHighlights, enrichLegIndoor } =
    await import("./planners/route-a11y");

  const originCoords: [number, number] = [origin.lng, origin.lat];
  const destCoords: [number, number] = [destination.lng, destination.lat];

  const legA11y = (leg: BusLeg | MetroLeg | ThsrLeg | TraLeg) =>
    leg.type === "BUS"
      ? { board: leg.departureStopA11y, alight: leg.arrivalStopA11y }
      : { board: leg.departureStationA11y, alight: leg.arrivalStationA11y };

  await Promise.all(
    routes.map(async (route) => {
      const transitLegs = route.legs.filter(
        (l): l is BusLeg | MetroLeg | ThsrLeg | TraLeg => l.type !== "WALK",
      );
      if (!transitLegs.length) return undefined;

      await Promise.all(
        transitLegs.map(async (leg) => {
          const { board, alight } = legA11y(leg);
          const boardCoords = leg.polyline[0];
          const alightCoords = leg.polyline[leg.polyline.length - 1];
          if (
            (!board.length || !alight.length) &&
            boardCoords &&
            alightCoords
          ) {
            const [boardA11y, alightA11y] = await Promise.all([
              board.length ? Promise.resolve(board) : nearbyA11y(boardCoords),
              alight.length
                ? Promise.resolve(alight)
                : nearbyA11y(alightCoords),
            ]);
            attachA11yToLeg(leg, boardA11y, alightA11y);
          }

          if (
            leg.type !== "BUS" &&
            leg.facilityHighlights.length === 0 &&
            boardCoords &&
            alightCoords
          ) {
            const legIdx = route.legs.indexOf(leg);
            const prev = route.legs[legIdx - 1];
            const next = route.legs[legIdx + 1];
            await enrichLegIndoor(
              leg,
              prev?.type === "WALK" ? prev : null,
              next?.type === "WALK" ? next : null,
              originCoords,
              destCoords,
              boardCoords,
              alightCoords,
              mode,
            );
          }
          return undefined;
        }),
      );

      if (!route.accessibilityHighlights.length) {
        const { board } = legA11y(transitLegs[0]);
        const { alight } = legA11y(transitLegs[transitLegs.length - 1]);
        route.accessibilityHighlights = deriveHighlights(board, alight);
      }
      return undefined;
    }),
  );
}

const MAX_CONFIRMED_HAZARDS_PER_PLAN = 100;

type ConfirmedHazardLookup = (
  center: { lat: number; lng: number },
  radiusM: number,
  limit: number,
) => Promise<ConfirmedHazardInput[]>;

async function defaultConfirmedHazardLookup(
  center: { lat: number; lng: number },
  radiusM: number,
  limit: number,
): Promise<ConfirmedHazardInput[]> {
  const { findConfirmedHazardsWithin } =
    await import("../hazard-report/hazard-report.service");
  return findConfirmedHazardsWithin(center, radiusM, limit);
}

function unappliedHazardPlan(routes: AccessibleRoute[]): HazardRoutePlan {
  return { routes, selectionApplied: false, allCandidatesAffected: false };
}

function warnHazardOverlayFailure(err: unknown): void {
  console.warn(
    "[accessible-route] confirmed-hazard overlay failed; keeping the base route ranking",
    err,
  );
}

/**
 * Fetch verified hazards once for a complete candidate set. `undefined` means
 * matching is unsafe or unavailable; an empty array is a successful no-hazard
 * lookup and preserves the ordinary route order.
 */
async function loadConfirmedHazards(
  routes: AccessibleRoute[],
  lookup: ConfirmedHazardLookup,
): Promise<ConfirmedHazardInput[] | undefined> {
  try {
    const queryArea = buildHazardQueryArea(routes);
    if (!queryArea) return undefined;
    // Fetch one extra document so a saturated response is treated as unknown,
    // rather than falsely asserting that an alternative avoided every hazard.
    const hazards = await lookup(
      queryArea.center,
      queryArea.radiusM,
      MAX_CONFIRMED_HAZARDS_PER_PLAN + 1,
    );
    if (
      !Array.isArray(hazards) ||
      hazards.length > MAX_CONFIRMED_HAZARDS_PER_PLAN
    ) {
      throw new Error("Confirmed-hazard query exceeded its safe result bound");
    }
    return hazards;
  } catch (err) {
    warnHazardOverlayFailure(err);
    return undefined;
  }
}

function planWithConfirmedHazards(
  routes: AccessibleRoute[],
  hazards: ConfirmedHazardInput[],
): HazardRoutePlan {
  try {
    return planConfirmedHazardRoutes(routes, hazards);
  } catch (err) {
    warnHazardOverlayFailure(err);
    return unappliedHazardPlan(routes);
  }
}

/**
 * Query confirmed hazards only for a bounded, fully-matchable candidate area,
 * then apply the pure geometry planner. Any lookup, saturation, or geometry
 * failure returns the original rank untouched: an unavailable check must never
 * manufacture a "clear" or "avoided" route claim.
 *
 * Exported for focused failure-path tests; production callers use the default
 * hazard-report lookup.
 */
export async function applyConfirmedHazardPlanning(
  routes: AccessibleRoute[],
  lookup: ConfirmedHazardLookup = defaultConfirmedHazardLookup,
): Promise<HazardRoutePlan> {
  const hazards = await loadConfirmedHazards(routes, lookup);
  return hazards === undefined
    ? unappliedHazardPlan(routes)
    : planWithConfirmedHazards(routes, hazards);
}

/**
 * Shared finalization: dedupe → cross-planner line-level collapse → proxy
 * pre-rank + confirmed-hazard candidate selection → top-N a11y enrichment
 * (fail-soft) → hard-constraint exclusion → mode-aware score + final
 * confirmed-hazard ranking → top 3 → realtime facility overlay (fail-soft) →
 * realtime transit overlay
 * (bus ETA + TRA delays, fail-soft) → facility slimming (runs LAST so scoring
 * and the overlays see full documents).
 *
 * @param routes Candidate routes to finalize.
 * @param origin Journey origin coordinates.
 * @param destination Journey destination coordinates.
 * @param mode Accessibility mode for scoring.
 * @param constraints Resolved hard accessibility constraints for exclusion.
 * @param format Response shape; "compact" dedupes facilities route-level.
 * @param departureTime Departure time used by the realtime transit overlay.
 * @param envPromise Environment lookup started alongside route planning.
 * @returns The top-3 finalized routes.
 */
async function finalizeRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
  constraints: A11yConstraints,
  format: "standard" | "compact" = "standard",
  departureTime?: Date,
  envPromise?: Promise<EnvConditions | undefined>,
): Promise<AccessibleRoute[]> {
  const PRERANK_N = 8;
  const t: Record<string, number> = {};
  let t0 = Date.now();
  // Stage 1: cheap accessibility-aware proxy pre-rank (no OSM data), then
  // compare every fully-matchable candidate to confirmed hazards BEFORE top-N.
  // Otherwise a clear ninth route can never be selected over eight blocked ones.
  const candidates = collapseLogicalDuplicates(deduplicateRoutes(routes));
  const proxyRanked = prerankByProxy(candidates, mode);
  const proxyEligible = constraints.avoidStairs
    ? prioritizeStepFreeRoutes(proxyRanked)
    : proxyRanked;
  const confirmedHazards = await loadConfirmedHazards(
    proxyEligible,
    defaultConfirmedHazardLookup,
  );
  const proxyHazardPlan =
    confirmedHazards === undefined
      ? unappliedHazardPlan(proxyEligible)
      : planWithConfirmedHazards(proxyEligible, confirmedHazards);
  const topN = proxyHazardPlan.selectionApplied
    ? proxyHazardPlan.routes.slice(0, PRERANK_N)
    : retainEarliestFutureRoute(
        proxyHazardPlan.routes,
        proxyHazardPlan.routes,
        PRERANK_N,
      );
  t.prerank = Date.now() - t0;
  t0 = Date.now();
  // Stage 2: a11y enrichment (Mongo) BEFORE scoring, so facility data is real
  // when scoreRoute runs — otherwise the accessibility budget collapses to 0.
  try {
    await enrichTopRoutes(topN, origin, destination, mode);
  } catch (err) {
    console.warn("[accessible-route] top-N a11y enrichment failed", err);
  }
  t.enrich = Date.now() - t0;
  t0 = Date.now();
  // One weather/air lookup per request (cached, CCTV-free); an environment
  // factor into the score. Never let an env failure break routing.
  let env: EnvConditions | undefined;
  try {
    env = envPromise
      ? await envPromise
      : await getWeatherAndAirQuality(destination.lat, destination.lng);
  } catch (err) {
    console.warn("[accessible-route] environment lookup failed", err);
    env = undefined;
  }
  t.env = Date.now() - t0;
  t0 = Date.now();
  // Stage 3: hard-constraint exclusion, which MUST run after enrichment — the
  // planners emit rail legs with an empty facilityHighlights and enrichLegIndoor
  // is what fills in the elevator notes the exclusion reads. Filtering before
  // Stage 2 silently excluded nothing at all.
  const eligible = applyA11yExclusion(topN, constraints);
  t.exclude = Date.now() - t0;
  t0 = Date.now();
  // Stage 4: score with the enriched facility data, then compare confirmed
  // street-level hazards BEFORE selecting/slimming the final routes.
  const baseRanked = scoreAndRank(eligible, mode, env);
  t.rank = Date.now() - t0;
  t0 = Date.now();
  const hazardPlan =
    confirmedHazards === undefined
      ? unappliedHazardPlan(baseRanked)
      : planWithConfirmedHazards(baseRanked, confirmedHazards);
  // Keep the legacy earliest-future-service guarantee only when hazard evidence
  // did not select between alternatives. A known blocking hazard must not be
  // reintroduced at index zero by that schedule-only override.
  const top = hazardPlan.selectionApplied
    ? hazardPlan.routes.slice(0, 3)
    : retainEarliestFutureRoute(hazardPlan.routes, hazardPlan.routes, 3);
  t.hazard = Date.now() - t0;
  t0 = Date.now();
  try {
    const { overlayFacilityStatus } =
      await import("./planners/facility-status");
    await overlayFacilityStatus(top, mode);
  } catch (err) {
    console.warn("[accessible-route] facility status overlay failed", err);
  }
  t.facilityOverlay = Date.now() - t0;
  t0 = Date.now();
  try {
    const { overlayRealtimeTransit, recoverRailTrainNos, annotateBusTdxCity } =
      await import("./planners/realtime-transit");
    annotateBusTdxCity(top);
    await recoverRailTrainNos(top).catch(() => undefined);
    await overlayRealtimeTransit(top, { departureTime });
  } catch (err) {
    console.warn("[accessible-route] realtime transit overlay failed", err);
  }
  t.realtimeOverlay = Date.now() - t0;
  // Derive B12 details while full facility tags are still attached. slimRoutes
  // and compactRoutes only project/move facility arrays, so these direct WALK
  // fields remain stable in either response format.
  attachWalkA11yDetails(top);
  slimRoutes(top);
  if (format === "compact") compactRoutes(top);
  console.log("[route-timing] finalize", JSON.stringify(t));
  return top;
}

/**
 * City of a coordinate from the nearest imported bus stop (~10ms local Mongo
 * lookup) instead of Google reverse geocoding (~200–800ms external call).
 *
 * @param lat Latitude.
 * @param lng Longitude.
 * @returns The city name, or null when the DB has no stops (caller falls back
 *   to Google).
 */
export async function resolveCityFromStops(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    return await findNearestStopCity(lat, lng, 50_000);
  } catch {
    return null;
  }
}

/** Every METRO leg across the planned routes, in route order. */
function metroLegsOf(routes: AccessibleRoute[]): MetroLeg[] {
  const legs: MetroLeg[] = [];
  for (const route of routes) {
    for (const leg of route.legs) if (leg.type === "METRO") legs.push(leg);
  }
  return legs;
}

/** Distinct rail systems the planned routes actually ride. */
function metroRailSystemsInRoutes(routes: AccessibleRoute[]): string[] {
  return [...new Set(metroLegsOf(routes).map((leg) => leg.railSystem))];
}

/**
 * Strip the `${railSystem}-` / `${railSystem}_` prefix so leg uids
 * (`TRTC-R10` legacy TDX, `TRTC_R10` GTFS-built) compare against TDX alert
 * scope ids, which carry the bare id (`R10`, `R`).
 */
function normalizeStationId(id: string): string {
  const sep = id.includes("_") ? "_" : id.includes("-") ? "-" : null;
  return sep === null ? id : id.slice(id.indexOf(sep) + 1);
}

const CITY_PREFIX_MAP: Record<string, string> = {
  TPE: "Taipei",
  NWT: "NewTaipei",
  TAO: "Taoyuan",
  TXG: "Taichung",
  TNN: "Tainan",
  KHH: "Kaohsiung",
  KEE: "Keelung",
  HSZ: "Hsinchu",
  HSQ: "HsinchuCounty",
  MIA: "MiaoliCounty",
  CHA: "ChanghuaCounty",
  NAN: "NantouCounty",
  YUN: "YunlinCounty",
  CYQ: "ChiayiCounty",
  CYI: "Chiayi",
  PIF: "PingtungCounty",
  ILA: "YilanCounty",
  HUA: "HualienCounty",
  TTT: "TaitungCounty",
  KIN: "KinmenCounty",
  PEN: "PenghuCounty",
  LIE: "LienchiangCounty",
};

function resolveBusCityForAlert(leg: BusLeg): string {
  if (leg.tdxCity) return leg.tdxCity;
  if (leg.departureStopId?.startsWith("THB") || leg.cityCode === "THB") {
    return "InterCity";
  }
  if (leg.departureStopId) {
    const prefixMatch = leg.departureStopId.match(/^[A-Z]+/);
    if (prefixMatch && CITY_PREFIX_MAP[prefixMatch[0]]) {
      return CITY_PREFIX_MAP[prefixMatch[0]];
    }
  }
  if (leg.cityCode && CITY_PREFIX_MAP[leg.cityCode]) {
    return CITY_PREFIX_MAP[leg.cityCode];
  }
  return leg.cityCode ?? "Taipei";
}

/**
 * Attach current operating alerts (TDX MQTT / snapshot cache / REST fallback)
 * across all transit modes (Metro, Bus, TRA, THSR) to their respective legs,
 * and collect system/mode summaries for the response envelope.
 *
 * Best-effort: failures in individual upstream lookups are logged and skipped.
 *
 * @param routes Planned routes; matching transit legs are annotated with `alerts` in place.
 * @returns Object with `metroAlerts` and `transitAlerts` list.
 */
export async function attachTransitAlerts(
  routes: AccessibleRoute[],
): Promise<{ metroAlerts: MetroAlertResult[]; transitAlerts: MatchedAlert[] }> {
  const metroLegs = metroLegsOf(routes);
  const busLegs: BusLeg[] = [];
  const traLegs: TraLeg[] = [];
  const thsrLegs: ThsrLeg[] = [];

  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type === "BUS") busLegs.push(leg);
      else if (leg.type === "TRA") traLegs.push(leg);
      else if (leg.type === "THSR") thsrLegs.push(leg);
    }
  }

  const allTransitAlertsMap = new Map<string, MatchedAlert>();

  // 1. Metro alerts
  let metroAlertsResult: MetroAlertResult[] = [];
  if (metroLegs.length > 0) {
    const railSystems = metroRailSystemsInRoutes(routes);
    const settled = await Promise.allSettled(
      railSystems.map((system) => getMetroAlerts(system)),
    );

    const alertsBySystem = new Map<string, MetroAlertResult>();
    settled.forEach((outcome, index) => {
      const system = railSystems[index];
      if (outcome.status === "rejected") {
        console.warn(
          `[accessible-route] metro alerts unavailable for ${system}`,
          outcome.reason,
        );
        return;
      }
      const result = outcome.value.find((item) => item.railSystem === system);
      if (result?.alerts.length) alertsBySystem.set(system, result);
    });

    for (const leg of metroLegs) {
      const result = alertsBySystem.get(leg.railSystem);
      if (!result) continue;
      const stationIds = new Set(
        [
          leg.departureStationUid,
          leg.arrivalStationUid,
          ...(leg.intermediateStops ?? []).map((stop) => stop.stationUid),
        ]
          .filter((uid): uid is string => Boolean(uid))
          .map(normalizeStationId),
      );
      const lineIds = new Set(
        [leg.lineUid, leg.lineId]
          .filter((uid): uid is string => Boolean(uid))
          .map(normalizeStationId),
      );
      const matched: MetroAlert[] = result.alerts.filter(
        (alert) =>
          alert.stations.some((station) =>
            stationIds.has(normalizeStationId(station.id)),
          ) ||
          alert.lines.some((line) => lineIds.has(normalizeStationId(line))),
      );
      if (matched.length) {
        leg.alerts = matched;
        for (const a of matched) {
          allTransitAlertsMap.set(a.alertId, {
            alertId: a.alertId,
            title: a.title,
            description: a.description,
            status: a.status,
            matchKind: "station",
            startTime: a.publishTime,
            endTime: a.updateTime,
          });
        }
      }
    }
    metroAlertsResult = [...alertsBySystem.values()];
  }

  // 2. Bus alerts
  if (busLegs.length > 0) {
    const busTasks = busLegs.map(async (leg) => {
      try {
        const city = resolveBusCityForAlert(leg);
        const res = await getTransitAlerts({
          mode: "bus",
          city,
          routeName: leg.routeName,
          direction: leg.direction,
          stopUid: leg.departureStopId,
          stopName: leg.departureStop,
        });
        if (res.ok && res.alerts.length > 0) {
          leg.alerts = res.alerts;
          for (const a of res.alerts) allTransitAlertsMap.set(a.alertId, a);
        }
        return res;
      } catch (err) {
        console.warn(
          `[accessible-route] bus alert lookup failed for ${leg.routeName}`,
          err,
        );
        return null;
      }
    });
    await Promise.allSettled(busTasks);
  }

  // 3. TRA alerts
  if (traLegs.length > 0) {
    const traTasks = traLegs.map(async (leg) => {
      try {
        const stationIds = [
          leg.departureStationUID,
          leg.arrivalStationUID,
          ...(leg.intermediateStops ?? []).map((s) => s.stationUid),
        ]
          .filter((uid): uid is string => Boolean(uid))
          .map(normalizeStationId);

        const res = await getTransitAlerts({
          mode: "tra",
          trainNo: leg.trainNo,
          stationIds,
        });
        if (res.ok && res.alerts.length > 0) {
          leg.alerts = res.alerts;
          for (const a of res.alerts) allTransitAlertsMap.set(a.alertId, a);
        }
        return res;
      } catch (err) {
        console.warn(
          `[accessible-route] TRA alert lookup failed for train ${leg.trainNo}`,
          err,
        );
        return null;
      }
    });
    await Promise.allSettled(traTasks);
  }

  // 4. THSR alerts
  if (thsrLegs.length > 0) {
    const thsrTasks = thsrLegs.map(async (leg) => {
      try {
        const fromStationId = normalizeStationId(leg.departureStationUID);
        const toStationId = normalizeStationId(leg.arrivalStationUID);
        const res = await getTransitAlerts({
          mode: "thsr",
          fromStationId,
          toStationId,
        });
        if (res.ok && res.alerts.length > 0) {
          leg.alerts = res.alerts;
          for (const a of res.alerts) allTransitAlertsMap.set(a.alertId, a);
        }
        return res;
      } catch (err) {
        console.warn(
          `[accessible-route] THSR alert lookup failed for train ${leg.trainNo}`,
          err,
        );
        return null;
      }
    });
    await Promise.allSettled(thsrTasks);
  }

  return {
    metroAlerts: metroAlertsResult,
    transitAlerts: [...allTransitAlertsMap.values()],
  };
}

/**
 * Attach current TDX metro alerts to every METRO leg they touch (by station or
 * line), and return the non-empty per-system results for the response envelope.
 * Best-effort: a rail system whose lookup fails is simply dropped.
 *
 * @param routes Planned routes; matching METRO legs are mutated in place.
 * @returns One entry per rail system that has at least one alert.
 */
export async function attachMetroAlerts(
  routes: AccessibleRoute[],
): Promise<MetroAlertResult[]> {
  const result = await attachTransitAlerts(routes);
  return result.metroAlerts;
}

export async function planAccessibleRouteFromRequest(
  body: PlanRouteRequest,
): Promise<PlanRouteResult> {
  let { origin, destination } = body;
  const { query, userLocation, maxTransfers, departureTime, format } = body;
  const travelMode = body.travelMode ?? "transit";
  const rawWaypoints = body.waypoints ?? [];
  let mode = body.mode;
  let requireElevator = body.requireElevator;
  let avoidStairs = body.avoidStairs;
  let needsAccessibleToilet = body.needsAccessibleToilet;
  let needsHandrail = body.needsHandrail;
  let maxSlopePercent = body.maxSlopePercent;

  let intent: RouteIntent | null = null;
  if (query && (!origin || !destination)) {
    try {
      intent = await parseRouteIntent(query);
    } catch (err) {
      console.error("[accessible-route] intent parsing failed", err);
      return {
        ok: false,
        status: ResponseCode.INTERNAL_ERROR,
        error:
          "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination",
      };
    }
    if (!intent) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error: ERROR_MESSAGE.INTENT_PARSE_FAILED,
      };
    }
    origin =
      intent.from === "current_location"
        ? (userLocation ?? undefined)
        : intent.from;
    destination = intent.to;
    mode = mode ?? intent.mode;
    requireElevator = requireElevator ?? intent.preferences?.preferElevator;
    if (!origin) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error: "查詢使用了『目前位置』，請一併提供 userLocation 座標",
      };
    }
  }

  // Lowest-priority fallback: an explicit body value or an AI-parsed intent
  // both reflect this specific trip and win over the account's saved profile.
  if (
    body.userId &&
    (mode === undefined ||
      avoidStairs === undefined ||
      requireElevator === undefined ||
      needsAccessibleToilet === undefined ||
      needsHandrail === undefined ||
      maxSlopePercent === undefined)
  ) {
    try {
      const profile = await getA11yProfile(body.userId);
      if (mode === undefined) {
        if (
          profile.mobilityAid === "manual_wheelchair" ||
          profile.mobilityAid === "power_wheelchair"
        ) {
          mode = "wheelchair";
        } else if (profile.visualAssistance === true) {
          mode = "visual_impaired";
        }
      }
      if (avoidStairs === undefined && profile.canUseStairs !== null)
        avoidStairs = !profile.canUseStairs;
      if (requireElevator === undefined && profile.needsElevator !== null) {
        requireElevator = profile.needsElevator;
      }
      if (
        needsAccessibleToilet === undefined &&
        profile.needsAccessibleToilet === true
      ) {
        needsAccessibleToilet = true;
      }
      if (needsHandrail === undefined && profile.needsHandrail === true)
        needsHandrail = true;
      if (maxSlopePercent === undefined && profile.maxSlopePercent !== null) {
        maxSlopePercent = profile.maxSlopePercent ?? undefined;
      }
    } catch (err) {
      console.error(
        "[accessible-route] failed to load caller's a11y profile, ignoring",
        err,
      );
    }
  }

  if (!origin || !destination) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: `${ERROR_MESSAGE.MISSING_PARAMS}：origin, destination`,
    };
  }

  const tGeo = Date.now();
  const [originCoords, destCoords, waypointCoords] = await Promise.all([
    typeof origin === "string"
      ? getCoordinates(origin)
      : Promise.resolve(origin as { latitude: number; longitude: number }),
    typeof destination === "string"
      ? getCoordinates(destination)
      : Promise.resolve(destination as { latitude: number; longitude: number }),
    Promise.all(
      rawWaypoints.map((w) =>
        typeof w === "string"
          ? getCoordinates(w)
          : Promise.resolve(w as { latitude: number; longitude: number }),
      ),
    ),
  ]);
  const geocodeMs = Date.now() - tGeo;
  if (!originCoords || !destCoords) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: "無法解析出發地或目的地座標",
    };
  }
  if (waypointCoords.some((w) => !w)) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: "無法解析中途點座標",
    };
  }
  const waypoints: LatLng[] = waypointCoords.map((w) => ({
    lat: w!.latitude,
    lng: w!.longitude,
  }));

  const lat = originCoords.latitude;
  const lng = originCoords.longitude;
  const originLatLng: LatLng = { lat, lng };
  const dest: LatLng = { lat: destCoords.latitude, lng: destCoords.longitude };

  const preflight = preflightAccessibleRoute(
    [originLatLng, ...waypoints, dest],
    getServiceCoverageConfig(),
  );
  if (!preflight.ok) return preflight;

  const tCity = Date.now();
  const city = ((await resolveCityFromStops(lat, lng)) ??
    (await getCity(lat, lng))) as TaiwanCityEn;
  const cityMs = Date.now() - tCity;

  const parsedDeparture = departureTime ? new Date(departureTime) : undefined;
  const futureDeparture =
    parsedDeparture &&
    !isNaN(parsedDeparture.getTime()) &&
    parsedDeparture.getTime() > Date.now()
      ? parsedDeparture
      : undefined;

  const waypointsOpt = waypoints.length ? waypoints : undefined;

  const tPlan = Date.now();
  let routes: AccessibleRoute[];
  // Set when a nominal "walk" request actually got routed via Valhalla (no
  // elevation data) instead of OTP, so slopeConstraint reporting isn't fooled
  // by the request's travelMode into claiming the OTP 8.3% default applied.
  let routedByEngineWithNoElevationData = false;
  const logRequestTiming = () =>
    console.log(
      "[route-timing] request",
      JSON.stringify({
        geocode: geocodeMs,
        city: cityMs,
        plan: Date.now() - tPlan,
      }),
    );

  if (travelMode === "transit") {
    const transitMode = mode ?? "normal";
    const constraints = resolveA11yConstraints(transitMode, {
      avoidStairs,
      requireElevator,
    });
    const transitOptions: FindAccessibleRoutesOptions = {
      mode: transitMode,
      maxTransfers: (maxTransfers ?? 2) as 0 | 1 | 2,
      departureTime: futureDeparture,
      format: format === "compact" ? "compact" : "standard",
      waypoints: waypointsOpt,
      avoidStairs: constraints.avoidStairs,
      requireElevator: constraints.requireElevator,
    };
    const transit = await findAccessibleRoutesDetailed(
      originLatLng,
      dest,
      city,
      transitOptions,
    );
    if (transit.status === "unavailable") {
      logRequestTiming();
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT);
    }
    if (transit.status === "no_route") {
      if (constraints.avoidStairs) {
        const relaxed = await findAccessibleRoutesDetailed(
          originLatLng,
          dest,
          city,
          {
            ...transitOptions,
            avoidStairs: false,
            requireElevator: false,
          },
        );
        logRequestTiming();
        if (relaxed.status === "unavailable") {
          return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT);
        }
        if (relaxed.status === "ok" && relaxed.routes.length) {
          return routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE);
        }
        return routeFailure(ROUTE_REASON.NO_ROUTE);
      }
      logRequestTiming();
      return routeFailure(ROUTE_REASON.NO_ROUTE);
    }
    routes = transit.routes;
    logRequestTiming();
  } else if (travelMode === "walk") {
    const roadMode = mode ?? "normal";
    const constraints = resolveA11yConstraints(roadMode, { avoidStairs });
    const walkPoints = [originLatLng, ...waypoints, dest];
    const otpWalk = await planOtpWalkSegments(
      walkPoints,
      roadMode,
      constraints.avoidStairs,
    );
    if (otpWalk.status === "no_route") {
      if (constraints.avoidStairs) {
        const relaxed = await planOtpWalkSegments(walkPoints, roadMode, false);
        logRequestTiming();
        if (relaxed.status === "unavailable") {
          return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT);
        }
        if (relaxed.status === "ok" && relaxed.routes.length) {
          return routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE);
        }
        return routeFailure(ROUTE_REASON.NO_ROUTE);
      }
      logRequestTiming();
      return routeFailure(ROUTE_REASON.NO_ROUTE);
    }
    if (otpWalk.status === "ok") {
      routes = await finalizeDrivingRoutes(otpWalk.routes, "walk", dest);
    } else {
      console.warn(
        "[accessible-route] OTP walk unavailable; falling back to Valhalla for the full route",
        JSON.stringify({ segments: waypoints.length + 1 }),
      );
      const outcome = await findDrivingRoutes(originLatLng, dest, {
        travelMode,
        waypoints: waypointsOpt,
        departureTime: futureDeparture,
        mode: roadMode,
        avoidStairs: constraints.avoidStairs,
      });
      if (outcome.kind === "unavailable") {
        logRequestTiming();
        return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT);
      }
      if (outcome.kind === "error") {
        logRequestTiming();
        return {
          ok: false,
          status: ResponseCode.INTERNAL_ERROR,
          error: "路線規劃失敗，請稍後再試",
        };
      }
      if (outcome.kind === "empty") {
        logRequestTiming();
        return routeFailure(ROUTE_REASON.NO_ROUTE);
      }
      routes = outcome.routes.map((route) => ({
        ...route,
        warnings: [
          ...new Set([
            ...(route.warnings ?? []),
            ROUTE_WARNING.OTP_WALK_FALLBACK,
          ]),
        ],
      }));
      routedByEngineWithNoElevationData = true;
    }
    logRequestTiming();
  } else {
    const roadMode = mode ?? "normal";
    const constraints = resolveA11yConstraints(roadMode, { avoidStairs });
    let routingDest = dest;
    let finalWalkTarget: LatLng | undefined;
    let arrivalParking: { name: string; distanceM: number } | undefined;
    try {
      const { findNearbyParking } = await import("../a11y/a11y.service");
      const parking = await findNearbyParking(
        dest.lat,
        dest.lng,
        PARKING_ARRIVAL_RADIUS_M,
      );
      if (parking.length) {
        const p = parking[0];
        const isLot = p.type === "lot";
        const anchor: LatLng = {
          lat: isLot ? p.position.coordinates[1] : p.location.coordinates[1],
          lng: isLot ? p.position.coordinates[0] : p.location.coordinates[0],
        };
        routingDest = anchor;
        finalWalkTarget = dest;
        arrivalParking = {
          name: isLot ? p.name : p.placeName,
          distanceM: Math.round(
            haversineMeters(anchor.lat, anchor.lng, dest.lat, dest.lng),
          ),
        };
      }
    } catch (err) {
      console.warn(
        "[accessible-route] parking-aware arrival lookup failed; using true destination",
        err,
      );
    }
    let outcome = await findDrivingRoutes(originLatLng, routingDest, {
      travelMode,
      waypoints: waypointsOpt,
      departureTime: futureDeparture,
      mode: roadMode,
      avoidStairs: constraints.avoidStairs,
      ...(finalWalkTarget ? { finalWalkTarget } : {}),
      ...(arrivalParking ? { arrivalParking } : {}),
    });
    // Two-stage fallback: if the parking bay is not drivable (NO_ROUTE → empty),
    // retry once with the true destination and the plain current-behavior path.
    // Only "empty" retries; "unavailable"/"error" keep their existing meaning.
    if (outcome.kind === "empty" && finalWalkTarget) {
      outcome = await findDrivingRoutes(originLatLng, dest, {
        travelMode,
        waypoints: waypointsOpt,
        departureTime: futureDeparture,
        mode: roadMode,
        avoidStairs: constraints.avoidStairs,
      });
    }
    logRequestTiming();
    if (outcome.kind === "unavailable") {
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT);
    }
    if (outcome.kind === "error") {
      return {
        ok: false,
        status: ResponseCode.INTERNAL_ERROR,
        error: "路線規劃失敗，請稍後再試",
      };
    }
    if (outcome.kind === "empty") {
      return routeFailure(ROUTE_REASON.NO_ROUTE);
    }
    routes = outcome.routes;
  }

  const { slopeConstraint } = await applyExtraA11yAnnotations(
    routes,
    dest,
    travelMode,
    mode,
    avoidStairs,
    {
      needsAccessibleToilet,
      needsHandrail,
      maxSlopePercent,
      routedByEngineWithNoElevationData,
    },
  );

  // Advisory overlay only — a failed alert lookup must never fail the plan.
  let metroAlerts: MetroAlertResult[] = [];
  let transitAlerts: MatchedAlert[] = [];
  try {
    const alertsResult = await attachTransitAlerts(routes);
    metroAlerts = alertsResult.metroAlerts;
    transitAlerts = alertsResult.transitAlerts;
  } catch (err) {
    console.warn(
      "[accessible-route] transit alerts lookup failed; continuing without alerts",
      err,
    );
  }

  return {
    ok: true,
    data: {
      origin: originLatLng,
      destination: dest,
      city,
      travelMode,
      ...(waypoints.length ? { waypoints } : {}),
      routes,
      ...(intent ? { intent } : {}),
      ...(slopeConstraint ? { slopeConstraint } : {}),
      ...(metroAlerts.length ? { metroAlerts } : {}),
      ...(transitAlerts.length ? { transitAlerts } : {}),
    },
  };
}

/** HTTP response variant that makes successful routes armable by voice Live. */
export async function planAccessibleRouteForHttp(
  body: PlanRouteRequest,
): Promise<PlanRouteResult> {
  const result = await planAccessibleRouteFromRequest(body);
  if (!result.ok) return result;
  return {
    ...result,
    data: {
      ...result.data,
      routes: await attachRouteTokens(result.data.routes),
    },
  };
}

/** Sum of road/walk leg distances (metres) — driving routes only. */
function driveTotalDistanceM(r: AccessibleRoute): number {
  return r.legs.reduce((sum, leg) => {
    if (
      leg.type === "WALK" ||
      leg.type === "DRIVE" ||
      leg.type === "MOTORCYCLE"
    )
      return sum + leg.distanceM;
    return sum;
  }, 0);
}

/** Drop near-identical Google alternatives (same rounded time + distance). */
function dedupeDrivingRoutes(routes: AccessibleRoute[]): AccessibleRoute[] {
  const seen = new Set<string>();
  const out: AccessibleRoute[] = [];
  for (const r of routes) {
    const key = `${Math.round(r.totalMinutes)}|${Math.round(
      driveTotalDistanceM(r) / 50,
    )}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Lightweight a11y hook for non-transit routes (best-effort): attach a nearby
 * disabled-parking count at the destination for drive/motorcycle, or nearby
 * elevator/ramp count for walk. Never throws.
 *
 * @param routes Ranked routes to annotate in place.
 * @param travelMode Road travel mode driving which hook runs.
 * @param destination Journey destination.
 */
async function attachDrivingA11yHighlights(
  routes: AccessibleRoute[],
  travelMode: RoadTravelMode,
  destination: LatLng,
  skipParkingHighlight = false,
): Promise<void> {
  if (!routes.length) return;
  if (travelMode === "walk") {
    const { findNearby } = await import("../a11y/a11y.orchestration");
    const near = await findNearby(destination.lat, destination.lng, 200);
    const structures = (near.nearbyOsm ?? []).filter(
      (p) => p.category === "elevator" || p.category === "ramp",
    );
    if (structures.length) {
      const hl = `目的地附近有 ${structures.length} 處電梯／坡道`;
      for (const r of routes)
        r.accessibilityHighlights = [...r.accessibilityHighlights, hl];
    }
    return;
  }
  // Parking-aware arrival already surfaced a specific bay — skip the generic
  // nearby-parking count (avoids a duplicate lookup and an overlapping highlight).
  if (skipParkingHighlight) return;
  const { findNearbyParking } = await import("../a11y/a11y.service");
  const parking = await findNearbyParking(
    destination.lat,
    destination.lng,
    300,
  );
  if (parking.length) {
    const hl = `目的地 300m 內有 ${parking.length} 處身障停車格`;
    for (const r of routes)
      r.accessibilityHighlights = [...r.accessibilityHighlights, hl];
  }
}

/**
 * Finalize Google-planned (non-transit) routes: dedupe near-identical
 * alternatives, rank by time/distance plus confirmed hazards, keep top 3, then
 * attach the lightweight a11y highlight. The transit scoring/overlay pipeline
 * does not apply here.
 *
 * @param routes Mapped Google routes.
 * @param travelMode Road travel mode.
 * @param destination Journey destination (for the a11y hook).
 * @returns The top-3 finalized routes.
 */
async function finalizeDrivingRoutes(
  routes: AccessibleRoute[],
  travelMode: RoadTravelMode,
  destination: LatLng,
  skipParkingHighlight = false,
): Promise<AccessibleRoute[]> {
  const baseRanked = dedupeDrivingRoutes(routes).sort(
    (a, b) =>
      a.totalMinutes - b.totalMinutes ||
      driveTotalDistanceM(a) - driveTotalDistanceM(b),
  );
  // Road/walk routes bypass the transit finalizer, so run the same confirmed
  // hazard ranking before this pipeline takes its top-three projection.
  const ranked = (await applyConfirmedHazardPlanning(baseRanked)).routes.slice(
    0,
    3,
  );
  attachWalkA11yDetails(ranked);
  try {
    await attachDrivingA11yHighlights(
      ranked,
      travelMode,
      destination,
      skipParkingHighlight,
    );
  } catch (err) {
    console.warn("[accessible-route] driving a11y hook failed", err);
  }
  return ranked;
}

type DrivingOutcome =
  | { kind: "ok"; routes: AccessibleRoute[] }
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "error" };

/**
 * Plan + finalize a drive/motorcycle/walk route via self-hosted Valhalla.
 *
 * @param origin Journey origin.
 * @param destination Journey destination.
 * @param opts Road travel mode, optional waypoints, optional departure time.
 * @returns An outcome distinguishing ok / no-route / upstream-down / error.
 */
async function findDrivingRoutes(
  origin: LatLng,
  destination: LatLng,
  opts: FindDrivingRoutesOptions,
): Promise<DrivingOutcome> {
  const { planValhallaRoute, ValhallaRoutingError } =
    await import("./planners/valhalla-routing");
  let raw: AccessibleRoute[];
  try {
    raw = await planValhallaRoute(origin, destination, {
      travelMode: opts.travelMode,
      waypoints: opts.waypoints,
      departureTime: opts.departureTime,
      finalWalkTarget: opts.finalWalkTarget,
      mode: opts.mode,
      avoidStairs: opts.avoidStairs,
    });
  } catch (err) {
    if (err instanceof ValhallaRoutingError) return { kind: "unavailable" };
    console.error("[accessible-route] valhalla routing failed", err);
    return { kind: "error" };
  }
  if (!raw.length) return { kind: "empty" };
  // Highlight-hook uses the true destination, not a proxy arrival point.
  const trueDest = opts.finalWalkTarget ?? destination;
  const routes = await finalizeDrivingRoutes(
    raw,
    opts.travelMode,
    trueDest,
    !!opts.arrivalParking,
  );
  if (opts.arrivalParking) {
    const { name, distanceM } = opts.arrivalParking;
    for (const r of routes) {
      r.accessibilityHighlights = [
        ...r.accessibilityHighlights,
        `已為您導引至最近身障停車格「${name}」（距目的地約 ${distanceM} 公尺）`,
      ];
    }
  }
  return routes.length ? { kind: "ok", routes } : { kind: "empty" };
}

/**
 * Concatenate per-segment transit routes into one combined route (legs joined
 * in order; minutes and transfers summed).
 *
 * @param segments The best route for each origin→wp→…→dest segment.
 * @returns The combined route.
 */
/**
 * Collapse consecutive WALK legs into one — removes the double-walk seam left
 * at each waypoint (arrive-at-waypoint walk + depart-waypoint walk). Distances
 * and times sum; polylines concatenate (prev's end == waypoint == next's start,
 * so the merged line still passes through the waypoint). Waypoint positions are
 * surfaced separately on the response `data.waypoints`, so no marker is lost.
 *
 * @param legs Concatenated legs.
 * @returns Legs with adjacent WALK legs merged.
 */
function mergeAdjacentWalkLegs(
  legs: AccessibleRoute["legs"],
): AccessibleRoute["legs"] {
  const out: AccessibleRoute["legs"] = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "WALK" && leg.type === "WALK") {
      out[out.length - 1] = {
        type: "WALK",
        from: prev.from,
        to: leg.to,
        distanceM: prev.distanceM + leg.distanceM,
        minutesEst: prev.minutesEst + leg.minutesEst,
        polyline: [...prev.polyline, ...leg.polyline],
        a11yFacilities: [...prev.a11yFacilities, ...leg.a11yFacilities],
        ...deriveWalkA11yDetails(
          [...prev.a11yFacilities, ...leg.a11yFacilities],
          [...prev.polyline, ...leg.polyline],
        ),
        ...(prev.exitInfo || leg.exitInfo
          ? { exitInfo: prev.exitInfo ?? leg.exitInfo }
          : {}),
        ...(prev.steps || leg.steps
          ? { steps: [...(prev.steps ?? []), ...(leg.steps ?? [])] }
          : {}),
        ...(prev.a11yRefs || leg.a11yRefs
          ? { a11yRefs: [...(prev.a11yRefs ?? []), ...(leg.a11yRefs ?? [])] }
          : {}),
      };
    } else {
      out.push(leg);
    }
  }
  return out;
}

/**
 * Combine sequential transit segments while keeping movement duration separate
 * from service-wait time and propagating the first segment's public date plus
 * the complete journey's internal absolute schedule.
 *
 * @param segments Ordered routes selected for each waypoint segment.
 * @returns One combined route with merged adjacent walk legs.
 */
function combineSegments(segments: AccessibleRoute[]): AccessibleRoute {
  const combined = {
    routeId: `combined-${segments.map((s) => s.routeId).join("-")}`,
    routeName: segments.map((s) => s.routeName).join(" → "),
    totalMinutes: segments.reduce((sum, s) => sum + s.totalMinutes, 0),
    transferCount: segments.reduce((sum, s) => sum + s.transferCount, 0),
    legs: mergeAdjacentWalkLegs(segments.flatMap((s) => s.legs)),
    accessibilityHighlights: segments.flatMap(
      (s) => s.accessibilityHighlights ?? [],
    ),
    ...(segments[0]?.departureDate
      ? { departureDate: segments[0].departureDate }
      : {}),
  } satisfies AccessibleRoute;
  const departureTime = segments[0]?._scheduledDepartureTime;
  const endTime = segments[segments.length - 1]?._scheduledEndTime;
  if (typeof departureTime !== "number" || typeof endTime !== "number") {
    return combined;
  }
  return attachInternalSchedule(
    combined,
    departureTime,
    endTime,
    segments.some((segment) => segment._isFutureScheduled),
  );
}

type WalkSegmentsResult =
  | { status: "ok"; routes: AccessibleRoute[] }
  | { status: "no_route" | "unavailable"; routes: [] };

/**
 * Combine successful OTP walking segments without collapsing their leg
 * boundaries, so public legIndex values remain meaningful at waypoints.
 * @param segments The selected OTP route for each adjacent coordinate pair.
 * @returns One ordered multi-leg walking route.
 */
function combineWalkSegments(segments: AccessibleRoute[]): AccessibleRoute {
  const legs = segments.flatMap((segment, segmentIndex) =>
    segment.legs.map((leg) => {
      if (leg.type !== "WALK") return leg;
      const lastIndex = segments.length - 1;
      return {
        ...leg,
        from: segmentIndex === 0 ? "起點" : `中途點 ${segmentIndex}`,
        to: segmentIndex === lastIndex ? "終點" : `中途點 ${segmentIndex + 1}`,
      };
    }),
  );
  return {
    routeId: `walk-${segments.map((segment) => segment.routeId).join("-")}`,
    routeName: "步行",
    totalMinutes: segments.reduce(
      (sum, segment) => sum + segment.totalMinutes,
      0,
    ),
    transferCount: 0,
    legs,
    accessibilityHighlights: segments.flatMap(
      (segment) => segment.accessibilityHighlights ?? [],
    ),
    ...(segments.some((segment) => segment.degraded) ? { degraded: true } : {}),
    ...(segments.some((segment) => segment.warnings?.length)
      ? {
          warnings: [
            ...new Set(segments.flatMap((segment) => segment.warnings ?? [])),
          ],
        }
      : {}),
    totalWalkDistanceM: segments.reduce(
      (sum, segment) => sum + (segment.totalWalkDistanceM ?? 0),
      0,
    ),
    attribution: segments[0]?.attribution,
  };
}

/**
 * Plan all adjacent walking segments through OTP with bounded concurrency.
 * @param points Ordered origin, waypoint, and destination coordinates.
 * @param mode Accessibility mode used for OTP walking speed.
 * @param avoidStairs Whether every segment must request wheelchair routing.
 * @returns A combined route or an explicit no-route/unavailable status.
 */
async function planOtpWalkSegments(
  points: LatLng[],
  mode: AccessibilityMode,
  avoidStairs: boolean,
): Promise<WalkSegmentsResult> {
  const { planOtpWalkDetailed } = await import("./planners/otp-routing");
  const limiter = createLimiter(MAX_WALK_SEGMENT_CONCURRENCY);
  const results = await Promise.all(
    points
      .slice(0, -1)
      .map((from, index) =>
        limiter(() =>
          planOtpWalkDetailed(from, points[index + 1], { mode, avoidStairs }),
        ),
      ),
  );
  if (results.some((result) => result.status === "unavailable")) {
    return { status: "unavailable", routes: [] };
  }
  if (results.some((result) => result.status === "no_route")) {
    return { status: "no_route", routes: [] };
  }
  const selected = results.map((result) => result.routes[0]);
  if (selected.some((route) => !route)) {
    return { status: "no_route", routes: [] };
  }
  return {
    status: "ok",
    routes: [combineWalkSegments(selected as AccessibleRoute[])],
  };
}

const OTP_TRANSPORT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_NETWORK",
  "ERR_BAD_RESPONSE",
]);

function isOtpPlannerTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; isAxiosError?: unknown };
  return (
    candidate.isAxiosError === true ||
    (typeof candidate.code === "string" &&
      OTP_TRANSPORT_ERROR_CODES.has(candidate.code))
  );
}

/** Compatibility wrapper for array-based callers. */
export async function findAccessibleRoutes(
  origin: LatLng,
  destination: LatLng,
  city: TaiwanCityEn,
  opts: FindAccessibleRoutesOptions = {},
): Promise<AccessibleRoute[]> {
  return (await findAccessibleRoutesDetailed(origin, destination, city, opts))
    .routes;
}

/**
 * Plan transit routes while preserving upstream-unavailable versus genuine
 * no-route outcomes across every waypoint segment.
 */
export async function findAccessibleRoutesDetailed(
  origin: LatLng,
  destination: LatLng,
  _city: TaiwanCityEn,
  opts: FindAccessibleRoutesOptions = {},
): Promise<FindAccessibleRoutesResult> {
  const mode = opts.mode ?? "normal";
  const constraints = resolveA11yConstraints(mode, {
    avoidStairs: opts.avoidStairs,
    requireElevator: opts.requireElevator,
  });
  const maxTransfers = opts.maxTransfers ?? 1;
  const waypoints = opts.waypoints ?? [];
  const { planOtpRouteDetailed } = await import("./planners/otp-routing");
  const runOtpSegment = async (
    from: LatLng,
    to: LatLng,
    segmentOpts: Parameters<typeof planOtpRouteDetailed>[2],
  ): Promise<FindAccessibleRoutesResult> => {
    try {
      return await planOtpRouteDetailed(from, to, segmentOpts);
    } catch (error) {
      if (!isOtpPlannerTransportFailure(error)) throw error;
      console.warn(
        "[accessible-route] OTP transit planner transport failure",
        error,
      );
      return { status: "unavailable", routes: [] };
    }
  };
  const t0 = Date.now();
  const envPromise = getWeatherAndAirQuality(
    destination.lat,
    destination.lng,
  ).catch(() => undefined);

  if (!waypoints.length) {
    const otp = await runOtpSegment(origin, destination, {
      maxTransfers,
      mode,
      avoidStairs: constraints.avoidStairs,
      departureTime: opts.departureTime,
    });
    console.log(
      "[route-timing] planners",
      JSON.stringify({ otp: Date.now() - t0 }),
    );
    if (otp.status !== "ok") return otp;
    if (!otp.routes.length) return { status: "no_route", routes: [] };
    const routes = await finalizeRoutes(
      otp.routes,
      origin,
      destination,
      mode,
      constraints,
      opts.format,
      opts.departureTime,
      envPromise,
    );
    return routes.length
      ? { status: "ok", routes }
      : { status: "no_route", routes: [] };
  }

  // Multi-waypoint transit: plan each origin→wp→…→dest segment sequentially,
  // propagating time — each segment departs when the previous one arrives, so
  // later-segment transit schedules line up with the traveller's real arrival.
  // Remaining accepted limitations: double WALK seams at each waypoint, and no
  // cross-segment global optimization (each segment takes its own best).
  const points: LatLng[] = [origin, ...waypoints, destination];
  const segmentPairs: [LatLng, LatLng][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segmentPairs.push([points[i], points[i + 1]]);
  }
  let cursor = opts.departureTime ?? new Date();
  const segments: AccessibleRoute[] = [];
  for (const [from, to] of segmentPairs) {
    const result = await runOtpSegment(from, to, {
      maxTransfers,
      mode,
      avoidStairs: constraints.avoidStairs,
      departureTime: cursor,
      limit: 1,
    });
    if (result.status !== "ok") return result;
    const best = result.routes[0];
    if (!best) return { status: "no_route", routes: [] };
    segments.push(best);
    const segmentEndTime =
      typeof best._scheduledEndTime === "number"
        ? best._scheduledEndTime
        : cursor.getTime() + best.totalMinutes * 60_000;
    cursor = new Date(segmentEndTime);
  }
  console.log(
    "[route-timing] planners",
    JSON.stringify({
      otpSegments: Date.now() - t0,
      segments: segmentPairs.length,
    }),
  );
  const combined = combineSegments(segments);
  const routes = await finalizeRoutes(
    [combined],
    origin,
    destination,
    mode,
    constraints,
    opts.format,
    opts.departureTime,
    envPromise,
  );
  return routes.length
    ? { status: "ok", routes }
    : { status: "no_route", routes: [] };
}
