package org.opentripplanner.routing.graph;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.opentripplanner.model.plan.leg.GraphByteIdentity;

/** Counts and hashes exactly the single stream consumed by Kryo, including its read-ahead. */
final class GraphLoadIdentityInputStream extends FilterInputStream {
  private final MessageDigest digest;
  private long byteCount;
  private boolean reachedEof;
  private GraphByteIdentity completed;

  GraphLoadIdentityInputStream(InputStream source) {
    super(source);
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }

  @Override public int read() throws IOException {
    int value = in.read();
    if (value == -1) reachedEof = true;
    else { digest.update((byte)value); byteCount++; }
    return value;
  }

  @Override public int read(byte[] buffer, int offset, int length) throws IOException {
    int count = in.read(buffer, offset, length);
    if (count == -1) reachedEof = true;
    else if (count > 0) { digest.update(buffer, offset, count); byteCount += count; }
    return count;
  }

  @Override public long skip(long count) throws IOException {
    long remaining = Math.max(0, count);
    byte[] buffer = new byte[(int)Math.min(8192, remaining)];
    while (remaining > 0) {
      int read = read(buffer, 0, (int)Math.min(buffer.length, remaining));
      if (read == -1) break;
      remaining -= read;
    }
    return Math.max(0, count) - remaining;
  }

  @Override public boolean markSupported() { return false; }
  @Override public void reset() throws IOException { throw new IOException("Graph digest cannot rewind"); }

  GraphByteIdentity finish() throws IOException {
    if (completed != null) return completed;
    // Kryo may retain an already-hashed buffer. Only bytes not yet read from the underlying
    // stream remain here; do not re-open the source path or hash Kryo's read-ahead twice.
    byte[] buffer = new byte[8192];
    while (!reachedEof) read(buffer, 0, buffer.length);
    completed = new GraphByteIdentity(HexFormat.of().formatHex(digest.digest()), byteCount);
    return completed;
  }
}
