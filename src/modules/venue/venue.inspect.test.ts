import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VenueRoutingConfig } from "../../config/routing";
import type { AccessibilityMode } from "../../types/route";
import { compileVenue } from "./venue.compile";
import { venueConnections } from "./venue.connections";
import { buildVenueGraph } from "./venue.graph";
import {
  InspectVenueArgsSchema,
  boundedCostsFrom,
  inspectVenue,
  normalizeLevelRef,
  selectVenue,
  type InspectVenueArgs,
  type VenueInspectSource,
} from "./venue.inspect";
import { parseOsmXml } from "./venue-osm.parse";
import { arrivalIndices, planVenueRoute, venueProfileFor } from "./venue.route";
import type { VenueData } from "./venue.types";

const CONFIG: VenueRoutingConfig = {
  stairsAvoidanceMultiplier: 4,
  elevatorWaitS: 30,
  elevatorPerFloorS: 3,
};

// The fictional fixture has no toilets; tag two 1F corridor ends of 測試館
// (A 館) as toilets, one tagged wheelchair=yes and one wheelchair=no.
const FIXTURE_XML = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
)
  .replace(
    "<node id='-10' action='modify' visible='true' lat='24.15007235' lon='120.68001969' />",
    "<node id='-10' action='modify' visible='true' lat='24.15007235' lon='120.68001969'><tag k='amenity' v='toilets' /><tag k='wheelchair' v='yes' /><tag k='name' v='廁所' /><tag k='level' v='0' /><tag k='a11ymap:id' v='a-wc-west' /></node>",
  )
  .replace(
    "<node id='-14' action='modify' visible='true' lat='24.15007235' lon='120.68037410' />",
    "<node id='-14' action='modify' visible='true' lat='24.15007235' lon='120.68037410'><tag k='amenity' v='toilets' /><tag k='wheelchair' v='no' /><tag k='name' v='廁所' /><tag k='level' v='0' /><tag k='a11ymap:id' v='a-wc-east' /></node>",
  );

function sourceOf(venue: VenueData): VenueInspectSource {
  return {
    version: 7,
    venue,
    graph: buildVenueGraph(venue, 7, CONFIG),
    connections: venueConnections(venue),
  };
}

const compiled = compileVenue(parseOsmXml(FIXTURE_XML), {
  venueId: "mini",
  name: "Mini Campus",
});
const SOURCE = sourceOf(compiled.venue);

const run = (args: InspectVenueArgs, mode: AccessibilityMode = "normal") =>
  inspectVenue(SOURCE, args, mode, CONFIG);
const facts = (args: InspectVenueArgs, mode: AccessibilityMode = "normal") => {
  const result = run(args, mode);
  if (!result.ok) throw new Error(`expected facts, got ${result.reason}`);
  return result.facts;
};

describe("fixture", () => {
  it("compiles the two tagged toilets", () => {
    expect(compiled.errors).toEqual([]);
    expect(
      compiled.venue.places
        .filter((p) => p.amenity === "toilets")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["a-wc-east", "a-wc-west"]);
  });
});

describe("normalizeLevelRef", () => {
  it.each([
    ["4樓", "4F"],
    ["四樓", "4F"],
    ["4F", "4F"],
    ["4f", "4F"],
    ["４Ｆ", "4F"],
    ["4", "4F"],
    ["十二樓", "12F"],
    ["二十樓", "20F"],
    ["B1", "B1"],
    ["b2f", "B2"],
    ["地下一樓", "B1"],
    ["地下1樓", "B1"],
    ["RF", "RF"],
    ["頂樓", "RF"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeLevelRef(input)).toBe(expected);
  });

  it.each(["0", "零樓", "地下", "樓", "abc", "B0"])("rejects %s", (input) => {
    expect(normalizeLevelRef(input)).toBeNull();
  });
});

describe("selectVenue", () => {
  const venues = [
    {
      venueId: "a",
      name: "國立臺中科技大學 三民校區",
      buildings: [{ name: "資訊館" }],
    },
    { venueId: "b", name: "Other Campus", buildings: [{ name: "資訊館" }] },
  ];

  it("defaults to the only venue and asks when there are several", () => {
    expect(selectVenue([venues[0]], undefined)).toEqual({
      ok: true,
      venueId: "a",
    });
    expect(selectVenue(venues, undefined)).toMatchObject({
      ok: false,
      candidates: [
        { id: "a", name: venues[0].name },
        { id: "b", name: "Other Campus" },
      ],
    });
  });

  it("matches an exact id or a normalized name, never a partial one", () => {
    expect(selectVenue(venues, "b")).toEqual({ ok: true, venueId: "b" });
    expect(selectVenue(venues, "國立台中科技大學三民校區")).toEqual({
      ok: true,
      venueId: "a",
    });
    expect(selectVenue(venues, "台中科大")).toMatchObject({ ok: false });
  });

  it("returns every match instead of the first when a name is shared", () => {
    expect(selectVenue(venues, "資訊館")).toMatchObject({
      ok: false,
      candidates: [{ id: "a" }, { id: "b" }],
    });
  });
});

describe("inspectVenue selectors", () => {
  it("selects a building by id or name and lists all buildings otherwise", () => {
    expect(facts({ building: "bldg-a", kinds: ["elevator"] })).toHaveLength(1);
    expect(facts({ building: "測試館", kinds: ["elevator"] })).toHaveLength(1);
    expect(run({ building: "不存在館" })).toEqual({
      ok: false,
      reason: "BUILDING_NOT_FOUND",
      candidates: [
        { id: "bldg-a", name: "測試館" },
        { id: "bldg-b", name: "實驗館" },
      ],
    });
  });

  it("does not pick the first of several buildings sharing an alias", () => {
    const shared = sourceOf({
      ...compiled.venue,
      buildings: compiled.venue.buildings.map((b) => ({
        ...b,
        aliases: ["共用館"],
      })),
    });
    expect(
      inspectVenue(shared, { building: "共用館" }, "normal", CONFIG),
    ).toMatchObject({
      ok: false,
      reason: "BUILDING_NOT_FOUND",
      candidates: [{ id: "bldg-a" }, { id: "bldg-b" }],
    });
  });

  it("normalizes the floor and lists the building's floors when it does not exist", () => {
    expect(
      facts({ building: "bldg-a", level: "二樓", kinds: ["room"] }).map(
        (f) => f.ref,
      ),
    ).toEqual(["206"]);
    expect(run({ building: "bldg-a", level: "5F" })).toEqual({
      ok: false,
      reason: "LEVEL_NOT_FOUND",
      candidates: [
        { id: "1F", name: "1F" },
        { id: "2F", name: "2F" },
        { id: "3F", name: "3F" },
      ],
    });
    expect(run({ building: "bldg-b", level: "地下一樓" })).toMatchObject({
      ok: false,
      reason: "LEVEL_NOT_FOUND",
    });
  });

  it("finds a room by its exact ref, folding full-width digits", () => {
    expect(facts({ room: "２０６" })).toMatchObject([
      { kind: "room", ref: "206", placeId: "a-room06@2F", levelRefs: ["2F"] },
    ]);
    expect(facts({ room: "20" })).toEqual([]);
  });
});

describe("inspectVenue facts", () => {
  it("reports an elevator's served floors and stairs with their step count", () => {
    expect(facts({ building: "bldg-a", kinds: ["elevator"] })).toEqual([
      {
        kind: "elevator",
        name: "A 館電梯",
        ref: null,
        buildingId: "bldg-a",
        buildingName: "測試館",
        levelRefs: ["1F", "2F", "3F"],
        connectionId: "node/-11",
        wheelchair: "yes",
      },
    ]);
    const stairs = facts({ kinds: ["stairs"] });
    expect(stairs.map((f) => f.connectionId).sort()).toEqual([
      "way/-108@span",
      "way/-109@span",
      "way/-205@span",
      "way/-305@0",
    ]);
    expect(stairs.find((f) => f.connectionId === "way/-305@0")).toMatchObject({
      stepCount: 6,
      wheelchair: "no",
    });
  });

  it("gives a ramp's slope only when it is not an estimate", () => {
    expect(facts({ kinds: ["ramp"] })).toMatchObject([
      { kind: "ramp", slopeRatio: 0.08, slopeMeasured: true },
    ]);
  });

  it("classifies toilets from the source amenity and keeps only accessible ones on request", () => {
    expect(
      facts({ kinds: ["toilet"] }).map((f) => [f.placeId, f.wheelchair]),
    ).toEqual([
      ["a-wc-east", "no"],
      ["a-wc-west", "yes"],
    ]);
    expect(
      facts({ kinds: ["toilet"], accessibleOnly: true }).map((f) => f.placeId),
    ).toEqual(["a-wc-west"]);
  });

  it("never lists floor anchors and reports truncation", () => {
    const all = facts({ limit: 20 });
    expect(all.some((f) => f.placeId?.startsWith("bldg-"))).toBe(false);
    const result = run({ limit: 2 });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.facts).toHaveLength(2);
  });
});

describe("inspectVenue room classification", () => {
  it("treats a poi linked to a room feature as a room and any other poi as other", () => {
    const venue = compiled.venue;
    const roomFeature = venue.features.find((f) => f.kind === "room");
    if (!roomFeature) throw new Error("fixture has no room feature");
    const source = sourceOf({
      ...venue,
      places: venue.places.map((p) =>
        p.id === "a-room06@2F"
          ? { ...p, kind: "poi" as const, featureId: roomFeature.id }
          : p.id === "a-room06@3F"
            ? { ...p, kind: "poi" as const, featureId: null }
            : p,
      ),
    });
    const kindOf = (room: string) => {
      const result = inspectVenue(source, { room }, "normal", CONFIG);
      return result.ok ? result.facts.map((f) => f.kind) : result.reason;
    };
    expect(kindOf("206")).toEqual(["room"]);
    expect(kindOf("306")).toEqual(["other"]);
  });
});

describe("inspectVenue nearPlaceId", () => {
  it("ranks by the mode's route cost and leaves out what the mode cannot reach", () => {
    expect(
      facts(
        { nearPlaceId: "a-room06@1F", building: "bldg-b", kinds: ["room"] },
        "normal",
      ).map((f) => f.placeId),
    ).toEqual(["b-lab"]);
    expect(
      facts(
        { nearPlaceId: "a-room06@1F", building: "bldg-b", kinds: ["room"] },
        "wheelchair",
      ),
    ).toEqual([]);
    expect(
      run({ nearPlaceId: "a-room06@1F", kinds: ["room"] }, "wheelchair"),
    ).toMatchObject({
      effectiveMode: "wheelchair",
    });
  });

  it("reports walking metres without the elevator, matching the venue planner", () => {
    const [upstairs] = facts(
      { nearPlaceId: "a-room06@1F", room: "306" },
      "wheelchair",
    );
    const venue = compiled.venue;
    const planned = planVenueRoute(
      SOURCE.graph,
      venue,
      venue.places.find((p) => p.id === "a-room06@1F")!,
      venue.places.find((p) => p.id === "a-room06@3F")!,
      "wheelchair",
      CONFIG,
      "zh-TW",
    );
    if (!planned.ok) throw new Error("fixture route missing");
    expect(upstairs.elevatorRides).toBe(planned.route.elevatorRides);
    expect(upstairs.elevatorRides).toBeGreaterThan(0);
    expect(upstairs.distanceM).toBe(Math.round(planned.route.distanceM));
  });

  it("orders the nearest toilets first and excludes the origin itself", () => {
    const toilets = facts({ nearPlaceId: "a-wc-west", kinds: ["toilet"] });
    expect(toilets.map((f) => f.placeId)).toEqual(["a-wc-east"]);
  });

  it("refuses an unknown or inconsistent origin instead of guessing", () => {
    expect(run({ nearPlaceId: "no-such-place" })).toEqual({
      ok: false,
      reason: "PLACE_NOT_FOUND",
      candidates: [],
    });
    const venue = compiled.venue;
    const room2f = venue.places.find((p) => p.id === "a-room06@2F")!;
    const corrupt = sourceOf({
      ...venue,
      places: venue.places.map((p) =>
        p.id === "a-room06@1F"
          ? { ...p, arrivalNodeIds: [p.nodeId, room2f.nodeId] }
          : p,
      ),
    });
    expect(
      inspectVenue(corrupt, { nearPlaceId: "a-room06@1F" }, "normal", CONFIG),
    ).toMatchObject({ ok: false, reason: "PLACE_NOT_FOUND" });
  });

  it("drops a candidate whose arrival nodes are inconsistent", () => {
    const venue = compiled.venue;
    const corrupt = sourceOf({
      ...venue,
      places: venue.places.map((p) =>
        p.id === "a-room06@3F"
          ? { ...p, arrivalNodeIds: [p.nodeId, p.nodeId] }
          : p,
      ),
    });
    const result = inspectVenue(
      corrupt,
      { nearPlaceId: "a-room06@1F", kinds: ["room"], building: "bldg-a" },
      "normal",
      CONFIG,
    );
    expect(result.ok && result.facts.map((f) => f.placeId)).toEqual([
      "a-room06@2F",
    ]);
  });
});

describe("boundedCostsFrom", () => {
  it("stops at the cost cap without treating farther nodes as unreachable", () => {
    const venue = compiled.venue;
    const vg = SOURCE.graph;
    const from = arrivalIndices(
      vg,
      venue.places.find((p) => p.id === "a-room06@1F")!,
    )!;
    const to = arrivalIndices(
      vg,
      venue.places.find((p) => p.id === "b-lab")!,
    )![0];
    const profile = venueProfileFor("normal", CONFIG);
    const wide = boundedCostsFrom(vg, from, profile, 1e9);
    expect(Number.isFinite(wide.cost[to])).toBe(true);
    const cap = wide.cost[to] / 2;
    const narrow = boundedCostsFrom(vg, from, profile, cap);
    const settled = (field: { cost: Float64Array }) =>
      field.cost.filter(Number.isFinite).length;
    expect(settled(narrow)).toBeLessThan(settled(wide));
    expect(narrow.cost[to]).toBeGreaterThan(cap);
  });

  it("charges an elevator ride a positive cost although it has no length", () => {
    const vg = SOURCE.graph;
    const venue = compiled.venue;
    const from = arrivalIndices(
      vg,
      venue.places.find((p) => p.id === "a-room06@1F")!,
    )!;
    const field = boundedCostsFrom(
      vg,
      from,
      venueProfileFor("wheelchair", CONFIG),
      1e9,
    );
    const rides = vg.edgeOfAttr.filter((e) => e.kind === "elevator");
    expect(rides.length).toBeGreaterThan(0);
    expect(rides.every((e) => e.lengthM === 0)).toBe(true);
    const target = arrivalIndices(
      vg,
      venue.places.find((p) => p.id === "a-room06@2F")!,
    )![0];
    expect(field.cost[target]).toBeGreaterThan(0);
  });
});

describe("inspectVenue landmarks", () => {
  it("names nearby rooms only for the requested floor", () => {
    const at = (level: string) =>
      facts({ building: "bldg-a", level, kinds: ["elevator"] })[0].landmarks;
    expect(at("2F")).toEqual(["206"]);
    expect(at("3F")).toEqual(["306"]);
    expect(
      facts({ building: "bldg-a", kinds: ["elevator"] })[0],
    ).not.toHaveProperty("landmarks");
  });
});

describe("InspectVenueArgsSchema", () => {
  it.each([
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { kinds: ["cafe"] },
    { nearPlaceId: "   " },
    { mode: "fast" },
    { level: 4 },
  ])("rejects %j", (args) => {
    expect(InspectVenueArgsSchema.safeParse(args).success).toBe(false);
  });

  it("trims text and accepts an empty object", () => {
    expect(InspectVenueArgsSchema.parse({ building: " 資訊館 " })).toEqual({
      building: "資訊館",
    });
    expect(InspectVenueArgsSchema.parse({})).toEqual({});
  });
});
