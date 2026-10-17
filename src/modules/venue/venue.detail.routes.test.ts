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
});
