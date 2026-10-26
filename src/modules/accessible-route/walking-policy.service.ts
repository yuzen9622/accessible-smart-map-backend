import type {
  AccessibilityMode,
  AccessibleRoute,
  WalkLeg,
  WalkingPolicyEvidence,
  WalkingFareAccess,
  CsrWalkingPolicyEvidence,
} from "../../types/route";
import type {
  CsrWalkPlan,
  CsrWalkResult,
} from "./planners/pedestrian-a11y/csr-walk.types";
import type { PedGraphSnapshot } from "./planners/pedestrian-a11y/graph-runtime";
import {
  getPedGraphRuntime,
  isPedGraphSnapshotCurrent,
  getPedGraphClient,
} from "./planners/pedestrian-a11y/graph-runtime";
import { findPedStopNodeId } from "./planners/pedestrian-a11y/ped-graph-geometry.repository";
import { denseId } from "./planners/pedestrian-a11y/endpoint-routing";
import {
  createTransitAuthorizedFareAccess,
  FORBID_FARE_ACCESS,
} from "./planners/pedestrian-a11y/fare-access";
import { planCsrWalkRoute } from "./planners/pedestrian-a11y/csr-walk-planner";
import { copyWithDescriptors } from "../../utils/route-source-names";
import { haversineMeters } from "../../utils/geo";
import { ROUTE_WARNING } from "../../constants/messages";
import { taipeiIsoOffset } from "../../config/taipei-time";
import { presentRouteMessages, routeMessage } from "../../utils/route-messages";
import type { SupportedLang } from "../../types/lang";
import { sameOtpWalkIdentity } from "./planners/otp-walk-identity";
import { hasCurrentOtpWalkingPolicy } from "./otp-walking-policy.service";

interface Point {
  lat: number;
  lng: number;
  stopId?: string;
}

function railStopId(
  leg: AccessibleRoute["legs"][number] | undefined,
  side: "departure" | "arrival",
): string | undefined {
  if (leg?.type === "METRO")
    return side === "departure"
      ? leg.departureStationUid
      : leg.arrivalStationUid;
  if (leg?.type === "TRA" || leg?.type === "THSR")
    return side === "departure"
      ? leg.departureStationUID
      : leg.arrivalStationUID;
  return undefined;
}

async function knownRailStop(
  context: PedGraphSnapshot,
  stopId: string | undefined,
): Promise<{ stopId: string; stationId?: string } | undefined> {
  if (!stopId) return undefined;
  const raw = await findPedStopNodeId(
    await getPedGraphClient(),
    context.graph.versionId,
    stopId,
  );
  if (raw === undefined) return undefined; // Legacy provider identity: outdoor only, never guessed indoor.
  const node = denseId(context.graph.originalNodeId, raw);
  const stationId = context.graph.stationIds[context.graph.nodeStationId[node]];
  return { stopId, ...(stationId ? { stationId } : {}) };
}

async function fareForStops(
  context: PedGraphSnapshot,
  stopIds: readonly (string | undefined)[],
): Promise<WalkingFareAccess> {
  const stops = await Promise.all(
    stopIds.map((id) => knownRailStop(context, id)),
  );
  const stations = stops.flatMap((s) => (s?.stationId ? [s.stationId] : []));
  return stations.length
    ? createTransitAuthorizedFareAccess(stations)
    : FORBID_FARE_ACCESS;
}
interface WalkRequest {
  allowStairsFallback?: boolean;
  mode: AccessibilityMode;
  avoidStairs: boolean;
  deadlineMs: number;
  context?: PedGraphSnapshot;
  getSnapshot?: () => Promise<PedGraphSnapshot | undefined>;
  departureTimeMs?: number;
}
export interface WalkingCandidateOptions extends WalkRequest {
  origin: Point;
  destination: Point;
  completeTransitEndpoints?: boolean;
  language?: SupportedLang;
}
export type WalkingCandidateResult =
  | { status: "ok"; routes: AccessibleRoute[] }
  | { status: "unavailable" | "budget_exhausted" | "no_route"; routes: [] };

export function walkLegFromPlan(
  plan: CsrWalkPlan,
  mode: AccessibilityMode,
  avoidStairs: boolean,
  from: string,
  to: string,
): WalkLeg & { walkingPolicy: CsrWalkingPolicyEvidence } {
  const leg: WalkLeg & { walkingPolicy: CsrWalkingPolicyEvidence } = {
    type: "WALK",
    from,
    to,
    distanceM: plan.distanceM,
    minutesEst: Math.max(1, Math.round(plan.durationS / 60)),
    durationS: plan.durationS,
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
    walkingPolicy: {
      ...plan.policy,
      graphVersionId: plan.graphVersionId,
      mode,
      avoidStairs,
      stairsFallback: plan.stairsFallback,
      selectedEdgeIds: plan.selectedEdgeIds,
      ...(plan.fareAccess ? { fareAccess: plan.fareAccess } : {}),
    },
  };
  Object.defineProperty(leg, "_durationMs", {
    value: plan.durationS * 1000,
    writable: true,
    configurable: true,
  });
  return leg;
}

export function combineWalkingPolicy(
  legs: readonly WalkLeg[],
): WalkingPolicyEvidence | undefined {
  const first = legs[0]?.walkingPolicy;
  if (!first || legs.some((leg) => !sameSource(first, leg.walkingPolicy)))
    return undefined;
  if (first.version === "otp-sidewalk-v1") {
    return {
      ...first,
      stairsFallback: legs.some((leg) => leg.walkingPolicy?.stairsFallback),
      segments: legs.flatMap((leg) =>
        leg.walkingPolicy?.version === "otp-sidewalk-v1"
          ? leg.walkingPolicy.segments
          : [],
      ),
    };
  }
  const fares = legs.flatMap((leg) =>
    leg.walkingPolicy?.fareAccess ? [leg.walkingPolicy.fareAccess] : [],
  );
  const stations = fares.flatMap((fare) =>
    fare.mode === "transit_authorized" ? [...fare.authorizedStationIds] : [],
  );
  return {
    ...first,
    ...(fares.length
      ? {
          fareAccess: stations.length
            ? createTransitAuthorizedFareAccess(stations)
            : FORBID_FARE_ACCESS,
        }
      : {}),
    stairsFallback: legs.some((leg) => leg.walkingPolicy?.stairsFallback),
    selectedEdgeIds: [
      ...new Set(
        legs.flatMap((leg) =>
          leg.walkingPolicy?.version === "sidewalk-v1"
            ? leg.walkingPolicy.selectedEdgeIds
            : [],
        ),
      ),
    ],
  };
}

export function attachWalkingPolicy(
  route: AccessibleRoute,
  language?: SupportedLang,
): void {
  const legs = route.legs.filter((leg): leg is WalkLeg => leg.type === "WALK");
  if (!legs.length) return;
  const combined = combineWalkingPolicy(legs);
  if (!combined) {
    throw new Error(
      "walking route contains missing or mixed source-policy evidence",
    );
  }
  route.walkingPolicy = combined;
  if (!route.walkingPolicy.stairsFallback) return;
  annotateStairsAssistance(route, language);
}

export function annotateStairsAssistance(
  route: AccessibleRoute,
  language?: SupportedLang,
): void {
  const message = routeMessage(
    "ROUTE_WHEELCHAIR_STAIRS_FALLBACK",
    ROUTE_WARNING.WHEELCHAIR_STAIRS_FALLBACK,
  );
  route.warnings = [
    ...new Set([...(route.warnings ?? []), message.legacyMessage]),
  ];
  route._warningMessages = [
    ...(route._warningMessages ?? []).filter(
      (entry) => entry.code !== message.code,
    ),
    message,
  ];
  route.accessibilityLabel = "critical";
  const summary = routeMessage(
    "ROUTE_WHEELCHAIR_STAIRS_FALLBACK_SUMMARY",
    ROUTE_WARNING.WHEELCHAIR_STAIRS_FALLBACK_SUMMARY,
  );
  route.accessibilitySummary = presentRouteMessages(
    [summary.legacyMessage],
    [summary],
    language,
  ).messages[0];
}

function sameSource(
  a: WalkingPolicyEvidence,
  b: WalkingPolicyEvidence | undefined,
): boolean {
  if (a.version === "otp-sidewalk-v1")
    return (
      b?.version === "otp-sidewalk-v1" &&
      a.mode === b.mode &&
      a.avoidStairs === b.avoidStairs &&
      a.fareAccess.mode === b.fareAccess.mode &&
      sameOtpWalkIdentity(a.identity, b.identity)
    );
  return (
    !!b &&
    b.version === "sidewalk-v1" &&
    a.graphVersionId === b.graphVersionId &&
    a.sourceVersionId === b.sourceVersionId &&
    a.sourceArchiveSha256 === b.sourceArchiveSha256 &&
    a.osmSha256 === b.osmSha256 &&
    a.mode === b.mode &&
    a.avoidStairs === b.avoidStairs &&
    a.omissionPolicyVersion === b.omissionPolicyVersion &&
    a.omissionPolicySha256 === b.omissionPolicySha256
  );
}

function coordinate(value: readonly number[] | undefined): Point | undefined {
  return value &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
    ? { lng: value[0], lat: value[1] }
    : undefined;
}
function separated(a: Point, b: Point): boolean {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) > 0.25;
}

export async function qualifyWalkingCandidates(
  candidates: readonly AccessibleRoute[],
  options: WalkingCandidateOptions,
): Promise<WalkingCandidateResult> {
  const requiresGraph =
    options.completeTransitEndpoints ||
    candidates.some(
      (route) =>
        route._walkAccessRequests?.length ||
        route.legs.some((leg) => leg.type === "WALK"),
    );
  if (!requiresGraph)
    return {
      status: "ok",
      routes: candidates.map((route) => {
        if (!route._walkAccessRequests) return route;
        const fulfilled = copyWithDescriptors(route, {});
        delete fulfilled._walkAccessRequests;
        return fulfilled;
      }),
    };
  if (Date.now() >= options.deadlineMs)
    return { status: "budget_exhausted", routes: [] };
  let context = options.context;
  if (!context && options.getSnapshot) {
    context = await options.getSnapshot();
    if (!context) return { status: "unavailable", routes: [] };
  }
  if (!context) {
    const runtime = await getPedGraphRuntime();
    if (runtime.status !== "ready")
      return { status: "unavailable", routes: [] };
    context = runtime.snapshot;
  }
  if (!context.graph.qualification)
    return { status: "unavailable", routes: [] };
  const routes: AccessibleRoute[] = [];
  let temporaryFailure: "unavailable" | "budget_exhausted" | undefined;
  for (const route of candidates) {
    let cursor: Point = options.origin;
    const legs: AccessibleRoute["legs"] = [];
    const requests = route._walkAccessRequests ?? [];
    const accessWalks: { request: (typeof requests)[number]; leg: WalkLeg }[] =
      [];
    let requestIndex = 0;
    let failed = false;
    const addWalk = async (
      to: Point,
      fromLabel: string,
      toLabel: string,
      original?: WalkLeg,
    ) => {
      let fareAccess: WalkingFareAccess;
      try {
        fareAccess = requests.length
          ? FORBID_FARE_ACCESS
          : await fareForStops(context, [cursor.stopId, to.stopId]);
      } catch {
        failed = true;
        temporaryFailure = "unavailable";
        return;
      }
      const planned: CsrWalkResult = await planCsrWalkRoute([cursor, to], {
        fareAccess,
        mode: options.mode,
        avoidStairs: options.avoidStairs,
        allowStairsFallback: options.allowStairsFallback,
        deadlineMs: options.deadlineMs,
        context,
      });
      if (planned.status !== "ok") {
        failed = true;
        if (
          planned.status === "budget_exhausted" ||
          planned.status === "unavailable"
        )
          temporaryFailure = planned.status;
        return;
      }
      const mapped = walkLegFromPlan(
        planned.plans[0],
        options.mode,
        options.avoidStairs,
        fromLabel,
        toLabel,
      );
      if (original) {
        for (const key of [
          "fromNameEn",
          "toNameEn",
          "fromDisplayName",
          "toDisplayName",
        ] as const)
          if (original[key]) mapped[key] = original[key];
      }
      legs.push(mapped);
      cursor = to;
    };
    const fulfill = async (index: number) => {
      while (!failed && requestIndex < requests.length) {
        const request = requests[requestIndex];
        if (request.beforeLegIndex > index) break;
        if (
          request.beforeLegIndex !== index ||
          separated(cursor, request.fromAnchor)
        ) {
          failed = true;
          temporaryFailure = "unavailable";
          break;
        }
        requestIndex++;
        await addWalk(request.toAnchor, request.from, request.to);
        if (!failed)
          accessWalks.push({ request, leg: legs.at(-1)! as WalkLeg });
      }
    };
    for (const [index, leg] of route.legs.entries()) {
      await fulfill(index);
      if (failed) break;
      if (leg.type === "WALK") {
        const target =
          index === route.legs.length - 1
            ? options.destination
            : coordinate(leg.polyline.at(-1));
        if (!target) {
          failed = true;
          break;
        }
        try {
          const stop = await knownRailStop(
            context,
            railStopId(route.legs[index + 1], "departure"),
          );
          if (stop) target.stopId = stop.stopId;
        } catch {
          failed = true;
          temporaryFailure = "unavailable";
          break;
        }
        await addWalk(target, leg.from, leg.to, leg);
        continue;
      }
      if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") {
        if (
          requests.some((r) => r.beforeLegIndex === index) &&
          separated(cursor, leg.from)
        ) {
          failed = true;
          temporaryFailure = "unavailable";
          break;
        }
        legs.push(leg);
        const target = coordinate(leg.polyline.at(-1));
        if (!target) {
          failed = true;
          break;
        }
        cursor = target;
        continue;
      }
      const departure = coordinate(leg.polyline[0]);
      const arrival = coordinate(leg.polyline.at(-1));
      if (!departure || !arrival) {
        failed = true;
        break;
      }
      try {
        const fromStop = await knownRailStop(
          context,
          railStopId(leg, "departure"),
        );
        const toStop = await knownRailStop(context, railStopId(leg, "arrival"));
        if (fromStop) departure.stopId = fromStop.stopId;
        if (toStop) arrival.stopId = toStop.stopId;
      } catch {
        failed = true;
        temporaryFailure = "unavailable";
        break;
      }
      if (separated(cursor, departure) || cursor.stopId !== departure.stopId)
        await addWalk(departure, "起點", "上車處");
      if (failed) break;
      legs.push(leg);
      cursor = arrival;
    }
    await fulfill(route.legs.length);
    if (!failed && requestIndex !== requests.length) {
      failed = true;
      temporaryFailure = "unavailable";
    }
    if (
      !failed &&
      options.completeTransitEndpoints &&
      (separated(cursor, options.destination) || cursor.stopId)
    )
      await addWalk(options.destination, "下車處", "終點");
    if (failed) continue;
    const qualified = copyWithDescriptors(route, { legs });
    delete qualified._walkAccessRequests;
    qualified.accessibilityHighlights = [
      ...(qualified.accessibilityHighlights ?? []),
    ];
    qualified._accessibilityHighlightMessages = [
      ...(qualified._accessibilityHighlightMessages ?? []),
    ];
    const groups = new Map<
      string,
      { request: (typeof requests)[number]; distanceM: number }
    >();
    for (const { request, leg } of accessWalks) {
      const key = `${request.role}:${request.waypointIndex ?? ""}`;
      const group = groups.get(key);
      if (group) group.distanceM += leg.distanceM;
      else groups.set(key, { request, distanceM: leg.distanceM });
    }
    for (const { request, distanceM } of groups.values()) {
      const label = `中途點 ${request.waypointIndex}`;
      const code =
        request.role === "origin"
          ? "ROUTE_WALK_FROM_ORIGIN"
          : request.role === "destination"
            ? "ROUTE_WALK_TO_DESTINATION"
            : "ROUTE_WALK_WAYPOINT_PARKING";
      const text =
        request.role === "origin"
          ? `起點需步行約 ${distanceM} 公尺至可上車路段`
          : request.role === "destination"
            ? `於終點前約 ${distanceM} 公尺處停車，需步行至目的地`
            : `${label} 需步行約 ${distanceM} 公尺往返停車處`;
      qualified.accessibilityHighlights.push(text);
      qualified._accessibilityHighlightMessages.push(
        routeMessage(code, text, {
          distanceM,
          ...(request.role === "waypoint"
            ? {
                placeLabel: label,
                placeRole: "waypoint",
                waypointIndex: request.waypointIndex!,
              }
            : {}),
        }),
      );
    }
    if (legs.length > 0 && legs.every((leg) => leg.type === "WALK"))
      qualified.engine = "pedestrian-a11y";
    attachWalkingPolicy(qualified, options.language);
    qualified.totalWalkDistanceM = legs.reduce(
      (sum, leg) => sum + (leg.type === "WALK" ? leg.distanceM : 0),
      0,
    );
    recomputeRoadClock(qualified, options.departureTimeMs);
    routes.push(qualified);
  }
  if (!routes.length)
    return { status: temporaryFailure ?? "no_route", routes: [] };
  const stepFree = routes.filter(
    (route) => !route.walkingPolicy?.stairsFallback,
  );
  if (!stepFree.length && options.mode === "wheelchair" && temporaryFailure)
    return { status: temporaryFailure, routes: [] };
  return { status: "ok", routes: stepFree.length ? stepFree : routes };
}

/** Preserve exact selected walking seconds; road providers expose only minute precision. */
export function recomputeRoadClock(
  route: AccessibleRoute,
  departureTimeMs?: number,
): void {
  if (
    !route.legs.every(
      (leg) =>
        leg.type === "WALK" ||
        leg.type === "DRIVE" ||
        leg.type === "MOTORCYCLE",
    )
  )
    return;
  const durationMs = route.legs.reduce(
    (sum, leg) =>
      sum +
      (leg.type === "WALK"
        ? (leg.durationS ?? leg.minutesEst * 60) * 1000
        : leg.type === "DRIVE" || leg.type === "MOTORCYCLE"
          ? (leg.durationInTrafficMin ?? leg.durationMin) * 60000
          : 0),
    0,
  );
  const declaredStart = route.departureTime
    ? Date.parse(route.departureTime)
    : NaN;
  const start =
    departureTimeMs ??
    route._scheduledDepartureTime ??
    (Number.isFinite(declaredStart) ? declaredStart : Date.now());
  route.totalMinutes = Math.max(1, Math.round(durationMs / 60000));
  route.departureTime = taipeiIsoOffset(start);
  route.arrivalTime = taipeiIsoOffset(start + durationMs);
  route._scheduledDepartureTime = start;
  route._scheduledEndTime = start + durationMs;
}

function fareKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fare = value as { mode?: unknown; authorizedStationIds?: unknown };
  if (fare.mode === "forbid")
    return fare.authorizedStationIds === undefined ? '["forbid"]' : undefined;
  if (
    fare.mode !== "transit_authorized" ||
    !Array.isArray(fare.authorizedStationIds) ||
    !fare.authorizedStationIds.length ||
    fare.authorizedStationIds.some(
      (id) => typeof id !== "string" || !id.length || id.trim() !== id,
    )
  )
    return undefined;
  const normalized = createTransitAuthorizedFareAccess(
    fare.authorizedStationIds,
  );
  if (
    JSON.stringify(normalized.authorizedStationIds) !==
    JSON.stringify(fare.authorizedStationIds)
  )
    return undefined;
  return JSON.stringify([fare.mode, ...normalized.authorizedStationIds]);
}

export async function hasCurrentWalkingPolicy(
  route: AccessibleRoute,
): Promise<boolean> {
  if (route._walkAccessRequests?.length) return false;
  const legs = route.legs.filter((leg): leg is WalkLeg => leg.type === "WALK");
  if (!legs.length) return route.walkingPolicy === undefined;
  const policy = route.walkingPolicy;
  if (policy?.version === "otp-sidewalk-v1")
    return hasCurrentOtpWalkingPolicy(route);
  if (
    !policy ||
    policy.version !== "sidewalk-v1" ||
    legs.some(
      (leg) =>
        !sameSource(policy, leg.walkingPolicy) ||
        !Number.isFinite(leg.durationS) ||
        (leg.distanceM > 0 &&
          (leg.walkingPolicy?.version !== "sidewalk-v1" ||
            !leg.walkingPolicy.selectedEdgeIds.length)),
    )
  )
    return false;
  if (
    !["normal", "wheelchair", "elderly", "visual_impaired"].includes(
      policy.mode,
    ) ||
    typeof policy.avoidStairs !== "boolean"
  )
    return false;
  const hasFare =
    policy.fareAccess !== undefined ||
    legs.some((leg) => leg.walkingPolicy?.fareAccess !== undefined);
  if (
    hasFare &&
    (fareKey(policy.fareAccess) === undefined ||
      legs.some((leg) => fareKey(leg.walkingPolicy?.fareAccess) === undefined))
  )
    return false;
  const runtime = await getPedGraphRuntime();
  if (
    runtime.status !== "ready" ||
    !(await isPedGraphSnapshotCurrent(runtime.snapshot))
  )
    return false;
  if (hasFare) {
    try {
      for (const [index, leg] of route.legs.entries()) {
        if (leg.type !== "WALK") continue;
        const expected = await fareForStops(runtime.snapshot, [
          railStopId(route.legs[index - 1], "arrival"),
          railStopId(route.legs[index + 1], "departure"),
        ]);
        if (fareKey(leg.walkingPolicy?.fareAccess) !== fareKey(expected))
          return false;
      }
      if (
        fareKey(policy.fareAccess) !==
        fareKey(combineWalkingPolicy(legs)?.fareAccess)
      )
        return false;
    } catch {
      return false;
    }
  }
  const graph = runtime.snapshot.graph;
  const current = graph.qualification;
  return (
    !!current &&
    policy.graphVersionId === graph.versionId &&
    policy.sourceVersionId === current.sourceVersionId &&
    policy.sourceArchiveSha256 === current.sourceArchiveSha256 &&
    policy.osmSha256 === current.osmSha256 &&
    policy.omissionPolicyVersion === current.omissionPolicyVersion &&
    policy.omissionPolicySha256 === current.omissionPolicySha256
  );
}
