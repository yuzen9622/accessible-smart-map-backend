import { z } from "zod";
import { fetchOtpWalkIdentityResponse } from "../../../adapters/otp-walk.adapter";
import type { OtpWalkIdentityResponse } from "../../../adapters/otp-walk.adapter";
import type { SidewalkSourceIdentity } from "./pedestrian-a11y/sidewalk-source.repository";

import { OtpWalkIdentitySchema } from "../../../types/otp-walk-identity";
import type {
  OtpWalkArtifact,
  OtpWalkIdentity,
  ReviewedOtpWalkPolicy,
} from "../../../types/otp-walk-identity";
export {
  OtpWalkArtifactSchema,
  OtpWalkBuildManifestSchema,
  ReviewedOtpWalkPolicySchema,
  OtpWalkIdentitySchema,
} from "../../../types/otp-walk-identity";
export type {
  OtpWalkArtifact,
  OtpWalkBuildManifest,
  ReviewedOtpWalkPolicy,
  OtpWalkIdentity,
} from "../../../types/otp-walk-identity";

export interface OtpWalkIdentityExpectations {
  sourceIdentity: SidewalkSourceIdentity;
  reviewedPolicies: readonly ReviewedOtpWalkPolicy[];
}
type TransportFailure = Extract<
  OtpWalkIdentityResponse,
  { status: "unavailable" }
>;
export type OtpWalkIdentityResult =
  | { status: "ready"; identity: OtpWalkIdentity }
  | TransportFailure
  | {
      status: "unavailable";
      reason:
        | "invalid_identity"
        | "source_mismatch"
        | "policy_not_reviewed"
        | "graphql_error";
    };

function sameRuntime(
  a: ReviewedOtpWalkPolicy,
  b: ReviewedOtpWalkPolicy,
): boolean {
  return (
    a.artifactSha256 === b.artifactSha256 &&
    a.manifestSha256 === b.manifestSha256 &&
    a.observedClassDigestSha256 === b.observedClassDigestSha256 &&
    a.classCount === b.classCount
  );
}

/** Parse observed claims, then bind them to the caller's current source and reviewed policy. */
export function parseOtpWalkIdentity(
  value: unknown,
  expected: OtpWalkIdentityExpectations,
): OtpWalkIdentityResult {
  const parsed = OtpWalkIdentitySchema.safeParse(value);
  if (!parsed.success)
    return { status: "unavailable", reason: "invalid_identity" };
  const identity = parsed.data;
  const source = identity.buildManifestIdentity;
  if (
    source.sourceVersion !== expected.sourceIdentity.sourceVersionId ||
    source.sourceBatch !== expected.sourceIdentity.sourceBatch ||
    source.sourceArchiveSha256 !== expected.sourceIdentity.archiveSha256
  )
    return { status: "unavailable", reason: "source_mismatch" };
  if (
    !expected.reviewedPolicies.some((policy) =>
      sameRuntime(policy, identity.runtimePolicyIdentity),
    )
  )
    return { status: "unavailable", reason: "policy_not_reviewed" };
  return { status: "ready", identity };
}

const responseSchema = z.object({
  data: z.object({ requestIdentity: z.unknown() }).nullable().optional(),
  errors: z.array(z.unknown()).optional(),
});

export function parseOtpWalkIdentityResponse(
  value: unknown,
  expected: OtpWalkIdentityExpectations,
): OtpWalkIdentityResult {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success)
    return { status: "unavailable", reason: "invalid_identity" };
  if (parsed.data.errors?.length)
    return { status: "unavailable", reason: "graphql_error" };
  return parseOtpWalkIdentity(parsed.data.data?.requestIdentity, expected);
}

export async function fetchCurrentOtpWalkIdentity(
  options: OtpWalkIdentityExpectations & { deadlineMs: number },
): Promise<OtpWalkIdentityResult> {
  const response = await fetchOtpWalkIdentityResponse(options);
  if (response.status !== "received") return response;
  const result = parseOtpWalkIdentityResponse(response.data, options);
  return Date.now() >= options.deadlineMs
    ? { status: "unavailable", reason: "deadline_exceeded" }
    : result;
}

function sameArtifacts(
  a: readonly OtpWalkArtifact[],
  b: readonly OtpWalkArtifact[],
): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(b.map((artifact) => [artifact.path, artifact]));
  return a.every((artifact) => {
    const other = byPath.get(artifact.path);
    return (
      other !== undefined &&
      artifact.role === other.role &&
      artifact.sha256 === other.sha256 &&
      artifact.byteCount === other.byteCount
    );
  });
}

/** Compare parsed identities; this alone neither fetches current state nor authorizes a policy. */
export function sameOtpWalkIdentity(
  a: OtpWalkIdentity,
  b: OtpWalkIdentity,
): boolean {
  const left = a.buildManifestIdentity;
  const right = b.buildManifestIdentity;
  return (
    a.graphByteIdentity.sha256 === b.graphByteIdentity.sha256 &&
    a.graphByteIdentity.byteCount === b.graphByteIdentity.byteCount &&
    left.manifestSha256 === right.manifestSha256 &&
    left.buildInputMode === right.buildInputMode &&
    left.graphSha256 === right.graphSha256 &&
    left.graphByteCount === right.graphByteCount &&
    left.sourceVersion === right.sourceVersion &&
    left.sourceBatch === right.sourceBatch &&
    left.sourceArchiveSha256 === right.sourceArchiveSha256 &&
    left.mergedPbfSha256 === right.mergedPbfSha256 &&
    left.layerReportSha256 === right.layerReportSha256 &&
    left.declaredBuildPolicyJarSha256 === right.declaredBuildPolicyJarSha256 &&
    sameRuntime(a.runtimePolicyIdentity, b.runtimePolicyIdentity) &&
    sameArtifacts(left.inputs, right.inputs) &&
    sameArtifacts(left.compilerArtifacts, right.compilerArtifacts)
  );
}
