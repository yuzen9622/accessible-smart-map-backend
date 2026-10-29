import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlCampusBranches } from "./import-campus-a11y";
import { parseCampusMapData } from "../adapters/campus-map.adapter";
import { parseFacilityResultHtml } from "./campus-a11y-parse";

const uid = "facility-13";
const fullList = `<section class="result-area">
<header>共 1 筆建物，1 筆設施</header>
<article class="result-all-item"><h2 id="building" aria-label="Building"></h2>
<div class="level" data-level="1F"><button class="btn-fac-detail"
data-fac-uid="${uid}" data-type="13" data-building-uid="building" data-floor-id="floor"
aria-label="引導設施">引導設施</button></div></article></section>`;
const zeroList =
  '<section class="result-area"><header>共 0 筆建物，0 筆設施</header></section>';
const branches = [
  { ID: 1, NAME: "First" },
  { ID: 2, NAME: "Second" },
];
const options = {
  school: { ID: 10, NAME: "School" },
  branches,
  city: "臺北市",
  facTypeQuery: "all-13-types",
};
const mapFor = (id: number) =>
  parseCampusMapData(
    {
      MAP_FACINFO: [
        {
          UID: uid,
          INSTITUTION_BRANCH_ID: id,
          GEO: "POINT (13434385.08 2771769.053)",
        },
      ],
    },
    id,
  );
afterEach(() => vi.restoreAllMocks());

describe("full-campus crawl coverage", () => {
  it("continues after a failed branch and passes all registry types to later campuses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const loadList = vi.fn(async (payload: Record<string, string>) => {
      if (payload.INSTITUTION_BRANCH_ID === "1")
        throw new Error("first campus unavailable");
      return fullList;
    });
    const result = await crawlCampusBranches({
      ...options,
      loadList,
      loadMap: async (id) => mapFor(id),
    });
    expect(result.failed).toBe(1);
    expect(result.docs.map((d) => d.branchId)).toEqual([2]);
    expect(loadList).toHaveBeenCalledTimes(2);
    expect(loadList.mock.calls[1][0].FacType).toBe("all-13-types");
    expect(result.docs[0].facilities[0]).toMatchObject({
      facTypeId: 13,
      location: { type: "Point", coordinates: [120.6831345, 24.1505911] },
    });
  });

  it("recognizes both legitimate zero-count and no-result pages without clearing stored data", async () => {
    expect(parseFacilityResultHtml(zeroList).complete).toBe(true);
    const result = await crawlCampusBranches({
      ...options,
      loadList: async (payload) =>
        payload.INSTITUTION_BRANCH_ID === "1"
          ? zeroList
          : '<section><article id="noResult">查無資料</article></section>',
      loadMap: async (id) => parseCampusMapData({ MAP_FACINFO: [] }, id),
    });
    expect(result).toEqual({ docs: [], empty: 2, failed: 0 });
  });

  it("rejects incomplete lists even for source rows whose geometry is absent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await crawlCampusBranches({
      ...options,
      loadList: async () => fullList,
      loadMap: async (id) =>
        parseCampusMapData(
          {
            MAP_FACINFO: [
              { UID: "not-in-list", INSTITUTION_BRANCH_ID: id, GEO: null },
            ],
          },
          id,
        ),
    });
    expect(result).toEqual({ docs: [], empty: 0, failed: 2 });
  });

  it("does not count a list as empty when MapInfo still contains facilities", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await crawlCampusBranches({
      ...options,
      loadList: async () => zeroList,
      loadMap: async (id) => mapFor(id),
    });
    expect(result).toEqual({ docs: [], empty: 0, failed: 2 });
  });

  it("retains catalogue facilities without source coordinates, without requiring equal source counts", async () => {
    const result = await crawlCampusBranches({
      ...options,
      loadList: async () => fullList,
      loadMap: async (id) => parseCampusMapData({ MAP_FACINFO: [] }, id),
    });
    expect(result.failed).toBe(0);
    expect(result.docs).toHaveLength(2);
    expect(
      result.docs.every((d) => d.facilities[0].location === undefined),
    ).toBe(true);
  });
});
