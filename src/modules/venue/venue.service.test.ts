import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./venue.repository", () => ({
  findVenueVersion: vi.fn(),
  findVenue: vi.fn(),
  listVenueSummaries: vi.fn(),
}));

import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import * as repository from "./venue.repository";
import {
  clearVenueCache,
  getCompiledVenue,
  getVenueDetail,
  inspectVenueByQuery,
  isVenueArrivalCurrent,
  planVenueRoute,
  replanVenueLeg,
  resolveVenueArrival,
} from "./venue.service";
import type { VenueDocument } from "./venue.types";

const { venue } = compileVenue(
  parseOsmXml(
    readFileSync(path.join(__dirname, "__fixtures__/mini-campus.osm"), "utf8"),
  ),
  { venueId: "mini", name: "Mini" },
);
const doc = (version: number): VenueDocument => ({
  ...structuredClone(venue),
  version,
  importedAt: new Date(0),
  source: { file: "mini-campus.osm", sha256: "x" },
  warnings: [],
});

beforeEach(() => {
  vi.resetAllMocks();
  clearVenueCache();
});

describe("venue graph cache", () => {
  it("compiles once per version and rebuilds after a newer import", async () => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(1);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(1));
    const first = await getCompiledVenue("mini");
    const second = await getCompiledVenue("mini");
    expect(first?.version).toBe(1);
    expect(second).toBe(first);
    expect(repository.findVenue).toHaveBeenCalledTimes(1);

    vi.mocked(repository.findVenueVersion).mockResolvedValue(2);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(2));
    expect((await getCompiledVenue("mini"))?.version).toBe(2);
  });

  it("shares one build between concurrent requests for the same version", async () => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(5);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(5));
    const [a, b] = await Promise.all([
      getCompiledVenue("mini"),
      getCompiledVenue("mini"),
    ]);
    expect(a).toBe(b);
    expect(repository.findVenue).toHaveBeenCalledTimes(1);
  });

  it("never hands a request that observed V2 a V1 graph", async () => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(2);
    vi.mocked(repository.findVenue)
      .mockResolvedValueOnce(doc(1))
      .mockResolvedValueOnce(doc(2));
    expect((await getCompiledVenue("mini"))?.version).toBe(2);
    expect(repository.findVenue).toHaveBeenCalledTimes(2);
  });

  it("compiles once when requests that observed V1 and V2 both read the V2 document", async () => {
    vi.mocked(repository.findVenueVersion)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(2));
    const [a, b] = await Promise.all([
      getCompiledVenue("mini"),
      getCompiledVenue("mini"),
    ]);
    expect(a?.version).toBe(2);
    expect(b).toBe(a);
  });

  it("fails instead of serving a graph older than the observed version", async () => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(3);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(2));
    await expect(getCompiledVenue("mini")).rejects.toThrow(/stayed older/);
    expect(repository.findVenue).toHaveBeenCalledTimes(3);
  });
});

describe("getVenueDetail", () => {
  it("projects floor coverage, walkways and the import source hash from the stored venue", async () => {
    const stored = doc(1);
    stored.buildings[0].levels.push({
      ordinal: 9,
      ref: "10F",
      elevationM: 32.4,
    });
    vi.mocked(repository.findVenueVersion).mockResolvedValue(1);
    vi.mocked(repository.findVenue).mockResolvedValue(stored);
    const detail = await getVenueDetail("mini");
    expect(detail?.sourceSha256).toBe("x");
    expect(detail?.walkways.some((way) => way.kind === "footway")).toBe(true);
    expect(
      detail?.buildings[0].levels.find((level) => level.ref === "10F")
        ?.coverage,
    ).toEqual({
      hasAnchor: false,
      hasRouteData: false,
      hasDisplayGeometry: false,
    });
    expect(
      detail?.buildings[0].levels.find((level) => level.ref === "1F")?.coverage,
    ).toEqual({
      hasAnchor: true,
      hasRouteData: true,
      hasDisplayGeometry: true,
    });
  });

  it("returns no pending annotations and a null hash for legacy documents without provenance", async () => {
    const stored = doc(1);
    Reflect.deleteProperty(stored, "source");
    Reflect.deleteProperty(stored, "walls");
    vi.mocked(repository.findVenueVersion).mockResolvedValue(1);
    vi.mocked(repository.findVenue).mockResolvedValue(stored);
    const detail = await getVenueDetail("mini");
    expect(detail?.sourceSha256).toBeNull();
    expect(detail?.walls).toEqual([]);
    expect(
      detail?.walkways.every((way) => way.heightPending === undefined),
    ).toBe(true);
    expect(
      detail?.connections.every(
        (connection) => connection.heightPending === undefined,
      ),
    ).toBe(true);
  });

  it("preserves stored display semantics, polygon rings, arrival metadata and source walls", async () => {
    const stored = doc(1);
    const feature = stored.features.find(
      (candidate) => candidate.geometry.type === "Polygon",
    );
    const place = stored.places.find((candidate) => candidate.kind === "room");
    if (!feature || !place || feature.geometry.type !== "Polygon") {
      throw new Error("fixture lacks a room polygon or place");
    }
    feature.tags = {
      indoor: "area",
      amenity: "toilets",
      "a11ymap:area_type": "elevator-shaft",
      ref: "101",
    };
    feature.osmRef = "way/source-feature";
    feature.connectionId = "node/-11";
    feature.connectionIds = ["node/-11"];
    feature.geometry.coordinates.push([
      [120.68018, 24.1501],
      [120.68019, 24.1501],
      [120.68019, 24.15011],
      [120.68018, 24.1501],
    ]);
    place.featureId = feature.id;
    place.arrivalKind = "corridor";
    place.doorKnown = false;
    place.connectionIds = ["node/-11"];
    stored.walls = [
      {
        id: "way/source-wall@0",
        osmRef: "way/source-wall",
        buildingId: "bldg-a",
        ordinal: 0,
        levelRef: "1F",
        geometry: {
          type: "LineString",
          coordinates: [
            [120.6801, 24.1501],
            [120.6802, 24.1501],
          ],
        },
        geometryStatus: "traced",
        heightStatus: "estimated",
        thicknessM: null,
        note: "來源沒有門位",
      },
    ];
    const expected = structuredClone(stored);
    vi.mocked(repository.findVenueVersion).mockResolvedValue(1);
    vi.mocked(repository.findVenue).mockResolvedValue(stored);
    const detail = await getVenueDetail("mini");
    expect(detail?.features).toEqual(expected.features);
    expect(detail?.places).toEqual(expected.places);
    expect(detail?.walls).toEqual(expected.walls);
    expect(
      detail?.connections.find((connection) => connection.id === "node/-11")
        ?.featureIds,
    ).toContain(feature.id);
  });

  it("returns the stairs, ramps and elevators with their heights", async () => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(1);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(1));
    const detail = await getVenueDetail("mini");
    expect(detail?.connections.map((c) => c.kind).sort()).toEqual([
      "elevator",
      "ramp",
      "stairs",
      "stairs",
      "stairs",
      "steps",
    ]);
    expect(
      detail?.connections.find((c) => c.kind === "elevator")?.coordinates,
    ).toHaveLength(3);
    // provenance survives the stored document and reaches the API shape
    expect(
      detail?.connections.every((c) => c.geometryStatus && c.heightStatus),
    ).toBe(true);
  });
});

describe("planVenueRoute", () => {
  beforeEach(() => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(4);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(4));
  });

  it("returns 404 for an unknown venue and an unknown place", async () => {
    vi.mocked(repository.findVenueVersion).mockResolvedValueOnce(null);
    expect(
      await planVenueRoute({
        venueId: "nope",
        fromPlaceId: "a",
        toPlaceId: "b",
        mode: "normal",
        lang: "zh-TW",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await planVenueRoute({
        venueId: "mini",
        fromPlaceId: "gate-main",
        toPlaceId: "nowhere",
        mode: "normal",
        lang: "zh-TW",
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it.each(["wheelchair", "elderly", "visual_impaired"] as const)(
    "maps a stairs-only destination to 422 NO_ACCESSIBLE_ROUTE for %s with venueAccessibility",
    async (mode) => {
      const r = await planVenueRoute({
        venueId: "mini",
        fromPlaceId: "gate-main",
        toPlaceId: "b-lab",
        mode,
        lang: "zh-TW",
      });
      expect(r).toMatchObject({
        ok: false,
        status: 422,
        data: {
          reason: "NO_ACCESSIBLE_ROUTE",
          venueAccessibility: {
            venueId: "mini",
            placeId: "b-lab",
            levelRef: "2F",
            stepFreeReachable: false,
          },
        },
      });
    },
  );

  it("returns the route with the version it was planned on", async () => {
    const r = await planVenueRoute({
      venueId: "mini",
      fromPlaceId: "gate-main",
      toPlaceId: "a-room06@2F",
      mode: "wheelchair",
      lang: "zh-TW",
    });
    expect(r.ok && r.route.venueVersion).toBe(4);
  });
});

describe("venue arrival for outdoor routes", () => {
  const gate = venue.places.find((p) => p.id === "gate-main");
  if (!gate) throw new Error("fixture has no gate-main");
  const gateLocation = { lat: gate.location[1], lng: gate.location[0] };
  const origin = { lat: gateLocation.lat - 0.002, lng: gateLocation.lng };

  beforeEach(() => {
    vi.mocked(repository.findVenueVersion).mockResolvedValue(3);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(3));
  });

  it("picks the gate, plans the indoor leg and records the version used", async () => {
    const r = await resolveVenueArrival({
      venueId: "mini",
      placeId: "a-room06@2F",
      origin,
      mode: "wheelchair",
      lang: "zh-TW",
    });
    expect(r).toMatchObject({
      ok: true,
      venueArrival: {
        venueId: "mini",
        placeId: "a-room06@2F",
        gateId: "gate-main",
        mode: "wheelchair",
        venueVersion: 3,
        gateLocation,
      },
    });
    expect(r.ok && r.venueLeg.steps.map((s) => s.type)).toContain("elevator");
  });

  it("fails closed: 404 for unknown ids, 422 when no gate reaches the place step-free", async () => {
    expect(
      await resolveVenueArrival({
        venueId: "mini",
        placeId: "nowhere",
        origin,
        mode: "normal",
        lang: "zh-TW",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await resolveVenueArrival({
        venueId: "mini",
        placeId: "b-lab",
        origin,
        mode: "wheelchair",
        lang: "zh-TW",
      }),
    ).toMatchObject({
      ok: false,
      status: 422,
      data: {
        reason: "NO_ACCESSIBLE_ROUTE",
        venueAccessibility: { placeId: "b-lab", levelRef: "2F" },
      },
    });
  });

  const arrival = (overrides = {}) => ({
    venueId: "mini",
    placeId: "a-room06@2F",
    gateId: "gate-main",
    gateLocation,
    mode: "wheelchair" as const,
    venueVersion: 1,
    ...overrides,
  });

  it("treats a missing or moved gate as stale and an unchanged gate as current", async () => {
    expect(await isVenueArrivalCurrent(arrival())).toBe(true);
    expect(
      await isVenueArrivalCurrent(
        arrival({
          gateLocation: {
            lat: gateLocation.lat + 0.0001,
            lng: gateLocation.lng,
          },
        }),
      ),
    ).toBe(false);
    expect(await isVenueArrivalCurrent(arrival({ gateId: "gone" }))).toBe(
      false,
    );
    expect(await isVenueArrivalCurrent(arrival({ placeId: "gone" }))).toBe(
      false,
    );
  });

  it("rebuilds the leg on the current version from the same gate", async () => {
    const r = await replanVenueLeg(arrival({ venueVersion: 1 }), "zh-TW");
    expect(r).toMatchObject({
      ok: true,
      venueArrival: { gateId: "gate-main", venueVersion: 3 },
    });
    expect(await replanVenueLeg(arrival({ gateId: "gone" }), "zh-TW")).toEqual({
      ok: false,
      stale: true,
    });
    expect(
      await replanVenueLeg(arrival({ placeId: "b-lab" }), "zh-TW"),
    ).toMatchObject({ ok: false, status: 422 });
  });
});

describe("gate choice", () => {
  const XML = readFileSync(
    path.join(__dirname, "__fixtures__/mini-campus.osm"),
    "utf8",
  );
  /** Fixture plus a side gate 5 m south-east of B, joined to B's door. */
  const withSideGate = (gateTags: string, wayTags: string) =>
    XML.replace(
      "</osm>",
      [
        `  <node id='-60' lat='24.15030000' lon='120.68059000'><tag k='barrier' v='gate' /><tag k='entrance' v='yes' /><tag k='a11ymap:id' v='gate-side' /><tag k='name' v='側門' />${gateTags}</node>`,
        `  <way id='-307'><nd ref='-60' /><nd ref='-34' />${wayTags}</way>`,
        "</osm>",
      ].join("\n"),
    );
  const useVenue = (xml: string) => {
    const compiled = compileVenue(parseOsmXml(xml), {
      venueId: "mini",
      name: "Mini",
    });
    expect(compiled.errors).toEqual([]);
    vi.mocked(repository.findVenueVersion).mockResolvedValue(1);
    vi.mocked(repository.findVenue).mockResolvedValue({
      ...compiled.venue,
      version: 1,
      importedAt: new Date(0),
      source: { file: "x.osm", sha256: "x" },
      warnings: [],
    });
  };
  // east of campus: about as far from the main gate as from the side gate
  const origin = { lat: 24.1501, lng: 120.683 };
  const gateFor = async (
    placeId: string,
    mode: "wheelchair" | "elderly" | "visual_impaired" | "normal",
  ) => {
    const r = await resolveVenueArrival({
      venueId: "mini",
      placeId,
      origin,
      mode,
      lang: "zh-TW",
    });
    return r.ok ? r.venueArrival.gateId : r;
  };

  it("uses a gate without wheelchair=yes only for normal walkers", async () => {
    useVenue(withSideGate("", "<tag k='highway' v='footway' />"));
    expect(await gateFor("bldg-b@1F", "normal")).toBe("gate-side");
    expect(await gateFor("bldg-b@1F", "wheelchair")).toBe("gate-main");
    expect(await gateFor("bldg-b@1F", "elderly")).toBe("gate-main");
  });

  it.each(["elderly", "visual_impaired"] as const)(
    "excludes a stairs-only gate for %s and searches the usable alternative gate",
    async (mode) => {
      useVenue(
        withSideGate(
          "<tag k='wheelchair' v='yes' />",
          "<tag k='highway' v='steps' /><tag k='step_count' v='40' />",
        ),
      );
      expect(await gateFor("bldg-b@1F", "normal")).toBe("gate-side");
      expect(await gateFor("bldg-b@1F", mode)).toBe("gate-main");
    },
  );

  it("reports NO_ACCESSIBLE_ROUTE, not NO_ROUTE, when only an unusable gate reaches the place", async () => {
    useVenue(
      XML.replace(
        "<tag k='wheelchair' v='yes' />\n    <tag k='name' v='測試校門' />",
        "<tag k='name' v='測試校門' />",
      ),
    );
    expect(await gateFor("a-room06@2F", "wheelchair")).toMatchObject({
      ok: false,
      status: 422,
      data: { reason: "NO_ACCESSIBLE_ROUTE" },
    });
  });
});

describe("gate eligibility on reroute", () => {
  it("treats a gate that lost wheelchair=yes as stale for a wheelchair trip, but not for a normal one", async () => {
    const xml = readFileSync(
      path.join(__dirname, "__fixtures__/mini-campus.osm"),
      "utf8",
    ).replace(
      "<tag k='wheelchair' v='yes' />\n    <tag k='name' v='測試校門' />",
      "<tag k='name' v='測試校門' />",
    );
    const compiled = compileVenue(parseOsmXml(xml), {
      venueId: "mini",
      name: "Mini",
    });
    vi.mocked(repository.findVenueVersion).mockResolvedValue(2);
    vi.mocked(repository.findVenue).mockResolvedValue({
      ...compiled.venue,
      version: 2,
      importedAt: new Date(0),
      source: { file: "x.osm", sha256: "x" },
      warnings: [],
    });
    const gate = compiled.venue.places.find((p) => p.id === "gate-main");
    if (!gate) throw new Error("no gate");
    const arrival = (mode: "wheelchair" | "normal") => ({
      venueId: "mini",
      placeId: "a-room06@2F",
      gateId: "gate-main",
      gateLocation: { lat: gate.location[1], lng: gate.location[0] },
      mode,
      venueVersion: 1,
    });
    expect(await isVenueArrivalCurrent(arrival("wheelchair"))).toBe(false);
    expect(await replanVenueLeg(arrival("wheelchair"), "zh-TW")).toEqual({
      ok: false,
      stale: true,
    });
    expect(await isVenueArrivalCurrent(arrival("normal"))).toBe(true);
  });
});

describe("inspectVenueByQuery", () => {
  const summary = {
    venueId: "mini",
    name: "Mini",
    center: [120.68, 24.15] as [number, number],
    version: 3,
    importedAt: new Date(0),
    buildings: venue.buildings.map((b) => ({ id: b.id, name: b.name })),
  };

  it("uses the only venue when none is named and reads its compiled facts", async () => {
    vi.mocked(repository.listVenueSummaries).mockResolvedValue([summary]);
    vi.mocked(repository.findVenueVersion).mockResolvedValue(3);
    vi.mocked(repository.findVenue).mockResolvedValue(doc(3));
    const result = await inspectVenueByQuery(
      { building: "測試館", kinds: ["elevator"] },
      "normal",
    );
    expect(result).toMatchObject({
      ok: true,
      venueId: "mini",
      venueVersion: 3,
      facts: [{ kind: "elevator", levelRefs: ["1F", "2F", "3F"] }],
    });
  });

  it("returns the venues to choose from when the named one is unknown", async () => {
    vi.mocked(repository.listVenueSummaries).mockResolvedValue([summary]);
    expect(await inspectVenueByQuery({ venue: "別的學校" }, "normal")).toEqual({
      ok: false,
      reason: "VENUE_NOT_FOUND",
      candidates: [{ id: "mini", name: "Mini" }],
    });
    expect(repository.findVenue).not.toHaveBeenCalled();
  });
});
