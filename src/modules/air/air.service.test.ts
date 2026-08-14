import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_MOENV_API_KEY = process.env.MOENV_API_KEY;

function record(overrides: Record<string, string> = {}) {
  return {
    sitename: "預設測站",
    county: "臺北市",
    "pm2.5": "15",
    longitude: "121.5654",
    latitude: "25.033",
    ...overrides,
  };
}

async function loadGetAirData() {
  const { getAirData } = await import("./air.service");
  return getAirData;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.MOENV_API_KEY = "test-key";
});

afterEach(() => {
  if (ORIGINAL_MOENV_API_KEY === undefined) delete process.env.MOENV_API_KEY;
  else process.env.MOENV_API_KEY = ORIGINAL_MOENV_API_KEY;
  vi.unstubAllGlobals();
});

describe("getAirData", () => {
  it("sorts readings by distance and uses the nearest station county", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        record({
          sitename: "遠方測站",
          county: "臺中市",
          longitude: "120.6839",
          latitude: "24.1477",
        }),
        record({
          sitename: "最近測站",
          county: "臺北市",
          longitude: "121.5655",
          latitude: "25.0331",
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    const result = await getAirData(25.033, 121.5654);

    expect(result?.city).toBe("臺北市");
    expect(result?.readings[0]).toMatchObject({
      area: "最近測站",
      city: "臺北市",
      pm25: 15,
      coordinates: [121.5655, 25.0331],
    });
  });

  it("filters blank and non-numeric PM2.5 records", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        record({ sitename: "空白", "pm2.5": "" }),
        record({ sitename: "未檢出", "pm2.5": "ND" }),
        record({ sitename: "文字", "pm2.5": "not-a-number" }),
        record({ sitename: "有效", "pm2.5": "18" }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    const result = await getAirData(25.033, 121.5654);

    expect(result?.readings).toHaveLength(1);
    expect(result?.readings[0]).toMatchObject({ area: "有效", pm25: 18 });
  });

  it("keeps valid PM2.5 readings when coordinates cannot be parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        record({
          sitename: "無座標測站",
          longitude: "not-a-number",
          latitude: "",
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    const result = await getAirData(25.033, 121.5654);

    expect(result?.readings[0]).toMatchObject({
      area: "無座標測站",
      coordinates: undefined,
    });
  });

  it("returns null without fetching when MOENV_API_KEY is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.MOENV_API_KEY;
    const getAirData = await loadGetAirData();

    await expect(getAirData(25.033, 121.5654)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the upstream request rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection failed"));
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    await expect(getAirData(25.033, 121.5654)).resolves.toBeNull();
  });

  it("returns null for a non-2xx upstream response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    await expect(getAirData(25.033, 121.5654)).resolves.toBeNull();
  });

  it("returns null when the upstream JSON cannot be parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError("invalid JSON")),
    });
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    await expect(getAirData(25.033, 121.5654)).resolves.toBeNull();
  });

  it("uses the successful module cache on the second call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([record()]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const getAirData = await loadGetAirData();

    await expect(getAirData(25.033, 121.5654)).resolves.not.toBeNull();
    await expect(getAirData(25.033, 121.5654)).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
