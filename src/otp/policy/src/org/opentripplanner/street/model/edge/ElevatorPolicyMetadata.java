package org.opentripplanner.street.model.edge;

import java.io.Serializable;
import java.util.List;

/** Isolated build-time provenance for the mandatory elevator hop. */
public record ElevatorPolicyMetadata(
  PathwayPolicyMetadata pathway, OsmSource osmSource, boolean reverse
) implements Serializable {
  public ElevatorPolicyMetadata {
    if ((pathway == null) == (osmSource == null)) throw new IllegalArgumentException("Exactly one elevator source is required");
  }

  public record OsmSource(
    String osmId, Double knownWidthMeters, List<String> sourceRefs, List<String> widthSourceRefs,
    String sourceBatch, String sourceVersion, String sourceSha256
  ) implements Serializable {
    public OsmSource { sourceRefs = List.copyOf(sourceRefs); widthSourceRefs = List.copyOf(widthSourceRefs); }
  }

  public Double knownWidthMeters() {
    return pathway != null ? pathway.knownMinWidthMeters() : osmSource.knownWidthMeters();
  }
}
