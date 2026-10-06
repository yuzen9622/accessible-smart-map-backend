import { describe, expect, it, vi } from "vitest";
import type { IParkEntrance } from "../../types";
import {
  arrivalEntranceHighlight,
  destinationNamesPark,
  entranceThresholds,
  PARK_NAME_SEARCH_RADIUS_M,
  resolveParkArrival,
  type ParkArrivalLookup,
} from "./park-arrival";

function entrance(
  parkName: string,
  entranceName: string,
  lat: number,
  lng: number,
  measured: { width?: number | null; slope?: number | null } = {},
): IParkEntrance {
  return {
    _id: `${parkName}-${entranceName}`,
    sourceId: `${parkName}-${entranceName}`,
    district: null,
    parkName,
    entranceName,
    location: { type: "Point", coordinates: [lng, lat] },
    minClearWidthM: measured.width === undefined ? 2 : measured.width,
    slopePercent: measured.slope === undefined ? 3 : measured.slope,
    importedAt: new Date(),
  };
}

function lookup(
  candidates: Partial<Awaited<ReturnType<ParkArrivalLookup["findCandidates"]>>>,
  entrancesOfParks: IParkEntrance[] = [],
): ParkArrivalLookup {
  return {
    findCandidates: vi.fn().mockResolvedValue({
      containingParks: [],
      nearbyEntrances: [],
      parksWithArea: [],
      ...candidates,
    }),
    findEntrancesOfParks: vi.fn().mockResolvedValue(entrancesOfParks),
  };
}

const origin = { lat: 25.04, lng: 121.56 };
const requested = { lat: 25.03, lng: 121.55 };
const near = entrance("青年公園", "1號出入口", 25.032, 121.552);
const far = entrance("青年公園", "2號出入口", 25.028, 121.548);

describe("destinationNamesPark", () => {
  it("matches a text containing the park name", () => {
    expect(destinationNamesPark("台北市 青年公園", "青年公園")).toBe(true);
  });

  it("matches a distinctive fragment of a longer park name", () => {
    expect(destinationNamesPark("天母公園", "1號天母公園")).toBe(true);
  });

  it("normalises full-width digits", () => {
    expect(destinationNamesPark("文德3號公園", "文德３號公園")).toBe(true);
  });

  it("does not match a generic fragment or another park", () => {
    expect(destinationNamesPark("公園", "青年公園")).toBe(false);
    expect(destinationNamesPark("大安森林公園", "青年公園")).toBe(false);
  });
});

describe("entranceThresholds", () => {
  it("applies width and the ramp limit to wheelchair users", () => {
    expect(entranceThresholds("wheelchair", undefined)).toEqual({
      minWidthM: 0.9,
      maxSlopePercent: 8.33,
    });
  });

  it("lets the caller's slope limit replace the default", () => {
    expect(entranceThresholds("elderly", 5)).toEqual({ maxSlopePercent: 5 });
  });

  it("applies no limit to other users unless they set one", () => {
    expect(entranceThresholds("normal", undefined)).toEqual({});
    expect(entranceThresholds("visual_impaired", 6)).toEqual({
      maxSlopePercent: 6,
    });
  });
});

describe("resolveParkArrival", () => {
  it("leads coordinates inside a park to the entrance nearest the origin", async () => {
    const data = lookup({ containingParks: ["青年公園"] }, [far, near]);

    const result = await resolveParkArrival(
      { requested, origin, mode: "normal" },
      data,
    );

    expect(result).toMatchObject({
      kind: "entrance",
      entrance: {
        entranceName: "1號出入口",
        location: { lat: 25.032, lng: 121.552 },
      },
    });
    expect(data.findCandidates).toHaveBeenCalledWith(
      requested,
      PARK_NAME_SEARCH_RADIUS_M,
    );
    expect(data.findEntrancesOfParks).toHaveBeenCalledWith(["青年公園"]);
  });

  it("leaves coordinates outside every park alone, even near entrances", async () => {
    const data = lookup({ nearbyEntrances: [near] }, [near]);

    const result = await resolveParkArrival(
      { requested, origin, mode: "normal" },
      data,
    );

    expect(result).toBeNull();
    expect(data.findEntrancesOfParks).not.toHaveBeenCalled();
  });

  it("leads text naming a park whose area contains the geocode", async () => {
    const result = await resolveParkArrival(
      { destinationText: "青年公園", requested, origin, mode: "normal" },
      lookup(
        {
          containingParks: ["青年公園"],
          nearbyEntrances: [near],
          parksWithArea: ["青年公園"],
        },
        [near, far],
      ),
    );

    expect(result).toMatchObject({ kind: "entrance" });
  });

  it("does not lead a place that names a park but geocodes outside its area", async () => {
    // 「大安森林公園站」: the station names the park but stands outside it.
    const parkEntrance = entrance("大安森林公園", "1號出入口", 25.031, 121.551);
    const result = await resolveParkArrival(
      {
        destinationText: "大安森林公園站",
        requested,
        origin,
        mode: "normal",
      },
      lookup(
        {
          containingParks: [],
          nearbyEntrances: [parkEntrance],
          parksWithArea: ["大安森林公園"],
        },
        [parkEntrance],
      ),
    );

    expect(result).toBeNull();
  });

  it("accepts a name match near entrances for a park with no stored area", async () => {
    const small = entrance("紫陽公園", "1號出入口", 25.031, 121.551);
    const result = await resolveParkArrival(
      { destinationText: "紫陽公園", requested, origin, mode: "normal" },
      lookup({ nearbyEntrances: [small], parksWithArea: [] }, [small]),
    );

    expect(result).toMatchObject({
      kind: "entrance",
      entrance: { parkName: "紫陽公園" },
    });
  });

  it("does not lead text that names no nearby park", async () => {
    const result = await resolveParkArrival(
      { destinationText: "誠品書店", requested, origin, mode: "normal" },
      lookup({ containingParks: ["青年公園"], nearbyEntrances: [near] }),
    );

    expect(result).toBeNull();
  });

  it("keeps a destination that already is an entrance (reroute)", async () => {
    const data = lookup({
      containingParks: ["青年公園"],
      nearbyEntrances: [far],
    });

    const result = await resolveParkArrival(
      {
        requested: { lat: 25.028, lng: 121.548 },
        origin,
        mode: "normal",
      },
      data,
    );

    expect(result).toMatchObject({
      kind: "entrance",
      entrance: { entranceName: "2號出入口", distanceFromRequestedM: 0 },
    });
    expect(data.findEntrancesOfParks).not.toHaveBeenCalled();
  });

  it("skips entrances outside the user's limits, including unmeasured ones", async () => {
    const steep = entrance("青年公園", "1號出入口", 25.032, 121.552, {
      slope: 8,
    });
    const unmeasured = entrance("青年公園", "3號出入口", 25.0321, 121.5521, {
      width: null,
    });
    const result = await resolveParkArrival(
      { requested, origin, mode: "wheelchair", maxSlopePercent: 5 },
      lookup({ containingParks: ["青年公園"] }, [steep, unmeasured, far]),
    );

    expect(result).toMatchObject({
      kind: "entrance",
      entrance: { entranceName: "2號出入口" },
    });
  });

  it("reports a park none of whose entrances qualifies", async () => {
    const steep = entrance("青年公園", "1號出入口", 25.032, 121.552, {
      slope: 8,
    });
    const result = await resolveParkArrival(
      { requested, origin, mode: "wheelchair", maxSlopePercent: 5 },
      lookup({ containingParks: ["青年公園"] }, [steep]),
    );

    expect(result).toEqual({ kind: "no_qualifying", parkName: "青年公園" });
  });
});

describe("arrivalEntranceHighlight", () => {
  it("states the measured width and slope", () => {
    expect(
      arrivalEntranceHighlight({
        parkName: "青年公園",
        entranceName: "2號出入口",
        location: requested,
        minClearWidthM: 19.6,
        slopePercent: 3,
        distanceFromRequestedM: 180,
      }),
    ).toBe(
      "已為您導引至「青年公園」2號出入口（無障礙出入口，淨寬 19.6 公尺、坡度 3%）",
    );
  });

  it("omits measurements that were not surveyed", () => {
    expect(
      arrivalEntranceHighlight({
        parkName: "青年公園",
        entranceName: "2號出入口",
        location: requested,
        minClearWidthM: null,
        slopePercent: null,
        distanceFromRequestedM: 0,
      }),
    ).toBe("已為您導引至「青年公園」2號出入口（無障礙出入口）");
  });
});
