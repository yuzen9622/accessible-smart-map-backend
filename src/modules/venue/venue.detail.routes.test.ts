import { readFileSync } from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

vi.mock("./venue.repository", () => ({
  findVenueVersion: vi.fn(),
  findVenue: vi.fn(),
  listVenueSummaries: vi.fn(),
}));

import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import * as repository from "./venue.repository";
import { clearVenueCache } from "./venue.service";
import type { VenueDocument } from "./venue.types";

const { venue } = compileVenue(
  parseOsmXml(
    readFileSync(path.join(__dirname, "__fixtures__/mini-campus.osm"), "utf8"),
  ),
  { venueId: "mini", name: "Mini" },
);
let app: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(app);
});
beforeEach(() => {
  vi.resetAllMocks();
  clearVenueCache();
});

describe("venue detail HTTP projection", () => {
  it("sends the real service projection including campus walkways and unresolved annotations", async () => {
    const stored: VenueDocument = {
      ...structuredClone(venue),
      version: 12,
      importedAt: new Date(0),
      source: { file: "mini-campus.osm", sha256: "a".repeat(64) },
      warnings: [],
    };
    stored.buildings[0].heightPending = true;
    stored.buildings[0].note = "電梯停靠樓層尚待確認";
    stored.features[0].fixme = "補拍樓層參考照片";
    const walkway = stored.edges.find(
      (edge) => edge.kind === "footway" && !edge.ramp,
    );
    if (!walkway) throw new Error("fixture lacks an ordinary footway");
    walkway.note = "跨棟步道";
    vi.mocked(repository.findVenueVersion).mockResolvedValue(12);
    vi.mocked(repository.findVenue).mockResolvedValue(stored);

    const res = await request(app).get("/api/v1/a11y/venues/mini");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      code: 200,
      data: {
        venueId: "mini",
        version: 12,
        importedAt: "1970-01-01T00:00:00.000Z",
        sourceSha256: "a".repeat(64),
      },
    });
    expect(res.body.data.buildings[0]).toMatchObject({
      heightPending: true,
      note: "電梯停靠樓層尚待確認",
      levels: expect.arrayContaining([
        expect.objectContaining({
          ref: "1F",
          coverage: {
            hasAnchor: true,
            hasRouteData: true,
            hasDisplayGeometry: true,
          },
        }),
      ]),
    });
    expect(res.body.data.features[0].fixme).toBe("補拍樓層參考照片");
    expect(
      res.body.data.walkways.find(
        (way: { id: string }) => way.id === walkway.id,
      ),
    ).toMatchObject({
      note: "跨棟步道",
      coordinates: expect.any(Array),
      buildingIds: expect.any(Array),
      levelRefs: expect.any(Array),
    });
    expect(
      res.body.data.connections.some(
        (connection: { kind: string }) => connection.kind === "elevator",
      ),
    ).toBe(true);
  });

  it("serves source classifications, reciprocal facility topology, walls and corridor arrivals without a sidecar", async () => {
    const osm = parseOsmXml(
      readFileSync(
        path.join(__dirname, "__fixtures__/mini-campus.osm"),
        "utf8",
      ),
    );
    const elevator = osm.nodes.get("-11");
    if (!elevator) throw new Error("fixture lacks elevator");
    elevator.tags.ref = "E-A";
    const corners: [number, number][] = [
      [elevator.lon - 0.00001, elevator.lat - 0.00001],
      [elevator.lon + 0.00001, elevator.lat - 0.00001],
      [elevator.lon + 0.00001, elevator.lat + 0.00001],
      [elevator.lon - 0.00001, elevator.lat + 0.00001],
    ];
    const ids = corners.map(([lon, lat], i) => {
      const id = `-990${i}`;
      osm.nodes.set(id, { id, lon, lat, tags: {} });
      return id;
    });
    osm.ways.set("-9910", {
      id: "-9910",
      nodeIds: [...ids, ids[0]],
      tags: {
        indoor: "area",
        level: "0",
        repeat_on: "1",
        "a11ymap:area_type": "elevator-shaft",
        "private:unused": "not-public",
      },
    });
    osm.ways.set("-9911", {
      id: "-9911",
      nodeIds: ["-20", "-21"],
      tags: {
        indoor: "wall",
        level: "0",
        "a11ymap:geometry_status": "traced",
        "a11ymap:height_status": "drawing",
        note: "No surveyed door opening",
      },
    });
    const room = osm.ways.get("-110");
    if (!room) throw new Error("fixture lacks room");
    osm.ways.set("-9912", {
      ...room,
      id: "-9912",
      tags: { indoor: "area", level: "0", amenity: "toilets" },
    });
    const result = compileVenue(osm, { venueId: "mini", name: "Mini" });
    expect(result.errors).toEqual([]);
    const stored: VenueDocument = {
      ...result.venue,
      version: 13,
      importedAt: new Date(0),
      source: { file: "fictional-campus.osm", sha256: "b".repeat(64) },
      warnings: [],
    };
    vi.mocked(repository.findVenueVersion).mockResolvedValue(13);
    vi.mocked(repository.findVenue).mockResolvedValue(stored);

    const response = await request(app).get("/api/v1/a11y/venues/mini");
    expect(response.status).toBe(200);
    const detail = response.body.data;
    expect(
      detail.features.find((f: { id: string }) => f.id === "way/-9910@0"),
    ).toMatchObject({
      kind: "area",
      osmRef: "way/-9910",
      tags: { indoor: "area", "a11ymap:area_type": "elevator-shaft" },
      connectionId: "node/-11",
      connectionIds: ["node/-11"],
    });
    expect(
      detail.features.find((f: { id: string }) => f.id === "way/-9910@0").tags,
    ).not.toHaveProperty("private:unused");
    expect(
      detail.features.find((f: { id: string }) => f.id === "way/-9912@0").tags
        .amenity,
    ).toBe("toilets");
    const lift = detail.connections.find(
      (c: { id: string }) => c.id === "node/-11",
    );
    expect(lift).toMatchObject({
      name: "A 館電梯",
      ref: "E-A",
      nodeIds: ["-11@0", "-11@1", "-11@2"],
      levelRefs: ["1F", "2F", "3F"],
      featureIds: expect.arrayContaining(["way/-9910@0", "way/-9910@1"]),
    });
    expect(lift.nodeIds).toHaveLength(lift.coordinates.length);
    const nodes = new Map(stored.nodes.map((node) => [node.id, node]));
    for (const walkway of detail.walkways) {
      expect(
        walkway.nodeIds.map((id: string) => {
          const node = nodes.get(id);
          if (!node) throw new Error(`missing node ${id}`);
          return [node.lng, node.lat, node.z];
        }),
      ).toEqual(walkway.coordinates);
    }
    expect(detail.walls).toEqual([
      expect.objectContaining({
        id: "way/-9911@0",
        osmRef: "way/-9911",
        buildingId: "bldg-a",
        levelRef: "1F",
        geometry: {
          type: "LineString",
          coordinates: [
            [osm.nodes.get("-20")?.lon, osm.nodes.get("-20")?.lat],
            [osm.nodes.get("-21")?.lon, osm.nodes.get("-21")?.lat],
          ],
        },
        thicknessM: null,
        note: "No surveyed door opening",
      }),
    ]);
    expect(
      detail.features.find((f: { id: string }) => f.id === "way/-110@0")
        .geometry.coordinates[0],
    ).toEqual(
      room.nodeIds.map((id) => [
        osm.nodes.get(id)?.lon,
        osm.nodes.get(id)?.lat,
      ]),
    );
    expect(
      detail.places.find((p: { id: string }) => p.id === "a-room06@3F"),
    ).toMatchObject({
      featureId: "way/-110@2",
      arrivalKind: "corridor",
      doorKnown: false,
    });

    const routeResponse = await request(app)
      .post("/api/v1/a11y/venues/mini/route")
      .send({
        fromPlaceId: "bldg-a@1F",
        toPlaceId: "a-room06@3F",
        mode: "elderly",
      });
    expect(routeResponse.status).toBe(200);
    const steps = routeResponse.body.data.steps;
    expect(
      steps.find((step: { type: string }) => step.type === "elevator")
        .connectionId,
    ).toBe(lift.id);
    expect(steps.at(-1).instruction).toContain("走廊");
    for (const mode of ["elderly", "visual_impaired"]) {
      const inaccessible = await request(app)
        .post("/api/v1/a11y/venues/mini/route")
        .send({
          fromPlaceId: "gate-main",
          toPlaceId: "b-lab",
          mode,
        });
      expect(inaccessible.status).toBe(422);
      expect(inaccessible.body.data.reason).toBe("NO_ACCESSIBLE_ROUTE");
    }
  });
});
