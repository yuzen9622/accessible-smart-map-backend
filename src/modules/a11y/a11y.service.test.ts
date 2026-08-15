import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IA11y, IOsmA11y } from "../../types";
import type { CampusFacilityPlace } from "../campus/campus.service";
import { mergeA11yPlaces, osmToA11yPlace } from "./a11y.service";
import { campusToA11yPlace } from "./a11y.orchestration";

function makeCampusFacility(
  overrides: Partial<CampusFacilityPlace> = {},
): CampusFacilityPlace {
  return {
    campusId: 1234,
    schoolId: 56,
    schoolName: "國立臺中科技大學",
    branchName: "三民校區",
    facUid: "fac-001",
    facTypeId: 8,
    type: "elevator",
    facType: "無障礙電梯",
    name: "行政大樓電梯",
    building: "行政大樓",
    floors: ["1", "2"],
    location: { type: "Point", coordinates: [120.684, 24.152] },
    ...overrides,
  };
}

function makeOsmDoc(overrides: Partial<IOsmA11y> = {}): IOsmA11y {
  return {
    osmId: "12342946149",
    name: "市府轉運站電梯",
    category: "elevator",
    wheelchair: "yes",
    tags: { highway: "elevator" },
    location: { type: "Point", coordinates: [121.5662, 25.0412] },
    importedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeMetroDoc(): Omit<IA11y, "_id"> {
  return {
    項次: "1",
    "出入口電梯/無障礙坡道名稱": "台北車站 M8 出口電梯",
    location: { type: "Point", coordinates: [121.517, 25.0478] },
  };
}

describe("osmToA11yPlace", () => {
  it("maps an OSM doc into the A11y response shape", () => {
    const place = osmToA11yPlace(makeOsmDoc());
    expect(place).toMatchObject({
      項次: "12342946149",
      "出入口電梯/無障礙坡道名稱": "市府轉運站電梯",
      source: "osm",
      osmId: "12342946149",
      wheelchair: "yes",
      category: "elevator",
    });
  });

  it("falls back to a Chinese category name when the OSM node is unnamed", () => {
    const elevator = osmToA11yPlace(makeOsmDoc({ name: undefined }));
    expect(elevator["出入口電梯/無障礙坡道名稱"]).toBe("無障礙電梯");

    const ramp = osmToA11yPlace(
      makeOsmDoc({ name: undefined, category: "ramp" }),
    );
    expect(ramp["出入口電梯/無障礙坡道名稱"]).toBe("無障礙坡道");
  });
});

describe("mergeA11yPlaces", () => {
  it("tags metro docs with source=metro and appends OSM elevators/ramps", () => {
    const merged = mergeA11yPlaces(
      [makeMetroDoc()],
      [makeOsmDoc(), makeOsmDoc({ osmId: "way/99", category: "ramp" })],
    );
    expect(merged).toHaveLength(3);
    expect(merged[0].source).toBe("metro");
    expect(merged[0]["出入口電梯/無障礙坡道名稱"]).toBe("台北車站 M8 出口電梯");
    expect(merged[1]).toMatchObject({ source: "osm", category: "elevator" });
    expect(merged[2]).toMatchObject({ source: "osm", category: "ramp" });
  });

  it("filters out non-structure OSM categories", () => {
    const merged = mergeA11yPlaces(
      [],
      [
        makeOsmDoc({ category: "toilet" }),
        makeOsmDoc({ category: "kerb_cut" }),
        makeOsmDoc({ category: "wheelchair_accessible" }),
        makeOsmDoc({ category: "elevator", osmId: "42" }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].osmId).toBe("42");
  });

  it("appends pre-normalized campus places when given a third argument", () => {
    const merged = mergeA11yPlaces(
      [makeMetroDoc()],
      [makeOsmDoc()],
      [campusToA11yPlace(makeCampusFacility())],
    );
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({ source: "campus", facUid: "fac-001" });
  });

  it("behaves like the two-arg form when no campus places are given", () => {
    const merged = mergeA11yPlaces([makeMetroDoc()], [makeOsmDoc()]);
    expect(merged).toHaveLength(2);
    expect(merged.every((p) => p.source !== "campus")).toBe(true);
  });
});

describe("campusToA11yPlace", () => {
  it("maps a campus facility into the A11y response shape", () => {
    const place = campusToA11yPlace(makeCampusFacility());
    expect(place).toMatchObject({
      項次: "fac-001",
      "出入口電梯/無障礙坡道名稱": "行政大樓電梯",
      location: { type: "Point", coordinates: [120.684, 24.152] },
      source: "campus",
      campusId: 1234,
      schoolName: "國立臺中科技大學",
      facUid: "fac-001",
      facType: "elevator",
      facTypeLabel: "無障礙電梯",
    });
  });

  it("falls back to the Chinese facType label then a generic name when unnamed", () => {
    const labelled = campusToA11yPlace(makeCampusFacility({ name: undefined }));
    expect(labelled["出入口電梯/無障礙坡道名稱"]).toBe("無障礙電梯");

    const generic = campusToA11yPlace(
      makeCampusFacility({ name: undefined, facType: undefined }),
    );
    expect(generic["出入口電梯/無障礙坡道名稱"]).toBe("校園無障礙設施");
  });
});

vi.mock("../../model/a11y.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/osm-a11y.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bathroom.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/disabled-parking.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../../model/parking-space.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../../model/parking-lot.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../campus/campus.service", () => ({
  findAllFacilities: vi.fn(),
  findFacilitiesNearby: vi.fn(),
}));

import A11y from "../../model/a11y.model";
import OsmA11y from "../../model/osm-a11y.model";
import BathroomModel from "../../model/bathroom.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import ParkingLotModel from "../../model/parking-lot.model";
import ParkingSpaceModel from "../../model/parking-space.model";
import * as campusService from "../campus/campus.service";
import { findNearbyParking } from "./a11y.service";
import {
  findAllFacilities,
  findBathroomFacilities,
  findElevatorFacilities,
  findRampFacilities,
} from "./a11y.orchestration";
import { A11yFacilitySchema } from "./a11y.schema";

const GEO = {
  type: "Point" as const,
  coordinates: [121.5, 25.03] as [number, number],
};

/**
 * Builds a chainable Mongoose-query stub whose `.sort().limit().lean()` resolves
 * to `docs`, exposing each hop as a vi spy so callers can assert invocation.
 */
function makeChain(docs: unknown[]) {
  const lean = vi.fn().mockResolvedValue(docs);
  const limit = vi.fn().mockReturnValue({ lean });
  const sort = vi.fn().mockReturnValue({ limit });
  return { sort, limit, lean };
}

function metroDoc(id: string, name: string) {
  return {
    _id: id,
    項次: id,
    "出入口電梯/無障礙坡道名稱": name,
    location: GEO,
  };
}

const SPACE_IMPORTED_AT = new Date("2026-06-01T00:00:00Z");

function spaceDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    city: "臺北市",
    segmentId: "TPE-0001",
    spaceType: 1,
    hasChargingPoint: false,
    isDisabled: false,
    externalId: `ext-${id}`,
    location: GEO,
    importedAt: SPACE_IMPORTED_AT,
    ...overrides,
  };
}

function lotDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    carParkId: `lot-${id}`,
    name: `停車場${id}`,
    city: "臺中市",
    district: "南屯區",
    carParkType: 1,
    chargeTypes: [1],
    position: GEO,
    importedAt: SPACE_IMPORTED_AT,
    ...overrides,
  };
}

function osmDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "osm-doc",
    osmId: "o1",
    name: "市府轉運站電梯",
    category: "elevator",
    wheelchair: "yes",
    tags: { highway: "elevator" },
    location: GEO,
    importedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(A11y.find).mockReturnValue(makeChain([]) as never);
  vi.mocked(OsmA11y.find).mockReturnValue(makeChain([]) as never);
  vi.mocked(BathroomModel.find).mockReturnValue(makeChain([]) as never);
  vi.mocked(DisabledParkingModel.find).mockReturnValue(makeChain([]) as never);
  vi.mocked(ParkingSpaceModel.find).mockReturnValue(makeChain([]) as never);
  vi.mocked(ParkingLotModel.find).mockReturnValue(makeChain([]) as never);
  vi.mocked(campusService.findAllFacilities).mockResolvedValue([]);
});

describe("findAllFacilities", () => {
  it("returns items from all five sources with correct source-specific fields", async () => {
    vi.mocked(A11y.find).mockReturnValue(
      makeChain([
        metroDoc("m1", "台北車站 M8 出口電梯"),
        metroDoc("m2", "市府轉運站電梯"),
        metroDoc("m3", "xx無障礙坡道"),
      ]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({ _id: "od1", osmId: "o1" }),
        osmDoc({
          _id: "od2",
          osmId: "o2",
          name: undefined,
          category: "toilet",
          wheelchair: undefined,
          tags: {},
        }),
      ]) as never,
    );
    vi.mocked(BathroomModel.find).mockReturnValue(
      makeChain([
        {
          _id: "b1",
          name: "台北車站無障礙廁所",
          location: GEO,
          type: "無障礙廁所",
        },
      ]) as never,
    );
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([
        { _id: "p1", placeName: "商港八路身障停車格", location: GEO },
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "elevator" }),
    ]);

    const result = await findAllFacilities();

    const sources = result.map((f) => f.source);
    expect(new Set(sources)).toEqual(
      new Set(["metro", "osm", "campus", "bathroom", "parking"]),
    );
    for (const f of result) {
      expect(f._id).toBeTypeOf("string");
      expect(f.name).toBeTypeOf("string");
      expect(f.location).toMatchObject({ type: "Point" });
      expect(f.category).toBeTypeOf("string");
    }

    const metroItems = result.filter((f) => f.source === "metro");
    expect(metroItems).toHaveLength(3);
    for (const m of metroItems) expect("exitName" in m).toBe(true);

    const osmItems = result.filter((f) => f.source === "osm");
    for (const o of osmItems) {
      expect(o).toHaveProperty("osmId");
      expect(o).toHaveProperty("wheelchair");
    }

    const campusItem = result.find((f) => f.source === "campus");
    expect(campusItem).toMatchObject({
      source: "campus",
      schoolName: expect.any(String),
    });
  });

  it("classifies metro facilities and extracts exit names", async () => {
    vi.mocked(A11y.find).mockReturnValue(
      makeChain([
        metroDoc("m1", "台北車站 M8 出口電梯"),
        metroDoc("m2", "市府轉運站電梯"),
        metroDoc("m3", "xx無障礙坡道"),
      ]) as never,
    );

    const result = await findAllFacilities();
    const [m1, m2, m3] = result;
    expect(m1).toMatchObject({
      source: "metro",
      category: "elevator",
      exitName: "M8",
    });
    expect(m2).toMatchObject({
      source: "metro",
      category: "elevator",
      exitName: null,
    });
    expect(m3).toMatchObject({ source: "metro", category: "ramp" });
  });

  it("normalizes missing OSM wheelchair to null and falls back to a Chinese name for unnamed toilets", async () => {
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({
          _id: "od2",
          osmId: "o2",
          name: undefined,
          category: "toilet",
          wheelchair: undefined,
          tags: {},
        }),
      ]) as never,
    );

    const [toilet] = await findAllFacilities();
    expect(toilet).toMatchObject({
      source: "osm",
      osmId: "o2",
      wheelchair: null,
      name: "無障礙廁所",
    });
  });

  it("sorts and limits each model query", async () => {
    const metroChain = makeChain([]);
    vi.mocked(A11y.find).mockReturnValue(metroChain as never);

    await findAllFacilities();

    expect(vi.mocked(A11y.find)).toHaveBeenCalled();
    expect(metroChain.sort).toHaveBeenCalled();
    expect(metroChain.limit).toHaveBeenCalled();
  });
});

describe("findAllFacilities with a category whitelist", () => {
  it("queries only parking-capable sources for ['parking']", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([
        { _id: "p1", placeName: "商港八路身障停車格", location: GEO },
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "elevator" }),
    ]);

    const result = await findAllFacilities(["parking"]);

    expect(vi.mocked(A11y.find)).not.toHaveBeenCalled();
    expect(vi.mocked(OsmA11y.find)).not.toHaveBeenCalled();
    expect(vi.mocked(BathroomModel.find)).not.toHaveBeenCalled();
    expect(vi.mocked(DisabledParkingModel.find)).toHaveBeenCalled();
    expect(result.map((f) => f.category)).toEqual(["parking"]);
  });

  it("narrows the OSM query and skips bathroom/parking for ['elevator']", async () => {
    vi.mocked(A11y.find).mockReturnValue(
      makeChain([
        metroDoc("m1", "台北車站 M8 出口電梯"),
        metroDoc("m2", "xx無障礙坡道"),
      ]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({ _id: "od1", osmId: "o1", category: "elevator" }),
      ]) as never,
    );

    const result = await findAllFacilities(["elevator"]);

    expect(vi.mocked(OsmA11y.find)).toHaveBeenCalledWith({
      category: { $in: ["elevator"] },
    });
    expect(vi.mocked(BathroomModel.find)).not.toHaveBeenCalled();
    expect(vi.mocked(DisabledParkingModel.find)).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    for (const f of result) expect(f.category).toBe("elevator");
  });

  it("skips metro and includes bathroom, OSM toilets and campus toilets for ['toilet']", async () => {
    vi.mocked(BathroomModel.find).mockReturnValue(
      makeChain([
        {
          _id: "b1",
          name: "台北車站無障礙廁所",
          location: GEO,
          type: "無障礙廁所",
        },
      ]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({ _id: "od2", osmId: "o2", category: "toilet" }),
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "accessible_toilet" }),
      makeCampusFacility({ facUid: "c2", type: "ramp" }),
    ]);

    const result = await findAllFacilities(["toilet"]);

    expect(vi.mocked(A11y.find)).not.toHaveBeenCalled();
    expect(vi.mocked(OsmA11y.find)).toHaveBeenCalledWith({
      category: { $in: ["toilet"] },
    });
    expect(new Set(result.map((f) => f.source))).toEqual(
      new Set(["bathroom", "osm", "campus"]),
    );
    for (const f of result) expect(f.category).toBe("toilet");
  });

  it("maps ['other'] to the OSM kerb_cut/wheelchair_accessible categories and keeps unclassified metro/campus items", async () => {
    vi.mocked(A11y.find).mockReturnValue(
      makeChain([
        metroDoc("m1", "台北車站 M8 出口電梯"),
        metroDoc("m2", "無障礙通道"),
      ]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({ _id: "od3", osmId: "o3", category: "kerb_cut" }),
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "accessible_stairs" }),
    ]);

    const result = await findAllFacilities(["other"]);

    expect(vi.mocked(OsmA11y.find)).toHaveBeenCalledWith({
      category: { $in: ["kerb_cut", "wheelchair_accessible"] },
    });
    expect(vi.mocked(BathroomModel.find)).not.toHaveBeenCalled();
    expect(vi.mocked(DisabledParkingModel.find)).not.toHaveBeenCalled();
    expect(new Set(result.map((f) => f.source))).toEqual(
      new Set(["metro", "osm", "campus"]),
    );
    for (const f of result) expect(f.category).toBe("other");
  });

  it("unions the OSM $in condition and only returns the selected categories for ['elevator','toilet']", async () => {
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({ _id: "od1", osmId: "o1", category: "elevator" }),
        osmDoc({ _id: "od2", osmId: "o2", category: "toilet" }),
      ]) as never,
    );
    vi.mocked(BathroomModel.find).mockReturnValue(
      makeChain([
        {
          _id: "b1",
          name: "台北車站無障礙廁所",
          location: GEO,
          type: "無障礙廁所",
        },
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "elevator" }),
      makeCampusFacility({ facUid: "c2", type: "accessible_parking" }),
    ]);

    const result = await findAllFacilities(["elevator", "toilet"]);

    expect(vi.mocked(OsmA11y.find)).toHaveBeenCalledWith({
      category: { $in: ["elevator", "toilet"] },
    });
    expect(vi.mocked(BathroomModel.find)).toHaveBeenCalled();
    expect(vi.mocked(DisabledParkingModel.find)).not.toHaveBeenCalled();
    expect(new Set(result.map((f) => f.category))).toEqual(
      new Set(["elevator", "toilet"]),
    );
  });

  it("queries every source when all five categories are requested", async () => {
    await findAllFacilities(["elevator", "ramp", "toilet", "parking", "other"]);

    expect(vi.mocked(A11y.find)).toHaveBeenCalled();
    expect(vi.mocked(OsmA11y.find)).toHaveBeenCalledWith({
      category: {
        $in: [
          "elevator",
          "ramp",
          "toilet",
          "kerb_cut",
          "wheelchair_accessible",
        ],
      },
    });
    expect(vi.mocked(BathroomModel.find)).toHaveBeenCalled();
    expect(vi.mocked(DisabledParkingModel.find)).toHaveBeenCalled();
    expect(vi.mocked(campusService.findAllFacilities)).toHaveBeenCalled();
  });

  it("treats an empty whitelist like no whitelist and queries every source unfiltered", async () => {
    await findAllFacilities([]);

    expect(vi.mocked(A11y.find)).toHaveBeenCalledWith();
    expect(vi.mocked(OsmA11y.find)).toHaveBeenCalledWith();
    expect(vi.mocked(BathroomModel.find)).toHaveBeenCalledWith({
      type: "無障礙廁所",
    });
    expect(vi.mocked(DisabledParkingModel.find)).toHaveBeenCalledWith();
  });
});

describe("findElevatorFacilities", () => {
  it("returns only elevator-category items and campus facilities of type elevator", async () => {
    vi.mocked(A11y.find).mockReturnValue(
      makeChain([metroDoc("m1", "台北車站 M8 出口電梯")]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({ _id: "od1", osmId: "o1", category: "elevator" }),
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "elevator" }),
      makeCampusFacility({ facUid: "c2", type: "ramp" }),
      makeCampusFacility({ facUid: "c3", type: "accessible_toilet" }),
    ]);

    const result = await findElevatorFacilities();
    expect(result.every((f) => f.category === "elevator")).toBe(true);
    const campusItems = result.filter((f) => f.source === "campus");
    expect(campusItems).toHaveLength(1);
    expect(campusItems[0]._id).toBe("c1");
  });
});

describe("findRampFacilities", () => {
  it("returns campus ramps and OSM ramps only", async () => {
    vi.mocked(A11y.find).mockReturnValue(
      makeChain([metroDoc("m3", "xx無障礙坡道")]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({
          _id: "od1",
          osmId: "o1",
          category: "ramp",
          name: "無障礙坡道",
        }),
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "elevator" }),
      makeCampusFacility({ facUid: "c2", type: "ramp" }),
    ]);

    const result = await findRampFacilities();
    const campusItems = result.filter((f) => f.source === "campus");
    expect(campusItems).toHaveLength(1);
    expect(campusItems[0]._id).toBe("c2");
    const osmItems = result.filter((f) => f.source === "osm");
    expect(osmItems.every((f) => f.category === "ramp")).toBe(true);
  });
});

describe("findBathroomFacilities", () => {
  it("returns toilet-category items across bathroom, OSM and campus sources", async () => {
    vi.mocked(BathroomModel.find).mockReturnValue(
      makeChain([
        {
          _id: "b1",
          name: "台北車站無障礙廁所",
          location: GEO,
          type: "無障礙廁所",
        },
      ]) as never,
    );
    vi.mocked(OsmA11y.find).mockReturnValue(
      makeChain([
        osmDoc({
          _id: "od1",
          osmId: "o1",
          category: "toilet",
          name: undefined,
          tags: {},
        }),
      ]) as never,
    );
    vi.mocked(campusService.findAllFacilities).mockResolvedValue([
      makeCampusFacility({ facUid: "c1", type: "accessible_toilet" }),
      makeCampusFacility({ facUid: "c2", type: "elevator" }),
    ]);

    const result = await findBathroomFacilities();
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((f) => f.category === "toilet")).toBe(true);

    const bathroomItem = result.find((f) => f.source === "bathroom");
    expect(bathroomItem).toMatchObject({
      category: "toilet",
      name: "台北車站無障礙廁所",
    });

    const campusItems = result.filter((f) => f.source === "campus");
    expect(campusItems).toHaveLength(1);
    expect(campusItems[0]._id).toBe("c1");
  });
});

describe("A11yFacilitySchema", () => {
  const geo = { type: "Point", coordinates: [121.5, 25.03] };

  it("accepts a valid sample of each source", () => {
    const samples = [
      {
        _id: "1",
        name: "電梯",
        location: geo,
        category: "elevator",
        source: "metro",
        exitName: "M8",
      },
      {
        _id: "2",
        name: "坡道",
        location: geo,
        category: "ramp",
        source: "osm",
        osmId: "o1",
        wheelchair: "yes",
      },
      {
        _id: "3",
        name: "電梯",
        location: geo,
        category: "elevator",
        source: "campus",
        schoolName: "北科大",
      },
      {
        _id: "4",
        name: "廁所",
        location: geo,
        category: "toilet",
        source: "bathroom",
      },
      {
        _id: "5",
        name: "停車格",
        location: geo,
        category: "parking",
        source: "parking",
      },
    ];
    for (const s of samples) {
      expect(A11yFacilitySchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects a metro object missing exitName", () => {
    const res = A11yFacilitySchema.safeParse({
      _id: "1",
      name: "電梯",
      location: geo,
      category: "elevator",
      source: "metro",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a metro object with an extra osmId field (.strict)", () => {
    const res = A11yFacilitySchema.safeParse({
      _id: "1",
      name: "電梯",
      location: geo,
      category: "elevator",
      source: "metro",
      exitName: "M8",
      osmId: "x",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a campus object missing schoolName", () => {
    const res = A11yFacilitySchema.safeParse({
      _id: "3",
      name: "電梯",
      location: geo,
      category: "elevator",
      source: "campus",
    });
    expect(res.success).toBe(false);
  });

  it("rejects an osm object missing osmId", () => {
    const res = A11yFacilitySchema.safeParse({
      _id: "2",
      name: "坡道",
      location: geo,
      category: "ramp",
      source: "osm",
      wheelchair: "yes",
    });
    expect(res.success).toBe(false);
  });
});

import { computeVerdict, buildQuickAssessSummary } from "./a11y.service";
import type { QuickAssessFacilityCount } from "./a11y.service";

const counts = (
  o: Partial<QuickAssessFacilityCount> = {},
): QuickAssessFacilityCount => ({
  elevator: 0,
  ramp: 0,
  toilet: 0,
  parking: 0,
  ...o,
});

describe("computeVerdict", () => {
  it("wheelchair: good needs a structural asset + total>=3 + few hazards", () => {
    expect(
      computeVerdict(counts({ elevator: 2, toilet: 1 }), 0, "wheelchair"),
    ).toBe("good");
  });
  it("wheelchair: only toilets (no structural) is caution, not good", () => {
    expect(computeVerdict(counts({ toilet: 3 }), 0, "wheelchair")).toBe(
      "caution",
    );
  });
  it("caution when at least one facility but not enough for good", () => {
    expect(computeVerdict(counts({ elevator: 1 }), 0, "wheelchair")).toBe(
      "caution",
    );
  });
  it("difficult when nothing nearby", () => {
    expect(computeVerdict(counts(), 0, "wheelchair")).toBe("difficult");
  });
  it("heavy hazard load forces difficult regardless of facilities", () => {
    expect(
      computeVerdict(counts({ elevator: 5, toilet: 5 }), 3, "wheelchair"),
    ).toBe("difficult");
  });
  it("normal mode does not require a structural asset for good", () => {
    expect(computeVerdict(counts({ toilet: 3 }), 0, "normal")).toBe("good");
  });
});

describe("buildQuickAssessSummary", () => {
  it("lists non-zero facilities with units and a verdict clause", () => {
    const s = buildQuickAssessSummary(
      counts({ elevator: 3, toilet: 2 }),
      0,
      "good",
      "wheelchair",
      200,
    );
    expect(s).toContain("200 公尺");
    expect(s).toContain("3 座電梯");
    expect(s).toContain("2 間無障礙廁所");
    expect(s).toContain("適合輪椅前往");
  });
  it("appends the hazard clause only when hazards exist", () => {
    const withHaz = buildQuickAssessSummary(
      counts({ elevator: 1 }),
      2,
      "caution",
      "wheelchair",
      200,
    );
    expect(withHaz).toContain("2 則通行障礙回報");
    const noHaz = buildQuickAssessSummary(
      counts({ elevator: 1 }),
      0,
      "caution",
      "wheelchair",
      200,
    );
    expect(noHaz).not.toContain("通行障礙回報");
  });
  it("states limited info when no facilities nearby", () => {
    const s = buildQuickAssessSummary(
      counts(),
      0,
      "difficult",
      "wheelchair",
      200,
    );
    expect(s).toContain("資訊有限");
  });
});

describe("findNearbyParking", () => {
  it("caps the client-supplied radius at 5000m and limits results to 50", async () => {
    const chain = makeChain([{ _id: "p1", placeName: "x", location: GEO }]);
    vi.mocked(DisabledParkingModel.find).mockReturnValue(chain as never);

    const result = await findNearbyParking(25.03, 121.56, 9999999);

    expect(vi.mocked(DisabledParkingModel.find)).toHaveBeenCalledWith({
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [121.56, 25.03] },
          $maxDistance: 5000,
        },
      },
    });
    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(result).toEqual([
      { _id: "p1", placeName: "x", location: GEO, type: "disabled" },
    ]);
  });

  it("keeps radii below the cap unchanged", async () => {
    const chain = makeChain([]);
    vi.mocked(DisabledParkingModel.find).mockReturnValue(chain as never);

    await findNearbyParking(25.03, 121.56, 300);

    const arg = vi.mocked(DisabledParkingModel.find).mock.calls[0][0] as {
      location: { $near: { $maxDistance: number } };
    };
    expect(arg.location.$near.$maxDistance).toBe(300);
  });

  it("defaults the radius to 1000m when omitted", async () => {
    const chain = makeChain([]);
    vi.mocked(DisabledParkingModel.find).mockReturnValue(chain as never);

    await findNearbyParking(25.03, 121.56);

    const arg = vi.mocked(DisabledParkingModel.find).mock.calls[0][0] as {
      location: { $near: { $maxDistance: number } };
    };
    expect(arg.location.$near.$maxDistance).toBe(1000);
  });

  it("defaults to type=all and queries both collections when type is omitted", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([{ _id: "p1", placeName: "x", location: GEO }]) as never,
    );
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(
      makeChain([spaceDoc("s1")]) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300);

    expect(vi.mocked(DisabledParkingModel.find)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ParkingSpaceModel.find)).toHaveBeenCalledTimes(1);
    expect(result.map((p) => p.type)).toEqual(["disabled", "standard"]);
  });

  it("queries only ParkingSpace for type=standard and maps it into the unified shape", async () => {
    const chain = makeChain([spaceDoc("s1")]);
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(chain as never);

    const result = await findNearbyParking(25.03, 121.56, 300, "standard");

    expect(vi.mocked(DisabledParkingModel.find)).not.toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(result).toEqual([
      {
        _id: "s1",
        city: "臺北市",
        district: "臺北市",
        areacode: "",
        quantity: 1,
        placeName: "一般停車格（ext-s1）",
        chargeType: "",
        spaceLabel: "",
        isMarked: false,
        source: "tdx",
        externalId: "ext-s1",
        location: GEO,
        importedAt: SPACE_IMPORTED_AT,
        type: "standard",
        segmentId: "TPE-0001",
        spaceType: 1,
        hasChargingPoint: false,
      },
    ]);
  });

  it("caps the radius for the standard-bay query too", async () => {
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(makeChain([]) as never);

    await findNearbyParking(25.03, 121.56, 9999999, "standard");

    const arg = vi.mocked(ParkingSpaceModel.find).mock.calls[0][0] as {
      location: { $near: { $maxDistance: number } };
    };
    expect(arg.location.$near.$maxDistance).toBe(5000);
  });

  it("queries both collections for type=all and puts disabled bays first", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([{ _id: "p1", placeName: "x", location: GEO }]) as never,
    );
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(
      makeChain([spaceDoc("s1")]) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300, "all");

    expect(vi.mocked(DisabledParkingModel.find)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ParkingSpaceModel.find)).toHaveBeenCalledTimes(1);
    expect(result.map((p) => p.type)).toEqual(["disabled", "standard"]);
    const second = result[1];
    expect(second.type).toBe("standard");
    if (second.type === "standard") {
      expect(second.placeName).toBe("一般停車格（ext-s1）");
    }
  });

  it("fills type=all up to 50 results with standard bays only after every disabled bay", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain(
        Array.from({ length: 48 }, (_, i) => ({
          _id: `p${i}`,
          placeName: "x",
          location: GEO,
        })),
      ) as never,
    );
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(
      makeChain(
        Array.from({ length: 50 }, (_, i) => spaceDoc(`s${i}`)),
      ) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300, "all");

    expect(result).toHaveLength(50);
    expect(result.filter((p) => p.type === "disabled")).toHaveLength(48);
    expect(result.filter((p) => p.type === "standard")).toHaveLength(2);
  });

  it("drops standard bays entirely for type=all when disabled bays already fill the cap", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain(
        Array.from({ length: 50 }, (_, i) => ({
          _id: `p${i}`,
          placeName: "x",
          location: GEO,
        })),
      ) as never,
    );
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(
      makeChain([spaceDoc("s1")]) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300, "all");

    expect(result).toHaveLength(50);
    expect(result.every((p) => p.type === "disabled")).toBe(true);
  });

  it("queries ParkingLot for type=all and puts lots after disabled bays, before standard bays", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([{ _id: "p1", placeName: "x", location: GEO }]) as never,
    );
    vi.mocked(ParkingLotModel.find).mockReturnValue(
      makeChain([lotDoc("l1")]) as never,
    );
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(
      makeChain([spaceDoc("s1")]) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300, "all");

    expect(vi.mocked(ParkingLotModel.find)).toHaveBeenCalledWith({
      position: {
        $near: {
          $geometry: { type: "Point", coordinates: [121.56, 25.03] },
          $maxDistance: 300,
        },
      },
    });
    expect(result.map((p) => p.type)).toEqual(["disabled", "lot", "standard"]);
    expect(result[1]).toMatchObject({ type: "lot", name: "停車場l1" });
  });

  it("queries every lot for type=standard and appends them after standard bays", async () => {
    vi.mocked(ParkingSpaceModel.find).mockReturnValue(
      makeChain([spaceDoc("s1")]) as never,
    );
    vi.mocked(ParkingLotModel.find).mockReturnValue(
      makeChain([lotDoc("l1")]) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300, "standard");

    expect(vi.mocked(ParkingLotModel.find)).toHaveBeenCalledTimes(1);
    expect(result.map((p) => p.type)).toEqual(["standard", "lot"]);
  });

  it("filters lots to confirmed disabled capacity for type=disabled", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([]) as never,
    );
    vi.mocked(ParkingLotModel.find).mockReturnValue(
      makeChain([lotDoc("l1", { disabledSpaces: 2 })]) as never,
    );

    await findNearbyParking(25.03, 121.56, 300, "disabled");

    expect(vi.mocked(ParkingLotModel.find)).toHaveBeenCalledWith({
      position: {
        $near: {
          $geometry: { type: "Point", coordinates: [121.56, 25.03] },
          $maxDistance: 300,
        },
      },
      $or: [{ disabledSpaces: { $gt: 0 } }, { wheelchairAccessible: true }],
    });
  });

  it("includes eligible lots in type=disabled results after disabled bays", async () => {
    vi.mocked(DisabledParkingModel.find).mockReturnValue(
      makeChain([{ _id: "p1", placeName: "x", location: GEO }]) as never,
    );
    vi.mocked(ParkingLotModel.find).mockReturnValue(
      makeChain([
        lotDoc("l1", { wheelchairAccessible: true, disabledSpaces: 4 }),
      ]) as never,
    );

    const result = await findNearbyParking(25.03, 121.56, 300, "disabled");

    expect(result.map((p) => p.type)).toEqual(["disabled", "lot"]);
    expect(result[1]).toMatchObject({
      type: "lot",
      carParkId: "lot-l1",
      wheelchairAccessible: true,
      disabledSpaces: 4,
    });
  });
});
