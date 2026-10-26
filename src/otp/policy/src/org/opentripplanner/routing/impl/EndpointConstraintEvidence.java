package org.opentripplanner.routing.impl;

import java.util.List;

/** A complete local endpoint-attachment rejection; never a global no-route claim. */
public record EndpointConstraintEvidence(
  String scope, String endpoint, String phase, List<String> reasons, int blockedCandidateCount
) {
  public EndpointConstraintEvidence {
    reasons = List.copyOf(reasons);
    if (!"SELECTED_ENDPOINT_ATTACHMENT".equals(scope) ||
        !("FROM".equals(endpoint) || "TO".equals(endpoint)) ||
        !("LINK".equals(phase) || "TERMINAL_CUT".equals(phase)) ||
        reasons.isEmpty() || reasons.size() != new java.util.HashSet<>(reasons).size() ||
        reasons.stream().anyMatch(r -> !"KNOWN_WIDTH".equals(r) && !"KNOWN_NON_STAIR_SLOPE".equals(r)) ||
        ("LINK".equals(phase) && !reasons.equals(List.of("KNOWN_WIDTH"))) || blockedCandidateCount <= 0) {
      throw new IllegalArgumentException("Invalid endpoint constraint proof");
    }
  }
}
