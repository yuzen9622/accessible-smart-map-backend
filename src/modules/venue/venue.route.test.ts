import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VenueRoutingConfig } from "../../config/routing";
import type { AccessibilityMode } from "../../types/route";
import { compileVenue } from "./venue.compile";
import { buildVenueGraph } from "./venue.graph";
import { parseOsmXml } from "./venue-osm.parse";
import { planVenueRoute, venueProfileFor } from "./venue.route";

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
  it("keeps wheelchair and normal strict and neutral, and sets the stairs multiplier only for elderly and visual_impaired", () => {
    expect(venueProfileFor("wheelchair", CONFIG)).toMatchObject({
      name: "wheelchair",
      relaxationLevel: 0,
    });
    expect(
      venueProfileFor("wheelchair", CONFIG).stairsAvoidanceMultiplier,
    ).toBeUndefined();
    expect(
      venueProfileFor("normal", CONFIG).stairsAvoidanceMultiplier,
    ).toBeUndefined();
    expect(venueProfileFor("elderly", CONFIG).stairsAvoidanceMultiplier).toBe(
      4,
    );
    expect(
      venueProfileFor("visual_impaired", CONFIG).stairsAvoidanceMultiplier,
    ).toBe(4);
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
    // two flights in a row are one stairs step covering both floors
    expect(r.route.steps.filter((s) => s.type === "stairs")).toEqual([
      expect.objectContaining({ instruction: "走樓梯從 3F 下到 1F（2 層）" }),
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

  it("makes elderly and visually impaired walkers prefer the elevator and the ramp", () => {
    for (const mode of ["elderly", "visual_impaired"] as const) {
      const steps = types("a-room06@3F", "bldg-b@1F", mode);
      expect(steps).toContain("elevator");
      expect(steps).toContain("ramp");
      expect(steps).not.toContain("stairs");
    }
  });

  it("still routes elderly over stairs when no elevator reaches the floor", () => {
    expect(types("bldg-b@1F", "b-lab", "elderly")).toContain("stairs");
  });

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
    expect(v.plan("gate-main", "a-room06@1F", "normal").ok).toBe(true);
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
