import java.time.Duration;
import java.util.List;
import java.util.Set;
import org.opentripplanner.core.model.i18n.NonLocalizedString;
import org.opentripplanner.street.geometry.GeometryUtils;
import org.opentripplanner.street.model.StreetTraversalPermission;
import org.opentripplanner.street.model.edge.ExtensionRequestContext;
import org.opentripplanner.street.model.edge.StreetEdge;
import org.opentripplanner.street.model.edge.StreetEdgeBuilder;
import org.opentripplanner.street.model.vertex.LabelledIntersectionVertex;
import org.opentripplanner.street.search.StreetSearchBuilder;
import org.opentripplanner.street.search.request.StreetSearchRequest;
import org.opentripplanner.street.search.strategy.DominanceFunctions;

public class NativeWalkPriorityTest {
  static List<ExtensionRequestContext> policy(String profile, boolean avoidStairs) throws Exception {
    try {
      var type = Class.forName("org.opentripplanner.street.search.request.DirectWalkPolicy");
      return List.of((ExtensionRequestContext) type.getMethod("of", String.class, boolean.class)
        .invoke(null, profile, avoidStairs));
    } catch (ClassNotFoundException absentOnBaseline) { return List.of(); }
  }
  static StreetEdge edge(LabelledIntersectionVertex a, LabelledIntersectionVertex b,
      double metres, byte role, boolean stairs, boolean wheelchair) throws Exception {
    var builder = new StreetEdgeBuilder<>()
      .withFromVertex(a).withToVertex(b)
      .withGeometry(GeometryUtils.makeLineString(a.getCoordinate(), b.getCoordinate()))
      .withName(new NonLocalizedString(role == 1 ? "road" : "sidewalk"))
      .withMeterLength(metres).withPermission(StreetTraversalPermission.ALL)
      .withWheelchairAccessible(wheelchair).withStairs(stairs)
      .withWalkSafetyFactor(role == 1 ? 5f : 1f);
    try {
      var type = Class.forName("org.opentripplanner.street.model.edge.PedestrianEdgeRole");
      var value = type.getField(role == 1 ? "CARRIAGEWAY" : role == 3 ? "CROSSING" : role == 4 ? "OTHER" : "SIDEWALK").get(null);
      builder.getClass().getMethod("withPedestrianRole", type, long.class, double.class)
        .invoke(builder, value, role == 1 ? 10L : 20L, Double.NaN);
    } catch (ClassNotFoundException absentOnBaseline) { }
    return builder.buildAndConnect();
  }
  static void check(String label, String profile, boolean avoidStairs, boolean sidepath,
      boolean stairs, boolean accessible, String expected) throws Exception {
    var a = new LabelledIntersectionVertex("a",120.0,24.0,false,false);
    var b = new LabelledIntersectionVertex("b",120.0001,24.0001,false,false);
    var c = new LabelledIntersectionVertex("c",120.0002,24.0,false,false);
    edge(a,c,10,(byte)1,false,true);
    if (sidepath) { edge(a,b,100,(byte)2,stairs,accessible); edge(b,c,100,(byte)2,false,true); }
    var request = StreetSearchRequest.of().withWheelchairEnabled(profile.equals("WHEELCHAIR"))
      .withTimeout(Duration.ofSeconds(2)).withWalk(w->w.withSpeed(1).withReluctance(1))
      .withExtensionRequestContexts(policy(profile,avoidStairs)).build();
    var paths = StreetSearchBuilder.of().withPreStartHook(()->{}).withRequest(request).withFrom(Set.of(a)).withTo(Set.of(c))
      .withDominanceFunction(new DominanceFunctions.MinimumWeight()).getPathsToTarget();
    if (paths.size()!=1) throw new AssertionError(label+" expected one path");
    var path=paths.getFirst();
    String selected=path.edges.getFirst().getName().toString();
    if (!selected.equals(expected)) throw new AssertionError(label+" expected "+expected+" but selected "+selected);
    System.out.println("PASS "+label+" "+selected);
  }
  static org.opentripplanner.astar.model.GraphPath<org.opentripplanner.street.search.state.State,
      org.opentripplanner.street.model.edge.Edge,org.opentripplanner.street.model.vertex.Vertex>
      search(LabelledIntersectionVertex from, LabelledIntersectionVertex to, String profile,
          boolean avoidStairs, boolean reverse, boolean enabled) throws Exception {
    var request = StreetSearchRequest.of().withWheelchairEnabled(profile.equals("WHEELCHAIR"))
      .withArriveBy(reverse).withTimeout(Duration.ofSeconds(2))
      .withWalk(w->w.withSpeed(1).withReluctance(1))
      .withExtensionRequestContexts(enabled ? policy(profile,avoidStairs) : List.of()).build();
    var paths = StreetSearchBuilder.of().withPreStartHook(()->{}).withRequest(request)
      .withFrom(Set.of(from)).withTo(Set.of(to))
      .withDominanceFunction(new DominanceFunctions.MinimumWeight()).getPathsToTarget();
    if (paths.size()!=1) throw new AssertionError("Expected one path");
    return paths.getFirst();
  }
  static long primary(org.opentripplanner.street.search.state.State state) throws Exception {
    return (Long)state.getClass().getMethod("getPrimaryWeight").invoke(state);
  }
  static void advanced() throws Exception {
    var a=new LabelledIntersectionVertex("a",120,24,false,false);
    var b=new LabelledIntersectionVertex("b",120.0001,24.0001,false,false);
    var c=new LabelledIntersectionVertex("c",120.0002,24,false,false);
    var road=edge(a,c,10,(byte)1,false,true);
    edge(a,b,100,(byte)2,false,true); edge(b,c,100,(byte)2,false,true);
    var reverse=search(a,c,"WHEELCHAIR",true,true,true);
    if (!reverse.edges.getFirst().getName().toString().equals("sidewalk") || primary(reverse.states.getLast())!=0)
      throw new AssertionError("Reverse search lost sidewalk priority");
    var legacy=search(a,c,"WHEELCHAIR",true,false,false);
    if (legacy.edges.getFirst()!=road) throw new AssertionError("Unrequested legacy search changed");
    var forward=search(a,c,"WHEELCHAIR",true,false,true);
    var context=policy("WHEELCHAIR",true).getFirst();
    var evidence=(java.util.Map<?,?>)context.getClass().getMethod("evidence",List.class).invoke(context,forward.states);
    if (!evidence.get("version").equals("sidewalk-priority-v1") || evidence.get("maxSlopePercent")!=null)
      throw new AssertionError("Unknown elevation was represented as enforced");
    System.out.println("PASS reverse, legacy and executed policy metadata");

    var middle=new LabelledIntersectionVertex("partial",120.0001,24,false,false);
    var p=road.createPartialEdge(a,middle).orElseThrow();
    var req=StreetSearchRequest.of().withWheelchairEnabled(true).withExtensionRequestContexts(policy("WHEELCHAIR",true)).build();
    var traversed=p.traverse(new org.opentripplanner.street.search.state.State(a,req));
    if (traversed.length!=1 || primary(traversed[0])!=5000)
      throw new AssertionError("Partial edge lost its carriageway role");
    System.out.println("PASS temporary partial edge preserves actual role");

    var x=new LabelledIntersectionVertex("x",120,24,false,false);
    var y=new LabelledIntersectionVertex("y",120.0001,24,false,false);
    edge(x,y,8,(byte)3,false,true);
    var crossing=search(x,y,"NORMAL",true,false,true);
    if (primary(crossing.states.getLast())!=0) throw new AssertionError("Crossing penalized as longitudinal road");
    System.out.println("PASS legal crossing has zero carriageway exposure");

    var d=new LabelledIntersectionVertex("d",120,24,false,false);
    var e=new LabelledIntersectionVertex("e",120.0001,24.0001,false,false);
    var f=new LabelledIntersectionVertex("f",120.0002,24,false,false);
    var necessary=edge(d,f,10,(byte)1,false,true);edge(d,e,100,(byte)2,false,true);
    if (search(d,f,"WHEELCHAIR",true,false,true).edges.getFirst()!=necessary)
      throw new AssertionError("Disconnected sidewalk removed necessary road");
    System.out.println("PASS disconnected sidewalk retains necessary road");

    var limited=org.opentripplanner.routing.api.request.RouteRequest.of()
      .withFrom(org.opentripplanner.model.GenericLocation.fromCoordinate(a.getY(),a.getX()))
      .withTo(org.opentripplanner.model.GenericLocation.fromCoordinate(c.getY(),c.getX()))
      .withJourney(j->j.withWheelchair(true).withDirect(new org.opentripplanner.routing.api.request.request.StreetRequest(
        org.opentripplanner.street.model.StreetMode.WALK)))
      .withPreferences(prefs->prefs.withStreet(street->street.withMaxDirectDuration(Duration.ofSeconds(1),java.util.Map.of())));
    limited.getClass().getMethod("withDirectWalkPolicy",context.getClass()).invoke(limited,context);
    var limitedRequest=limited.buildRequest();
    var found=new org.opentripplanner.routing.impl.GraphPathFinder(null).getPaths(limitedRequest,Set.of(a),Set.of(c));
    if (found.size()!=1 || !found.getFirst().edges.getFirst().getName().toString().equals("sidewalk"))
      throw new AssertionError("Journey duration pruning restored a short road shortcut");
    var router=Class.forName("org.opentripplanner.routing.algorithm.raptoradapter.router.street.DirectStreetRouter");
    var distanceLimit=router.getDeclaredMethod("calculateDistanceMaxLimit",limitedRequest.getClass(),float.class);
    distanceLimit.setAccessible(true);
    if (!Double.isInfinite((Double)distanceLimit.invoke(null,limitedRequest,11.2f)))
      throw new AssertionError("Direct router precheck still limits sidewalk detours");
    System.out.println("PASS direct router preserves longer sidewalk beyond legacy duration bound");

    var schema=org.opentripplanner.apis.gtfs.SchemaFactory.createSchemaWithDefaultInjection(
      org.opentripplanner.routing.api.request.RouteRequest.defaultValue());
    if(schema.getQueryType().getFieldDefinition("plan").getArgument("directWalkProfile")==null
        ||schema.getObjectType("Leg").getFieldDefinition("walkPolicy")==null)
      throw new AssertionError("GraphQL policy contract missing");
    System.out.println("PASS production GraphQL schema and default injection");
  }
  static void regressions() throws Exception {
    var a=new LabelledIntersectionVertex("multi-a",120,24,false,false);
    var far=new LabelledIntersectionVertex("multi-far",120.001,24,false,false);
    var near=new LabelledIntersectionVertex("multi-near",120,24.00001,false,false);
    var farEdge=edge(a,far,102,(byte)2,false,true);
    var nearEdge=edge(a,near,1.2,(byte)2,false,true);
    var builder=org.opentripplanner.routing.api.request.RouteRequest.of()
      .withFrom(org.opentripplanner.model.GenericLocation.fromCoordinate(a.getY(),a.getX()))
      .withTo(org.opentripplanner.model.GenericLocation.fromCoordinate(far.getY(),far.getX()))
      .withJourney(j->j.withDirect(new org.opentripplanner.routing.api.request.request.StreetRequest(
        org.opentripplanner.street.model.StreetMode.WALK)))
      .withPreferences(prefs->prefs.withWalk(w->w.withReluctance(1)));
    var ctx=policy("NORMAL",true).getFirst();
    builder.getClass().getMethod("withDirectWalkPolicy",ctx.getClass()).invoke(builder,ctx);
    var targets=new java.util.LinkedHashSet<org.opentripplanner.street.model.vertex.Vertex>();
    targets.add(far);targets.add(near);
    var found=new org.opentripplanner.routing.impl.GraphPathFinder(null).getPaths(builder.buildRequest(),Set.of(a),targets);
    if(found.size()!=1||found.getFirst().edges.getFirst()!=nearEdge)
      throw new AssertionError("First-target heuristic defeated a better legal endpoint");
    System.out.println("PASS actual GraphPathFinder compares all legal target endpoints");

    var start=new LabelledIntersectionVertex("turn-a",120,24,false,false);
    var vertex=new LabelledIntersectionVertex("turn-v",120.001,24,false,false);
    var end=new LabelledIntersectionVertex("turn-t",120.002,24,false,false);
    var cheap=edge(start,vertex,100,(byte)2,false,true);
    var role=Class.forName("org.opentripplanner.street.model.edge.PedestrianEdgeRole");
    var costly=cheap.toBuilder().withGeometry(GeometryUtils.makeLineString(start.getCoordinate(),vertex.getCoordinate()))
      .withMeterLength(101).withName(new NonLocalizedString("straight approach"));
    var curved=cheap.toBuilder().withGeometry(GeometryUtils.makeLineString(java.util.List.of(start.getCoordinate(),end.getCoordinate(),vertex.getCoordinate())))
      .withMeterLength(100).withName(new NonLocalizedString("turn approach"));
    // Remove the original straight approach by making it unavailable to walking.
    cheap.setPermission(StreetTraversalPermission.CAR);
    var straight=costly.buildAndConnect();curved.buildAndConnect();
    edge(vertex,end,10,(byte)2,false,true);
    var turn=search(start,end,"NORMAL",true,false,true);
    if(turn.edges.getFirst()!=straight) throw new AssertionError("Incoming-edge pruning discarded cheaper turn continuation");
    System.out.println("PASS incoming street edges preserve native turn costs");

    var widthParser=role.getMethod("knownWidth",String.class,String.class,String.class);
    for(String h:List.of("footway","path","pedestrian","corridor","steps")) {
      double width=(Double)widthParser.invoke(null,h,null,"0.6 m");
      if(width!=0.6)throw new AssertionError("Known pedestrian width lost for "+h);
    }
    if(!Double.isNaN((Double)widthParser.invoke(null,"secondary",null,"0.6")))
      throw new AssertionError("Carriageway gross width was used as pedestrian clearance");
    var p=new LabelledIntersectionVertex("narrow-a",120,24,false,false);
    var q=new LabelledIntersectionVertex("narrow-b",120.0001,24,false,false);
    var narrowBuilder=new StreetEdgeBuilder<>().withFromVertex(p).withToVertex(q)
      .withGeometry(GeometryUtils.makeLineString(p.getCoordinate(),q.getCoordinate()))
      .withName(new NonLocalizedString("narrow path")).withMeterLength(5)
      .withPermission(StreetTraversalPermission.PEDESTRIAN);
    narrowBuilder.getClass().getMethod("withPedestrianRole",role,long.class,double.class)
      .invoke(narrowBuilder,role.getField("SIDEWALK").get(null),20L,0.6);
    var narrow=narrowBuilder.buildAndConnect();
    var wide=edge(p,q,10,(byte)1,false,true);
    if(search(p,q,"WHEELCHAIR",false,false,true).edges.getFirst()!=wide)
      throw new AssertionError("Narrow sidewalk defeated wheelchair admission");
    if(search(p,q,"NORMAL",true,false,true).edges.getFirst()!=narrow)
      throw new AssertionError("Normal avoidance inherited wheelchair-only width restriction");
    System.out.println("PASS source width and profile-specific admission");

    var u=new LabelledIntersectionVertex("gtfs-a",120,24,false,false);
    var v=new LabelledIntersectionVertex("gtfs-b",120.0001,24,false,false);
    var gtfs=org.opentripplanner.street.model.edge.PathwayEdge.createPathwayEdge(
      u,v,new NonLocalizedString("GTFS stairs without count"),5,5,0,0,false,true);
    var road=edge(u,v,10,(byte)1,false,true);
    if(search(u,v,"NORMAL",true,false,true).edges.getFirst()!=road)
      throw new AssertionError("GTFS stairs/escalator mode lost when stair_count omitted");
    var low=org.opentripplanner.street.model.edge.PathwayEdge.createLowCostPathwayEdge(u,v,false);
    if(search(u,v,"NORMAL",true,false,true).edges.getFirst()!=low)
      throw new AssertionError("Wheelchair-only barrier was misclassified as stairs for normal mode");
    System.out.println("PASS GTFS zero-count stairs and non-stair low-cost pathway");
  }
  static void slopeAndCopies() throws Exception {
    var a=new LabelledIntersectionVertex("slope-a",120,24,false,false);
    var b=new LabelledIntersectionVertex("slope-b",120.001,24,false,false);
    var steep=edge(a,b,100,(byte)2,false,true);
    var profile=new org.locationtech.jts.geom.impl.PackedCoordinateSequence.Double(new org.locationtech.jts.geom.Coordinate[]{
      new org.locationtech.jts.geom.Coordinate(0,0),new org.locationtech.jts.geom.Coordinate(100,50)},2);
    steep.setElevationExtension(org.opentripplanner.street.model.edge.StreetElevationExtensionBuilder.of(steep)
      .withComputed(false).withElevationProfile(profile).build().orElseThrow());
    if(!steep.isElevationFlattened()||steep.getMaxSlope()!=0)
      throw new AssertionError("Fixture did not exercise the native flattening branch");
    var request=StreetSearchRequest.of().withWheelchairEnabled(true)
      .withExtensionRequestContexts(policy("WHEELCHAIR",true)).build();
    if(steep.traverse(new org.opentripplanner.street.search.state.State(a,request)).length!=0)
      throw new AssertionError("Native flattening hid a known 50 percent grade");
    System.out.println("PASS raw elevation prevents flattened steep-edge admission");

    var flat=edge(a,b,100,(byte)2,false,true);
    flat.setElevationExtension(org.opentripplanner.street.model.edge.StreetElevationExtensionBuilder.of(flat)
      .withComputed(false).withElevationProfile(new org.locationtech.jts.geom.impl.PackedCoordinateSequence.Double(
        new org.locationtech.jts.geom.Coordinate[]{new org.locationtech.jts.geom.Coordinate(0,0),
          new org.locationtech.jts.geom.Coordinate(100,0)},2)).build().orElseThrow());
    var path=search(a,b,"WHEELCHAIR",true,false,true);
    var ctx=policy("WHEELCHAIR",true).getFirst();
    var ack=(java.util.Map<?,?>)ctx.getClass().getMethod("evidence",List.class).invoke(ctx,path.states);
    if(ack.get("maxSlopePercent")==null || ((Number)ack.get("maxSlopePercent")).doubleValue()!=8.3)
      throw new AssertionError("Executed profile bound was not preserved");
    System.out.println("PASS known profile returns the actual computational slope bound");

    var base=org.opentripplanner.routing.api.request.RouteRequest.of()
      .withFrom(org.opentripplanner.model.GenericLocation.fromCoordinate(24,120))
      .withTo(org.opentripplanner.model.GenericLocation.fromCoordinate(24,120.001)).buildRequest();
    var copy=base.copyOf();var normal=policy("NORMAL",true).getFirst();
    copy.getClass().getMethod("withDirectWalkPolicy",normal.getClass()).invoke(copy,normal);
    var updated=copy.buildRequest();
    if(updated==base || updated.getClass().getMethod("directWalkPolicy").invoke(updated)!=normal)
      throw new AssertionError("Immutable request discarded a policy-only edit");
    var again=updated.copyOf();var changed=policy("NORMAL",false).getFirst();
    again.getClass().getMethod("withDirectWalkPolicy",changed.getClass()).invoke(again,changed);
    var second=again.buildRequest();
    if(second==updated || second.equals(updated) || new java.util.HashSet<>(List.of(updated,second)).size()!=2)
      throw new AssertionError("Immutable policy constraints collapsed as equal");
    System.out.println("PASS immutable request copies retain policy-only changes");
  }
  static void timeout() throws Exception {
    var first=new LabelledIntersectionVertex("timeout-0",120,24,false,false);
    var last=first;
    for(int i=1;i<=201;i++) {
      var next=new LabelledIntersectionVertex("timeout-"+i,120+i*0.00001,24,false,false);
      edge(last,next,1,(byte)2,false,true);last=next;
    }
    var request=StreetSearchRequest.of().withTimeout(Duration.ofMillis(1))
      .withExtensionRequestContexts(policy("NORMAL",true)).build();
    var visitor=new org.opentripplanner.astar.spi.TraverseVisitor<org.opentripplanner.street.search.state.State,
        org.opentripplanner.street.model.edge.Edge>() {
      public void visitEdge(org.opentripplanner.street.model.edge.Edge e) { }
      public void visitEnqueue() { }
      public void visitVertex(org.opentripplanner.street.search.state.State state) { java.util.concurrent.locks.LockSupport.parkNanos(2_000_000); }
    };
    boolean aborted=false;
    try {
      StreetSearchBuilder.of().withPreStartHook(()->{}).withRequest(request)
        .withTraverseVisitor(visitor).withFrom(Set.of(first)).withTo(Set.of(last)).getPathsToTarget();
    } catch(IllegalStateException limit) { aborted=limit.getMessage().contains("timed out"); }
    if(!aborted)throw new AssertionError("Incomplete policy search became a completed route result");
    System.out.println("PASS computation timeout remains inconclusive");
  }
  public static void main(String[] args) throws Exception {
    check("wheelchair prefers connected longer sidewalk","WHEELCHAIR",true,true,false,true,"sidewalk");
    check("normal avoiding stairs prefers sidewalk","NORMAL",true,true,false,true,"sidewalk");
    check("normal prefers connected longer sidewalk","NORMAL",false,true,false,true,"sidewalk");
    check("necessary road retained","WHEELCHAIR",true,false,false,true,"road");
    check("stairs do not defeat avoidance","NORMAL",true,true,true,true,"road");
    check("wheelchair barrier does not defeat accessibility","WHEELCHAIR",false,true,false,false,"road");
    advanced();
    regressions();
    slopeAndCopies();
    timeout();
  }
}
