package org.opentripplanner.routing.algorithm.mapping;

import java.util.ArrayList;
import java.util.List;
import org.opentripplanner.model.plan.leg.WalkEvidence;
import org.opentripplanner.street.model.edge.Edge;
import org.opentripplanner.street.model.edge.PathwayEdge;
import org.opentripplanner.street.model.edge.StreetEdge;
import org.opentripplanner.street.model.edge.TemporaryPartialStreetEdge;

/** Maps each occurrence in order, retaining non-street and missing-metadata edges explicitly. */
public final class WalkEvidenceMapper {
  private WalkEvidenceMapper() {}

  public static WalkEvidence map(List<Edge> edges) { return map(edges, null); }

  public static WalkEvidence map(List<Edge> edges, org.opentripplanner.routing.impl.DirectWalkExecutedPolicy policy) {
    var occurrences = new ArrayList<WalkEvidence.EdgeOccurrence>();
    int nonStreet = 0;
    int unknown = 0;
    for (int i = 0; i < edges.size(); i++) {
      var edge = edges.get(i);
      if (!(edge instanceof StreetEdge)) nonStreet++;
      var occurrence = mapEdge(i, edge, policy);
      if (occurrence.unknownReason() != null) unknown++;
      occurrences.add(occurrence);
    }
    return new WalkEvidence("7", "LEG_STATES_BACK_EDGES", "UNVERIFIED", null, null, "UNVERIFIED", "UNVERIFIED", edges.size(),
      nonStreet, unknown, occurrences).withExecutedPolicy(policy);
  }

  private static WalkEvidence.EdgeOccurrence mapEdge(int index, Edge edge, org.opentripplanner.routing.impl.DirectWalkExecutedPolicy policy) {
    var evaluation = org.opentripplanner.routing.impl.DirectWalkEdgePolicy.observe(edge, policy);
    boolean partial = edge instanceof TemporaryPartialStreetEdge;
    if(edge instanceof org.opentripplanner.street.model.edge.GovernmentEndpointEdge connector){
      var p=connector.getAttachmentProof();
      var attachment=new WalkEvidence.EndpointAttachment(p.ruleVersion(),p.regionId(),p.surfaceSha256(),p.grade(),
        p.parentOsmWayId(),p.parentSegmentIndex(),p.parentReverse(),p.exactCoverage(),p.widthObservationGeometrySha256(),p.widthCoverageStatus(),p.slopeStatus());
      return new WalkEvidence.EdgeOccurrence(index,edge.getClass().getSimpleName(),edge.getDistanceMeters(),
        "GOVERNMENT_ENDPOINT",false,null,null,null,p.knownWidthMeters(),p.sourceRefs(),p.widthSourceRefs(),
        p.sourceBatch(),p.sourceVersion(),p.sourceSha256(),List.of(),null,null,evaluation,attachment);
    }

    if (edge instanceof StreetEdge street && street.getPolicyMetadata() != null) {
      var m = street.getPolicyMetadata();
      var areas = m.areaSources().stream().map(a -> new WalkEvidence.AreaSource(
        a.osmId(), a.knownWidthMeters(), a.stairs(), a.wheelchairAccessible(),
        a.sourceRefs(), a.widthSourceRefs(), a.sourceBatch(), a.sourceVersion(), a.sourceSha256(), a.knownSmoothness()
      )).toList();
      boolean area = !areas.isEmpty();
      return new WalkEvidence.EdgeOccurrence(index, edge.getClass().getSimpleName(),
        edge.getDistanceMeters(), area ? "OSM_AREA" : "OSM_WAY", partial,
        area ? null : Long.toString(m.osmWayId()), area ? null : m.segmentIndex(), m.reverse(),
        m.knownWidthMeters(), m.sourceRefs(), m.widthSourceRefs(), m.sourceBatch(),
        m.sourceVersion(), m.sourceSha256(), areas, null, null, evaluation);
    }
    if (edge instanceof PathwayEdge pathway && pathway.getPolicyMetadata() != null) {
      var m = pathway.getPolicyMetadata();
      var source = new WalkEvidence.PathwaySource(m.pathwayId(), m.fromStopId(), m.toStopId(),
        m.mode(), m.knownMinWidthMeters(), m.knownSlopeRatio(), m.knownWheelchairAccessible());
      return new WalkEvidence.EdgeOccurrence(index, edge.getClass().getSimpleName(),
        edge.getDistanceMeters(), "GTFS_PATHWAY", false, null, null, null,
        m.knownMinWidthMeters(), List.of(), List.of(), null, null, null, List.of(), source,
        m.pathwayId() == null ? "PATHWAY_SOURCE_ID_UNKNOWN" : null, evaluation);
    }
    return new WalkEvidence.EdgeOccurrence(index, edge.getClass().getSimpleName(),
      edge.getDistanceMeters(), "UNKNOWN", partial, null, null, null, null,
      List.of(), List.of(), null, null, null, List.of(), null,
      edge instanceof StreetEdge ? "STREET_POLICY_METADATA_MISSING" : "NON_STREET_METADATA_UNAVAILABLE", evaluation);
  }
}
