package org.opentripplanner.routing.impl;

import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.routing.api.request.DirectWalkPolicyProfile;
import org.opentripplanner.street.model.StreetMode;

/** Immutable observations of the request actually mapped to the direct street search. */
public record DirectWalkExecutedPolicy(
  String schemaVersion, String scope, DirectWalkPolicyProfile profile,
  boolean wheelchairEnabled, double walkSpeedMps, double stairsReluctance,
  Double minimumKnownWidthM, Double maximumKnownNonStairSlopeRatio, String fareAccess
) {
  public static DirectWalkExecutedPolicy from(RouteRequest request) {
    var profile = request.directWalkPolicyProfile();
    if (profile == DirectWalkPolicyProfile.UNSPECIFIED) return null;
    if (request.journey().direct().mode() != StreetMode.WALK || request.journey().transit().enabled()
      || request.isViaSearch() || request.arriveBy() || request.pageCursor() != null)
      throw new IllegalArgumentException("Explicit direct WALK profile requires depart-at WALK-only without native via/paging");
    if (request.journey().wheelchair() != profile.wheelchair())
      throw new IllegalArgumentException("Wheelchair flag differs from explicit profile");
    double speed = request.preferences().walk().speed();
    if (speed != (profile.wheelchair() ? 0.8 : 1.3))
      throw new IllegalArgumentException("Walk speed differs from reviewed profile");
    return new DirectWalkExecutedPolicy("1", "DIRECT_WALK_ONLY", profile, request.journey().wheelchair(),
      speed, profile.wheelchair() ? request.preferences().wheelchair().stairsReluctance() : request.preferences().walk().stairsReluctance(), profile.wheelchair() ? 0.9 : null, profile.wheelchair() ? 0.12 : null, "FORBID");
  }
}
