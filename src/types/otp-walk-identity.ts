import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
export const OtpWalkArtifactSchema = z.strictObject({
  path: nonBlank.refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  ),
  role: z.enum([
    "OSM",
    "GTFS",
    "DEM",
    "CONFIG",
    "OTHER",
    "COMPILER",
    "TOPOLOGY",
    "DEPENDENCY",
  ]),
  sha256,
  byteCount,
});
const compilerRoles = new Map([
  ["otp-sidewalk-layer.py", "COMPILER"],
  ["otp-sidewalk-topology.py", "TOPOLOGY"],
  ["build-ped-graph.py", "DEPENDENCY"],
  ["ped-sidewalk-network.py", "DEPENDENCY"],
  ["ped-osm-areas.py", "DEPENDENCY"],
  ["osm-area-polygon-features.json", "DEPENDENCY"],
]);

function inputRole(path: string): string {
  if (path.endsWith(".pbf")) return "OSM";
  if (path.endsWith(".zip")) return "GTFS";
  if (/\.tiff?$/i.test(path)) return "DEM";
  return path.endsWith("config.json") ? "CONFIG" : "OTHER";
}

export const OtpWalkBuildManifestSchema = z
  .strictObject({
    manifestSha256: sha256,
    buildInputMode: z.literal("LOCAL_AUTO_DISCOVERY_NO_CACHE"),
    graphSha256: sha256,
    graphByteCount: byteCount,
    sourceVersion: nonBlank,
    sourceBatch: nonBlank,
    sourceArchiveSha256: sha256,
    mergedPbfSha256: sha256,
    layerReportSha256: sha256,
    declaredBuildPolicyJarSha256: sha256,
    inputs: z.array(OtpWalkArtifactSchema).min(1),
    compilerArtifacts: z
      .array(OtpWalkArtifactSchema)
      .length(compilerRoles.size),
  })
  .superRefine((manifest, context) => {
    const inputs = new Set(manifest.inputs.map((artifact) => artifact.path));
    const compiler = new Set(
      manifest.compilerArtifacts.map((artifact) => artifact.path),
    );
    if (
      inputs.size !== manifest.inputs.length ||
      manifest.inputs.some(
        (artifact) =>
          artifact.path === "graph.obj" ||
          artifact.role !== inputRole(artifact.path),
      ) ||
      manifest.inputs.filter(
        (artifact) =>
          artifact.path === "merged.osm.pbf" &&
          artifact.role === "OSM" &&
          artifact.sha256 === manifest.mergedPbfSha256,
      ).length !== 1 ||
      compiler.size !== compilerRoles.size ||
      manifest.compilerArtifacts.some(
        (artifact) => compilerRoles.get(artifact.path) !== artifact.role,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Build artifact identities are inconsistent",
      });
  });

export const ReviewedOtpWalkPolicySchema = z.strictObject({
  artifactSha256: sha256,
  manifestSha256: sha256,
  observedClassDigestSha256: sha256,
  classCount: z.number().int().positive().max(2_147_483_647),
});
export type ReviewedOtpWalkPolicy = z.infer<typeof ReviewedOtpWalkPolicySchema>;

export const OtpWalkIdentitySchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    graphIdentityStatus: z.literal("VERIFIED_LOADED_BYTES"),
    graphByteIdentity: z.strictObject({ sha256, byteCount }),
    sourceManifestIdentityStatus: z.literal("VERIFIED_TRUSTED_BUILD_MANIFEST"),
    buildManifestIdentity: OtpWalkBuildManifestSchema,
    runtimePolicyIdentityStatus: z.literal("VERIFIED_OBSERVED_POLICY_CLASSES"),
    runtimePolicyIdentity: ReviewedOtpWalkPolicySchema.extend({
      status: z.literal("VERIFIED_OBSERVED_POLICY_CLASSES"),
      reason: z.literal("TRUSTED_LAUNCHER_BOUNDARY"),
    }),
  })
  .superRefine((identity, context) => {
    if (
      identity.graphByteIdentity.sha256 !==
        identity.buildManifestIdentity.graphSha256 ||
      identity.graphByteIdentity.byteCount !==
        identity.buildManifestIdentity.graphByteCount
    )
      context.addIssue({
        code: "custom",
        message: "Build manifest does not identify the loaded graph",
      });
  });
export type OtpWalkIdentity = z.infer<typeof OtpWalkIdentitySchema>;
export type OtpWalkArtifact = z.infer<typeof OtpWalkArtifactSchema>;
export type OtpWalkBuildManifest = z.infer<typeof OtpWalkBuildManifestSchema>;
