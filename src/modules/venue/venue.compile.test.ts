import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileVenue,
  inclineOf,
  isInclined,
  levelsOf,
  levelRefOf,
  parseIncline,
  parseLevels,
  tagNumber,
} from "./venue.compile";
import { venueConnections } from "./venue.connections";
import { parseOsmXml } from "./venue-osm.parse";

const FIXTURE = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
);
const compileFixture = (xml = FIXTURE) =>
  compileVenue(parseOsmXml(xml), { venueId: "mini", name: "Mini Campus" });

/** Replaces one exact snippet of the fixture, failing loudly if it is absent. */
function mutate(find: string, replace: string): string {
  expect(FIXTURE.includes(find)).toBe(true);
  return FIXTURE.replace(find, replace);
}

describe("level and incline parsing", () => {
  it("parses OSM level lists and ranges", () => {
    expect(parseLevels("0")).toEqual([0]);
    expect(parseLevels("-1;0;2")).toEqual([-1, 0, 2]);
    expect(parseLevels("0-2")).toEqual([0, 1, 2]);
    expect(parseLevels(undefined)).toEqual([]);
    expect(parseLevels("ground")).toBeNull();
  });

  it("maps ordinals to Taiwanese floor names", () => {
    expect(levelRefOf(0)).toBe("1F");
    expect(levelRefOf(3)).toBe("4F");
    expect(levelRefOf(-1)).toBe("B1");
  });

  it("reads incline as an absolute ratio", () => {
    expect(parseIncline("8%")).toBeCloseTo(0.08);
    expect(parseIncline("-5%")).toBeCloseTo(0.05);
    expect(parseIncline("up")).toBeUndefined();
  });
});

describe("compileVenue on the fictional fixture", () => {
  const { venue, errors, warnings } = compileFixture();

  it("compiles without errors", () => {
    expect(errors).toEqual([]);
  });

  it("builds levels with the building's ground offset", () => {
    const a = venue.buildings.find((b) => b.id === "bldg-a");
    const b = venue.buildings.find((x) => x.id === "bldg-b");
    expect(a?.levels.map((l) => l.ref)).toEqual(["1F", "2F", "3F"]);
    expect(b?.levels.map((l) => [l.ref, l.elevationM])).toEqual([
      ["1F", 1],
      ["2F", 4.6],
    ]);
    expect(a?.heightStatus).toBe("estimated");
  });

  it("creates repeated places, per-level anchors and the gate", () => {
    const ids = venue.places.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        "a-room06@1F",
        "a-room06@2F",
        "a-room06@3F",
        "b-lab",
        "bldg-a@1F",
        "bldg-a@2F",
        "bldg-a@3F",
        "bldg-b@1F",
        "bldg-b@2F",
        "gate-main",
      ].sort(),
    );
    const room = venue.places.find((p) => p.id === "a-room06@3F");
    expect(room).toMatchObject({
      name: "306 教室",
      ref: "306",
      buildingId: "bldg-a",
      levelRef: "3F",
    });
    expect(venue.places.find((p) => p.id === "gate-main")).toMatchObject({
      kind: "gate",
      buildingId: null,
    });
  });

  it("splits the elevator into one node per served level and links every pair", () => {
    const rides = venue.edges.filter((e) => e.kind === "elevator");
    expect(rides.map((e) => e.levelSpan).sort()).toEqual([1, 1, 2]);
    expect(rides.every((e) => e.indoor && e.lengthM === 0)).toBe(true);
  });

  it("keeps the tagged ramp grade and marks steps", () => {
    const ramp = venue.edges.find((e) => e.osmRef === "way/-302");
    expect(ramp).toMatchObject({ ramp: true, widthM: 1.5, kind: "footway" });
    expect(ramp?.slopeRatio).toBeCloseTo(0.08);
    const outdoorSteps = venue.edges.find((e) => e.osmRef === "way/-305");
    expect(outdoorSteps).toMatchObject({
      kind: "steps",
      indoor: false,
      stepCount: 6,
    });
    const indoorStairs = venue.edges.find((e) => e.osmRef === "way/-108");
    expect(indoorStairs).toMatchObject({ kind: "steps", indoor: true });
  });

  it("connects a ground footway and a 1F corridor through a shared entrance node", () => {
    const entrance = venue.nodes.find((n) => n.id === "-6@0");
    expect(entrance).toMatchObject({
      buildingId: "bldg-a",
      kind: "entrance",
      z: 0,
    });
    const touching = venue.edges.filter(
      (e) => e.from === "-6@0" || e.to === "-6@0",
    );
    expect(touching.some((e) => !e.indoor)).toBe(true);
    expect(touching.some((e) => e.indoor)).toBe(true);
  });

  it("emits display features per level and reports wheelchair-unreachable places", () => {
    expect(
      venue.features.filter((f) => f.kind === "room").map((f) => f.levelRef),
    ).toEqual(["1F", "2F", "3F"]);
    expect(
      warnings.some(
        (w) => w.includes("實驗館 2F") && w.includes("輪椅無法抵達"),
      ),
    ).toBe(true);
  });
});

describe("compileVenue validation", () => {
  it("refuses an elevator level with no corridor attached instead of linking it", () => {
    const xml = mutate(
      "v='0;1;2' />\n    <tag k='name' v='A 館電梯'",
      "v='0;1;2;3' />\n    <tag k='name' v='A 館電梯'",
    );
    const { errors } = compileFixture(xml);
    expect(errors.some((e) => e.includes("A 館電梯") && e.includes("4F"))).toBe(
      true,
    );
  });

  it("accepts places on a basement level", () => {
    const xml = mutate(
      "<tag k='building:levels' v='3' />",
      "<tag k='building:levels' v='3' />\n    <tag k='building:levels:underground' v='1' />",
    )
      .replace(
        /(<nd ref='-15' \/>\n(?:\s*<tag [^>]*\/>\n)*?\s*)<tag k='repeat_on' v='1;2' \/>/,
        "$1<tag k='repeat_on' v='-1;1;2' />",
      )
      .replace(
        "<tag k='repeat_on' v='1;2' />\n    <tag k='a11ymap:id' v='a-room06' />",
        "<tag k='repeat_on' v='-1;1;2' />\n    <tag k='a11ymap:id' v='a-room06' />",
      );
    const { venue, errors } = compileFixture(xml);
    expect(errors).toEqual([]);
    expect(venue.places.map((p) => p.id)).toContain("a-room06@B1");
  });

  it("requires single-level end nodes on stairs that span levels", () => {
    const noLevel = FIXTURE.replace(
      /(<node id='-17'[^>]*>\n)\s*<tag k='level' v='1' \/>\n/,
      "$1",
    );
    expect(noLevel).not.toBe(FIXTURE);
    const { errors } = compileFixture(noLevel);
    expect(errors.some((e) => e.includes("way -108"))).toBe(true);
  });

  it("rejects '@' in an id, duplicate ids and a place off the network", () => {
    const withAt = mutate("v='gate-main'", "v='gate@main'");
    expect(
      compileFixture(withAt).errors.some((e) => e.includes("gate@main")),
    ).toBe(true);

    const duplicate = mutate("v='b-lab'", "v='gate-main'");
    expect(
      compileFixture(duplicate).errors.some((e) => e.includes("重複")),
    ).toBe(true);

    const orphan = FIXTURE.replace(
      "</osm>",
      "  <node id='-900' lat='24.1503' lon='120.6802'><tag k='a11ymap:id' v='orphan' /><tag k='name' v='孤立地點' /></node>\n</osm>",
    );
    expect(
      compileFixture(orphan).errors.some((e) => e.includes("孤立地點")),
    ).toBe(true);
  });

  it("rejects a11ymap:id on a room outline instead of ignoring it", () => {
    const xml = mutate(
      "<tag k='ref' v='{L}06' />\n  </way>",
      "<tag k='ref' v='{L}06' />\n    <tag k='a11ymap:id' v='room-x' />\n  </way>",
    );
    expect(
      compileFixture(xml).errors.some(
        (e) => e.includes("room-x") && e.includes("way -110"),
      ),
    ).toBe(true);
  });

  it("rejects an invalid step_count and warns about a missing one", () => {
    const negative = mutate("v='22' />", "v='-3' />");
    expect(
      compileFixture(negative).errors.some(
        (e) => e.includes("way -205") && e.includes("step_count"),
      ),
    ).toBe(true);
    const missing = mutate("<tag k='step_count' v='22' />", "");
    const out = compileFixture(missing);
    expect(out.errors).toEqual([]);
    expect(
      out.warnings.some((w) => w.includes("way -205 沒標 step_count")),
    ).toBe(true);
  });

  it("checks ramp:wheelchair on ramps and stairs", () => {
    const missing = compileFixture(
      mutate("<tag k='ramp:wheelchair' v='yes' />", ""),
    );
    expect(
      missing.warnings.some(
        (w) => w.includes("way -302") && w.includes("ramp:wheelchair"),
      ),
    ).toBe(true);

    const notAccessible = compileFixture(
      mutate(
        "<tag k='ramp:wheelchair' v='yes' />",
        "<tag k='ramp:wheelchair' v='no' />",
      ),
    );
    expect(
      notAccessible.venue.edges
        .filter((e) => e.osmRef === "way/-302")
        .map((e) => e.wheelchair),
    ).toEqual(["no"]);

    const onStairs = compileFixture(
      mutate(
        "<tag k='step_count' v='22' />",
        "<tag k='step_count' v='22' />\n    <tag k='ramp:wheelchair' v='yes' />",
      ),
    );
    expect(
      onStairs.warnings.some(
        (w) => w.includes("way -205") && w.includes("另畫一條 footway"),
      ),
    ).toBe(true);
  });

  it("reports a dead end drawn next to another way without a shared node", () => {
    const xml = FIXTURE.replace(
      "</osm>",
      [
        "  <node id='-920' lat='24.15007505' lon='120.68029534' />",
        "  <node id='-921' lat='24.15011000' lon='120.68034000' />",
        "  <way id='-922'><nd ref='-921' /><nd ref='-920' /><tag k='highway' v='corridor' /><tag k='level' v='0' /></way>",
        "</osm>",
      ].join("\n"),
    );
    const { errors, warnings } = compileFixture(xml);
    expect(errors).toEqual([]);
    expect(
      warnings.filter((w) => w.includes("不到 0.5 公尺")).map((w) => w),
    ).toEqual([expect.stringMatching(/^node -920（1F）離 way\/-10\d/)]);
    expect(compileFixture().warnings.some((w) => w.includes("0.5 公尺"))).toBe(
      false,
    );
  });

  it("warns which levels have no anchor", () => {
    const xml = FIXTURE.replace(
      /(<node id='-36'[\s\S]*?)<tag k='a11ymap:anchor' v='yes' \/>\n\s*/,
      "$1",
    );
    expect(xml).not.toBe(FIXTURE);
    expect(compileFixture(xml).warnings).toContain(
      "「實驗館」缺樓層錨點（a11ymap:anchor=yes）：1F、2F；這些樓層無法用「建築＋樓層」選為起訖（該層的教室等地點仍可）",
    );
    expect(compileFixture().warnings.some((w) => w.includes("錨點"))).toBe(
      false,
    );
  });
});

describe("stairs and ramps that span levels", () => {
  /** Way -108 without its own level tag: only the end nodes say 1F → 2F. */
  const endpointsOnly = () =>
    mutate(
      "<tag k='highway' v='steps' />\n    <tag k='level' v='0;1' />\n    <tag k='step_count' v='20' />",
      "<tag k='highway' v='steps' />\n    <tag k='step_count' v='20' />",
    );

  it("derives the span from the end nodes when the way has no level", () => {
    const { venue, errors } = compileFixture(endpointsOnly());
    expect(errors).toEqual([]);
    expect(
      venue.edges
        .filter((e) => e.osmRef === "way/-108")
        .map((e) => [e.from, e.to]),
    ).toEqual([["-16@0", "-17@1"]]);
  });

  it("keeps a landing with its own level shared and interpolates the rest, honouring a11ymap:ele", () => {
    // 1F → (ele 2.5) → (no tags) → 2F landing → 3F, as one way
    const xml = endpointsOnly()
      .replace(
        "<nd ref='-16' />\n    <nd ref='-17' />",
        "<nd ref='-16' />\n    <nd ref='-901' />\n    <nd ref='-902' />\n    <nd ref='-17' />\n    <nd ref='-18' />",
      )
      .replace(
        "</osm>",
        [
          "  <node id='-901' lat='24.15009948' lon='120.68029534'><tag k='a11ymap:ele' v='2.5' /></node>",
          "  <node id='-902' lat='24.15011757' lon='120.68029534' />",
          "</osm>",
        ].join("\n"),
      );
    const { venue, errors } = compileFixture(xml);
    expect(errors).toEqual([]);
    const z = (id: string) => venue.nodes.find((n) => n.id === id)?.z;
    expect(z("-901@w-108")).toBe(2.5);
    expect(z("-902@w-108")).toBeCloseTo(3.05, 2);
    expect(z("-17@1")).toBeCloseTo(3.6);
    const way108 = venue.edges.filter((e) => e.osmRef === "way/-108");
    expect(way108.map((e) => e.to)).toEqual([
      "-901@w-108",
      "-902@w-108",
      "-17@1",
      "-18@2",
    ]);
    // the 2F landing is the same node the 2F corridor uses
    expect(
      venue.edges.some((e) => e.osmRef === "way/-106" && e.to === "-17@1"),
    ).toBe(true);
  });

  it("rejects a vertex without a level that another way also uses", () => {
    const xml = endpointsOnly()
      .replace(
        "<nd ref='-16' />\n    <nd ref='-17' />",
        "<nd ref='-16' />\n    <nd ref='-902' />\n    <nd ref='-17' />",
      )
      .replace(
        "</osm>",
        [
          "  <node id='-902' lat='24.15011757' lon='120.68029534' />",
          "  <way id='-911'><nd ref='-902' /><nd ref='-13' /><tag k='highway' v='corridor' /><tag k='level' v='0' /></way>",
          "</osm>",
        ].join("\n"),
      );
    expect(
      compileFixture(xml).errors.some(
        (e) => e.includes("way -108") && e.includes("中間節點 -902"),
      ),
    ).toBe(true);
  });

  it("rejects a way level that contradicts its end nodes, and repeat_on on a span", () => {
    const contradict = mutate(
      "<tag k='level' v='0;1' />\n    <tag k='step_count' v='20' />",
      "<tag k='level' v='1;2' />\n    <tag k='step_count' v='20' />",
    );
    expect(
      compileFixture(contradict).errors.some(
        (e) => e.includes("way -108") && e.includes("不一致"),
      ),
    ).toBe(true);
    const repeated = mutate(
      "<tag k='level' v='0;1' />\n    <tag k='step_count' v='20' />",
      "<tag k='level' v='0;1' />\n    <tag k='repeat_on' v='2' />\n    <tag k='step_count' v='20' />",
    );
    expect(
      compileFixture(repeated).errors.some(
        (e) => e.includes("way -108") && e.includes("repeat_on"),
      ),
    ).toBe(true);
  });
});

describe("round-2 authoring rules", () => {
  it("treats a direction-only incline as a ramp", () => {
    const closed = compileFixture(
      mutate(
        "<tag k='incline' v='8%' />",
        "<tag k='incline' v='up' />",
      ).replace(
        "<tag k='ramp:wheelchair' v='yes' />",
        "<tag k='ramp:wheelchair' v='no' />",
      ),
    );
    expect(
      closed.venue.edges
        .filter((e) => e.osmRef === "way/-302")
        .map((e) => [e.ramp, e.wheelchair]),
    ).toEqual([[true, "no"]]);
    const untagged = compileFixture(
      mutate(
        "<tag k='incline' v='8%' />",
        "<tag k='incline' v='up' />",
      ).replace("<tag k='ramp:wheelchair' v='yes' />", ""),
    );
    expect(
      untagged.warnings.some(
        (w) => w.includes("way -302") && w.includes("ramp:wheelchair"),
      ),
    ).toBe(true);
  });

  it.each([
    ["a footway", "<tag k='highway' v='footway' /><tag k='level' v='3' />"],
    ["steps", "<tag k='highway' v='steps' /><tag k='level' v='3' />"],
    [
      "a corridor on several levels",
      "<tag k='highway' v='corridor' /><tag k='level' v='2;3' />",
    ],
  ])("does not accept %s as an elevator landing", (_label, tags) => {
    const xml = mutate(
      "v='0;1;2' />\n    <tag k='name' v='A 館電梯'",
      "v='0;1;2;3' />\n    <tag k='name' v='A 館電梯'",
    )
      .replace(
        "<tag k='building:levels' v='3' />",
        "<tag k='building:levels' v='4' />",
      )
      .replace(
        "</osm>",
        `  <way id='-930'><nd ref='-10' /><nd ref='-11' />${tags}</way>\n</osm>`,
      );
    expect(
      compileFixture(xml).errors.some(
        (e) => e.includes("A 館電梯") && e.includes("4F"),
      ),
    ).toBe(true);
  });

  const building = (rel: string, ways: string) =>
    FIXTURE.replace(
      "</osm>",
      [
        "  <node id='-950' lat='24.1490' lon='120.6790' />",
        "  <node id='-951' lat='24.1490' lon='120.6792' />",
        "  <node id='-952' lat='24.1492' lon='120.6792' />",
        "  <node id='-953' lat='24.1492' lon='120.6790' />",
        ways,
        rel,
        "</osm>",
      ].join("\n"),
    );
  const splitOuter = (closingNode: string) =>
    building(
      "  <relation id='-956'><member type='way' ref='-954' role='outer' /><member type='way' ref='-955' role='outer' /><tag k='type' v='multipolygon' /><tag k='building' v='yes' /><tag k='name' v='分段館' /><tag k='a11ymap:id' v='bldg-c' /><tag k='building:levels' v='1' /></relation>",
      [
        "  <way id='-954'><nd ref='-950' /><nd ref='-951' /><nd ref='-952' /></way>",
        `  <way id='-955'><nd ref='-953' /><nd ref='-952' /><nd ref='${closingNode}' /></way>`,
      ].join("\n"),
    );

  it("stitches a multipolygon outline split across several ways", () => {
    // -955 is drawn backwards on purpose
    const xml = splitOuter("-950").replace(
      "<nd ref='-953' /><nd ref='-952' /><nd ref='-950' />",
      "<nd ref='-950' /><nd ref='-953' /><nd ref='-952' />",
    );
    const { venue, errors } = compileFixture(xml);
    expect(errors).toEqual([]);
    const c = venue.buildings.find((b) => b.id === "bldg-c");
    expect(c?.footprint).toHaveLength(1);
    expect(c?.footprint[0]).toHaveLength(5);
    expect(c?.footprint[0][0]).toEqual(c?.footprint[0][4]);
  });

  it("rejects a multipolygon whose outline does not close", () => {
    const xml = splitOuter("-953").replace(
      "<nd ref='-953' /><nd ref='-952' /><nd ref='-953' />",
      "<nd ref='-952' /><nd ref='-953' />",
    );
    expect(
      compileFixture(xml).errors.some((e) => e.includes("relation -956")),
    ).toBe(true);
  });

  it("lists buildings left out of navigation and requires a name on included ones", () => {
    const xml = building(
      "",
      "  <way id='-940'><nd ref='-950' /><nd ref='-951' /><nd ref='-952' /><nd ref='-953' /><nd ref='-950' /><tag k='building' v='yes' /><tag k='name' v='倉庫' /></way>",
    );
    expect(compileFixture(xml).warnings).toContain(
      "1 棟建築沒標 a11ymap:id，不會納入導航：way/-940（倉庫）",
    );
    const nameless = mutate("<tag k='name' v='測試館' />\n", "");
    expect(compileFixture(nameless).errors).toContain(
      "建築 way/-100（bldg-a）缺少 name",
    );
  });
});

describe("round-3 edge cases", () => {
  it("reads a bare or padded flat incline as no ramp", () => {
    expect(isInclined("0")).toBe(false);
    expect(isInclined(" no ")).toBe(false);
    expect(isInclined("0%")).toBe(false);
    expect(isInclined("up")).toBe(true);
    expect(parseIncline("5")).toBeCloseTo(0.05);
    const flat = compileFixture(
      mutate("<tag k='incline' v='8%' />", "<tag k='incline' v='0' />").replace(
        "<tag k='ramp:wheelchair' v='yes' />",
        "<tag k='ramp:wheelchair' v='no' />",
      ),
    );
    expect(
      flat.venue.edges
        .filter((e) => e.osmRef === "way/-302")
        .map((e) => [e.ramp, e.wheelchair]),
    ).toEqual([[false, "unknown"]]);
  });

  it("interpolates the middle of an indoor same-floor ramp between tagged end heights", () => {
    const xml = FIXTURE.replace(
      "</osm>",
      [
        "  <node id='-960' lat='24.15003000' lon='120.68005000'><tag k='a11ymap:ele' v='0' /></node>",
        "  <node id='-961' lat='24.15003000' lon='120.68010000' />",
        "  <node id='-962' lat='24.15003000' lon='120.68015000'><tag k='a11ymap:ele' v='0.6' /></node>",
        "  <way id='-963'><nd ref='-960' /><nd ref='-961' /><nd ref='-962' /><tag k='highway' v='corridor' /><tag k='level' v='0' /><tag k='incline' v='up' /><tag k='ramp:wheelchair' v='yes' /></way>",
        "</osm>",
      ].join("\n"),
    );
    const { venue, errors } = compileFixture(xml);
    expect(errors).toEqual([]);
    expect(venue.nodes.find((n) => n.id === "-961@0")?.z).toBeCloseTo(0.3, 2);
    expect(
      venueConnections(venue)
        .find((c) => c.id === "way/-963@0")
        ?.coordinates.map((c) => c[2]),
    ).toEqual([0, 0.3, 0.6]);
  });

  it("rejects a gate that is not tagged as an entrance", () => {
    const xml = mutate(
      "<tag k='entrance' v='main' />\n    <tag k='wheelchair' v='yes' />",
      "<tag k='wheelchair' v='yes' />",
    );
    expect(compileFixture(xml).errors).toContain(
      "校門「測試校門」要標 entrance=main 或 entrance=yes；不是出入口的閘門請拿掉 a11ymap:id",
    );
  });

  it("rejects a venue id the API could never serve", () => {
    expect(
      compileVenue(parseOsmXml(FIXTURE), { venueId: "Foo", name: "x" }).errors,
    ).toContain("場域 id「Foo」只能用小寫英數、- 與 _，最多 64 字");
    expect(
      compileVenue(parseOsmXml(FIXTURE), {
        venueId: "a".repeat(65),
        name: "x",
      }).errors.some((e) => e.startsWith("場域 id")),
    ).toBe(true);
  });

  it("rejects a non-finite floor height and an absurd level range", () => {
    const infinite = mutate(
      "<tag k='building:levels' v='3' />",
      "<tag k='building:levels' v='3' />\n    <tag k='a11ymap:floor_height' v='Infinity' />",
    );
    expect(
      compileFixture(infinite).errors.some((e) =>
        e.includes("樓高或地面高差無效"),
      ),
    ).toBe(true);
    expect(parseLevels("0-9007199254740992")).toBeNull();
    expect(parseLevels("0-201")).toBeNull();
    expect(parseLevels("0-3")).toEqual([0, 1, 2, 3]);
  });

  it("warns about a ramp without a width, which wheelchairs still use", () => {
    const { warnings } = compileFixture(
      mutate("<tag k='width' v='1.5' />\n", ""),
    );
    expect(warnings).toContain(
      "1 條坡道沒標 width，輪椅以可通過計算，請量測後補上：way -302",
    );
  });
});

describe("round-7: limits and provenance", () => {
  it("rejects an absurd building height before building its floors", () => {
    const started = Date.now();
    const { errors } = compileFixture(
      mutate(
        "<tag k='building:levels' v='3' />",
        "<tag k='building:levels' v='1000000000' />",
      ),
    );
    expect(errors.some((e) => e.includes("總樓層數超過 200 層"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(parseLevels("0-200;201-401")).toBeNull();
    expect(parseLevels("0-100;101-200")).toHaveLength(201);
  });

  it("carries source, geometry and height status from the tags to the connections", () => {
    const { venue } = compileFixture(
      mutate(
        "<tag k='a11ymap:height_status' v='drawing' />",
        "<tag k='a11ymap:source' v='IMG_0042.jpg' /><tag k='a11ymap:geometry_status' v='surveyed' /><tag k='a11ymap:height_status' v='measured' />",
      ),
    );
    expect(
      venueConnections(venue).find((c) => c.id === "way/-302@0"),
    ).toMatchObject({
      source: "IMG_0042.jpg",
      geometryStatus: "surveyed",
      heightStatus: "measured",
    });
    // untagged stairs default to traced / estimated, without a source
    const stairs = venueConnections(venue).find(
      (c) => c.id === "way/-108@span",
    );
    expect(stairs).toMatchObject({
      geometryStatus: "traced",
      heightStatus: "estimated",
    });
    expect(stairs?.source).toBeUndefined();
  });

  it("keeps the default floor height estimated whatever status is tagged", () => {
    const tagged = (extra: string) =>
      compileFixture(
        mutate(
          "<tag k='building:levels' v='3' />",
          `<tag k='building:levels' v='3' /><tag k='a11ymap:height_status' v='measured' /><tag k='a11ymap:source' v='scan-a' />${extra}`,
        ),
      ).venue.buildings.find((b) => b.id === "bldg-a");
    expect(tagged("")).toMatchObject({
      heightStatus: "estimated",
      source: "scan-a",
    });
    expect(
      tagged("<tag k='a11ymap:floor_height' v='3.9' />")?.heightStatus,
    ).toBe("measured");
  });
});

describe("round-8: combined levels and display levels", () => {
  it("bounds level and repeat_on together, everywhere they are merged", () => {
    const room = compileFixture(
      mutate(
        "<tag k='indoor' v='room' />\n    <tag k='level' v='0' />\n    <tag k='repeat_on' v='1;2' />\n    <tag k='ref' v='{L}06' />\n  </way>",
        "<tag k='indoor' v='room' />\n    <tag k='level' v='0-200' />\n    <tag k='repeat_on' v='201-401' />\n    <tag k='ref' v='{L}06' />\n  </way>",
      ),
    );
    expect(room.errors).toContain(
      "外框 way -110 的 level／repeat_on 格式錯誤，或合計超過 201 層",
    );
    expect(room.venue.features.length).toBeLessThan(20);
    expect(levelsOf({ level: "0-200", repeat_on: "201-401" })).toBeNull();
    expect(
      levelsOf({ level: "0-100", repeat_on: "101-200" })?.all,
    ).toHaveLength(201);
  });

  it("rejects a display outline or door with a malformed level instead of drawing it on 1F", () => {
    const room = compileFixture(
      mutate(
        "<tag k='indoor' v='room' />\n    <tag k='level' v='0' />",
        "<tag k='indoor' v='room' />\n    <tag k='level' v='ground' />",
      ),
    );
    expect(room.errors.some((e) => e.startsWith("外框 way -110"))).toBe(true);
    expect(room.venue.features.some((f) => f.id.startsWith("way/-110@"))).toBe(
      false,
    );
    const door = compileFixture(
      mutate(
        "<tag k='door' v='hinged' />\n    <tag k='wheelchair' v='yes' />\n    <tag k='level' v='0' />",
        "<tag k='door' v='hinged' />\n    <tag k='wheelchair' v='yes' />\n    <tag k='level' v='ground' />",
      ),
    );
    expect(door.errors.some((e) => e.startsWith("門 node -6"))).toBe(true);
  });
});

describe("round-9: floors, grades and provenance of display features", () => {
  it("rejects a room outline or door on a floor the building does not have", () => {
    const room = compileFixture(
      mutate(
        "<tag k='repeat_on' v='1;2' />\n    <tag k='ref' v='{L}06' />\n  </way>",
        "<tag k='repeat_on' v='1;2;3' />\n    <tag k='ref' v='{L}06' />\n  </way>",
      ),
    );
    expect(room.errors).toContain(
      "外框 way -110 在「測試館」的 4F，但該棟沒有這一層",
    );
    expect(room.venue.features.some((f) => f.id === "way/-110@3")).toBe(false);
    const door = compileFixture(
      mutate(
        "<tag k='level' v='0' />\n    <tag k='name' v='A 館北門' />",
        "<tag k='level' v='0' />\n    <tag k='repeat_on' v='5' />\n    <tag k='name' v='A 館北門' />",
      ),
    );
    expect(door.errors).toContain(
      "門 node -6 在「測試館」的 6F，但該棟沒有這一層",
    );
  });

  it("rejects a numeric incline that overflows", () => {
    const huge = `${"9".repeat(310)}%`;
    const { errors } = compileFixture(
      mutate("<tag k='incline' v='8%' />", `<tag k='incline' v='${huge}' />`),
    );
    expect(errors.some((e) => e.startsWith("way -302 的 incline"))).toBe(true);
  });

  it("keeps a room's height status and source", () => {
    const { venue } = compileFixture(
      mutate(
        "<tag k='ref' v='{L}06' />\n  </way>",
        "<tag k='ref' v='{L}06' />\n    <tag k='a11ymap:height_status' v='measured' />\n    <tag k='a11ymap:source' v='IMG_0100.jpg' />\n  </way>",
      ),
    );
    expect(venue.features.find((f) => f.id === "way/-110@0")).toMatchObject({
      heightStatus: "measured",
      source: "IMG_0100.jpg",
    });
    expect(
      compileFixture().venue.features.find((f) => f.id === "way/-110@0")
        ?.heightStatus,
    ).toBe("estimated");
  });
});

describe("round-10: bounds, untagged buildings, open outlines, grade status", () => {
  it("rejects grades and heights that would overflow downstream", () => {
    const grade = compileFixture(
      mutate(
        "<tag k='incline' v='8%' />",
        `<tag k='incline' v='${"9".repeat(41)}%' />`,
      ),
    );
    expect(grade.errors.some((e) => e.startsWith("way -302 的 incline"))).toBe(
      true,
    );
    const floor = compileFixture(
      mutate(
        "<tag k='building:levels' v='3' />",
        "<tag k='building:levels' v='3' /><tag k='a11ymap:floor_height' v='1e308' />",
      ),
    );
    expect(floor.errors.some((e) => e.includes("樓高或地面高差無效"))).toBe(
      true,
    );
    const ele = compileFixture(
      mutate(
        "<tag k='a11ymap:ele' v='1.0' />",
        "<tag k='a11ymap:ele' v='1e400' />",
      ),
    );
    expect(ele.errors.some((e) => e.includes("a11ymap:ele"))).toBe(true);
  });

  it("refuses indoor ways and places inside a building left out of navigation", () => {
    const { errors, venue } = compileFixture(
      mutate("<tag k='a11ymap:id' v='bldg-b' />\n", ""),
    );
    expect(
      errors.some(
        (e) =>
          e.startsWith("way -201") &&
          e.includes("沒標 a11ymap:id 的建築「實驗館」"),
      ),
    ).toBe(true);
    expect(
      errors.some((e) => e.startsWith("地點 node -41") && e.includes("實驗館")),
    ).toBe(true);
    expect(venue.places.some((p) => p.id === "b-lab")).toBe(false);
  });

  it("still allows an outdoor parking spot inside an untagged parking outline", () => {
    const xml = FIXTURE.replace(
      "<node id='-51' action='modify' visible='true' lat='24.14990956' lon='120.68019689' />",
      "<node id='-51' action='modify' visible='true' lat='24.14990956' lon='120.68019689'><tag k='amenity' v='parking' /><tag k='a11ymap:id' v='parking-a' /><tag k='name' v='停車棚' /></node>",
    ).replace(
      "</osm>",
      [
        "  <node id='-980' lat='24.14988000' lon='120.68016000' />",
        "  <node id='-981' lat='24.14988000' lon='120.68023000' />",
        "  <node id='-982' lat='24.14994000' lon='120.68023000' />",
        "  <node id='-983' lat='24.14994000' lon='120.68016000' />",
        "  <way id='-984'><nd ref='-980' /><nd ref='-981' /><nd ref='-982' /><nd ref='-983' /><nd ref='-980' /><tag k='building' v='roof' /><tag k='name' v='停車棚' /></way>",
        "</osm>",
      ].join("\n"),
    );
    const { errors, venue } = compileFixture(xml);
    expect(errors).toEqual([]);
    expect(venue.places.find((p) => p.id === "parking-a")?.kind).toBe(
      "parking",
    );
    expect(venue.places.find((p) => p.id === "parking-a")).not.toHaveProperty(
      "amenity",
    );
  });

  it("rejects a room outline that does not close", () => {
    const xml = mutate(
      "<nd ref='-23' />\n    <nd ref='-20' />\n    <tag k='indoor' v='room' />",
      "<nd ref='-23' />\n    <tag k='indoor' v='room' />",
    );
    expect(compileFixture(xml).errors).toContain(
      "外框 way -110（room）沒有閉合，請在 JOSM 把頭尾接起來",
    );
  });
});

describe("round-11: strict tag values", () => {
  it.each(["1e400%", "Infinity", "steep", "12 percent"])(
    "rejects incline=%s instead of treating it as a direction",
    (value) => {
      const { errors } = compileFixture(
        mutate(
          "<tag k='incline' v='8%' />",
          `<tag k='incline' v='${value}' />`,
        ),
      );
      expect(errors.some((e) => e.startsWith("way -302 的 incline"))).toBe(
        true,
      );
    },
  );

  it("accepts direction-only inclines and reads them as ramps", () => {
    for (const value of ["up", "down", "yes"]) {
      expect(inclineOf(value)).toEqual({ inclined: true });
    }
    expect(inclineOf("0")).toEqual({ inclined: false, grade: 0 });
    expect(inclineOf("no")).toEqual({ inclined: false });
  });

  it("does not read an empty height as 0", () => {
    expect(tagNumber("")).toBeNaN();
    expect(tagNumber(" 1.5 ")).toBe(1.5);
    expect(tagNumber(undefined)).toBeUndefined();
    const ele = compileFixture(
      mutate("<tag k='a11ymap:ele' v='1.0' />", "<tag k='a11ymap:ele' v='' />"),
    );
    expect(ele.errors.some((e) => e.includes("a11ymap:ele"))).toBe(true);
    const offset = compileFixture(
      mutate(
        "<tag k='building:levels' v='3' />",
        "<tag k='building:levels' v='3' /><tag k='a11ymap:ground_offset' v=' ' />",
      ),
    );
    expect(offset.errors.some((e) => e.includes("樓高或地面高差無效"))).toBe(
      true,
    );
  });

  const untaggedSquare = [
    "  <node id='-990' lat='24.14960000' lon='120.68060000' />",
    "  <node id='-991' lat='24.14960000' lon='120.68070000' />",
    "  <node id='-992' lat='24.14970000' lon='120.68070000' />",
    "  <node id='-993' lat='24.14970000' lon='120.68060000' />",
    "  <way id='-994'><nd ref='-990' /><nd ref='-991' /><nd ref='-992' /><nd ref='-993' /><nd ref='-990' /><tag k='building' v='yes' /><tag k='name' v='倉庫' /></way>",
  ];

  it("only exempts gates, not other barriers, from the untagged-building rule", () => {
    const xml = FIXTURE.replace(
      "</osm>",
      [
        ...untaggedSquare,
        "  <node id='-995' lat='24.14965000' lon='120.68065000'><tag k='barrier' v='bollard' /><tag k='level' v='0' /><tag k='a11ymap:id' v='bollard' /></node>",
        "  <node id='-996' lat='24.14965000' lon='120.68080000' />",
        "  <way id='-997'><nd ref='-995' /><nd ref='-996' /><tag k='highway' v='footway' /></way>",
        "</osm>",
      ].join("\n"),
    );
    expect(
      compileFixture(xml).errors.some(
        (e) => e.startsWith("地點 node -995") && e.includes("倉庫"),
      ),
    ).toBe(true);
  });

  it("rejects an indoor way that only partly enters an untagged building", () => {
    const xml = FIXTURE.replace(
      "</osm>",
      [
        ...untaggedSquare,
        // first vertex inside the outline, second outside
        "  <node id='-9998' lat='24.14965000' lon='120.68065000' />",
        "  <node id='-9999' lat='24.14965000' lon='120.68090000' />",
        "  <way id='-1000'><nd ref='-9998' /><nd ref='-9999' /><tag k='highway' v='corridor' /><tag k='level' v='0' /></way>",
        "</osm>",
      ].join("\n"),
    );
    expect(
      compileFixture(xml).errors.some(
        (e) => e.startsWith("way -1000") && e.includes("倉庫"),
      ),
    ).toBe(true);
  });
});
