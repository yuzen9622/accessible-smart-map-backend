import { describe, expect, it } from "vitest";
import {
  parseTaichungTimetables,
  taichungLowFloorFlag,
} from "./taichung-bus.adapter";

describe("taichungLowFloorFlag", () => {
  it.each(["dsby", "lfv", "lfv_2", "midi_dsby", "ev"])(
    "treats %s as accessible",
    (type) => {
      expect(taichungLowFloorFlag(type)).toBe(1);
    },
  );

  it.each(["no_s", "midi", "sml", "sidi"])("treats %s as standard", (type) => {
    expect(taichungLowFloorFlag(type)).toBe(0);
  });

  it("leaves unknown or blank types undecided", () => {
    expect(taichungLowFloorFlag("Tour")).toBeUndefined();
    expect(taichungLowFloorFlag("")).toBeUndefined();
    expect(taichungLowFloorFlag(null)).toBeUndefined();
  });

  it("tolerates surrounding whitespace in the source value", () => {
    expect(taichungLowFloorFlag(" dsby")).toBe(1);
  });
});

describe("parseTaichungTimetables", () => {
  it("emits one observation per dispatched plate across aliases", () => {
    const obs = parseTaichungTimetables({
      r54: {
        edges: [
          { node: { carId: "KKA-6319", carType: "dsby" } },
          { node: { carId: "KKA-6319", carType: "dsby" } },
          { node: { carId: "552-U8", carType: "dsby" } },
        ],
      },
      r70: {
        edges: [
          { node: { carId: "KKA-5851", carType: "no_s" } },
          { node: { carId: "", carType: "dsby" } },
          { node: { carId: "TDG-1", carType: "Tour" } },
        ],
      },
      r999: null,
    });

    expect(obs).toEqual([
      {
        plateNumb: "KKA-6319",
        city: "Taichung",
        isLowFloor: 1,
        source: "taichung-ebus",
        cityRouteIds: ["54"],
      },
      {
        plateNumb: "552-U8",
        city: "Taichung",
        isLowFloor: 1,
        source: "taichung-ebus",
        cityRouteIds: ["54"],
      },
      {
        plateNumb: "KKA-5851",
        city: "Taichung",
        isLowFloor: 0,
        source: "taichung-ebus",
        cityRouteIds: ["70"],
      },
    ]);
  });

  it("keeps every route a plate ran that day", () => {
    const obs = parseTaichungTimetables({
      r54: { edges: [{ node: { carId: "KKA-6319", carType: "dsby" } }] },
      r70: { edges: [{ node: { carId: "kka-6319", carType: "dsby" } }] },
    });

    expect(obs).toEqual([
      expect.objectContaining({
        plateNumb: "KKA-6319",
        cityRouteIds: ["54", "70"],
      }),
    ]);
  });
});
