import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaiwanCityEn } from "../types/transit";

const fetchMock = vi.fn();
let getCity: typeof import("./google.adapter").getCity;

/** Builds a Google geocoding response at the external HTTP boundary. */
function geocodeResponse(longName: unknown) {
  return {
    status: "OK",
    results: [
      {
        address_components: [
          {
            long_name: longName,
            types: ["administrative_area_level_1", "political"],
          },
        ],
      },
    ],
  };
}

/** Supplies a successful HTTP response with the requested upstream body. */
function respond(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ({ getCity } = await import("./google.adapter"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getCity administrative city", () => {
  it.each([
    ["New Taipei City", TaiwanCityEn.NewTaipei],
    ["Taipei City", TaiwanCityEn.Taipei],
    ["Keelung City", TaiwanCityEn.Keelung],
    ["Chiayi City", TaiwanCityEn.Chiayi],
    ["Chiayi County", TaiwanCityEn.ChiayiCounty],
    ["Hsinchu City", TaiwanCityEn.Hsinchu],
    ["Hsinchu County", TaiwanCityEn.HsinchuCounty],
    ["Kinmen County", TaiwanCityEn.KinmenCounty],
  ])("maps %s to %s and caches only the valid enum", async (name, expected) => {
    respond(geocodeResponse(name));
    await expect(getCity(25.01484, 121.46328)).resolves.toBe(expected);
    await expect(getCity(25.01484, 121.46328)).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "missing admin area",
      {
        status: "OK",
        results: [
          {
            address_components: [{ long_name: "Taipei", types: ["locality"] }],
          },
        ],
      },
    ],
    ["empty results", { status: "ZERO_RESULTS", results: [] }],
    ["missing results", { status: "OK" }],
    ["missing components", { status: "OK", results: [{}] }],
    ["unknown city", geocodeResponse("Unknown City")],
    ["dataset scope", geocodeResponse("InterCity")],
    ["malformed name", geocodeResponse(123)],
    [
      "Google error",
      { ...geocodeResponse("Taipei City"), status: "REQUEST_DENIED" },
    ],
  ])("returns null, logs and does not cache %s", async (_label, body) => {
    respond(body);
    await expect(getCity(25.01484, 121.46328)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
    respond(geocodeResponse("New Taipei City"));
    await expect(getCity(25.01484, 121.46328)).resolves.toBe(
      TaiwanCityEn.NewTaipei,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on network failure without logging a URL containing the key", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed?key=private-key"));
    await expect(getCity(25, 121)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "private-key",
    );
    respond(geocodeResponse("Taipei City"));
    await expect(getCity(25, 121)).resolves.toBe(TaiwanCityEn.Taipei);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on non-success HTTP status or invalid JSON", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(getCity(25, 121)).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("invalid JSON");
      },
    });
    await expect(getCity(25, 121)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
