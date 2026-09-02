import { describe, expect, it } from "vitest";
import { applyTripA11y } from "./inject-tdx-bus-trips-a11y";

function rows(
  ...specs: {
    trip_id: string;
    route_id: string;
    wheelchair_accessible?: string;
  }[]
): Record<string, string>[] {
  return specs.map((s) => ({
    trip_id: s.trip_id,
    route_id: s.route_id,
    wheelchair_accessible: s.wheelchair_accessible ?? "",
  }));
}

const ROUTE_TYPES = new Map<string, string>([
  ["METRO_R", "1"],
  ["BUS_299", "3"],
  ["TRA_WEST", "2"],
  ["FERRY_1", "4"],
]);

describe("applyTripA11y decision table", () => {
  it("marks route_type=1 (metro/light rail/gondola) trips accessible", () => {
    const data = rows({ trip_id: "t1", route_id: "METRO_R" });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("1");
    expect(counts.railAccessible).toBe(1);
  });

  it("leaves route_type=3 (bus) trips unknown and never inaccessible", () => {
    const data = rows({ trip_id: "t1", route_id: "BUS_299" });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("0");
    expect(counts.busUnknown).toBe(1);
    expect(counts).not.toHaveProperty("inaccessible");
  });

  it("preserves an existing 1 from the TRA WheelChairFlag injection", () => {
    const data = rows({
      trip_id: "t1",
      route_id: "TRA_WEST",
      wheelchair_accessible: "1",
    });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("1");
    expect(counts.preserved).toBe(1);
    expect(counts.railAccessible).toBe(0);
  });

  it("keeps an unflagged TRA trip at unknown", () => {
    const data = rows({ trip_id: "t1", route_id: "TRA_WEST" });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("0");
    expect(counts.otherUnknown).toBe(1);
  });

  it("resets a bus trip with existing wheelchair_accessible=1 down to unknown (0)", () => {
    const data = rows({
      trip_id: "t_legacy",
      route_id: "BUS_299",
      wheelchair_accessible: "1",
    });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("0");
    expect(counts.busUnknown).toBe(1);
    expect(counts.preserved).toBe(0);
  });

  it("normalises a leftover 2 down to unknown", () => {
    const data = rows({
      trip_id: "t1",
      route_id: "BUS_299",
      wheelchair_accessible: "2",
    });
    applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("0");
  });

  it("treats an unindexed route_id as unknown", () => {
    const data = rows({ trip_id: "t1", route_id: "MISSING" });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("0");
    expect(counts.otherUnknown).toBe(1);
  });

  it("appends the wheelchair_accessible header when absent", () => {
    const headers = ["trip_id", "route_id"];
    applyTripA11y(
      headers,
      rows({ trip_id: "t1", route_id: "BUS_299" }),
      ROUTE_TYPES,
    );

    expect(headers).toContain("wheelchair_accessible");
    expect(headers.filter((h) => h === "wheelchair_accessible")).toHaveLength(
      1,
    );
  });

  it("skips rows without a trip_id", () => {
    const data = rows({ trip_id: "", route_id: "METRO_R" });
    const counts = applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data[0].wheelchair_accessible).toBe("");
    expect(counts.railAccessible).toBe(0);
  });

  it("never writes 2 for any combination of inputs", () => {
    const data = rows(
      { trip_id: "t1", route_id: "METRO_R" },
      { trip_id: "t2", route_id: "BUS_299" },
      { trip_id: "t3", route_id: "TRA_WEST", wheelchair_accessible: "1" },
      { trip_id: "t4", route_id: "TRA_WEST" },
      { trip_id: "t5", route_id: "FERRY_1", wheelchair_accessible: "2" },
      { trip_id: "t6", route_id: "MISSING", wheelchair_accessible: "2" },
      { trip_id: "t7", route_id: "BUS_299", wheelchair_accessible: "0" },
    );
    applyTripA11y(["trip_id", "route_id"], data, ROUTE_TYPES);

    expect(data.every((r) => r.wheelchair_accessible !== "2")).toBe(true);
  });
});
