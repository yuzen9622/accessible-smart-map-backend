package org.opentripplanner.routing.impl;

import org.opentripplanner.street.model.edge.*;
import org.opentripplanner.core.model.accessibility.Accessibility;
import org.opentripplanner.routing.api.request.DirectWalkPolicyProfile;

/** Native attributes of an actual selected occurrence; null preserves unobserved attributes. */
public record DirectWalkEdgePolicy(Boolean stairs, Boolean escalator, Boolean nativeWheelchairAccessible,
  Double knownMaxSlopeRatio, Double knownWidthM, String knownSmoothness, boolean assistedStairs, Integer captureSchemaVersion) {
  public static DirectWalkEdgePolicy observe(Edge edge, DirectWalkExecutedPolicy policy) {
    if (policy == null) return null;
    boolean assisted = policy.profile() == DirectWalkPolicyProfile.WHEELCHAIR_STAIRS_ASSISTED;
    if (edge instanceof GovernmentEndpointEdge endpoint) {
      return new DirectWalkEdgePolicy(null, null, null, null, endpoint.getKnownWidthMeters(), null, false, null);
    }
    if (edge instanceof StreetEdge street) {
      StreetEdge parent = street;
      while (parent instanceof TemporaryPartialStreetEdge partial) parent = partial.getParentEdge();
      boolean stairs = street.isStairs() || parent.isStairs();
      var metadata = street.getPolicyMetadata();
      return new DirectWalkEdgePolicy(stairs, false, street.isWheelchairAccessible() && parent.isWheelchairAccessible(),
        nativeSlope(street), metadata == null ? null : metadata.knownWidthMeters(), metadata == null ? null : metadata.knownSmoothness(), assisted && stairs,
        metadata == null ? null : metadata.captureSchemaVersion());
    }
    if (edge instanceof PathwayEdge pathway) {
      var m = pathway.getPolicyMetadata();
      boolean stairs = pathway.getSteps() != 0 || (m != null && "STAIRS".equals(m.mode()));
      boolean escalator = m != null && "ESCALATOR".equals(m.mode());
      return new DirectWalkEdgePolicy(stairs, escalator, m == null ? null : m.knownWheelchairAccessible(),
        m == null ? null : m.knownSlopeRatio(), m == null ? null : m.knownMinWidthMeters(), null, assisted && stairs && !escalator, null);
    }
    if (edge instanceof EscalatorEdge)
      return new DirectWalkEdgePolicy(false, true, false, null, null, null, false, null);
    if (edge instanceof ElevatorHopEdge elevator) {
      var m = elevator.getPolicyMetadata();
      return new DirectWalkEdgePolicy(false, false, accessible(elevator.getWheelchairAccessibility()),
        null, m == null ? null : m.knownWidthMeters(), null, false, null);
    }
    if (edge instanceof StreetTransitEntityLink<?> link)
      return new DirectWalkEdgePolicy(false, false, accessible(link.getWheelchairAccessibility()), null, null, null, false, null);
    return new DirectWalkEdgePolicy(null, null, null, null, null, null, false, null);
  }
  private static Boolean accessible(Accessibility value) {
    return value == Accessibility.NO_INFORMATION ? null : value == Accessibility.POSSIBLE;
  }
  public static Double nativeSlope(StreetEdge street) {
    var profile = street.getElevationProfile();
    if (profile == null || profile.size() < 2) return null;
    Double maximum = null;
    for (int i = 1; i < profile.size(); i++) {
      double dx = profile.getX(i) - profile.getX(i-1), dy = profile.getY(i) - profile.getY(i-1);
      if (Double.isFinite(dx) && Double.isFinite(dy) && dx > 0) {
        double slope = Math.abs(dy/dx);
        if (Double.isFinite(slope)) maximum = maximum == null ? slope : Math.max(maximum,slope);
      }
    }
    return maximum;
  }
}
