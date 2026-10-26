import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.GeometryFactory;
import org.opentripplanner.core.model.accessibility.Accessibility;
import org.opentripplanner.core.model.i18n.NonLocalizedString;
import org.opentripplanner.core.model.id.FeedScopedId;
import org.opentripplanner.model.GenericLocation;
import org.opentripplanner.routing.api.request.DirectWalkPolicyProfile;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.routing.linking.LinkingContextFactory;
import org.opentripplanner.routing.linking.LinkingContextRequest;
import org.opentripplanner.routing.linking.internal.VertexCreationService;
import org.opentripplanner.routing.linking.mapping.LinkingContextRequestMapper;
import org.opentripplanner.street.graph.Graph;
import org.opentripplanner.street.linking.LinkingDirection;
import org.opentripplanner.street.linking.TemporaryVerticesContainer;
import org.opentripplanner.street.linking.VertexLinker;
import org.opentripplanner.street.linking.VisibilityMode;
import org.opentripplanner.street.model.StreetMode;
import org.opentripplanner.street.model.StreetTraversalPermission;
import org.opentripplanner.street.model.edge.FreeEdge;
import org.opentripplanner.street.model.edge.StreetEdge;
import org.opentripplanner.street.model.edge.TemporaryFreeEdge;
import org.opentripplanner.street.model.edge.TemporaryPartialStreetEdge;
import org.opentripplanner.street.model.vertex.OsmVertex;
import org.opentripplanner.street.model.vertex.StreetVertex;
import org.opentripplanner.street.model.vertex.TemporaryStreetLocation;
import org.opentripplanner.street.model.vertex.TransitStopVertex;
import org.opentripplanner.street.model.vertex.Vertex;
import org.opentripplanner.street.search.TraverseMode;
import org.opentripplanner.street.search.TraverseModeSet;

/** Uses real OTP graph, edges, mapper, factory and request linking; no mocks or services. */
public class TransitEndpointFilterHarness {
  static final GeometryFactory GEOMETRY = new GeometryFactory();
  static final Method PROOF;
  static long nextId;
  static int checks;
  static {
    try {
      PROOF = VertexLinker.class.getDeclaredMethod("isProvenZeroStopComponent", StreetEdge.class, Set.class);
      PROOF.setAccessible(true);
    } catch (ReflectiveOperationException e) { throw new ExceptionInInitializerError(e); }
  }
  static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
    checks++;
  }
  static OsmVertex vertex(Graph graph, double lon, double lat) {
    var vertex = new OsmVertex(lon, lat, ++nextId);
    graph.addVertex(vertex);
    return vertex;
  }
  static StreetEdge street(StreetVertex from, StreetVertex to, StreetTraversalPermission permission) {
    return new org.opentripplanner.street.model.edge.StreetEdgeBuilder<>()
      .withFromVertex(from).withToVertex(to).withName("test")
      .withGeometry(GEOMETRY.createLineString(new Coordinate[]{from.getCoordinate(), to.getCoordinate()}))
      .withMeterLength(20).withPermission(permission).buildAndConnect();
  }
  static StreetEdge street(Graph graph, double lon, double lat) {
    return street(vertex(graph, lon - .0001, lat), vertex(graph, lon + .0001, lat), StreetTraversalPermission.ALL);
  }
  static TransitStopVertex stop(Graph graph, double lon, double lat) {
    var stop = TransitStopVertex.of().withId(new FeedScopedId("test", "stop" + (++nextId)))
      .withCoordinate(lat, lon).withWheelchairAccessiblity(Accessibility.POSSIBLE).withIsFerry(false).build();
    graph.addVertex(stop);
    return stop;
  }
  static VertexLinker linker(Graph graph) {
    return new VertexLinker(graph, VisibilityMode.TRAVERSE_AREA_EDGES, 500, false);
  }
  static boolean proof(VertexLinker linker, StreetEdge street) throws Exception {
    return proof(linker, street, freshCache());
  }
  static boolean proof(VertexLinker linker, StreetEdge street, Set<Vertex> cache) throws Exception {
    return (boolean) PROOF.invoke(linker, street, cache);
  }
  static Set<Vertex> freshCache() {
    return Collections.newSetFromMap(new IdentityHashMap<>());
  }
  static Vertex location(double lon, double lat) {
    return new TemporaryStreetLocation(new Coordinate(lon, lat), new NonLocalizedString("request"));
  }
  static double snappedLatitude(Vertex endpoint, boolean origin) {
    var edges = origin ? endpoint.getOutgoing() : endpoint.getIncoming();
    check(!edges.isEmpty(), "endpoint must have a link");
    var edge = edges.iterator().next();
    return origin ? edge.getToVertex().getLat() : edge.getFromVertex().getLat();
  }
  static void requestMappingAndFactory() throws Exception {
    var graph = new Graph();
    var isolated = street(graph, 121, 25);
    var connected = street(graph, 121, 25.0002);
    var stop = stop(graph, 121.0001, 25.0002);
    // Only incoming non-street connectivity: proof must be weak, not outgoing-only.
    FreeEdge.createFreeEdge(stop, connected.getToVertex());
    graph.index();
    var linker = linker(graph);
    var service = new VertexCreationService(linker);
    var factory = new LinkingContextFactory(graph, service);
    var from = GenericLocation.fromCoordinate(25.000001, 121);
    var to = GenericLocation.fromCoordinate(25.000001, 121.00001);
    for (boolean transit : List.of(false, true)) {
      for (var profile : List.of(DirectWalkPolicyProfile.UNSPECIFIED, DirectWalkPolicyProfile.NORMAL)) {
        var request = RouteRequest.of().withFrom(from).withTo(to).withDirectWalkPolicyProfile(profile)
          .withJourney(j -> { j.withAllModes(StreetMode.WALK); if (!transit) j.withTransit(t -> t.disable()); })
          .buildRequest();
        var mapped = LinkingContextRequestMapper.map(request);
        check(mapped.transitEndpointFiltering() == transit, "mapper transit flag");
        int permanentEdges = graph.countEdges();
        try (var temporary = new TemporaryVerticesContainer()) {
          var context = factory.create(temporary, mapped);
          double expected = transit ? 25.0002 : 25;
          check(Math.abs(snappedLatitude(context.findVertices(from).iterator().next(), true) - expected) < 1e-9,
            "factory origin respects transit / pure WALK separation " + profile + " " + transit);
          check(Math.abs(snappedLatitude(context.findVertices(to).iterator().next(), false) - expected) < 1e-9,
            "factory destination respects transit / pure WALK separation");
        }
        check(graph.countEdges() == permanentEdges, "request disposal preserves permanent graph");
      }
    }
    var original = LinkingContextRequest.of().withFrom(from).withTo(to).build();
    var filtered = original.copyOf().withTransitEndpointFiltering(true).build();
    check(original != filtered && !original.equals(filtered), "copy flag changes equality");
    check(original.hashCode() != filtered.hashCode(), "flag included in hashCode");
    check(filtered.copyOf().build() == filtered, "unchanged copy retains identity");
    check(!filtered.copyOf().withTransitEndpointFiltering(false).build().transitEndpointFiltering(), "copy clears flag");
    var mixed = new TraverseModeSet(List.of(TraverseMode.WALK, TraverseMode.CAR));
    var endpoint = location(121, 25.000001);
    var edges = linker.linkVertexForRequest(endpoint, mixed, LinkingDirection.INCOMING, true,
      (v, s) -> List.of(TemporaryFreeEdge.createTemporaryFreeEdge((TemporaryStreetLocation) v, s)));
    check(Math.abs(snappedLatitude(endpoint, true) - 25) < 1e-9, "mixed car access is unchanged");
    edges.disposeEdges();
    var via = GenericLocation.fromCoordinate(25.000001, 121.00002);
    var viaRequest = filtered.copyOf().withAccessMode(StreetMode.WALK).withEgressMode(StreetMode.WALK)
      .withTransferMode(StreetMode.WALK).withDirectMode(StreetMode.WALK)
      .withViaLocationsWithCoordinates(List.of(via)).build();
    try (var temporary = new TemporaryVerticesContainer()) {
      var context = factory.create(temporary, viaRequest);
      check(Math.abs(snappedLatitude(context.findVertices(via).iterator().next(), true) - 25.0002) < 1e-9,
        "via propagates filter flag");
    }
    // Old public overload retains its behavior, including temporary partial candidates.
    var oldEndpoint = location(121, 25.000001);
    var oldEdges = linker.linkVertexForRequest(oldEndpoint, new TraverseModeSet(TraverseMode.WALK), LinkingDirection.INCOMING,
      (v, s) -> List.of(TemporaryFreeEdge.createTemporaryFreeEdge((TemporaryStreetLocation) v, s)));
    check(Math.abs(snappedLatitude(oldEndpoint, true) - 25) < 1e-9, "old request overload unchanged");
    var partial = oldEdges.listEdges().stream().filter(TemporaryPartialStreetEdge.class::isInstance)
      .map(TemporaryPartialStreetEdge.class::cast).findFirst().orElseThrow();
    check(proof(linker, partial), "temporary partial candidate resolves permanent parent");
    oldEdges.disposeEdges();
    var permanent = vertex(graph, 121, 25.000001);
    linker.linkVertexPermanently(permanent, new TraverseModeSet(TraverseMode.WALK), LinkingDirection.BIDIRECTIONAL,
      (v, s) -> List.of(FreeEdge.createFreeEdge(v, s)));
    check(Math.abs(permanent.getOutgoing().iterator().next().getToVertex().getLat() - 25) < 1e-9,
      "permanent linking still chooses closest island");
  }
  static void conservativeProofs() throws Exception {
    var graph = new Graph();
    var edge = street(graph, 121, 25);
    var stop = stop(graph, 121, 25.0002);
    var middle = vertex(graph, 121, 25.0001);
    FreeEdge.createFreeEdge(middle, edge.getToVertex());
    FreeEdge.createFreeEdge(stop, middle);
    var linker = linker(graph);
    var cache = freshCache();
    check(!proof(linker, edge, cache), "arbitrary incoming non-street chain to stop must remain");
    check(cache.isEmpty(), "stop component never cached");

    graph = new Graph();
    edge = street(graph, 121, 25);
    middle = vertex(graph, 121, 25.0002);
    street((StreetVertex) edge.getToVertex(), middle, StreetTraversalPermission.CAR);
    FreeEdge.createFreeEdge(middle, stop(graph, 121, 25.0002));
    linker = linker(graph);
    cache = freshCache();
    check(proof(linker, edge, cache), "non-walk street does not connect pedestrian component");
    check(cache.size() == 2, "only completed walk component cached");

    graph = new Graph();
    edge = street(graph, 121, 25);
    var outside = new OsmVertex(121, 25.0002, ++nextId);
    FreeEdge.createFreeEdge(edge.getToVertex(), outside);
    linker = linker(graph);
    cache = freshCache();
    check(!proof(linker, edge, cache) && cache.isEmpty(), "unknown non-permanent neighbor retains candidate");

    graph = new Graph();
    edge = street(graph, 121, 25);
    stop = stop(graph, 121, 25.0002);
    var temporary = (TemporaryStreetLocation) location(121, 25.0001);
    TemporaryFreeEdge.createTemporaryFreeEdge(edge.getToVertex(), temporary);
    TemporaryFreeEdge.createTemporaryFreeEdge(temporary, stop);
    linker = linker(graph);
    cache = freshCache();
    check(proof(linker, edge, cache), "another request's temporary bridge does not pollute permanent proof");
    check(cache.size() == 2, "temporary vertices never cached");
  }
  static void searchRadiusAndStopId() throws Exception {
    var graph = new Graph();
    street(graph, 121, 25);
    var connected = street(graph, 121, 25.004);
    var stop = stop(graph, 121.0001, 25.004);
    FreeEdge.createFreeEdge(connected.getToVertex(), stop);
    graph.index();
    var service = new VertexCreationService(linker(graph));
    try (var temporary = new TemporaryVerticesContainer()) {
      var endpoint = service.createVertexFromCoordinate(temporary, new Coordinate(121, 25.000001), null,
        List.of(TraverseMode.WALK), VertexCreationService.LocationType.FROM, false, false, true, null);
      check(Math.abs(snappedLatitude(endpoint, true) - 25.004) < 1e-9, "existing 1000 m fallback finds connected candidate");
    }
    try (var temporary = new TemporaryVerticesContainer()) {
      var endpoint = service.createVertexFromCoordinate(temporary, new Coordinate(121, 24.99), null,
        List.of(TraverseMode.WALK), VertexCreationService.LocationType.FROM, false, false, true, null);
      check(endpoint.getOutgoing().isEmpty(), "existing 1000 m maximum radius remains unchanged");
    }
    var factory = new LinkingContextFactory(graph, service);
    var from = GenericLocation.fromStopId(stop.getId());
    var to = GenericLocation.fromCoordinate(25.004, 121);
    var request = LinkingContextRequest.of().withFrom(from).withTo(to).withAccessMode(StreetMode.WALK)
      .withEgressMode(StreetMode.WALK).withTransitEndpointFiltering(true).build();
    try (var temporary = new TemporaryVerticesContainer()) {
      check(factory.create(temporary, request).findVertices(from).contains(stop), "explicit stop ID bypasses endpoint filter");
    }
  }
  static void buildOnlyStopMarker() throws Exception {
    var graph = new Graph();
    var nearest = street(graph, 121, 25);
    nearest.setExcludedFromStopLinking(true);
    street(graph, 121, 25.0002);
    graph.index();
    var linker = linker(graph);
    var stop = stop(graph, 121, 25.000001);
    check(linker.linkToSpecificStreetEdgesPermanently(stop, new TraverseModeSet(TraverseMode.WALK),
      LinkingDirection.BIDIRECTIONAL, Set.of(nearest)).isEmpty(), "specific platform WALK stop respects build marker");
    linker.linkVertexPermanently(stop, new TraverseModeSet(TraverseMode.WALK), LinkingDirection.BIDIRECTIONAL,
      (v, s) -> List.of(FreeEdge.createFreeEdge(v, s)));
    check(Math.abs(stop.getOutgoing().iterator().next().getToVertex().getLat() - 25.0002) < 1e-9,
      "general WALK stop relinks away from build marker");
    var endpoint = location(121, 25.000001);
    var temporary = linker.linkVertexForRequest(endpoint, new TraverseModeSet(TraverseMode.WALK), LinkingDirection.INCOMING,
      (v, s) -> List.of(TemporaryFreeEdge.createTemporaryFreeEdge((TemporaryStreetLocation) v, s)));
    check(Math.abs(snappedLatitude(endpoint, true) - 25) < 1e-9, "build marker does not affect direct WALK endpoints");
    temporary.disposeEdges();
    var carStop = stop(graph, 121, 25.000001);
    check(!linker.linkToSpecificStreetEdgesPermanently(carStop, new TraverseModeSet(TraverseMode.CAR),
      LinkingDirection.BIDIRECTIONAL, Set.of(nearest)).isEmpty(), "specific CAR stop ignores build marker");
    var other = vertex(graph, 121, 25.000001);
    check(!linker.linkToSpecificStreetEdgesPermanently(other, new TraverseModeSet(TraverseMode.WALK),
      LinkingDirection.BIDIRECTIONAL, Set.of(nearest)).isEmpty(), "non-stop permanent entity ignores build marker");
    check(nearest.canTraverse(TraverseMode.WALK), "build marker never changes street permissions");
  }
  static void budgetsAndConcurrency() throws Exception {
    var graph = new Graph();
    var edge = street(graph, 121, 25);
    Vertex previous = edge.getToVertex();
    for (int i = 0; i < 254; i++) {
      var next = vertex(graph, 121 + i * .00001, 25);
      FreeEdge.createFreeEdge(previous, next);
      previous = next;
    }
    var linker = linker(graph);
    var cache = freshCache();
    check(proof(linker, edge, cache) && cache.size() == 256, "256-vertex complete component can be excluded");
    FreeEdge.createFreeEdge(previous, vertex(graph, 121.01, 25));
    cache = freshCache();
    check(!proof(linker, edge, cache) && cache.isEmpty(), "next operation sees 257-vertex component and retains it");
    graph = new Graph();
    edge = street(graph, 121, 25);
    for (int i = 0; i < 2100; i++) FreeEdge.createFreeEdge(edge.getFromVertex(), edge.getToVertex());
    linker = linker(graph);
    cache = freshCache();
    check(!proof(linker, edge, cache) && cache.isEmpty(), "adjacency budget retains dense component");

    graph = new Graph();
    var candidates = new ArrayList<StreetEdge>();
    for (int i = 0; i < 4200; i++) candidates.add(street(graph, 121, 25 + i * .00001));
    final var concurrentLinker = linker(graph);
    try (var executor = Executors.newFixedThreadPool(4)) {
      var tasks = candidates.stream().<java.util.concurrent.Callable<Boolean>>map(e -> () -> {
        var operationCache = freshCache();
        return proof(concurrentLinker, e, operationCache) && operationCache.size() == 2;
      }).toList();
      for (var result : executor.invokeAll(tasks)) check(result.get(), "concurrent operation caches are independent");
    }
    cache = freshCache();
    for (var candidate : candidates) check(proof(concurrentLinker, candidate, cache), "complete component proof within one operation");
    check(cache.size() == 8192, "each operation's cache is bounded");
    check(proof(concurrentLinker, candidates.getLast(), cache), "uncached component remains correctly filtered after cache fills");
  }
  static double transitSnap(VertexCreationService service) {
    try (var temporary = new TemporaryVerticesContainer()) {
      var endpoint = service.createVertexFromCoordinate(temporary, new Coordinate(121, 25.000001), null,
        List.of(TraverseMode.WALK), VertexCreationService.LocationType.FROM, false, false, true, null);
      return snappedLatitude(endpoint, true);
    }
  }
  static void stopConnectivityChangesBetweenRequests() throws Exception {
    for (String mode : List.of("permanent", "realtime", "specific")) {
      var graph = new Graph();
      var island = street(graph, 121, 25);
      var connected = street(graph, 121, 25.0002);
      FreeEdge.createFreeEdge(connected.getToVertex(), stop(graph, 121.0001, 25.0002));
      graph.index();
      var linker = linker(graph);
      var service = new VertexCreationService(linker);
      check(Math.abs(transitSnap(service) - 25.0002) < 1e-9, "initial zero-stop island excluded: " + mode);
      var addedStop = stop(graph, 121, 25.000001);
      org.opentripplanner.street.linking.DisposableEdgeCollection realtime = null;
      java.util.function.BiFunction<Vertex, StreetVertex, List<org.opentripplanner.street.model.edge.Edge>> links =
        (v, s) -> List.of(FreeEdge.createFreeEdge(v, s), FreeEdge.createFreeEdge(s, v));
      if (mode.equals("permanent")) {
        linker.linkVertexPermanently(addedStop, new TraverseModeSet(TraverseMode.WALK), LinkingDirection.BIDIRECTIONAL, links);
      } else if (mode.equals("realtime")) {
        realtime = linker.linkVertexForRealTime(addedStop, new TraverseModeSet(TraverseMode.WALK), LinkingDirection.BIDIRECTIONAL, links);
        check(realtime.listEdges().stream().anyMatch(TemporaryPartialStreetEdge.class::isInstance), "real realtime split created");
      } else {
        for (var linked : linker.linkToSpecificStreetEdgesPermanently(addedStop, new TraverseModeSet(TraverseMode.WALK),
          LinkingDirection.BIDIRECTIONAL, Set.of(island))) links.apply(addedStop, linked);
      }
      check(Math.abs(transitSnap(service) - 25) < 1e-9, "new stop makes next endpoint eligible: " + mode);
      if (realtime != null) {
        realtime.disposeEdges();
        check(Math.abs(transitSnap(service) - 25.0002) < 1e-9, "disposed realtime link restores zero-stop exclusion");
      }
    }
  }
  public static void main(String[] args) throws Exception {
    requestMappingAndFactory();
    conservativeProofs();
    searchRadiusAndStopId();
    buildOnlyStopMarker();
    budgetsAndConcurrency();
    stopConnectivityChangesBetweenRequests();
    System.out.println("PASS: " + checks + " assertions; real graph endpoint, mapper/factory, bounds and concurrency regressions");
  }
}
