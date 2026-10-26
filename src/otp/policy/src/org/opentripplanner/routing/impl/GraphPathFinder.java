package org.opentripplanner.routing.impl;

import java.util.Collection;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import javax.annotation.Nullable;
import org.opentripplanner.astar.model.GraphPath;
import org.opentripplanner.astar.spi.TraverseVisitor;
import org.opentripplanner.astar.strategy.DurationSkipEdgeStrategy;
import org.opentripplanner.astar.strategy.ComposingSkipEdgeStrategy;
import org.opentripplanner.astar.strategy.PathComparator;
import org.opentripplanner.framework.application.OTPRequestTimeoutException;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.routing.api.request.preference.StreetPreferences;
import org.opentripplanner.routing.error.PathNotFoundException;
import org.opentripplanner.routing.linking.LinkingContext;
import org.opentripplanner.street.model.StreetConstants;
import org.opentripplanner.street.model.edge.Edge;
import org.opentripplanner.street.model.edge.ExtensionRequestContext;
import org.opentripplanner.street.model.edge.StreetEdge;
import org.opentripplanner.street.model.edge.PathwayEdge;
import org.opentripplanner.street.model.edge.ElevatorHopEdge;
import org.opentripplanner.street.model.edge.StreetTransitEntityLink;
import org.opentripplanner.core.model.accessibility.Accessibility;
import org.opentripplanner.street.model.edge.TemporaryPartialStreetEdge;
import org.opentripplanner.street.model.vertex.Vertex;
import org.opentripplanner.street.search.EuclideanRemainingWeightHeuristic;
import org.opentripplanner.street.search.StreetSearchBuilder;
import org.opentripplanner.street.search.state.State;
import org.opentripplanner.street.search.strategy.DominanceFunctions;
import org.opentripplanner.streetadapter.StreetSearchRequestMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * This class contains the logic for repeatedly building shortest path trees and accumulating paths
 * through the graph until the requested number of them have been found. It is used in
 * point-to-point (i.e. not one-to-many / analyst) routing.
 * <p>
 * Its exact behavior will depend on whether the routing request allows transit.
 * <p>
 * When using transit it will incorporate techniques from what we called "long distance" mode, which
 * is designed to provide reasonable response times when routing over large graphs (e.g. the entire
 * Netherlands or New York State). In this case it only uses the street network at the first and
 * last legs of the trip, and all other transfers between transit vehicles will occur via
 * PathTransfer edges which are pre-computed by the graph builder.
 * <p>
 * More information is available on the OTP wiki at: https://github.com/openplans/OpenTripPlanner/wiki/LargeGraphs
 * <p>
 * One instance of this class should be constructed per search (i.e. per RouteRequest: it is
 * request-scoped). Its behavior is undefined if it is reused for more than one search.
 * <p>
 * It is very close to being an abstract library class with only static functions. However it turns
 * out to be convenient and harmless to have the OTPServer object etc. in fields, to avoid passing
 * context around in function parameters.
 */
public class GraphPathFinder {

  private static final Logger LOG = LoggerFactory.getLogger(GraphPathFinder.class);

  @Nullable
  private final TraverseVisitor<State, Edge> traverseVisitor;

  private final Collection<ExtensionRequestContext> extensionRequestContexts;

  private final float maxCarSpeed;
  private org.opentripplanner.astar.SearchCompletion searchCompletion;
  private boolean durationLimitPruned;
  private EndpointConstraintEvidence endpointConstraint;
  public EndpointConstraintEvidence endpointConstraint() { return endpointConstraint; }
  public org.opentripplanner.astar.SearchCompletion searchCompletion() { return searchCompletion; }
  public boolean durationLimitPruned() { return durationLimitPruned; }

  public GraphPathFinder(@Nullable TraverseVisitor<State, Edge> traverseVisitor) {
    this(traverseVisitor, List.of(), StreetConstants.DEFAULT_MAX_CAR_SPEED);
  }

  public GraphPathFinder(
    @Nullable TraverseVisitor<State, Edge> traverseVisitor,
    Collection<ExtensionRequestContext> extensionRequestContexts,
    float maxCarSpeed
  ) {
    this.traverseVisitor = traverseVisitor;
    this.extensionRequestContexts = Objects.requireNonNull(extensionRequestContexts);
    this.maxCarSpeed = maxCarSpeed;
  }

  /**
   * This no longer does "trip banning" to find multiple itineraries. It just searches once trying
   * to find a non-transit path.
   */
  public List<GraphPath<State, Edge, Vertex>> getPaths(
    RouteRequest request,
    Set<Vertex> from,
    Set<Vertex> to
  ) {
    StreetPreferences preferences = request.preferences().street();
    var executedPolicy = DirectWalkExecutedPolicy.from(request);
    var contexts = new java.util.ArrayList<ExtensionRequestContext>(extensionRequestContexts);
    if (executedPolicy != null) contexts.add(new DirectWalkPolicyContext(executedPolicy));
    var durationLimit = new DurationSkipEdgeStrategy<State, Edge>(
      preferences.maxDirectDuration().valueOf(request.journey().direct().mode()));

    var streetRequest=StreetSearchRequestMapper.map(request)
      .withExtensionRequestContexts(contexts).withMode(request.journey().direct().mode()).build();
    DirectWalkPolicyContext.observed(streetRequest);
    endpointConstraint=proveTerminalCut(request,from,to,executedPolicy);
    if(endpointConstraint!=null)return List.of();

    StreetSearchBuilder aStar = StreetSearchBuilder.of()
      .withPreStartHook(OTPRequestTimeoutException::checkForTimeout)
      .withHeuristic(new EuclideanRemainingWeightHeuristic(maxCarSpeed))
      .withCompletionObserver(completion -> searchCompletion = completion)
      .withSkipEdgeStrategy((state, edge) -> {
        if (durationLimit.shouldSkipEdge(state, edge)) {
          durationLimitPruned = true;
          return true;
        }
        return prototypeHardWheelchairSkip(state, edge);
      })
      // FORCING the dominance function to weight only
      .withDominanceFunction(new DominanceFunctions.MinimumWeight())
      .withRequest(streetRequest)
      .withFrom(from)
      .withTo(to);

    // If the search has a traverseVisitor(GraphVisualizer) attached to it, set it as a callback
    // for the AStar search
    if (traverseVisitor != null) {
      aStar.withTraverseVisitor(traverseVisitor);
    }

    LOG.debug("rreq={}", request);

    long searchBeginTime = System.currentTimeMillis();
    LOG.debug("BEGIN SEARCH");

    List<GraphPath<State, Edge, Vertex>> paths = aStar.getPathsToTarget();

    LOG.debug("we have {} paths", paths.size());
    LOG.debug("END SEARCH ({} msec)", System.currentTimeMillis() - searchBeginTime);
    paths.sort(new PathComparator(request.arriveBy()));
    for (var path : paths) {
      for (var edge : path.edges) {
        if (edge instanceof ElevatorHopEdge hop) {
          LOG.debug("ELEVATOR_SELECTED from={} to={} accessibility={} metadata={}",
            edge.getFromVertex().getLabel(), edge.getToVertex().getLabel(), hop.getWheelchairAccessibility(), hop.getPolicyMetadata());
        }
        if (edge instanceof StreetTransitEntityLink<?> link) {
          LOG.debug("TRANSIT_LINK_SELECTED type={} from={} to={} accessibility={}", edge.getClass().getSimpleName(),
            edge.getFromVertex().getLabel(), edge.getToVertex().getLabel(), link.getWheelchairAccessibility());
        }
        if (edge instanceof PathwayEdge pathway) {
          LOG.debug("PATHWAY_SELECTED distanceMeters={} from={} to={} steps={} metadata={}",
            pathway.getDistanceMeters(), edge.getFromVertex().getLabel(), edge.getToVertex().getLabel(),
            pathway.getSteps(), pathway.getPolicyMetadata());
        }
        if (edge instanceof StreetEdge street) {
          var metadata = street.getPolicyMetadata();
          if (street instanceof TemporaryPartialStreetEdge partial &&
              !Objects.equals(metadata, partial.getParentEdge().getPolicyMetadata())) {
            throw new IllegalStateException("Prototype partial edge lost policy metadata");
          }
          LOG.debug("PROTOTYPE_SELECTED partial={} metadata={} distanceMeters={} nativeSlope={}",
            edge instanceof TemporaryPartialStreetEdge, metadata, street.getDistanceMeters(), nativeProfileMaxSlope(street));
        }
      }
    }
    return paths;
  }

  private static boolean tooNarrow(Double width) {
    return width != null && Double.isFinite(width) && Math.round(width * 1_000_000) < 900_000;
  }

  private static boolean tooSteep(Double slope) {
    return slope != null && Double.isFinite(slope) &&
      Math.round(Math.abs(slope) * 100 * 1_000_000) > 12_000_000;
  }

  // Native profiles may be DEM-derived or interpolated; missing is not measured flat.
  // Read raw adjacent slopes because native maxSlope suppresses extreme/flattened slopes.
  private static Double nativeProfileMaxSlope(StreetEdge street) {
    var profile = street.getElevationProfile();
    if (profile == null || profile.size() < 2) return null;
    Double maximum = null;
    for (int i = 1; i < profile.size(); i++) {
      double dx = profile.getX(i) - profile.getX(i - 1);
      double dy = profile.getY(i) - profile.getY(i - 1);
      if (Double.isFinite(dx) && Double.isFinite(dy) && dx > 0) {
        double slope = Math.abs(dy / dx);
        if (Double.isFinite(slope)) maximum = maximum == null ? slope : Math.max(maximum, slope);
      }
    }
    return maximum;
  }

  private record StreetLimits(boolean narrow, boolean steep) {}

  // Shared by the actual AStar veto and the conservative endpoint proof.
  private static StreetLimits streetLimits(StreetEdge street) {
    var metadata=street.getPolicyMetadata();
    return new StreetLimits(metadata!=null&&tooNarrow(metadata.knownWidthMeters()),tooSteep(nativeProfileMaxSlope(street)));
  }

  private static EndpointConstraintEvidence proveTerminalCut(
    RouteRequest request,Set<Vertex> from,Set<Vertex> to,DirectWalkExecutedPolicy policy
  ) {
    if(policy==null||!policy.wheelchairEnabled()||request.arriveBy()||from.isEmpty()||to.size()!=1||request.directWalkSearchTrace()==null)return null;
    var target=to.iterator().next();
    if(!(target instanceof org.opentripplanner.street.model.vertex.TemporaryStreetLocation)||
        request.from().getCoordinate()==null||request.to().getCoordinate()==null||
        request.from().getCoordinate().equals2D(request.to().getCoordinate())||
        !target.getCoordinate().equals2D(request.to().getCoordinate()))return null;
    var owned=request.directWalkSearchTrace().ownedTarget(target);
    if(owned==null)return null;
    var targetIncoming=List.copyOf(target.getIncoming());
    if(targetIncoming.isEmpty())return null;
    Set<Vertex> cut=java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
    cut.add(target);
    String region=null;
    for(var edge:targetIncoming){
      if(!(edge instanceof org.opentripplanner.street.model.edge.GovernmentEndpointEdge connector)||
          !owned.ownedConnectors().contains(edge)||edge.getToVertex()!=target||
          !(edge.getFromVertex() instanceof org.opentripplanner.street.model.vertex.TemporarySplitterVertex)||
          !owned.ownedSplits().contains(edge.getFromVertex()))return null;
      String edgeRegion=connector.getAttachmentProof().regionId();
      if(region!=null&&!region.equals(edgeRegion))return null;
      region=edgeRegion;cut.add(edge.getFromVertex());
    }
    if(from.stream().anyMatch(cut::contains))return null;
    Set<Edge> boundary=java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
    var reasons=new java.util.TreeSet<String>();
    for(var split:cut){
      if(split==target)continue;
      var incoming=List.copyOf(split.getIncoming());
      if(incoming.isEmpty())return null;
      for(var edge:incoming){
        if(!(edge instanceof TemporaryPartialStreetEdge partial)||!owned.ownedPartials().contains(edge)||
            edge.getToVertex()!=split||cut.contains(edge.getFromVertex()))return null;
        StreetEdge parent=partial.getParentEdge();
        while(parent instanceof TemporaryPartialStreetEdge previous)parent=previous.getParentEdge();
        var metadata=partial.getPolicyMetadata();
        if(partial.isStairs()||parent.isStairs()||metadata==null||!Integer.valueOf(2).equals(metadata.captureSchemaVersion())||
            !Objects.equals(metadata,parent.getPolicyMetadata())||metadata.endpointSurfaceProof()==null||
            !metadata.endpointSurfaceProof().eligible()||!region.equals(metadata.endpointSurfaceProof().regionId()))return null;
        var limits=streetLimits(partial);
        if(!limits.narrow()&&!limits.steep())return null;
        if(limits.narrow())reasons.add("KNOWN_WIDTH");
        if(limits.steep())reasons.add("KNOWN_NON_STAIR_SLOPE");
        boundary.add(edge);
      }
    }
    if(boundary.isEmpty())return null;
    return new EndpointConstraintEvidence("SELECTED_ENDPOINT_ATTACHMENT","TO","TERMINAL_CUT",List.copyOf(reasons),boundary.size());
  }

  // ISOLATED PROTOTYPE: retain the stock graph/search and test an actual edge veto.
  private static boolean prototypeHardWheelchairSkip(State state, Edge edge) {
    // Direct WALK has no adjacent rail leg authorizing a paid-area boundary.
    if (state.getRequest().mode() == org.opentripplanner.street.model.StreetMode.WALK &&
        edge instanceof PathwayEdge pathway && pathway.getPolicyMetadata() != null) {
      String mode = pathway.getPolicyMetadata().mode();
      if ("FARE_GATE".equals(mode) || "EXIT_GATE".equals(mode)) {
        LOG.debug("PROTOTYPE_FARE_SKIP metadata={}", pathway.getPolicyMetadata());
        return true;
      }
    }
    var executed = DirectWalkPolicyContext.observed(state.getRequest());
    boolean assisted = executed != null && executed.profile() ==
      org.opentripplanner.routing.api.request.DirectWalkPolicyProfile.WHEELCHAIR_STAIRS_ASSISTED;
    if (!state.getRequest().wheelchairEnabled()) return false;
    if (edge instanceof StreetTransitEntityLink<?> link) {
      return link.getWheelchairAccessibility() == Accessibility.NOT_POSSIBLE;
    }
    if (edge instanceof ElevatorHopEdge hop) {
      var metadata = hop.getPolicyMetadata();
      boolean skip = hop.getWheelchairAccessibility() == Accessibility.NOT_POSSIBLE ||
        (metadata != null && tooNarrow(metadata.knownWidthMeters()));
      if (skip) LOG.debug("PROTOTYPE_ELEVATOR_SKIP accessibility={} metadata={}", hop.getWheelchairAccessibility(), metadata);
      return skip;
    }
    if (edge instanceof PathwayEdge pathway) {
      var metadata = pathway.getPolicyMetadata();
      boolean stairs = pathway.getSteps() != 0 || (metadata != null && "STAIRS".equals(metadata.mode()));
      boolean escalator = metadata != null && "ESCALATOR".equals(metadata.mode());
      boolean assistedStairs = assisted && stairs && !escalator;
      boolean skip = escalator || (!assistedStairs && stairs) || (metadata != null && (
        tooNarrow(metadata.knownMinWidthMeters()) ||
        (!assistedStairs && (Boolean.FALSE.equals(metadata.knownWheelchairAccessible()) || tooSteep(metadata.knownSlopeRatio())))
      ));
      if (skip) LOG.debug("PROTOTYPE_PATHWAY_SKIP steps={} metadata={}", pathway.getSteps(), metadata);
      return skip;
    }
    if (!(edge instanceof StreetEdge street)) return false;
    StreetEdge parent = street;
    while (parent instanceof TemporaryPartialStreetEdge partial) {
      parent = partial.getParentEdge();
    }
    var metadata = street.getPolicyMetadata();
    // Repository wheelchair profile: cost.ts WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M = 0.9;
    // same 1e-6 comparison precision as cost.ts; unknown remains unknown.
    if (executed != null && (metadata == null || !Integer.valueOf(2).equals(metadata.captureSchemaVersion())))
      throw new IllegalStateException("Explicit wheelchair profile requires captured street constraint metadata v2");
    boolean impassable = metadata != null && ("impassable".equals(metadata.knownSmoothness()) ||
      metadata.areaSources().stream().anyMatch(area -> "impassable".equals(area.knownSmoothness())));
    var limits=streetLimits(street);
    boolean narrow=limits.narrow();
    boolean steep=limits.steep();
    boolean stairs = street.isStairs() || parent.isStairs();
    boolean assistedStairs = assisted && stairs;
    boolean skip = impassable || narrow || (!assistedStairs && (steep || stairs || !street.isWheelchairAccessible()
      || !parent.isWheelchairAccessible()));
    if (skip) {
      LOG.debug(
        "PROTOTYPE_HARD_SKIP partial={} stairs={} accessible={} parentStairs={} parentAccessible={} narrow={} metadata={} steep={}",
        edge instanceof TemporaryPartialStreetEdge, street.isStairs(),
        street.isWheelchairAccessible(), parent.isStairs(), parent.isWheelchairAccessible(), narrow, metadata, steep
      );
    }
    return skip;
  }

  /**
   * Try to find N paths through the Graph
   */
  public List<GraphPath<State, Edge, Vertex>> graphPathFinderEntryPoint(
    RouteRequest request,
    LinkingContext linkingContext
  ) {
    return graphPathFinderEntryPoint(
      request,
      linkingContext.findVertices(request.from()),
      linkingContext.findVertices(request.to())
    );
  }

  public List<GraphPath<State, Edge, Vertex>> graphPathFinderEntryPoint(
    RouteRequest request,
    Set<Vertex> from,
    Set<Vertex> to
  ) {
    OTPRequestTimeoutException.checkForTimeout();
    var reqTime = request.dateTime() == null ? RouteRequest.normalizeNow() : request.dateTime();

    List<GraphPath<State, Edge, Vertex>> paths = getPaths(request, from, to);

    // Detect and report that most obnoxious of bugs: path reversal asymmetry.
    // Removing paths might result in an empty list, so do this check before the empty list check.
    if (paths != null) {
      Iterator<GraphPath<State, Edge, Vertex>> gpi = paths.iterator();
      while (gpi.hasNext()) {
        GraphPath<State, Edge, Vertex> graphPath = gpi.next();
        // TODO check, is it possible that arriveBy and time are modifed in-place by the search?
        if (request.arriveBy()) {
          if (graphPath.states.getLast().getTimeAccurate().isAfter(reqTime)) {
            LOG.error(
              "A graph path arrives {} after the requested time {}. This implies a bug.",
              graphPath.states.getLast().getTimeAccurate(),
              reqTime
            );
            gpi.remove();
          }
        } else {
          if (graphPath.states.getFirst().getTimeAccurate().isBefore(reqTime)) {
            LOG.error(
              "A graph path leaves {} before the requested time {}. This implies a bug.",
              graphPath.states.getFirst().getTimeAccurate(),
              reqTime
            );
            gpi.remove();
          }
        }
      }
    }

    if (paths == null || paths.isEmpty()) {
      LOG.debug("Path not found: {} : {}", request.from(), request.to());
      throw new PathNotFoundException();
    }

    return paths;
  }
}
