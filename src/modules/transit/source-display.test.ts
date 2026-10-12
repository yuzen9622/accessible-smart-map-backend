import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-route.model", () => ({
  default: { find: vi.fn(), aggregate: vi.fn() },
}));
vi.mock("../../model/bus-stop.model", () => ({
  default: { aggregate: vi.fn() },
}));
vi.mock("../../model/bus-vehicle.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => undefined),
}));

import { tdxFetch } from "../../config/fetch";
import BusRouteModel from "../../model/bus-route.model";
import BusStopModel from "../../model/bus-stop.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import { redisGet, redisSet } from "../../config/redis";
import * as bus from "./bus.service";
import * as train from "./train.service";
import { __resetRailAdapterForTest } from "../../adapters/rail.adapter";
import { createTransitRouter } from "./transit.router";
import { registry } from "../../openapi/registry";
import { TaiwanCityEn } from "../../types/transit";
import type { SupportedLang } from "../../types/lang";

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const route = frozen({
  routeUid: "R",
  subRouteUid: "S",
  routeName: { Zh_tw: "307", En: "Route 307" },
  subRouteName: { Zh_tw: "307支線", En: "Branch 307" },
  direction: 0,
  stops: [
    {
      seq: 1,
      stopUID: "A",
      stopName: { Zh_tw: "臺北", En: " Taipei " },
      lat: 25,
      lng: 121,
    },
    {
      seq: 2,
      stopUID: "B",
      stopName: { Zh_tw: "終點", En: "  " },
      lat: 25.1,
      lng: 121.1,
    },
  ],
});
const stop = frozen({
  stopUid: "A",
  stopName: { Zh_tw: "臺北", En: "Taipei" },
  city: "Taipei",
  location: { type: "Point", coordinates: [121, 25] },
  subRouteIds: ["307支線"],
  distance: 12,
});
const eta = frozen([
  {
    RouteUID: "R",
    RouteName: { Zh_tw: "307", En: "Route 307" },
    SubRouteUID: "S",
    SubRouteName: { Zh_tw: "307支線", En: "Branch 307" },
    StopUID: "A",
    StopName: { Zh_tw: "臺北", En: "Taipei" },
    Direction: 0,
    StopStatus: 0,
    EstimateTime: 180,
  },
]);
const schedule = frozen([
  {
    RouteName: route.routeName,
    SubRouteUID: "S",
    SubRouteName: route.subRouteName,
    Direction: 0,
    Timetables: [
      {
        StopTimes: [
          {
            StopSequence: 1,
            StopName: route.stops[0].stopName,
            DepartureTime: "09:00",
          },
          {
            StopSequence: 2,
            StopName: route.stops[1].stopName,
            ArrivalTime: "10:00",
          },
        ],
      },
    ],
  },
]);
function routeRows(rows: unknown[]) {
  // SAFETY: repositories consume only find().lean() and find().select().lean();
  // the fixture supplies both chains and resolves the provided source rows.
  // Other Mongoose Query methods are not called; only the external I/O is mocked.
  vi.mocked(BusRouteModel.find).mockReturnValue({
    lean: async () => rows,
    select: () => ({ lean: async () => rows }),
  } as unknown as ReturnType<typeof BusRouteModel.find>);
}
function respond(body: unknown) {
  // SAFETY: these are the Response members consumed by tdxFetch callers in this suite.
  return { ok: true, json: async () => body } as Response;
}
beforeEach(() => {
  vi.clearAllMocks();
  bus.clearStopArrivalsCache();
  __resetRailAdapterForTest();
  routeRows([route]);
  vi.mocked(BusStopModel.aggregate).mockResolvedValue([stop]);
  vi.mocked(BusRouteModel.aggregate).mockResolvedValue([
    {
      _id: { routeName: "307", city: "Taipei" },
      routeNameEn: "Route 307",
      subRoutes: [route],
    },
  ]);
  // SAFETY: only lean is used for vehicle I/O; no other query operations are exercised.
  vi.mocked(BusVehicleModel.find).mockReturnValue({
    lean: async () => [],
  } as ReturnType<typeof BusVehicleModel.find>);
  vi.mocked(tdxFetch).mockImplementation(async (url) =>
    respond(
      String(url).includes("Schedule")
        ? schedule
        : String(url).includes("Shape")
          ? []
          : eta,
    ),
  );
});
const params = { city: TaiwanCityEn.Taipei, routeName: "307" };
const stopParams = {
  city: TaiwanCityEn.Taipei,
  stopName: "臺北",
  lat: 25,
  lng: 121,
};
function withoutDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDisplay);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/Display|displayName/.test(key))
        .map(([key, child]) => [key, withoutDisplay(child)]),
    );
  return value;
}

describe("real bus producers source-only presentation", () => {
  it.each(["en", "zh-TW"] as const)(
    "all bus producers preserve canonical payload in %s",
    async (lang) => {
      const calls = [
        (lang?: SupportedLang) => bus.getBusRouteInfo({ ...params, lang }),
        (lang?: SupportedLang) => bus.getBusRouteDetail({ ...params, lang }),
        (lang?: SupportedLang) =>
          bus.getBusArrivalAtStop({ ...params, stopName: "臺北", lang }),
        (lang?: SupportedLang) =>
          bus.getBusTimetable({ ...params, lang, preserveSubRoutes: true }),
        (lang?: SupportedLang) =>
          bus.getBusRealtimeOnRoute({ ...params, lang }),
        (lang?: SupportedLang) =>
          bus.searchBusRoutes("307", undefined, 50, lang),
        (lang?: SupportedLang) =>
          bus.searchBusStops("臺北", undefined, 50, lang),
        (lang?: SupportedLang) =>
          bus.getNearbyStops({
            lat: 25,
            lng: 121,
            radius: 100,
            limit: 10,
            lang,
          }),
        (lang?: SupportedLang) =>
          bus.getBusStopArrivals({ ...stopParams, lang }),
      ];
      for (const call of calls) {
        const legacy = await call();
        const localized = await call(lang);
        expect(legacy.ok).toBe(true);
        expect(localized.ok).toBe(true);
        expect(withoutDisplay(localized)).toEqual(legacy);
        expect(JSON.stringify(localized)).toContain("Display");
      }
      const info = await bus.getBusRouteInfo({ ...params, lang });
      if (!info.ok) throw new Error(info.error);
      expect(info.routeDisplayName).toBe(lang === "en" ? "Route 307" : "307");
      expect(info.directions[0].stops.map((s) => s.displayName)).toEqual([
        lang === "en" ? "Taipei" : "臺北",
        "終點",
      ]);
      const timetable = await bus.getBusTimetable({
        ...params,
        lang,
        preserveSubRoutes: true,
      });
      if (!timetable.ok) throw new Error(timetable.error);
      expect(timetable.schedules[0].subRouteDisplayName).toBe(
        lang === "en" ? "Branch 307" : "307支線",
      );
      expect(timetable.schedules[0].frequencies[0]).toMatchObject({
        originStopDisplayName: lang === "en" ? "Taipei" : "臺北",
        stopTimes: [
          {
            seq: 1,
            stopName: "臺北",
            stopDisplayName: lang === "en" ? "Taipei" : "臺北",
            arrivalTime: "09:00",
          },
          {
            seq: 2,
            stopName: "終點",
            stopDisplayName: "終點",
            arrivalTime: "10:00",
          },
        ],
      });
    },
  );
  it("live StopOfRoute fallback uses source English without mutating source", async () => {
    routeRows([]);
    vi.mocked(tdxFetch).mockResolvedValue(
      respond(
        frozen([
          {
            RouteName: route.routeName,
            SubRouteUID: "S",
            SubRouteName: route.subRouteName,
            Direction: 0,
            Stops: [
              {
                StopName: route.stops[0].stopName,
                StopUID: "A",
                StopSequence: 1,
              },
            ],
          },
        ]),
      ),
    );
    const result = await bus.getBusRouteInfo({ ...params, lang: "en" });
    expect(result).toMatchObject({
      routeName: "307",
      routeDisplayName: "Route 307",
      source: "tdx",
      directions: [
        { subRouteUid: "S", from: "臺北", fromDisplayName: "Taipei" },
      ],
    });
  });
  it("English search opts into source query while keeping original IDs and order", async () => {
    const result = await bus.searchBusStops("Taipei", undefined, 50, "zh-TW");
    expect(result).toMatchObject({
      stops: [
        {
          stopUid: "A",
          stopName: "臺北",
          stopDisplayName: "臺北",
          routes: ["307"],
          routeDisplayNames: ["307"],
        },
      ],
    });
    expect(vi.mocked(BusStopModel.aggregate).mock.calls[0][0]).toMatchObject([
      {
        $match: {
          $or: [
            { "stopName.Zh_tw": expect.anything() },
            { "stopName.En": expect.anything() },
          ],
        },
      },
      { $limit: 250 },
    ]);
    await bus.searchBusRoutes("Route", undefined, 50, "en");
    expect(vi.mocked(BusRouteModel.aggregate).mock.calls[0][0]).toMatchObject([
      {
        $match: {
          $or: [
            { "routeName.Zh_tw": expect.anything() },
            { "routeName.En": expect.anything() },
          ],
        },
      },
      { $group: { routeNameEn: { $first: "$routeName.En" } } },
      { $limit: 50 },
    ]);
    vi.mocked(BusStopModel.aggregate).mockClear();
    await bus.searchBusStops("臺北");
    expect(vi.mocked(BusStopModel.aggregate).mock.calls[0][0]).toMatchObject([
      { $match: { "stopName.Zh_tw": expect.anything() } },
      { $limit: 250 },
    ]);
    await bus.searchBusStops("Taipei", { lat: 25, lng: 121 }, 50, "en");
    expect(
      vi.mocked(BusStopModel.aggregate).mock.calls[1][0]?.[0],
    ).toMatchObject({ $geoNear: { query: { $or: expect.any(Array) } } });
  });
  it("concurrent en/zh/legacy cache entries are distinct, same locale coalesces; joins use IDs", async () => {
    const results = await Promise.all(
      ["en", "zh-TW", undefined, "en"].map((lang) =>
        bus.getBusStopArrivals({
          ...stopParams,
          lang: lang as SupportedLang | undefined,
        }),
      ),
    );
    expect(tdxFetch).toHaveBeenCalledTimes(3);
    expect(results[0]).toEqual(results[3]);
    expect(results[0]).toMatchObject({
      stopName: "臺北",
      stopDisplayName: "Taipei",
      arrivals: [
        {
          routeName: "307",
          routeDisplayName: "Route 307",
          headsign: "終點",
          headsignDisplayName: "終點",
        },
      ],
    });
    expect(results[1]).toMatchObject({ stopDisplayName: "臺北" });
    expect(results[2]).not.toHaveProperty("stopDisplayName");
    await Promise.all(
      ["en", "zh-TW", undefined].map((lang) =>
        bus.getBusStopArrivals({
          ...stopParams,
          lang: lang as SupportedLang | undefined,
        }),
      ),
    );
    expect(tdxFetch).toHaveBeenCalledTimes(3);
    expect(
      decodeURIComponent(String(vi.mocked(tdxFetch).mock.calls[0][0])),
    ).toContain("StopUID eq 'A'");
    expect(BusRouteModel.find).toHaveBeenCalledWith({
      subRouteUid: { $in: ["S"] },
    });
  });
  it("missing and blank bus English fall back verbatim, including headsigns", async () => {
    const noEnglish = {
      ...route,
      routeName: { Zh_tw: "307" },
      subRouteName: { Zh_tw: "307支線", En: "  " },
      stops: route.stops.map((s) => ({
        ...s,
        stopName: { Zh_tw: s.stopName.Zh_tw },
      })),
    };
    routeRows([frozen(noEnglish)]);
    const info = await bus.getBusRouteInfo({ ...params, lang: "en" });
    expect(info).toMatchObject({
      routeName: "307",
      routeDisplayName: "307",
      directions: [
        {
          subRouteDisplayName: "307支線",
          fromDisplayName: "臺北",
          toDisplayName: "終點",
        },
      ],
    });
    routeRows([
      {
        ...route,
        stops: [
          { ...route.stops[1], stopName: { Zh_tw: "終點", En: "Terminus" } },
        ],
      },
    ]);
    const result = await bus.getBusStopArrivals({ ...stopParams, lang: "en" });
    expect(result).toMatchObject({
      arrivals: [
        {
          headsign: "終點",
          headsignDisplayName: "Terminus",
          estimateMinutes: 3,
          subRouteDisplayName: "Branch 307",
        },
      ],
    });
  });
  it("geometry cache identity is shared across locales", async () => {
    await bus.getBusRouteDetail({ ...params, lang: "en" });
    await bus.getBusRouteDetail({ ...params, lang: "zh-TW" });
    expect(vi.mocked(redisGet).mock.calls.map(([key]) => key)).toEqual([
      "bus:shape:v1:Taipei:307",
      "bus:shape:v1:Taipei:307",
    ]);
    expect(redisSet).not.toHaveBeenCalled();
  });
});

function railIo() {
  const stations = frozen([
    { StationID: "1000", StationName: { Zh_tw: "臺北", En: " Taipei " } },
    { StationID: "3300", StationName: { Zh_tw: "臺中", En: "Taichung" } },
    { StationID: "9", StationName: { Zh_tw: "缺英文", En: " " } },
  ]);
  vi.mocked(tdxFetch).mockImplementation(async (url) => {
    const text = String(url);
    if (text.includes("/Station?")) return respond(stations);
    if (text.includes("/OD/"))
      return respond(
        frozen([
          {
            DailyTrainInfo: {
              TrainNo: "1",
              TrainTypeName: { Zh_tw: "自強", En: "Tze-Chiang" },
            },
            OriginStopTime: { DepartureTime: "09:00" },
            DestinationStopTime: { ArrivalTime: "10:00" },
          },
        ]),
      );
    return respond(
      frozen([
        {
          TrainNo: "2",
          DepartureTime: "09:00",
          TrainTypeName: { Zh_tw: "區間", En: " " },
          EndingStationName: { Zh_tw: "臺中", En: "Taichung" },
        },
      ]),
    );
  });
}
describe("real rail parser, cache and service bilingual catalog", () => {
  it("English inputs resolve IDs, raw caches shared, omission unchanged, missing English falls back", async () => {
    railIo();
    const now = new Date("2026-10-12T00:00:00Z");
    const base = {
      originStation: "臺北",
      destinationStation: "臺中",
      date: "2026-10-12",
    };
    const [en, zh, legacy] = await Promise.all([
      train.getTrainTimetable(
        {
          ...base,
          originStation: "Taipei",
          destinationStation: "Taichung",
          lang: "en",
        },
        now,
      ),
      train.getTrainTimetable({ ...base, lang: "zh-TW" }, now),
      train.getTrainTimetable(base, now),
    ]);
    expect(en).toMatchObject({
      origin: { name: "臺北", stationID: "1000", displayName: "Taipei" },
      destination: { name: "臺中", stationID: "3300", displayName: "Taichung" },
      trains: [{ trainType: "自強", trainTypeDisplayName: "Tze-Chiang" }],
    });
    expect(withoutDisplay(en)).toEqual(legacy);
    expect(withoutDisplay(zh)).toEqual(legacy);
    expect(tdxFetch).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(tdxFetch)
        .mock.calls.map(([url]) => String(url))
        .join(" "),
    ).toContain("/1000/to/3300/");
    const board = await train.getStationTimetable(
      { station: "Taipei", date: base.date, lang: "en" },
      now,
    );
    expect(board).toMatchObject({
      station: { name: "臺北", displayName: "Taipei" },
      trains: [
        {
          trainType: "區間",
          trainTypeDisplayName: "區間",
          destination: "臺中",
          destinationDisplayName: "Taichung",
        },
      ],
    });
    expect(
      await train.suggestTrainStations({ query: "tai", lang: "zh-TW" }),
    ).toMatchObject({
      stations: [
        { name: "臺北", stationID: "1000", displayName: "臺北" },
        { name: "臺中", stationID: "3300", displayName: "臺中" },
      ],
    });
    expect(await train.suggestTrainStations({ query: "tai" })).toMatchObject({
      stations: [],
    });
    expect(
      await train.suggestTrainStations({ query: "缺", lang: "en" }),
    ).toMatchObject({ stations: [{ displayName: "缺英文" }] });
    const alias = await train.getTrainTimetable(
      { ...base, originStation: "台北", lang: "en" },
      now,
    );
    expect(alias).toMatchObject({
      origin: { name: "台北", displayName: "Taipei", stationID: "1000" },
    });
    expect(
      (await train.getTrainTimetable({ ...base, originStation: "Taipei" }, now))
        .ok,
    ).toBe(false);
    expect(
      await train.getTrainTimetable(
        {
          ...base,
          originStation: "Taipei",
          destinationStation: "臺北",
          lang: "en",
        },
        now,
      ),
    ).toMatchObject({ ok: false, error: "起訖站相同" });
  });
});

const endpoints = [
  ["bus/route", { routeName: "307", city: "Taipei" }],
  ["bus/route-detail", { routeName: "307", city: "Taipei" }],
  ["bus/arrival", { routeName: "307", stopName: "臺北", city: "Taipei" }],
  ["bus/timetable", { routeName: "307", city: "Taipei" }],
  ["bus/positions", { routeName: "307", city: "Taipei" }],
  ["bus/search-routes", { keyword: "Route" }],
  ["bus/search-route", { keyword: "Route" }],
  ["bus/search-stops", { keyword: "Taipei" }],
  ["bus/search-stop", { keyword: "Taipei" }],
  ["bus/nearby-stops", { lat: 25, lng: 121 }],
  ["bus/stop-arrivals", stopParams],
  ["train/stations", { query: "tai" }],
  [
    "train/timetable",
    { originStation: "Taipei", destinationStation: "Taichung" },
  ],
  ["train/station-timetable", { station: "Taipei" }],
] as const;
describe("real router/controller/service source lang validation and OpenAPI", () => {
  const app = express().use("/transit", createTransitRouter());
  it.each(endpoints)(
    "%s accepts alias, rejects invalid lang",
    async (path, query) => {
      if (path.startsWith("train")) railIo();
      const invalid = await request(app)
        .get(`/transit/${path}`)
        .query({ ...query, lang: "fr" });
      expect(invalid.status).toBe(400);
      const response = await request(app)
        .get(`/transit/${path}`)
        .query({ ...query, lang: "EN-us" });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body.data)).toMatch(/Display|displayName/);
      const zh = await request(app)
        .get(`/transit/${path}`)
        .query({ ...query, lang: "zh-Hant" });
      expect(zh.status).toBe(200);
      const legacyQuery =
        path === "train/timetable"
          ? { originStation: "臺北", destinationStation: "臺中" }
          : path === "train/station-timetable"
            ? { station: "臺北" }
            : query;
      const legacy = await request(app)
        .get(`/transit/${path}`)
        .query(legacyQuery);
      expect(legacy.status).toBe(200);
      expect(JSON.stringify(legacy.body.data)).not.toMatch(
        /Display|displayName/,
      );
    },
  );
  it("OpenAPI exposes optional lang on all read aliases and optional display fields", () => {
    const document = new OpenApiGeneratorV3(
      registry.definitions,
    ).generateDocument({
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
    });
    for (const [path] of endpoints) {
      const operation = document.paths[`/transit/${path}`]?.get;
      expect(operation).toBeDefined();
      expect(operation?.parameters).toContainEqual(
        expect.objectContaining({ name: "lang", in: "query", required: false }),
      );
    }
    expect(document.components?.schemas?.BusRouteDirection).toMatchObject({
      properties: {
        fromDisplayName: { type: "string" },
        subRouteDisplayName: { type: "string" },
      },
    });
    expect(document.components?.schemas?.BusStopSearchResult).toMatchObject({
      properties: { routeDisplayNames: { type: "array" } },
    });
  });
});
