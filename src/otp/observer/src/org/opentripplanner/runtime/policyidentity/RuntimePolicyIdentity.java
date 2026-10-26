package org.opentripplanner.runtime.policyidentity;

import com.sun.management.HotSpotDiagnosticMXBean;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipInputStream;

/** Identity of observed policy classes under a trusted launcher, not operator attestation. */
public final class RuntimePolicyIdentity {
  public static final String PIN_PATH_PROPERTY = "otp.policyIdentity.pin";
  public static final String PIN_SHA_PROPERTY = "otp.policyIdentity.pinSha256";
  private static final String VERIFIED = "VERIFIED_OBSERVED_POLICY_CLASSES";
  private static final Object LOCK = new Object();
  private static final Map<String, List<Observation>> OBSERVED = new LinkedHashMap<>();
  private static volatile Result result = unverified("STARTUP_NOT_VERIFIED");
  private static volatile Pin pin;
  private static volatile Instrumentation instrumentation;
  private static volatile String observationFailure;
  private static volatile ClassLoader verifiedLoader;

  private RuntimePolicyIdentity() {}

  public record Result(
    String status,
    String reason,
    String artifactSha256,
    String manifestSha256,
    String observedClassDigestSha256,
    int classCount
  ) {}

  private record Observation(byte[] bytes, ClassLoader loader, URI codeSource, boolean redefinition) {}
  private record Pin(
    Path artifact,
    String artifactSha256,
    String manifestSha256,
    Path observer,
    String observerSha256,
    Map<String, byte[]> classes
  ) {}

  public static Result current() {
    synchronized (LOCK) {
      if (observationFailure != null) return unverified(observationFailure);
      return result;
    }
  }

  public static void premain(String ignored, Instrumentation inst) {
    if (instrumentation != null) throw failure("OBSERVER_REGISTERED_TWICE");
    instrumentation = inst;
    if (!hasConfiguredPin()) {
      result = unverified("PIN_NOT_CONFIGURED");
      return;
    }
    try {
      pin = loadPin();
      validateLaunch(pin);
      for (Class<?> loaded : inst.getAllLoadedClasses()) {
        if (pin.classes.containsKey(loaded.getName())) throw failure("POLICY_LOADED_BEFORE_OBSERVER");
      }
      inst.addTransformer(new Observer(), false);
      result = unverified("OBSERVER_ACTIVE_NOT_VERIFIED");
    } catch (IOException e) {
      throw failure("PIN_IO_FAILURE", e);
    }
  }

  /** Called exactly once by the trusted launcher, before the application main method. */
  public static Result verifyConfigured(ClassLoader expectedLoader) {
    if (!hasConfiguredPin()) return unverified("PIN_NOT_CONFIGURED");
    if (instrumentation == null) return unverified("OBSERVER_NOT_ACTIVE");
    if (pin == null) throw failure("PIN_WAS_NOT_CONFIGURED_AT_PREMAIN");
    if (expectedLoader == null) throw failure("EXPECTED_LOADER_REQUIRED");
    synchronized (LOCK) {
      if (VERIFIED.equals(result.status())) {
        if (verifiedLoader != expectedLoader) throw failure("VERIFICATION_LOADER_CHANGED");
        if (observationFailure != null) throw failure(observationFailure);
        return result;
      }
    }
    try {
      for (String name : pin.classes.keySet()) {
        Class<?> loaded = Class.forName(name, false, expectedLoader);
        if (loaded.getClassLoader() != expectedLoader) throw failure("UNEXPECTED_DEFINING_LOADER: " + name);
        if (!codeSource(loaded.getProtectionDomain()).equals(pin.artifact.toUri())) {
          throw failure("UNEXPECTED_CLASS_CODE_SOURCE: " + name);
        }
      }
    } catch (ClassNotFoundException | LinkageError | SecurityException e) {
      throw failure("POLICY_CLASS_LOAD_FAILED", e);
    }
    synchronized (LOCK) {
      if (observationFailure != null) throw failure(observationFailure);
      StringBuilder digestInput = new StringBuilder();
      for (var entry : pin.classes.entrySet()) {
        var observations = OBSERVED.get(entry.getKey());
        if (observations == null || observations.size() != 1) {
          throw failure("MISSING_OR_DUPLICATE_OBSERVATION: " + entry.getKey());
        }
        var observed = observations.getFirst();
        if (observed.loader != expectedLoader || observed.redefinition) {
          throw failure("OBSERVATION_LOADER_OR_REDEFINITION_MISMATCH: " + entry.getKey());
        }
        if (!pin.artifact.toUri().equals(observed.codeSource)) {
          throw failure("OBSERVED_CODE_SOURCE_MISMATCH: " + entry.getKey());
        }
        if (!Arrays.equals(entry.getValue(), observed.bytes)) {
          throw failure("OBSERVED_CLASS_BYTES_MISMATCH: " + entry.getKey());
        }
        digestInput.append(entry.getKey()).append('\0').append(sha256(observed.bytes)).append('\n');
      }
      // Detect definitions whose observer callback ran but whose class is not the application class.
      for (Class<?> loaded : instrumentation.getAllLoadedClasses()) {
        if (pin.classes.containsKey(loaded.getName()) && loaded.getClassLoader() != expectedLoader) {
          throw failure("DUPLICATE_LOADED_POLICY_CLASS: " + loaded.getName());
        }
      }
      verifiedLoader = expectedLoader;
      result = new Result(
        VERIFIED, "TRUSTED_LAUNCHER_BOUNDARY", pin.artifactSha256, pin.manifestSha256,
        sha256(digestInput.toString().getBytes(StandardCharsets.UTF_8)), pin.classes.size()
      );
      return result;
    }
  }

  private static final class Observer implements ClassFileTransformer {
    @Override public byte[] transform(
      Module module, ClassLoader loader, String name, Class<?> redefined,
      ProtectionDomain domain, byte[] buffer
    ) {
      if (name == null || !pin.classes.containsKey(name.replace('/', '.'))) return null;
      try {
        String binaryName = name.replace('/', '.');
        var observation = new Observation(buffer.clone(), loader, codeSource(domain), redefined != null);
        synchronized (LOCK) {
          OBSERVED.computeIfAbsent(binaryName, unused -> new ArrayList<>()).add(observation);
          if (VERIFIED.equals(result.status())) {
            observationFailure = "POLICY_DEFINITION_CHANGED_AFTER_VERIFICATION";
          }
        }
      } catch (Throwable e) {
        observationFailure = "POLICY_OBSERVATION_FAILED";
      }
      return null; // Observer only: never transforms, replaces, or suppresses class bytes.
    }
  }

  private static boolean hasConfiguredPin() {
    String path = System.getProperty(PIN_PATH_PROPERTY);
    String sha = System.getProperty(PIN_SHA_PROPERTY);
    if (path == null && sha == null) return false;
    if (path == null || sha == null) throw failure("PARTIAL_PIN_CONFIGURATION");
    return true;
  }

  private static Pin loadPin() throws IOException {
    byte[] configBytes = Files.readAllBytes(Path.of(System.getProperty(PIN_PATH_PROPERTY)));
    requireHash(configBytes, System.getProperty(PIN_SHA_PROPERTY), "PIN_DIGEST_MISMATCH");
    Map<String, String> config = new LinkedHashMap<>();
    for (String line : new String(configBytes, StandardCharsets.UTF_8).split("\n")) {
      if (line.isBlank()) continue;
      int separator = line.indexOf('=');
      if (separator < 1 || config.putIfAbsent(line.substring(0, separator), line.substring(separator + 1)) != null) {
        throw failure("INVALID_PIN_LINE");
      }
    }
    if (!"1".equals(config.remove("format"))) throw failure("UNSUPPORTED_PIN_FORMAT");
    Path artifact = Path.of(required(config, "artifact.path")).toRealPath();
    String artifactHash = required(config, "artifact.sha256");
    byte[] artifactBytes = Files.readAllBytes(artifact);
    requireHash(artifactBytes, artifactHash, "ARTIFACT_DIGEST_MISMATCH");
    Path manifest = Path.of(required(config, "manifest.path")).toRealPath();
    String manifestHash = required(config, "manifest.sha256");
    requireHash(Files.readAllBytes(manifest), manifestHash, "MANIFEST_DIGEST_MISMATCH");
    Path observer = Path.of(required(config, "observer.path")).toRealPath();
    String observerHash = required(config, "observer.sha256");
    requireHash(Files.readAllBytes(observer), observerHash, "OBSERVER_DIGEST_MISMATCH");
    Map<String, String> expected = new TreeMap<>();
    for (var entry : config.entrySet()) {
      if (!entry.getKey().startsWith("class.")) throw failure("UNKNOWN_PIN_KEY");
      String name = entry.getKey().substring(6);
      if (!name.matches("[a-zA-Z_$][a-zA-Z0-9_$]*(\\.[a-zA-Z_$][a-zA-Z0-9_$]*)+")) {
        throw failure("INVALID_CLASS_NAME");
      }
      expected.put(name, entry.getValue());
    }
    if (expected.isEmpty()) throw failure("NO_PINNED_CLASSES");
    Map<String, byte[]> classes = new TreeMap<>();
    try (var zip = new ZipInputStream(new ByteArrayInputStream(artifactBytes))) {
      java.util.zip.ZipEntry entry;
      while ((entry = zip.getNextEntry()) != null) {
        if (!entry.getName().endsWith(".class")) continue;
        if (entry.getName().startsWith("META-INF/")) throw failure("MULTI_RELEASE_POLICY_UNSUPPORTED");
        String name = entry.getName().substring(0, entry.getName().length() - 6).replace('/', '.');
        if (!expected.containsKey(name)) throw failure("UNPINNED_JAR_CLASS: " + name);
        byte[] bytes = zip.readAllBytes();
        requireHash(bytes, expected.get(name), "PINNED_CLASS_DIGEST_MISMATCH: " + name);
        if (classes.putIfAbsent(name, bytes) != null) throw failure("DUPLICATE_JAR_CLASS");
      }
    }
    if (!classes.keySet().equals(expected.keySet())) throw failure("PINNED_CLASS_MISSING_FROM_JAR");
    return new Pin(artifact, artifactHash, manifestHash, observer, observerHash, java.util.Collections.unmodifiableMap(classes));
  }

  private static void validateLaunch(Pin pin) {
    URI ownSource = codeSource(RuntimePolicyIdentity.class.getProtectionDomain());
    if (!pin.observer.toUri().equals(ownSource)) throw failure("OBSERVER_CODE_SOURCE_MISMATCH");
    var diagnostic = ManagementFactory.getPlatformMXBean(HotSpotDiagnosticMXBean.class);
    if (diagnostic == null || !"true".equals(diagnostic.getVMOption("DisableAttachMechanism").getValue())) {
      throw failure("ATTACH_NOT_DISABLED");
    }
    int observerCount = 0;
    for (String arg : ManagementFactory.getRuntimeMXBean().getInputArguments()) {
      if (arg.startsWith("-agentlib:") || arg.startsWith("-agentpath:") || arg.startsWith("-Xrun")) {
        throw failure("OTHER_NATIVE_AGENT_FORBIDDEN");
      }
      if (arg.startsWith("-javaagent:")) {
        String agentPath = arg.substring("-javaagent:".length()).split("=", 2)[0];
        try {
          if (!Path.of(agentPath).toRealPath().equals(pin.observer)) throw failure("OTHER_JAVA_AGENT_FORBIDDEN");
        } catch (IOException e) {
          throw failure("AGENT_PATH_UNREADABLE", e);
        }
        observerCount++;
      }
    }
    if (observerCount != 1) throw failure("EXACTLY_ONE_OBSERVER_AGENT_REQUIRED");
  }

  private static URI codeSource(ProtectionDomain domain) {
    if (domain == null || domain.getCodeSource() == null || domain.getCodeSource().getLocation() == null) {
      throw failure("CODE_SOURCE_UNAVAILABLE");
    }
    try { return domain.getCodeSource().getLocation().toURI().normalize(); }
    catch (java.net.URISyntaxException e) { throw failure("INVALID_CODE_SOURCE", e); }
  }

  private static String required(Map<String, String> config, String key) {
    String value = config.remove(key);
    if (value == null || value.isBlank()) throw failure("MISSING_PIN_KEY: " + key);
    return value;
  }

  private static void requireHash(byte[] bytes, String expected, String reason) {
    if (expected == null || !expected.matches("[0-9a-f]{64}") || !sha256(bytes).equals(expected)) throw failure(reason);
  }

  private static String sha256(byte[] bytes) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    catch (java.security.NoSuchAlgorithmException e) { throw new AssertionError(e); }
  }

  private static Result unverified(String reason) { return new Result("UNVERIFIED", reason, null, null, null, 0); }
  private static IllegalStateException failure(String reason) { return new IllegalStateException(reason); }
  private static IllegalStateException failure(String reason, Throwable cause) { return new IllegalStateException(reason, cause); }
}
