package org.opentripplanner.routing.graph;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import org.opentripplanner.model.plan.leg.GraphByteIdentity;
import org.opentripplanner.model.plan.leg.BuildManifestIdentity;
import org.opentripplanner.street.graph.Graph;

/** Runtime-only object-identity binding; neither keys nor values retain a graph strongly. */
public final class LoadedGraphIdentityRegistry {
  private static final ReferenceQueue<Graph> QUEUE = new ReferenceQueue<>();
  private static final Map<IdentityReference, LoadedIdentity> IDENTITIES = new HashMap<>();
  private LoadedGraphIdentityRegistry() {}

  private record LoadedIdentity(GraphByteIdentity bytes, BuildManifestIdentity manifest) {}

  static synchronized void register(Graph graph, GraphByteIdentity identity) {
    register(graph, identity, null);
  }

  static synchronized void register(Graph graph, GraphByteIdentity identity, BuildManifestIdentity manifest) {
    reap();
    Objects.requireNonNull(graph);
    Objects.requireNonNull(identity);
    var reference = new IdentityReference(graph, QUEUE);
    var binding = new LoadedIdentity(identity, manifest);
    var previous = IDENTITIES.putIfAbsent(reference, binding);
    if (previous != null && !previous.equals(binding)) {
      throw new IllegalStateException("A loaded graph already has a different byte identity");
    }
  }

  public static synchronized GraphByteIdentity forGraph(Graph graph) {
    reap();
    var binding = graph == null ? null : IDENTITIES.get(new IdentityReference(graph, null));
    return binding == null ? null : binding.bytes();
  }

  public static synchronized BuildManifestIdentity manifestForGraph(Graph graph) {
    reap();
    var binding = graph == null ? null : IDENTITIES.get(new IdentityReference(graph, null));
    return binding == null ? null : binding.manifest();
  }

  private static void reap() {
    IdentityReference dead;
    while ((dead = (IdentityReference)QUEUE.poll()) != null) IDENTITIES.remove(dead);
  }

  private static final class IdentityReference extends WeakReference<Graph> {
    private final int identityHash;
    IdentityReference(Graph graph, ReferenceQueue<Graph> queue) {
      super(graph, queue);
      identityHash = System.identityHashCode(graph);
    }
    @Override public int hashCode() { return identityHash; }
    @Override public boolean equals(Object other) {
      if (this == other) return true;
      return other instanceof IdentityReference reference && get() != null && get() == reference.get();
    }
  }
}
