import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import { venueBuildings, venueWalkways } from "./venue.presentation";
import type { VenueData } from "./venue.types";

const { venue } = compileVenue(
  parseOsmXml(
    readFileSync(path.join(__dirname, "__fixtures__/mini-campus.osm"), "utf8"),
  ),
  { venueId: "mini", name: "Mini" },
);
const copy = (): VenueData => structuredClone(venue);

describe("venueWalkways", () => {
  it("projects ordinary indoor and outdoor graph edges without vertical connections or ramps", () => {
    const walkways = venueWalkways(venue);
    const expected = venue.edges.filter(
      (edge) =>
        !edge.ramp && !["steps", "escalator", "elevator"].includes(edge.kind),
    );
    expect(walkways.map((way) => way.id)).toEqual(
      expected.map((edge) => edge.id),
    );
    expect(
      walkways.some(
        (way) => way.kind === "corridor" && way.buildingId === "bldg-a",
      ),
    ).toBe(true);
    expect(walkways.some((way) => !way.indoor && way.kind === "footway")).toBe(
      true,
    );
    expect(walkways.every((way) => way.coordinates.length === 2)).toBe(true);
    const doorBoundary = walkways.find(
      (way) =>
        way.buildingIds.includes(null) && way.buildingIds.includes("bldg-a"),
    );
    expect(doorBoundary).toMatchObject({ buildingId: null, levelRef: null });
    expect(doorBoundary?.levelRefs).toContain("1F");
    expect(doorBoundary?.levelRefs).toContain(null);
  });

  it("retains both buildings at a same-floor skybridge and all source annotations", () => {
    const data = copy();
    const a = data.nodes.find(
      (node) => node.buildingId === "bldg-a" && node.ordinal === 1,
    );
    const b = data.nodes.find(
      (node) => node.buildingId === "bldg-b" && node.ordinal === 1,
    );
    if (!a || !b) throw new Error("fixture lacks second-floor nodes");
    data.edges.push({
      ...data.edges[0],
      id: "skybridge",
      from: a.id,
      to: b.id,
      kind: "corridor",
      ramp: false,
      geometryStatus: "schematic",
      heightStatus: "drawing",
      source: "drawing-a",
      heightPending: true,
      note: "停靠樓層仍待現場核實",
      fixme: "補量高度",
      wheelchair: "limited",
    });
    expect(venueWalkways(data).find((way) => way.id === "skybridge")).toEqual({
      id: "skybridge",
      kind: "corridor",
      indoor: data.edges[0].indoor,
      coordinates: [
        [a.lng, a.lat, a.z],
        [b.lng, b.lat, b.z],
      ],
      buildingId: null,
      levelRef: null,
      buildingIds: ["bldg-a", "bldg-b"],
      levelRefs: ["2F", "2F"],
      wheelchair: "limited",
      geometryStatus: "schematic",
      heightStatus: "drawing",
      source: "drawing-a",
      heightPending: true,
      note: "停靠樓層仍待現場核實",
      fixme: "補量高度",
      osmRef: data.edges[0].osmRef,
    });
  });

  it("reads old stored edges without new annotations and uses conservative status defaults", () => {
    const data = copy();
    const edge = data.edges.find((candidate) => candidate.kind === "corridor");
    if (!edge) throw new Error("fixture lacks a corridor");
    Reflect.deleteProperty(edge, "geometryStatus");
    Reflect.deleteProperty(edge, "heightStatus");
    const projected = venueWalkways(data).find((way) => way.id === edge.id);
    expect(projected).toMatchObject({
      geometryStatus: "traced",
      heightStatus: "estimated",
    });
    expect(projected).not.toHaveProperty("heightPending");
    expect(projected).not.toHaveProperty("note");
  });
});

describe("venueBuildings coverage", () => {
  it("marks authored anchor, incident route data and display geometry independently", () => {
    const data = copy();
    const building = data.buildings.find(
      (candidate) => candidate.id === "bldg-a",
    );
    if (!building) throw new Error("fixture lacks building A");
    building.levels.push(
      { ordinal: 3, ref: "4F", elevationM: 10.8 },
      { ordinal: 4, ref: "5F", elevationM: 14.4 },
      { ordinal: 5, ref: "6F", elevationM: 18 },
      { ordinal: 6, ref: "7F", elevationM: 21.6 },
    );
    const node = data.nodes.find(
      (candidate) => candidate.buildingId === building.id,
    );
    if (!node) throw new Error("fixture lacks a building A node");
    data.nodes.push({ ...node, id: "anchor-only", ordinal: 4, z: 14.4 });
    data.places.push({
      id: "bldg-a@5F",
      name: "5F",
      kind: "anchor",
      buildingId: building.id,
      levelRef: "5F",
      nodeId: "anchor-only",
      location: [node.lng, node.lat],
    });
    data.features.push({
      ...data.features[0],
      id: "display-only",
      buildingId: building.id,
      ordinal: 5,
      levelRef: "6F",
    });
    data.nodes.push({ ...node, id: "route-only", ordinal: 6, z: 21.6 });
    data.edges.push({
      ...data.edges[0],
      id: "incident-only",
      from: node.id,
      to: "route-only",
    });
    const projected = venueBuildings(data).find(
      (candidate) => candidate.id === building.id,
    );
    if (!projected) throw new Error("projection lacks building A");
    expect(
      projected.levels.find((level) => level.ref === "3F")?.coverage,
    ).toEqual({
      hasAnchor: true,
      hasRouteData: true,
      hasDisplayGeometry: true,
    });
    expect(
      projected.levels.find((level) => level.ref === "4F")?.coverage,
    ).toEqual({
      hasAnchor: false,
      hasRouteData: false,
      hasDisplayGeometry: false,
    });
    expect(
      projected.levels.find((level) => level.ref === "5F")?.coverage,
    ).toEqual({
      hasAnchor: true,
      hasRouteData: false,
      hasDisplayGeometry: false,
    });
    expect(
      projected.levels.find((level) => level.ref === "6F")?.coverage,
    ).toEqual({
      hasAnchor: false,
      hasRouteData: false,
      hasDisplayGeometry: true,
    });
    expect(
      projected.levels.find((level) => level.ref === "7F")?.coverage,
    ).toEqual({
      hasAnchor: false,
      hasRouteData: true,
      hasDisplayGeometry: false,
    });
    expect(building.levels.every((level) => !("coverage" in level))).toBe(true);
  });

  it("does not borrow an anchor, graph node or feature from another building or floor", () => {
    const data = copy();
    const building = data.buildings[0];
    building.levels.push({ ordinal: 7, ref: "8F", elevationM: 25.2 });
    data.places.push({
      ...data.places[0],
      kind: "anchor",
      buildingId: "bldg-b",
      levelRef: "8F",
    });
    data.features.push({
      ...data.features[0],
      buildingId: building.id,
      ordinal: 6,
      levelRef: "8F",
    });
    expect(
      venueBuildings(data)[0].levels.find((level) => level.ref === "8F")
        ?.coverage,
    ).toEqual({
      hasAnchor: false,
      hasRouteData: false,
      hasDisplayGeometry: false,
    });
  });
});
