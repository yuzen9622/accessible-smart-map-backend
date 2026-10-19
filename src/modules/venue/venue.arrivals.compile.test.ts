import { describe, expect, it } from "vitest";
import { compileVenue } from "./venue.compile";
import { venueConnections } from "./venue.connections";
import type { OsmData, OsmTags } from "./venue-osm.parse";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fictional source is absent");
  return value;
}

/** Fictional geometry deliberately unrelated to any published campus. */
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
    way(id, [...corners, corners[0]], tags);
  };
  rectangle("building", 0, 0, 100, 100, {
    building: "yes",
    name: "Fictional",
    "a11ymap:id": "fictional",
    "building:levels": "3",
  });
  point(20, 20, { highway: "elevator", level: "0;2" }, "lift");
  way("lift-approach", [point(10, 20), "lift"], {
    highway: "corridor",
    level: "0",
    repeat_on: "2",
  });
  point(30, 30, { level: "0" }, "landing0");
  point(30, 35, { level: "1" }, "landing1");
  way("stairs", ["landing0", "landing1"], {
    highway: "steps",
    level: "0;1",
    indoor: "yes",
  });
  way("stair-approach0", [point(35, 30), "landing0"], {
    highway: "corridor",
    level: "0",
  });
  way("stair-approach1", [point(35, 35), "landing1"], {
    highway: "corridor",
    level: "1",
  });
  const compile = () =>
    compileVenue(osm, { venueId: "fictional", name: "Fictional" });
  return { osm, point, way, rectangle, compile };
}

describe("source-backed selectable feature arrivals", () => {
  it("turns a mixed vertical core into one destination with its real landing alternatives, without changing the graph", () => {
    const f = fixture();
    const before = f.compile().venue;
    f.rectangle("core-c", 15, 15, 32, 38, {
      indoor: "area",
      "a11ymap:area_type": "vertical-core",
      name: "電梯／樓梯核心 C",
      level: "0-2",
    });
    const { venue, errors } = f.compile();
    expect(errors).toEqual([]);
    expect(venue.nodes).toEqual(before.nodes);
    expect(venue.edges).toEqual(before.edges);
    expect(
      venue.places.filter((place) => place.featureId === "way/core-c@0"),
    ).toEqual([
      expect.objectContaining({
        id: "arrival:way/core-c@0",
        nodeId: "landing0@0",
        arrivalNodeIds: ["landing0@0", "lift@0"],
        arrivalKind: "corridor",
        doorKnown: false,
      }),
    ]);
    expect(
      venue.features.find((feature) => feature.id === "way/core-c@0")
        ?.connectionIds,
    ).toEqual(["node/lift", "way/stairs@span"]);
    expect(
      venueConnections(venue).find(
        (connection) => connection.id === "node/lift",
      )?.featureIds,
    ).toContain("way/core-c@0");
    expect(
      venue.places.find((place) => place.featureId === "way/core-c@1")?.nodeId,
    ).toBe("landing1@1");
    expect(
      venue.places.find((place) => place.featureId === "way/core-c@2")?.nodeId,
    ).toBe("lift@2");
  });

  it("does not manufacture elevator stops, select another facility kind, or use a landing without an ordinary floor approach", () => {
    const f = fixture();
    f.rectangle("shaft", 15, 15, 25, 25, {
      indoor: "area",
      "a11ymap:area_type": "elevator-shaft",
      level: "0-2",
    });
    f.rectangle("wrong-stairwell", 15, 15, 25, 25, {
      indoor: "area",
      "a11ymap:area_type": "stairwell",
      level: "0-2",
    });
    const { venue } = f.compile();
    expect(
      venue.places.some((place) => place.featureId === "way/shaft@0"),
    ).toBe(true);
    expect(
      venue.places.some((place) => place.featureId === "way/shaft@1"),
    ).toBe(false);
    expect(
      venue.places.some((place) =>
        place.featureId?.startsWith("way/wrong-stairwell@"),
      ),
    ).toBe(false);
    f.osm.ways.delete("stair-approach1");
    f.rectangle("stairs-without-approach", 25, 25, 34, 40, {
      indoor: "area",
      "a11ymap:area_type": "stairwell",
      level: "1",
    });
    expect(
      f
        .compile()
        .venue.places.some(
          (place) => place.featureId === "way/stairs-without-approach@1",
        ),
    ).toBe(false);
  });

  it("rejects ambiguous overlapping cores, polygon holes and a different floor", () => {
    const f = fixture();
    const tags = {
      indoor: "area",
      "a11ymap:area_type": "vertical-core",
      level: "0",
    };
    f.rectangle("core-a", 15, 15, 25, 25, tags);
    f.rectangle("core-b", 15, 15, 25, 25, tags);
    expect(f.compile().venue.places).toEqual([]);
    f.osm.ways.delete("core-b");
    f.rectangle("hole", 18, 18, 22, 22, {});
    f.osm.relations.set("holed-core", {
      id: "holed-core",
      members: [
        { type: "way", ref: "core-a", role: "outer" },
        { type: "way", ref: "hole", role: "inner" },
      ],
      tags: { ...tags, type: "multipolygon" },
    });
    required(f.osm.ways.get("core-a")).tags = {};
    expect(f.compile().venue.places).toEqual([]);
    f.osm.relations.delete("holed-core");
    required(f.osm.ways.get("core-a")).tags = { ...tags, level: "1" };
    expect(f.compile().venue.places).toEqual([]);
  });

  it("accepts a deliberate corridor arrival outside its room polygon and keeps one stable feature destination", () => {
    const f = fixture();
    f.rectangle("room", 50, 50, 60, 60, {
      indoor: "room",
      level: "0",
      "a11ymap:arrival_node": "landing0",
    });
    const { venue, errors } = f.compile();
    expect(errors).toEqual([]);
    expect(venue.places).toEqual([
      expect.objectContaining({
        id: "arrival:way/room@0",
        name: "未標房號空間",
        kind: "room",
        featureId: "way/room@0",
        nodeId: "landing0@0",
        arrivalKind: "corridor",
        doorKnown: false,
      }),
    ]);
    required(f.osm.nodes.get("landing0")).tags = {
      level: "0",
      "a11ymap:id": "existing",
      indoor: "room",
      ref: "101",
    };
    required(f.osm.ways.get("room")).tags.ref = "101";
    expect(
      f
        .compile()
        .venue.places.filter((place) => place.featureId === "way/room@0")
        .map((place) => place.id),
    ).toEqual(["existing"]);
  });

  it.each(["missing", "lift@0", "landing1", "unconnected", "outside"])(
    "fails compilation for invalid explicit arrival %s",
    (sourceId) => {
      const f = fixture();
      f.point(70, 70, { level: "0" }, "unconnected");
      f.point(120, 120, { level: "0" }, "outside");
      f.way("outside-path", ["outside", f.point(125, 125)], {
        highway: "footway",
        level: "0",
      });
      f.rectangle("room", 50, 50, 60, 60, {
        indoor: "room",
        level: "0",
        "a11ymap:arrival_node": sourceId,
      });
      const result = f.compile();
      expect(
        result.errors.some((error) => error.includes("a11ymap:arrival_node")),
      ).toBe(true);
      expect(
        result.venue.places.some((place) => place.featureId === "way/room@0"),
      ).toBe(false);
    },
  );
  it("rejects an explicit shaft arrival on a non-stop floor even when that corridor node exists", () => {
    const f = fixture();
    const arrival = f.point(20, 20, { level: "1" }, "not-a-stop");
    f.way("non-stop-corridor", [f.point(10, 20), arrival], {
      highway: "corridor",
      level: "1",
    });
    f.rectangle("shaft", 15, 15, 25, 25, {
      indoor: "area",
      "a11ymap:area_type": "elevator-shaft",
      level: "1",
      "a11ymap:arrival_node": arrival,
    });
    const result = f.compile();
    expect(
      result.errors.some((error) => error.includes("a11ymap:arrival_node")),
    ).toBe(true);
    expect(
      result.venue.places.some((place) => place.featureId === "way/shaft@1"),
    ).toBe(false);
    expect(result.venue.nodes.some((node) => node.id === "lift@1")).toBe(false);
  });

  it("supports a source-authored door and multipolygon facility without guessing its geometry", () => {
    const f = fixture();
    const source = f.osm.nodes.get("landing0");
    if (!source) throw new Error("Fictional landing is absent");
    source.tags.door = "hinged";
    f.rectangle("toilet-outer", 50, 50, 60, 60, {});
    f.osm.relations.set("toilets", {
      id: "toilets",
      members: [{ type: "way", ref: "toilet-outer", role: "outer" }],
      tags: {
        type: "multipolygon",
        indoor: "area",
        amenity: "toilets",
        level: "0",
        "a11ymap:arrival_node": "landing0",
      },
    });
    const result = f.compile();
    expect(result.errors).toEqual([]);
    expect(
      result.venue.places.find(
        (place) => place.featureId === "relation/toilets@0",
      ),
    ).toMatchObject({
      id: "arrival:relation/toilets@0",
      kind: "amenity",
      name: "廁所",
      nodeId: "landing0@0",
      arrivalKind: "door",
      doorKnown: true,
    });
  });

  it("carries a toilet's wheelchair tag to its feature and arrival place only when tagged", () => {
    const f = fixture();
    f.rectangle("toilet-accessible", 50, 50, 60, 60, {
      indoor: "area",
      amenity: "toilets",
      wheelchair: "yes",
      level: "0",
      "a11ymap:arrival_node": "landing0",
    });
    f.rectangle("toilet-untagged", 70, 50, 80, 60, {
      indoor: "area",
      amenity: "toilets",
      level: "0",
      "a11ymap:arrival_node": "landing0",
    });
    const { venue, errors } = f.compile();
    expect(errors).toEqual([]);
    const byFeature = (id: string) => ({
      feature: venue.features.find((x) => x.id === id),
      place: venue.places.find((x) => x.featureId === id),
    });
    const tagged = byFeature("way/toilet-accessible@0");
    expect(tagged.feature?.tags?.wheelchair).toBe("yes");
    expect(tagged.place?.wheelchair).toBe("yes");
    const untagged = byFeature("way/toilet-untagged@0");
    expect(untagged.feature?.tags).not.toHaveProperty("wheelchair");
    expect(untagged.place).not.toHaveProperty("wheelchair");
  });

  it("carries a toilet node place's wheelchair tag only when tagged", () => {
    const f = fixture();
    f.way(
      "toilet-approach",
      [
        f.point(40, 30, { level: "0" }),
        f.point(45, 30, {
          level: "0",
          amenity: "toilets",
          wheelchair: "no",
          "a11ymap:id": "wc-a",
          name: "廁所 A",
        }),
        f.point(50, 30, {
          level: "0",
          amenity: "toilets",
          "a11ymap:id": "wc-b",
          name: "廁所 B",
        }),
      ],
      { highway: "corridor", level: "0" },
    );
    const { venue, errors } = f.compile();
    expect(errors).toEqual([]);
    expect(venue.places.find((x) => x.id === "wc-a")?.wheelchair).toBe("no");
    expect(venue.places.find((x) => x.id === "wc-b")).not.toHaveProperty(
      "wheelchair",
    );
  });
});
