import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import VenueModel from "../../model/venue.model";
import { compileVenue } from "./venue.compile";
import { parseOsmXml, type OsmData, type OsmTags } from "./venue-osm.parse";
import type { LngLat } from "./venue.types";

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Required fictional source is absent");
  return value;
}

/** Fictional source geometry: coordinates are deliberately unrelated to NUTC. */
function fixture() {
  const osm: OsmData = {
    nodes: new Map(),
    ways: new Map(),
    relations: new Map(),
  };
  let next = 1;
  const point = (
    x: number,
    y: number,
    tags: OsmTags = {},
    id = `p${next++}`,
  ) => {
    osm.nodes.set(id, {
      id,
      lon: 120 + x * 0.00001,
      lat: 24 + y * 0.00001,
      tags,
    });
    return id;
  };
  const way = (id: string, nodeIds: string[], tags: OsmTags) => {
    osm.ways.set(id, { id, nodeIds, tags });
    return id;
  };
  const rectangle = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    tags: OsmTags,
  ) => {
    const corners = [
      point(x1, y1),
      point(x2, y1),
      point(x2, y2),
      point(x1, y2),
    ];
    return way(id, [...corners, corners[0]], tags);
  };
  rectangle("building", 0, 0, 100, 100, {
    building: "yes",
    name: "Fictional",
    "a11ymap:id": "fictional",
    "building:levels": "3",
  });
  for (const [id, x] of [
    ["lift-a", 20],
    ["lift-b", 40],
    ["lift-c", 60],
  ] as const) {
    point(
      x,
      20,
      {
        highway: "elevator",
        level: "0;2",
        name: "相同電梯名稱",
        ref: id,
        "a11ymap:id": id,
      },
      id,
    );
  }
  way(
    "approaches",
    [point(10, 20), "lift-a", "lift-b", "lift-c", point(70, 20)],
    {
      highway: "corridor",
      level: "0",
      repeat_on: "2",
    },
  );
  const compile = (buildingIds?: string[]) =>
    compileVenue(osm, {
      venueId: "fictional",
      name: "Fictional",
      ...(buildingIds ? { buildingIds } : {}),
    });
  const coordinates = (id: string): LngLat[] =>
    required(osm.ways.get(id)).nodeIds.map((nid) => {
      const n = required(osm.nodes.get(nid));
      return [n.lon, n.lat];
    });
  return { osm, point, way, rectangle, compile, coordinates };
}

describe("source-backed renderer compilation", () => {
  it("retains only public feature tags and every polygon ring without reshaping", () => {
    const f = fixture();
    f.rectangle("outer", 10, 40, 90, 90, {});
    f.rectangle("hole", 20, 50, 30, 60, {});
    f.osm.relations.set("toilets", {
      id: "toilets",
      members: [
        { type: "way", ref: "outer", role: "outer" },
        { type: "way", ref: "hole", role: "inner" },
      ],
      tags: {
        type: "multipolygon",
        indoor: "area",
        amenity: "toilets",
        "a11ymap:area_type": "facility",
        level: "0",
        ref: "{L}01",
        private: "do not publish",
      },
    });
    const result = f.compile();
    expect(result.errors).toEqual([]);
    expect(
      result.venue.features.find(
        (feature) => feature.id === "relation/toilets@0",
      ),
    ).toMatchObject({
      osmRef: "relation/toilets",
      kind: "area",
      buildingId: "fictional",
      ref: "101",
      tags: {
        indoor: "area",
        amenity: "toilets",
        "a11ymap:area_type": "facility",
        ref: "101",
      },
      geometry: {
        type: "Polygon",
        coordinates: [f.coordinates("outer"), f.coordinates("hole")],
      },
    });
    expect(Object.keys(required(result.venue.features[0].tags)).sort()).toEqual(
      ["a11ymap:area_type", "amenity", "indoor", "ref"],
    );
  });

  it("distinguishes three adjacent shafts by unique source containment on non-stop floors too", () => {
    const f = fixture();
    for (const [id, x] of [
      ["lift-a", 20],
      ["lift-b", 40],
      ["lift-c", 60],
    ] as const) {
      f.rectangle(`shaft-${id}`, x - 4, 16, x + 4, 24, {
        indoor: "area",
        "a11ymap:area_type": "elevator-shaft",
        level: "0-2",
        name: "相同電梯名稱",
      });
    }
    f.rectangle("shared-core", 10, 10, 70, 30, {
      indoor: "area",
      "a11ymap:area_type": "vertical-core",
      level: "0",
    });
    const result = f.compile();
    expect(result.errors).toEqual([]);
    for (const id of ["lift-a", "lift-b", "lift-c"]) {
      for (const ordinal of [0, 1, 2]) {
        expect(
          result.venue.features.find(
            (feature) => feature.id === `way/shaft-${id}@${ordinal}`,
          ),
        ).toMatchObject({
          connectionId: `node/${id}`,
          connectionIds: [`node/${id}`],
        });
      }
      expect(result.venue.nodes.some((node) => node.id === `${id}@1`)).toBe(
        false,
      );
      expect(
        result.venue.places.find((place) => place.id === `${id}@1F`),
      ).toMatchObject({
        connectionId: `node/${id}`,
        connectionIds: [`node/${id}`],
      });
    }
    expect(
      result.venue.features.find(
        (feature) => feature.id === "way/shared-core@0",
      ),
    ).toMatchObject({
      tags: { "a11ymap:area_type": "vertical-core" },
      connectionId: null,
      connectionIds: ["node/lift-a", "node/lift-b", "node/lift-c"],
    });
    expect(
      result.venue.edges.find((edge) => edge.osmRef === "node/lift-a"),
    ).toMatchObject({ name: "相同電梯名稱", ref: "lift-a" });
  });

  it("leaves ambiguous, holed and merely named shaft areas unassociated", () => {
    const f = fixture();
    const tags = {
      indoor: "area",
      "a11ymap:area_type": "elevator-shaft",
      level: "0",
    };
    f.rectangle("duplicate-a", 16, 16, 24, 24, tags);
    f.rectangle("duplicate-b", 17, 17, 23, 23, tags);
    f.rectangle("two-lifts", 35, 15, 65, 25, tags);
    f.rectangle("name-only", 75, 15, 85, 25, { ...tags, name: "相同電梯名稱" });
    f.rectangle("outer", 16, 16, 24, 24, {});
    f.rectangle("hole", 19, 19, 21, 21, {});
    f.osm.relations.set("holed-shaft", {
      id: "holed-shaft",
      tags,
      members: [
        { type: "way", ref: "outer", role: "outer" },
        { type: "way", ref: "hole", role: "inner" },
      ],
    });
    const result = f.compile();
    expect(result.errors).toEqual([]);
    expect(
      result.venue.features.every(
        (feature) =>
          feature.connectionId === null && feature.connectionIds?.length === 0,
      ),
    ).toBe(true);
  });

  it("links a stairwell only through same-floor span endpoints and retains source names", () => {
    const f = fixture();
    const low = f.point(20, 50, { level: "0" });
    const high = f.point(25, 55, { level: "1" });
    f.way("stairs", [low, high], {
      highway: "steps",
      indoor: "yes",
      level: "0;1",
      name: "來源樓梯",
      ref: "S1",
      step_count: "12",
    });
    for (const ordinal of [0, 1, 2]) {
      f.rectangle(`stairwell-${ordinal}`, 15, 45, 30, 60, {
        indoor: "area",
        "a11ymap:area_type": "stairwell",
        level: String(ordinal),
      });
    }
    const result = f.compile();
    expect(result.errors).toEqual([]);
    for (const ordinal of [0, 1])
      expect(
        result.venue.features.find(
          (feature) => feature.id === `way/stairwell-${ordinal}@${ordinal}`,
        ),
      ).toMatchObject({
        connectionId: "way/stairs@span",
        connectionIds: ["way/stairs@span"],
      });
    expect(
      result.venue.features.find(
        (feature) => feature.id === "way/stairwell-2@2",
      ),
    ).toMatchObject({ connectionId: null, connectionIds: [] });
    expect(
      result.venue.edges.find((edge) => edge.osmRef === "way/stairs"),
    ).toMatchObject({ name: "來源樓梯", ref: "S1" });
  });

  it("keeps open wall lines, provenance and unknown thickness while respecting publication exclusions", () => {
    const f = fixture();
    f.way("wall", [f.point(10, 70), f.point(10, 80), f.point(20, 80)], {
      indoor: "wall",
      level: "0",
      repeat_on: "1",
      "a11ymap:source": "drawing.png",
      "a11ymap:geometry_status": "traced",
      "a11ymap:height_status": "drawing",
      note: "來源註記",
      fixme: "尺寸待確認",
    });
    f.rectangle("excluded", 200, 0, 300, 100, {
      building: "yes",
      name: "Excluded",
      "a11ymap:id": "excluded",
    });
    f.way("excluded-wall", [f.point(220, 20), f.point(240, 20)], {
      indoor: "wall",
      level: "invalid",
    });
    f.way("crossing-wall", [f.point(150, 50), f.point(350, 50)], {
      indoor: "wall",
      level: "invalid",
    });
    const result = f.compile(["fictional"]);
    expect(result.errors).toEqual([]);
    expect(result.venue.walls).toHaveLength(2);
    expect(result.venue.walls?.map((wall) => wall.ordinal)).toEqual([0, 1]);
    expect(result.venue.walls?.[0]).toMatchObject({
      id: "way/wall@0",
      osmRef: "way/wall",
      buildingId: "fictional",
      ordinal: 0,
      levelRef: "1F",
      thicknessM: null,
      geometry: { type: "LineString", coordinates: f.coordinates("wall") },
      geometryStatus: "traced",
      heightStatus: "drawing",
      source: "drawing.png",
      note: "來源註記",
      fixme: "尺寸待確認",
    });
    expect(result.venue.walls?.[0].geometry.coordinates[0]).not.toEqual(
      result.venue.walls?.[0].geometry.coordinates.at(-1),
    );
    expect(VenueModel.schema.path("walls")).toBeDefined();
  });

  it("uses unique structured room refs and reports corridor arrivals without inventing a door", () => {
    const f = fixture();
    const arrival = f.point(
      80,
      50,
      {
        indoor: "room",
        level: "0",
        ref: "101",
        name: "教室",
        "a11ymap:id": "room",
      },
      "arrival",
    );
    f.way("room-approach", [f.point(70, 50), arrival], {
      highway: "corridor",
      level: "0",
    });
    f.rectangle("room-outline", 75, 55, 85, 65, {
      indoor: "room",
      level: "0",
      ref: "101",
    });
    let result = f.compile();
    expect(result.errors).toEqual([]);
    expect(
      result.venue.places.find((place) => place.id === "room"),
    ).toMatchObject({
      featureId: "way/room-outline@0",
      arrivalKind: "corridor",
      doorKnown: false,
    });
    f.rectangle("duplicate-ref", 75, 70, 85, 80, {
      indoor: "room",
      level: "0",
      ref: "101",
    });
    result = f.compile();
    expect(
      result.venue.places.find((place) => place.id === "room"),
    ).toMatchObject({
      featureId: null,
      arrivalKind: "corridor",
      doorKnown: false,
    });
    required(f.osm.nodes.get(arrival)).tags.ref = "";
    required(f.osm.nodes.get(arrival)).tags.fixme = "door=yes";
    result = f.compile();
    expect(
      result.venue.places.find((place) => place.id === "room"),
    ).toMatchObject({
      featureId: null,
      arrivalKind: "corridor",
      doorKnown: false,
    });
  });

  const negativeOpeningTags: OsmTags[] = [
    { door: "no" },
    { entrance: "no" },
    { door: "no", entrance: "no" },
  ];
  it.each(negativeOpeningTags)(
    "does not compile negative opening tags as a known door: %j",
    (openingTags) => {
      const f = fixture();
      const arrival = f.point(80, 50, {
        indoor: "room",
        level: "0",
        "a11ymap:id": "room",
        ...openingTags,
      });
      f.way("room-approach", [f.point(70, 50), arrival], {
        highway: "corridor",
        level: "0",
      });
      const result = f.compile();
      expect(result.errors).toEqual([]);
      expect(
        result.venue.nodes.find((node) => node.id === `${arrival}@0`),
      ).toMatchObject({ kind: "place" });
      expect(
        result.venue.features.some(
          (feature) => feature.osmRef === `node/${arrival}`,
        ),
      ).toBe(false);
      expect(
        result.venue.places.find((place) => place.id === "room"),
      ).toMatchObject({
        kind: "room",
        arrivalKind: "corridor",
        doorKnown: false,
      });
    },
  );

  it("can link an explicitly shared source door to its room without a ref", () => {
    const f = fixture();
    const door = f.point(80, 50, {
      indoor: "room",
      level: "0",
      door: "hinged",
      "a11ymap:id": "room",
    });
    f.way("door-approach", [f.point(70, 50), door], {
      highway: "corridor",
      level: "0",
    });
    const ring = [
      door,
      f.point(85, 50),
      f.point(85, 60),
      f.point(80, 60),
      door,
    ];
    f.way("room-outline", ring, { indoor: "room", level: "0" });
    const result = f.compile();
    expect(result.errors).toEqual([]);
    expect(
      result.venue.nodes.find((node) => node.id === `${door}@0`),
    ).toMatchObject({ kind: "door" });
    expect(
      result.venue.features.find((feature) => feature.id === `node/${door}@0`),
    ).toMatchObject({ kind: "door" });
    expect(
      result.venue.places.find((place) => place.id === "room"),
    ).toMatchObject({
      featureId: "way/room-outline@0",
      arrivalKind: "door",
      doorKnown: true,
    });
  });

  it("omits absent allowlist tags and never treats a feature match as a usable landing", () => {
    const f = fixture();
    const door = f.point(80, 50, { door: "hinged", level: "0" });
    f.way("door-path", [f.point(70, 50), door], {
      highway: "corridor",
      level: "0",
    });
    f.rectangle("shaft", 16, 16, 24, 24, {
      indoor: "area",
      "a11ymap:area_type": "elevator-shaft",
      ref: "L1",
      level: "0-2",
    });
    const arrival = f.point(20, 30, {
      level: "1",
      ref: "L1",
      "a11ymap:id": "non-stop-place",
    });
    f.way("non-stop-approach", [f.point(10, 30), arrival], {
      highway: "corridor",
      level: "1",
    });
    const result = f.compile();
    expect(result.errors).toEqual([]);
    expect(
      result.venue.features.find((feature) => feature.id === `node/${door}@0`),
    ).not.toHaveProperty("tags");
    expect(
      result.venue.places.find((place) => place.id === "non-stop-place"),
    ).toMatchObject({
      featureId: "way/shaft@1",
      connectionId: null,
      connectionIds: [],
      arrivalKind: "corridor",
      doorKnown: false,
    });
  });

  it("preserves the old fixture's rooms, graph coordinates and repeated refs", () => {
    const osm = parseOsmXml(
      readFileSync(
        path.join(__dirname, "__fixtures__/mini-campus.osm"),
        "utf8",
      ),
    );
    const result = compileVenue(osm, { venueId: "mini", name: "Mini" });
    expect(result.errors).toEqual([]);
    const room = required(
      result.venue.features.find((feature) => feature.id === "way/-110@2"),
    );
    expect(room).toMatchObject({
      ref: "306",
      tags: { indoor: "room", ref: "306" },
    });
    expect(room.geometry).toEqual({
      type: "Polygon",
      coordinates: [
        required(osm.ways.get("-110")).nodeIds.map((id) => [
          required(osm.nodes.get(id)).lon,
          required(osm.nodes.get(id)).lat,
        ]),
      ],
    });
    expect(
      result.venue.places.find((place) => place.id === "a-room06@3F"),
    ).toMatchObject({
      featureId: "way/-110@2",
      arrivalKind: "corridor",
      doorKnown: false,
    });
    expect(
      result.venue.nodes.find((node) => node.id === "-15@2"),
    ).toMatchObject({
      lng: required(osm.nodes.get("-15")).lon,
      lat: required(osm.nodes.get("-15")).lat,
      z: 7.2,
    });
  });
});
