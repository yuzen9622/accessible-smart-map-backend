import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-route.model", () => ({ default: { find: vi.fn() } }));

import { tdxFetch } from "../../config/fetch";
import BusRouteModel from "../../model/bus-route.model";
import { clearTransitAlertsCache, getTransitAlerts } from "./alert.service";
import { upsertAlertSnapshot } from "./alert.store";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;
const routeFindMock = BusRouteModel.find as unknown as ReturnType<typeof vi.fn>;

function mockTdxJson(payload: unknown): void {
  tdxFetchMock.mockResolvedValue({ ok: true, json: async () => payload });
}

function mockBusRoutes(rows: unknown[]): void {
  routeFindMock.mockReturnValue({ lean: () => Promise.resolve(rows) });
}

function busRouteDocument(overrides: Record<string, unknown> = {}) {
  return {
    routeId: "0100",
    subRouteName: { Zh_tw: "總站→成德高中" },
    direction: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTransitAlertsCache();
});

describe("getTransitAlerts", () => {
  it("matches a bus alert by Scope.Routes RouteID", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-route-id",
        Title: "改道",
        Description: "路線改道",
        Status: 2,
        Scope: {
          Routes: [
            {
              RouteID: "0100",
              RouteName: { Zh_tw: "總站→成德高中" },
              Direction: 0,
            },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      direction: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      alertId: "bus-route-id",
      matchKind: "route",
    });
  });

  it("matches a direction-scoped bus alert when the user omits direction", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-omit-dir",
        Title: "改道",
        Description: "去程改道",
        Status: 2,
        Scope: {
          Routes: [
            {
              RouteID: "0100",
              RouteName: { Zh_tw: "總站→成德高中" },
              Direction: 0,
            },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      alertId: "bus-omit-dir",
      matchKind: "route",
    });
  });

  it("does not treat bus Direction 2 (迴圈) as a wildcard direction", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-loop",
        Title: "改道",
        Description: "迴圈改道",
        Status: 2,
        Scope: {
          Routes: [
            {
              RouteID: "0100",
              RouteName: { Zh_tw: "總站→成德高中" },
              Direction: 2,
            },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      direction: 0,
    });

    expect(result).toMatchObject({ ok: true, alerts: [] });
  });

  it("matches a bus alert RouteName against the resolved sub-route terminal name", async () => {
    mockBusRoutes([busRouteDocument({ routeId: "different-route-id" })]);
    mockTdxJson([
      {
        AlertID: "bus-route-name",
        Title: "改道",
        Description: "路線改道",
        Status: 2,
        Scope: {
          Routes: [
            {
              RouteID: "unrelated",
              RouteName: { Zh_tw: "總站→成德高中" },
              Direction: 0,
            },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      direction: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "bus-route-name",
      matchKind: "route",
    });
  });

  it("matches a bus alert stop by stopUid", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-stop",
        Title: "取消停靠",
        Description: "本站不停靠",
        Status: 2,
        Scope: {
          Routes: [
            { RouteID: "0100", RouteName: { Zh_tw: "307" }, Direction: 0 },
          ],
          Stops: [{ StopID: "STOP-1", StopName: { Zh_tw: "市政府" } }],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      stopUid: "STOP-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "bus-stop",
      matchKind: "stop",
    });
  });

  it("filters out stop-specific bus alert when user's stops do not include the affected stop", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-stop-other",
        Title: "遠東園區站不停靠",
        Description: "施工不停靠",
        Status: 2,
        Scope: {
          Routes: [
            { RouteID: "0100", RouteName: { Zh_tw: "307" }, Direction: 0 },
          ],
          Stops: [
            { StopID: "STOP-OTHER", StopName: { Zh_tw: "遠東世紀廣場" } },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      stopUid: "STOP-1",
      stopName: "板橋公車站",
      stopUids: ["STOP-1", "STOP-2"],
      stopNames: ["板橋公車站", "萬華車站"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts).toEqual([]);
  });

  it("matches a stop-specific bus alert when user's arrival stop matches in stopUids / stopNames", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-stop-arrival",
        Title: "萬華車站不停靠",
        Description: "施工不停靠",
        Status: 2,
        Scope: {
          Routes: [
            { RouteID: "0100", RouteName: { Zh_tw: "307" }, Direction: 0 },
          ],
          Stops: [{ StopID: "STOP-2", StopName: { Zh_tw: "萬華車站" } }],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      stopUid: "STOP-1",
      stopName: "板橋公車站",
      stopUids: ["STOP-1", "STOP-2"],
      stopNames: ["板橋公車站", "萬華車站"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      alertId: "bus-stop-arrival",
      matchKind: "stop",
    });
  });

  it("filters out TDX alert with Title '取消停靠' when Scope.Stops is empty but Description specifies other stops", async () => {
    mockBusRoutes([
      busRouteDocument({ routeId: "99", subRouteName: { Zh_tw: "99" } }),
    ]);
    mockTdxJson([
      {
        AlertID: "403225146",
        Title: "取消停靠",
        Description:
          "【因配合臺中市養護工程處辦理「北區健行路(崇德路至金龍街)道路鋪面燙平改善工程」，自115年8月17日上午8時至下午5時「莒光新城」(往西)公車招呼站將臨時取消停靠，敬請您提早至前站或下一站搭乘，造成不便，敬請見諒。】",
        Status: 2,
        Scope: {
          Routes: [{ RouteID: "99", RouteName: { Zh_tw: "99" }, Direction: 0 }],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taichung",
      routeName: "99",
      stopName: "黎明文心南五路口",
      stopNames: ["黎明文心南五路口", "國立臺中科技大學"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts).toEqual([]);
  });

  it("matches TDX alert with Title '臨時站位' when Scope.Stops is empty but Description specifies user's stop", async () => {
    mockBusRoutes([
      busRouteDocument({ routeId: "99", subRouteName: { Zh_tw: "99" } }),
    ]);
    mockTdxJson([
      {
        AlertID: "402705099",
        Title: "臨時站位",
        Description:
          "【配合本市養護工程處辦理「臺中市北區三民路三段(太平路至五權路)道路、共桿建置及人行道改善工程，為維護候車安全，自115年7月14日至115年9月15日 (如因受天候因素影響將順延)「國立臺中科技大學」(往北)全線請至「墊腳石圖書文化廣場」前候車，造成不便，敬請見諒。】",
        Status: 2,
        Scope: {
          Routes: [{ RouteID: "99", RouteName: { Zh_tw: "99" }, Direction: 0 }],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taichung",
      routeName: "99",
      stopName: "黎明文心南五路口",
      stopNames: ["黎明文心南五路口", "國立臺中科技大學"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].alertId).toBe("402705099");
    expect(result.alerts[0].matchKind).toBe("stop");
  });

  it("filters normal bus alerts with Status === 1", async () => {
    mockBusRoutes([busRouteDocument()]);
    mockTdxJson([
      {
        AlertID: "bus-normal",
        Title: "正常",
        Description: "正常營運",
        Status: 1,
        Scope: {
          Routes: [
            {
              RouteID: "0100",
              RouteName: { Zh_tw: "總站→成德高中" },
              Direction: 0,
            },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      direction: 0,
    });

    expect(result).toMatchObject({ ok: true, alerts: [] });
  });

  it("matches a metro line when Scope.Lines uses object records", async () => {
    mockTdxJson({
      Alerts: [
        {
          AlertID: "metro-line-object",
          Title: "異常",
          Description: "紅線異常",
          Status: 2,
          Scope: {
            Lines: [{ LineID: "R", LineName: { Zh_tw: "淡水信義線" } }],
          },
        },
      ],
    });

    const result = await getTransitAlerts({
      mode: "metro",
      railSystem: "TRTC",
      lineCode: "R",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "metro-line-object",
      matchKind: "line",
    });
  });

  it("matches a metro line when Scope.Lines uses string records", async () => {
    mockTdxJson({
      Alerts: [
        {
          AlertID: "metro-line-string",
          Title: "異常",
          Description: "紅線異常",
          Status: 2,
          Scope: { Lines: ["R"] },
        },
      ],
    });

    const result = await getTransitAlerts({
      mode: "metro",
      railSystem: "TRTC",
      lineCode: "R",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "metro-line-string",
      matchKind: "line",
    });
  });

  it("matches a metro station in Scope.Stations", async () => {
    mockTdxJson({
      Alerts: [
        {
          AlertID: "metro-station",
          Title: "電梯維修",
          Description: "R10 電梯維修",
          Status: 2,
          Scope: {
            Stations: [{ StationID: "R10", StationName: { Zh_tw: "中山" } }],
          },
        },
      ],
    });

    const result = await getTransitAlerts({
      mode: "metro",
      railSystem: "TRTC",
      stationIds: ["R10"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "metro-station",
      matchKind: "station",
    });
  });

  it("matches a TRA alert by TrainNo", async () => {
    mockTdxJson({
      Alerts: [
        {
          AlertID: "tra-train",
          Title: "延誤",
          Description: "列車延誤",
          Status: 2,
          Direction: 0,
          Scope: { Trains: [{ TrainNo: "123" }] },
        },
      ],
    });

    const result = await getTransitAlerts({
      mode: "tra",
      trainNo: "123",
      direction: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "tra-train",
      matchKind: "train",
    });
  });

  it("matches a THSR alert section that covers the requested OD", async () => {
    mockTdxJson([
      {
        AlertID: "thsr-section",
        Title: "全停",
        Description: "區間停駛",
        Status: "X",
        Direction: 0,
        Scope: {
          LineSections: [
            {
              LineID: "THSR",
              StartingStationID: "1000",
              EndingStationID: "1200",
            },
          ],
        },
      },
    ]);

    const result = await getTransitAlerts({
      mode: "thsr",
      direction: 0,
      fromStationId: "1050",
      toStationId: "1100",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({
      alertId: "thsr-section",
      matchKind: "section",
    });
  });

  it("filters alerts whose EndTime has passed", async () => {
    mockTdxJson({
      Alerts: [
        {
          AlertID: "expired-metro",
          Title: "過期異常",
          Description: "不應顯示",
          Status: 2,
          EndTime: "2000-01-01T00:00:00+08:00",
          Scope: { Lines: ["R"] },
        },
      ],
    });

    const result = await getTransitAlerts({
      mode: "metro",
      railSystem: "TRTC",
      lineCode: "R",
    });

    expect(result).toMatchObject({ ok: true, alerts: [] });
  });

  it("serves a fresh store snapshot without calling TDX", async () => {
    upsertAlertSnapshot(
      "metro:TRTC",
      [
        {
          AlertID: "metro-from-mqtt",
          Title: "\u7570\u5e38",
          Description: "\u7d05\u7dda\u7570\u5e38",
          Status: 2,
          Scope: { Lines: ["R"] },
        },
      ],
      "mqtt",
    );

    const result = await getTransitAlerts({
      mode: "metro",
      railSystem: "TRTC",
      lineCode: "R",
    });

    expect(tdxFetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alerts[0]).toMatchObject({ alertId: "metro-from-mqtt" });
  });
});
