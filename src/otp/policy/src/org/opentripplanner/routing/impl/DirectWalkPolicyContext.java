package org.opentripplanner.routing.impl;

import org.opentripplanner.street.model.edge.ExtensionRequestContext;
import org.opentripplanner.street.search.request.StreetSearchRequest;
public record DirectWalkPolicyContext(DirectWalkExecutedPolicy executedPolicy) implements ExtensionRequestContext {
  public DirectWalkPolicyContext { java.util.Objects.requireNonNull(executedPolicy); }
  public static DirectWalkExecutedPolicy observed(StreetSearchRequest request) {
    DirectWalkExecutedPolicy result = null;
    for (var context : request.listExtensionRequestContexts()) {
      if (context instanceof DirectWalkPolicyContext direct) {
        if (result != null) throw new IllegalStateException("Duplicate direct WALK policy context");
        result = direct.executedPolicy();
      }
    }
    if (result != null && (request.mode() != org.opentripplanner.street.model.StreetMode.WALK
      || request.wheelchairEnabled() != result.wheelchairEnabled()
      || request.walk().speed() != result.walkSpeedMps()
      || (result.wheelchairEnabled() ? request.wheelchair().stairsReluctance() : request.walk().stairsReluctance()) != result.stairsReluctance()))
      throw new IllegalStateException("Actual street request differs from executed policy");
    return result;
  }
}
