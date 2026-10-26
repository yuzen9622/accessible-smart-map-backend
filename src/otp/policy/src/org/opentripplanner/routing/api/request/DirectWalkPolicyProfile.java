package org.opentripplanner.routing.api.request;

/** Explicit, direct-WALK-only search profile. UNSPECIFIED retains legacy callers. */
public enum DirectWalkPolicyProfile {
  UNSPECIFIED, NORMAL, WHEELCHAIR_STRICT, WHEELCHAIR_STAIRS_ASSISTED;
  public boolean wheelchair() {
    return this == WHEELCHAIR_STRICT || this == WHEELCHAIR_STAIRS_ASSISTED;
  }
}
