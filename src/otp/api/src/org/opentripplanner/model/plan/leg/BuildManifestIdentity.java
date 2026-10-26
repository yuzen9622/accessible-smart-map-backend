package org.opentripplanner.model.plan.leg;

import java.util.List;

/** A launcher-pinned build attestation; it is not evidence of current runtime policy bytecode. */
public record BuildManifestIdentity(
  String manifestSha256, String buildInputMode, String graphSha256, long graphByteCount,
  String sourceVersion, String sourceBatch, String sourceArchiveSha256,
  String mergedPbfSha256, String layerReportSha256, String declaredBuildPolicyJarSha256,
  List<BuildArtifact> inputs, List<BuildArtifact> compilerArtifacts
) {
  public BuildManifestIdentity {
    inputs=List.copyOf(inputs);
    compilerArtifacts=List.copyOf(compilerArtifacts);
  }
  public record BuildArtifact(String path, String role, String sha256, long byteCount) {}
}
