import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VenueRoutingConfig } from "../../config/routing";
import type { AccessibilityMode } from "../../types/route";
import { compileVenue } from "./venue.compile";
import { buildVenueGraph } from "./venue.graph";
import { parseOsmXml } from "./venue-osm.parse";
import { planVenueRoute, venueProfileFor } from "./venue.route";
import { venueConnections } from "./venue.connections";
import { profileFor } from "../accessible-route/planners/pedestrian-a11y/csr-walk-planner";
import type {
  VenueData,
  VenueEdge,
  VenueNode,
  VenuePlace,
} from "./venue.types";

const CONFIG: VenueRoutingConfig = {
  stairsAvoidanceMultiplier: 4,
  elevatorWaitS: 30,
  elevatorPerFloorS: 3,
};
const FIXTURE_XML = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
);
const { venue, errors } = compileVenue(parseOsmXml(FIXTURE_XML), {
  venueId: "mini",
  name: "Mini Campus",
});
const vg = buildVenueGraph(venue, 7, CONFIG);
const place = (id: string) => {
  const p = venue.places.find((x) => x.id === id);
  if (!p) throw new Error(`no place ${id}`);
  return p;
};
const plan = (
  from: string,
  to: string,
  mode: AccessibilityMode,
  lang: "zh-TW" | "en" = "zh-TW",
) => planVenueRoute(vg, venue, place(from), place(to), mode, CONFIG, lang);
const types = (from: string, to: string, mode: AccessibilityMode) => {
  const r = plan(from, to, mode);
  if (!r.ok) throw new Error(`expected a route, got ${r.reason}`);
  return r.route.steps.map((s) => s.type);
};

describe("venueProfileFor", () => {
  it("preserves each mode's profile and bars stairs only for venue elderly and visual_impaired", () => {
    for (const mode of [
      "wheelchair",
      "normal",
      "elderly",
      "visual_impaired",
    ] as const) {
      const outdoorProfile = profileFor(mode);
      const expected =
        mode === "elderly" || mode === "visual_impaired"
          ? { ...outdoorProfile, forbidStairs: true }
          : outdoorProfile;
      expect(venueProfileFor(mode, CONFIG)).toEqual(expected);
      expect(outdoorProfile.forbidStairs).toBeUndefined();
      expect(outdoorProfile.stairsAvoidanceMultiplier).toBeUndefined();
      expect(
        venueProfileFor(mode, CONFIG).stairsAvoidanceMultiplier,
      ).toBeUndefined();
    }
  });
});

describe("planVenueRoute on the fictional fixture", () => {
  it("compiles the fixture cleanly", () => {
    expect(errors).toEqual([]);
  });

  it("routes a wheelchair by elevator and the 1:12 ramp, never stairs or steps", () => {
    const steps = types("a-room06@3F", "bldg-b@1F", "wheelchair");
    expect(steps).toContain("elevator");
    expect(steps).toContain("ramp");
    expect(steps).not.toContain("stairs");
    expect(steps).not.toContain("steps");
    expect(steps[0]).toBe("depart");
    expect(steps.at(-1)).toBe("arrive");
  });

  it("lets a normal walker take the stairs and the steps shortcut", () => {
    const r = plan("a-room06@3F", "bldg-b@1F", "normal");
    if (!r.ok) throw new Error(r.reason);
    // no walk instruction shorter than the turn threshold survives
    expect(
      r.route.steps
        .filter((s) => s.type === "walk")
        .every((s) => s.distanceM >= 3),
    ).toBe(true);
    const steps = types("a-room06@3F", "bldg-b@1F", "normal");
    expect(steps).toContain("stairs");
    expect(steps).toContain("steps");
    expect(steps).not.toContain("elevator");
    // Distinct authored facilities keep separate identities even when adjacent.
    expect(r.route.steps.filter((s) => s.type === "stairs")).toEqual([
      expect.objectContaining({
        connectionId: "way/-109@span",
        instruction: "走樓梯從 3F 下到 2F（1 層）",
      }),
      expect.objectContaining({
        connectionId: "way/-108@span",
        instruction: "走樓梯從 2F 下到 1F（1 層）",
      }),
    ]);
    expect(r.route.stairFlights).toBe(2);
  });

  it("counts a flight drawn with a middle vertex once", () => {
    const withVertex = FIXTURE_XML.replace(
      /<nd ref='-16' \/>\n    <nd ref='-17' \/>/,
      "<nd ref='-16' /><nd ref='-970' /><nd ref='-17' />",
    ).replace(
      "</osm>",
      "  <node id='-970' lat='24.15010850' lon='120.68029534' />\n</osm>",
    );
    const out = compileVenue(parseOsmXml(withVertex), {
      venueId: "mini",
      name: "Mini Campus",
    });
    expect(out.errors).toEqual([]);
    const g = buildVenueGraph(out.venue, 1, CONFIG);
    const at = (id: string) => {
      const p = out.venue.places.find((x) => x.id === id);
      if (!p) throw new Error(`no place ${id}`);
      return p;
    };
    const r = planVenueRoute(
      g,
      out.venue,
      at("a-room06@2F"),
      at("a-room06@1F"),
      "normal",
      CONFIG,
      "en",
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.route.stairFlights).toBe(1);
    expect(r.route.steps.find((s) => s.type === "stairs")?.instruction).toBe(
      "Take the stairs down from 2F to 1F (1 floor)",
    );
  });

  it("routes elderly and visually impaired walkers by elevator and ramp without stairs, steps or escalators", () => {
    for (const mode of ["elderly", "visual_impaired"] as const) {
      const steps = types("a-room06@3F", "bldg-b@1F", mode);
      expect(steps).toContain("elevator");
      expect(steps).toContain("ramp");
      expect(steps).not.toContain("stairs");
      expect(steps).not.toContain("steps");
      expect(steps).not.toContain("escalator");
    }
  });

  it.each(["elderly", "visual_impaired"] as const)(
    "reports NO_ACCESSIBLE_ROUTE for %s when only stairs reach the floor",
    (mode) => {
      expect(plan("bldg-b@1F", "b-lab", mode)).toEqual({
        ok: false,
        reason: "NO_ACCESSIBLE_ROUTE",
        levelRef: "2F",
      });
    },
  );

  it("reports NO_ACCESSIBLE_ROUTE for a wheelchair when the floor is reachable only by stairs", () => {
    const r = plan("gate-main", "b-lab", "wheelchair");
    expect(r).toEqual({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
      levelRef: "2F",
    });
  });

  it("enters and leaves buildings with floor-aware instructions and 3D coordinates", () => {
    const r = plan("gate-main", "a-room06@2F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    const steps = r.route.steps;
    expect(steps.map((s) => s.type)).toEqual([
      "depart",
      "walk",
      "enter",
      "walk",
      "walk",
      "elevator",
      "walk",
      "walk",
      "arrive",
    ]);
    // entering northwards then heading west to the elevator is a left turn
    expect(steps[4]).toMatchObject({
      maneuver: "left",
      instruction: "左轉，沿測試館 1F 走廊前進約 10 公尺",
    });
    expect(steps.find((s) => s.type === "enter")?.instruction).toBe(
      "進入測試館（1F）",
    );
    expect(steps.find((s) => s.type === "elevator")).toMatchObject({
      fromLevelRef: "1F",
      toLevelRef: "2F",
      instruction: "搭電梯從 1F 到 2F",
    });
    expect(r.route.path.coordinates.at(-1)?.[2]).toBeCloseTo(3.6);
    expect(r.route.venueVersion).toBe(7);
    expect(r.route.elevatorRides).toBe(1);
  });

  it("splits the path into outdoor and per-floor segments that share their boundaries", () => {
    const r = plan("gate-main", "a-room06@2F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    const { segments, path: p } = r.route;
    expect(segments.map((s) => [s.buildingId, s.levelRef])).toEqual([
      [null, null],
      ["bldg-a", "1F"],
      ["bldg-a", "2F"],
    ]);
    expect(segments[0].pathStart).toBe(0);
    expect(segments.at(-1)?.pathEnd).toBe(p.coordinates.length - 1);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].pathStart).toBe(segments[i - 1].pathEnd);
    }
    for (const s of segments) {
      for (let i = s.pathStart + 1; i < s.pathEnd; i += 1) {
        expect(p.levelRefs[i]).toBe(s.levelRef);
      }
    }
  });

  it("charges one elevator wait per ride, however many floors it travels", () => {
    const r = plan("a-room06@3F", "a-room06@1F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    const rides = r.route.steps.filter((s) => s.type === "elevator");
    expect(rides).toHaveLength(1);
    // 30 s wait + 2 floors × 3 s
    expect(rides[0]).toMatchObject({
      fromLevelRef: "3F",
      toLevelRef: "1F",
      durationS: 36,
    });
  });

  it("sums distance from raw lengths and duration from raw times, not the weighted cost", () => {
    const r = plan("gate-main", "a-room06@2F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    const walk = r.route.steps
      .filter((s) => s.type === "walk")
      .reduce((s, x) => s + x.distanceM, 0);
    expect(Math.abs(r.route.distanceM - walk)).toBeLessThanOrEqual(2);
    // walking at 0.8 m/s plus one elevator ride (30 s wait + 3 s per floor)
    expect(r.route.durationS).toBeCloseTo(r.route.distanceM / 0.8 + 33, -1);
  });

  it("writes instructions in English when asked", () => {
    const r = plan("a-room06@3F", "bldg-b@1F", "wheelchair", "en");
    if (!r.ok) throw new Error(r.reason);
    expect(r.route.steps.find((s) => s.type === "elevator")?.instruction).toBe(
      "Take the elevator from 3F to 1F",
    );
    expect(r.route.steps.find((s) => s.type === "ramp")?.instruction).toMatch(
      /^Go up the ramp for \d+ m \(about 8% grade, not surveyed\)$/,
    );
  });
});

/**
 * Compiles the fixture after one tag edit and returns a planner on it.
 * The edit must change the XML, so a stale fixture cannot pass silently.
 */
function variant(pattern: RegExp, replacement: string) {
  const xml = FIXTURE_XML.replace(pattern, replacement);
  if (xml === FIXTURE_XML) throw new Error(`no match for ${pattern}`);
  const out = compileVenue(parseOsmXml(xml), {
    venueId: "mini",
    name: "Mini Campus",
  });
  expect(out.errors).toEqual([]);
  const g = buildVenueGraph(out.venue, 1, CONFIG);
  const at = (id: string) => {
    const p = out.venue.places.find((x) => x.id === id);
    if (!p) throw new Error(`no place ${id}`);
    return p;
  };
  return {
    edges: out.venue.edges,
    places: out.venue.places,
    plan: (from: string, to: string, mode: AccessibilityMode) =>
      planVenueRoute(g, out.venue, at(from), at(to), mode, CONFIG, "zh-TW"),
  };
}

describe("wheelchair hard limits where the barred element is the only way", () => {
  it("never rides an escalator, and names it as an escalator for others", () => {
    // B's only stairs become an escalator
    const v = variant(
      /(<tag k='step_count' v='22' \/>)/,
      "$1<tag k='conveying' v='yes' />",
    );
    expect(
      v.edges.filter((e) => e.kind === "escalator").map((e) => e.wheelchair),
    ).toEqual(["no"]);
    expect(v.plan("gate-main", "b-lab", "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
      levelRef: "2F",
    });
    for (const mode of ["elderly", "visual_impaired"] as const) {
      expect(v.plan("gate-main", "b-lab", mode)).toEqual({
        ok: false,
        reason: "NO_ACCESSIBLE_ROUTE",
        levelRef: "2F",
      });
    }
    const r = v.plan("bldg-b@1F", "b-lab", "normal");
    if (!r.ok) throw new Error(r.reason);
    expect(r.route.steps.map((s) => s.type)).not.toContain("stairs");
    expect(r.route.steps.find((s) => s.type === "escalator")).toMatchObject({
      fromLevelRef: "1F",
      toLevelRef: "2F",
      instruction: "搭手扶梯從 1F 到 2F",
    });
  });

  it("never takes a way tagged wheelchair=no", () => {
    // the ramp to B is closed; only the steps shortcut is left
    const v = variant(
      /<tag k='ramp:wheelchair' v='yes' \/>/,
      "<tag k='wheelchair' v='no' />",
    );
    expect(v.plan("a-room06@3F", "bldg-b@1F", "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
      levelRef: "1F",
    });
    expect(v.plan("a-room06@3F", "bldg-b@1F", "normal").ok).toBe(true);
  });

  it("never passes a door node tagged wheelchair=no", () => {
    // B's only entrance gets a step
    const v = variant(
      /(<node id='-34'[^>]*>\s*<tag k='entrance' v='main' \/>\s*<tag k='door' v='automatic' \/>\s*)<tag k='wheelchair' v='yes' \/>/,
      "$1<tag k='wheelchair' v='no' />",
    );
    expect(v.plan("gate-main", "bldg-b@1F", "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
      levelRef: "1F",
    });
    expect(v.plan("gate-main", "bldg-b@1F", "normal").ok).toBe(true);
  });
});

describe("parking", () => {
  it("lets a driver start from the accessible parking spot on the outdoor path", () => {
    const v = variant(
      /<node id='-51' ([^>]*) \/>/,
      "<node id='-51' $1><tag k='amenity' v='parking' /><tag k='a11ymap:id' v='parking-a' /><tag k='name' v='測試停車場' /><tag k='capacity:disabled' v='2' /></node>",
    );
    expect(v.places.find((p) => p.id === "parking-a")).toMatchObject({
      kind: "parking",
      accessibleSpaces: 2,
      buildingId: null,
      levelRef: null,
    });
    const r = v.plan("parking-a", "a-room06@3F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    expect(r.route.steps[0].instruction).toBe("從測試停車場出發");
    expect(r.route.steps.map((s) => s.type)).toContain("elevator");
  });
});

describe("ramp grades", () => {
  it("never states an estimated grade as a number", () => {
    // without a numeric incline the grade comes from the end heights
    const v = variant(
      /<tag k='incline' v='8%' \/>/,
      "<tag k='incline' v='up' />",
    );
    const r = v.plan("a-room06@3F", "bldg-b@1F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    const ramp = r.route.steps.find((s) => s.type === "ramp");
    expect(ramp?.instruction).toMatch(/^走坡道上行約 \d+ 公尺（坡度未實測）$/);
    expect(ramp?.instruction).not.toContain("%");
  });
});

describe("door width", () => {
  it("keeps wheelchairs out of a door narrower than 0.9 m, not other walkers", () => {
    // A's south door is the only way in from the gate
    const v = variant(
      /(<tag k='name' v='A 館南門' \/>)/,
      "$1<tag k='width' v='0.5' />",
    );
    expect(v.plan("gate-main", "a-room06@1F", "wheelchair")).toMatchObject({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
    });
    for (const mode of ["normal", "elderly", "visual_impaired"] as const) {
      expect(v.plan("gate-main", "a-room06@1F", mode).ok).toBe(true);
    }
  });
});

describe("grade status", () => {
  it("treats a numeric incline nobody vouched for as an estimate", () => {
    const v = variant(
      /<tag k='a11ymap:height_status' v='drawing' \/>\n\s*/,
      "",
    );
    const r = v.plan("a-room06@3F", "bldg-b@1F", "wheelchair");
    if (!r.ok) throw new Error(r.reason);
    expect(r.route.steps.find((s) => s.type === "ramp")?.instruction).toMatch(
      /（坡度未實測）$/,
    );
  });
});

/** A connected source chain lets route tests control facility and height metadata. */
function chainVenue(
  edgeValues: Partial<VenueEdge>[],
  nodeValues: Partial<VenueNode>[] = [],
): VenueData {
  const nodes: VenueNode[] = Array.from(
    { length: edgeValues.length + 1 },
    (_, i) => ({
      id: `node/-${900 + i}@0`,
      lng: 120.68 + i * 0.0001,
      lat: 24.15,
      z: 0,
      buildingId: "bldg-a",
      ordinal: 0,
      indoor: true,
      kind: "path",
      kerbRamp: false,
      ...nodeValues[i],
    }),
  );
  const edges: VenueEdge[] = edgeValues.map((value, i) => ({
    id: `way/-900:${i}@0`,
    from: nodes[i].id,
    to: nodes[i + 1].id,
    kind: "corridor",
    indoor: true,
    lengthM: 10,
    wheelchair: "yes",
    ramp: false,
    osmRef: "way/-900",
    geometryStatus: "traced",
    heightStatus: "estimated",
    ...value,
  }));
  const at = (id: string, n: VenueNode): VenuePlace => ({
    id,
    name: id,
    kind: "room",
    nodeId: n.id,
    location: [n.lng, n.lat],
    buildingId: n.buildingId,
    levelRef: n.ordinal === null ? null : `${n.ordinal + 1}F`,
  });
  return {
    ...venue,
    nodes,
    edges,
    features: [],
    places: [
      at("Origin", nodes[0]),
      at("Destination", nodes[nodes.length - 1]),
    ],
  };
}

function planChain(
  data: VenueData,
  lang: "zh-TW" | "en" = "zh-TW",
  reverse = false,
) {
  const [origin, destination] = data.places;
  const result = planVenueRoute(
    buildVenueGraph(data, 1, CONFIG),
    data,
    reverse ? destination : origin,
    reverse ? origin : destination,
    "normal",
    CONFIG,
    lang,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.route;
}

describe("source-backed route metadata", () => {
  it("uses existing connection IDs and separates adjacent ramp facilities", () => {
    const data = chainVenue([
      { ramp: true, heightPending: false },
      { ramp: true, heightPending: true },
      { ramp: true, osmRef: "way/-901", id: "way/-901:0@0" },
    ]);
    const route = planChain(data);
    const ramps = route.steps.filter((s) => s.type === "ramp");
    expect(ramps).toEqual([
      expect.objectContaining({
        connectionId: "way/-900@0",
        pathStart: 0,
        pathEnd: 2,
        heightPending: true,
      }),
      expect.objectContaining({
        connectionId: "way/-901@0",
        pathStart: 2,
        pathEnd: 3,
      }),
    ]);
    expect(ramps[1]).not.toHaveProperty("heightPending");
    const ids = new Set(
      venueConnections(data).map((connection) => connection.id),
    );
    for (const step of ramps)
      expect(ids.has(step.connectionId as string)).toBe(true);
    expect(route.path.coordinates.map((point) => point[2])).toEqual([
      0, 0, 0, 0,
    ]);
    expect(ramps[0].instruction).toBe("走坡道約 20 公尺（坡度未實測）");
    // In reverse, the true flag is still aggregated over the same source facility.
    expect(
      planChain(data, "en", true).steps.filter((s) => s.type === "ramp"),
    ).toEqual([
      expect.objectContaining({
        connectionId: "way/-901@0",
        pathStart: 0,
        pathEnd: 1,
      }),
      expect.objectContaining({
        connectionId: "way/-900@0",
        heightPending: true,
        pathStart: 1,
        pathEnd: 3,
      }),
    ]);
  });

  it("leaves only slope-inferred ramps without a facility ID and keeps pending at z=0", () => {
    const data = chainVenue([{ slopeRatio: 0.02, heightPending: true }]);
    expect(venueConnections(data)).toEqual([]);
    expect(
      planChain(data).steps.find((step) => step.type === "ramp"),
    ).toMatchObject({
      connectionId: null,
      heightPending: true,
      pathStart: 0,
      pathEnd: 1,
    });
  });

  it("preserves explicit false but omits unknown heightPending", () => {
    const pending = chainVenue([{ ramp: true, heightPending: false }]);
    expect(
      planChain(pending).steps.find((step) => step.type === "ramp"),
    ).toHaveProperty("heightPending", false);
    const unknown = chainVenue([{ ramp: true }]);
    expect(
      planChain(unknown).steps.find((step) => step.type === "ramp"),
    ).not.toHaveProperty("heightPending");
  });

  it("retains stable elevator identity and a single wait on a multi-floor ride", () => {
    const result = plan("a-room06@3F", "a-room06@1F", "wheelchair");
    if (!result.ok) throw new Error(result.reason);
    const elevators = result.route.steps.filter(
      (step) => step.type === "elevator",
    );
    expect(elevators).toEqual([
      expect.objectContaining({ connectionId: "node/-11", durationS: 36 }),
    ]);
    expect(
      venueConnections(venue).some(
        (connection) => connection.id === elevators[0].connectionId,
      ),
    ).toBe(true);
    expect(result.route.elevatorRides).toBe(1);
  });
});

describe("typed place arrivals", () => {
  it("describes a corridor arrival explicitly in both languages even for a room place", () => {
    const data = chainVenue([{}]);
    Object.assign(data.places[1], {
      arrivalKind: "corridor",
      doorKnown: false,
      name: "2101",
      kind: "room",
    });
    expect(planChain(data).steps.at(-1)?.instruction).toBe("抵達2101附近走廊");
    expect(planChain(data, "en").steps.at(-1)?.instruction).toBe(
      "Arrive at the corridor near 2101",
    );
  });

  it("names the door only when its typed arrival and known-door evidence agree", () => {
    const data = chainVenue([{}]);
    Object.assign(data.places[1], { arrivalKind: "door", doorKnown: true });
    expect(planChain(data).steps.at(-1)?.instruction).toBe(
      "抵達Destination門口",
    );
    expect(planChain(data, "en").steps.at(-1)?.instruction).toBe(
      "Arrive at the door of Destination",
    );
    data.places[1].doorKnown = false;
    expect(planChain(data).steps.at(-1)?.instruction).toBe("抵達Destination");
    delete data.places[1].arrivalKind;
    delete data.places[1].doorKnown;
    expect(planChain(data, "en").steps.at(-1)?.instruction).toBe(
      "Arrive at Destination",
    );
  });
});

describe("building transition indices", () => {
  it.each([false, true])(
    "preserves the existing outdoor entry/exit boundary (reverse=%s)",
    (reverse) => {
      const data = chainVenue(
        [{}, { indoor: false }, { indoor: false }],
        [
          {},
          {},
          { buildingId: null, ordinal: null, indoor: false },
          { buildingId: null, ordinal: null, indoor: false },
        ],
      );
      const route = planChain(data, "zh-TW", reverse);
      const transition = route.steps.find(
        (step) => step.type === (reverse ? "enter" : "exit"),
      );
      expect(transition).toMatchObject({
        buildingId: "bldg-a",
        pathStart: reverse ? 2 : 1,
        pathEnd: reverse ? 2 : 1,
      });
      expect(route.path.buildingIds).toEqual(
        reverse
          ? [null, null, "bldg-a", "bldg-a"]
          : ["bldg-a", "bldg-a", null, null],
      );
    },
  );
  it.each([false, true])(
    "keeps entry at the preceding boundary vertex (reverse=%s)",
    (reverse) => {
      const data = chainVenue(
        [{}, {}, {}],
        [
          { buildingId: "bldg-a", ordinal: 2, z: 7.2 },
          { buildingId: "bldg-a", ordinal: 2, z: 7.2 },
          { buildingId: "bldg-b", ordinal: 2, z: 7.2 },
          { buildingId: "bldg-b", ordinal: 2, z: 7.2 },
        ],
      );
      const route = planChain(data, "zh-TW", reverse);
      const sourceBuilding = reverse ? "bldg-b" : "bldg-a";
      const destinationBuilding = reverse ? "bldg-a" : "bldg-b";
      expect(route.steps.find((step) => step.type === "enter")).toMatchObject({
        buildingId: destinationBuilding,
        levelRef: "3F",
        pathStart: 1,
        pathEnd: 1,
      });
      // Instructions may announce entry before the per-point building context changes.
      expect(route.path.buildingIds).toEqual([
        sourceBuilding,
        sourceBuilding,
        destinationBuilding,
        destinationBuilding,
      ]);
      expect(route.path.levelRefs).toEqual(["3F", "3F", "3F", "3F"]);
      expect(route.path.coordinates.map((point) => point[2])).toEqual([
        7.2, 7.2, 7.2, 7.2,
      ]);
      expect(route.segments).toEqual([
        {
          buildingId: sourceBuilding,
          levelRef: "3F",
          pathStart: 0,
          pathEnd: 2,
        },
        {
          buildingId: destinationBuilding,
          levelRef: "3F",
          pathStart: 2,
          pathEnd: 3,
        },
      ]);
    },
  );
});

describe("multiple source-backed arrival nodes", () => {
  function alternatives() {
    const data = chainVenue([{ kind: "steps", lengthM: 5 }, { lengthM: 30 }]);
    data.edges[1].from = data.nodes[0].id;
    Object.assign(data.places[1], {
      nodeId: data.nodes[1].id,
      location: [data.nodes[1].lng, data.nodes[1].lat],
      arrivalNodeIds: [data.nodes[1].id, data.nodes[2].id],
      arrivalKind: "corridor",
      doorKnown: false,
    });
    return data;
  }
  function attempt(data: VenueData, mode: AccessibilityMode) {
    return planVenueRoute(
      buildVenueGraph(data, 1, CONFIG),
      data,
      data.places[0],
      data.places[1],
      mode,
      CONFIG,
      "zh-TW",
    );
  }
  it("selects the accessible alternative and reports its actual endpoint while preserving the destination identity", () => {
    const data = alternatives();
    const result = attempt(data, "wheelchair");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.route.toPlaceId).toBe("Destination");
    expect(result.route.path.coordinates.at(-1)).toEqual([
      data.nodes[2].lng,
      data.nodes[2].lat,
      0,
    ]);
    expect(result.route.distanceM).toBe(30);
    expect(result.route.steps.at(-1)?.instruction).toBe(
      "抵達Destination附近走廊",
    );
    expect(result.route.steps.map((step) => step.type)).not.toContain("stairs");
    const ordinary = attempt(data, "normal");
    if (!ordinary.ok) throw new Error(ordinary.reason);
    expect(ordinary.route.path.coordinates.at(-1)).toEqual([
      data.nodes[1].lng,
      data.nodes[1].lat,
      0,
    ]);
    expect(ordinary.route.distanceM).toBe(5);
  });
  it("does not label a selected corridor alternative as the primary known door", () => {
    const data = alternatives();
    data.nodes[1].kind = "door";
    Object.assign(data.places[1], { arrivalKind: "door", doorKnown: true });
    const result = attempt(data, "wheelchair");
    if (!result.ok) throw new Error(result.reason);
    expect(result.route.steps.at(-1)?.instruction).toBe(
      "抵達Destination附近走廊",
    );
    const ordinary = attempt(data, "normal");
    if (!ordinary.ok) throw new Error(ordinary.reason);
    expect(ordinary.route.steps.at(-1)?.instruction).toBe(
      "抵達Destination門口",
    );
  });
  it("evaluates origin alternatives and does not use an inaccessible primary origin", () => {
    const data = alternatives();
    data.places.reverse();
    const result = attempt(data, "wheelchair");
    if (!result.ok) throw new Error(result.reason);
    expect(result.route.fromPlaceId).toBe("Destination");
    expect(result.route.path.coordinates[0]).toEqual([
      data.nodes[2].lng,
      data.nodes[2].lat,
      0,
    ]);
  });
  it("classifies failure using every legal pair rather than the disconnected primary", () => {
    const data = alternatives();
    data.edges = [{ ...data.edges[1], kind: "steps" }];
    expect(attempt(data, "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
      levelRef: "1F",
    });
    data.edges = [];
    expect(attempt(data, "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ROUTE",
    });
  });
  it("rejects alternative nodes on a different building or floor rather than inventing an endpoint", () => {
    const data = alternatives();
    data.nodes[2].ordinal = 1;
    expect(attempt(data, "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ROUTE",
    });
    data.nodes[2].ordinal = 0;
    data.nodes[2].buildingId = "other";
    expect(attempt(data, "wheelchair")).toEqual({
      ok: false,
      reason: "NO_ROUTE",
    });
  });
  it("fails closed for malformed, missing-primary and unbounded candidate lists", () => {
    const data = alternatives();
    for (const ids of [
      [],
      [data.nodes[2].id],
      ["missing", data.nodes[1].id],
      [data.nodes[1].id, data.nodes[1].id],
      Array.from({ length: 17 }, (_, i) => data.nodes[i % 3].id),
    ]) {
      data.places[1].arrivalNodeIds = ids;
      expect(attempt(data, "wheelchair")).toEqual({
        ok: false,
        reason: "NO_ROUTE",
      });
    }
  });
});
