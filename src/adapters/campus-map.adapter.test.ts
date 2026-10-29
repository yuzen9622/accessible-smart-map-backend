import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/moe-mapinfo-nutc-sanmin.json";
import {
  fetchCampusMapLocations,
  parseCampusMapLocations,
} from "./campus-map.adapter";
import { parseFacilityLocation, parseGeoPoint } from "../utils/campus-geo";
const branchId = -2147483619;
afterEach(() => vi.unstubAllGlobals());
describe("MOE MapInfo facility coordinates", () => {
  it("converts the observed facility UID/GEO from EPSG:3857 to WGS84", () => {
    const locations = parseCampusMapLocations(fixture, branchId);
    expect(locations.size).toBe(fixture.MAP_FACINFO.length);
    expect(locations.get("e391e1ad-ca08-4bd8-aa81-009160aece24")).toEqual({
      type: "Point",
      coordinates: [120.6831345, 24.1505911],
    });
  });
  it("requests every facility type using only the observed campus query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fixture)));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchCampusMapLocations(branchId)).size).toBe(
      fixture.MAP_FACINFO.length,
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://cam.moe.gov.tw/api/Map/MapInfo?INSTITUTION_BRANCH_ID=-2147483619",
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Cookie");
  });
  it("rejects failed requests, unrecognized data, wrong campuses and duplicate UIDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    await expect(fetchCampusMapLocations(branchId)).rejects.toThrow("503");
    expect(() => parseCampusMapLocations({}, branchId)).toThrow();
    expect(() => parseCampusMapLocations(fixture, 123)).toThrow(
      "different campus",
    );
    expect(() =>
      parseCampusMapLocations(
        { MAP_FACINFO: [fixture.MAP_FACINFO[0], fixture.MAP_FACINFO[0]] },
        branchId,
      ),
    ).toThrow("duplicate");
  });
  it("does not substitute building positions for absent or invalid facility geometry", () => {
    for (const GEO of [
      null,
      "",
      "POINT EMPTY",
      "POLYGON ((1 2, 3 4))",
      "POINT (NaN 3)",
      "POINT (1e309 3)",
    ]) {
      expect(
        parseCampusMapLocations(
          {
            MAP_FACINFO: [{ ...fixture.MAP_FACINFO[0], GEO }],
            MAP_BUILDINFO: [{ GEO: fixture.MAP_FACINFO[0].GEO }],
          },
          branchId,
        ).size,
      ).toBe(0);
    }
    expect(parseGeoPoint(" POINT(13434385.08   2771769.053) ")).toEqual({
      lng: 120.6831345,
      lat: 24.1505911,
    });
  });
  it("only considers finite WGS84 Point pairs already located", () => {
    for (const value of [
      undefined,
      null,
      {},
      { coordinates: [] },
      { type: "Point", coordinates: [120] },
      { type: "Point", coordinates: [120, NaN] },
      { type: "Point", coordinates: [120, Infinity] },
      { type: "Point", coordinates: [181, 24] },
      { type: "Point", coordinates: [120, 91] },
      { type: "Point", coordinates: [120, 24, 1] },
    ])
      expect(parseFacilityLocation(value)).toBeUndefined();
    expect(
      parseFacilityLocation({ type: "Point", coordinates: [120, 24] }),
    ).toEqual({ type: "Point", coordinates: [120, 24] });
  });
});
