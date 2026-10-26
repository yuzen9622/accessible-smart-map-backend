import { z } from "zod";
import bundledPolicies from "../otp/reviewed-policies.json";
import {
  ReviewedOtpWalkPolicySchema,
  type ReviewedOtpWalkPolicy,
} from "../types/otp-walk-identity";

const policiesSchema = z.array(ReviewedOtpWalkPolicySchema).min(1);

/** The Docker build verifies this bundled allowlist against the reviewed OTP package. */
export function getReviewedOtpWalkPolicies(): readonly ReviewedOtpWalkPolicy[] {
  return policiesSchema.parse(bundledPolicies);
}
