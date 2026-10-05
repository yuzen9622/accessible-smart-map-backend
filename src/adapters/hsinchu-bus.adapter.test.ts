import { describe, expect, it } from "vitest";
import {
  hsinchuCityOf,
  hsinchuLowFloorFlag,
  parseHsinchuRouteDetails,
} from "./hsinchu-bus.adapter";

describe("hsinchuLowFloorFlag", () => {
  it("accepts numeric and string flags", () => {
    expect(hsinchuLowFloorFlag(1)).toBe(1);
    expect(hsinchuLowFloorFlag("1")).toBe(1);
    expect(hsinchuLowFloorFlag(0)).toBe(0);
    expect(hsinchuLowFloorFlag("0")).toBe(0);
  });

  it("treats null as unknown rather than standard", () => {
    expect(hsinchuLowFloorFlag(null)).toBeUndefined();
    expect(hsinchuLowFloorFlag(undefined)).toBeUndefined();
  });
});

describe("hsinchuCityOf", () => {
  it("splits city and county routes by prefix", () => {
    expect(hsinchuCityOf("HSZ010001_1")).toBe("Hsinchu");
    expect(hsinchuCityOf("HSQ000901_1")).toBe("HsinchuCounty");
    expect(hsinchuCityOf("HSP000101_1")).toBe("HsinchuCounty");
  });
});

describe("parseHsinchuRouteDetails", () => {
  it("collects plates from both directions and skips empty or unknown rows", () => {
    const obs = parseHsinchuRouteDetails({
      go: [
        { routeId: "HSZ011001_1", car_no: "", car_accessibility: null },
        { routeId: "HSZ011001_1", car_no: "FAD-233", car_accessibility: 1 },
      ],
      back: [
        { routeId: "HSZ011002_2", car_no: "KKA-3036", car_accessibility: 0 },
        { routeId: "HSZ011002_2", car_no: "KQA-0229", car_accessibility: null },
      ],
    });

    expect(obs).toEqual([
      {
        plateNumb: "FAD-233",
        city: "Hsinchu",
        isLowFloor: 1,
        source: "hsinchu-ibus",
      },
      {
        plateNumb: "KKA-3036",
        city: "Hsinchu",
        isLowFloor: 0,
        source: "hsinchu-ibus",
      },
    ]);
  });
});
