import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import { buildVenueGraph } from "./venue.graph";
import { planVenueRoute } from "./venue.route";
import type { AccessibilityMode } from "../../types/route";
import { VenueRouteSchema } from "../accessible-route/venue-leg.schema";

const xml = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
);
const config = {
  stairsAvoidanceMultiplier: 4,
  elevatorWaitS: 30,
  elevatorPerFloorS: 3,
};
const stairs = "<way id='-205' action='modify' visible='true'>";
function compiled(source: string) {
  const result = compileVenue(parseOsmXml(source), {
    venueId: "mini",
    name: "Mini",
  });
  expect(result.errors).toEqual([]);
  const data = result.venue;
  const graph = buildVenueGraph(data, 1, config);
  const from = data.places.find((p) => p.id === "gate-main");
  const to = data.places.find((p) => p.id === "b-lab");
  if (!from || !to) throw new Error("missing fixture places");
  return {
    data,
    plan: (
      mode: AccessibilityMode,
      lang: "en" | "zh-TW" = "en",
      deadlineMs?: number,
    ) =>
      planVenueRoute(graph, data, from, to, mode, config, lang, { deadlineMs }),
  };
}
function stairTags(tags: string) {
  expect(xml).toContain(stairs);
  return xml.replace(stairs, stairs + tags);
}

describe("source-backed venue staircase policy negatives", () => {
  it("permits intrinsic staircase wheelchair=no and steep incline only as an explicitly warned backup", () => {
    const v = compiled(
      stairTags(
        "<tag k='wheelchair' v='no'/><tag k='incline' v='60%'/><tag k='ramp' v='yes'/>",
      ),
    );
    for (const lang of ["en", "zh-TW"] as const) {
      const result = v.plan("wheelchair", lang);
      if (!result.ok) throw new Error(result.reason);
      expect(VenueRouteSchema.parse(result.route)).toMatchObject({
        stairsFallback: true,
        stairFlights: 1,
      });
      expect(result.route.warningDetails?.[0]).toMatchObject({
        index: 0,
        code: "ROUTE_WHEELCHAIR_STAIRS_FALLBACK",
        message: result.route.warnings?.[0],
      });
      expect(result.route.warnings?.[0]).toMatch(
        lang === "en" ? /assistance/i : /無法自行/,
      );
      expect(result.route.steps.some((s) => s.type === "stairs")).toBe(true);
      expect(
        result.route.steps.some(
          (s) => s.type === "ramp" && s.connectionId === "way/-205@span",
        ),
      ).toBe(false);
    }
    expect(v.plan("normal")).toMatchObject({
      ok: true,
      route: { stairsFallback: false, warnings: [] },
    });
  });

  it.each([
    "<tag k='foot' v='no'/>",
    "<tag k='access' v='private'/>",
    "<tag k='access' v='no'/>",
  ])(
    "retains source prohibition %s independently of stair identity",
    (tags) => {
      const v = compiled(stairTags(tags));
      expect(
        v.data.edges.find((e) => e.osmRef === "way/-205")?.accessDenied,
      ).toBe(true);
      for (const mode of ["normal", "wheelchair"] as const)
        expect(v.plan(mode).ok).toBe(false);
    },
  );

  it("preserves explicit pedestrian authorization on an otherwise private way", () => {
    const v = compiled(
      stairTags("<tag k='access' v='private'/><tag k='foot' v='yes'/>"),
    );
    expect(
      v.data.edges.find((e) => e.osmRef === "way/-205")?.accessDenied,
    ).toBeUndefined();
    expect(v.plan("normal").ok).toBe(true);
    expect(v.plan("wheelchair")).toMatchObject({
      ok: true,
      route: { stairsFallback: true },
    });
  });

  it.each(["foot", "access"])(
    "retains a separate %s=no stair landing restriction",
    (key) => {
      const v = compiled(
        xml.replace(
          "<tag k='level' v='1' />\n  </node>\n  <node id='-41'",
          `<tag k='level' v='1' /><tag k='${key}' v='no'/>\n  </node>\n  <node id='-41'`,
        ),
      );
      expect(
        v.data.edges.find((e) => e.osmRef === "way/-205")?.accessDenied,
      ).toBe(true);
      expect(v.plan("wheelchair").ok).toBe(false);
      expect(v.plan("normal").ok).toBe(false);
    },
  );

  it("does not waive wheelchair=no on a separate landing node even when incident to stairs", () => {
    const v = compiled(
      xml.replace(
        "<tag k='level' v='1' />\n  </node>\n  <node id='-41'",
        "<tag k='level' v='1' /><tag k='wheelchair' v='no'/>\n  </node>\n  <node id='-41'",
      ),
    );
    expect(
      v.data.edges.find((e) => e.osmRef === "way/-205")?.wheelchairBarrier,
    ).toBe(true);
    expect(v.plan("wheelchair")).toMatchObject({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
    });
    expect(v.plan("normal").ok).toBe(true);
  });

  it("retains known stair width and never mutates compiled source across requests", () => {
    const v = compiled(stairTags("<tag k='width' v='0.4'/>"));
    const before = JSON.stringify(v.data);
    expect(v.plan("wheelchair")).toMatchObject({
      ok: false,
      reason: "NO_ACCESSIBLE_ROUTE",
    });
    expect(v.plan("normal").ok).toBe(true);
    expect(v.plan("wheelchair", "en", Date.now() - 1)).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });
    expect(JSON.stringify(v.data)).toBe(before);
  });

  it.each([
    "<tag k='locked' v='yes'/>",
    "<tag k='barrier' v='wall'/>",
    "<tag k='barrier' v='fence'/>",
  ])("retains an explicit closed landing %s", (tags) => {
    const v = compiled(
      xml.replace(
        "<tag k='level' v='1' />\n  </node>\n  <node id='-41'",
        `<tag k='level' v='1' />${tags}\n  </node>\n  <node id='-41'`,
      ),
    );
    expect(
      v.data.edges.find((e) => e.osmRef === "way/-205")?.accessDenied,
    ).toBe(true);
    expect(v.plan("normal").ok).toBe(false);
    expect(v.plan("wheelchair").ok).toBe(false);
  });

  it("preserves the minimum clear door width on a staircase landing", () => {
    const v = compiled(
      xml.replace(
        "<tag k='level' v='1' />\n  </node>\n  <node id='-41'",
        "<tag k='level' v='1' /><tag k='door' v='yes'/><tag k='width' v='0.4'/>\n  </node>\n  <node id='-41'",
      ),
    );
    expect(v.data.edges.find((e) => e.osmRef === "way/-205")?.widthM).toBe(0.4);
    expect(v.plan("wheelchair").ok).toBe(false);
    expect(v.plan("normal").ok).toBe(true);
  });

  it("does not treat a deadline exhausted inside strict search as proof that stairs are required", () => {
    const v = compiled(xml);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(101);
    try {
      expect(v.plan("wheelchair", "en", 100)).toEqual({
        ok: false,
        reason: "UNAVAILABLE",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("does not invent access or barrier observations when tags are absent", () => {
    const edge = compiled(xml).data.edges.find((e) => e.osmRef === "way/-205");
    expect(edge?.accessDenied).toBeUndefined();
    expect(edge?.wheelchairBarrier).toBeUndefined();
    expect(edge?.widthM).toBeUndefined();
  });
});
