import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/metro-station.model", () => ({
  default: { find: vi.fn() },
}));

import { tdxFetch } from "../../config/fetch";
import { metroUrl } from "../../config/transit";
import MetroStationModel from "../../model/metro-station.model";
import { clearMetroAlertsCache, getMetroAlerts } from "./metro.service";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;
const stationFindMock = MetroStationModel.find as unknown as ReturnType<
  typeof vi.fn
>;

function tdxResponse(alerts: unknown[] = []) {
  return {
    ok: true,
    json: async () => ({
      UpdateTime: "2026-08-15T10:00:00+08:00",
      AuthorityCode: "TRTC",
      Alerts: alerts,
    }),
  };
}

function mockStations(rows: unknown[]) {
  stationFindMock.mockReturnValue({ lean: () => Promise.resolve(rows) });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMetroAlertsCache();
  tdxFetchMock.mockResolvedValue(tdxResponse());
  mockStations([]);
});

describe("getMetroAlerts", () => {
  it("未指定系統時查詢所有支援的捷運系統", async () => {
    await getMetroAlerts();

    const systems = ["TRTC", "KRTC", "TYMC", "TMRT", "KLRT", "TRTCMG"];
    expect(tdxFetchMock).toHaveBeenCalledTimes(systems.length);
    for (const system of systems) {
      expect(tdxFetchMock).toHaveBeenCalledWith(
        `${metroUrl.alertUrl(system)}?$format=JSON`,
        { signal: expect.any(AbortSignal) },
      );
    }
  });

  it("指定 TRTC 時只查詢 TRTC", async () => {
    await getMetroAlerts("TRTC");

    expect(tdxFetchMock).toHaveBeenCalledTimes(1);
    expect(tdxFetchMock).toHaveBeenCalledWith(
      `${metroUrl.alertUrl("TRTC")}?$format=JSON`,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("不支援的系統會拋出錯誤", async () => {
    await expect(getMetroAlerts("NTMC")).rejects.toThrow(
      "Unsupported metro rail system: NTMC",
    );
    expect(tdxFetchMock).not.toHaveBeenCalled();
  });

  it("過濾正常營運公告並解析異常公告的車站名稱", async () => {
    tdxFetchMock.mockResolvedValue(
      tdxResponse([
        {
          AlertID: "normal-1",
          Title: "正常營運",
          Description: "全線正常",
          Status: 1,
          Scope: { Stations: ["R10"], Lines: ["R"] },
          PublishTime: "2026-08-15T09:00:00+08:00",
          UpdateTime: "2026-08-15T09:00:00+08:00",
        },
        {
          AlertID: "normal-2",
          Title: "目前全線正常營運",
          Description: "正常",
          Status: 1,
          Scope: { Stations: [], Lines: [] },
          PublishTime: "2026-08-15T09:00:00+08:00",
          UpdateTime: "2026-08-15T09:00:00+08:00",
        },
        {
          AlertID: "fault-1",
          Title: "電梯故障",
          Description: "R10 電梯維修中",
          Status: 2,
          Scope: { Stations: ["R10", "R11"], Lines: ["R"] },
          PublishTime: "2026-08-15T09:30:00+08:00",
          UpdateTime: "2026-08-15T09:45:00+08:00",
        },
      ]),
    );
    mockStations([{ stationUid: "R10", stationName: { Zh_tw: "中山站" } }]);

    const result = await getMetroAlerts("TRTC");

    expect(stationFindMock).toHaveBeenCalledWith({
      stationUid: { $in: ["R10", "R11"] },
    });
    expect(result).toEqual([
      {
        railSystem: "TRTC",
        updatedAt: "2026-08-15T10:00:00+08:00",
        alerts: [
          {
            alertId: "fault-1",
            title: "電梯故障",
            description: "R10 電梯維修中",
            status: 2,
            stations: [
              { id: "R10", name: "中山站" },
              { id: "R11", name: null },
            ],
            lines: ["R"],
            publishTime: "2026-08-15T09:30:00+08:00",
            updateTime: "2026-08-15T09:45:00+08:00",
          },
        ],
      },
    ]);
  });

  it("快取未過期時不再打 TDX", async () => {
    await getMetroAlerts("TRTC");
    const second = await getMetroAlerts("TRTC");

    expect(tdxFetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual([
      {
        railSystem: "TRTC",
        updatedAt: "2026-08-15T10:00:00+08:00",
        alerts: [],
      },
    ]);
  });

  it("clearMetroAlertsCache() 後會重新打 TDX", async () => {
    await getMetroAlerts("TRTC");
    clearMetroAlertsCache();
    await getMetroAlerts("TRTC");

    expect(tdxFetchMock).toHaveBeenCalledTimes(2);
  });
});
