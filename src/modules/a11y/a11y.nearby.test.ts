import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IA11y, IBathroom, IOsmA11y } from "../../types";
import BathroomModel from "../../model/bathroom.model";
import { buildResponsePayload } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import { haversineMeters } from "../../utils/geo";
import { preparePlaceBounds, type PlaceBounds } from "../../utils/place-extent";
import { fetchTaipeiMetroNotices } from "../../adapters/taipei-metro-notice.adapter";
import * as repository from "./a11y.repository";
import * as campusService from "../campus/campus.service";
import { mergeA11yPlaces } from "./a11y.service";
import {
  campusToA11yPlace,
  findNearby,
  summarizeNearby,
} from "./a11y.orchestration";

vi.mock("./a11y.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./a11y.repository")>()),
  findNearbyA11yRows: vi.fn(),
  findNearbyA11yRowsInBounds: vi.fn(),
}));
vi.mock("../campus/campus.service", () => ({
  findFacilitiesNearby: vi.fn(),
  findFacilitiesInBounds: vi.fn(),
}));
vi.mock("../../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn(),
}));

const origin = { lat: 24.1372, lng: 120.6867 };
const point = (lng = origin.lng, lat = origin.lat) => ({
  type: "Point" as const,
  coordinates: [lng, lat] as [number, number],
});
const osm = (
  osmId: string,
  category: IOsmA11y["category"],
  lng = origin.lng,
): IOsmA11y => ({
  osmId,
  category,
  name: `OSM ${category}`,
  tags: {},
  location: point(lng),
  importedAt: new Date(0),
});
const metro = (id: string, name: string, lng = origin.lng): IA11y => ({
  _id: id,
  項次: id,
  "出入口電梯/無障礙坡道名稱": name,
  location: point(lng),
});
const campus = (
  facUid: string,
  type: string,
): campusService.CampusFacilityPlace => ({
  campusId: 1,
  schoolId: 2,
  schoolName: "測試大學",
  branchName: "主校區",
  facUid,
  type,
  name: `校園 ${type}`,
  floors: [],
  location: point(),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repository.findNearbyA11yRows).mockResolvedValue({
    metro: [],
    osm: [],
    bathroom: [],
    parking: [],
  });
  vi.mocked(repository.findNearbyA11yRowsInBounds).mockResolvedValue({
    metro: [],
    osm: [],
    bathroom: [],
    parking: [],
  });
  vi.mocked(campusService.findFacilitiesNearby).mockResolvedValue([]);
  vi.mocked(campusService.findFacilitiesInBounds).mockResolvedValue([]);
  vi.mocked(fetchTaipeiMetroNotices).mockResolvedValue([]);
});

describe("summarizeNearby", () => {
  it("keeps campus toilets, ramps and elevators separate and ignores parking/other", () => {
    const places = [
      "accessible_toilet",
      "ramp",
      "elevator",
      "accessible_parking",
      "other",
    ].map((type) => campusToA11yPlace(campus(type, type)));
    expect(
      summarizeNearby(
        { nearbyMetroA11y: places, nearbyOsm: [], nearbyBathroom: [] },
        origin,
      ),
    ).toEqual({
      elevator: { count: 1, nearestMeters: 0 },
      ramp: { count: 1, nearestMeters: 0 },
      toilet: { count: 1, nearestMeters: 0 },
    });
    expect(
      summarizeNearby(
        {
          nearbyMetroA11y: places.slice(0, 1),
          nearbyOsm: [],
          nearbyBathroom: [],
        },
        origin,
      ).elevator,
    ).toEqual({ count: 0, nearestMeters: null });
  });

  it("counts OSM toilets and government bathrooms, reusing OSM and metro classifications", () => {
    const osmRows = [
      osm("lift", "elevator"),
      osm("ramp", "ramp"),
      osm("wc", "toilet"),
      osm("kerb", "kerb_cut"),
    ];
    const places = mergeA11yPlaces(
      [
        metro("both", "出口電梯及坡道"),
        metro("ramp", "出口坡道"),
        metro("other", "出口通道"),
      ],
      osmRows,
    );
    expect(
      summarizeNearby(
        {
          nearbyMetroA11y: places,
          nearbyOsm: osmRows,
          nearbyBathroom: [{ location: point() }],
        },
        origin,
      ),
    ).toEqual({
      elevator: { count: 2, nearestMeters: 0 },
      ramp: { count: 2, nearestMeters: 0 },
      toilet: { count: 2, nearestMeters: 0 },
    });
  });

  it("counts a shared OSM identity only once across and within the merged/raw arrays", () => {
    const row = osm("same", "elevator");
    expect(
      summarizeNearby(
        {
          nearbyMetroA11y: mergeA11yPlaces([], [row, row]),
          nearbyOsm: [row, row],
          nearbyBathroom: [],
        },
        origin,
      ).elevator.count,
    ).toBe(1);
  });

  it("rounds the closest distance and leaves empty categories nullable", () => {
    const rows = [
      osm("far", "toilet", origin.lng + 0.002),
      osm("near", "toilet", origin.lng + 0.0003),
    ];
    expect(
      summarizeNearby(
        { nearbyMetroA11y: [], nearbyOsm: rows, nearbyBathroom: [] },
        origin,
      ),
    ).toEqual({
      elevator: { count: 0, nearestMeters: null },
      ramp: { count: 0, nearestMeters: null },
      toilet: {
        count: 2,
        nearestMeters: Math.round(
          haversineMeters(
            origin.lat,
            origin.lng,
            origin.lat,
            origin.lng + 0.0003,
          ),
        ),
      },
    });
  });

  it("deduplicates exact metro/OSM matches without hiding different nearby facilities", () => {
    const matched = {
      ...osm("shared-lift", "elevator"),
      name: "台北車站 M8 出口電梯",
    };
    const otherName = {
      ...osm("other-lift", "elevator"),
      name: "台北車站 M9 出口電梯",
    };
    const otherPosition = {
      ...matched,
      osmId: "other-position",
      location: point(origin.lng + 0.0001),
    };
    const osmRows = [matched, otherName, otherPosition];
    expect(
      summarizeNearby(
        {
          nearbyMetroA11y: mergeA11yPlaces(
            [metro("m8", matched.name)],
            osmRows,
          ),
          nearbyOsm: osmRows,
          nearbyBathroom: [],
        },
        origin,
      ).elevator.count,
    ).toBe(3);
  });
});

describe("findNearby", () => {
  it("preserves radius queries, legacy serialized fields and source ordering without bbox", async () => {
    const metroRow = metro("m1", "台北車站 M8 出口電梯", origin.lng + 0.001);
    const osmRow = osm("o1", "elevator");
    const campusRow = campus("c1", "accessible_toilet");
    const bathroom = new BathroomModel({
      _id: "000000000000000000000001",
      name: "政府廁所",
      location: point(),
      latitude: origin.lat,
      longitude: origin.lng,
      __v: 2,
    });
    vi.mocked(repository.findNearbyA11yRows).mockResolvedValue({
      metro: [metroRow],
      osm: [osmRow],
      bathroom: [bathroom as unknown as IBathroom],
      parking: [],
    });
    vi.mocked(campusService.findFacilitiesNearby).mockResolvedValue([
      campusRow,
    ]);
    const postedAt = new Date();
    vi.mocked(fetchTaipeiMetroNotices).mockResolvedValue([
      {
        station: "台北車站",
        line: "板南線",
        description: "電梯暫停使用",
        postedAt,
      },
    ]);

    const result = await findNearby(origin.lat, origin.lng);
    expect(repository.findNearbyA11yRows).toHaveBeenCalledExactlyOnceWith(
      origin.lat,
      origin.lng,
      150,
    );
    expect(campusService.findFacilitiesNearby).toHaveBeenCalledExactlyOnceWith(
      origin.lat,
      origin.lng,
      150,
    );
    expect(repository.findNearbyA11yRowsInBounds).not.toHaveBeenCalled();
    expect(campusService.findFacilitiesInBounds).not.toHaveBeenCalled();
    expect(fetchTaipeiMetroNotices).toHaveBeenCalledTimes(1);

    const { summary: _summary, ...groups } = result;
    const legacy = Object.fromEntries(
      Object.entries(groups).map(([key, rows]) => [
        key,
        rows.map(({ distanceMeters: _distance, ...row }) => row),
      ]),
    );
    const serialize = (value: unknown) =>
      JSON.parse(
        JSON.stringify(
          buildResponsePayload(true, "success", ResponseCode.OK, "ok", value),
        ),
      );
    expect(serialize(legacy)).toEqual(
      serialize({
        nearbyMetroA11y: [
          {
            ...metroRow,
            source: "metro",
            outageNotice: {
              description: "電梯暫停使用",
              postedAt: postedAt.toISOString(),
            },
          },
          {
            項次: "o1",
            "出入口電梯/無障礙坡道名稱": "OSM elevator",
            location: point(),
            source: "osm",
            osmId: "o1",
            category: "elevator",
          },
          {
            項次: "c1",
            "出入口電梯/無障礙坡道名稱": "校園 accessible_toilet",
            location: point(),
            source: "campus",
            campusId: 1,
            schoolName: "測試大學",
            facUid: "c1",
            facType: "accessible_toilet",
          },
        ],
        nearbyBathroom: [bathroom],
        nearbyOsm: [osmRow],
        nearbyParking: [],
      }),
    );
    expect(result.nearbyMetroA11y.map((row) => row.source)).toEqual([
      "metro",
      "osm",
      "campus",
    ]);
    expect(result.nearbyMetroA11y[0].distanceMeters).toBeGreaterThan(
      result.nearbyMetroA11y[1].distanceMeters,
    );
  });

  it("uses one prepared bbox per source and sorts every group from the request origin", async () => {
    const bounds: PlaceBounds = [120.6835, 24.135, 120.6895, 24.1395];
    const near = point(origin.lng + 0.0001);
    const far = point(origin.lng + 0.001);
    vi.mocked(repository.findNearbyA11yRowsInBounds).mockResolvedValue({
      metro: [metro("m1", "台北車站出口電梯", far.coordinates[0])],
      osm: [
        osm("far", "elevator", far.coordinates[0]),
        osm("near", "toilet", near.coordinates[0]),
      ],
      bathroom: [
        { _id: "far", location: far },
        { _id: "near", location: near },
      ] as IBathroom[],
      parking: [
        { _id: "far", location: far },
        { _id: "near", location: near },
      ] as repository.NearbyA11yRows["parking"],
    });
    vi.mocked(campusService.findFacilitiesInBounds).mockResolvedValue([
      campus("c1", "ramp"),
    ]);
    vi.mocked(fetchTaipeiMetroNotices).mockResolvedValue([
      {
        station: "台北車站",
        line: "板南線",
        description: "電梯暫停使用",
        postedAt: new Date(),
      },
    ]);
    const result = await findNearby(origin.lat, origin.lng, {
      kind: "bbox",
      bounds,
    });
    expect(
      repository.findNearbyA11yRowsInBounds,
    ).toHaveBeenCalledExactlyOnceWith(preparePlaceBounds(bounds));
    expect(
      campusService.findFacilitiesInBounds,
    ).toHaveBeenCalledExactlyOnceWith(preparePlaceBounds(bounds));
    expect(repository.findNearbyA11yRows).not.toHaveBeenCalled();
    expect(campusService.findFacilitiesNearby).not.toHaveBeenCalled();
    expect(fetchTaipeiMetroNotices).toHaveBeenCalledTimes(1);
    expect(
      result.nearbyMetroA11y.find((row) => row.source === "metro")?.outageNotice
        ?.description,
    ).toBe("電梯暫停使用");
    for (const rows of [
      result.nearbyMetroA11y,
      result.nearbyBathroom,
      result.nearbyOsm,
      result.nearbyParking,
    ]) {
      const distances = rows.map((row) => row.distanceMeters);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    }
    expect(result.summary.elevator.count).toBe(2);
  });

  it("does not substitute radius results after a bbox query fails", async () => {
    vi.mocked(repository.findNearbyA11yRowsInBounds).mockRejectedValue(
      new Error("db failure"),
    );
    await expect(
      findNearby(origin.lat, origin.lng, {
        kind: "bbox",
        bounds: [120.68, 24.13, 120.69, 24.14],
      }),
    ).rejects.toThrow("db failure");
    expect(repository.findNearbyA11yRows).not.toHaveBeenCalled();
    expect(campusService.findFacilitiesNearby).not.toHaveBeenCalled();
  });
});
