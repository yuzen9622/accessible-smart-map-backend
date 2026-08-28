import { describe, expect, it } from "vitest";
import {
  NODE_RAMP_SNAP_PREFILTER_DEGREES,
  RAMP_SNAP_PREFILTER_DEGREES,
  RAMP_SNAP_TOLERANCE_M,
  REBUILD_RAMP_EDGE_SQL,
  REBUILD_RAMP_NODE_SQL,
} from "./import-taipei-ramps";

describe("REBUILD_RAMP_EDGE_SQL", () => {
  it("is a single set-based INSERT...SELECT, not a per-point loop", () => {
    const insertCount = (REBUILD_RAMP_EDGE_SQL.match(/\bINSERT\b/gi) ?? [])
      .length;
    expect(insertCount).toBe(1);
    expect(REBUILD_RAMP_EDGE_SQL).toMatch(/CROSS JOIN LATERAL/i);
  });

  it("never casts the indexed geometry column to ::geography inside ST_DWithin", () => {
    const dWithinCall = REBUILD_RAMP_EDGE_SQL.match(
      /ST_DWithin\(([^)]*)\)/i,
    )?.[1];
    expect(dWithinCall).toBeDefined();
    expect(dWithinCall).not.toContain("::geography");
  });

  it("still verifies the exact distance in geography units after the degree-space prefilter", () => {
    expect(REBUILD_RAMP_EDGE_SQL).toMatch(
      /ST_Distance\(edge\.geom::geography, point\.geom::geography\)/i,
    );
  });

  it("keeps the degree-space prefilter wider than the metre tolerance it approximates", () => {
    expect(RAMP_SNAP_PREFILTER_DEGREES).toBeGreaterThan(0);
    expect(RAMP_SNAP_TOLERANCE_M).toBeGreaterThan(0);
  });
});

describe("REBUILD_RAMP_NODE_SQL", () => {
  it("is a single set-based INSERT...SELECT, not a per-point loop", () => {
    const insertCount = (REBUILD_RAMP_NODE_SQL.match(/\bINSERT\b/gi) ?? [])
      .length;
    expect(insertCount).toBe(1);
    expect(REBUILD_RAMP_NODE_SQL).toMatch(/\bJOIN\b/i);
  });

  it("maps every node within tolerance, not just the nearest one", () => {
    expect(REBUILD_RAMP_NODE_SQL).not.toMatch(/CROSS JOIN LATERAL/i);
    expect(REBUILD_RAMP_NODE_SQL).not.toMatch(/\bLIMIT 1\b/i);
  });

  it("never casts the indexed geometry column to ::geography inside ST_DWithin", () => {
    const dWithinCall = REBUILD_RAMP_NODE_SQL.match(
      /ST_DWithin\(([^)]*)\)/i,
    )?.[1];
    expect(dWithinCall).toBeDefined();
    expect(dWithinCall).not.toContain("::geography");
  });

  it("still verifies the exact distance in geography units after the degree-space prefilter", () => {
    expect(REBUILD_RAMP_NODE_SQL).toMatch(
      /ST_Distance\(node\.geom::geography, point\.geom::geography\)/i,
    );
  });

  it("keeps the degree-space prefilter wider than the metre tolerance it approximates", () => {
    expect(NODE_RAMP_SNAP_PREFILTER_DEGREES).toBeGreaterThan(0);
    expect(RAMP_SNAP_TOLERANCE_M).toBeGreaterThan(0);
  });

  it("excludes nodes with no real surveyed geometry", () => {
    expect(REBUILD_RAMP_NODE_SQL).toMatch(/node\.geom IS NOT NULL/i);
  });
});
