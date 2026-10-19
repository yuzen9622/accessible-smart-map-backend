import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EDGE_FLAG,
  EDGE_TYPE,
  NODE_FLAG,
  WHEELCHAIR,
} from "../accessible-route/planners/pedestrian-a11y/graph.types";
import { edgeCost } from "../accessible-route/planners/pedestrian-a11y/cost";
import { compileVenue } from "./venue.compile";
import { buildVenueGraph } from "./venue.graph";
import { parseOsmXml } from "./venue-osm.parse";
import { venueProfileFor } from "./venue.route";

const FIXTURE = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
);
const CONFIG = { elevatorWaitS: 30, elevatorPerFloorS: 3 };
const build = (xml = FIXTURE) => {
  const { venue } = compileVenue(parseOsmXml(xml), {
    venueId: "mini",
    name: "Mini Campus",
  });
  return buildVenueGraph(venue, 3, CONFIG);
};
/** Directed attributes built from the edges of one OSM way. */
const attrsOf = (vg: ReturnType<typeof build>, osmRef: string) =>
  vg.edgeOfAttr.flatMap((e, attr) => (e.osmRef === osmRef ? [attr] : []));

describe("buildVenueGraph", () => {
  it("stores every venue edge as two directed attributes", () => {
    const vg = build();
    expect(vg.graph.directedEdgeCount).toBe(2 * vg.graph.undirectedEdgeCount);
    expect(vg.graph.adjOffset[vg.graph.nodeCount]).toBe(
      vg.graph.directedEdgeCount,
    );
  });

  it("prices one elevator ride as one wait plus the floors travelled", () => {
    const vg = build();
    const rides = vg.edgeOfAttr.flatMap((e, attr) =>
      e.kind === "elevator" ? [[e.levelSpan, attr] as const] : [],
    );
    // stops 1F, 2F, 3F: every pair, both directions
    expect(rides).toHaveLength(6);
    for (const [span, attr] of rides) {
      expect(vg.graph.edgeType[attr]).toBe(EDGE_TYPE.INDOOR_ELEVATOR);
      expect(vg.graph.edgeTraversalTimeS[attr]).toBe(30 + (span ?? 0) * 3);
      expect(vg.graph.edgeFlags[attr] & EDGE_FLAG.INDOOR).toBeTruthy();
    }
  });

  it("maps indoor stairs, outdoor steps and the ramp to the cost model's types", () => {
    const vg = build();
    for (const attr of attrsOf(vg, "way/-108")) {
      expect(vg.graph.edgeType[attr]).toBe(EDGE_TYPE.INDOOR_STAIRS);
      expect(vg.graph.edgeStairCount[attr]).toBe(20);
    }
    for (const attr of attrsOf(vg, "way/-305")) {
      expect(vg.graph.edgeType[attr]).toBe(EDGE_TYPE.STEPS);
      expect(vg.graph.edgeFlags[attr] & EDGE_FLAG.INDOOR).toBe(0);
    }
    for (const attr of attrsOf(vg, "way/-302")) {
      expect(vg.graph.edgeSlope[attr]).toBeCloseTo(0.08);
      expect(vg.graph.edgeWidthM[attr]).toBeCloseTo(1.5);
    }
  });

  it("marks an escalator as escalator and closed to wheelchairs", () => {
    const vg = build(
      FIXTURE.replace(
        "<tag k='step_count' v='22' />",
        "<tag k='step_count' v='22' /><tag k='conveying' v='yes' />",
      ),
    );
    const attrs = attrsOf(vg, "way/-205");
    expect(attrs).toHaveLength(2);
    for (const attr of attrs) {
      expect(vg.graph.edgeType[attr]).toBe(EDGE_TYPE.INDOOR_ESCALATOR);
      expect(vg.graph.edgeWheelchair[attr]).toBe(WHEELCHAIR.NO);
    }
  });

  it("flags the gate as an entrance and never emits a fare gate", () => {
    const vg = build();
    const gate = vg.nodeIndex.get("-50@0");
    expect(gate).toBeDefined();
    expect(
      vg.graph.nodeFlags[gate as number] & NODE_FLAG.ENTRANCE,
    ).toBeTruthy();
    expect(vg.graph.edgeType).not.toContain(EDGE_TYPE.INDOOR_FARE_GATE);
  });
});

describe("elevator wheelchair tag", () => {
  it("keeps a limited elevator limited in the graph and in the cost", () => {
    const xml = FIXTURE.replace(
      "<tag k='highway' v='elevator' />",
      "<tag k='highway' v='elevator' /><tag k='wheelchair' v='limited' />",
    );
    const limited = build(xml);
    const plain = build();
    const ride = (vg: ReturnType<typeof build>) =>
      vg.edgeOfAttr.findIndex((e) => e.kind === "elevator");
    expect(limited.graph.edgeWheelchair[ride(limited)]).toBe(
      WHEELCHAIR.LIMITED,
    );
    expect(plain.graph.edgeWheelchair[ride(plain)]).toBe(WHEELCHAIR.YES);
    const wheelchair = venueProfileFor("wheelchair", {
      stairsAvoidanceMultiplier: 4,
    });
    const costOf = (vg: ReturnType<typeof build>) => {
      const attr = ride(vg);
      const from = vg.nodeIndex.get(vg.edgeOfAttr[attr].from) as number;
      const to = vg.nodeIndex.get(vg.edgeOfAttr[attr].to) as number;
      return edgeCost(vg.graph, attr, wheelchair, from, to);
    };
    expect(costOf(limited)).toBeGreaterThan(costOf(plain));
  });
});
