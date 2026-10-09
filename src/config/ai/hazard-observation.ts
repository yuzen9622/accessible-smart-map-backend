import { z } from "zod";

const observationText = z.string().trim().min(1).max(80);
/** Single response-format source for both the model and strict I/O parser. */
export const hazardObservationSchema = z
  .object({
    scene: z.enum(["street", "non_street", "unclear"]),
    imageQuality: z.enum(["usable", "insufficient"]),
    pathImpact: z.enum(["blocked", "partly_blocked", "clear", "unclear"]),
    visibleHazards: z
      .array(
        z.enum([
          "vehicle",
          "construction",
          "steps",
          "debris",
          "blocked_path",
          "other_obstacle",
        ]),
      )
      .max(6),
    claimMatch: z.enum(["supported", "contradicted", "insufficient"]),
    observations: z.array(observationText).max(5),
    limitations: z.array(observationText).max(5),
    requiredEvidence: z
      .array(
        z.enum([
          "wider_view",
          "clearer_image",
          "matching_hazard",
          "map_reference",
        ]),
      )
      .max(4),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
export const hazardObservationJsonSchema = z.toJSONSchema(
  hazardObservationSchema,
);
