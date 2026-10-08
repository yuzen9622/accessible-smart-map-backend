import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRetentionConfig,
  retentionCutoff,
  RETENTION_DAY_MS,
} from "./retention";

describe("getRetentionConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the published policy deadlines", () => {
    const config = getRetentionConfig();
    expect(config.sosResolvedDeadlineDays).toBe(30);
    expect(config.contactLocationDeadlineDays).toBe(30);
    expect(config.hazardReportDeadlineDays).toBe(90);
    expect(config.memoryUnusedDeadlineDays).toBe(365);
    expect(config.safetyMarginMs).toBeGreaterThanOrEqual(
      2 * config.scanIntervalMs,
    );
  });

  it("accepts an override that shortens a deadline", () => {
    vi.stubEnv("HAZARD_REPORT_DEADLINE_DAYS", "60");
    expect(getRetentionConfig().hazardReportDeadlineDays).toBe(60);
  });

  it.each([
    ["SOS_RESOLVED_DEADLINE_DAYS", "31"],
    ["HAZARD_REPORT_DEADLINE_DAYS", "91"],
    ["MEMORY_UNUSED_DEADLINE_DAYS", "366"],
    ["CONTACT_LOCATION_DEADLINE_DAYS", "0"],
    ["RETENTION_SCAN_INTERVAL_MS", String(7 * 60 * 60 * 1000)],
    ["RETENTION_BATCH_SIZE", "abc"],
    ["SOS_STALE_AUTO_RESOLVE_HOURS", "2"],
  ])("rejects %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => getRetentionConfig()).toThrow(name);
  });

  it("rejects a safety margin shorter than two scan intervals", () => {
    vi.stubEnv("RETENTION_SCAN_INTERVAL_MS", String(6 * 60 * 60 * 1000));
    vi.stubEnv("RETENTION_SAFETY_MARGIN_MS", String(10 * 60 * 60 * 1000));
    expect(() => getRetentionConfig()).toThrow("RETENTION_SAFETY_MARGIN_MS");
  });

  it("rejects a photo cache max-age longer than the safety margin", () => {
    vi.stubEnv("HAZARD_PHOTO_CACHE_MAX_AGE_SEC", String(2 * 24 * 60 * 60));
    expect(() => getRetentionConfig()).toThrow(
      "HAZARD_PHOTO_CACHE_MAX_AGE_SEC",
    );
  });

  it("rejects a LINE send timeout not shorter than the notice lease", () => {
    vi.stubEnv("SOS_NOTICE_LEASE_MS", "5000");
    vi.stubEnv("SOS_NOTICE_SEND_TIMEOUT_MS", "5000");
    expect(() => getRetentionConfig()).toThrow("SOS_NOTICE_SEND_TIMEOUT_MS");
  });

  it("rejects a vector grace that would push orphans past the margin", () => {
    vi.stubEnv("MEMORY_VECTOR_GRACE_MS", String(3 * 24 * 60 * 60 * 1000));
    expect(() => getRetentionConfig()).toThrow("MEMORY_VECTOR_GRACE_MS");
  });

  it("rejects an index timeout not shorter than the vector grace", () => {
    vi.stubEnv("MEMORY_VECTOR_GRACE_MS", "1000");
    expect(() => getRetentionConfig()).toThrow("MEMORY_INDEX_TIMEOUT_MS");
  });
});

describe("retentionCutoff", () => {
  it("pulls the deadline forward by the safety margin", () => {
    const now = new Date("2026-10-08T00:00:00Z");
    const cutoff = retentionCutoff(now, 30 * RETENTION_DAY_MS, {
      safetyMarginMs: RETENTION_DAY_MS,
    });
    expect(cutoff.toISOString()).toBe("2026-09-09T00:00:00.000Z");
  });
});
