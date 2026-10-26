package org.opentripplanner.street.model.edge;

import java.io.Serializable;

/** ISOLATED PROTOTYPE: nullable observations remain unknown, with original GTFS identity. */
public record PathwayPolicyMetadata(
  String pathwayId, String fromStopId, String toStopId, String mode,
  Double knownMinWidthMeters, Double knownSlopeRatio, Boolean knownWheelchairAccessible
) implements Serializable {}
