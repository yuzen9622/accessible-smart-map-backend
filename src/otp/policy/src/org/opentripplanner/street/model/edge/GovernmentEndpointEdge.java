package org.opentripplanner.street.model.edge;

import java.util.List;
import org.locationtech.jts.geom.LineString;
import org.opentripplanner.core.model.i18n.I18NString;
import org.opentripplanner.core.model.i18n.NonLocalizedString;
import org.opentripplanner.street.geometry.SphericalDistanceLibrary;
import org.opentripplanner.street.model.vertex.Vertex;
import org.opentripplanner.street.search.TraverseMode;
import org.opentripplanner.street.search.state.State;

/** Actual request-only traversed geometry. Parent way is an attachment target, not this edge's ID. */
public final class GovernmentEndpointEdge extends Edge implements TemporaryEdge {
  private final LineString geometry;
  private final double distance;
  private final AttachmentProof proof;

  public record AttachmentProof(
    String ruleVersion, String regionId, String surfaceSha256, List<String> sourceRefs,
    String sourceVersion, String sourceBatch, String sourceSha256, List<String> grade,
    String parentOsmWayId, int parentSegmentIndex, boolean parentReverse,
    String exactCoverage, Double knownWidthMeters, List<String> widthSourceRefs,
    List<String> widthObservationGeometrySha256, String widthCoverageStatus, String slopeStatus
  ) {
    public AttachmentProof {
      sourceRefs=List.copyOf(sourceRefs); grade=List.copyOf(grade);
      widthSourceRefs=List.copyOf(widthSourceRefs);
      widthObservationGeometrySha256=List.copyOf(widthObservationGeometrySha256);
    }
  }

  private GovernmentEndpointEdge(Vertex from, Vertex to, LineString geometry, StreetPolicyMetadata parent) {
    super(from,to);
    var surface=parent.endpointSurfaceProof();
    if(surface==null||!surface.eligible()||!surface.covers(geometry))throw new IllegalArgumentException("Unproven endpoint connector");
    if(!geometry.getCoordinateN(0).equals2D(from.getCoordinate())||!geometry.getCoordinateN(geometry.getNumPoints()-1).equals2D(to.getCoordinate()))throw new IllegalArgumentException("Connector endpoint mismatch");
    this.geometry=(LineString)geometry.copy(); this.distance=SphericalDistanceLibrary.length(geometry);
    if(!Double.isFinite(distance)||distance<0)throw new IllegalArgumentException("Connector length");
    var width=surface.widthAlong(geometry);
    this.proof=new AttachmentProof(surface.ruleVersion(),surface.regionId(),surface.surfaceSha256(),surface.sourceRefs(),
      surface.sourceVersion(),surface.sourceBatch(),surface.sourceSha256(),surface.grade(),
      Long.toString(parent.osmWayId()),parent.segmentIndex(),parent.reverse(),"EXACT_EFFECTIVE_SURFACE_COVERS",
      width.knownWidthMeters(),width.sourceRefs(),width.observationGeometrySha256(),width.coverageStatus(),"UNKNOWN");
  }
  public static GovernmentEndpointEdge create(Vertex from,Vertex to,LineString geometry,StreetPolicyMetadata parent){
    return connectToGraph(new GovernmentEndpointEdge(from,to,geometry,parent));
  }
  public AttachmentProof getAttachmentProof(){return proof;}
  public Double getKnownWidthMeters(){return proof.knownWidthMeters();}
  @Override public LineString getGeometry(){return (LineString)geometry.copy();}
  @Override public double getDistanceMeters(){return distance;}
  @Override public double getEffectiveWalkDistance(){return distance;}
  @Override public I18NString getName(){return new NonLocalizedString("Sidewalk endpoint connection");}
  @Override public State[] traverse(State state){
    if(state.currentMode()!=TraverseMode.WALK)return State.empty();
    if(state.getRequest().wheelchairEnabled()&&getKnownWidthMeters()!=null&&Math.round(getKnownWidthMeters()*1_000_000)<900_000)return State.empty();
    var request=state.getRequest();double seconds=distance/request.walk().speed();
    if(!Double.isFinite(seconds)||seconds<0)return State.empty();
    var editor=state.edit(this);editor.incrementTimeInMilliseconds((long)Math.ceil(seconds*1000));
    editor.incrementWeight(seconds*request.walk().reluctance());editor.incrementWalkDistance(distance);
    editor.setBackMode(TraverseMode.WALK);return editor.makeStateArray();
  }
}
