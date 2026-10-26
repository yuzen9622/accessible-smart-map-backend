import { z } from "zod";

export const OtpDirectWalkProfileSchema = z.enum([
  "NORMAL",
  "WHEELCHAIR_STRICT",
  "WHEELCHAIR_STAIRS_ASSISTED",
]);
export type OtpDirectWalkProfile = z.infer<typeof OtpDirectWalkProfileSchema>;

export const OtpExecutedWalkPolicySchema = z.strictObject({
  schemaVersion: z.literal("1"),
  scope: z.literal("DIRECT_WALK_ONLY"),
  profile: OtpDirectWalkProfileSchema,
  wheelchairEnabled: z.boolean(),
  walkSpeedMps: z.number().finite().positive(),
  stairsReluctance: z.number().finite().min(1),
  minimumKnownWidthM: z.number().finite().positive().nullable(),
  maximumKnownNonStairSlopeRatio: z.number().finite().nonnegative().nullable(),
  fareAccess: z.literal("FORBID"),
});
export type OtpExecutedWalkPolicy = z.infer<typeof OtpExecutedWalkPolicySchema>;

const searchStatuses = [
  "FOUND",
  "COMPLETED_NO_ROUTE",
  "NOT_EXECUTED",
  "NOT_EXECUTED_LIMIT",
  "TIMEOUT",
  "INCOMPLETE",
  "ERROR",
] as const;

export const OtpEndpointConstraintSchema = z
  .strictObject({
    scope: z.literal("SELECTED_ENDPOINT_ATTACHMENT"),
    endpoint: z.enum(["FROM", "TO"]),
    phase: z.enum(["LINK", "TERMINAL_CUT"]),
    reasons: z
      .array(z.enum(["KNOWN_WIDTH", "KNOWN_NON_STAIR_SLOPE"]))
      .min(1)
      .max(2)
      .refine((reasons) => new Set(reasons).size === reasons.length),
    blockedCandidateCount: z.number().int().safe().positive(),
  })
  .refine(
    (value) =>
      value.phase !== "LINK" ||
      (value.reasons.length === 1 && value.reasons[0] === "KNOWN_WIDTH"),
  )
  .refine((value) => value.phase !== "TERMINAL_CUT" || value.endpoint === "TO");
export type OtpEndpointConstraint = z.infer<typeof OtpEndpointConstraintSchema>;

const searchFields = {
  nativeOutcome: z.enum([
    "TARGET_REACHED",
    "EXHAUSTED",
    "TIMEOUT",
    "TERMINATED",
    "ERROR",
    "NOT_STARTED",
    "DISTANCE_LIMIT",
  ]),
  executedPolicy: OtpExecutedWalkPolicySchema,
  fromLat: z.number().finite().min(-90).max(90),
  fromLon: z.number().finite().min(-180).max(180),
  toLat: z.number().finite().min(-90).max(90),
  toLon: z.number().finite().min(-180).max(180),
  departureTimeMs: z
    .number()
    .int()
    .safe()
    .min(-8_640_000_000_000_000)
    .max(8_640_000_000_000_000)
    .refine((value) => value % 1000 === 0),
  maximumSearchDurationS: z.number().finite().positive(),
  streetSearchTimeoutS: z.number().finite().positive(),
  durationLimitPruned: z.boolean(),
};

export const OtpDirectWalkSearchSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    schemaVersion: z.literal("1"),
    status: z.enum(searchStatuses),
    ...searchFields,
  }),
  z
    .strictObject({
      schemaVersion: z.literal("2"),
      status: z.enum([...searchStatuses, "ENDPOINT_CONSTRAINT_BLOCKED"]),
      ...searchFields,
      endpointConstraint: OtpEndpointConstraintSchema.nullable(),
    })
    .refine((proof) =>
      proof.status === "ENDPOINT_CONSTRAINT_BLOCKED"
        ? proof.endpointConstraint !== null &&
          proof.nativeOutcome === "NOT_STARTED" &&
          !proof.durationLimitPruned &&
          proof.executedPolicy.profile !== "NORMAL" &&
          proof.executedPolicy.wheelchairEnabled
        : proof.endpointConstraint === null,
    ),
]);
export type OtpDirectWalkSearch = z.infer<typeof OtpDirectWalkSearchSchema>;
