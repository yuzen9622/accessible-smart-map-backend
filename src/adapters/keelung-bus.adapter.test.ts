import { describe, expect, it } from "vitest";
import { keelungLowFloorFlag, parseKeelungBuses } from "./keelung-bus.adapter";

describe("keelungLowFloorFlag", () => {
  it("reads the first imgTag digit as the low-floor flag", () => {
    expect(keelungLowFloorFlag({ imgTag: "100" })).toBe(1);
    expect(keelungLowFloorFlag({ imgTag: "000" })).toBe(0);
    expect(keelungLowFloorFlag({ imgTag: "010" })).toBe(0);
  });

  it("leaves a missing tag undecided", () => {
    expect(keelungLowFloorFlag({})).toBeUndefined();
    expect(keelungLowFloorFlag({ imgTag: "" })).toBeUndefined();
  });
});

describe("parseKeelungBuses", () => {
  it("maps busData entries to observations and skips plateless rows", () => {
    const obs = parseKeelungBuses([
      { carNo: "FAC-157", imgTag: "100" },
      { carNo: "590-FU", imgTag: "000" },
      { carNo: "", imgTag: "100" },
      { carNo: "KKA-1", imgTag: "" },
    ]);

    expect(obs).toEqual([
      {
        plateNumb: "FAC-157",
        city: "Keelung",
        isLowFloor: 1,
        source: "keelung-ebus",
      },
      {
        plateNumb: "590-FU",
        city: "Keelung",
        isLowFloor: 0,
        source: "keelung-ebus",
      },
    ]);
  });

  it("returns nothing for a missing busData array", () => {
    expect(parseKeelungBuses(undefined)).toEqual([]);
  });
});
