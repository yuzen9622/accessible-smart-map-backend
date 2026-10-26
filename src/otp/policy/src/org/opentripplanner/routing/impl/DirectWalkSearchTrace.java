package org.opentripplanner.routing.impl;

import java.util.IdentityHashMap;
import java.util.Map;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.street.linking.GovernmentEndpointLinkResult;
import org.opentripplanner.street.model.vertex.Vertex;

/** One explicitly owned plan operation. Transient in RouteRequest, never global or graph state. */
public final class DirectWalkSearchTrace {
  private DirectWalkSearchEvidence terminal;
  private boolean frozen;
  private record LinkedEndpoint(String endpoint, GovernmentEndpointLinkResult result) {}
  private final Map<Vertex,LinkedEndpoint> linkedEndpoints = new IdentityHashMap<>();

  public synchronized void registerEndpoint(Vertex vertex, String endpoint, GovernmentEndpointLinkResult result) {
    if(frozen||terminal!=null||!("FROM".equals(endpoint)||"TO".equals(endpoint))||
        linkedEndpoints.values().stream().anyMatch(x->x.endpoint().equals(endpoint)))
      throw new IllegalStateException("Repeated or late endpoint link observation");
    linkedEndpoints.put(vertex,new LinkedEndpoint(endpoint,java.util.Objects.requireNonNull(result)));
  }

  public synchronized GovernmentEndpointLinkResult ownedTarget(Vertex vertex) {
    if(frozen||terminal!=null)return null;
    var linked=linkedEndpoints.get(vertex);
    return linked!=null&&"TO".equals(linked.endpoint())?linked.result():null;
  }

  public synchronized void recordLinkFailure(RouteRequest request) {
    var from=request.from().getCoordinate();var to=request.to().getCoordinate();
    if(from==null||to==null||from.equals2D(to))return;
    for(String side:java.util.List.of("FROM","TO"))for(var entry:linkedEndpoints.entrySet()) {
      var linked=entry.getValue();int count=linked.result().knownWidthBlockedCandidates();
      if(side.equals(linked.endpoint())&&count>0&&entry.getKey().getIncoming().isEmpty()&&entry.getKey().getOutgoing().isEmpty()){
        recordEndpointBlocked(request,new EndpointConstraintEvidence("SELECTED_ENDPOINT_ATTACHMENT",side,"LINK",java.util.List.of("KNOWN_WIDTH"),count));
        return;
      }
    }
  }

  public synchronized void recordEndpointBlocked(RouteRequest request, EndpointConstraintEvidence constraint) {
    var policy=DirectWalkExecutedPolicy.from(request);
    if(policy==null||!policy.wheelchairEnabled())throw new IllegalArgumentException("Wheelchair endpoint proof required");
    finish(request,"ENDPOINT_CONSTRAINT_BLOCKED","NOT_STARTED",false,java.util.Objects.requireNonNull(constraint));
  }

  public synchronized void record(RouteRequest request, String status, String nativeOutcome, boolean durationPruned) {
    finish(request,status,nativeOutcome,durationPruned,null);
  }

  private void finish(RouteRequest request,String status,String outcome,boolean pruned,EndpointConstraintEvidence constraint) {
    if(frozen||terminal!=null)throw new IllegalStateException("Repeated or late direct search completion");
    terminal=evidence(request,status,outcome,pruned,constraint);
    linkedEndpoints.clear();
  }

  public synchronized DirectWalkSearchEvidence snapshot(RouteRequest request) {
    if(frozen)throw new IllegalStateException("Search evidence already consumed");
    frozen=true;linkedEndpoints.clear();
    return terminal==null?evidence(request,"NOT_EXECUTED","NOT_STARTED",false,null):terminal;
  }

  private static DirectWalkSearchEvidence evidence(RouteRequest request,String status,String nativeOutcome,boolean pruned,EndpointConstraintEvidence constraint) {
    var policy=DirectWalkExecutedPolicy.from(request);
    if(policy==null)return null;
    var from=request.from().getCoordinate();var to=request.to().getCoordinate();
    return new DirectWalkSearchEvidence("2",status,nativeOutcome,policy,
      from==null?null:from.y,from==null?null:from.x,to==null?null:to.y,to==null?null:to.x,
      request.dateTime()==null?null:request.dateTime().toEpochMilli(),
      request.preferences().street().maxDirectDuration().valueOf(request.journey().direct().mode()).toMillis()/1000.0,
      request.preferences().street().routingTimeout().toMillis()/1000.0,pruned,constraint);
  }
}
