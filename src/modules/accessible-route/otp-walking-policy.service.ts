import { getReviewedOtpWalkPolicies } from "../../config/otp-walk";
import type { AccessibleRoute } from "../../types/route";
import {
  OtpWalkingPolicyEvidenceSchema,
  type OtpWalkingSegment,
} from "../../types/otp-walking-policy";
import {
  fetchCurrentOtpWalkIdentity,
  sameOtpWalkIdentity,
  type OtpWalkIdentityResult,
} from "./planners/otp-walk-identity";
import { parseOtpWalkEvidence } from "./planners/otp-walk-evidence";
import { readCurrentSidewalkSourceIdentity } from "./planners/pedestrian-a11y/sidewalk-source.repository";
import { haversineMeters } from "../../utils/geo";
import {
  parseOtpWalkSearch,
  type OtpWalkSearchExpectations,
} from "./planners/otp-walk-search";

/** Resolve current source and loaded OTP identities without requiring a CSR graph. */
export async function getCurrentOtpWalkingIdentity(
  deadlineMs: number,
): Promise<OtpWalkIdentityResult> {
  const source = await readCurrentSidewalkSourceIdentity({
    deadlineMs,
    timeoutMs: 5000,
  });
  if (source.status !== "ready")
    return { status: "unavailable", reason: "source_mismatch" };
  const result = await fetchCurrentOtpWalkIdentity({
    deadlineMs,
    sourceIdentity: source.identity,
    reviewedPolicies: getReviewedOtpWalkPolicies(),
  });
  if (result.status !== "ready") return result;
  const current = await readCurrentSidewalkSourceIdentity({
    deadlineMs,
    timeoutMs: 5000,
  });
  if (
    current.status !== "ready" ||
    current.identity.sourceVersionId !== source.identity.sourceVersionId ||
    current.identity.sourceBatch !== source.identity.sourceBatch ||
    current.identity.archiveSha256 !== source.identity.archiveSha256
  )
    return { status: "unavailable", reason: "source_mismatch" };
  return result;
}

/** Recheck sealed route evidence and the provider/source currently serving it. */
export async function hasCurrentOtpWalkingPolicy(
  route: AccessibleRoute,
): Promise<boolean> {
  try {
    const parsed = OtpWalkingPolicyEvidenceSchema.safeParse(
      route.walkingPolicy,
    );
    if (!parsed.success || route.engine !== "otp" || !route.legs.length)
      return false;
    const policy = parsed.data;
    const collected: OtpWalkingSegment[] = [];
    let totalDistance = 0;
    for (const leg of route.legs) {
      if (leg.type !== "WALK") return false;
      const legPolicy = OtpWalkingPolicyEvidenceSchema.safeParse(
        leg.walkingPolicy,
      );
      if (
        !legPolicy.success ||
        legPolicy.data.mode !== policy.mode ||
        legPolicy.data.avoidStairs !== policy.avoidStairs ||
        !sameOtpWalkIdentity(legPolicy.data.identity, policy.identity)
      )
        return false;
      const points: [number, number][] = [];
      let duration = 0;
      let distance = 0;
      let legAssisted = false;
      for (const segment of legPolicy.data.segments) {
        const path = segment.evidence.selectedPath;
        if (!path.requestFrom || !path.requestTo) return false;
        const assisted = segment.strictNoRoute !== null;
        const profile =
          policy.mode === "normal"
            ? "NORMAL"
            : assisted
              ? "WHEELCHAIR_STAIRS_ASSISTED"
              : "WHEELCHAIR_STRICT";
        if (assisted && policy.mode !== "wheelchair") return false;
        const searchExpected: OtpWalkSearchExpectations = {
          profile,
          avoidStairs: policy.avoidStairs,
          origin: { lat: path.requestFrom.lat, lng: path.requestFrom.lon },
          destination: { lat: path.requestTo.lat, lng: path.requestTo.lon },
          departureTimeMs: segment.startTimeMs,
        };
        const search = parseOtpWalkSearch(segment.search, searchExpected);
        if (search.status !== "found") return false;
        if (
          segment.strictNoRoute !== null &&
          parseOtpWalkSearch(segment.strictNoRoute, {
            ...searchExpected,
            profile: "WHEELCHAIR_STRICT",
          }).status !== "no_route"
        )
          return false;
        const result = parseOtpWalkEvidence(segment.evidence, {
          identity: policy.identity,
          origin: path.requestFrom,
          destination: path.requestTo,
          profile,
          avoidStairs: policy.avoidStairs,
        });
        if (result.status !== "ready") return false;
        if (
          assisted &&
          !result.evidence.edges.some(
            (edge) => edge.policyEvaluation.assistedStairs,
          )
        )
          return false;
        legAssisted ||= assisted;
        const previous = collected.at(-1);
        if (previous) {
          const last = previous.evidence.selectedPath.requestTo;
          if (
            !last ||
            haversineMeters(
              last.lat,
              last.lon,
              path.requestFrom.lat,
              path.requestFrom.lon,
            ) > 0.25 ||
            Math.abs(previous.endTimeMs - segment.startTimeMs) > 1
          )
            return false;
        }
        points.push(...result.polyline);
        distance += result.distanceM;
        duration += segment.durationS;
        collected.push(segment);
      }
      if (
        legPolicy.data.stairsFallback !== legAssisted ||
        !Number.isFinite(duration) ||
        !Number.isFinite(distance) ||
        leg.durationS === undefined ||
        !Number.isFinite(leg.durationS) ||
        !Number.isFinite(leg.distanceM) ||
        Math.abs(duration - leg.durationS) > 1e-9 ||
        Math.abs(distance - leg.distanceM) > 1e-6 ||
        points.length !== leg.polyline.length ||
        points.some(
          (point, index) =>
            point[0] !== leg.polyline[index][0] ||
            point[1] !== leg.polyline[index][1],
        )
      )
        return false;
      totalDistance += distance;
    }
    if (
      JSON.stringify(collected) !== JSON.stringify(policy.segments) ||
      policy.stairsFallback !==
        collected.some((segment) => segment.strictNoRoute !== null)
    )
      return false;
    const first = collected[0];
    const last = collected.at(-1);
    if (
      !first ||
      !last ||
      !Number.isFinite(totalDistance) ||
      route.totalWalkDistanceM === undefined ||
      !Number.isFinite(route.totalWalkDistanceM) ||
      Math.abs(route.totalWalkDistanceM - totalDistance) > 1e-6 ||
      Date.parse(route.departureTime ?? "") !== first.startTimeMs ||
      Date.parse(route.arrivalTime ?? "") !== last.endTimeMs ||
      route.totalMinutes !==
        Math.max(1, Math.round((last.endTimeMs - first.startTimeMs) / 60_000))
    )
      return false;
    const current = await getCurrentOtpWalkingIdentity(Date.now() + 5000);
    return (
      current.status === "ready" &&
      sameOtpWalkIdentity(policy.identity, current.identity)
    );
  } catch {
    return false;
  }
}
