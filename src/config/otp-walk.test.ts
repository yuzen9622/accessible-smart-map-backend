import { describe, expect, it } from "vitest";
import native from "../../tests/fixtures/otp-walk-endpoint-refusal-current-native.json";
import { parseOtpWalkIdentity } from "../modules/accessible-route/planners/otp-walk-identity";
import { getReviewedOtpWalkPolicies } from "./otp-walk";

describe("bundled reviewed OTP policies", () => {
  const identity = native.response.data.requestIdentity;
  const source = identity.buildManifestIdentity;
  const sourceIdentity = {
    sourceVersionId: source.sourceVersion,
    sourceBatch: source.sourceBatch,
    archiveSha256: source.sourceArchiveSha256,
  };

  it("accepts the reviewed native package without deployment configuration", () => {
    expect(
      parseOtpWalkIdentity(identity, {
        sourceIdentity,
        reviewedPolicies: getReviewedOtpWalkPolicies(),
      }).status,
    ).toBe("ready");
  });

  it("rejects an OTP runtime whose policy is not bundled with this backend", () => {
    const changed = structuredClone(identity);
    changed.runtimePolicyIdentity.manifestSha256 = "a".repeat(64);
    expect(
      parseOtpWalkIdentity(changed, {
        sourceIdentity,
        reviewedPolicies: getReviewedOtpWalkPolicies(),
      }),
    ).toEqual({ status: "unavailable", reason: "policy_not_reviewed" });
  });

  it("does not let callers mutate the bundled trust configuration", () => {
    const policies = getReviewedOtpWalkPolicies();
    policies[0].manifestSha256 = "a".repeat(64);
    expect(getReviewedOtpWalkPolicies()[0].manifestSha256).toBe(
      identity.runtimePolicyIdentity.manifestSha256,
    );
  });
});
