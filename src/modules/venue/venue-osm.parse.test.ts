import { describe, expect, it } from "vitest";
import { parseOsmXml } from "./venue-osm.parse";

describe("parseOsmXml", () => {
  it("reads nodes, ways and relations with tags in either quote style", () => {
    const osm = parseOsmXml(`<?xml version='1.0'?>
<osm version='0.6'>
  <node id='-1' lat='24.15' lon='120.68'><tag k='name' v='A &amp; B &#x6821;' /></node>
  <node id="-2" lat="24.16" lon="120.69"/>
  <way id='-10'><nd ref='-1'/><nd ref='-2'/><tag k="highway" v="footway"/></way>
  <relation id='-20'><member type='way' ref='-10' role='outer'/><tag k='type' v='multipolygon'/></relation>
</osm>`);
    expect(osm.nodes.get("-1")).toEqual({
      id: "-1",
      lat: 24.15,
      lon: 120.68,
      tags: { name: "A & B 校" },
    });
    expect(osm.nodes.get("-2")?.tags).toEqual({});
    expect(osm.ways.get("-10")).toEqual({
      id: "-10",
      nodeIds: ["-1", "-2"],
      tags: { highway: "footway" },
    });
    expect(osm.relations.get("-20")?.members).toEqual([
      { type: "way", ref: "-10", role: "outer" },
    ]);
  });

  it("drops elements JOSM marked deleted or invisible", () => {
    const osm = parseOsmXml(`<osm>
  <node id='1' action='delete' lat='24' lon='120'/>
  <node id='2' visible='false' lat='24' lon='120'><tag k='a' v='b'/></node>
  <way id='3' action='delete'><nd ref='1'/></way>
  <node id='4' action='modify' lat='24' lon='120'/>
</osm>`);
    expect([...osm.nodes.keys()]).toEqual(["4"]);
    expect(osm.ways.size).toBe(0);
  });

  it("rejects a node without coordinates and a child outside its parent", () => {
    expect(() =>
      parseOsmXml("<osm><node id='1' lat='x' lon='120'/></osm>"),
    ).toThrow("node 1");
    expect(() => parseOsmXml("<osm><nd ref='1'/></osm>")).toThrow(
      "<nd> outside a way",
    );
  });
});
