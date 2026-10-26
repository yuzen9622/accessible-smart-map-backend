package org.opentripplanner.model.plan.leg;

import java.util.List;

/** Immutable evidence of actual leg-state back edges; occurrence indexes are not persistent IDs. */
public record WalkEvidence(
  String schemaVersion, String captureScope, String graphIdentityStatus,
  GraphByteIdentity graphByteIdentity, BuildManifestIdentity buildManifestIdentity, String sourceManifestIdentityStatus, String runtimePolicyIdentityStatus,
  int edgeOccurrenceCount, int nonStreetEdgeCount, int unknownMetadataEdgeCount,
  List<EdgeOccurrence> edges, SelectedWalkPath selectedPath, org.opentripplanner.routing.impl.DirectWalkExecutedPolicy executedPolicy
) {
  public WalkEvidence { edges = List.copyOf(edges); }

  public WalkEvidence(String schemaVersion, String captureScope, String graphIdentityStatus,
    GraphByteIdentity graphByteIdentity, BuildManifestIdentity buildManifestIdentity,
    String sourceManifestIdentityStatus, String runtimePolicyIdentityStatus,
    int edgeOccurrenceCount, int nonStreetEdgeCount, int unknownMetadataEdgeCount, List<EdgeOccurrence> edges) {
    this(schemaVersion,captureScope,graphIdentityStatus,graphByteIdentity,buildManifestIdentity,
      sourceManifestIdentityStatus,runtimePolicyIdentityStatus,edgeOccurrenceCount,nonStreetEdgeCount,unknownMetadataEdgeCount,edges,null,null);
  }

  public WalkEvidence withExecutedPolicy(org.opentripplanner.routing.impl.DirectWalkExecutedPolicy policy) {
    return new WalkEvidence(schemaVersion,captureScope,graphIdentityStatus,graphByteIdentity,buildManifestIdentity,
      sourceManifestIdentityStatus,runtimePolicyIdentityStatus,edgeOccurrenceCount,nonStreetEdgeCount,unknownMetadataEdgeCount,edges,selectedPath,policy);
  }

  public WalkEvidence withSelectedPath(SelectedWalkPath path) {
    return new WalkEvidence(schemaVersion,captureScope,graphIdentityStatus,graphByteIdentity,buildManifestIdentity,
      sourceManifestIdentityStatus,runtimePolicyIdentityStatus,edgeOccurrenceCount,nonStreetEdgeCount,unknownMetadataEdgeCount,edges,path,executedPolicy);
  }

  public WalkEvidence withGraphByteIdentity(GraphByteIdentity identity) {
    return withGraphIdentity(identity, null);
  }

  public WalkEvidence withGraphIdentity(GraphByteIdentity identity, BuildManifestIdentity manifest) {
    return withRequestIdentity(identity, manifest, "UNVERIFIED");
  }

  public WalkEvidence withRequestIdentity(GraphByteIdentity identity, BuildManifestIdentity manifest, String runtimeStatus) {
    if (!List.of("UNVERIFIED", "VERIFIED_OBSERVED_POLICY_CLASSES").contains(runtimeStatus)) {
      throw new IllegalArgumentException("Unknown runtime policy identity status");
    }
    if (manifest != null && (identity == null || !identity.sha256().equals(manifest.graphSha256()) || identity.byteCount()!=manifest.graphByteCount())) {
      throw new IllegalStateException("Manifest and request graph identity differ");
    }
    return new WalkEvidence(schemaVersion, captureScope,
      identity == null ? "UNVERIFIED" : "VERIFIED_LOADED_BYTES", identity, manifest,
      manifest == null ? "UNVERIFIED" : "VERIFIED_TRUSTED_BUILD_MANIFEST", runtimeStatus, edgeOccurrenceCount, nonStreetEdgeCount,
      unknownMetadataEdgeCount, edges, selectedPath, executedPolicy);
  }

  public record EdgeOccurrence(
    int occurrenceIndex, String edgeKind, double distanceM, String metadataStatus,
    boolean partial, String osmWayId, Integer sourceSegmentIndex, Boolean reverse,
    Double knownWidthM, List<String> sourceRefs, List<String> widthSourceRefs,
    String sourceBatch, String sourceVersion, String sourceSha256,
    List<AreaSource> areaSources, PathwaySource pathway, String unknownReason, org.opentripplanner.routing.impl.DirectWalkEdgePolicy policyEvaluation, EndpointAttachment attachment
  ) {
    public EdgeOccurrence(int occurrenceIndex,String edgeKind,double distanceM,String metadataStatus,
      boolean partial,String osmWayId,Integer sourceSegmentIndex,Boolean reverse,Double knownWidthM,
      List<String> sourceRefs,List<String> widthSourceRefs,String sourceBatch,String sourceVersion,String sourceSha256,
      List<AreaSource> areaSources,PathwaySource pathway,String unknownReason,org.opentripplanner.routing.impl.DirectWalkEdgePolicy policyEvaluation) {
      this(occurrenceIndex,edgeKind,distanceM,metadataStatus,partial,osmWayId,sourceSegmentIndex,reverse,knownWidthM,
        sourceRefs,widthSourceRefs,sourceBatch,sourceVersion,sourceSha256,areaSources,pathway,unknownReason,policyEvaluation,null);
    }
    public EdgeOccurrence {
      sourceRefs = List.copyOf(sourceRefs);
      widthSourceRefs = List.copyOf(widthSourceRefs);
      areaSources = List.copyOf(areaSources);
    }
  }

  public record EndpointAttachment(
    String ruleVersion, String regionId, String surfaceSha256, List<String> grade,
    String parentOsmWayId, int parentSegmentIndex, boolean parentReverse,
    String exactCoverage, List<String> widthObservationGeometrySha256, String widthCoverageStatus, String slopeStatus
  ) {
    public EndpointAttachment { grade=List.copyOf(grade);widthObservationGeometrySha256=List.copyOf(widthObservationGeometrySha256); }
  }

  public record AreaSource(
    String osmId, Double knownWidthM, boolean stairs, boolean wheelchairAccessible,
    List<String> sourceRefs, List<String> widthSourceRefs,
    String sourceBatch, String sourceVersion, String sourceSha256, String knownSmoothness
  ) {
    public AreaSource {
      sourceRefs = List.copyOf(sourceRefs);
      widthSourceRefs = List.copyOf(widthSourceRefs);
    }
  }

  public record PathwaySource(
    String pathwayId, String sourceFromStopId, String sourceToStopId, String mode,
    Double knownMinWidthM, Double knownSlopeRatio, Boolean knownWheelchairAccessible
  ) {}
}
