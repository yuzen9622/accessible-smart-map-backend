import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./venue.repository", () => ({
  findVenueVersion: vi.fn(),
  findVenue: vi.fn(),
  listVenueSummaries: vi.fn(),
}));
import * as repository from "./venue.repository";
import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import { clearVenueCache } from "./venue.service";
import { createVenueRouter } from "./venue.router";
import { VenueRouteSchema } from "../accessible-route/venue-leg.schema";

const xml = readFileSync(
  path.join(__dirname, "__fixtures__/mini-campus.osm"),
  "utf8",
);
const app = express();
app.use(express.json());
app.use("/api/v1/a11y", createVenueRouter());
function use(source = xml) {
  const out = compileVenue(parseOsmXml(source), {
    venueId: "mini",
    name: "Mini",
  });
  expect(out.errors).toEqual([]);
  vi.mocked(repository.findVenueVersion).mockResolvedValue(3);
  vi.mocked(repository.findVenue).mockResolvedValue({
    ...out.venue,
    version: 3,
    importedAt: new Date(0),
    warnings: [],
    source: { file: "mini-campus.osm", sha256: "a".repeat(64) },
  });
  clearVenueCache();
}
const route = (body = {}) =>
  request(app)
    .post("/api/v1/a11y/venues/mini/route")
    .send({
      fromPlaceId: "gate-main",
      toPlaceId: "b-lab",
      ...body,
    });
beforeEach(() => {
  vi.resetAllMocks();
  use();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearVenueCache();
});

describe("venue HTTP uses the real source/compiler/search/service policy", () => {
  it.each(["en", "zh-TW"])(
    "delivers a typed warned wheelchair backup in %s",
    async (language) => {
      const response = await route({ language });
      expect(response.status).toBe(200);
      const result = VenueRouteSchema.parse(response.body.data);
      expect(result).toMatchObject({
        stairsFallback: true,
        stairFlights: 1,
        venueVersion: 3,
      });
      expect(result.steps.some((step) => step.type === "stairs")).toBe(true);
      expect(result.warningDetails?.[0]).toMatchObject({
        code: "ROUTE_WHEELCHAIR_STAIRS_FALLBACK",
        message: result.warnings?.[0],
      });
      expect(result.warnings?.[0]).toMatch(
        language === "en" ? /assistance/i : /無法自行/,
      );
    },
  );
  it("keeps ordinary stairs ordinary and a reachable wheelchair elevator route step-free", async () => {
    const normal = await route({ mode: "normal" });
    expect(normal.status).toBe(200);
    expect(normal.body.data).toMatchObject({
      stairsFallback: false,
      stairFlights: 1,
      warnings: [],
    });
    const stepFree = await route({ toPlaceId: "a-room06@2F" });
    expect(stepFree.status).toBe(200);
    expect(stepFree.body.data).toMatchObject({
      stairsFallback: false,
      stairFlights: 0,
      elevatorRides: 1,
      warnings: [],
    });
  });
  it.each(["normal", "wheelchair"])(
    "does not turn a source foot=no closure into a delivered %s route",
    async (mode) => {
      use(
        xml.replace(
          "<way id='-205' action='modify' visible='true'>",
          "<way id='-205' action='modify' visible='true'><tag k='foot' v='no'/>",
        ),
      );
      const response = await route({ mode });
      expect(response.status).toBe(422);
      expect(response.body.data.reason).toBe("NO_ROUTE");
      expect(response.body.data.stairsFallback).toBeUndefined();
    },
  );
  it("reports an exhausted search as 503 instead of 422 or a staircase backup", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000_000));
    const response = await route();
    expect(response.status).toBe(503);
    expect(response.body.data.reason).toBe("UPSTREAM_TIMEOUT");
    expect(response.body.data.stairsFallback).toBeUndefined();
  });
});
