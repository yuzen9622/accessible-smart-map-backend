import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import { buildVenueGraph } from "./venue.graph";
import { planVenueRoute } from "./venue.route";

const XML = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
);
const options = { venueId: "mini", name: "Mini", buildingIds: ["bldg-a"] };
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Required fictional fixture element missing");
  return value;
}
const config = {
  stairsAvoidanceMultiplier: 4,
  elevatorWaitS: 30,
  elevatorPerFloorS: 3,
};

describe("scoped venue publication", () => {
  it("skips unfinished buildings before validation and removes their navigation and display data", () => {
    const osm = parseOsmXml(XML);
    const b = required(
      [...osm.ways.values()].find((w) => w.tags["a11ymap:id"] === "bldg-b"),
    );
    delete b.tags["building:levels"];
    required(osm.nodes.get("-36")).tags["a11ymap:ele"] = "invalid";
    required(osm.nodes.get("-36")).tags.highway = "elevator";
    required(osm.nodes.get("-36")).tags.level = "invalid";
    expect(
      compileVenue(osm, { venueId: "mini", name: "Mini" }).errors.length,
    ).toBeGreaterThan(0);
    const result = compileVenue(osm, options);
    expect(result.errors).toEqual([]);
    expect(result.venue.buildings.map((x) => x.id)).toEqual(["bldg-a"]);
    expect(result.venue.nodes.some((n) => n.id.startsWith("-36@"))).toBe(false);
    expect(
      result.venue.places.some(
        (p) => p.id === "b-lab" || p.buildingId === "bldg-b",
      ),
    ).toBe(false);
    expect(result.venue.features.some((f) => f.buildingId === "bldg-b")).toBe(
      false,
    );
    expect(result.venue.edges.some((e) => e.osmRef === "way/-201")).toBe(false);
    expect(required(osm.nodes.get("-36")).tags.level).toBe("invalid");
    const g = buildVenueGraph(result.venue, 1, config);
    const at = (id: string) =>
      required(result.venue.places.find((p) => p.id === id));
    expect(
      planVenueRoute(
        g,
        result.venue,
        at("gate-main"),
        at("a-room06@3F"),
        "wheelchair",
        config,
        "zh-TW",
      ).ok,
    ).toBe(true);
  });
  it("removes a long outdoor segment that crosses an excluded building away from its midpoint", () => {
    const extra = `<node id='-990' lat='24.15040' lon='120.67990'/><node id='-991' lat='24.15040' lon='120.68200'/><way id='-992'><nd ref='-990'/><nd ref='-991'/><tag k='highway' v='footway'/></way>`;
    const r = compileVenue(
      parseOsmXml(XML.replace("</osm>", extra + "</osm>")),
      options,
    );
    expect(r.errors).toEqual([]);
    expect(r.venue.edges.some((e) => e.osmRef === "way/-992")).toBe(false);
  });
  it("keeps an included building and its shared outline nodes when excluded geometry overlaps", () => {
    const osm = parseOsmXml(XML);
    const a = required(
      [...osm.ways.values()].find((w) => w.tags["a11ymap:id"] === "bldg-a"),
    );
    osm.ways.set("-999", {
      ...a,
      id: "-999",
      nodeIds: [...a.nodeIds],
      tags: { building: "yes", name: "Background", "a11ymap:id": "background" },
    });
    const r = compileVenue(osm, {
      ...options,
      buildingIds: ["bldg-a", "bldg-b"],
    });
    expect(r.errors).toEqual([]);
    expect(r.venue.places.some((p) => p.id === "a-room06@3F")).toBe(true);
    expect(r.venue.nodes.some((n) => n.id === "-5@0")).toBe(true);
  });
  it("rejects empty, duplicate, malformed and unknown building selections", () => {
    for (const buildingIds of [
      [],
      ["bldg-a", "bldg-a"],
      ["bad id"],
      ["missing"],
    ]) {
      expect(
        compileVenue(parseOsmXml(XML), { ...options, buildingIds }).errors
          .length,
      ).toBeGreaterThan(0);
    }
  });
  it("skips fully excluded nested relations, while still validating mixed or unknown members", () => {
    const osm = parseOsmXml(XML);
    osm.relations.set("-990", {
      id: "-990",
      tags: { type: "multipolygon", indoor: "room" },
      members: [{ type: "way", ref: "-201", role: "outer" }],
    });
    osm.relations.set("-991", {
      id: "-991",
      tags: { "a11ymap:id": "excluded-room" },
      members: [
        { type: "relation", ref: "-990", role: "" },
        { type: "node", ref: "-36", role: "" },
      ],
    });
    expect(compileVenue(osm, options).errors).toEqual([]);
    osm.relations
      .get("-991")
      ?.members.push({ type: "node", ref: "-11", role: "" });
    expect(
      compileVenue(osm, options).errors.some((e) =>
        e.includes("excluded-room"),
      ),
    ).toBe(true);
    osm.relations.get("-991")?.members.pop();
    osm.relations
      .get("-991")
      ?.members.push({ type: "relation", ref: "missing", role: "" });
    expect(
      compileVenue(osm, options).errors.some((e) =>
        e.includes("excluded-room"),
      ),
    ).toBe(true);
  });
  it("preserves height and access qualifications from the source", () => {
    const osm = parseOsmXml(XML);
    const building = required(
      [...osm.ways.values()].find((w) => w.tags["a11ymap:id"] === "bldg-a"),
    );
    building.tags.note = "Floor layout is a drawing";
    const lift = required(osm.nodes.get("-11"));
    lift.tags.fixme = "Verify served floors on site";
    const ramp = required(osm.ways.get("-302"));
    ramp.tags["a11ymap:height_pending"] = "yes";
    ramp.tags.note = "Height not measured";
    const r = compileVenue(osm, { venueId: "mini", name: "Mini" });
    expect(r.errors).toEqual([]);
    expect(r.venue.buildings.find((b) => b.id === "bldg-a")?.note).toBe(
      "Floor layout is a drawing",
    );
    expect(r.venue.edges.find((e) => e.kind === "elevator")?.fixme).toBe(
      "Verify served floors on site",
    );
    expect(r.venue.edges.find((e) => e.osmRef === "way/-302")).toMatchObject({
      heightPending: true,
      note: "Height not measured",
    });
  });
});
