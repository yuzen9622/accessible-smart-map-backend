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
      nodeIds: ["-16@0", "-17@1"],
      name: null,
      ref: null,
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

  it("keeps source node IDs ordered with each coordinate and elevator stop", () => {
    const sourceNodes = new Map(venue.nodes.map((node) => [node.id, node]));
    for (const connection of connections) {
      expect(connection.nodeIds).toHaveLength(connection.coordinates.length);
      expect(connection.nodeIds).toHaveLength(connection.levelRefs.length);
      expect(
        connection.nodeIds.map((id) => {
          const node = sourceNodes.get(id);
          if (!node) throw new Error(`unknown source node ${id}`);
          return [node.lng, node.lat, Math.round(node.z * 100) / 100];
        }),
      ).toEqual(connection.coordinates);
    }
    expect(byId("node/-11")?.nodeIds).toEqual(["-11@0", "-11@1", "-11@2"]);
  });

  it("returns only explicit feature links for separate shafts with the same name and position", () => {
    const data = structuredClone(venue);
    const firstId = "node/-11";
    const secondId = "node/-999";
    const elevatorEdges = data.edges.filter((edge) => edge.kind === "elevator");
    const elevatorNodeIds = [
      ...new Set(elevatorEdges.flatMap((edge) => [edge.from, edge.to])),
    ];
    for (const node of data.nodes.filter((node) =>
      elevatorNodeIds.includes(node.id),
    )) {
      data.nodes.push({ ...node, id: `${node.id}-parallel` });
    }
    data.edges.push(
      ...elevatorEdges.map((edge) => ({
        ...edge,
        id: `${edge.id}-parallel`,
        from: `${edge.from}-parallel`,
        to: `${edge.to}-parallel`,
        osmRef: secondId,
        name: "共用電梯",
        ref: "B",
      })),
    );
    elevatorEdges.forEach((edge) => {
      edge.name = "共用電梯";
      edge.ref = "A";
    });
    const feature = structuredClone(data.features[0]);
    delete feature.connectionId;
    delete feature.connectionIds;
    data.features = [
      { ...feature, id: "shaft-a", name: "共用電梯", connectionIds: [firstId] },
      { ...feature, id: "shaft-b", name: "共用電梯", connectionId: secondId },
      { ...feature, id: "unlinked", name: "共用電梯" },
      {
        ...feature,
        id: "shared-core",
        connectionId: firstId,
        connectionIds: [firstId, secondId],
      },
      {
        ...feature,
        id: "non-stop-shaft-boundary",
        ordinal: 3,
        levelRef: "4F",
        connectionId: firstId,
      },
    ];
    const projected = venueConnections(data);
    expect(
      projected.find((connection) => connection.id === firstId),
    ).toMatchObject({
      name: "共用電梯",
      ref: "A",
      featureIds: ["shaft-a", "shared-core", "non-stop-shaft-boundary"],
      nodeIds: ["-11@0", "-11@1", "-11@2"],
      levelRefs: ["1F", "2F", "3F"],
    });
    expect(
      projected.find((connection) => connection.id === secondId),
    ).toMatchObject({
      name: "共用電梯",
      ref: "B",
      featureIds: ["shaft-b", "shared-core"],
      nodeIds: ["-11@0-parallel", "-11@1-parallel", "-11@2-parallel"],
    });
    expect(
      data.features.find(
        (candidate) => candidate.id === "non-stop-shaft-boundary",
      ),
    ).toMatchObject({ ordinal: 3, levelRef: "4F" });
  });

  it("keeps inferred route slopes outside the authored display connection set", () => {
    const data = structuredClone(venue);
    const levelWalk = data.edges.find((edge) => edge.kind === "corridor");
    if (!levelWalk) throw new Error("fixture lacks a corridor");
    levelWalk.slopeRatio = 0.08;
    levelWalk.ramp = false;
    expect(venueConnections(data).map((connection) => connection.id)).toEqual(
      connections.map((connection) => connection.id),
    );
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
