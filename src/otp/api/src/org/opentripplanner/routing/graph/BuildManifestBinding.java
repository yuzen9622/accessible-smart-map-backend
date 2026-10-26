package org.opentripplanner.routing.graph;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.opentripplanner.model.plan.leg.BuildManifestIdentity;
import org.opentripplanner.model.plan.leg.GraphByteIdentity;

/** Only the trusted launcher supplies the path AND independent byte pin; the document cannot opt in. */
final class BuildManifestBinding {
  private static final String MANIFEST_PATH=System.getProperty("otp.buildManifest.path");
  private static final String MANIFEST_PIN=System.getProperty("otp.buildManifest.sha256");
  private static final Set<String> COMPILER_FILES=Set.of("otp-sidewalk-layer.py", "otp-sidewalk-topology.py",
    "build-ped-graph.py", "ped-sidewalk-network.py", "ped-osm-areas.py", "osm-area-polygon-features.json");
  private BuildManifestBinding() {}

  static BuildManifestIdentity forLoadedGraph(GraphByteIdentity graph) {
    if (MANIFEST_PATH==null && MANIFEST_PIN==null) return null;
    if (MANIFEST_PATH==null || MANIFEST_PIN==null) throw invalid("Both launcher manifest path and SHA pin are required");
    return readPinned(Path.of(MANIFEST_PATH), MANIFEST_PIN, graph);
  }

  static BuildManifestIdentity readPinned(Path path, String expectedPin, GraphByteIdentity graph) {
    sha(expectedPin);
    try {
      byte[] bytes;
      try (var input=Files.newInputStream(path)) {
        bytes=input.readNBytes(1_048_577);
      }
      if (bytes.length>1_048_576) throw invalid("Build manifest exceeds 1 MiB");
      var actual=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
      if (!actual.equals(expectedPin)) throw invalid("Build manifest differs from launcher pin");
      var mapper=new ObjectMapper().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
      JsonNode root=mapper.readTree(bytes);
      fields(root,Set.of("schemaVersion","buildInputMode","phase","graph","inputs","compilerArtifacts","source",
        "layerReportSha256","mergedPbfSha256","declaredBuildPolicyJarSha256","preparedManifestSha256"));
      if (!root.path("schemaVersion").isIntegralNumber() || !root.path("schemaVersion").canConvertToInt() || root.path("schemaVersion").intValue()!=2 || !text(root,"phase").equals("BUILT")) throw invalid("Unsupported build manifest schema/phase");
      if (!text(root,"buildInputMode").equals("LOCAL_AUTO_DISCOVERY_NO_CACHE")) throw invalid("Unsupported build input provenance mode");
      var declared=root.get("graph");fields(declared,Set.of("sha256","byteCount"));
      String graphSha=sha(text(declared,"sha256"));long count=count(declared,"byteCount");
      if (!graph.sha256().equals(graphSha)||graph.byteCount()!=count) throw invalid("Build manifest does not describe actual loaded graph bytes");
      var source=root.get("source");fields(source,Set.of("version","batch","archiveSha256"));
      String merged=sha(text(root,"mergedPbfSha256"));
      var inputs=artifacts(root.get("inputs"),false);
      if (inputs.stream().filter(a->a.path().equals("merged.osm.pbf")&&a.role().equals("OSM")&&a.sha256().equals(merged)).count()!=1) throw invalid("Missing matching merged PBF input");
      var compiler=artifacts(root.get("compilerArtifacts"),true);
      sha(text(root,"preparedManifestSha256"));
      return new BuildManifestIdentity(actual,text(root,"buildInputMode"),graphSha,count,text(source,"version"),text(source,"batch"),
        sha(text(source,"archiveSha256")),merged,sha(text(root,"layerReportSha256")),
        sha(text(root,"declaredBuildPolicyJarSha256")),inputs,compiler);
    } catch (IOException|NoSuchAlgorithmException e) {
      throw new IllegalStateException("Unable to verify launcher-pinned build manifest",e);
    }
  }

  private static List<BuildManifestIdentity.BuildArtifact> artifacts(JsonNode array, boolean compiler) {
    if (array==null||!array.isArray()||array.isEmpty()) throw invalid("Missing build artifact list");
    var result=new ArrayList<BuildManifestIdentity.BuildArtifact>();var seen=new HashSet<String>();
    for(var item:array){
      fields(item,Set.of("path","role","sha256","byteCount"));
      String path=text(item,"path"),role=text(item,"role");
      if (path.startsWith("/")||path.contains("\\")||path.indexOf('\0')>=0||List.of(path.split("/",-1)).stream().anyMatch(s->s.equals("..")||s.equals(".")||s.isEmpty())||!seen.add(path)) throw invalid("Invalid/duplicate artifact path");
      if (compiler) {
        String expected=path.equals("otp-sidewalk-layer.py")?"COMPILER":path.equals("otp-sidewalk-topology.py")?"TOPOLOGY":"DEPENDENCY";
        if (!COMPILER_FILES.contains(path)||!role.equals(expected)) throw invalid("Unknown compiler artifact/role");
      } else {
        String expected=path.endsWith(".pbf")?"OSM":path.endsWith(".zip")?"GTFS":path.toLowerCase().endsWith(".tif")||path.toLowerCase().endsWith(".tiff")?"DEM":path.endsWith("config.json")?"CONFIG":"OTHER";
        if(path.equals("graph.obj")||!role.equals(expected)) throw invalid("Invalid build input role");
      }
      result.add(new BuildManifestIdentity.BuildArtifact(path,role,sha(text(item,"sha256")),count(item,"byteCount")));
    }
    if (compiler&&!seen.equals(COMPILER_FILES)) throw invalid("Incomplete compiler/helper identity set");
    return List.copyOf(result);
  }
  private static void fields(JsonNode node,Set<String> expected) {
    if(node==null||!node.isObject())throw invalid("Expected build manifest object");
    var fields=new HashSet<String>();node.fieldNames().forEachRemaining(fields::add);
    if(!fields.equals(expected))throw invalid("Missing or unexpected build manifest fields");
  }
  private static String text(JsonNode node,String key) {
    var value=node.get(key);
    if(value==null||!value.isTextual()||value.textValue().isBlank())throw invalid("Missing build manifest string: "+key);
    return value.textValue();
  }
  private static long count(JsonNode node,String key) {
    var value=node.get(key);
    if(value==null||!value.isIntegralNumber()||!value.canConvertToLong()||value.longValue()<0)throw invalid("Invalid byte count");
    return value.longValue();
  }
  private static String sha(String value) {
    if(value==null||!value.matches("[0-9a-f]{64}"))throw invalid("Invalid SHA-256");
    return value;
  }
  private static IllegalStateException invalid(String message) {return new IllegalStateException(message);}
}
