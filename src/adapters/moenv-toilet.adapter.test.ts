import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAccessibleToilets,
  isAccessibleToilet,
  type MoenvToiletRow,
} from "./moenv-toilet.adapter";

function toilet(number: string, type: string, name: string): MoenvToiletRow {
  return {
    county: "63000",
    areacode: "63000010",
    village: "",
    number,
    name,
    address: "",
    administration: "",
    latitude: "25.0",
    longitude: "121.5",
    grade: "",
    type2: "",
    type,
    exec: "",
    diaper: "0",
  };
}

function page(rows: MoenvToiletRow[]): Response {
  return new Response(JSON.stringify(rows), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("isAccessibleToilet", () => {
  it("keeps accessible-typed toilets and stalls named as accessible", () => {
    expect(isAccessibleToilet(toilet("1", "無障礙廁所", "某站-廁所"))).toBe(
      true,
    );
    expect(
      isAccessibleToilet(toilet("2", "男廁所", "某醫院-男廁(無障礙廁所)")),
    ).toBe(true);
    expect(isAccessibleToilet(toilet("3", "男廁所", "某站-男廁"))).toBe(false);
  });
});

describe("fetchAccessibleToilets", () => {
  it("pages until a short page and filters to accessible toilets", async () => {
    const full = Array.from({ length: 1000 }, (_, i) =>
      toilet(`A${i}`, i % 2 ? "無障礙廁所" : "女廁所", "x"),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(page([toilet("B", "無障礙廁所", "y")]));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await fetchAccessibleToilets("key");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("offset")).toBe(
      "1000",
    );
    expect(rows).toHaveLength(501);
  });

  it("fails the whole download when any page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          page(Array(1000).fill(toilet("A", "無障礙廁所", "x"))),
        )
        .mockResolvedValueOnce(new Response("busy", { status: 503 })),
    );

    await expect(fetchAccessibleToilets("key")).rejects.toThrow(
      "offset 1000: HTTP 503",
    );
  });
});
