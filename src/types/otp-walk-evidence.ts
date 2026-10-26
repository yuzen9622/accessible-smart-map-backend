import { z } from "zod";
import { OtpWalkBuildManifestSchema } from "./otp-walk-identity";
import { OtpExecutedWalkPolicySchema } from "./otp-walk-search";

const count = z.number().int().nonnegative().max(2_147_483_647);
const distance = z.number().finite().nonnegative();
const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceFields = {
  knownWidthM: z.number().finite().positive().nullable(),
  sourceRefs: z.array(nonBlank),
  widthSourceRefs: z.array(nonBlank),
  sourceBatch: nonBlank.nullable(),
  sourceVersion: nonBlank.nullable(),
  sourceSha256: sha256.nullable(),
};

export const OtpWalkCoordinateSchema = z.strictObject({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
});
export type OtpWalkCoordinate = z.infer<typeof OtpWalkCoordinateSchema>;

const areaSourceSchema = z.strictObject({
  osmId: nonBlank,
  stairs: z.boolean(),
  wheelchairAccessible: z.boolean(),
  knownSmoothness: nonBlank.nullable(),
  ...sourceFields,
});
const pathwaySchema = z.strictObject({
  pathwayId: nonBlank.nullable(),
  sourceFromStopId: nonBlank.nullable(),
  sourceToStopId: nonBlank.nullable(),
  mode: z
    .enum([
      "WALKWAY",
      "STAIRS",
      "MOVING_SIDEWALK",
      "ESCALATOR",
      "ELEVATOR",
      "FARE_GATE",
      "EXIT_GATE",
    ])
    .nullable(),
  knownMinWidthM: z.number().finite().positive().nullable(),
  knownSlopeRatio: z.number().finite().nullable(),
  knownWheelchairAccessible: z.boolean().nullable(),
});
const edgeSchema = z.strictObject({
  occurrenceIndex: count,
  edgeKind: nonBlank,
  distanceM: distance,
  metadataStatus: z.enum([
    "OSM_WAY",
    "OSM_AREA",
    "GTFS_PATHWAY",
    "GOVERNMENT_ENDPOINT",
    "UNKNOWN",
  ]),
  partial: z.boolean(),
  osmWayId: z
    .string()
    .regex(/^-?[0-9]+$/)
    .nullable(),
  sourceSegmentIndex: count.nullable(),
  reverse: z.boolean().nullable(),
  ...sourceFields,
  areaSources: z.array(areaSourceSchema),
  pathway: pathwaySchema.nullable(),
  policyEvaluation: z.strictObject({
    captureSchemaVersion: count.nullable(),
    stairs: z.boolean().nullable(),
    escalator: z.boolean().nullable(),
    nativeWheelchairAccessible: z.boolean().nullable(),
    knownMaxSlopeRatio: z.number().finite().nullable(),
    knownWidthM: z.number().finite().positive().nullable(),
    knownSmoothness: nonBlank.nullable(),
    assistedStairs: z.boolean(),
  }),
  attachment: z
    .strictObject({
      ruleVersion: z.literal("government-endpoint-v1"),
      regionId: sha256,
      surfaceSha256: sha256,
      grade: z.array(nonBlank).length(4),
      parentOsmWayId: z.string().regex(/^-?[0-9]+$/),
      parentSegmentIndex: count,
      parentReverse: z.boolean(),
      exactCoverage: z.literal("EXACT_EFFECTIVE_SURFACE_COVERS"),
      widthObservationGeometrySha256: z.array(sha256),
      widthCoverageStatus: z.enum([
        "KNOWN_OVER_ENTIRE_CONNECTOR",
        "PARTIALLY_KNOWN",
        "UNKNOWN",
      ]),
      slopeStatus: z.literal("UNKNOWN"),
    })
    .nullable(),
  unknownReason: z
    .enum([
      "PATHWAY_SOURCE_ID_UNKNOWN",
      "STREET_POLICY_METADATA_MISSING",
      "NON_STREET_METADATA_UNAVAILABLE",
    ])
    .nullable(),
});
const coordinate = OtpWalkCoordinateSchema.nullable();
const gap = distance.nullable();
const geometryOccurrenceSchema = z.strictObject({
  occurrenceIndex: count,
  edgeKind: nonBlank,
  distanceM: distance,
  partial: z.boolean(),
  traversalFrom: coordinate,
  traversalTo: coordinate,
  traversalDirection: z.enum(["EDGE_FORWARD", "EDGE_REVERSE", "UNRESOLVED"]),
  geometryStatus: z.enum(["PRESENT", "NULL", "EMPTY", "INVALID_COORDINATE"]),
  geometrySource: z.enum([
    "NATIVE_STREET_COMPACT_E6_INTERMEDIATES",
    "NATIVE_PATHWAY_ENDPOINT_LINE",
    "NATIVE_EDGE_GET_GEOMETRY",
  ]),
  coordinates: z.array(OtpWalkCoordinateSchema),
  vertexGapM: gap,
  geometryStartToTraversalFromGapM: gap,
  geometryEndToTraversalToGapM: gap,
  gapFromPreviousGeometryM: gap,
  geometryLengthM: distance,
});
const selectedPathSchema = z.strictObject({
  geometryCoverageStatus: z.enum([
    "EMPTY_PATH",
    "UNRESOLVED_STATE_CHAIN",
    "NO_NATIVE_GEOMETRY",
    "NATIVE_GEOMETRY_GAPS",
    "NATIVE_GEOMETRY_COMPLETE",
  ]),
  coordinateEncoding: z.literal("FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION"),
  gapMetric: z.literal("HAVERSINE_R6371000_METERS"),
  endpointReachabilityStatus: z.literal("NOT_PROVEN_BY_GEOMETRY"),
  startsSearchPath: z.boolean(),
  endsSearchPath: z.boolean(),
  requestFrom: coordinate,
  requestTo: coordinate,
  startState: coordinate,
  endState: coordinate,
  firstGeometryPoint: coordinate,
  lastGeometryPoint: coordinate,
  requestFromToStartStateGapM: gap,
  requestToToEndStateGapM: gap,
  requestFromToFirstGeometryGapM: gap,
  requestToToLastGeometryGapM: gap,
  missingGeometryCount: count,
  positiveDistanceMissingGeometryCount: count,
  stateChainMismatchCount: count,
  representedGeometryLengthM: distance,
  occurrences: z.array(geometryOccurrenceSchema),
});

/** Native occurrence evidence; qualification against a request and root identity is separate. */
export const OtpWalkEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("7"),
  executedPolicy: OtpExecutedWalkPolicySchema,
  captureScope: z.literal("LEG_STATES_BACK_EDGES"),
  graphIdentityStatus: z.literal("VERIFIED_LOADED_BYTES"),
  graphByteIdentity: z.strictObject({
    sha256,
    byteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  buildManifestIdentity: OtpWalkBuildManifestSchema,
  sourceManifestIdentityStatus: z.literal("VERIFIED_TRUSTED_BUILD_MANIFEST"),
  runtimePolicyIdentityStatus: z.literal("VERIFIED_OBSERVED_POLICY_CLASSES"),
  edgeOccurrenceCount: count,
  nonStreetEdgeCount: count,
  unknownMetadataEdgeCount: count,
  edges: z.array(edgeSchema),
  selectedPath: selectedPathSchema,
});
export type OtpWalkEvidence = z.infer<typeof OtpWalkEvidenceSchema>;
