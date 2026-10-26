package org.opentripplanner.street.model.edge;

import java.io.Serializable;
import java.util.Arrays;
import java.util.List;

/** ISOLATED PROTOTYPE: exact build-time provenance and known decimal metre width. */
public record StreetPolicyMetadata(
  long osmWayId, int segmentIndex, boolean reverse, Double knownWidthMeters,
  List<String> sourceRefs, List<String> widthSourceRefs, String sourceBatch, String sourceVersion, String sourceSha256, List<AreaSource> areaSources, Integer captureSchemaVersion, String knownSmoothness, EndpointSurfaceProof endpointSurfaceProof
) implements Serializable {
  public StreetPolicyMetadata(long osmWayId,int segmentIndex,boolean reverse,Double knownWidthMeters,
    List<String> sourceRefs,List<String> widthSourceRefs,String sourceBatch,String sourceVersion,String sourceSha256,List<AreaSource> areaSources) {
    this(osmWayId,segmentIndex,reverse,knownWidthMeters,sourceRefs,widthSourceRefs,sourceBatch,sourceVersion,sourceSha256,areaSources,null,null,null);
  }
  public StreetPolicyMetadata(long osmWayId,int segmentIndex,boolean reverse,Double knownWidthMeters,
    List<String> sourceRefs,List<String> widthSourceRefs,String sourceBatch,String sourceVersion,String sourceSha256,List<AreaSource> areaSources,
    Integer captureSchemaVersion,String knownSmoothness) {
    this(osmWayId,segmentIndex,reverse,knownWidthMeters,sourceRefs,widthSourceRefs,sourceBatch,sourceVersion,sourceSha256,areaSources,captureSchemaVersion,knownSmoothness,null);
  }
  public StreetPolicyMetadata(long osmWayId,int segmentIndex,boolean reverse,Double knownWidthMeters,
    List<String> sourceRefs,List<String> widthSourceRefs,String sourceBatch,String sourceVersion,String sourceSha256,List<AreaSource> areaSources,
    EndpointSurfaceProof proof) {
    this(osmWayId,segmentIndex,reverse,knownWidthMeters,sourceRefs,widthSourceRefs,sourceBatch,sourceVersion,sourceSha256,areaSources,null,null,proof);
  }
  public StreetPolicyMetadata withEndpointSurfaceProof(EndpointSurfaceProof proof) {
    return new StreetPolicyMetadata(osmWayId,segmentIndex,reverse,knownWidthMeters,sourceRefs,widthSourceRefs,sourceBatch,sourceVersion,sourceSha256,areaSources,captureSchemaVersion,knownSmoothness,proof);
  }
  public StreetPolicyMetadata {
    sourceRefs = List.copyOf(sourceRefs);
    widthSourceRefs = List.copyOf(widthSourceRefs);
    areaSources = List.copyOf(areaSources);
  }

  public record AreaSource(
    String osmId, Double knownWidthMeters, boolean stairs, boolean wheelchairAccessible, List<String> sourceRefs, List<String> widthSourceRefs,
    String sourceBatch, String sourceVersion, String sourceSha256, String knownSmoothness
  ) implements Serializable {
    public AreaSource(String osmId,Double knownWidthMeters,boolean stairs,boolean wheelchairAccessible,List<String> sourceRefs,List<String> widthSourceRefs,
      String sourceBatch,String sourceVersion,String sourceSha256){this(osmId,knownWidthMeters,stairs,wheelchairAccessible,sourceRefs,widthSourceRefs,sourceBatch,sourceVersion,sourceSha256,null);}
    public AreaSource { sourceRefs = List.copyOf(sourceRefs); widthSourceRefs = List.copyOf(widthSourceRefs); }
  }

  public static StreetPolicyMetadata forAreas(List<AreaSource> sources, boolean reverse) {
    var sorted = sources.stream().distinct().sorted(java.util.Comparator.comparing(AreaSource::osmId)).toList();
    Double width = sorted.stream().map(AreaSource::knownWidthMeters).filter(java.util.Objects::nonNull)
      .min(Double::compare).orElse(null);
    var refs = sorted.stream().flatMap(a -> a.sourceRefs().stream()).distinct().sorted().toList();
    var widthRefs = sorted.stream().flatMap(a -> a.widthSourceRefs().stream()).distinct().sorted().toList();
    // Area entities retain typed IDs and their individual evidence; no arbitrary parent wins.
    return new StreetPolicyMetadata(0, -1, reverse, width, refs, widthRefs, null, null, null, sorted,2,sorted.stream().anyMatch(a -> "impassable".equals(a.knownSmoothness())) ? "impassable" : null);
  }

  public static String captureSmoothness(String raw) { return raw==null||raw.isBlank()?null:raw.trim().toLowerCase(java.util.Locale.ROOT); }

  public static Double parseKnownWidthMeters(String value) {
    if (value == null || !value.trim().matches("[0-9]+(?:\\.[0-9]+)?(?: ?m)?")) return null;
    double metres = Double.parseDouble(value.trim().replace("m", "").trim());
    return Double.isFinite(metres) && metres > 0 ? metres : null;
  }

  public static List<String> parseSourceRefs(String refs, String ref) {
    String joined = refs == null ? ref : refs;
    return joined == null ? List.of() : Arrays.stream(joined.split(";"))
      .map(String::trim).filter(s -> !s.isEmpty()).distinct().sorted().toList();
  }
}
