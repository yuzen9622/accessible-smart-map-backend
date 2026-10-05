import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaiwanCityEn } from "../types/transit";
import {
  NLSC_CACHE_MAX,
  NLSC_CACHE_TTL_MS,
  NLSC_TIMEOUT_MS,
} from "../config/nlsc";

/** Load captured NLSC XML without making network calls. */
function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__/nlsc", name), "utf8");
}

const taipei = fixture("taipei.xml");
const kinmen = fixture("kinmen.xml");
const noLand = fixture("no-land.xml");
const counties = [
  ...fixture("listcounty.xml").matchAll(
    /<countyItem>\s*<countycode>([^<]+)<\/countycode>\s*<countyname>([^<]+)<\/countyname>/g,
  ),
].map((match) => [match[1], match[2]]);
const cityByName: Record<string, TaiwanCityEn> = {
  臺北市: TaiwanCityEn.Taipei,
  臺中市: TaiwanCityEn.Taichung,
  基隆市: TaiwanCityEn.Keelung,
  臺南市: TaiwanCityEn.Tainan,
  高雄市: TaiwanCityEn.Kaohsiung,
  新北市: TaiwanCityEn.NewTaipei,
  宜蘭縣: TaiwanCityEn.YilanCounty,
  桃園市: TaiwanCityEn.Taoyuan,
  嘉義市: TaiwanCityEn.Chiayi,
  新竹縣: TaiwanCityEn.HsinchuCounty,
  苗栗縣: TaiwanCityEn.MiaoliCounty,
  南投縣: TaiwanCityEn.NantouCounty,
  彰化縣: TaiwanCityEn.ChanghuaCounty,
  新竹市: TaiwanCityEn.Hsinchu,
  雲林縣: TaiwanCityEn.YunlinCounty,
  嘉義縣: TaiwanCityEn.ChiayiCounty,
  屏東縣: TaiwanCityEn.PingtungCounty,
  花蓮縣: TaiwanCityEn.HualienCounty,
  臺東縣: TaiwanCityEn.TaitungCounty,
  金門縣: TaiwanCityEn.KinmenCounty,
  澎湖縣: TaiwanCityEn.PenghuCounty,
  連江縣: TaiwanCityEn.LienchiangCounty,
};
const fetchMock = vi.fn();
let lookup: typeof import("./nlsc.adapter").getNlscAdministrativeArea;

/** Stub the HTTP boundary, preserving the real parser/cache. */
function respond(xml = taipei, status = 200): void {
  fetchMock.mockResolvedValue({ status, text: async () => xml });
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ({ getNlscAdministrativeArea: lookup } = await import("./nlsc.adapter"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NLSC administrative area", () => {
  it("parses the captured Kinmen response and sends longitude before latitude", async () => {
    respond(kinmen);
    await expect(lookup(24.4325, 118.3186)).resolves.toEqual({
      city: TaiwanCityEn.KinmenCounty,
      town: "金城鎮",
      village: "北門里",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.nlsc.gov.tw/other/TownVillagePointQuery/118.3186/24.4325/4326",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("covers all 22 distinct counties in the captured ListCounty response", () => {
    expect(counties).toHaveLength(22);
    expect(new Set(counties.map(([, name]) => cityByName[name]))).toEqual(
      new Set(Object.values(TaiwanCityEn)),
    );
  });

  it.each(counties)(
    "maps official county %s / %s exactly",
    async (code, name) => {
      respond(
        `<townVillageItem><ctyCode>${code}</ctyCode><ctyName>${name}</ctyName></townVillageItem>`,
      );
      await expect(lookup(25, 121)).resolves.toEqual({
        city: cityByName[name],
      });
    },
  );

  it("decodes predefined/numeric XML entities and omits empty optional fields", async () => {
    respond(
      "<townVillageItem><ctyCode>A</ctyCode><townName>&#x4E2D;&#27491;&amp;區</townName><villageName></villageName></townVillageItem>",
    );
    await expect(lookup(25, 121)).resolves.toEqual({
      city: TaiwanCityEn.Taipei,
      town: "中正&區",
    });
  });

  it.each([
    ["NO_LAND", noLand],
    [
      "unknown code",
      taipei.replace("<ctyCode>A</ctyCode>", "<ctyCode>L</ctyCode>"),
    ],
    [
      "prototype key",
      "<townVillageItem><ctyCode>toString</ctyCode></townVillageItem>",
    ],
    [
      "missing code",
      "<townVillageItem><ctyName>臺北市</ctyName></townVillageItem>",
    ],
    ["JSON", '{"ctyCode":"A"}'],
    ["HTML", "<html><ctyCode>A</ctyCode></html>"],
    ["truncated XML", taipei.replace("</townVillageItem>", "")],
    [
      "duplicate code",
      taipei.replace(
        "<ctyCode>A</ctyCode>",
        "<ctyCode>A</ctyCode><ctyCode>F</ctyCode>",
      ),
    ],
    ["mismatched tag", taipei.replace("</ctyCode>", "</ctyName>")],
    [
      "external entity",
      '<!DOCTYPE townVillageItem [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
        taipei,
    ],
    ["invalid entity", taipei.replace("中正區", "&unknown;")],
    ["invalid character", taipei.replace("中正區", "&#0;")],
    ["raw control character", taipei.replace("中正區", "\u0000")],
    ["unpaired surrogate", taipei.replace("中正區", "\ud800")],
    ["oversized XML", taipei + " ".repeat(16_384)],
  ])("returns null, logs and does not cache %s", async (_label, xml) => {
    respond(xml);
    await expect(lookup(25, 121)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
    respond();
    await expect(lookup(25, 121)).resolves.toMatchObject({
      city: TaiwanCityEn.Taipei,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([204, 301, 429, 500, 503])(
    "does not cache non-200 HTTP %s",
    async (status) => {
      respond(taipei, status);
      await expect(lookup(25, 121)).resolves.toBeNull();
      respond();
      await expect(lookup(25, 121)).resolves.toMatchObject({
        city: TaiwanCityEn.Taipei,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("returns null at the configured timeout without caching the failure", async () => {
    vi.useFakeTimers();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("Timed out", "TimeoutError")),
          ms,
        );
        return controller.signal;
      });
    fetchMock.mockImplementation(
      (_url, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const pending = lookup(25, 121);
    await vi.advanceTimersByTimeAsync(NLSC_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(timeout).toHaveBeenCalledWith(1_500);
    respond();
    await expect(lookup(25, 121)).resolves.toMatchObject({
      city: TaiwanCityEn.Taipei,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("isolates network and body-read failures without logging error URLs", async () => {
    fetchMock.mockRejectedValueOnce(new Error("private-url"));
    await expect(lookup(25, 121)).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      text: async () => {
        throw new Error("private-url");
      },
    });
    await expect(lookup(25, 121)).resolves.toBeNull();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "private-url",
    );
  });

  it("uses four-decimal cache keys, expires successes and protects cached values from mutation", async () => {
    vi.useFakeTimers();
    respond();
    const first = await lookup(25.04781, 121.51701);
    first!.city = TaiwanCityEn.Keelung;
    await expect(lookup(25.04782, 121.51702)).resolves.toMatchObject({
      city: TaiwanCityEn.Taipei,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NLSC_CACHE_TTL_MS);
    await lookup(25.04781, 121.51701);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds successful entries and evicts the least recently used coordinate", async () => {
    respond();
    for (let i = 0; i < NLSC_CACHE_MAX; i++) await lookup(25, 120 + i / 10_000);
    await lookup(25, 120);
    await lookup(25, 122);
    await lookup(25, 120);
    expect(fetchMock).toHaveBeenCalledTimes(NLSC_CACHE_MAX + 1);
    await lookup(25, 120.0001);
    expect(fetchMock).toHaveBeenCalledTimes(NLSC_CACHE_MAX + 2);
  });
});
