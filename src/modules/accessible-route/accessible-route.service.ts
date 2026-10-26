import {
  groupRoutesByTransitSkeleton,
  resolveCandidateGroup,
  compareRoutesByArrival,
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
import { getA11yProfile } from "../user/user.service";
import type { RouteIntent } from "../../types/ai";
import type {
  CsrWalkPlan,
  CsrWalkResult,
} from "./planners/pedestrian-a11y/csr-walk.types";
import { ResponseCode } from "../../types/code";
import { getServiceCoverageConfig } from "../../config/coverage";
import {
  getPedGraphRuntime,
  type PedGraphSnapshot,
} from "./planners/pedestrian-a11y/graph-runtime";
import {
  attachWalkingPolicy,
  annotateStairsAssistance,
  combineWalkingPolicy,
  qualifyWalkingCandidates,
  recomputeRoadClock,
  walkLegFromPlan,
} from "./walking-policy.service";
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
import { getReviewedOtpWalkPolicies } from "../../config/otp-walk";
import { planQualifiedOtpWalk } from "./planners/otp-walk-planner";
import { restoreRouteStopIds } from "./stop-aliases";
import { matchAudioSignals, paddedBbox } from "./planners/audio-signals";
import {
  scoreRoute,
  routeCost,
  resolveA11yConstraints,
  type EnvConditions,
} from "./scoring";
import {
  buildAccessibilitySummary,
  nearbyA11y,
  attachA11yToLeg,
  deriveHighlightMessages,
  enrichLegIndoor,
} from "./planners/route-a11y";
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
  pointToSegmentDistanceM,
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
  DriveLeg,
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
/**
 * Budget for the park-entrance lookup. It is an advisory refinement of the
 * destination, so a slow or unreachable database must not hold up planning.
 */
const PARK_ARRIVAL_BUDGET_MS = 800;

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
  return Math.max(
    (leg.steps ?? []).filter((step) => step.stairs).length,
    (leg.a11ySegments ?? []).filter((segment) => segment.feature === "stairs")
      .length,
  );
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
          walkLegHasStairsBarrier(leg) &&
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
  if (opts.maxSlopePercent !== undefined) {
    const requestedMaxPercent = opts.maxSlopePercent;
    let slopeMessageCode: string;
    const hasCsrWalkRoute = routes.some(
      (route) =>
        route.engine === "pedestrian-a11y" ||
        route.walkingPolicy?.version === "sidewalk-v1",
    );
    if (hasCsrWalkRoute) {
      slopeMessageCode = "ROUTE_SLOPE_CSR";
      slopeConstraint = {
        requestedMaxPercent,
        enforced: false,
        note: ROUTE_WARNING.CSR_SLOPE_LIMIT_NOT_ENFORCED,
      };
    } else if (
      routes.some((route) => route.walkingPolicy?.version === "otp-sidewalk-v1")
    ) {
      const wheelchair = routes.some(
        (route) =>
          route.walkingPolicy?.version === "otp-sidewalk-v1" &&
          route.walkingPolicy.mode === "wheelchair",
      );
      slopeMessageCode = wheelchair
        ? "ROUTE_SLOPE_OTP_WHEELCHAIR"
        : "ROUTE_SLOPE_NORMAL_WALK";
      slopeConstraint = {
        requestedMaxPercent,
        enforced: false,
        note: wheelchair
          ? ROUTE_WARNING.OTP_WHEELCHAIR_SLOPE_NOT_ENFORCED
          : ROUTE_WARNING.NORMAL_WALK_SLOPE_NOT_ENFORCED,
      };
    } else if (
      travelMode === "drive" ||
      travelMode === "motorcycle" ||
      opts.routedByEngineWithNoElevationData
    ) {
      slopeMessageCode = "ROUTE_SLOPE_NO_ELEVATION";
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
      slopeMessageCode = wheelchairEngaged
        ? enforced
          ? "ROUTE_SLOPE_SERVER_LIMIT"
          : "ROUTE_SLOPE_SERVER_DEFAULT"
        : "ROUTE_SLOPE_WHEELCHAIR_DISABLED";
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
    const descriptor = routeMessage(slopeMessageCode, slopeConstraint.note, {
      requestedMaxPercent: slopeConstraint.requestedMaxPercent,
      enforced: slopeConstraint.enforced,
      serverMaxPercent: OTP_SERVER_MAX_SLOPE_PERCENT,
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
        walkLegHasStairsBarrier(leg) &&
        !leg.walkingPolicy?.stairsFallback
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
  return routes.filter((route) => !isRouteExcluded(route, constraints));
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
  deadline = Date.now() + getRoutingConfig().planBudgetMs,
): Promise<AccessibleRoute[]> {
  if (Date.now() >= deadline) return [];
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
  const budget = createCandidateRequestBudget(
    Math.max(1, Math.min(8000, deadline - Date.now())),
  );
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
  if (Date.now() >= deadline) return [];
  const scored = scoreAndRank(feasible, mode, env, transitPreference, language);
  const top = groupRoutesByTransitSkeleton(scored.sort(compareRoutesByArrival))
    .map((group) => group.members[0])
    .slice(0, 3);
  // Nothing after the arrival-first comparator may reorder routes.
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
 * Plan direct walking through a qualified provider. Reviewed OTP policies
 * enable native direct WALK; other transport requests retain their existing providers.
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
  deadline = Date.now() + getRoutingConfig().planBudgetMs,
  getSnapshot?: () => Promise<PedGraphSnapshot | undefined>,
  allowStairsFallback?: boolean,
  language?: SupportedLang,
): Promise<WalkPlanOutcome> {
  const dest = walkPoints[walkPoints.length - 1];
  const startsAt = departureTime?.getTime() ?? Date.now();
  if (
    (roadMode === "normal" || roadMode === "wheelchair") &&
    getReviewedOtpWalkPolicies().length > 0
  ) {
    const result = await planQualifiedOtpWalk({
      points: walkPoints,
      mode: roadMode,
      avoidStairs,
      allowStairsFallback,
      departureTimeMs: startsAt,
      deadlineMs: deadline,
    });
    if (result.status !== "ready") {
      return {
        ok: false,
        failure: routeFailure(
          result.status === "no_route"
            ? ROUTE_REASON.NO_ROUTE
            : result.status === "endpoint_blocked"
              ? ROUTE_REASON.ENDPOINT_CONSTRAINT_BLOCKED
              : ROUTE_REASON.UPSTREAM_TIMEOUT,
          result.status === "endpoint_blocked"
            ? { endpointConstraint: result.endpointConstraint }
            : {},
          language,
        ),
      };
    }
    return {
      ok: true,
      routes: await finalizeDrivingRoutes([result.route], "walk", dest, false),
      trafficMs: 0,
      routedByEngineWithNoElevationData: false,
    };
  }
  const snapshot = getSnapshot
    ? await getSnapshot()
    : await getPedGraphRuntime().then((runtime) =>
        runtime.status === "ready" ? runtime.snapshot : undefined,
      );
  if (!snapshot) {
    return { ok: false, failure: routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT) };
  }
  const csrWalk = await planCsrWalkForRequest(
    walkPoints,
    roadMode,
    avoidStairs,
    undefined,
    snapshot,
    deadline,
    allowStairsFallback,
  );
  logCsrWalkOutcome(csrWalk, walkPoints.length - 1, roadMode);
  if (csrWalk.status === "ok") {
    const candidates = [
      buildCsrWalkRoute(csrWalk.plans, roadMode, avoidStairs, startsAt),
    ];
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
          snapshot,
          deadline,
          allowStairsFallback,
        );
        if (alternative.status === "ok")
          candidates.push(
            buildCsrWalkRoute(
              alternative.plans,
              roadMode,
              avoidStairs,
              startsAt,
            ),
          );
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

  const reason =
    csrWalk.status === "accessibility_blocked" ||
    csrWalk.status === "fare_policy_blocked"
      ? ROUTE_REASON.NO_ACCESSIBLE_ROUTE
      : csrWalk.status === "topology_disconnected" ||
          csrWalk.status === "outside_coverage"
        ? ROUTE_REASON.NO_ROUTE
        : ROUTE_REASON.UPSTREAM_TIMEOUT;
  return { ok: false, failure: routeFailure(reason) };
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

interface PlanningScope {
  planningNow: number;
  deadlineMs: number;
  getSnapshot: () => Promise<PedGraphSnapshot | undefined>;
  profileResolved?: boolean;
  allowStairsFallback?: boolean;
  handover?: { venueArrival: VenueArrival; venueLeg: VenueRoute };
}

export async function planAccessibleRouteFromRequest(
  body: PlanRouteRequest,
  scope?: PlanningScope,
): Promise<PlanRouteResult> {
  const planningNow = scope?.planningNow ?? Date.now();
  if (!scope) {
    let snapshot: Promise<PedGraphSnapshot | undefined> | undefined;
    scope = {
      planningNow,
      deadlineMs: planningNow + getRoutingConfig().planBudgetMs,
      getSnapshot: () =>
        (snapshot ??= getPedGraphRuntime().then((runtime) =>
          runtime.status === "ready" ? runtime.snapshot : undefined,
        )),
    };
  }
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
    !scope.profileResolved &&
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

  let venueArrival = scope.handover?.venueArrival;
  let venueLeg = scope.handover?.venueLeg;
  const venueLang = body.language ?? DEFAULT_LANG;
  if (!scope.handover && body.destinationVenuePlace && origin) {
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
    const resolvedWaypoints = await Promise.all(
      rawWaypoints.map((point) =>
        typeof point === "string"
          ? getCoordinates(point)
          : Promise.resolve(point as { latitude: number; longitude: number }),
      ),
    );
    if (resolvedWaypoints.some((point) => !point)) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        error:
          localizeRouteReason("WAYPOINT_LOOKUP_FAILED", body.language) ??
          "無法解析中途點座標",
        data: { reason: "WAYPOINT_LOOKUP_FAILED" },
      };
    }
    const waypointPoints = resolvedWaypoints.flatMap((point) =>
      point ? [point] : [],
    );
    const commonPreflight = preflightAccessibleRoute(
      [originPoint, ...waypointPoints].map((point) => ({
        lat: point.latitude,
        lng: point.longitude,
      })),
      getServiceCoverageConfig(),
      body.language,
    );
    if (!commonPreflight.ok) return commonPreflight;
    const planningScope = scope;
    const positive = new Map<string, Extract<PlanRouteResult, { ok: true }>>();
    const resolved = await venueArrivalPlanner().resolveVenueArrival({
      venueId: body.destinationVenuePlace.venueId,
      placeId: body.destinationVenuePlace.placeId,
      origin: { lat: originPoint.latitude, lng: originPoint.longitude },
      mode: venueModeFor(mode, avoidStairs),
      lang: venueLang,
      deadlineMs: scope.deadlineMs,
      planOutdoorApproach: async ({
        venueArrival,
        venueLeg,
        allowStairsFallback,
      }) => {
        if (!allowStairsFallback && venueLeg.stairsFallback)
          return { status: "unavailable" };
        const result = await planAccessibleRouteFromRequest(
          {
            ...body,
            query: undefined,
            destinationVenuePlace: undefined,
            venueArrival: undefined,
            origin: originPoint,
            destination: {
              latitude: venueArrival.gateLocation.lat,
              longitude: venueArrival.gateLocation.lng,
            },
            waypoints: waypointPoints,
            keepExactDestination: true,
            mode,
            transitPreference,
            requireElevator,
            avoidStairs,
            needsAccessibleToilet,
            needsHandrail,
            maxSlopePercent,
          },
          {
            ...planningScope,
            profileResolved: true,
            allowStairsFallback,
            handover: { venueArrival, venueLeg },
          },
        ).catch((error: unknown) => {
          console.warn(
            "[accessible-route] venue outdoor approach unavailable",
            error,
          );
          return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, body.language);
        });
        if (!result.ok) {
          return {
            status:
              result.status === ResponseCode.UNPROCESSABLE_ENTITY
                ? "no_route"
                : "unavailable",
          };
        }
        if (
          !result.data.routes.length ||
          (!allowStairsFallback &&
            result.data.routes.some(
              (route) => route.walkingPolicy?.stairsFallback,
            ))
        )
          return { status: "unavailable" };
        const durationS = Math.min(
          ...result.data.routes.map((route) => {
            const start = Date.parse(route.departureTime ?? "");
            const end = Date.parse(route.arrivalTime ?? "");
            return Number.isFinite(start) && Number.isFinite(end)
              ? (end - start) / 1000
              : route.totalMinutes * 60;
          }),
        );
        if (!Number.isFinite(durationS) || durationS < 0)
          return { status: "unavailable" };
        positive.set(venueArrival.gateId, result);
        return { status: "ok", durationS };
      },
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
    const chosen = positive.get(resolved.venueArrival.gateId);
    if (!chosen)
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, body.language);
    if (intent) chosen.data.intent = intent;
    return chosen;
  } else if (!scope.handover && body.venueArrival) {
    // Reroute of a venue trip: the destination is already the stored gate.
    const replanned = await venueArrivalPlanner().replanVenueLeg(
      body.venueArrival,
      venueLang,
      scope.deadlineMs,
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
    : (nextTaipeiClock(normalizedDeparture, new Date(planningNow)) ??
      new Date(normalizedDeparture));
  const futureDeparture =
    parsedDeparture &&
    !isNaN(parsedDeparture.getTime()) &&
    parsedDeparture.getTime() > planningNow
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
    const deadline = scope.deadlineMs;
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
      getSnapshot: scope.getSnapshot,
      planningNow,
      allowStairsFallback: scope.allowStairsFallback,
    };
    let transit = await findAccessibleRoutesDetailed(
      originLatLng,
      dest,
      city,
      transitOptions,
    );
    if (transit.status === "unavailable") {
      logRequestTiming();
      return routeFailure(ROUTE_REASON.UPSTREAM_TIMEOUT, {}, body.language);
    }
    let blockedByAccessibility =
      transit.status === "no_route" && transit.blockedByAccessibility === true;
    if (
      transit.status === "no_route" &&
      constraints.avoidStairs &&
      Date.now() < deadline
    ) {
      transit = await findAccessibleRoutesDetailed(originLatLng, dest, city, {
        ...transitOptions,
        avoidStairs: false,
      });
      blockedByAccessibility ||=
        transit.status === "no_route" &&
        transit.blockedByAccessibility === true;
    }
    if (transit.status !== "ok") {
      logRequestTiming();
      const reason =
        transit.status === "unavailable"
          ? ROUTE_REASON.UPSTREAM_TIMEOUT
          : blockedByAccessibility
            ? ROUTE_REASON.NO_ACCESSIBLE_ROUTE
            : ROUTE_REASON.NO_ROUTE;
      return routeFailure(reason, {}, body.language);
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
      futureDeparture ?? new Date(planningNow),
      scope.deadlineMs,
      scope.getSnapshot,
      scope.allowStairsFallback,
      body.language,
    );
    logRequestTiming();
    if (!walk.ok) return walk.failure;
    routes = walk.routes;
    trafficHookMs += walk.trafficMs;
    routedByEngineWithNoElevationData = walk.routedByEngineWithNoElevationData;
  } else {
    const roadMode = mode ?? "normal";
    const constraints = resolveA11yConstraints(roadMode, { avoidStairs });
    const walkingOptions = {
      getSnapshot: scope.getSnapshot,
      allowStairsFallback: scope.allowStairsFallback,
      deadlineMs: scope.deadlineMs,
      departureTimeMs: futureDeparture?.getTime() ?? planningNow,
      language: body.language,
    };
    let routingDest = dest;
    let finalWalkTarget: LatLng | undefined =
      arrivalEntrance || venueArrival ? dest : undefined;
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
      ...walkingOptions,
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
        ...walkingOptions,
        finalWalkTarget: dest,
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
    avoidStairs,
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
  routes.forEach((route) => attachWalkingPolicy(route, body.language));
  const displayRoutes = await enrichRouteDisplayNames(routes, body.language);
  const normalizedRoutes = displayRoutes.map((route) => {
    const normalized = normalizeWalkSteps(route, body.language);
    if (venueLeg?.stairsFallback)
      annotateStairsAssistance(normalized, body.language);
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
      routes: await attachRouteTokens(result.data.routes, canonicalRequest),
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
    // Equal time/distance does not mean equal exposure to a blocking hazard.
    const walkGeometry = r.legs.every((leg) => leg.type === "WALK")
      ? JSON.stringify(r.legs.map((leg) => leg.polyline))
      : "";
    const key = `${Math.round(r.totalMinutes)}|${Math.round(
      driveTotalDistanceM(r) / 50,
    )}|${walkGeometry}`;
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
  knownHazards?: ConfirmedHazardInput[],
): Promise<AccessibleRoute[]> {
  const baseRanked = dedupeDrivingRoutes(routes).sort(
    (a, b) =>
      a.totalMinutes - b.totalMinutes ||
      driveTotalDistanceM(a) - driveTotalDistanceM(b),
  );
  // Road/walk routes bypass the transit finalizer, so run the same confirmed
  // hazard ranking before this pipeline takes its top-three projection.
  const ranked = (
    await applyConfirmedHazardPlanning(
      baseRanked,
      defaultConfirmedHazardLookup,
      knownHazards,
    )
  ).routes.slice(0, 3);
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
  const verified = await qualifyWalkingCandidates(raw, {
    origin,
    destination: trueDest,
    mode: opts.mode ?? "normal",
    avoidStairs: opts.avoidStairs ?? opts.mode === "wheelchair",
    deadlineMs: opts.deadlineMs ?? Date.now() + getRoutingConfig().planBudgetMs,
    getSnapshot: opts.getSnapshot,
    allowStairsFallback: opts.allowStairsFallback,
    departureTimeMs: opts.departureTimeMs ?? opts.departureTime?.getTime(),
    language: opts.language,
  });
  if (verified.status !== "ok")
    return { kind: verified.status === "no_route" ? "empty" : "unavailable" };
  raw = verified.routes;
  for (const route of raw)
    recomputeRoadClock(
      route,
      opts.departureTimeMs ?? opts.departureTime?.getTime(),
    );
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

  for (const route of routes)
    recomputeRoadClock(
      route,
      opts.departureTimeMs ?? opts.departureTime?.getTime(),
    );
  return routes.length
    ? { kind: "ok", routes, trafficMs: trafficHookMs }
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
      const policy = combineWalkingPolicy([prev, leg]);
      if ((prev.walkingPolicy || leg.walkingPolicy) && !policy) {
        out.push(leg);
        continue;
      }
      const durationS =
        prev.durationS !== undefined && leg.durationS !== undefined
          ? prev.durationS + leg.durationS
          : undefined;
      const merged: WalkLeg = {
        ...prev,
        type: "WALK",
        durationS,
        walkingPolicy: policy,
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
        maxSlopePercent:
          prev.maxSlopePercent === null
            ? leg.maxSlopePercent
            : leg.maxSlopePercent === null
              ? prev.maxSlopePercent
              : Math.max(prev.maxSlopePercent, leg.maxSlopePercent),
        minPathWidthCm:
          prev.minPathWidthCm === null
            ? leg.minPathWidthCm
            : leg.minPathWidthCm === null
              ? prev.minPathWidthCm
              : Math.min(prev.minPathWidthCm, leg.minPathWidthCm),
        crossings:
          prev.crossings === null && leg.crossings === null
            ? null
            : (prev.crossings ?? 0) + (leg.crossings ?? 0),
        crossingsWithCurbRamp:
          prev.crossingsWithCurbRamp === null &&
          leg.crossingsWithCurbRamp === null
            ? null
            : (prev.crossingsWithCurbRamp ?? 0) +
              (leg.crossingsWithCurbRamp ?? 0),
        surfaceType:
          prev.surfaceType === leg.surfaceType ? prev.surfaceType : "unknown",
        a11ySegments: [
          ...(prev.a11ySegments ?? []),
          ...(leg.a11ySegments ?? []).map((segment) => ({
            ...segment,
            startIndex: segment.startIndex + prev.polyline.length,
            endIndex: segment.endIndex + prev.polyline.length,
          })),
        ],
        restPoints: [
          ...prev.restPoints,
          ...leg.restPoints.map((point) => ({
            ...point,
            distanceM: point.distanceM + prev.distanceM,
          })),
        ],
        toNameEn: leg.toNameEn,
        toDisplayName: leg.toDisplayName,
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
      if (durationS !== undefined) {
        Object.defineProperty(merged, "_durationMs", {
          value: durationS * 1000,
          writable: true,
        });
      }
      out[out.length - 1] = merged;
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

const CSR_WALK_ATTRIBUTION = "© OpenStreetMap contributors";

/** Plan every ordered walking segment against one qualified graph context. */
async function planCsrWalkForRequest(
  points: LatLng[],
  mode: AccessibilityMode,
  avoidStairs: boolean,
  avoidPoints?: [number, number][],
  context?: PedGraphSnapshot,
  deadlineMs?: number,
  allowStairsFallback?: boolean,
): Promise<CsrWalkResult> {
  try {
    const { planCsrWalkRoute } =
      await import("./planners/pedestrian-a11y/csr-walk-planner");
    const result = await planCsrWalkRoute(points, {
      mode,
      avoidStairs,
      ...(avoidPoints?.length ? { avoidPoints } : {}),
      ...(context ? { context } : {}),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      allowStairsFallback,
    });
    if (result.status === "ok") {
      const matches =
        result.plans.length === points.length - 1 &&
        result.plans.every((plan, index) => {
          const geometry = plan.polyline;
          return (
            geometry.length > 0 &&
            geometry.every(
              (p) =>
                p.length === 2 &&
                Number.isFinite(p[0]) &&
                Number.isFinite(p[1]) &&
                Math.abs(p[0]) <= 180 &&
                Math.abs(p[1]) <= 90,
            ) &&
            Number.isFinite(plan.distanceM) &&
            plan.distanceM >= 0 &&
            Number.isFinite(plan.durationS) &&
            plan.durationS >= 0 &&
            haversineMeters(
              points[index].lat,
              points[index].lng,
              geometry[0][1],
              geometry[0][0],
            ) <= 0.25 &&
            haversineMeters(
              points[index + 1].lat,
              points[index + 1].lng,
              geometry[geometry.length - 1][1],
              geometry[geometry.length - 1][0],
            ) <= 0.25
          );
        });
      if (!matches)
        return {
          status: "unavailable",
          reason:
            "qualified planner output does not match the ordered walking request",
        };
    }
    return result;
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
function buildCsrWalkRoute(
  plans: readonly CsrWalkPlan[],
  mode: AccessibilityMode = "normal",
  avoidStairs = mode === "wheelchair",
  startsAt = Date.now(),
): AccessibleRoute {
  const lastIndex = plans.length - 1;
  const legs = plans.map((plan, index) =>
    walkLegFromPlan(
      plan,
      mode,
      avoidStairs,
      index === 0 ? "起點" : `中途點 ${index}`,
      index === lastIndex ? "終點" : `中途點 ${index + 1}`,
    ),
  );

  const approximateIndoorSegments = plans.reduce(
    (sum, plan) => sum + plan.approximateIndoorSegmentCount,
    0,
  );
  const totalDurationS = plans.reduce((sum, plan) => sum + plan.durationS, 0);

  const route: AccessibleRoute = {
    routeId: "csr-walk-0",
    routeName: "步行",
    totalMinutes: Math.max(1, Math.round(totalDurationS / 60)),
    transferCount: 0,
    legs,
    accessibilityHighlights: [],
    engine: "pedestrian-a11y",
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
  route.departureTime = taipeiIsoOffset(startsAt);
  route.arrivalTime = taipeiIsoOffset(startsAt + totalDurationS * 1000);
  attachInternalSchedule(
    route,
    startsAt,
    startsAt + totalDurationS * 1000,
    startsAt > Date.now(),
  );
  attachWalkingPolicy(route);
  return route;
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
  const deadline =
    opts.deadline ?? Date.now() + getRoutingConfig().planBudgetMs;
  const snapshot = opts.getSnapshot
    ? await opts.getSnapshot()
    : await getPedGraphRuntime().then((runtime) =>
        runtime.status === "ready" ? runtime.snapshot : undefined,
      );
  if (!snapshot || Date.now() >= deadline)
    return { status: "unavailable", routes: [] };
  const noFeasible = (
    candidates: readonly AccessibleRoute[],
  ): FindAccessibleRoutesResult => {
    const expired = Date.now() >= deadline;
    const blocked =
      !expired &&
      candidates.length > 0 &&
      candidates.every((route) => isRouteExcluded(route, constraints));
    return {
      status: expired ? "unavailable" : "no_route",
      routes: [],
      ...(blocked ? { blockedByAccessibility: true } : {}),
    };
  };
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
      transitPreference: opts.transitPreference,
      maxTransfers,
      mode,
      avoidStairs: constraints.avoidStairs,
      departureTime: opts.departureTime,
      deadline,
    });
    console.log(
      "[route-timing] planners",
      JSON.stringify({ otp: Date.now() - t0 }),
    );
    if (otp.status !== "ok") return otp;
    if (!otp.routes.length) return { status: "no_route", routes: [] };
    await restoreRouteStopIds(otp.routes);
    const verified = await qualifyWalkingCandidates(otp.routes, {
      origin,
      destination,
      mode,
      avoidStairs: constraints.avoidStairs,
      deadlineMs: deadline,
      context: snapshot,
      allowStairsFallback: opts.allowStairsFallback,
      completeTransitEndpoints: true,
      language: opts.language,
    });
    if (verified.status !== "ok")
      return {
        status: verified.status === "no_route" ? "no_route" : "unavailable",
        routes: [],
      };
    const routes = await finalizeRoutes(
      verified.routes,
      origin,
      destination,
      mode,
      constraints,
      opts.format,
      envPromise,
      opts.transitPreference,
      opts.language,
      opts.departureTime?.getTime() ?? opts.planningNow ?? t0,
      deadline,
    );
    if (!routes.length) return noFeasible(verified.routes);
    routes.forEach((route) => attachWalkingPolicy(route, opts.language));
    return otp.walkingBetter
      ? { status: "ok", routes, walkingBetter: true }
      : { status: "ok", routes };
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
  let cursor = opts.departureTime ?? new Date(opts.planningNow ?? Date.now());
  const segments: AccessibleRoute[] = [];
  let everySegmentWalkingBetter = true;
  for (const [from, to] of segmentPairs) {
    const result = await runOtpSegment(from, to, {
      transitPreference: opts.transitPreference,
      maxTransfers,
      mode,
      avoidStairs: constraints.avoidStairs,
      departureTime: cursor,
      deadline,
    });
    if (result.status !== "ok") return result;
    everySegmentWalkingBetter &&= result.walkingBetter === true;
    await restoreRouteStopIds(result.routes);
    const verified = await qualifyWalkingCandidates(result.routes, {
      origin: from,
      destination: to,
      mode,
      avoidStairs: constraints.avoidStairs,
      deadlineMs: deadline,
      context: snapshot,
      allowStairsFallback: opts.allowStairsFallback,
      completeTransitEndpoints: true,
      language: opts.language,
    });
    if (verified.status !== "ok")
      return {
        status: verified.status === "no_route" ? "no_route" : "unavailable",
        routes: [],
      };
    const feasible = await finalizeRoutes(
      verified.routes,
      from,
      to,
      mode,
      constraints,
      "standard",
      envPromise,
      opts.transitPreference,
      opts.language,
      cursor.getTime(),
      deadline,
    );
    const best = feasible[0];
    if (!best) return noFeasible(verified.routes);
    attachWalkingPolicy(best, opts.language);
    segments.push(best);
    const segmentEndTime = best.arrivalTime
      ? Date.parse(best.arrivalTime)
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
  await restoreRouteStopIds([combined]);
  const routes = await finalizeRoutes(
    [combined],
    origin,
    destination,
    mode,
    constraints,
    opts.format,
    envPromise,
    opts.transitPreference,
    opts.language,
    opts.departureTime?.getTime() ?? opts.planningNow ?? t0,
    deadline,
  );
  if (!routes.length) return noFeasible([combined]);
  routes.forEach((route) => attachWalkingPolicy(route, opts.language));
  return everySegmentWalkingBetter
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
    (isRouteExcluded(route, resolveA11yConstraints(request.mode, request)) &&
      !base.degraded) ||
    (route.hazardAdvisory?.blockingOnRoute ?? 0) >
      (base.hazardAdvisory?.blockingOnRoute ?? 0)
  );
}
