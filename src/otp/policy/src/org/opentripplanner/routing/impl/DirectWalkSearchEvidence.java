package org.opentripplanner.routing.impl;

public record DirectWalkSearchEvidence(
  String schemaVersion, String status, String nativeOutcome, DirectWalkExecutedPolicy executedPolicy,
  Double fromLat, Double fromLon, Double toLat, Double toLon, Long departureTimeMs,
  Double maximumSearchDurationS, Double streetSearchTimeoutS, boolean durationLimitPruned, EndpointConstraintEvidence endpointConstraint
) {}
