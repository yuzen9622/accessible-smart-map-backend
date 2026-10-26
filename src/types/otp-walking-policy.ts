import { z } from "zod";
import { OtpWalkIdentitySchema } from "./otp-walk-identity";
import { OtpWalkEvidenceSchema } from "./otp-walk-evidence";
import { OtpDirectWalkSearchSchema } from "./otp-walk-search";

export const OtpWalkingSegmentSchema = z
  .strictObject({
    evidence: OtpWalkEvidenceSchema,
    search: OtpDirectWalkSearchSchema,
    strictNoRoute: OtpDirectWalkSearchSchema.nullable(),
    durationS: z.number().finite().nonnegative(),
    startTimeMs: z.number().int().safe(),
    endTimeMs: z.number().int().safe(),
  })
  .refine(
    (segment) =>
      Math.abs(
        segment.endTimeMs - segment.startTimeMs - segment.durationS * 1000,
      ) <= 1,
    "Native leg duration and timestamps disagree",
  );

export const OtpWalkingPolicyEvidenceSchema = z.strictObject({
  version: z.literal("otp-sidewalk-v1"),
  schemaVersion: z.literal(1),
  mode: z.enum(["normal", "wheelchair"]),
  avoidStairs: z.boolean(),
  stairsFallback: z.boolean(),
  fareAccess: z.strictObject({ mode: z.literal("forbid") }),
  identity: OtpWalkIdentitySchema,
  // Keep traversal order and repeated edges, including waypoint boundaries.
  segments: z.array(OtpWalkingSegmentSchema).min(1),
});

export type OtpWalkingSegment = z.infer<typeof OtpWalkingSegmentSchema>;
export type OtpWalkingPolicyEvidence = z.infer<
  typeof OtpWalkingPolicyEvidenceSchema
>;
