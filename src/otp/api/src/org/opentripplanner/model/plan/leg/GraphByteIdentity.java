package org.opentripplanner.model.plan.leg;

/** Identity of the complete byte stream actually deserialized, not a provenance manifest. */
public record GraphByteIdentity(String sha256, long byteCount) {}
