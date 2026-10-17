import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileVenue } from "./venue.compile";
import { venueConnections } from "./venue.connections";
import { parseOsmXml } from "./venue-osm.parse";

const { venue } = compileVenue(
  parseOsmXml(
    readFileSync(path.join(__dirname, "__fixtures__/mini-campus.osm"), "utf8"),
  ),
  { venueId: "mini", name: "Mini Campus" },
);
const connections = venueConnections(venue);
const byId = (id: string) => connections.find((c) => c.id === id);

describe("venueConnections", () => {
  it("lists every stairs, steps, ramp and elevator once", () => {
    expect(connections.map((c) => [c.id, c.kind]).sort()).toEqual(
      [
        ["node/-11", "elevator"],
        ["way/-108@span", "stairs"],
        ["way/-109@span", "stairs"],
        ["way/-205@span", "stairs"],
        ["way/-302@0", "ramp"],
        ["way/-305@0", "steps"],
      ].sort(),
    );
  });

  it("gives stairs their floor heights at both ends", () => {
    expect(byId("way/-108@span")).toMatchObject({
      buildingId: "bldg-a",
      levelRefs: ["1F", "2F"],
      stepCount: 20,
      wheelchair: "no",
    });
    expect(byId("way/-108@span")?.coordinates.map((c) => c[2])).toEqual([
      0, 3.6,
    ]);
  });

  it("gives the ramp its grade and the tagged height of its top", () => {
    const ramp = byId("way/-302@0");
    expect(ramp?.slopeRatio).toBeCloseTo(0.08);
    expect(ramp?.coordinates.map((c) => c[2])).toEqual([0, 1]);
    expect(ramp?.levelRefs).toEqual([null, null]);
  });

  it("gives the elevator one point per stop, bottom to top", () => {
    expect(byId("node/-11")).toMatchObject({
      buildingId: "bldg-a",
      levelRefs: ["1F", "2F", "3F"],
      wheelchair: "yes",
    });
    expect(byId("node/-11")?.coordinates.map((c) => c[2])).toEqual([
      0, 3.6, 7.2,
    ]);
  });

  it("aggregates pending heights and distinct notes without certifying stop floors", () => {
    const data = structuredClone(venue);
    const elevatorEdges = data.edges.filter((edge) => edge.kind === "elevator");
    elevatorEdges.forEach((edge, index) => {
      edge.heightPending = index === 0;
      edge.note = index === 0 ? "停靠樓層仍待現場核實" : "高度參考圖面";
      edge.fixme = "現場確認停靠表";
    });
    const elevator = venueConnections(data).find(
      (connection) => connection.kind === "elevator",
    );
    expect(elevator).toMatchObject({
      heightPending: true,
      note: "停靠樓層仍待現場核實\n高度參考圖面",
      fixme: "現場確認停靠表",
      levelRefs: ["1F", "2F", "3F"],
    });
  });
});
