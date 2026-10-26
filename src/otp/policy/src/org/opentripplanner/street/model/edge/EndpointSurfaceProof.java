package org.opentripplanner.street.model.edge;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.Serializable;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.Inflater;
import org.locationtech.jts.geom.*;
import org.locationtech.jts.io.WKBReader;

/** Immutable graph-owned source proof. Geometry is never returned to callers. */
public final class EndpointSurfaceProof implements Serializable {
  private static final long serialVersionUID = 1L;
  public static final String TAG = "asm:endpoint:proof:v1";
  private static final ObjectMapper JSON = new ObjectMapper().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
  private final String regionId, surfaceSha256, sourceVersion, sourceBatch, sourceSha256, ruleVersion, eligibility, regionKind;
  private final List<String> sourceRefs, grade;
  private final Geometry surface;
  private final Width base;
  private final List<Width> observations;
  private final boolean gradeKnown;
  private final List<Long> closureNodeIds;

  private record Width(Geometry geometry, String geometrySha256, Double width, List<String> refs) implements Serializable {}
  public record WidthResult(Double knownWidthMeters, List<String> sourceRefs, List<String> observationGeometrySha256, String coverageStatus) implements Serializable {
    public WidthResult { sourceRefs=List.copyOf(sourceRefs); observationGeometrySha256=List.copyOf(observationGeometrySha256); }
  }

  private EndpointSurfaceProof(String regionId, JsonNode p) throws Exception {
    requireFields(p, "crs", "rule_version", "region_kind", "eligibility", "closure_node_ids", "source_version", "source_batch", "source_sha256", "source_refs", "grade", "grade_known", "surface_wkb_hex", "surface_sha256", "width_base", "width_observations");
    if (!"EPSG:4326".equals(string(p,"crs"))) throw invalid("CRS");
    this.regionId=regionId; ruleVersion=string(p,"rule_version"); if(!"government-endpoint-v1".equals(ruleVersion))throw invalid("rule version");
    regionKind=string(p,"region_kind"); eligibility=string(p,"eligibility");
    sourceVersion=string(p,"source_version"); sourceBatch=string(p,"source_batch"); sourceSha256=digest(p,"source_sha256");
    sourceRefs=strings(p.get("source_refs")); if(sourceRefs.isEmpty()) throw invalid("empty source refs");
    surfaceSha256=digest(p,"surface_sha256"); surface=geometry(string(p,"surface_wkb_hex"),surfaceSha256,true);
    var gs=p.get("grade"); if(!gs.isArray() || gs.size()!=4) throw invalid("grade");
    var values=new ArrayList<String>(); for(var v:gs) { if(!v.isNull()&&!v.isTextual())throw invalid("grade item"); values.add(v.isNull()?null:v.textValue()); }
    grade=Collections.unmodifiableList(values); gradeKnown=bool(p,"grade_known");
    if(gradeKnown != grade.stream().allMatch(v->v!=null&&!v.startsWith("opaque:"))) throw invalid("grade knownness");
    var closures=p.get("closure_node_ids"); if(!closures.isArray())throw invalid("closures");
    var ids=new ArrayList<Long>(); for(var n:closures){if(!n.isIntegralNumber()||!n.canConvertToLong()||n.longValue()<=0)throw invalid("closure id");ids.add(n.longValue());}
    closureNodeIds=List.copyOf(ids);
    if(!ids.equals(ids.stream().distinct().sorted().toList()))throw invalid("closure order");
    if(!Set.of("effective_surface","shared_surface_precision_connector").contains(regionKind))throw invalid("region kind");
    String expectedEligibility="shared_surface_precision_connector".equals(regionKind)?"shared_precision_connector":!ids.isEmpty()?"closure_affected":!gradeKnown?"unknown_grade":"eligible";
    if(!eligibility.equals(expectedEligibility))throw invalid("eligibility");
    base=width(p.get("width_base"),false);
    var ws=p.get("width_observations"); if(!ws.isArray())throw invalid("width observations");
    var list=new ArrayList<Width>();for(var n:ws){var w=width(n,true);list.add(w);}observations=List.copyOf(list);
  }

  /** Builder-local interning; absent or explicitly unsupported payload never authorizes attachment. */
  public static EndpointSurfaceProof read(Map<String,String> tags, Map<String,EndpointSurfaceProof> intern) {
    var manifest=tags.get(TAG);
    if(manifest==null){ if(tags.keySet().stream().anyMatch(k->k.startsWith(TAG+":")))throw invalid("orphan chunk");return null; }
    try {
      var m=readJson(manifest);
      if(!m.path("schema_version").isIntegralNumber()||m.path("schema_version").intValue()!=1)throw invalid("schema");
      if("unsupported".equals(string(m,"status"))){
        requireFields(m,"schema_version","status","encoding","region_id","payload_bytes","compressed_bytes","chunk_count","chunk_size","reason");
        digest(m,"region_id");
        if(!"zlib-base64".equals(string(m,"encoding"))||!"payload_limits".equals(string(m,"reason"))||positiveInt(m,"chunk_size",1000)!=1000)throw invalid("unsupported manifest");
        int pb=positiveInt(m,"payload_bytes",Integer.MAX_VALUE),cb=positiveInt(m,"compressed_bytes",Integer.MAX_VALUE),cc=positiveInt(m,"chunk_count",Integer.MAX_VALUE);
        if(pb<=8*1024*1024&&cb<=2*1024*1024&&cc<=4096)throw invalid("false unsupported");
        if(tags.keySet().stream().anyMatch(k->k.startsWith(TAG+":")))throw invalid("unsupported chunks");
        return null;
      }
      requireFields(m,"schema_version","status","encoding","region_id","payload_bytes","compressed_bytes","chunk_count","chunk_size");
      if(!"supported".equals(string(m,"status"))||!"zlib-base64".equals(string(m,"encoding")))throw invalid("encoding");
      String id=digest(m,"region_id");
      int length=positiveInt(m,"payload_bytes",8*1024*1024), compressed=positiveInt(m,"compressed_bytes",2*1024*1024), count=positiveInt(m,"chunk_count",4096);
      if(positiveInt(m,"chunk_size",1000)!=1000)throw invalid("chunk size");
      var joined=new StringBuilder();
      for(int i=0;i<count;i++){
        var part=tags.get(TAG+":"+String.format(Locale.ROOT,"%06d",i));
        if(part==null||part.isEmpty()||part.length()>1000||(i<count-1&&part.length()!=1000)||!part.matches("[A-Za-z0-9+/]*={0,2}"))throw invalid("chunk content");
        joined.append(part);
      }
      if(tags.keySet().stream().filter(k->k.startsWith(TAG+":")).count()!=count)throw invalid("extra chunk");
      var bytes=Base64.getDecoder().decode(joined.toString());
      if(bytes.length!=compressed||!Base64.getEncoder().encodeToString(bytes).equals(joined.toString()))throw invalid("base64 length/canonical");
      var inflater=new Inflater();var decoded=new byte[length+1];int n=0;
      try{
        inflater.setInput(bytes);
        while(!inflater.finished() && n<decoded.length){int got=inflater.inflate(decoded,n,decoded.length-n);if(got==0)break;n+=got;}
        if(!inflater.finished()||inflater.getRemaining()!=0||n!=length)throw invalid("zlib length/trailing");
      }finally{inflater.end();}
      decoded=Arrays.copyOf(decoded,n);if(!sha(decoded).equals(id))throw invalid("region digest");
      var payload=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(decoded)).toString();
      // Validate bytes even on cache hits: a reused id must never conceal corrupt chunks.
      var existing=intern.get(id);if(existing!=null)return existing;
      var proof=new EndpointSurfaceProof(id,readJson(payload));intern.put(id,proof);return proof;
    }catch(Exception e){throw new IllegalArgumentException("Invalid government endpoint proof",e);}
  }

  public void verifyParent(StreetPolicyMetadata parent, LineString originalGeometry) {
    if(!sourceVersion.equals(parent.sourceVersion())||!sourceBatch.equals(parent.sourceBatch())||!sourceSha256.equals(parent.sourceSha256())||!sourceRefs.equals(parent.sourceRefs()))throw invalid("parent source identity");
    if(!surface.covers(originalGeometry))throw invalid("parent outside effective surface");
  }
  public boolean contains(Coordinate point){return surface.covers(surface.getFactory().createPoint(point));}
  public boolean covers(LineString line){return surface.covers(line);}
  public Envelope envelope(){return new Envelope(surface.getEnvelopeInternal());}
  public boolean effectiveSurface(){return "effective_surface".equals(regionKind);}
  public boolean eligible(){return "eligible".equals(eligibility)&&"effective_surface".equals(regionKind)&&gradeKnown&&closureNodeIds.isEmpty();}
  public WidthResult widthAlong(LineString line){
    Geometry uncovered=line;Double known=base.width();var refs=new TreeSet<String>();if(known!=null)refs.addAll(base.refs());var hashes=new TreeSet<String>();
    for(var w:observations) {
      if(w.width()==null)continue;
      boolean positive=false;
      for(var part:atomicGeometries(w.geometry()))if(part.intersection(line).getLength()>0){
        positive=true;uncovered=uncovered.difference(part);
      }
      if(positive){known=known==null?w.width():Math.min(known,w.width());refs.addAll(w.refs());hashes.add(w.geometrySha256());}
    }
    return new WidthResult(known,List.copyOf(refs),List.copyOf(hashes),known==null?"UNKNOWN":base.width()!=null||uncovered.getLength()==0?"KNOWN_OVER_ENTIRE_CONNECTOR":"PARTIALLY_KNOWN");
  }
  private static List<Geometry> atomicGeometries(Geometry geometry) {
    var parts=new ArrayList<Geometry>();
    if(geometry instanceof org.locationtech.jts.geom.GeometryCollection){
      for(int i=0;i<geometry.getNumGeometries();i++)parts.addAll(atomicGeometries(geometry.getGeometryN(i)));
    }else parts.add(geometry);
    return parts;
  }
  public String regionId(){return regionId;} public String surfaceSha256(){return surfaceSha256;}
  public String sourceVersion(){return sourceVersion;} public String sourceBatch(){return sourceBatch;}
  public String sourceSha256(){return sourceSha256;} public String ruleVersion(){return ruleVersion;}
  public List<String> sourceRefs(){return sourceRefs;} public List<String> grade(){return grade;}

  private static Width width(JsonNode n, boolean hasGeometry) throws Exception {
    if(hasGeometry)requireFields(n,"geometry_wkb_hex","geometry_sha256","source_refs","known","width_m");else requireFields(n,"source_refs","known","width_m");
    boolean known=bool(n,"known");var value=n.get("width_m");Double width=known&&value.isNumber()?value.doubleValue():null;
    if(known&&(width==null||!Double.isFinite(width)||width<=0)||!known&&!value.isNull())throw invalid("width knownness");
    var refs=strings(n.get("source_refs"));if(known&&refs.isEmpty())throw invalid("width refs");
    String hash=hasGeometry?digest(n,"geometry_sha256"):null;
    return new Width(hasGeometry?geometry(string(n,"geometry_wkb_hex"),hash,false):null,hash,width,refs);
  }
  private static Geometry geometry(String hex,String hash,boolean isSurface)throws Exception{
    if(!hex.matches("(?:[0-9a-f]{2})+"))throw invalid("WKB hex");var bytes=HexFormat.of().parseHex(hex);if(!sha(bytes).equals(hash))throw invalid("WKB digest");
    var g=new WKBReader().read(bytes);if((isSurface&&!(g instanceof Polygon || g instanceof MultiPolygon))||g.isEmpty()||!g.isValid()||(g.getSRID()!=0&&g.getSRID()!=4326))throw invalid("polygon");
    for(var c:g.getCoordinates())if(!Double.isFinite(c.x)||!Double.isFinite(c.y)||c.x< -180||c.x>180||c.y< -90||c.y>90||!Double.isNaN(c.getZ()))throw invalid("coordinate dimension/range");
    var canonical=new org.locationtech.jts.io.WKBWriter(2,org.locationtech.jts.io.ByteOrderValues.LITTLE_ENDIAN,false).write(g);
    if(!Arrays.equals(bytes,canonical))throw invalid("noncanonical or trailing WKB");
    return g;
  }
  private static JsonNode readJson(String text)throws Exception {
    try(var parser=JSON.createParser(text)){JsonNode node=JSON.readTree(parser);if(parser.nextToken()!=null)throw invalid("trailing JSON");return node;}
  }
  private static String sha(byte[] b)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));}
  private static void requireFields(JsonNode n,String... names){if(!n.isObject())throw invalid("object");var keys=new HashSet<String>();n.fieldNames().forEachRemaining(keys::add);if(!keys.equals(Set.of(names)))throw invalid("fields "+keys);}
  private static String string(JsonNode n,String k){var v=n.get(k);if(v==null||!v.isTextual()||v.textValue().isEmpty())throw invalid(k);return v.textValue();}
  private static String digest(JsonNode n,String k){String v=string(n,k);if(!v.matches("[0-9a-f]{64}"))throw invalid(k);return v;}
  private static boolean bool(JsonNode n,String k){var v=n.get(k);if(v==null||!v.isBoolean())throw invalid(k);return v.booleanValue();}
  private static int positiveInt(JsonNode n,String k,int max){var v=n.get(k);if(v==null||!v.isIntegralNumber()||!v.canConvertToInt()||v.intValue()<1||v.intValue()>max)throw invalid(k);return v.intValue();}
  private static List<String> strings(JsonNode n){if(n==null||!n.isArray())throw invalid("refs");var v=new ArrayList<String>();for(var e:n){if(!e.isTextual()||e.textValue().isEmpty())throw invalid("ref");v.add(e.textValue());}if(v.isEmpty()||!v.equals(v.stream().distinct().sorted().toList()))throw invalid("refs empty/duplicate/order");return List.copyOf(v);}
  private static IllegalArgumentException invalid(String reason){return new IllegalArgumentException("Endpoint proof: "+reason);}
}
