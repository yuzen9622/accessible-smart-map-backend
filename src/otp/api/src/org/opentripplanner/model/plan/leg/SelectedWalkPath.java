package org.opentripplanner.model.plan.leg;
import java.util.List;

/** Native edge geometry observations, never an assertion that off-network gaps are walkable. */
public record SelectedWalkPath(
  String geometryCoverageStatus, String coordinateEncoding, String gapMetric,
  boolean startsSearchPath, boolean endsSearchPath,
  Point requestFrom, Point requestTo, Point startState, Point endState,
  Point firstGeometryPoint, Point lastGeometryPoint,
  Double requestFromToStartStateGapM, Double requestToToEndStateGapM,
  Double requestFromToFirstGeometryGapM, Double requestToToLastGeometryGapM,
  int missingGeometryCount, int positiveDistanceMissingGeometryCount,
  int stateChainMismatchCount, double representedGeometryLengthM,
  List<Occurrence> occurrences
) {
  public SelectedWalkPath { occurrences = List.copyOf(occurrences); }
  public String endpointReachabilityStatus() { return "NOT_PROVEN_BY_GEOMETRY"; }
  public record Point(double lat, double lon) {}
  public record Occurrence(
    int occurrenceIndex, String edgeKind, double distanceM, boolean partial,
    Point traversalFrom, Point traversalTo, String traversalDirection,
    String geometryStatus, String geometrySource, List<Point> coordinates,
    Double vertexGapM, Double geometryStartToTraversalFromGapM,
    Double geometryEndToTraversalToGapM, Double gapFromPreviousGeometryM,
    double geometryLengthM
  ) { public Occurrence { coordinates = List.copyOf(coordinates); } }
}
