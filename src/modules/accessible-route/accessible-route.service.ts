import {
  groupRoutesByTransitSkeleton,
  resolveCandidateGroup,
  compareRoutesByArrival,
  compareRouteEligibility,
  type PairSearchMemo,
} from "./bus-stop-pair-candidates";
import { createCandidateRequestBudget } from "../transit/bus-stop-pair-eta.service";
import { nextTaipeiClock, taipeiIsoOffset } from "../../config/taipei-time";
import { copyWithDescriptors } from "../../utils/route-source-names";
import { enrichRouteDisplayNames } from "./route-display-enrichment";
import { normalizedStreetNames } from "../../utils/nav-instructions-engine";
import { getCoordinates } from "../../adapters/google.adapter";
import { resolveCity } from "../geography/city.service";
import { transitPreferencePenalty } from "./planners/transit-preference";
import type { TransitPreference } from "../../types/route";
import { parseRouteIntent } from "./route-intent.port";
import {
  accessibilityModeFromProfile,
  getA11yProfile,
} from "../user/user.service";
import type { RouteIntent } from "../../types/ai";
import type {
  CsrWalkPlan,
  CsrWalkResult,
} from "./planners/pedestrian-a11y/csr-walk.types";
import { ResponseCode } from "../../types/code";
import { getServiceCoverageConfig } from "../../config/coverage";
import { isWithinPedGraphCoverage } from "../../config/ped-graph";
import { peekPedGraphSnapshot } from "./planners/pedestrian-a11y/graph-runtime";
import { nearestOutdoorPoint } from "./planners/pedestrian-a11y/spatial-index";
import {
  ERROR_MESSAGE,
  REROUTE_MSG,
  REROUTE_MSG_EN,
  ROUTE_REASON,
  ROUTE_WARNING,
  TRANSIT_FALLBACK_REASON,
} from "../../constants/messages";
import type {
  A11yConstraints,
  CanonicalPlanRouteRequest,
  FindAccessibleRoutesOptions,
  FindAccessibleRoutesResult,
  FindDrivingRoutesOptions,
  LatLng,
  PlanRouteRequest,
  PlanRouteResult,
  RoadTravelMode,
  TransitFallback,
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
import { attachWalkElevationProfiles } from "./route-elevation-enrichment";
import { slimRouteGeometry } from "./geometry-slim";
import { getRoutingConfig } from "../../config/routing";
import { restoreRouteStopIds } from "./stop-aliases";
import { matchAudioSignals, paddedBbox } from "./planners/audio-signals";
import {
  scoreRoute,
  routeCost,
  resolveA11yConstraints,
  type EnvConditions,
} from "./scoring";
import { buildAccessibilitySummary } from "./planners/route-a11y";
import { DEFAULT_LANG, type SupportedLang } from "../../types/lang";
import { venueArrivalPlanner } from "./venue-arrival.port";
import type { VenueArrival, VenueRoute } from "./venue-leg.types";
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
import {
  arrivalEntranceHighlight,
  resolveParkArrival,
  type ParkArrival,
  type ParkArrivalInput,
} from "./park-arrival";
import { attachRouteTokens } from "./route-token.service";
import {
  dedupeExactRouteGeometry,
  dedupeRouteGeometry,
} from "./planners/route-geometry-dedupe";
import { selectDiverseWalkRoutes } from "./planners/walk-route-diversity";
import { selectRoadCandidates } from "./planners/road-candidate-selection";
import { annotateSidewalkSegments } from "../../adapters/otp-sidewalk-index.adapter";
import { normalizeWalkLegSteps } from "../../utils/nav-instructions-engine";
import {
  localizeRouteDetails,
  localizeRouteReason,
  presentRouteMessages,
  routeMessage,
} from "../../utils/route-messages";
import { attachInternalSchedule } from "./route-schedule";
import {
  buildHazardQueryArea,
  HAZARD_PENALTY_POINTS,
  matchConfirmedHazardsToRoute,
  pointToSegmentDistanceM,
  planConfirmedHazardRoutes,
  type ConfirmedHazardInput,
  type HazardRoutePlan,
} from "./planners/hazard-routing";
import {
  preflightAccessibleRoute,
  routeFailure,
} from "./accessible-route.failure";

import { WALK_POLICY_VERSION } from "../../types/route";
import type {
  AccessibilityMode,
  SlimA11y,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  DriveLeg,
  AccessibleRoute,
  RouteHazard,
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
/**
 * Budget for the park-entrance lookup. It is an advisory refinement of the
 * destination, so a slow or unreachable database must not hold up planning.
 */
const PARK_ARRIVAL_BUDGET_MS = 800;
const MAX_WALK_SEGMENT_CONCURRENCY = 4;

function appendRouteWarning(
  route: AccessibleRoute,
  descriptor: import("../../types/route-message").RouteMessageDescriptor,
): void {
  const current = route.warnings ?? [];
  if (current.includes(descriptor.legacyMessage)) return;
  route.warnings = [...current, descriptor.legacyMessage];
  route._warningMessages = [...(route._warningMessages ?? []), descriptor];
}

function appendRouteHighlight(
  route: AccessibleRoute,
  descriptor: import("../../types/route-message").RouteMessageDescriptor,
): void {
  if (route.accessibilityHighlights.includes(descriptor.legacyMessage)) return;
  route.accessibilityHighlights = [
    ...route.accessibilityHighlights,
    descriptor.legacyMessage,
  ];
  route._accessibilityHighlightMessages = [
    ...(route._accessibilityHighlightMessages ?? []),
    descriptor,
  ];
}
/** How far a transit endpoint may move to reach a street-level walkway. */
const STREET_ANCHOR_TOLERANCE_M = 30;

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

function audioSignalNodes(leg: WalkLeg): IOsmA11y[] {
  return (leg.a11yPoints ?? [])
    .filter((p) => p.type === "audio_signal")
    .map((p) => ({
      osmId: `audio_signal:${p.location[0]},${p.location[1]}`,
      ...(p.name ? { name: p.name } : {}),
      category: "wheelchair_accessible",
      tags: { "traffic_signals:sound": "yes" },
      location: { type: "Point", coordinates: p.location },
      importedAt: new Date(0),
    }));
}

function collectRouteFacilities(r: AccessibleRoute): IOsmA11y[] {
  return r.legs.flatMap((leg) => {
    if (leg.type === "WALK")
      return [...leg.a11yFacilities, ...audioSignalNodes(leg)];
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
 * Score one route with the evidence-based scoring engine, attaching the score
 * metadata to it.
 *
 * @param r The route, updated in place.
 * @param maxTime Slowest total minutes among the routes compared.
 * @param minTime Fastest total minutes among the routes compared.
 * @param mode Accessibility mode driving the weights.
 * @param env Weather / air conditions, when known.
 * @returns The route's total accessibility score.
 */
function scoreRouteInPlace(
  r: AccessibleRoute,
  maxTime: number,
  minTime: number,
  mode: AccessibilityMode,
  env?: EnvConditions,
  language?: SupportedLang,
): number {
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
    r.transferCount,
    language,
  );
  r.accessibilityScore = result.totalScore;
  r.accessibilityLabel = result.label;
  r.scoreComponents = result.components;
  r.factors = result.factors;
  r.dataConfidence = result.dataConfidence;
  r.scoreWarnings = result.warnings;
  r._scoreWarningMessages = result.warningMessages;
  r.totalWalkDistanceM = walkDistanceM;
  r.accessibilitySummary = buildAccessibilitySummary({
    mode,
    walkDistanceM,
    transferCount: r.transferCount,
    facilities,
    label: result.label,
    language,
  });
  return result.totalScore;
}

/**
 * Mode-aware ranking cost of an already scored route.
 *
 * @param r A route with its accessibility score attached.
 * @param mode Accessibility mode driving the cost weights.
 * @param transitPreference Soft transit-mode preference.
 * @returns The cost; lower ranks first.
 */
function scoredRouteCost(
  r: AccessibleRoute,
  mode: AccessibilityMode,
  transitPreference?: TransitPreference,
): number {
  return (
    routeCost(
      r.totalMinutes,
      r.transferCount,
      r.accessibilityScore ?? 0,
      mode,
      r.totalWalkDistanceM ?? totalWalkDistanceM(r),
    ) + transitPreferencePenalty(r, transitPreference)
  );
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
  transitPreference?: TransitPreference,
  language?: SupportedLang,
): AccessibleRoute[] {
  const maxTime = Math.max(...routes.map((r) => r.totalMinutes), 1);
  const minTime = Math.min(...routes.map((r) => r.totalMinutes), maxTime);

  return routes
    .map((r) => {
      scoreRouteInPlace(r, maxTime, minTime, mode, env, language);
      return { route: r, cost: scoredRouteCost(r, mode, transitPreference) };
    })
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
  // SAFETY: Legacy compacted legs may carry a11yRefs before facility resolution.
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
 * @param opts The three profile-only preferences to check.
 * @returns `slopeConstraint` metadata when `maxSlopePercent` was requested.
 */
async function applyExtraA11yAnnotations(
  routes: AccessibleRoute[],
  dest: LatLng,
  travelMode: TravelMode,
  mode: AccessibilityMode | undefined,
  opts: {
    language?: SupportedLang;
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
      const descriptor =
        total > 0
          ? routeMessage("ROUTE_TOILET_AVAILABLE", note, { count: total })
          : routeMessage("ROUTE_NO_ACCESSIBLE_TOILET", note);
      for (const r of routes) {
        if (total > 0) appendRouteHighlight(r, descriptor);
        else appendRouteWarning(r, descriptor);
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
        appendRouteWarning(
          r,
          routeMessage(
            "ROUTE_STAIRS_HANDRAIL_UNKNOWN",
            ROUTE_WARNING.STAIRS_HANDRAIL_UNKNOWN,
          ),
        );
      }
    }
  }

  let slopeConstraint:
    | { requestedMaxPercent: number; enforced: boolean; note: string }
    | undefined;
  const pureWalk =
    routes.length > 0 &&
    routes.every((route) => route.legs.every((leg) => leg.type === "WALK"));
  const serverMaxPercent = pureWalk
    ? Math.max(
        ...routes.map(
          (route) =>
            route.walkPolicy?.maxSlopePercent ?? OTP_SERVER_MAX_SLOPE_PERCENT,
        ),
      )
    : OTP_SERVER_MAX_SLOPE_PERCENT;
  if (opts.maxSlopePercent !== undefined) {
    const requestedMaxPercent = opts.maxSlopePercent;
    let slopeMessageCode: string;
    const hasCsrWalkRoute = routes.some(
      (route) => route.engine === "pedestrian-a11y",
    );
    if (hasCsrWalkRoute) {
      slopeMessageCode = "ROUTE_SLOPE_CSR";
      slopeConstraint = {
        requestedMaxPercent,
        enforced: false,
        note: ROUTE_WARNING.CSR_SLOPE_LIMIT_NOT_ENFORCED,
      };
    } else if (
      travelMode === "drive" ||
      travelMode === "motorcycle" ||
      opts.routedByEngineWithNoElevationData ||
      (pureWalk &&
        routes.some(
          (route) =>
            route.walkPolicy?.profile === "wheelchair" &&
            route.walkPolicy.maxSlopePercent === null,
        ))
    ) {
      slopeMessageCode = "ROUTE_SLOPE_NO_ELEVATION";
      slopeConstraint = {
        requestedMaxPercent,
        enforced: false,
        note: ROUTE_WARNING.SLOPE_LIMIT_NOT_ENFORCED_NO_ELEVATION,
      };
    } else {
      const officialOtp =
        getRoutingConfig().walkPlanner === "otp" ||
        (pureWalk &&
          routes.length > 0 &&
          routes.every(
            (route) => route.engine === "otp-fallback" && !route.walkPolicy,
          ));
      const wheelchairEngaged = officialOtp
        ? mode === "wheelchair"
        : pureWalk
          ? routes.length > 0 &&
            routes.every((route) => route.walkPolicy?.profile === "wheelchair")
          : mode === "wheelchair";
      const softWheelchairSlope = officialOtp && wheelchairEngaged;
      const enforced =
        wheelchairEngaged &&
        !softWheelchairSlope &&
        requestedMaxPercent >= serverMaxPercent;
      slopeMessageCode = softWheelchairSlope
        ? "ROUTE_SLOPE_SOFT_PREFERENCE"
        : wheelchairEngaged
          ? enforced
            ? "ROUTE_SLOPE_SERVER_LIMIT"
            : "ROUTE_SLOPE_SERVER_DEFAULT"
          : "ROUTE_SLOPE_WHEELCHAIR_DISABLED";
      slopeConstraint = {
        requestedMaxPercent,
        enforced,
        note: softWheelchairSlope
          ? ROUTE_WARNING.OTP_SOFT_SLOPE_LIMIT_NOT_ENFORCED
          : wheelchairEngaged
            ? enforced
              ? `伺服器已套用 ${serverMaxPercent}% 上限（等於或寬於您的設定）`
              : ROUTE_WARNING.SLOPE_LIMIT_STRICTER_THAN_SERVER_DEFAULT
            : "此路線未啟用輪椅模式，伺服器未套用輪椅坡度限制",
      };
    }
    const descriptor = routeMessage(slopeMessageCode, slopeConstraint.note, {
      requestedMaxPercent: slopeConstraint.requestedMaxPercent,
      enforced: slopeConstraint.enforced,
      serverMaxPercent,
    });
    for (const r of routes) appendRouteWarning(r, descriptor);
    slopeConstraint.note = presentRouteMessages(
      [descriptor.legacyMessage],
      [descriptor],
      opts.language,
    ).messages[0];
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
      if (
        constraints.avoidStairs &&
        (getRoutingConfig().walkPlanner === "otp"
          ? leg.steps?.some((step) => step.stairs)
          : walkLegHasStairsBarrier(leg))
      )
        return true;
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
 * Apply hard accessibility constraints. Official OTP mode rejects all excluded
 * candidates; the legacy CSR path retains its marked graceful fallback.
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
  if (kept.length || getRoutingConfig().walkPlanner === "otp") return kept;
  if (routes.length) {
    if (
      constraints.avoidStairs &&
      routes.every((route) => routeStairsCount(route) > 0)
    ) {
      const leastStairs = routes.reduce((best, route) =>
        routeStairsCount(route) < routeStairsCount(best) ? route : best,
      );
      leastStairs.degraded = true;
      appendRouteWarning(
        leastStairs,
        routeMessage(
          "ROUTE_STAIRS_CONSTRAINT_UNSATISFIED",
          ROUTE_WARNING.STAIRS_CONSTRAINT_UNSATISFIED,
        ),
      );
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
  const {
    nearbyA11y,
    attachA11yToLeg,
    deriveHighlightMessages,
    enrichLegIndoor,
  } = await import("./planners/route-a11y");

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
        const highlightMessages = deriveHighlightMessages(board, alight);
        route.accessibilityHighlights = highlightMessages.map(
          (item) => item.legacyMessage,
        );
        route._accessibilityHighlightMessages = highlightMessages;
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

/**
 * Attach audible pedestrian signals to WALK legs as `a11yPoints`, so scoring
 * and the accessibility summary see them. Fail-soft: a lookup failure leaves
 * the legs untouched. Exported for focused tests.
 *
 * @param routes The routes to annotate in place.
 */
export async function attachAudioSignals(
  routes: AccessibleRoute[],
): Promise<void> {
  const walkLegs = routes.flatMap((r) =>
    r.legs.filter(
      (l): l is WalkLeg => l.type === "WALK" && l.polyline.length >= 2,
    ),
  );
  const bbox = paddedBbox(walkLegs.map((l) => l.polyline));
  if (!bbox) return;
  try {
    const { findAudioSignalsWithin } =
      await import("../visual-a11y/visual-a11y.service");
    const signals = (await findAudioSignalsWithin(bbox)).map((d) => ({
      source: d.source ?? "osm",
      location: d.location.coordinates,
      name: d.properties?.name,
    }));
    if (!signals.length) return;
    for (const leg of walkLegs) {
      const matched = matchAudioSignals(leg.polyline, signals);
      if (matched.length)
        leg.a11yPoints = [...(leg.a11yPoints ?? []), ...matched];
    }
  } catch (err) {
    console.warn("[accessible-route] audio signal lookup failed", err);
  }
}

const GOVERNMENT_HAZARD_PREFILTER_M = 100;
const PEDESTRIAN_WORK_RE = /人行道|騎樓|行人/;

function roundedEndDate(endTime: string | undefined): string | undefined {
  return endTime ? /^\d{4}-\d{2}-\d{2}/.exec(endTime)?.[0] : undefined;
}

/**
 * Government road events (TDX LiveEvent; Taipei enriched with permit closure
 * flags and work-area points) near the candidates, as hazard inputs. Only
 * road closures and works on the footway (人行道／騎樓／行人) are used: other
 * advisories, such as routine maintenance on the carriageway, say nothing about
 * walking. Fail-soft: any failure yields no government hazards.
 * Exported for focused tests.
 *
 * @param routes The candidate routes.
 * @returns Government hazards whose points lie near some candidate.
 */
export async function loadGovernmentHazards(
  routes: AccessibleRoute[],
): Promise<ConfirmedHazardInput[]> {
  try {
    const area = buildHazardQueryArea(routes);
    if (!area) return [];
    const { getActiveRoadIncidents } =
      await import("../traffic/road-incident.service");
    const { TRAFFIC_ROUTE_HOOK_TIMEOUT_MS } =
      await import("../../config/traffic");
    const dLat = area.radiusM / 111_320;
    const dLng = dLat / Math.cos((area.center.lat * Math.PI) / 180);
    const incidents = await withTimeoutBudget(
      getActiveRoadIncidents({
        bbox: [
          area.center.lng - dLng,
          area.center.lat - dLat,
          area.center.lng + dLng,
          area.center.lat + dLat,
        ],
      }),
      TRAFFIC_ROUTE_HOOK_TIMEOUT_MS,
      "Government hazard fetch timeout",
    );

    const segments = routes.flatMap((r) =>
      r.legs
        .filter(
          (l) =>
            l.type === "WALK" || l.type === "DRIVE" || l.type === "MOTORCYCLE",
        )
        .flatMap((l) =>
          l.polyline.slice(1).map((end, k) => [l.polyline[k], end] as const),
        ),
    );
    const near = (lat: number, lng: number) =>
      segments.some(
        ([a, b]) =>
          pointToSegmentDistanceM([lng, lat], a, b) <=
          GOVERNMENT_HAZARD_PREFILTER_M,
      );

    return incidents
      .filter(
        (i) =>
          i.severity === "closure" ||
          PEDESTRIAN_WORK_RE.test(
            `${i.title} ${i.description ?? ""} ${i.locationDescription ?? ""}`,
          ),
      )
      .filter((i) => (i.points ?? [i.location]).some((p) => near(p.lat, p.lng)))
      .map((i) => {
        const endDate = roundedEndDate(i.endTime);
        const detail = i.locationDescription ?? i.description ?? i.roadName;
        return {
          id: `tdx:${i.incidentId}`,
          hazardType: i.title.includes("施工") ? "construction" : "obstacle",
          severity: "difficult",
          source: "government",
          description: `${i.title}${detail ? `｜${detail}` : ""}${
            endDate ? `（預計至 ${endDate}）` : ""
          }`,
          coordinates: [i.location.lng, i.location.lat],
          ...(i.points
            ? {
                points: i.points.map((p) => [p.lng, p.lat] as [number, number]),
              }
            : {}),
        } satisfies ConfirmedHazardInput;
      });
  } catch (err) {
    console.warn("[accessible-route] government hazard lookup failed", err);
    return [];
  }
}

/**
 * Community hazards plus government closures. An unsafe community lookup stays
 * unknown unless government evidence alone exists.
 *
 * @param community The community hazards, or undefined when unsafe.
 * @param government The government hazards.
 * @returns The combined list, or undefined when nothing is known.
 */
function combineHazards(
  community: ConfirmedHazardInput[] | undefined,
  government: ConfirmedHazardInput[],
): ConfirmedHazardInput[] | undefined {
  if (community === undefined)
    return government.length ? government : undefined;
  return [...community, ...government];
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
 * then apply the pure geometry planner. If a refresh fails, retain previously
 * observed on-route hazards when supplied; otherwise preserve the base order.
 * An unavailable check never manufactures a "clear" or "avoided" claim.
 *
 * Exported for focused failure-path tests; production callers use the default
 * hazard-report lookup.
 */
export async function applyConfirmedHazardPlanning(
  routes: AccessibleRoute[],
  lookup: ConfirmedHazardLookup = defaultConfirmedHazardLookup,
  knownHazards?: ConfirmedHazardInput[],
): Promise<HazardRoutePlan> {
  const hazards = await loadConfirmedHazards(routes, lookup);
  if (hazards !== undefined) return planWithConfirmedHazards(routes, hazards);
  if (knownHazards === undefined) return unappliedHazardPlan(routes);
  // The expanded-area lookup failed. Keep previously observed on-route risks,
  // but do not issue a comparative "avoided" claim for an incomplete check.
  const decorated = routes
    .map((route) => {
      const observed = planWithConfirmedHazards([route], knownHazards)
        .routes[0];
      const descriptor = routeMessage(
        "ROUTE_HAZARD_DATA_UNAVAILABLE",
        ROUTE_WARNING.HAZARD_DATA_UNAVAILABLE,
      );
      const warnings = observed.warnings ?? [];
      return {
        ...observed,
        degraded: true,
        warnings: warnings.includes(descriptor.legacyMessage)
          ? warnings
          : [...warnings, descriptor.legacyMessage],
        _warningMessages: warnings.includes(descriptor.legacyMessage)
          ? observed._warningMessages
          : [...(observed._warningMessages ?? []), descriptor],
      };
    })
    .sort(
      (a, b) =>
        (a.hazardAdvisory?.blockingOnRoute ?? 0) -
        (b.hazardAdvisory?.blockingOnRoute ?? 0),
    );
  return {
    routes: decorated,
    selectionApplied: false,
    allCandidatesAffected: false,
  };
}

async function finalizeRoutes(
  routes: AccessibleRoute[],
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: AccessibilityMode,
  constraints: A11yConstraints,
  format: "standard" | "compact" = "standard",
  envPromise?: Promise<EnvConditions | undefined>,
  transitPreference?: TransitPreference,
  language?: SupportedLang,
  planningNow = Date.now(),
): Promise<AccessibleRoute[]> {
  // All bounded upstream members survive until canonical grouping and chain
  // search. In particular, no route-name collapse or arbitrary pre-rank eight.
  let candidates = routes;
  const [community, government] = await Promise.all([
    loadConfirmedHazards(candidates, defaultConfirmedHazardLookup),
    loadGovernmentHazards(candidates),
  ]);
  const hazards = combineHazards(community, government);
  if (hazards !== undefined)
    candidates = planWithConfirmedHazards(candidates, hazards).routes;
  try {
    await enrichTopRoutes(candidates, origin, destination, mode);
  } catch (err) {
    console.warn("[accessible-route] a11y enrichment failed", err);
  }
  if (mode === "visual_impaired") await attachAudioSignals(candidates);
  let notices = new Set<AccessibleRoute>();
  try {
    const { overlayFacilityStatus } =
      await import("./planners/facility-status");
    notices = await overlayFacilityStatus(candidates, mode);
  } catch (err) {
    console.warn("[accessible-route] facility overlay failed", err);
  }
  try {
    const { overlayRealtimeTransit, recoverRailTrainNos, annotateBusTdxCity } =
      await import("./planners/realtime-transit");
    annotateBusTdxCity(candidates);
    await recoverRailTrainNos(candidates);
    await overlayRealtimeTransit(candidates);
  } catch (err) {
    console.warn("[accessible-route] realtime overlay failed", err);
  }
  const safe = candidates.filter(
    (r) => !isRouteExcluded(r, constraints) && !r.degraded,
  );
  // Hazard and station-level elevator notices remain advisory, not new hard
  // exclusions. Preserve their existing demotion as explicit eligibility tiers.
  for (const route of candidates)
    Object.defineProperty(route, "_advisoryEligibilityTier", {
      value: Number(
        !!route.hazardAdvisory?.blockingOnRoute ||
          (notices.has(route) &&
            (mode === "wheelchair" || constraints.requireElevator)),
      ),
      configurable: true,
    });
  const unsafe = candidates.filter((r) => !safe.includes(r));
  // Keep the legacy graceful fallback, but label every retained member as
  // degraded, and defer activating it until safe candidate chains are tried.
  const fallback = applyA11yExclusion(unsafe, constraints);
  for (const route of fallback) route.degraded = true;
  const realtimeNow = Date.now();
  const budget = createCandidateRequestBudget();
  const memo: PairSearchMemo = new Map();
  let feasible: AccessibleRoute[] = [];
  try {
    for (const tier of [safe, fallback]) {
      const groups = groupRoutesByTransitSkeleton(tier);
      const solved = await Promise.all(
        groups.map((g) =>
          resolveCandidateGroup({
            members: g.members,
            mode,
            planningNow,
            realtimeNow,
            budget,
            memo,
            validateMaterialized: async (base, collections) => {
              const replacements = [...collections].flatMap(
                ([index, collection]) =>
                  [...collection.materialized].map(([id, leg]) => {
                    const legs = base.legs.slice();
                    legs[index] = leg;
                    return {
                      collection,
                      id,
                      route: copyWithDescriptors(base, { legs }),
                    };
                  }),
              );
              await enrichTopRoutes(
                replacements.map((v) => v.route),
                origin,
                destination,
                mode,
              ).catch((err) =>
                console.warn(
                  "[accessible-route] candidate a11y enrichment failed",
                  err,
                ),
              );
              if (hazards !== undefined)
                planWithConfirmedHazards(
                  replacements.map((v) => v.route),
                  hazards,
                );
              for (const { collection, id, route } of replacements) {
                if (
                  (isRouteExcluded(route, constraints) && !base.degraded) ||
                  (route.hazardAdvisory?.blockingOnRoute ?? 0) >
                    (base.hazardAdvisory?.blockingOnRoute ?? 0)
                ) {
                  collection.materialized.delete(id);
                  collection.candidates = collection.candidates.filter(
                    (c) => c.candidateId !== id,
                  );
                }
              }
            },
          }),
        ),
      );
      feasible = solved.flat();
      if (feasible.length) break;
    }
  } finally {
    budget.close();
  }
  let env: EnvConditions | undefined;
  try {
    env = envPromise
      ? await envPromise
      : await getWeatherAndAirQuality(destination.lat, destination.lng);
  } catch {
    env = undefined;
  }
  const scored = scoreAndRank(feasible, mode, env, transitPreference, language);
  const ordered = groupRoutesByTransitSkeleton(
    scored.sort(compareRoutesByArrival),
  ).map((group) => group.members[0]);
  const top = ordered.slice(0, 3);
  const isWalkOnly = (route: AccessibleRoute) =>
    route.legs.every((leg) => leg.type === "WALK");
  const walk = ordered.find(isWalkOnly);
  if (
    walk &&
    top.length === 3 &&
    !top.some(isWalkOnly) &&
    compareRouteEligibility(walk, top[2]) === 0
  ) {
    top[2] = walk;
  }
  // Preserve safety tiers and the selected order through response projection.
  attachWalkA11yDetails(top);
  slimRoutes(top);
  slimRouteGeometry(top);
  if (format === "compact") compactRoutes(top);
  return top;
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
      const matched: MetroAlert[] = result.alerts.filter((alert) => {
        const hasSpecificStations = alert.stations && alert.stations.length > 0;
        if (hasSpecificStations) {
          return alert.stations.some((station) =>
            stationIds.has(normalizeStationId(station.id)),
          );
        }
        return alert.lines.some((line) =>
          lineIds.has(normalizeStationId(line)),
        );
      });
      const uniqueMetroAlerts = Array.from(
        new Map(matched.map((a) => [a.alertId, a])).values(),
      );
      if (uniqueMetroAlerts.length) {
        leg.alerts = uniqueMetroAlerts;
        for (const a of uniqueMetroAlerts) {
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
        const stopUids = [
          leg.departureStopId,
          leg.arrivalStopId,
          ...(leg.intermediateStops ?? []).map((s) => s.stationUid),
        ].filter((id): id is string => Boolean(id));

        const stopNames = [
          leg.departureStop,
          leg.arrivalStop,
          ...(leg.intermediateStops ?? []).map((s) => s.name),
        ].filter((name): name is string => Boolean(name));

        const res = await getTransitAlerts({
          mode: "bus",
          city,
          routeName: leg.routeName,
          direction: leg.direction,
          stopUid: leg.departureStopId,
          stopName: leg.departureStop,
          stopUids,
          stopNames,
        });
        if (res.ok && res.alerts.length > 0) {
          const uniqueLegAlerts = Array.from(
            new Map(res.alerts.map((a) => [a.alertId, a])).values(),
          );
          leg.alerts = uniqueLegAlerts;
          for (const a of uniqueLegAlerts)
            allTransitAlertsMap.set(a.alertId, a);
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
          const uniqueLegAlerts = Array.from(
            new Map(res.alerts.map((a) => [a.alertId, a])).values(),
          );
          leg.alerts = uniqueLegAlerts;
          for (const a of uniqueLegAlerts)
            allTransitAlertsMap.set(a.alertId, a);
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
          const uniqueLegAlerts = Array.from(
            new Map(res.alerts.map((a) => [a.alertId, a])).values(),
          );
          leg.alerts = uniqueLegAlerts;
          for (const a of uniqueLegAlerts)
            allTransitAlertsMap.set(a.alertId, a);
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

/**
 * Move a transit endpoint onto the nearest outdoor, step-free walkway when the
 * in-memory Taipei pedestrian graph is loaded. OTP links a raw coordinate to
 * its nearest walkable edge on any level, so a point in the middle of a
 * no-walking road above an underground concourse links into the concourse;
 * wheelchair searches from there ran for over a minute and returned nothing.
 *
 * @param point The requested endpoint.
 * @returns The street-level point, or the original when none is in range or
 *   the graph is not loaded yet.
 */
function anchorToStreetLevel(point: LatLng): LatLng {
  if (!isWithinPedGraphCoverage(point)) return point;
  const snapshot = peekPedGraphSnapshot();
  if (!snapshot) return point;
  const anchor = nearestOutdoorPoint(
    snapshot.index,
    point.lat,
    point.lng,
    STREET_ANCHOR_TOLERANCE_M,
  );
  return anchor ? { lat: anchor.lat, lng: anchor.lng } : point;
}

/**
 * Wait for a promise up to a time budget without cancelling it.
 *
 * @param work The promise to wait on; a later rejection is swallowed.
 * @param budgetMs Maximum wait in milliseconds.
 * @returns The settled value, or undefined when the budget elapsed first.
 */
async function settleWithin<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<T | undefined> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type WalkPlanOutcome =
  | {
      ok: true;
      routes: AccessibleRoute[];
      trafficMs: number;
      routedByEngineWithNoElevationData: boolean;
    }
  | { ok: false; failure: Extract<PlanRouteResult, { ok: false }> };

/**
 * Plan pure walking with the configured engine. The legacy CSR path retains
 * its policy-aware OTP fallback; official OTP mode uses OTP directly.
 *
 * @param walkPoints Origin, waypoints and destination in order.
 * @param roadMode Accessibility mode driving walk speed and scoring.
 * @param avoidStairs Resolved step-free constraint sent to the engines.
 * @param departureTime Optional future departure forwarded to Valhalla.
 * @returns Finalized walk routes, or the failure envelope to return.
 */
async function planWalkRoutes(
  walkPoints: LatLng[],
  roadMode: AccessibilityMode,
  avoidStairs: boolean,
  departureTime?: Date,
  walkingCandidates = false,
): Promise<WalkPlanOutcome> {
  const dest = walkPoints[walkPoints.length - 1];

  if (walkingCandidates) {
    const deadline = Date.now() + getRoutingConfig().planBudgetMs;
    const otp = await planOtpWalkSegments(
      walkPoints,
      roadMode,
      false,
      deadline,
      true,
    );
    const candidates = otp.routes.map((route) => ({
      ...route,
      routeId: `otp-${route.routeId}`,
    }));
    let unavailable = otp.status === "unavailable";
    if (Date.now() < deadline) {
      try {
        const { planValhallaRoute } =
          await import("./planners/valhalla-routing");
        const alternatives = await planValhallaRoute(walkPoints[0], dest, {
          travelMode: "walk",
          mode: roadMode,
          walkingCandidates: true,
          deadline,
        });
        candidates.push(
          ...alternatives.map((route) => ({
            ...route,
            routeId: `valhalla-${route.routeId}`,
          })),
        );
      } catch (error) {
        unavailable = true;
        console.warn(
          "[accessible-route] optional walking candidates unavailable",
          error,
        );
      }
    }
    if (!candidates.length)
      return {
        ok: false,
        failure: routeFailure(
          unavailable || Date.now() >= deadline
            ? ROUTE_REASON.UPSTREAM_TIMEOUT
            : ROUTE_REASON.NO_ROUTE,
        ),
      };
    const routes = await finalizeDrivingRoutes(
      candidates,
      "walk",
      dest,
      false,
      undefined,
      avoidStairs,
    );
    return {
      ok: true,
      routes,
      trafficMs: 0,
      routedByEngineWithNoElevationData: routes.some((route) =>
        route.routeId.startsWith("valhalla-"),
      ),
    };
  }

  const useCsr = getRoutingConfig().walkPlanner === "csr";
  let csrFallbackIsDegraded = false;
  if (useCsr) {
    const csrWalk = await planCsrWalkForRequest(
      walkPoints,
      roadMode,
      avoidStairs,
      undefined,
      true,
    );
    logCsrWalkOutcome(csrWalk, walkPoints.length - 1, roadMode);
    if (csrWalk.status === "ok") {
      const candidates = [csrWalk.plans, ...(csrWalk.alternatives ?? [])].map(
        (plans, index) => ({
          ...buildCsrWalkRoute(plans),
          routeId: `csr-walk-${index}`,
        }),
      );
      let knownHazards: ConfirmedHazardInput[] | undefined;
      // Generate an alternative before hazard ranking; never mutate the shared
      // graph or assert that a point observation proves a physical road closure.
      // Current reports cannot establish conditions for a future departure.
      if (!departureTime || departureTime.getTime() <= Date.now()) {
        knownHazards = await loadConfirmedHazards(
          candidates,
          defaultConfirmedHazardLookup,
        );
        const blocking = knownHazards?.filter(
          (hazard) =>
            hazard.severity === "blocking" &&
            (!hazard.source || hazard.source === "community"),
        );
        if (blocking?.length) {
          const alternative = await planCsrWalkForRequest(
            walkPoints,
            roadMode,
            avoidStairs,
            blocking.map((hazard) => hazard.coordinates),
          );
          if (alternative.status === "ok")
            candidates.push({
              ...buildCsrWalkRoute(alternative.plans),
              routeId: `csr-walk-${candidates.length}`,
            });
        }
      }
      return {
        ok: true,
        routes: await finalizeDrivingRoutes(
          candidates,
          "walk",
          dest,
          false,
          knownHazards,
        ),
        trafficMs: 0,
        routedByEngineWithNoElevationData: false,
      };
    }

    if (csrWalk.status === "fare_policy_blocked") {
      return { ok: false, failure: routeFailure(ROUTE_REASON.NO_ROUTE) };
    }
    if (csrWalk.status === "accessibility_blocked") {
      return {
        ok: false,
        failure: routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE),
      };
    }
    csrFallbackIsDegraded = csrWalk.status !== "outside_coverage";
  }
  const markFallback = (routes: AccessibleRoute[]) =>
    useCsr
      ? routes.map((route) => ({
          ...route,
          engine: "otp-fallback" as const,
          ...(csrFallbackIsDegraded ? { degraded: true } : {}),
        }))
      : routes;

  const otpWalk = await planOtpWalkSegments(walkPoints, roadMode, avoidStairs);
  if (otpWalk.status === "no_route") {
    if (avoidStairs) {
      const relaxed = await planOtpWalkSegments(walkPoints, roadMode, false);
      if (relaxed.status === "unavailable") {
        return {
          ok: false,
          failure: routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT),
        };
      }
      if (relaxed.status === "ok" && relaxed.routes.length) {
        return {
          ok: false,
          failure: routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE),
        };
      }
    }
    return { ok: false, failure: routeFailure(ROUTE_REASON.NO_ROUTE) };
  }
  if (otpWalk.status === "ok") {
    const constraints = resolveA11yConstraints(roadMode, { avoidStairs });
    const eligible = otpWalk.routes.filter(
      (route) => !isRouteExcluded(route, constraints),
    );
    const routes = await finalizeDrivingRoutes(
      eligible,
      "walk",
      dest,
      false,
      otpWalk.knownHazards,
    );
    if (!routes.length)
      return {
        ok: false,
        failure: routeFailure(ROUTE_REASON.NO_ACCESSIBLE_ROUTE),
      };
    return {
      ok: true,
      routes: markFallback(routes),
      trafficMs: 0,
      routedByEngineWithNoElevationData: false,
    };
  }

  return { ok: false, failure: routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT) };
}

/**
 * Whether every route is walk-only, i.e. a transit request was answered by
 * walking.
 *
 * @param routes Routes returned for a transit request.
 * @returns True when at least one route exists and none rides transit.
 */
function isWalkOnlyAnswer(routes: AccessibleRoute[]): boolean {
  return (
    routes.length > 0 &&
    routes.every((route) => route.legs.every((leg) => leg.type === "WALK"))
  );
}

/** Replace whole-walk candidates in CSR mode before the transit finalizer. */
async function refineWalkOptionWithCsr(
  routes: AccessibleRoute[],
  walkPoints: LatLng[],
  mode: AccessibilityMode,
  avoidStairs: boolean,
  deadline?: number,
): Promise<Extract<PlanRouteResult, { ok: false }> | undefined> {
  if (getRoutingConfig().walkPlanner === "otp") return;
  const index = routes.findIndex((r) => r.legs.every((l) => l.type === "WALK"));
  if (index === -1) return;
  const csr = await planCsrWalkForRequest(walkPoints, mode, avoidStairs);
  logCsrWalkOutcome(csr, walkPoints.length - 1, mode);
  const others = routes.filter(
    (route) => !route.legs.every((leg) => leg.type === "WALK"),
  );
  if (
    csr.status === "fare_policy_blocked" ||
    csr.status === "accessibility_blocked"
  ) {
    routes.splice(0, routes.length, ...others);
    return others.length
      ? undefined
      : routeFailure(
          csr.status === "fare_policy_blocked"
            ? ROUTE_REASON.NO_ROUTE
            : ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
        );
  }
  let walkRoutes: AccessibleRoute[];
  let knownHazards: ConfirmedHazardInput[] | undefined;
  if (csr.status === "ok") {
    walkRoutes = [buildCsrWalkRoute(csr.plans)];
  } else {
    const existingWalks = routes.filter((route) =>
      route.legs.every((leg) => leg.type === "WALK"),
    );
    if (
      existingWalks.every(
        (route) =>
          route.walkPolicy?.version === WALK_POLICY_VERSION &&
          route.walkPolicy.profile ===
            (mode === "wheelchair" ? "wheelchair" : "normal") &&
          route.walkPolicy.avoidStairs === avoidStairs,
      )
    )
      return;
    const planned = await planOtpWalkSegments(
      walkPoints,
      mode,
      avoidStairs,
      deadline,
    );
    if (planned.status !== "ok") {
      routes.splice(0, routes.length, ...others);
      return others.length
        ? undefined
        : routeFailure(
            planned.status === "unavailable"
              ? ROUTE_REASON.UPSTREAM_TIMEOUT
              : ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
          );
    }
    knownHazards = planned.knownHazards;
    walkRoutes = planned.routes.map((route) => ({
      ...route,
      engine: "otp-fallback" as const,
      ...(csr.status !== "outside_coverage" ? { degraded: true } : {}),
    }));
  }
  const [refined] = await finalizeDrivingRoutes(
    walkRoutes,
    "walk",
    walkPoints[walkPoints.length - 1],
    false,
    knownHazards,
  );
  routes.splice(0, routes.length, ...others, ...(refined ? [refined] : []));
}

/**
 * The venue (indoor) routing mode for a trip: a hard step-free requirement
 * uses the strict wheelchair rules indoors whatever the accessibility mode.
 *
 * @param mode Resolved accessibility mode, if any.
 * @param avoidStairs Explicit or profile-derived step-free requirement.
 * @returns The mode the venue leg is planned with.
 */
export function venueModeFor(
  mode: AccessibilityMode | undefined,
  avoidStairs: boolean | undefined,
): AccessibilityMode {
  return avoidStairs === true ? "wheelchair" : (mode ?? "normal");
}

/**
 * Resolve a park destination to an accessible entrance. Advisory: a failed
 * lookup, or one exceeding {@link PARK_ARRIVAL_BUDGET_MS}, keeps the
 * destination the caller asked for.
 *
 * @param input Destination, origin and the user's limits.
 * @returns The park arrival, or null when not a park or the lookup failed.
 */
async function lookupParkArrival(
  input: ParkArrivalInput,
): Promise<ParkArrival | null> {
  try {
    const { findParkArrivalCandidates, findEntrancesOfParks } =
      await import("../a11y/a11y.service");
    const arrival = await settleWithin(
      resolveParkArrival(input, {
        findCandidates: (point, radiusM) =>
          findParkArrivalCandidates(point.lat, point.lng, radiusM),
        findEntrancesOfParks,
      }),
      PARK_ARRIVAL_BUDGET_MS,
    );
    if (arrival === undefined) {
      console.warn(
        "[accessible-route] park entrance lookup exceeded its budget; using requested destination",
        JSON.stringify({ budgetMs: PARK_ARRIVAL_BUDGET_MS }),
      );
      return null;
    }
    return arrival;
  } catch (err) {
    console.warn(
      "[accessible-route] park entrance lookup failed; using requested destination",
      err,
    );
    return null;
  }
}

/**
 * Tell the user where a park route ends: the entrance it was led to, or that
 * none of the park's entrances meets their limits.
 *
 * @param routes Planned routes, annotated in place.
 * @param parkArrival The park resolution, if the destination is a park.
 */
function annotateParkArrival(
  routes: AccessibleRoute[],
  parkArrival: ParkArrival | null,
): void {
  if (!parkArrival) return;
  for (const route of routes) {
    if (parkArrival.kind === "entrance") {
      const entrance = parkArrival.entrance;
      const legacyMessage = arrivalEntranceHighlight(entrance);
      appendRouteHighlight(
        route,
        routeMessage("ROUTE_PARK_ENTRANCE_SELECTED", legacyMessage, {
          parkName: entrance.parkName,
          entranceName: entrance.entranceName,
          ...(entrance.minClearWidthM === null
            ? {}
            : { widthM: entrance.minClearWidthM }),
          ...(entrance.slopePercent === null
            ? {}
            : { slopePercent: entrance.slopePercent }),
        }),
      );
    } else {
      appendRouteWarning(
        route,
        routeMessage(
          "ROUTE_PARK_NO_QUALIFYING_ENTRANCE",
          ROUTE_WARNING.PARK_NO_QUALIFYING_ENTRANCE,
        ),
      );
    }
  }
}

export async function planAccessibleRouteFromRequest(
  body: PlanRouteRequest,
): Promise<PlanRouteResult> {
  const planningNow = Date.now();
  let { origin, destination } = body;
  const { query, userLocation, maxTransfers, departureTime, format } = body;
  const travelMode = body.travelMode ?? "transit";
  const rawWaypoints = body.waypoints ?? [];
  let mode = body.mode;
  let transitPreference = body.transitPreference;
  let requireElevator = body.requireElevator;
  let avoidStairs = body.avoidStairs;
  let needsAccessibleToilet = body.needsAccessibleToilet;
  let needsHandrail = body.needsHandrail;
  let maxSlopePercent = body.maxSlopePercent;

  let intent: RouteIntent | null = null;
  if (
    query &&
    (!origin ||
      !destination ||
      (travelMode === "transit" && transitPreference === undefined))
  ) {
    try {
      intent = await parseRouteIntent(query);
    } catch (err) {
      console.error("[accessible-route] intent parsing failed", err);
      return {
        ok: false,
        status: ResponseCode.INTERNAL_ERROR,
        error:
          localizeRouteReason("ROUTE_INTENT_UNAVAILABLE", body.language) ??
          "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination",
        data: { reason: "ROUTE_INTENT_UNAVAILABLE" },
      };
    }
    if (!intent) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error:
          localizeRouteReason("INTENT_PARSE_FAILED", body.language) ??
          ERROR_MESSAGE.INTENT_PARSE_FAILED,
        data: { reason: "INTENT_PARSE_FAILED" },
      };
    }
    origin =
      origin ??
      (intent.from === "current_location"
        ? (userLocation ?? undefined)
        : intent.from);
    destination = destination ?? intent.to;
    mode = mode ?? intent.mode;
    transitPreference =
      transitPreference ?? intent.preferences?.transitPreference;
    requireElevator = requireElevator ?? intent.preferences?.preferElevator;
    if (!origin) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error:
          localizeRouteReason("CURRENT_LOCATION_REQUIRED", body.language) ??
          "查詢使用了『目前位置』，請一併提供 userLocation 座標",
        data: { reason: "CURRENT_LOCATION_REQUIRED" },
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
      if (mode === undefined) mode = accessibilityModeFromProfile(profile);
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

  // A venue destination is resolved to one fixed gate before routing; the
  // outdoor route ends there and the indoor leg continues from it.
  let venueArrival: VenueArrival | undefined;
  let venueLeg: VenueRoute | undefined;
  const venueLang = body.language ?? DEFAULT_LANG;
  if (body.destinationVenuePlace && origin) {
    const originPoint =
      typeof origin === "string"
        ? await getCoordinates(origin)
        : (origin as { latitude: number; longitude: number });
    if (!originPoint) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error:
          localizeRouteReason("COORDINATE_LOOKUP_FAILED", body.language) ??
          "無法解析出發地或目的地座標",
        data: { reason: "COORDINATE_LOOKUP_FAILED" },
      };
    }
    const resolved = await venueArrivalPlanner().resolveVenueArrival({
      venueId: body.destinationVenuePlace.venueId,
      placeId: body.destinationVenuePlace.placeId,
      origin: { lat: originPoint.latitude, lng: originPoint.longitude },
      mode: venueModeFor(mode, avoidStairs),
      lang: venueLang,
    });
    if (!resolved.ok) {
      // This endpoint never answers 404 (engine outcomes are 422): an unknown
      // venue or place is invalid input, like an unresolvable address.
      if (resolved.status === ResponseCode.NOT_FOUND) {
        return {
          ok: false,
          status: ResponseCode.INVALID_INPUT,
          error:
            localizeRouteReason("VENUE_PLACE_NOT_FOUND", body.language) ??
            resolved.error,
          data: { reason: "VENUE_PLACE_NOT_FOUND" },
        };
      }
      return resolved;
    }
    venueArrival = resolved.venueArrival;
    venueLeg = resolved.venueLeg;
    origin = originPoint;
    destination = {
      latitude: venueArrival.gateLocation.lat,
      longitude: venueArrival.gateLocation.lng,
    };
  } else if (body.venueArrival) {
    // Reroute of a venue trip: the destination is already the stored gate.
    const replanned = await venueArrivalPlanner().replanVenueLeg(
      body.venueArrival,
      venueLang,
    );
    if (!replanned.ok) {
      return "stale" in replanned
        ? {
            ok: false,
            status: ResponseCode.GONE,
            error:
              venueLang === "en"
                ? REROUTE_MSG_EN.VENUE_UPDATED
                : REROUTE_MSG.VENUE_UPDATED,
            data: { reason: "ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED" },
          }
        : replanned;
    }
    venueArrival = replanned.venueArrival;
    venueLeg = replanned.venueLeg;
  }

  // A trip leaving a venue starts outdoors at one chosen gate; the indoor
  // leg from the place to that gate travels alongside the routes.
  let venueDeparture: VenueArrival | undefined;
  let venueDepartureLeg: VenueRoute | undefined;
  if (body.originVenuePlace && destination) {
    const destinationPoint =
      typeof destination === "string"
        ? await getCoordinates(destination)
        : (destination as { latitude: number; longitude: number });
    if (!destinationPoint) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error:
          localizeRouteReason("COORDINATE_LOOKUP_FAILED", body.language) ??
          "無法解析出發地或目的地座標",
        data: { reason: "COORDINATE_LOOKUP_FAILED" },
      };
    }
    const resolved = await venueArrivalPlanner().resolveVenueDeparture({
      venueId: body.originVenuePlace.venueId,
      placeId: body.originVenuePlace.placeId,
      destination: {
        lat: destinationPoint.latitude,
        lng: destinationPoint.longitude,
      },
      mode: venueModeFor(mode, avoidStairs),
      lang: venueLang,
    });
    if (!resolved.ok) {
      if (resolved.status === ResponseCode.NOT_FOUND) {
        return {
          ok: false,
          status: ResponseCode.INVALID_INPUT,
          error:
            localizeRouteReason("VENUE_PLACE_NOT_FOUND", body.language) ??
            resolved.error,
          data: { reason: "VENUE_PLACE_NOT_FOUND" },
        };
      }
      return resolved;
    }
    venueDeparture = resolved.venueDeparture;
    venueDepartureLeg = resolved.venueDepartureLeg;
    origin = {
      latitude: venueDeparture.gateLocation.lat,
      longitude: venueDeparture.gateLocation.lng,
    };
    destination = destinationPoint;
  }

  if (!origin || !destination) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error:
        localizeRouteReason("ROUTE_PARAMETERS_REQUIRED", body.language) ??
        `${ERROR_MESSAGE.MISSING_PARAMS}：origin, destination`,
      data: { reason: "ROUTE_PARAMETERS_REQUIRED" },
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
      error:
        localizeRouteReason("COORDINATE_LOOKUP_FAILED", body.language) ??
        "無法解析出發地或目的地座標",
      data: { reason: "COORDINATE_LOOKUP_FAILED" },
    };
  }
  if (waypointCoords.some((w) => !w)) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error:
        localizeRouteReason("WAYPOINT_LOOKUP_FAILED", body.language) ??
        "無法解析中途點座標",
      data: { reason: "WAYPOINT_LOOKUP_FAILED" },
    };
  }
  const waypoints: LatLng[] = waypointCoords.flatMap((w) =>
    w ? [{ lat: w.latitude, lng: w.longitude }] : [],
  );

  const lat = originCoords.latitude;
  const lng = originCoords.longitude;
  const originLatLng: LatLng = { lat, lng };
  const requestedDest: LatLng = {
    lat: destCoords.latitude,
    lng: destCoords.longitude,
  };
  const parkArrival =
    body.keepExactDestination || venueArrival
      ? null
      : await lookupParkArrival({
          ...(typeof destination === "string"
            ? { destinationText: destination }
            : {}),
          requested: requestedDest,
          origin: originLatLng,
          mode: mode ?? "normal",
          ...(maxSlopePercent === undefined ? {} : { maxSlopePercent }),
        });
  const arrivalEntrance =
    parkArrival?.kind === "entrance" ? parkArrival.entrance : undefined;
  const dest: LatLng = arrivalEntrance?.location ?? requestedDest;

  const preflight = preflightAccessibleRoute(
    [originLatLng, ...waypoints, dest],
    getServiceCoverageConfig(),
    body.language,
  );
  if (!preflight.ok) return preflight;

  const tCity = Date.now();
  const city = await resolveCity(lat, lng);
  const cityMs = Date.now() - tCity;

  // Offset-free ISO datetimes and bare "HH:mm" from AI tools are Taipei
  // wall-clock times; a bare clock already past today means tomorrow.
  // Preserve explicit offsets; never let the host timezone choose the instant.
  const normalizedDeparture =
    departureTime &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(departureTime)
      ? `${departureTime}+08:00`
      : departureTime;
  const parsedDeparture = !normalizedDeparture
    ? undefined
    : (nextTaipeiClock(normalizedDeparture) ?? new Date(normalizedDeparture));
  const futureDeparture =
    parsedDeparture &&
    !isNaN(parsedDeparture.getTime()) &&
    parsedDeparture.getTime() > Date.now()
      ? parsedDeparture
      : undefined;

  const waypointsOpt = waypoints.length ? waypoints : undefined;

  const tPlan = Date.now();
  let trafficHookMs = 0;
  let routes: AccessibleRoute[];
  // Set when a nominal "walk" request actually got routed via Valhalla (no
  // elevation data) instead of OTP, so slopeConstraint reporting isn't fooled
  // by the request's travelMode into claiming the OTP 8.3% default applied.
  let routedByEngineWithNoElevationData = false;
  let transitFallback: TransitFallback | undefined;
  const walkPoints = [originLatLng, ...waypoints, dest];
  const walkingCandidates =
    travelMode === "walk" &&
    getRoutingConfig().walkPlanner === "otp" &&
    waypoints.length === 0 &&
    !body.keepExactDestination &&
    !venueArrival &&
    !venueDeparture &&
    !arrivalEntrance;
  const logRequestTiming = () => {
    const planTotal = Date.now() - tPlan;
    console.log(
      "[route-timing] request",
      JSON.stringify({
        geocode: geocodeMs,
        city: cityMs,
        "plan.total": planTotal,
        "plan.routing": Math.max(planTotal - trafficHookMs, 0),
        "plan.traffic.total": trafficHookMs,
      }),
    );
  };

  if (travelMode === "transit") {
    const transitMode = mode ?? "normal";
    const constraints = resolveA11yConstraints(transitMode, {
      avoidStairs,
      requireElevator,
    });
    // Every OTP stage of this request, including the diagnostic retry below,
    // shares one budget instead of each getting a fresh client timeout.
    const deadline = Date.now() + getRoutingConfig().planBudgetMs;
    const transitOptions: FindAccessibleRoutesOptions = {
      language: body.language,
      mode: transitMode,
      transitPreference,
      maxTransfers: (maxTransfers ?? 2) as 0 | 1 | 2,
      departureTime: futureDeparture,
      format: format === "compact" ? "compact" : "standard",
      waypoints: waypointsOpt,
      avoidStairs: constraints.avoidStairs,
      requireElevator: constraints.requireElevator,
      deadline,
    };
    const transit = await findAccessibleRoutesDetailed(
      originLatLng,
      dest,
      city,
      transitOptions,
    );
    if (transit.status === "unavailable") {
      logRequestTiming();
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, body.language);
    }
    if (transit.status === "no_route") {
      if (transit.reason === ROUTE_REASON.NO_ACCESSIBLE_ROUTE) {
        logRequestTiming();
        return routeFailure(
          ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
          {},
          body.language,
        );
      }
      // The relaxed search only tells NO_ACCESSIBLE_ROUTE from NO_ROUTE; its
      // routes are never shown, so it is skipped once the budget is spent.
      if (constraints.avoidStairs && Date.now() < deadline) {
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
          return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, body.language);
        }
        if (relaxed.status === "ok" && relaxed.routes.length) {
          return routeFailure(
            ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
            {},
            body.language,
          );
        }
        return routeFailure(ROUTE_REASON.NO_ROUTE, {}, body.language);
      }
      logRequestTiming();
      return routeFailure(ROUTE_REASON.NO_ROUTE, {}, body.language);
    }
    routes = transit.routes;
    if (isWalkOnlyAnswer(routes)) {
      transitFallback = {
        travelMode: "walk",
        reason:
          transit.status === "ok" && transit.walkingBetter
            ? TRANSIT_FALLBACK_REASON.WALKING_BETTER
            : TRANSIT_FALLBACK_REASON.NO_TRANSIT_ROUTE,
      };
    }
    logRequestTiming();
  } else if (travelMode === "walk") {
    const roadMode = mode ?? "normal";
    const constraints = resolveA11yConstraints(roadMode, { avoidStairs });
    const walk = await planWalkRoutes(
      walkPoints,
      roadMode,
      constraints.avoidStairs,
      futureDeparture,
      walkingCandidates,
    );
    logRequestTiming();
    if (!walk.ok) return walk.failure;
    routes = walk.routes;
    trafficHookMs += walk.trafficMs;
    routedByEngineWithNoElevationData = walk.routedByEngineWithNoElevationData;
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
          lat: p.location.coordinates[1],
          lng: p.location.coordinates[0],
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
    if (outcome.kind === "ok") {
      trafficHookMs += outcome.trafficMs ?? 0;
    }
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
      if (outcome.kind === "ok") {
        trafficHookMs += outcome.trafficMs ?? 0;
      }
    }
    logRequestTiming();
    if (outcome.kind === "unavailable") {
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, body.language);
    }
    if (outcome.kind === "error") {
      return {
        ok: false,
        status: ResponseCode.INTERNAL_ERROR,
        error:
          localizeRouteReason("ROUTE_PLANNING_FAILED", body.language) ??
          "路線規劃失敗，請稍後再試",
        data: { reason: "ROUTE_PLANNING_FAILED" },
      };
    }
    if (outcome.kind === "empty") {
      return routeFailure(ROUTE_REASON.NO_ROUTE, {}, body.language);
    }
    routes = outcome.routes;
  }

  annotateParkArrival(routes, parkArrival);

  const { slopeConstraint } = await applyExtraA11yAnnotations(
    routes,
    dest,
    transitFallback ? transitFallback.travelMode : travelMode,
    mode,
    {
      needsAccessibleToilet,
      needsHandrail,
      maxSlopePercent,
      routedByEngineWithNoElevationData,
      language: body.language,
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

  // All successful road/walk routes share the resolved request instant. Transit
  // chains already carry their own authoritative origin/destination instants.
  for (const route of routes) {
    if (!route.departureTime || !route.arrivalTime) {
      const start =
        futureDeparture?.getTime() ??
        route._scheduledDepartureTime ??
        planningNow;
      route.departureTime = taipeiIsoOffset(start);
      route.arrivalTime = taipeiIsoOffset(start + route.totalMinutes * 60000);
    }
  }
  await attachWalkElevationProfiles(routes, travelMode);
  const displayRoutes = await enrichRouteDisplayNames(routes, body.language);
  const normalizedRoutes = displayRoutes.map((route) => {
    const normalized = normalizeWalkSteps(route, body.language);
    const warnings = normalized._warningMessages
      ? presentRouteMessages(
          normalized.warnings,
          normalized._warningMessages,
          body.language,
        )
      : localizeRouteDetails(
          normalized.warnings,
          normalized.warningDetails,
          body.language,
        );
    const scoreWarnings = normalized._scoreWarningMessages
      ? presentRouteMessages(
          normalized.scoreWarnings,
          normalized._scoreWarningMessages,
          body.language,
        )
      : localizeRouteDetails(
          normalized.scoreWarnings,
          normalized.scoreWarningDetails,
          body.language,
        );
    const highlights = normalized._accessibilityHighlightMessages
      ? presentRouteMessages(
          normalized.accessibilityHighlights,
          normalized._accessibilityHighlightMessages,
          body.language,
        )
      : localizeRouteDetails(
          normalized.accessibilityHighlights,
          normalized.accessibilityHighlightDetails,
          body.language,
        );
    const presented = {
      ...normalized,
      ...(warnings.messages.length ? { warnings: warnings.messages } : {}),
      ...(warnings.details ? { warningDetails: warnings.details } : {}),
      ...(scoreWarnings.messages.length
        ? { scoreWarnings: scoreWarnings.messages }
        : {}),
      ...(scoreWarnings.details
        ? { scoreWarningDetails: scoreWarnings.details }
        : {}),
      accessibilityHighlights: highlights.messages,
      ...(highlights.details
        ? { accessibilityHighlightDetails: highlights.details }
        : {}),
      _warningMessages: undefined,
      _scoreWarningMessages: undefined,
      _accessibilityHighlightMessages: undefined,
    };
    return Object.defineProperties(
      presented,
      Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(normalized)).filter(
          ([, descriptor]) => !descriptor.enumerable,
        ),
      ),
    ) as AccessibleRoute;
  });

  const effectiveMode = mode ?? "normal";
  const effectiveConstraints = resolveA11yConstraints(effectiveMode, {
    avoidStairs,
    requireElevator,
  });
  const canonicalRequest: CanonicalPlanRouteRequest = {
    ...(walkingCandidates ? { walkStairsPreference: walkingCandidates } : {}),
    origin: {
      latitude: originLatLng.lat,
      longitude: originLatLng.lng,
    },
    destination: { latitude: dest.lat, longitude: dest.lng },
    userLocation: {
      latitude: originLatLng.lat,
      longitude: originLatLng.lng,
    },
    travelMode,
    mode: effectiveMode,
    ...(body.language ? { language: body.language } : {}),
    transitPreference: transitPreference ?? "none",
    maxTransfers: maxTransfers ?? 2,
    format: format === "compact" ? "compact" : "standard",
    waypoints: waypoints.map((waypoint) => ({
      latitude: waypoint.lat,
      longitude: waypoint.lng,
    })),
    avoidStairs: effectiveConstraints.avoidStairs,
    requireElevator: effectiveConstraints.requireElevator,
    needsAccessibleToilet: needsAccessibleToilet ?? false,
    needsHandrail: needsHandrail ?? false,
    ...(maxSlopePercent === undefined ? {} : { maxSlopePercent }),
    ...(body.keepExactDestination ? { keepExactDestination: true } : {}),
    ...(venueArrival ? { venueArrival, keepExactDestination: true } : {}),
    ...(futureDeparture
      ? { departureTime: futureDeparture.toISOString() }
      : {}),
  };
  await annotateSidewalkSegments(normalizedRoutes);
  const data = {
    origin: originLatLng,
    destination: dest,
    city,
    travelMode,
    ...(travelMode === "transit"
      ? { transitPreference: transitPreference ?? "none" }
      : {}),
    ...(waypoints.length ? { waypoints } : {}),
    ...(arrivalEntrance ? { arrivalEntrance } : {}),
    ...(venueArrival ? { venueArrival, venueLeg } : {}),
    ...(venueDeparture ? { venueDeparture, venueDepartureLeg } : {}),
    routes: normalizedRoutes,
    ...(intent ? { intent } : {}),
    ...(slopeConstraint ? { slopeConstraint } : {}),
    ...(transitFallback ? { fallback: transitFallback } : {}),
    ...(metroAlerts.length ? { metroAlerts } : {}),
    ...(transitAlerts.length ? { transitAlerts } : {}),
  };
  Object.defineProperty(data, "_canonicalRequest", {
    value: canonicalRequest,
    enumerable: false,
  });
  return {
    ok: true,
    data,
  };
}

/**
 * Replace every WALK leg's `steps` with their merged, split, machine-only
 * normalized form, best-effort per leg.
 * @param route The route whose WALK legs' `steps` should be normalized.
 * @returns The route with each WALK leg's `steps` normalized where possible;
 *   a leg is left with its original `steps` unchanged when normalization
 *   produces no usable result, and the whole route is left unchanged if
 *   normalization throws.
 */
function normalizeWalkSteps(
  route: AccessibleRoute,
  language?: SupportedLang,
): AccessibleRoute {
  try {
    const legs = route.legs.map((leg, index) => {
      if (leg.type !== "WALK") return leg;
      const normalizedSteps = normalizeWalkLegSteps(leg, index === 0);
      if (normalizedSteps.length === 0) return leg;
      return copyWithDescriptors(leg, {
        steps: normalizedSteps,
        ...(leg.stepStreetNames
          ? {
              stepStreetNames: normalizedStreetNames(
                leg,
                normalizedSteps,
                language,
              ),
            }
          : {}),
      });
    });
    return Object.defineProperties(
      { ...route, legs },
      Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(route)).filter(
          ([, descriptor]) => !descriptor.enumerable,
        ),
      ),
    ) as AccessibleRoute;
  } catch (err) {
    console.error("[accessible-route] walk step localization failed", err);
    return route;
  }
}

/** HTTP response variant that makes successful routes armable by voice Live. */
export async function planAccessibleRouteForHttp(
  body: PlanRouteRequest,
): Promise<PlanRouteResult> {
  const result = await planAccessibleRouteFromRequest(body);
  if (!result.ok) return result;
  const canonicalRequest = result.data._canonicalRequest;
  if (!canonicalRequest) return result;
  return {
    ...result,
    data: {
      ...result.data,
      routes: await attachRouteTokens(result.data.routes, canonicalRequest, {
        departure: result.data.venueDepartureLeg,
        arrival: result.data.venueLeg,
      }),
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
        appendRouteHighlight(
          r,
          routeMessage("ROUTE_WALK_NEARBY_FEATURES", hl, {
            count: structures.length,
          }),
        );
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
      appendRouteHighlight(
        r,
        routeMessage("ROUTE_NEARBY_PARKING", hl, { count: parking.length }),
      );
  }
}

function compareWalkPolicy(a: AccessibleRoute, b: AccessibleRoute): number {
  if (!a.walkPolicy || !b.walkPolicy) return 0;
  return (
    a.walkPolicy.carriagewayMillimetres - b.walkPolicy.carriagewayMillimetres ||
    a.walkPolicy.generalizedCost - b.walkPolicy.generalizedCost
  );
}

async function finalizeDrivingRoutes(
  routes: AccessibleRoute[],
  travelMode: RoadTravelMode,
  destination: LatLng,
  skipParkingHighlight = false,
  knownHazards?: ConfirmedHazardInput[],
  walkStairPreference?: boolean,
): Promise<AccessibleRoute[]> {
  const preserveOtpOrder =
    travelMode === "walk" && getRoutingConfig().walkPlanner === "otp";
  const hasWalkSteps = (route: AccessibleRoute) =>
    route.legs.every((leg) => leg.type === "WALK" && !!leg.steps?.length);
  const input =
    walkStairPreference === undefined
      ? routes
      : dedupeRouteGeometry(
          [...routes].sort(
            (a, b) =>
              routeStairsCount(b) - routeStairsCount(a) ||
              Number(hasWalkSteps(b)) - Number(hasWalkSteps(a)),
          ),
        );
  const policyRanked = [...input].sort((a, b) => {
    if (walkStairPreference !== undefined) {
      if (walkStairPreference) {
        const evidence = Number(hasWalkSteps(b)) - Number(hasWalkSteps(a));
        if (evidence) return evidence;
        const stairs = routeStairsCount(a) - routeStairsCount(b);
        if (stairs) return stairs;
      }
      return (
        a.totalMinutes - b.totalMinutes ||
        (a.totalWalkDistanceM ?? Infinity) - (b.totalWalkDistanceM ?? Infinity)
      );
    }
    if (travelMode === "walk") {
      const policyOrder = compareWalkPolicy(a, b);
      if (policyOrder) return policyOrder;
    }
    if (preserveOtpOrder) return 0;
    return (
      a.totalMinutes - b.totalMinutes ||
      driveTotalDistanceM(a) - driveTotalDistanceM(b)
    );
  });
  // Road/walk routes bypass the transit finalizer, so run the same confirmed
  // hazard ranking before this pipeline takes its top-three projection.
  const hazardRanked = (
    await applyConfirmedHazardPlanning(
      policyRanked,
      defaultConfirmedHazardLookup,
      knownHazards,
    )
  ).routes;
  const ranked =
    travelMode === "walk"
      ? selectDiverseWalkRoutes(
          dedupeRouteGeometry(hazardRanked),
          walkStairPreference !== undefined,
        )
      : dedupeRouteGeometry(hazardRanked);
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
  | { kind: "ok"; routes: AccessibleRoute[]; trafficMs?: number }
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "error" };

/**
 * Executes a promise with an explicit timeout, guaranteeing timer cleanup via clearTimeout.
 */
function withTimeoutBudget<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

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

  let incidents: import("../../types/traffic").RoadIncident[] = [];
  let excludeLocations: LatLng[] | undefined;

  const { TRAFFIC_ROUTE_HOOK_TIMEOUT_MS } =
    await import("../../config/traffic");

  if (opts.travelMode !== "walk") {
    try {
      const { getActiveRoadIncidents } =
        await import("../traffic/road-incident.service");
      const { bboxOfPoints, pickExcludeLocations } =
        await import("./planners/traffic-overlay");

      const allPoints: LatLng[] = [
        origin,
        ...(opts.waypoints ?? []),
        destination,
      ];
      const searchBbox = bboxOfPoints(allPoints, 0.02);

      incidents = await withTimeoutBudget(
        getActiveRoadIncidents({ bbox: searchBbox }),
        TRAFFIC_ROUTE_HOOK_TIMEOUT_MS,
        "Traffic incident fetch timeout",
      );
      const closures = incidents.filter((i) => i.severity === "closure");
      if (closures.length > 0) {
        excludeLocations = pickExcludeLocations(closures, origin, destination);
      }
    } catch (incidentErr) {
      console.warn(
        "[accessible-route] incident avoidance fetch failed or timed out:",
        incidentErr,
      );
      incidents = [];
      excludeLocations = undefined;
    }
  }

  let raw: AccessibleRoute[];
  try {
    raw = await planValhallaRoute(origin, destination, {
      travelMode: opts.travelMode,
      waypoints: opts.waypoints,
      departureTime: opts.departureTime,
      finalWalkTarget: opts.finalWalkTarget,
      mode: opts.mode,
      avoidStairs: opts.avoidStairs,
      excludeLocations,
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
      appendRouteHighlight(
        r,
        routeMessage(
          "ROUTE_PARKING_ARRIVAL",
          `已為您導引至最近身障停車格「${name}」（距目的地約 ${distanceM} 公尺）`,
          { name, distanceM },
        ),
      );
    }
  }

  let trafficHookMs = 0;
  if (opts.travelMode !== "walk" && routes.length > 0) {
    const tTrafficStart = Date.now();
    try {
      await withTimeoutBudget(
        (async () => {
          const tGeo = Date.now();
          const { getTrafficGeometrySnapshot } =
            await import("../traffic/traffic-geometry.runtime");
          const snapshot = getTrafficGeometrySnapshot();
          const loadGeometryMs = Date.now() - tGeo;

          let routeSegments = 0;
          for (const r of routes) {
            for (const leg of r.legs) {
              if (
                (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") &&
                (leg as DriveLeg).polyline &&
                (leg as DriveLeg).polyline.length >= 2
              ) {
                routeSegments += (leg as DriveLeg).polyline.length - 1;
              }
            }
          }

          let loadLiveMs = 0;
          let spatialMatchMs = 0;
          let aggregateMs = 0;
          let candidateProbes = 0;
          let matchedSections = 0;

          if (routeSegments > 0) {
            const { getLiveSectionsForBbox } =
              await import("../traffic/traffic-flow.service");
            const { applyTrafficOverlay, bboxOfPolyline } =
              await import("./planners/traffic-overlay");
            const { buildSegmentIndex } =
              await import("../traffic/traffic-segment-index");

            const allCoords: [number, number][] = [];
            for (const r of routes) {
              for (const leg of r.legs) {
                if (
                  (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") &&
                  (leg as DriveLeg).polyline
                ) {
                  allCoords.push(...(leg as DriveLeg).polyline);
                }
              }
            }

            const routesBbox = bboxOfPolyline(allCoords);
            const [minLng, minLat, maxLng, maxLat] = routesBbox;
            const paddedBbox: [number, number, number, number] = [
              minLng - 0.01,
              minLat - 0.01,
              maxLng + 0.01,
              maxLat + 0.01,
            ];

            const tLive = Date.now();
            const liveSectionsMap = await getLiveSectionsForBbox(paddedBbox);
            loadLiveMs = Date.now() - tLive;

            const segmentIndex = snapshot
              ? snapshot.index
              : buildSegmentIndex([]);
            const overlayMetrics = applyTrafficOverlay(
              routes,
              liveSectionsMap,
              segmentIndex,
            );
            spatialMatchMs = overlayMetrics.spatialMatchMs;
            aggregateMs = overlayMetrics.aggregateMs;
            candidateProbes = overlayMetrics.candidateProbes;
            matchedSections = overlayMetrics.matchedSections;
          }

          if (incidents.length > 0) {
            const tIncStart = performance.now();
            const { applyIncidentAdvisories } =
              await import("./planners/traffic-overlay");
            applyIncidentAdvisories(routes, incidents);
            aggregateMs += Math.round(performance.now() - tIncStart);
          }

          const trafficTotalMs = Date.now() - tTrafficStart;
          console.log(
            "[route-timing] traffic",
            JSON.stringify({
              "plan.traffic.total": trafficTotalMs,
              "plan.traffic.loadLive": loadLiveMs,
              "plan.traffic.loadGeometry": loadGeometryMs,
              "plan.traffic.spatialMatch": spatialMatchMs,
              "plan.traffic.aggregate": aggregateMs,
              "plan.traffic.routeSegments": routeSegments,
              "plan.traffic.indexedSegments": snapshot
                ? snapshot.index.segmentCount
                : 0,
              "plan.traffic.candidateProbes": candidateProbes,
              "plan.traffic.matchedSections": matchedSections,
            }),
          );
        })(),
        TRAFFIC_ROUTE_HOOK_TIMEOUT_MS,
        "Traffic overlay hook timeout",
      );
    } catch (trafficErr) {
      console.warn(
        "[accessible-route] traffic overlay failed or timed out, degrading to free flow:",
        trafficErr,
      );
    }
    trafficHookMs = Date.now() - tTrafficStart;
  }

  const selected = selectRoadCandidates(routes);
  return selected.length
    ? { kind: "ok", routes: selected, trafficMs: trafficHookMs }
    : { kind: "empty" };
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
        ...(prev.stepStreetNames || leg.stepStreetNames
          ? {
              stepStreetNames: [
                ...(prev.stepStreetNames ?? []),
                ...(leg.stepStreetNames ?? []).map((entry) => ({
                  ...entry,
                  index: entry.index + (prev.steps?.length ?? 0),
                })),
              ],
            }
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
    accessibilityHighlights: [
      ...new Set(segments.flatMap((s) => s.accessibilityHighlights ?? [])),
    ],
    _accessibilityHighlightMessages: segments.flatMap(
      (s) => s._accessibilityHighlightMessages ?? [],
    ),
    ...(segments.some((s) => s.warnings?.length)
      ? { warnings: [...new Set(segments.flatMap((s) => s.warnings ?? []))] }
      : {}),
    _warningMessages: segments.flatMap((s) => s._warningMessages ?? []),
    ...(segments[0]?.departureDate
      ? { departureDate: segments[0].departureDate }
      : {}),
  } satisfies AccessibleRoute;
  if (combined.legs.every((leg) => leg.type === "WALK"))
    Object.assign(combined, {
      walkPolicy: combineWalkSegments(segments).walkPolicy,
    });
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
  | {
      status: "ok";
      routes: AccessibleRoute[];
      knownHazards?: ConfirmedHazardInput[];
    }
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
  const policies = segments.flatMap((segment) =>
    segment.walkPolicy ? [segment.walkPolicy] : [],
  );
  const firstPolicy = policies[0];
  return {
    routeId: `walk-${segments.map((segment) => segment.routeId).join("-")}`,
    routeName: "步行",
    totalMinutes: segments.reduce(
      (sum, segment) => sum + segment.totalMinutes,
      0,
    ),
    transferCount: 0,
    legs,
    accessibilityHighlights: [
      ...new Set(
        segments.flatMap((segment) => segment.accessibilityHighlights ?? []),
      ),
    ],
    _accessibilityHighlightMessages: segments.flatMap(
      (segment) => segment._accessibilityHighlightMessages ?? [],
    ),
    ...(segments.some((segment) => segment.degraded) ? { degraded: true } : {}),
    ...(segments.some((segment) => segment.warnings?.length)
      ? {
          warnings: [
            ...new Set(segments.flatMap((segment) => segment.warnings ?? [])),
          ],
          _warningMessages: segments.flatMap(
            (segment) => segment._warningMessages ?? [],
          ),
        }
      : {}),
    totalWalkDistanceM: segments.reduce(
      (sum, segment) => sum + (segment.totalWalkDistanceM ?? 0),
      0,
    ),
    attribution: segments[0]?.attribution,
    ...(firstPolicy && policies.length === segments.length
      ? {
          walkPolicy: {
            ...firstPolicy,
            maxSlopePercent: policies.every(
              (policy) => policy.maxSlopePercent !== null,
            )
              ? Math.max(
                  ...policies.map((policy) => policy.maxSlopePercent ?? 0),
                )
              : null,
            carriagewayMillimetres: policies.reduce(
              (sum, policy) => sum + policy.carriagewayMillimetres,
              0,
            ),
            generalizedCost: policies.reduce(
              (sum, policy) => sum + policy.generalizedCost,
              0,
            ),
          },
        }
      : {}),
  };
}

const CSR_WALK_ATTRIBUTION = "© OpenStreetMap contributors";

/** Run the existing CSR planner with independent mobility and stair conditions. */
async function planCsrWalkForRequest(
  points: LatLng[],
  mode: AccessibilityMode,
  avoidStairs: boolean,
  avoidPoints?: [number, number][],
  includeAlternatives = false,
): Promise<CsrWalkResult> {
  try {
    const { planCsrWalkRoute } =
      await import("./planners/pedestrian-a11y/csr-walk-planner");
    return await planCsrWalkRoute(points, {
      mode,
      avoidStairs,
      ...(avoidPoints?.length ? { avoidPoints } : {}),
      ...(includeAlternatives ? { includeAlternatives: true } : {}),
    });
  } catch (error: unknown) {
    return {
      status: "unavailable",
      reason:
        error instanceof Error
          ? `CSR pedestrian planner failed: ${error.message}`
          : "CSR pedestrian planner failed",
    };
  }
}

/**
 * Assemble ordered CSR segment plans into the existing walking route contract.
 *
 * One WalkLeg per requested segment, in request order, so waypoint `legIndex`
 * values stay meaningful. `steps` are derived from the selected edges' own
 * geometry and facility types (`buildCsrWalkSteps`) — they carry no street
 * names, since the CSR graph has none, but do describe real turns, elevators,
 * escalators, moving walkways, fare gates, and station entry/exit crossings.
 *
 * @param plans Ordered per-segment CSR plans.
 * @returns One multi-leg walking route.
 */
function buildCsrWalkRoute(plans: readonly CsrWalkPlan[]): AccessibleRoute {
  const lastIndex = plans.length - 1;
  const legs: WalkLeg[] = plans.map((plan, index) => ({
    type: "WALK",
    from: index === 0 ? "起點" : `中途點 ${index}`,
    to: index === lastIndex ? "終點" : `中途點 ${index + 1}`,
    distanceM: Math.round(plan.distanceM),
    minutesEst: Math.max(1, Math.round(plan.durationS / 60)),
    polyline: plan.polyline,
    a11yFacilities: [],
    maxSlopePercent: plan.accessibility.maxSlopePercent,
    crossings: plan.accessibility.crossings,
    crossingsWithCurbRamp: plan.accessibility.crossingsWithCurbRamp,
    minPathWidthCm: plan.accessibility.minPathWidthCm,
    surfaceType: plan.accessibility.surfaceType,
    restPoints: [],
    exitInfo: null,
    a11ySegments: plan.a11ySegments,
    steps: plan.steps,
    ...(plan.stepStreetNames ? { stepStreetNames: plan.stepStreetNames } : {}),
    sidewalkRampCount: plan.sidewalkRampCount,
    a11yPoints: plan.a11yPoints,
  }));

  const approximateIndoorSegments = plans.reduce(
    (sum, plan) => sum + plan.approximateIndoorSegmentCount,
    0,
  );
  const totalDurationS = plans.reduce((sum, plan) => sum + plan.durationS, 0);

  return {
    routeId: "csr-walk-0",
    routeName: "步行",
    totalMinutes: Math.max(1, Math.round(totalDurationS / 60)),
    transferCount: 0,
    legs,
    accessibilityHighlights: [],
    engine: "pedestrian-a11y",
    walkPolicy: {
      ...plans[0].walkPolicy,
      carriagewayMillimetres: plans.reduce(
        (sum, plan) => sum + plan.walkPolicy.carriagewayMillimetres,
        0,
      ),
      generalizedCost: plans.reduce(
        (sum, plan) => sum + plan.walkPolicy.generalizedCost,
        0,
      ),
    },
    totalWalkDistanceM: legs.reduce((sum, leg) => sum + leg.distanceM, 0),
    attribution: CSR_WALK_ATTRIBUTION,
    ...(approximateIndoorSegments > 0
      ? {
          warnings: [ROUTE_WARNING.CSR_WALK_APPROXIMATE_INDOOR_GEOMETRY],
          _warningMessages: [
            routeMessage(
              "ROUTE_CSR_APPROXIMATE_INDOOR",
              ROUTE_WARNING.CSR_WALK_APPROXIMATE_INDOOR_GEOMETRY,
            ),
          ],
        }
      : {}),
  };
}

/**
 * Emit one structured line describing what the CSR planner decided and why.
 *
 * @param result CSR walk planner outcome.
 * @param segmentCount Number of adjacent coordinate pairs requested.
 * @param mode Resolved accessibility mode.
 * @returns Nothing.
 */
function logCsrWalkOutcome(
  result: CsrWalkResult,
  segmentCount: number,
  mode: AccessibilityMode,
): void {
  const base = {
    engine: "pedestrian-a11y",
    status: result.status,
    segmentCount,
    mode,
  };

  if (result.status === "ok") {
    console.log(
      "[csr-walk] planned",
      JSON.stringify({
        ...base,
        graphVersionId: result.plans[0]?.graphVersionId ?? null,
        distanceM: Math.round(
          result.plans.reduce((sum, plan) => sum + plan.distanceM, 0),
        ),
        approximateIndoorSegmentCount: result.plans.reduce(
          (sum, plan) => sum + plan.approximateIndoorSegmentCount,
          0,
        ),
      }),
    );
    return;
  }

  if (result.status === "outside_coverage") {
    console.log("[csr-walk] skipped", JSON.stringify(base));
    return;
  }

  console.warn(
    "[csr-walk] no route",
    JSON.stringify(
      result.status === "unavailable"
        ? { ...base, reason: result.reason }
        : base,
    ),
  );
}

/**
 * Plan all adjacent walking segments through OTP with bounded concurrency.
 * @param points Ordered origin, waypoint, and destination coordinates.
 * @param mode Accessibility mode used for OTP walking speed.
 * @param avoidStairs Independent stair condition for every walking segment.
 * @returns A combined route or an explicit no-route/unavailable status.
 */
async function planOtpWalkSegments(
  points: LatLng[],
  mode: AccessibilityMode,
  avoidStairs: boolean,
  deadline?: number,
  includeWalkingAlternatives = false,
): Promise<WalkSegmentsResult> {
  const { planOtpWalkDetailed } = await import("./planners/otp-routing");
  const limiter = createLimiter(MAX_WALK_SEGMENT_CONCURRENCY);
  const results = await Promise.all(
    points.slice(0, -1).map((from, index) =>
      limiter(() =>
        planOtpWalkDetailed(from, points[index + 1], {
          mode,
          avoidStairs,
          ...(deadline !== undefined ? { deadline } : {}),
          ...(includeWalkingAlternatives
            ? { includeWalkingAlternatives: true }
            : {}),
        }),
      ),
    ),
  );
  if (results.some((result) => result.status === "unavailable")) {
    return { status: "unavailable", routes: [] };
  }
  if (results.some((result) => result.status === "no_route")) {
    return { status: "no_route", routes: [] };
  }
  const constraints = resolveA11yConstraints(mode, { avoidStairs });
  const eligibleSegments = results.map((result) => {
    const eligible = result.routes
      .filter((route) => !isRouteExcluded(route, constraints))
      .sort(compareWalkPolicy);
    return includeWalkingAlternatives
      ? eligible
      : dedupeExactRouteGeometry(eligible);
  });
  if (eligibleSegments.some((routes) => routes.length === 0))
    return { status: "ok", routes: [] };
  if (eligibleSegments.length === 1)
    return {
      status: "ok",
      routes: eligibleSegments[0].map((route) => combineWalkSegments([route])),
    };
  // The public request accepts at most five waypoints: 3^6 is 729 complete
  // combinations. Rank their distinct hazards before taking a bounded result.
  const hazards = await loadConfirmedHazards(
    eligibleSegments.flat(),
    defaultConfirmedHazardLookup,
  );
  const matchedHazards = new Map<AccessibleRoute, RouteHazard[]>();
  if (hazards !== undefined) {
    try {
      for (const route of eligibleSegments.flat()) {
        matchedHazards.set(route, matchConfirmedHazardsToRoute(route, hazards));
      }
    } catch (error) {
      matchedHazards.clear();
      warnHazardOverlayFailure(error);
    }
  }
  type WalkCombination = {
    segments: AccessibleRoute[];
    rank: number;
    hazards: Map<string, RouteHazard>;
  };
  let combinations: WalkCombination[] = [
    { segments: [], rank: 0, hazards: new Map() },
  ];
  for (const segmentRoutes of eligibleSegments) {
    combinations = combinations
      .flatMap((combination) =>
        segmentRoutes.slice(0, 3).map((route, index) => {
          const routeHazards = new Map(combination.hazards);
          for (const hazard of matchedHazards.get(route) ?? []) {
            routeHazards.set(hazard.id, hazard);
          }
          return {
            segments: [...combination.segments, route],
            rank: combination.rank + index,
            hazards: routeHazards,
          };
        }),
      )
      .slice(0, 729);
    if (!combinations.length) return { status: "no_route", routes: [] };
  }
  const risk = (combination: WalkCombination) => {
    const found = [...combination.hazards.values()];
    return {
      blocking: found.filter((hazard) => hazard.severity === "blocking").length,
      penalty: found.reduce(
        (sum, hazard) => sum + HAZARD_PENALTY_POINTS[hazard.severity],
        0,
      ),
    };
  };
  combinations.sort((a, b) => {
    const left = risk(a);
    const right = risk(b);
    return (
      left.blocking - right.blocking ||
      (left.blocking > 0 ? left.penalty - right.penalty : 0) ||
      a.rank - b.rank
    );
  });
  return {
    status: "ok",
    routes: combinations.slice(0, 12).map(({ segments }, index) => ({
      ...combineWalkSegments(segments),
      routeId: `otp-walk-${index}`,
    })),
    ...(hazards !== undefined ? { knownHazards: hazards } : {}),
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
  city: TaiwanCityEn | null,
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
  _city: TaiwanCityEn | null,
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
  const deadline = opts.deadline ?? t0 + getRoutingConfig().planBudgetMs;
  const envPromise = getWeatherAndAirQuality(
    destination.lat,
    destination.lng,
  ).catch(() => undefined);

  if (!waypoints.length) {
    const otp = await runOtpSegment(
      anchorToStreetLevel(origin),
      anchorToStreetLevel(destination),
      {
        transitPreference: opts.transitPreference,
        maxTransfers,
        mode,
        avoidStairs: constraints.avoidStairs,
        departureTime: opts.departureTime,
        deadline,
      },
    );
    console.log(
      "[route-timing] planners",
      JSON.stringify({ otp: Date.now() - t0 }),
    );
    if (otp.status !== "ok") return otp;
    if (!otp.routes.length) return { status: "no_route", routes: [] };
    const originalWalks = new Set(otp.routes);
    const walkingFailure = await refineWalkOptionWithCsr(
      otp.routes,
      [origin, destination],
      mode,
      constraints.avoidStairs,
      deadline,
    );
    if (walkingFailure)
      return walkingFailure.status === ResponseCode.SERVICE_UNAVAILABLE
        ? { status: "unavailable", routes: [] }
        : walkingFailure.data?.reason === ROUTE_REASON.NO_ACCESSIBLE_ROUTE
          ? {
              status: "no_route",
              routes: [],
              reason: ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
            }
          : { status: "no_route", routes: [] };
    const walkingBetter =
      otp.walkingBetter &&
      otp.routes.every((route) => originalWalks.has(route));
    await restoreRouteStopIds(otp.routes);
    const routes = await finalizeRoutes(
      otp.routes,
      origin,
      destination,
      mode,
      constraints,
      opts.format,
      envPromise,
      opts.transitPreference,
      opts.language,
      opts.departureTime?.getTime() ?? t0,
    );
    if (!routes.length) return { status: "no_route", routes: [] };
    return walkingBetter
      ? { status: "ok", routes, walkingBetter: true }
      : { status: "ok", routes };
  }

  // Multi-waypoint transit: plan each origin→wp→…→dest segment sequentially,
  // propagating time — each segment departs when the previous one arrives, so
  // later-segment transit schedules line up with the traveller's real arrival.
  // Remaining accepted limitations: double WALK seams at each waypoint, and no
  // cross-segment global optimization (each segment takes its own best).
  const points: LatLng[] = [origin, ...waypoints, destination].map(
    anchorToStreetLevel,
  );
  const segmentPairs: [LatLng, LatLng][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segmentPairs.push([points[i], points[i + 1]]);
  }
  let cursor = opts.departureTime ?? new Date();
  const segments: AccessibleRoute[] = [];
  let everySegmentWalkingBetter = true;
  for (const [from, to] of segmentPairs) {
    const result = await runOtpSegment(from, to, {
      transitPreference: opts.transitPreference,
      maxTransfers,
      mode,
      avoidStairs: constraints.avoidStairs,
      departureTime: cursor,
      limit: 1,
      deadline,
    });
    if (result.status !== "ok") return result;
    everySegmentWalkingBetter &&= result.walkingBetter === true;
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
  const candidates = [combined];
  const walkingFailure = await refineWalkOptionWithCsr(
    candidates,
    points,
    mode,
    constraints.avoidStairs,
    deadline,
  );
  if (walkingFailure)
    return walkingFailure.status === ResponseCode.SERVICE_UNAVAILABLE
      ? { status: "unavailable", routes: [] }
      : walkingFailure.data?.reason === ROUTE_REASON.NO_ACCESSIBLE_ROUTE
        ? {
            status: "no_route",
            routes: [],
            reason: ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
          }
        : { status: "no_route", routes: [] };
  await restoreRouteStopIds(candidates);
  const routes = await finalizeRoutes(
    candidates,
    origin,
    destination,
    mode,
    constraints,
    opts.format,
    envPromise,
    opts.transitPreference,
    opts.language,
    opts.departureTime?.getTime() ?? t0,
  );
  if (!routes.length) return { status: "no_route", routes: [] };
  return everySegmentWalkingBetter && candidates[0] === combined
    ? { status: "ok", routes, walkingBetter: true }
    : { status: "ok", routes };
}

/** Apply the planner's replacement-leg constraints before adopting a bus. */
export async function isBusSelectionAccessible(
  base: AccessibleRoute,
  route: AccessibleRoute,
  request: CanonicalPlanRouteRequest,
): Promise<boolean> {
  await enrichTopRoutes(
    [route],
    { lat: request.origin.latitude, lng: request.origin.longitude },
    { lat: request.destination.latitude, lng: request.destination.longitude },
    request.mode,
  ).catch((err) =>
    console.warn("[accessible-route] candidate a11y enrichment failed", err),
  );
  const [community, government] = await Promise.all([
    loadConfirmedHazards([route], defaultConfirmedHazardLookup),
    loadGovernmentHazards([route]),
  ]);
  const hazards = combineHazards(community, government);
  if (hazards !== undefined) planWithConfirmedHazards([route], hazards);
  return !(
    (isRouteExcluded(
      route,
      resolveA11yConstraints(request.mode, {
        ...request,
        ...(request.walkStairsPreference ? { avoidStairs: false } : {}),
      }),
    ) &&
      !base.degraded) ||
    (route.hazardAdvisory?.blockingOnRoute ?? 0) >
      (base.hazardAdvisory?.blockingOnRoute ?? 0)
  );
}
