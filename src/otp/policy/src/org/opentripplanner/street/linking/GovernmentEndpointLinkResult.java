package org.opentripplanner.street.linking;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import org.opentripplanner.street.model.edge.Edge;
import org.opentripplanner.street.model.edge.StreetEdge;
import org.opentripplanner.street.model.edge.TemporaryPartialStreetEdge;
import org.opentripplanner.street.model.vertex.TemporarySplitterVertex;
import org.opentripplanner.street.model.vertex.Vertex;

/** Per-call object identities, captured at creation; never stored on the shared graph/linker. */
public record GovernmentEndpointLinkResult(
  DisposableEdgeCollection edges, int knownWidthBlockedCandidates,
  Set<Vertex> ownedSplits, Set<Edge> ownedPartials, Set<Edge> ownedConnectors
) {
  public GovernmentEndpointLinkResult {
    if (knownWidthBlockedCandidates < 0) throw new IllegalArgumentException("Negative candidate count");
    ownedSplits = frozen(ownedSplits); ownedPartials = frozen(ownedPartials); ownedConnectors = frozen(ownedConnectors);
  }
  private static <T> Set<T> frozen(Set<T> source) {
    Set<T> copy=Collections.newSetFromMap(new IdentityHashMap<>()); copy.addAll(source);
    return Collections.unmodifiableSet(copy);
  }
  static final class Capture {
    int knownWidthBlockedCandidates;
    final Set<Vertex> splits=Collections.newSetFromMap(new IdentityHashMap<>());
    final Set<Edge> partials=Collections.newSetFromMap(new IdentityHashMap<>());
    final Set<Edge> connectors=Collections.newSetFromMap(new IdentityHashMap<>());
    void split(Vertex vertex, StreetEdge parent) {
      if (!(vertex instanceof TemporarySplitterVertex)) return;
      splits.add(vertex);
      java.util.stream.Stream.concat(vertex.getIncoming().stream(),vertex.getOutgoing().stream())
        .filter(e -> e instanceof TemporaryPartialStreetEdge p && p.getParentEdge()==parent).forEach(partials::add);
    }
    GovernmentEndpointLinkResult finish(DisposableEdgeCollection edges) {
      return new GovernmentEndpointLinkResult(edges,knownWidthBlockedCandidates,splits,partials,connectors);
    }
  }
}
