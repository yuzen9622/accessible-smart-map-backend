package org.opentripplanner.routing.algorithm.mapping;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.locationtech.jts.geom.Coordinate;
import org.opentripplanner.model.plan.leg.SelectedWalkPath;
import org.opentripplanner.model.plan.leg.SelectedWalkPath.Point;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.street.model.edge.Edge;
import org.opentripplanner.street.model.edge.PathwayEdge;
import org.opentripplanner.street.model.edge.StreetEdge;
import org.opentripplanner.street.model.edge.TemporaryPartialStreetEdge;
import org.opentripplanner.street.model.vertex.Vertex;
import org.opentripplanner.street.search.state.State;

public final class SelectedWalkPathMapper {
  private SelectedWalkPathMapper() {}

  public static SelectedWalkPath map(List<State> states, RouteRequest request, boolean startsPath, boolean endsPath) {
    var occurrences = new ArrayList<SelectedWalkPath.Occurrence>();
    Point first = null, last = null;
    int missing = 0, positiveMissing = 0, chainMismatch = 0;
    double length = 0;
    boolean gaps = false;
    Point previousGeometryEnd = null;
    for (int i = 1; i < states.size(); i++) {
      var from = states.get(i-1).getVertex();
      var to = states.get(i).getVertex();
      var occurrence = occurrence(i-1, states.get(i).getBackEdge(), from, to, previousGeometryEnd);
      occurrences.add(occurrence);
      if (occurrence.traversalDirection().equals("UNRESOLVED")) chainMismatch++;
      if (occurrence.coordinates().isEmpty()) {
        missing++;
        if (occurrence.distanceM() > 0) positiveMissing++;
        if (occurrence.geometryStatus().equals("INVALID_COORDINATE") || occurrence.vertexGapM() == null || occurrence.vertexGapM() > 0 || occurrence.distanceM() > 0) gaps = true;
      } else {
        if (first == null) first = occurrence.coordinates().getFirst();
        last = occurrence.coordinates().getLast();
        if (occurrence.gapFromPreviousGeometryM() != null && occurrence.gapFromPreviousGeometryM() > 0) gaps = true;
        if (occurrence.geometryStartToTraversalFromGapM() == null || occurrence.geometryEndToTraversalToGapM() == null ||
          occurrence.geometryStartToTraversalFromGapM() > 0 || occurrence.geometryEndToTraversalToGapM() > 0) gaps = true;
        length += occurrence.geometryLengthM();
      }
      // Null/empty occurrences remain explicit. This comparison is a gap measurement, never a joining segment.
      if (!occurrence.coordinates().isEmpty()) previousGeometryEnd = occurrence.coordinates().getLast();
    }
    var start = states.isEmpty() ? null : point(states.getFirst().getVertex().getCoordinate());
    var end = states.isEmpty() ? null : point(states.getLast().getVertex().getCoordinate());
    var from = request == null ? null : point(request.from().getCoordinate());
    var to = request == null ? null : point(request.to().getCoordinate());
    String status = occurrences.isEmpty() ? "EMPTY_PATH" : chainMismatch > 0 ? "UNRESOLVED_STATE_CHAIN" : first == null ? "NO_NATIVE_GEOMETRY" : gaps ? "NATIVE_GEOMETRY_GAPS" : "NATIVE_GEOMETRY_COMPLETE";
    return new SelectedWalkPath(status, "FLOAT64_NATIVE_NO_ADDITIONAL_QUANTIZATION", "HAVERSINE_R6371000_METERS", startsPath, endsPath,
      from, to, start, end, first, last, distance(from,start), distance(to,end), distance(from,first), distance(to,last),
      missing, positiveMissing, chainMismatch, length, occurrences);
  }

  static SelectedWalkPath.Occurrence occurrence(int index, Edge edge, Vertex from, Vertex to, Point previousEnd) {
    var fromPoint = point(from.getCoordinate());
    var toPoint = point(to.getCoordinate());
    String direction = edge.getFromVertex() == from && edge.getToVertex() == to ? "EDGE_FORWARD" :
      edge.getFromVertex() == to && edge.getToVertex() == from ? "EDGE_REVERSE" : "UNRESOLVED";
    var line = edge.getGeometry();
    var points = new ArrayList<Point>();
    String status = line == null ? "NULL" : line.isEmpty() ? "EMPTY" : "PRESENT";
    if (line != null) for (Coordinate coordinate : line.getCoordinates()) {
      Point value = point(coordinate);
      if (value == null) { status = "INVALID_COORDINATE"; points.clear(); break; }
      points.add(value);
    }
    if (direction.equals("EDGE_REVERSE")) Collections.reverse(points);
    String source = edge instanceof StreetEdge ? "NATIVE_STREET_COMPACT_E6_INTERMEDIATES" :
      edge instanceof PathwayEdge ? "NATIVE_PATHWAY_ENDPOINT_LINE" : "NATIVE_EDGE_GET_GEOMETRY";
    double length = 0;
    for (int i = 1; i < points.size(); i++) length += distance(points.get(i-1),points.get(i));
    return new SelectedWalkPath.Occurrence(index, edge.getClass().getSimpleName(), edge.getDistanceMeters(), edge instanceof TemporaryPartialStreetEdge,
      fromPoint,toPoint,direction,status,source,points,distance(fromPoint,toPoint),
      points.isEmpty() ? null : distance(points.getFirst(),fromPoint),
      points.isEmpty() ? null : distance(points.getLast(),toPoint),
      points.isEmpty() ? null : distance(previousEnd,points.getFirst()),length);
  }

  static Point point(Coordinate c) {
    return c == null || !Double.isFinite(c.x) || !Double.isFinite(c.y) ? null : new Point(c.y,c.x);
  }
  static Double distance(Point a, Point b) {
    if (a == null || b == null) return null;
    double p1=Math.toRadians(a.lat()), p2=Math.toRadians(b.lat());
    double dp=p2-p1, dl=Math.toRadians(b.lon()-a.lon());
    double h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
    h=Math.min(1,Math.max(0,h));
    return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
  }
}
