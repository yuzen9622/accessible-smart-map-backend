import { z } from "zod";
import { fetchOtpWalkPlanResponse } from "../../../adapters/otp-walk.adapter";
import { getReviewedOtpWalkPolicies } from "../../../config/otp-walk";
import { taipeiIsoLocal, taipeiIsoOffset } from "../../../config/taipei-time";
import type { AccessibleRoute, WalkLeg } from "../../../types/route";
import type { OtpWalkIdentity } from "../../../types/otp-walk-identity";
import type {
  OtpDirectWalkProfile,
  OtpDirectWalkSearch,
  OtpEndpointConstraint,
} from "../../../types/otp-walk-search";
import type {
  OtpWalkingPolicyEvidence,
  OtpWalkingSegment,
} from "../../../types/otp-walking-policy";
import { getCurrentOtpWalkingIdentity } from "../otp-walking-policy.service";
import { attachInternalSchedule } from "../route-schedule";
import { parseOtpWalkIdentity, sameOtpWalkIdentity } from "./otp-walk-identity";
import {
  parseOtpWalkEvidence,
  type OtpWalkEvidenceResult,
} from "./otp-walk-evidence";
import { parseOtpWalkSearch } from "./otp-walk-search";
import { unknownWalkA11yDetails } from "./walk-a11y";

export interface QualifiedOtpWalkOptions {
  points: readonly { lat: number; lng: number }[];
  mode: "normal" | "wheelchair";
  avoidStairs: boolean;
  allowStairsFallback?: boolean;
  departureTimeMs: number;
  deadlineMs: number;
}
type EndpointBlockedResult = {
  status: "endpoint_blocked";
  endpointConstraint: {
    pointIndex: number;
    reasons: OtpEndpointConstraint["reasons"];
  };
};
export type QualifiedOtpWalkResult =
  | { status: "ready"; route: AccessibleRoute }
  | { status: "no_route" }
  | EndpointBlockedResult
  | { status: "unavailable"; reason: string };

type QualifiedGeometry = Extract<OtpWalkEvidenceResult, { status: "ready" }>;
type SegmentSearch =
  | { status: "ready"; segment: OtpWalkingSegment; geometry: QualifiedGeometry }
  | { status: "no_route"; proof: OtpDirectWalkSearch }
  | EndpointBlockedResult
  | { status: "unavailable"; reason: string };

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});
const epochMs = z
  .number()
  .int()
  .safe()
  .min(-8_640_000_000_000_000)
  .max(8_640_000_000_000_000);
const legSchema = z.object({
  mode: z.literal("WALK"),
  duration: z.number().finite().nonnegative(),
  startTime: epochMs,
  endTime: epochMs,
  walkEvidence: z.unknown(),
});
const planDataSchema = z.object({
  requestIdentity: z.unknown(),
  plan: z.object({
    directWalkSearch: z.unknown(),
    routingErrors: z.array(z.object({ code: z.string().min(1) })),
    itineraries: z
      .array(
        z.object({
          duration: z.number().finite().nonnegative().optional(),
          legs: z.array(legSchema).length(1),
        }),
      )
      .max(1),
  }),
});

function validOptions(options: QualifiedOtpWalkOptions): boolean {
  return (
    Number.isFinite(options.deadlineMs) &&
    Number.isFinite(options.departureTimeMs) &&
    Math.abs(options.departureTimeMs) <= 8_640_000_000_000_000 &&
    (options.mode === "normal" || options.mode === "wheelchair") &&
    options.points.length >= 2 &&
    options.points.every(
      (point) =>
        Number.isFinite(point.lat) &&
        Math.abs(point.lat) <= 90 &&
        Number.isFinite(point.lng) &&
        Math.abs(point.lng) <= 180,
    )
  );
}

async function searchSegment(
  options: QualifiedOtpWalkOptions,
  identity: OtpWalkIdentity,
  index: number,
  departure: number,
  profile: OtpDirectWalkProfile,
): Promise<SegmentSearch> {
  const origin = options.points[index];
  const destination = options.points[index + 1];
  const local = taipeiIsoLocal(new Date(departure));
  const response = await fetchOtpWalkPlanResponse({
    deadlineMs: options.deadlineMs,
    origin,
    destination,
    date: local.slice(0, 10),
    time: local.slice(11),
    avoidStairs: options.avoidStairs,
    profile,
  });
  if (Date.now() >= options.deadlineMs)
    return { status: "unavailable", reason: "deadline_exceeded" };
  if (response.status !== "received") return response;
  const envelope = envelopeSchema.safeParse(response.data);
  if (!envelope.success)
    return { status: "unavailable", reason: "invalid_response" };
  if (envelope.data.errors?.length)
    return { status: "unavailable", reason: "graphql_error" };
  const data = planDataSchema.safeParse(envelope.data.data);
  if (!data.success)
    return { status: "unavailable", reason: "invalid_response" };
  const manifest = identity.buildManifestIdentity;
  const observed = parseOtpWalkIdentity(data.data.requestIdentity, {
    sourceIdentity: {
      sourceVersionId: manifest.sourceVersion,
      sourceBatch: manifest.sourceBatch,
      archiveSha256: manifest.sourceArchiveSha256,
    },
    reviewedPolicies: getReviewedOtpWalkPolicies(),
  });
  if (observed.status !== "ready") return observed;
  if (!sameOtpWalkIdentity(observed.identity, identity))
    return { status: "unavailable", reason: "identity_changed" };
  const plan = data.data.plan;
  const search = parseOtpWalkSearch(plan.directWalkSearch, {
    profile,
    avoidStairs: options.avoidStairs,
    origin,
    destination,
    departureTimeMs: departure,
  });
  if (search.status === "unavailable") return search;
  if (search.status === "endpoint_blocked") {
    const errorsMatch =
      search.constraint.phase === "LINK"
        ? plan.routingErrors.length > 0 &&
          plan.routingErrors.every(
            (error) => error.code === "LOCATION_NOT_FOUND",
          )
        : plan.routingErrors.length === 0;
    return plan.itineraries.length === 0 && errorsMatch
      ? {
          status: "endpoint_blocked",
          endpointConstraint: {
            pointIndex: index + (search.constraint.endpoint === "TO" ? 1 : 0),
            reasons: search.constraint.reasons,
          },
        }
      : { status: "unavailable", reason: "search_result_mismatch" };
  }
  if (search.status === "no_route")
    return plan.itineraries.length === 0 && plan.routingErrors.length === 0
      ? { status: "no_route", proof: search.proof }
      : { status: "unavailable", reason: "search_result_mismatch" };
  if (plan.itineraries.length !== 1 || plan.routingErrors.length > 0)
    return { status: "unavailable", reason: "search_result_mismatch" };
  const itinerary = plan.itineraries[0];
  const native = itinerary.legs[0];
  if (
    native.startTime !== departure ||
    native.endTime < native.startTime ||
    native.endTime % 1000 !== 0 ||
    native.startTime % 1000 !== 0 ||
    Math.abs(native.endTime - native.startTime - native.duration * 1000) > 1 ||
    (itinerary.duration !== undefined && itinerary.duration !== native.duration)
  )
    return { status: "unavailable", reason: "time_mismatch" };
  const geometry = parseOtpWalkEvidence(native.walkEvidence, {
    identity,
    origin: { lat: origin.lat, lon: origin.lng },
    destination: { lat: destination.lat, lon: destination.lng },
    profile,
    avoidStairs: options.avoidStairs,
  });
  if (geometry.status !== "ready") return geometry;
  if (
    profile === "WHEELCHAIR_STAIRS_ASSISTED" &&
    !geometry.evidence.edges.some(
      (edge) => edge.policyEvaluation.assistedStairs,
    )
  )
    return { status: "unavailable", reason: "assisted_stairs_missing" };
  return {
    status: "ready",
    geometry,
    segment: {
      evidence: geometry.evidence,
      search: search.proof,
      strictNoRoute: null,
      durationS: native.duration,
      startTimeMs: native.startTime,
      endTimeMs: native.endTime,
    },
  };
}

/** All strict searches complete before any stairs-assisted pass is considered. */
export async function planQualifiedOtpWalk(
  options: QualifiedOtpWalkOptions,
): Promise<QualifiedOtpWalkResult> {
  if (!validOptions(options))
    return { status: "unavailable", reason: "invalid_request" };
  const expired = (): boolean => Date.now() >= options.deadlineMs;
  const deadlineFailure: QualifiedOtpWalkResult = {
    status: "unavailable",
    reason: "deadline_exceeded",
  };
  if (expired()) return deadlineFailure;
  try {
    const initial = await getCurrentOtpWalkingIdentity(options.deadlineMs);
    if (expired()) return deadlineFailure;
    if (initial.status !== "ready") return initial;
    const identity = initial.identity;
    const firstDeparture = Math.floor(options.departureTimeMs / 1000) * 1000;
    const strictProfile =
      options.mode === "normal" ? "NORMAL" : "WHEELCHAIR_STRICT";
    const screened: {
      departure: number;
      result: Extract<SegmentSearch, { status: "ready" | "no_route" }>;
    }[] = [];
    let departure = firstDeparture;
    let noRoute = false;
    let endpointBlocked: EndpointBlockedResult | undefined;
    for (let index = 0; index < options.points.length - 1; index++) {
      if (expired()) return deadlineFailure;
      const result = await searchSegment(
        options,
        identity,
        index,
        departure,
        strictProfile,
      );
      if (result.status === "unavailable") return result;
      if (result.status === "endpoint_blocked") {
        endpointBlocked = result;
        break;
      }
      screened.push({ departure, result });
      if (result.status === "ready") departure = result.segment.endTimeMs;
      else noRoute = true;
    }
    const selected: Extract<SegmentSearch, { status: "ready" }>[] = [];
    if (!endpointBlocked && !noRoute) {
      for (const item of screened)
        if (item.result.status === "ready") selected.push(item.result);
    } else if (
      !endpointBlocked &&
      options.mode === "wheelchair" &&
      options.allowStairsFallback !== false
    ) {
      noRoute = false;
      departure = firstDeparture;
      for (const [index, item] of screened.entries()) {
        if (expired()) return deadlineFailure;
        const strict =
          item.departure === departure
            ? item.result
            : await searchSegment(
                options,
                identity,
                index,
                departure,
                strictProfile,
              );
        if (strict.status === "unavailable") return strict;
        if (strict.status === "endpoint_blocked") {
          endpointBlocked = strict;
          break;
        }
        if (strict.status === "ready") {
          selected.push(strict);
          departure = strict.segment.endTimeMs;
          continue;
        }
        const assisted = await searchSegment(
          options,
          identity,
          index,
          departure,
          "WHEELCHAIR_STAIRS_ASSISTED",
        );
        if (assisted.status === "unavailable") return assisted;
        if (assisted.status === "endpoint_blocked") {
          endpointBlocked = assisted;
          break;
        }
        if (assisted.status === "no_route") {
          noRoute = true;
          break;
        }
        assisted.segment.strictNoRoute = strict.proof;
        selected.push(assisted);
        departure = assisted.segment.endTimeMs;
      }
    }
    if (expired()) return deadlineFailure;
    const current = await getCurrentOtpWalkingIdentity(options.deadlineMs);
    if (expired()) return deadlineFailure;
    if (current.status !== "ready") return current;
    if (!sameOtpWalkIdentity(current.identity, identity))
      return { status: "unavailable", reason: "identity_changed" };
    if (endpointBlocked) return endpointBlocked;
    if (noRoute) return { status: "no_route" };
    const segments = selected.map((item) => item.segment);
    const first = segments[0];
    const last = segments.at(-1);
    if (!first || !last || segments.length !== options.points.length - 1)
      return { status: "unavailable", reason: "invalid_response" };
    const policy = (parts: OtpWalkingSegment[]): OtpWalkingPolicyEvidence => ({
      version: "otp-sidewalk-v1",
      schemaVersion: 1,
      mode: options.mode,
      avoidStairs: options.avoidStairs,
      stairsFallback: parts.some((part) => part.strictNoRoute !== null),
      fareAccess: { mode: "forbid" },
      identity,
      segments: parts,
    });
    const legs: WalkLeg[] = selected.map((item, index) => {
      const native = item.segment;
      const leg: WalkLeg = {
        type: "WALK",
        from: index === 0 ? "起點" : "中途點 " + index,
        to: index === selected.length - 1 ? "終點" : "中途點 " + (index + 1),
        distanceM: item.geometry.distanceM,
        durationS: native.durationS,
        minutesEst: Math.max(1, Math.round(native.durationS / 60)),
        polyline: item.geometry.polyline,
        a11yFacilities: [],
        exitInfo: null,
        ...unknownWalkA11yDetails(),
        walkingPolicy: policy([native]),
      };
      Object.defineProperty(leg, "_durationMs", {
        value: native.endTimeMs - native.startTimeMs,
        writable: true,
        configurable: true,
      });
      return leg;
    });
    const totalWalkDistanceM = legs.reduce(
      (sum, leg) => sum + leg.distanceM,
      0,
    );
    if (!Number.isFinite(totalWalkDistanceM) || totalWalkDistanceM < 0)
      return { status: "unavailable", reason: "invalid_evidence" };
    const route: AccessibleRoute = {
      routeId: "otp-walk-0",
      routeName: "步行",
      engine: "otp",
      totalMinutes: Math.max(
        1,
        Math.round((last.endTimeMs - first.startTimeMs) / 60_000),
      ),
      transferCount: 0,
      legs,
      accessibilityHighlights: [],
      totalWalkDistanceM,
      departureTime: taipeiIsoOffset(first.startTimeMs),
      arrivalTime: taipeiIsoOffset(last.endTimeMs),
      walkingPolicy: policy(segments),
    };
    attachInternalSchedule(
      route,
      first.startTimeMs,
      last.endTimeMs,
      first.startTimeMs > Date.now(),
    );
    return expired() ? deadlineFailure : { status: "ready", route };
  } catch {
    return expired()
      ? deadlineFailure
      : { status: "unavailable", reason: "provider_failure" };
  }
}
