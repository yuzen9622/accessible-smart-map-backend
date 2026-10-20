import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/fetch", () => ({ tdxFetch: vi.fn() }));

import { tdxFetch } from "../config/fetch";
import {
  clearTransitLineCache,
  fetchMetroNetwork,
  fetchTraLines,
} from "./transit-line.adapter";

const tdxFetchMock = vi.mocked(tdxFetch);

function respond(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTransitLineCache();
});

describe("fetchMetroNetwork", () => {
  it("joins the line directory with each line's stations", async () => {
    tdxFetchMock.mockImplementation(async (url) =>
      String(url).includes("/StationOfLine/")
        ? respond([
            {
              LineID: "BL",
              Stations: [
                { StationID: "BL12", StationName: { Zh_tw: "台北車站" } },
              ],
            },
          ])
        : respond([{ LineID: "BL", LineName: { Zh_tw: "板南線" } }]),
    );

    await expect(fetchMetroNetwork("TRTC")).resolves.toEqual({
      lines: [{ lineId: "BL", name: "板南線" }],
      stations: [{ stationId: "BL12", name: "台北車站", lineId: "BL" }],
    });
  });

  it("rejects a malformed 2xx payload and retries on the next call instead of caching it", async () => {
    tdxFetchMock.mockResolvedValue(respond({ Message: "unexpected" }));
    await expect(fetchMetroNetwork("TRTC")).rejects.toThrow();

    tdxFetchMock.mockImplementation(async (url) =>
      String(url).includes("/StationOfLine/")
        ? respond([
            {
              LineID: "BL",
              Stations: [
                { StationID: "BL12", StationName: { Zh_tw: "台北車站" } },
              ],
            },
          ])
        : respond([{ LineID: "BL", LineName: { Zh_tw: "板南線" } }]),
    );
    await expect(fetchMetroNetwork("TRTC")).resolves.toMatchObject({
      lines: [{ lineId: "BL" }],
    });
  });
});

describe("fetchTraLines", () => {
  it("reads the v3 Lines envelope and caches a good directory", async () => {
    tdxFetchMock.mockResolvedValue(
      respond({ Lines: [{ LineID: "WL", LineName: { Zh_tw: "西部幹線" } }] }),
    );

    await fetchTraLines();
    await expect(fetchTraLines()).resolves.toEqual([
      { lineId: "WL", name: "西部幹線" },
    ]);
    expect(tdxFetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache an upstream error", async () => {
    tdxFetchMock.mockResolvedValueOnce(respond({}, 503));
    await expect(fetchTraLines()).rejects.toThrow("TDX 503");

    tdxFetchMock.mockResolvedValueOnce(
      respond({ Lines: [{ LineID: "WL", LineName: { Zh_tw: "西部幹線" } }] }),
    );
    await expect(fetchTraLines()).resolves.toHaveLength(1);
  });
});
