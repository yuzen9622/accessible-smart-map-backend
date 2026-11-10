import { z } from "zod";

export const RoadLaneDirectionSchema = z.enum([
  "none",
  "straight",
  "left",
  "slight_left",
  "sharp_left",
  "right",
  "slight_right",
  "sharp_right",
  "uturn",
  "merge_left",
  "merge_right",
]);
export const RoadRangeSchema = z
  .object({
    fromIndex: z.number().int().nonnegative(),
    toIndex: z.number().int().positive(),
  })
  .strict()
  .refine(
    (range) => range.toIndex > range.fromIndex,
    "Expected a nonempty half-open range",
  );
export const RoadSignsSchema = z
  .object({
    exitNumbers: z.array(z.string()),
    branches: z.array(z.string()),
    destinations: z.array(z.string()),
    exitNames: z.array(z.string()),
  })
  .strict();
export const RoadLaneSchema = z
  .object({
    directions: z.array(RoadLaneDirectionSchema).min(1),
    recommendation: z.enum(["preferred", "usable", "not_recommended"]),
    maneuverDirection: RoadLaneDirectionSchema.nullable(),
  })
  .strict();
export const RoadNetworkInfoSchema = z
  .object({
    tilesetId: z.string().min(1),
    sourcePbfSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    provenance: z.enum(["verified", "unverified"]),
  })
  .strict();
const range = {
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().positive(),
};
const source = z.enum(["valhalla", "osm_directional"]);
export const RoadSpeedLimitSegmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...range,
      kind: z.literal("known"),
      limitKph: z.number().finite().positive(),
      source,
    })
    .strict(),
  z
    .object({
      ...range,
      kind: z.literal("unlimited"),
      limitKph: z.null(),
      source,
    })
    .strict(),
  z
    .object({
      ...range,
      kind: z.literal("unknown"),
      limitKph: z.null(),
      source: z.null(),
    })
    .strict(),
]);
export const RoadSpeedLimitsSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      direction: z.literal("along_leg"),
      segments: z
        .array(RoadSpeedLimitSegmentSchema)
        .min(1)
        .refine(
          (segments) =>
            segments.every(
              (segment, i) =>
                segment.fromIndex === (i ? segments[i - 1].toIndex : 0) &&
                segment.toIndex > segment.fromIndex,
            ),
          "Expected contiguous nonempty speed partition from zero",
        ),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      direction: z.literal("along_leg"),
      segments: z.tuple([]),
      reason: z.enum([
        "upstream_error",
        "budget_exhausted",
        "geometry_mismatch",
        "invalid_response",
        "tileset_changed",
      ]),
    })
    .strict(),
]);
export const RoadManeuverMetadataFields = {
  beginStreetNames: z.array(z.string()).optional(),
  bearingBefore: z.number().finite().min(0).lt(360).optional(),
  bearingAfter: z.number().finite().min(0).lt(360).optional(),
  signs: RoadSignsSchema.optional(),
  lanes: z.array(RoadLaneSchema).min(1).optional(),
  laneApproachRange: RoadRangeSchema.optional(),
};
export const RoadGuidanceSchema = z
  .object({
    maneuverIndex: z.number().int().nonnegative(),
    maneuver: z.string(),
    endPolylineIndex: z.number().int().nonnegative(),
    streetNames: z.array(z.string()),
    ...RoadManeuverMetadataFields,
    /** Localized "which lanes to take" line, also appended to the step text. */
    laneHint: z.string().min(1).optional(),
  })
  .strict();
