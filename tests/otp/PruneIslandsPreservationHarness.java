import java.util.*;
import org.locationtech.jts.geom.*;
import org.opentripplanner.core.model.accessibility.Accessibility;
import org.opentripplanner.core.model.i18n.NonLocalizedString;
import org.opentripplanner.core.model.id.FeedScopedId;
import org.opentripplanner.graph_builder.issue.api.DataImportIssueStore;
import org.opentripplanner.graph_builder.module.StreetLinkerModule;
import org.opentripplanner.graph_builder.module.islandpruning.PruneIslands;
import org.opentripplanner.street.graph.Graph;
import org.opentripplanner.street.linking.*;
import org.opentripplanner.street.model.StreetTraversalPermission;
import org.opentripplanner.street.model.edge.*;
import org.opentripplanner.street.model.vertex.*;
import org.opentripplanner.street.search.TraverseMode;
import org.opentripplanner.transit.service.*;

/** Offline regression through actual OTP pruning, repositories, permanent linker and graph edges. */
public class PruneIslandsPreservationHarness {
  static final GeometryFactory GEO = new GeometryFactory();
  static long nextId;
  static int checks, cases;
  static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); checks++; }
  static void passed(String name) { cases++; System.out.println("CASE PASS " + name); }

  static class Fixture {
    final Graph graph = new Graph();
    final SiteRepositoryBuilder sites = SiteRepository.of();
    final List<StreetEdge> original = new ArrayList<>();
    final List<String> originalState = new ArrayList<>();
    final List<OsmVertex> main = new ArrayList<>();
    TimetableRepository timetable;
    VertexLinker linker;
    StreetLinkerModule module;
    Fixture(double mainLatitude) {
      for (int i = 0; i < 40; i++) main.add(vertex(121 + (i - 20) * .00005, mainLatitude));
      for (int i = 1; i < main.size(); i++) pair(main.get(i - 1), main.get(i), false);
    }
    OsmVertex vertex(double lon, double lat) {
      var v = new OsmVertex(lon, lat, ++nextId); graph.addVertex(v); return v;
    }
    StreetEdge edge(StreetVertex from, StreetVertex to, StreetTraversalPermission permission, boolean government) {
      var builder = new StreetEdgeBuilder<>().withFromVertex(from).withToVertex(to)
        .withGeometry(GEO.createLineString(new Coordinate[]{from.getCoordinate(), to.getCoordinate()}))
        .withMeterLength(Math.max(.01, Math.hypot(from.getLon()-to.getLon(), from.getLat()-to.getLat()) * 111320))
        .withName(government ? "government sidewalk" : "original street").withPermission(permission);
      if (government) builder.withPolicyMetadata(new StreetPolicyMetadata(++nextId, 0, false, 2.0,
        List.of("government-source-fixture"), List.of("government-source-fixture"), "202606", "1", "fixture", List.of()));
      var edge = builder.buildAndConnect(); original.add(edge); return edge;
    }
    void pair(StreetVertex a, StreetVertex b, boolean government) {
      edge(a,b,StreetTraversalPermission.ALL,government); edge(b,a,StreetTraversalPermission.ALL,government);
    }
    List<OsmVertex> island(double lon, double lat, boolean government) {
      OsmVertex a=vertex(lon,lat), b=vertex(lon+.00003,lat), c=vertex(lon+.00003,lat+.00003), d=vertex(lon,lat+.00003);
      pair(a,b,government);pair(b,c,government);pair(c,d,government);pair(d,a,government);
      return List.of(a,b,c,d);
    }
    TransitStopVertex stop(String name, StreetVertex attach, boolean ferry) {
      var id=new FeedScopedId("test",name);
      var regular=sites.regularStop(id).withName(new NonLocalizedString(name)).withCoordinate(attach.getLat(),attach.getLon())
        .withWheelchairAccessibility(Accessibility.POSSIBLE).build(); sites.withRegularStop(regular);
      var s=TransitStopVertex.of().withId(id).withCoordinate(attach.getLat(),attach.getLon())
        .withWheelchairAccessiblity(Accessibility.POSSIBLE).withIsFerry(ferry).build();graph.addVertex(s);
      StreetTransitStopLink.createStreetTransitStopLink(attach,s);StreetTransitStopLink.createStreetTransitStopLink(s,attach);
      return s;
    }
    void prepare() {
      graph.index();timetable=new TimetableRepository(sites.build());
      linker=new VertexLinker(graph,VisibilityMode.TRAVERSE_AREA_EDGES,500,false);
      module=new StreetLinkerModule(graph,linker,null,timetable,DataImportIssueStore.NOOP);
      originalState.clear();for(var e:original)originalState.add(signature(e));
    }
    PruneIslands pruning(StreetLinkerModule chosen) {
      var p=new PruneIslands(graph,timetable,DataImportIssueStore.NOOP,chosen);
      p.setPruningThresholdIslandWithStops(0);p.setPruningThresholdIslandWithoutStops(0);
      p.setAdaptivePruningDistance(250);p.setAdaptivePruningFactor(50);return p;
    }
    void run() {pruning(module).buildGraph();}
    void assertStreetsPreserved() {
      for(int i=0;i<original.size();i++){
        var e=original.get(i);
        check(e.getFromVertex().getOutgoing().contains(e),"original street edge retained: "+i);
        check(signature(e).equals(originalState.get(i)),"original geometry/permission/nothru/provenance retained: "+i);
      }
      for(var e:graph.getStreetEdges())check(!e.isExcludedFromStopLinking(),"temporary linking marker cleared");
    }
  }

  static String signature(StreetEdge e) {
    return e.getGeometry().toText()+"|"+e.getPermission()+"|"+e.isWalkNoThruTraffic()+"|"+
      e.isBicycleNoThruTraffic()+"|"+e.isMotorVehicleNoThruTraffic()+"|"+e.getPolicyMetadata();
  }
  static Set<Vertex> connected(Vertex start) {
    var seen=Collections.newSetFromMap(new IdentityHashMap<Vertex,Boolean>());var queue=new ArrayDeque<Vertex>();seen.add(start);queue.add(start);
    while(!queue.isEmpty())for(var e:queue.removeFirst().getOutgoing())
      if(!(e instanceof StreetEdge s)||s.canTraverse(TraverseMode.WALK))if(seen.add(e.getToVertex()))queue.add(e.getToVertex());
    return seen;
  }
  static Set<String> stopLinks(TransitStopVertex stop) {
    var out=new TreeSet<String>();
    for(var e:stop.getOutgoing())if(e instanceof StreetTransitStopLink)out.add("out:"+e.getGeometry().toText());
    for(var e:stop.getIncoming())if(e instanceof StreetTransitStopLink)out.add("in:"+e.getGeometry().toText());
    return out;
  }
  static Set<Edge> stopLinkObjects(TransitStopVertex stop) {
    var links=Collections.newSetFromMap(new IdentityHashMap<Edge,Boolean>());
    for(var e:stop.getOutgoing())if(e instanceof StreetTransitStopLink)links.add(e);
    for(var e:stop.getIncoming())if(e instanceof StreetTransitStopLink)links.add(e);
    return links;
  }
  static void relinkPreservesStreetsAndGovernmentIsland() {
    var f=new Fixture(25.0002);var old=f.island(121,25,false);var s=f.stop("stranded",old.getFirst(),false);
    var gov=f.island(121.0015,25.00008,true);
    var spur=f.vertex(121.0008,25.00025);f.pair(f.main.get(36),spur,false);
    for(var e:spur.getIncoming())if(e instanceof StreetEdge street)street.setWalkNoThruTraffic(true);
    for(var e:spur.getOutgoing())if(e instanceof StreetEdge street)street.setWalkNoThruTraffic(true);
    f.prepare();check(!connected(s).contains(f.main.getFirst()),"precondition: stop on isolated platform");
    f.run();check(connected(s).contains(f.main.getFirst()),"stop reconnects through actual StreetLinkerModule to main network");
    check(connected(f.main.getFirst()).contains(s),"main network reaches recovered stop in the reverse direction");
    check(!connected(s).contains(old.getFirst()),"no invented bridge between old platform and main network");
    check(connected(gov.getFirst()).contains(gov.getLast()),"government-only island remains walkable");
    check(!connected(gov.getFirst()).contains(f.main.getFirst()),"government island not bridged");f.assertStreetsPreserved();
    var links=stopLinks(s);int edges=f.graph.countEdges();f.run();
    check(stopLinks(s).equals(links),"second pass does not move a recovered stop again");check(f.graph.countEdges()==edges,"second pass adds no duplicate links");f.assertStreetsPreserved();
    passed("actual permanent relink; geometry, permissions, government island and no-thru preserved; repeat stable");
  }
  static void noAlternativeRestoresLinks() {
    var f=new Fixture(25.05);var old=f.island(121,25,false);var s=f.stop("no-alternative",old.getFirst(),false);
    // Nearby car-only geometry triggers the upstream adaptive proximity test but offers no walk candidate.
    OsmVertex a=f.vertex(121,25.0001),b=f.vertex(121.00003,25.0001);
    f.edge(a,b,StreetTraversalPermission.CAR,false);f.edge(b,a,StreetTraversalPermission.CAR,false);
    f.prepare();var before=stopLinks(s);var objects=stopLinkObjects(s);f.run();
    check(stopLinks(s).equals(before),"no walking alternative restores original directed stop links");
    check(stopLinkObjects(s).equals(objects),"no alternative restores original stop link object identities");
    check(connected(s).contains(old.getFirst()),"isolated stop remains connected to original platform");f.assertStreetsPreserved();
    passed("actual linker finds no alternative; original stop links restored");
  }
  static void mappedStationEdgesRemain() {
    var f=new Fixture(25.0002);var old=f.island(121,25,false);var s=f.stop("mapped-station",old.getFirst(),false);
    OsmVertex hall=f.vertex(121.00001,25.00001),upper=f.vertex(121.00001,25.00002);
    var pathway=PathwayEdge.createLowCostPathwayEdge(s,hall,true);
    var back=PathwayEdge.createLowCostPathwayEdge(hall,s,true);
    var elevator=ElevatorHopEdge.createElevatorHopEdge(hall,upper,StreetTraversalPermission.PEDESTRIAN,Accessibility.POSSIBLE,1,10);
    f.prepare();var before=stopLinks(s);f.run();
    check(stopLinks(s).equals(before),"mapped station not reattached by approximate-coordinate repair");
    check(s.getOutgoing().contains(pathway)&&hall.getOutgoing().contains(back),"actual GTFS pathway directions retained");
    check(hall.getOutgoing().contains(elevator),"actual elevator retained");f.assertStreetsPreserved();
    passed("mapped PathwayEdge and ElevatorHopEdge preserved");
  }
  static void ferryRemains() {
    var f=new Fixture(25.0002);var old=f.island(121,25,false);var s=f.stop("ferry",old.getFirst(),true);
    f.prepare();var before=stopLinks(s);f.run();
    check(stopLinks(s).equals(before),"upstream ferry island exception retained");
    check(!connected(s).contains(f.main.getFirst()),"ferry does not acquire an invented mainland link");f.assertStreetsPreserved();
    passed("ferry exception retains original island and stop links");
  }
  static void failureCleansMarkersAndRestoresLinks() {
    var f=new Fixture(25.0002);var old=f.island(121,25,false);var s=f.stop("fault",old.getFirst(),false);f.prepare();
    var before=stopLinks(s);var objects=stopLinkObjects(s);
    var failure=new StreetLinkerModule(f.graph,f.linker,null,f.timetable,DataImportIssueStore.NOOP){
      @Override public void linkTransitStops(Graph graph,TimetableRepository timetable){
        check(graph.getStreetEdges().stream().anyMatch(StreetEdge::isExcludedFromStopLinking),"fault occurs after candidate exclusion");
        throw new IllegalStateException("injected-linker-failure");
      }
    };
    try{f.pruning(failure).buildGraph();throw new AssertionError("expected linker failure");}
    catch(IllegalStateException expected){check(expected.getMessage().equals("injected-linker-failure"),"original exception preserved");}
    check(stopLinks(s).equals(before),"failed relink restores original links");f.assertStreetsPreserved();
    check(stopLinkObjects(s).equals(objects),"failed relink restores original stop link object identities");
    passed("relink exception restores stop links and clears markers");
  }
  static void nullLinkerPreservesLinks() {
    var f=new Fixture(25.0002);var old=f.island(121,25,false);var s=f.stop("no-linker",old.getFirst(),false);f.prepare();
    var before=stopLinks(s);f.pruning(null).buildGraph();
    check(stopLinks(s).equals(before),"absent linker does not strand original stop");f.assertStreetsPreserved();
    passed("absent relinker retains original stop links");
  }
  public static void main(String[] args) {
    relinkPreservesStreetsAndGovernmentIsland();noAlternativeRestoresLinks();mappedStationEdgesRemain();ferryRemains();failureCleansMarkersAndRestoresLinks();nullLinkerPreservesLinks();
    System.out.println("RESULT PASS "+cases+" cases, "+checks+" assertions");
  }
}
