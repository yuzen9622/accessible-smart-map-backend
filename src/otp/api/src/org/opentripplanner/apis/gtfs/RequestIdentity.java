package org.opentripplanner.apis.gtfs;

import org.opentripplanner.model.plan.leg.BuildManifestIdentity;
import org.opentripplanner.model.plan.leg.GraphByteIdentity;
import org.opentripplanner.runtime.policyidentity.RuntimePolicyIdentity;

/** Immutable identities observed for one request, independent of itinerary availability. */
public record RequestIdentity(
  GraphByteIdentity graphByteIdentity,
  BuildManifestIdentity buildManifestIdentity,
  RuntimePolicyIdentity.Result runtimePolicyIdentity
) {
  public RequestIdentity {
    if (buildManifestIdentity != null && (graphByteIdentity == null ||
        !graphByteIdentity.sha256().equals(buildManifestIdentity.graphSha256()) ||
        graphByteIdentity.byteCount() != buildManifestIdentity.graphByteCount())) {
      throw new IllegalStateException("Manifest and request graph identity differ");
    }
  }
  public String schemaVersion() { return "1"; }
  public String graphIdentityStatus() { return graphByteIdentity == null ? "UNVERIFIED" : "VERIFIED_LOADED_BYTES"; }
  public String sourceManifestIdentityStatus() { return buildManifestIdentity == null ? "UNVERIFIED" : "VERIFIED_TRUSTED_BUILD_MANIFEST"; }
  public String runtimePolicyIdentityStatus() { return runtimePolicyIdentity == null ? "UNVERIFIED" : runtimePolicyIdentity.status(); }
}
