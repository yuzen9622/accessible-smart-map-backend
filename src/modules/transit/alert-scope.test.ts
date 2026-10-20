import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../adapters/transit-line.adapter", () => ({
  fetchMetroNetwork: vi.fn(),
  fetchTraLines: vi.fn(),
}));
vi.mock("../../adapters/rail.adapter", () => ({
  fetchRailStationIndex: vi.fn(),
}));

import { tdxFetch } from "../../config/fetch";
import {
  fetchMetroNetwork,
  fetchTraLines,
} from "../../adapters/transit-line.adapter";
import { fetchRailStationIndex } from "../../adapters/rail.adapter";
import { clearTransitAlertsCache } from "./alert.service";
import { upsertAlertSnapshot } from "./alert.store";
import { getRailAlertsByName } from "./alert-scope";

const metroNetworkMock = vi.mocked(fetchMetroNetwork);
const traLinesMock = vi.mocked(fetchTraLines);
const stationIndexMock = vi.mocked(fetchRailStationIndex);

const TRTC_NETWORK = {
  lines: [
    { lineId: "BL", name: "板南線" },
    { lineId: "R", name: "淡水信義線" },
  ],
  stations: [
    { stationId: "BL12", name: "台北車站", lineId: "BL" },
    { stationId: "R10", name: "台北車站", lineId: "R" },
    { stationId: "BL13", name: "善導寺", lineId: "BL" },
  ],
};

function metroAlert(id: string, scope: Record<string, unknown>) {
  return { AlertID: id, Title: id, Description: id, Status: 2, Scope: scope };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTransitAlertsCache();
  vi.mocked(tdxFetch).mockRejectedValue(new Error("network disabled in test"));
  metroNetworkMock.mockResolvedValue(TRTC_NETWORK);
});

describe("getRailAlertsByName — metro", () => {
  it("finds a station-scoped alert from a Chinese station name", async () => {
    upsertAlertSnapshot(
      "metro:TRTC",
      [metroAlert("bl12-elevator", { Stations: [{ StationID: "BL12" }] })],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "metro",
      stationName: "臺北車站",
    });

    expect(result).toMatchObject({
      ok: true,
      alerts: [{ alertId: "bl12-elevator", matchKind: "station" }],
    });
  });

  it("finds a line-wide alert from the line's Chinese name", async () => {
    upsertAlertSnapshot(
      "metro:TRTC",
      [metroAlert("bl-delay", { Lines: [{ LineID: "BL" }] })],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "metro",
      lineName: "板南線",
    });

    expect(result).toMatchObject({
      ok: true,
      alerts: [{ alertId: "bl-delay", matchKind: "line" }],
    });
  });

  it("covers every line through a transfer station when only the station is named", async () => {
    upsertAlertSnapshot(
      "metro:TRTC",
      [metroAlert("red-line-delay", { Lines: ["R"] })],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "metro",
      stationName: "台北車站",
    });

    expect(result).toMatchObject({
      ok: true,
      alerts: [{ alertId: "red-line-delay" }],
    });
  });

  it("queries the Maokong Gondola system instead of rewriting it to TRTC", async () => {
    metroNetworkMock.mockResolvedValue({
      lines: [{ lineId: "MK", name: "貓空纜車" }],
      stations: [{ stationId: "MK04", name: "貓空站", lineId: "MK" }],
    });
    upsertAlertSnapshot(
      "metro:TRTCMG",
      [metroAlert("mk-wind", { Lines: [{ LineID: "MK" }] })],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "metro",
      railSystem: "TRTCMG",
      stationName: "貓空",
    });

    expect(metroNetworkMock).toHaveBeenCalledWith("TRTCMG");
    expect(result).toMatchObject({
      ok: true,
      alerts: [{ alertId: "mk-wind" }],
    });
  });

  it("rejects a system with no alert feed instead of answering for Taipei", async () => {
    const result = await getRailAlertsByName({
      mode: "metro",
      railSystem: "NTMC",
      stationName: "淡海",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "UNSUPPORTED_RAIL_SYSTEM",
    });
  });

  it("reports an unknown station instead of an empty result", async () => {
    const result = await getRailAlertsByName({
      mode: "metro",
      stationName: "不存在站",
    });

    expect(result).toMatchObject({ ok: false, reason: "UNKNOWN_STATION" });
  });

  it("reports an upstream directory outage as unavailable, not as normal service", async () => {
    metroNetworkMock.mockRejectedValue(new Error("TDX 503"));

    const result = await getRailAlertsByName({
      mode: "metro",
      lineName: "板南線",
    });

    expect(result).toMatchObject({ ok: false, reason: "LOOKUP_UNAVAILABLE" });
  });
});

describe("getRailAlertsByName — TRA / THSR", () => {
  beforeEach(() => {
    stationIndexMock.mockImplementation(async (system) => ({
      ok: true,
      index: new Map(
        system === "TRA"
          ? [["臺北", "1000"]]
          : [
              ["臺北", "1000"],
              ["左營", "1070"],
            ],
      ),
    }));
    traLinesMock.mockResolvedValue([{ lineId: "WL", name: "西部幹線" }]);
  });

  it("finds a TRA station alert from a Chinese station name", async () => {
    upsertAlertSnapshot(
      "tra",
      [metroAlert("tra-taipei", { Stations: [{ StationID: "1000" }] })],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "tra",
      stationName: "台北車站",
    });

    expect(result).toMatchObject({
      ok: true,
      alerts: [{ alertId: "tra-taipei", matchKind: "station" }],
    });
  });

  it("finds a TRA line alert from the line's Chinese name", async () => {
    upsertAlertSnapshot(
      "tra",
      [metroAlert("tra-wl", { Lines: [{ LineID: "WL" }] })],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "tra",
      lineName: "西部幹線",
    });

    expect(result).toMatchObject({ ok: true, alerts: [{ alertId: "tra-wl" }] });
  });

  it("finds a THSR section alert from a station name", async () => {
    upsertAlertSnapshot(
      "thsr",
      [
        {
          AlertID: "thsr-south",
          Title: "延誤",
          Description: "南段延誤",
          Status: "▲",
          Scope: {
            LineSections: [
              {
                LineID: "",
                StartingStationID: "1040",
                EndingStationID: "1070",
              },
            ],
          },
        },
      ],
      "rest",
    );

    const result = await getRailAlertsByName({
      mode: "thsr",
      stationName: "左營",
    });

    expect(result).toMatchObject({
      ok: true,
      alerts: [{ alertId: "thsr-south", matchKind: "section" }],
    });
  });

  it("asks for a station when THSR is queried by train number only", async () => {
    const result = await getRailAlertsByName({ mode: "thsr", trainNo: "603" });

    expect(result).toMatchObject({ ok: false, reason: "SCOPE_REQUIRED" });
  });
});
