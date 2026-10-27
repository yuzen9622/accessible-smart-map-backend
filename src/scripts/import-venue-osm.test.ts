import { describe, expect, it } from "vitest";
import {
  DEFAULT_NUTC_BUILDING_IDS,
  parseVenueImportArgs,
} from "./import-venue-osm";
import { SYNC_STEPS } from "./sync-all-data-plan";

describe("venue import publication scope", () => {
  it("publishes the same default buildings for direct import and data sync", () => {
    expect(parseVenueImportArgs([]).buildingIds).toEqual(
      DEFAULT_NUTC_BUILDING_IDS,
    );
    const step = SYNC_STEPS.find((s) => s.id === "venue-nutc-sanmin");
    expect(step?.command).toContain("import:venue");
    expect(step?.command).not.toContain("--all-buildings");
  });
  it("allows an explicit scope and leaves other venues unscoped", () => {
    expect(parseVenueImportArgs(["--buildings", "a,b"]).buildingIds).toEqual([
      "a",
      "b",
    ]);
    expect(parseVenueImportArgs(["--buildings=a,b"]).buildingIds).toEqual([
      "a",
      "b",
    ]);
    expect(
      parseVenueImportArgs(["--venue", "other"]).buildingIds,
    ).toBeUndefined();
    expect(
      parseVenueImportArgs(["--all-buildings"]).buildingIds,
    ).toBeUndefined();
  });
  it("rejects missing, empty, invalid and conflicting scopes before database I/O", () => {
    for (const args of [
      ["--buildings"],
      ["--buildings="],
      ["--buildings", "a,"],
      ["--buildings", "a,a"],
      ["--buildings", "A"],
      ["--buildings", "a", "--all-buildings"],
    ]) {
      expect(() => parseVenueImportArgs(args)).toThrow();
    }
  });
});
