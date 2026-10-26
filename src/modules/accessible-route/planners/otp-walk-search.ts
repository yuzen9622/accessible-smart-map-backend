import { WALK_SPEED_MPS } from "../../../config/routing";
import {
  OtpDirectWalkSearchSchema,
  type OtpDirectWalkProfile,
  type OtpDirectWalkSearch,
  type OtpExecutedWalkPolicy,
  type OtpEndpointConstraint,
} from "../../../types/otp-walk-search";

export interface OtpWalkSearchExpectations {
  profile: OtpDirectWalkProfile;
  avoidStairs: boolean;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  departureTimeMs: number;
}

export function matchesExecutedWalkPolicy(
  policy: OtpExecutedWalkPolicy,
  expected: Pick<OtpWalkSearchExpectations, "profile" | "avoidStairs">,
): boolean {
  const wheelchair = expected.profile !== "NORMAL";
  return (
    policy.profile === expected.profile &&
    policy.wheelchairEnabled === wheelchair &&
    policy.walkSpeedMps ===
      (wheelchair ? WALK_SPEED_MPS.wheelchair : WALK_SPEED_MPS.normal) &&
    policy.stairsReluctance === (wheelchair || expected.avoidStairs ? 12 : 1) &&
    policy.minimumKnownWidthM === (wheelchair ? 0.9 : null) &&
    policy.maximumKnownNonStairSlopeRatio === (wheelchair ? 0.12 : null) &&
    policy.fareAccess === "FORBID"
  );
}

/** A provider limit or timeout never authorizes the stairs-assisted pass. */
export function parseOtpWalkSearch(
  value: unknown,
  expected: OtpWalkSearchExpectations,
):
  | { status: "found" | "no_route"; proof: OtpDirectWalkSearch }
  | {
      status: "endpoint_blocked";
      proof: OtpDirectWalkSearch;
      constraint: OtpEndpointConstraint;
    }
  | { status: "unavailable"; reason: string } {
  const parsed = OtpDirectWalkSearchSchema.safeParse(value);
  if (!parsed.success)
    return { status: "unavailable", reason: "invalid_search_evidence" };
  const proof = parsed.data;
  if (!matchesExecutedWalkPolicy(proof.executedPolicy, expected))
    return { status: "unavailable", reason: "search_profile_mismatch" };
  if (
    proof.fromLat !== expected.origin.lat ||
    proof.fromLon !== expected.origin.lng ||
    proof.toLat !== expected.destination.lat ||
    proof.toLon !== expected.destination.lng ||
    proof.departureTimeMs !== expected.departureTimeMs
  )
    return { status: "unavailable", reason: "search_request_mismatch" };
  if (proof.status === "FOUND" && proof.nativeOutcome === "TARGET_REACHED")
    return { status: "found", proof };
  if (
    proof.schemaVersion === "2" &&
    proof.status === "ENDPOINT_CONSTRAINT_BLOCKED" &&
    proof.endpointConstraint !== null
  )
    return {
      status: "endpoint_blocked",
      proof,
      constraint: proof.endpointConstraint,
    };
  if (
    proof.status === "COMPLETED_NO_ROUTE" &&
    proof.nativeOutcome === "EXHAUSTED" &&
    !proof.durationLimitPruned
  )
    return { status: "no_route", proof };
  return { status: "unavailable", reason: "search_not_complete" };
}
