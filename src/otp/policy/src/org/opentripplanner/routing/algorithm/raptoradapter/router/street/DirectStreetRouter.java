package org.opentripplanner.routing.algorithm.raptoradapter.router.street;

import java.util.Collections;
import java.util.List;
import org.opentripplanner.astar.model.GraphPath;
import org.opentripplanner.framework.application.OTPRequestTimeoutException;
import org.opentripplanner.model.plan.Itinerary;
import org.opentripplanner.routing.algorithm.mapping.GraphPathToItineraryMapper;
import org.opentripplanner.routing.algorithm.mapping.ItinerariesHelper;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.routing.error.PathNotFoundException;
import org.opentripplanner.routing.graphfinder.TransitServiceResolver;
import org.opentripplanner.routing.impl.GraphPathFinder;
import org.opentripplanner.routing.linking.LinkingContext;
import org.opentripplanner.standalone.api.OtpServerRequestContext;
import org.opentripplanner.street.geometry.SphericalDistanceLibrary;
import org.opentripplanner.street.model.StreetMode;
import org.opentripplanner.street.model.edge.Edge;
import org.opentripplanner.street.model.vertex.Vertex;
import org.opentripplanner.street.search.state.State;

/**
 * Generates "direct" street routes, i.e. those that do not use transit and are on the street
 * network for the entire itinerary.
 *
 * @see DirectFlexRouter
 */
public class DirectStreetRouter {

  public static List<Itinerary> route(
    OtpServerRequestContext serverContext,
    RouteRequest request,
    LinkingContext linkingContext
  ) {
    if (request.journey().direct().mode() == StreetMode.NOT_SET) {
      return Collections.emptyList();
    }
    var executed = org.opentripplanner.routing.impl.DirectWalkExecutedPolicy.from(request);
    GraphPathFinder gpFinder = null;
    try {
      OTPRequestTimeoutException.checkForTimeout();
      var maxCarSpeed = serverContext.streetLimitationParametersService().maxCarSpeed();
      if (!straightLineDistanceIsWithinLimit(request, maxCarSpeed, linkingContext)) {
        record(request, executed, "NOT_EXECUTED_LIMIT", "DISTANCE_LIMIT", false);
        return Collections.emptyList();
      }

      // we could also get a persistent router-scoped GraphPathFinder but there's no setup cost here
      gpFinder = new GraphPathFinder(
        serverContext.traverseVisitor(),
        serverContext.listExtensionRequestContexts(request),
        maxCarSpeed
      );
      List<GraphPath<State, Edge, Vertex>> paths = gpFinder.graphPathFinderEntryPoint(
        request,
        linkingContext
      );

      // Convert the internal GraphPaths to itineraries
      final GraphPathToItineraryMapper graphPathToItineraryMapper = new GraphPathToItineraryMapper(
        new TransitServiceResolver(serverContext.transitService()),
        serverContext.transitService().getTimeZone(),
        serverContext.graph().streetNotesService,
        serverContext.streetDetailsService(),
        serverContext.graph().ellipsoidToGeoidDifference
      );
      List<Itinerary> response = graphPathToItineraryMapper.mapItineraries(paths, request);
      response = ItinerariesHelper.decorateItinerariesWithRequestData(
        response,
        request.journey().wheelchair(),
        request.preferences().wheelchair()
      );
      record(request, executed, "FOUND", outcome(gpFinder), gpFinder.durationLimitPruned());
      return response;
    } catch (PathNotFoundException e) {
      if(gpFinder!=null&&gpFinder.endpointConstraint()!=null){
        if(request.directWalkSearchTrace()!=null)request.directWalkSearchTrace().recordEndpointBlocked(request,gpFinder.endpointConstraint());
        return Collections.emptyList();
      }
      String outcome = outcome(gpFinder);
      boolean pruned = gpFinder != null && gpFinder.durationLimitPruned();
      String status = "EXHAUSTED".equals(outcome) && !pruned ? "COMPLETED_NO_ROUTE"
        : "TIMEOUT".equals(outcome) ? "TIMEOUT" : "INCOMPLETE";
      record(request, executed, status, outcome, pruned);
      return Collections.emptyList();
    } catch (RuntimeException e) {
      record(request, executed, e instanceof OTPRequestTimeoutException ? "TIMEOUT" : "ERROR", outcome(gpFinder),
        gpFinder != null && gpFinder.durationLimitPruned());
      throw e;
    }
  }

  private static String outcome(GraphPathFinder finder) {
    return finder == null || finder.searchCompletion() == null ? "NOT_STARTED" : finder.searchCompletion().name();
  }

  private static void record(RouteRequest request, org.opentripplanner.routing.impl.DirectWalkExecutedPolicy policy,
    String status, String outcome, boolean pruned) {
    if (policy != null && request.directWalkSearchTrace() != null)
      request.directWalkSearchTrace().record(request, status, outcome, pruned);
  }

  private static boolean straightLineDistanceIsWithinLimit(
    RouteRequest request,
    float maxCarSpeed,
    LinkingContext linkingContext
  ) {
    // TODO This currently only calculates the distances between the first fromVertex
    //      and the first toVertex
    double distance = SphericalDistanceLibrary.distance(
      linkingContext.findVertices(request.from()).iterator().next().getCoordinate(),
      linkingContext.findVertices(request.to()).iterator().next().getCoordinate()
    );
    return distance < calculateDistanceMaxLimit(request, maxCarSpeed);
  }

  /**
   * Calculates the maximum distance in meters based on the maxDirectStreetDuration and the
   * fastest mode available. This assumes that it is not possible to exceed the speed defined in the
   * RouteRequest.
   */
  private static double calculateDistanceMaxLimit(RouteRequest request, float maxCarSpeed) {
    var preferences = request.preferences();
    double distanceLimit;
    StreetMode mode = request.journey().direct().mode();

    double durationLimit = preferences.street().maxDirectDuration().valueOf(mode).toSeconds();

    if (mode.includesDriving()) {
      distanceLimit = durationLimit * maxCarSpeed;
    } else if (mode.includesBiking()) {
      distanceLimit = durationLimit * preferences.bike().speed();
    } else if (mode.includesScooter()) {
      distanceLimit = durationLimit * preferences.scooter().speed();
    } else if (mode.includesWalking()) {
      distanceLimit = durationLimit * preferences.walk().speed();
    } else {
      throw new IllegalStateException("Could not set max limit for StreetMode");
    }

    return distanceLimit;
  }
}
