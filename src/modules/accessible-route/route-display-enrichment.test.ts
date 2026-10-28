import { beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({
  bus: vi.fn(),
  routes: vi.fn(),
  metro: vi.fn(),
  train: vi.fn(),
}));
vi.mock("../../model/bus-stop.model", () => ({ default: { find: io.bus } }));
vi.mock("../../model/bus-route.model", () => ({
  default: { find: io.routes },
}));
vi.mock("../../model/metro-station.model", () => ({
  default: { find: io.metro },
}));
vi.mock("../../model/train-station.model", () => ({
  default: { find: io.train },
}));
import { enrichRouteDisplayNames } from "./route-display-enrichment";
import type {
  AccessibleRoute,
  BusLeg,
  MetroLeg,
  WalkLeg,
  WalkStep,
} from "../../types/route";
import { attachBusSchedule, attachInternalSchedule } from "./route-schedule";
import {
  generateNavInstructions,
  normalizedStreetNames,
  normalizeWalkLegSteps,
} from "../../utils/nav-instructions-engine";

const machineStep: WalkStep = {
  relativeDirection: "DEPART",
  absoluteDirection: "EAST",
  streetName: "同名路",
  bogusName: false,
  area: false,
  stairs: false,
  steepSlope: false,
  distanceM: 70,
  location: [121, 25],
};
const bus = (id: string): BusLeg => ({
  type: "BUS",
  routeName: "同名公車",
  subRouteName: "同名支線",
  subRouteUid: `route-${id}`,
  departureStop: "同名站",
  arrivalStop: "無英站",
  departureStopId: id,
  arrivalStopId: "missing",
  waitInfo: { time: 2, source: "realtime" },
  direction: 0,
  polyline: [],
  departureStopA11y: [],
  arrivalStopA11y: [],
  intermediateStops: [{ name: "同名站", stationUid: id }],
});
const walk = (): WalkLeg => ({
  type: "WALK",
  from: "起點",
  to: "終點",
  distanceM: 70,
  minutesEst: 2,
  polyline: [
    [121, 25],
    [121.001, 25],
  ],
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
  steps: [machineStep],
  stepStreetNames: [
    {
      index: 0,
      streetName: "同名路",
      nameEn: "Source Road",
      displayName: "stale saved display",
    },
  ],
});
const route = (legs: AccessibleRoute["legs"]): AccessibleRoute => ({
  routeId: "id",
  routeName: "原始",
  legs,
  totalMinutes: 20,
  transferCount: 0,
  accessibilityHighlights: [],
});
function query(fn: typeof io.bus, rows: unknown[] = []) {
  fn.mockReturnValue({
    select: () => ({ lean: () => ({ exec: async () => rows }) }),
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(io)) query(fn);
});

describe("real route source enrichment", () => {
  it("uses stable IDs, batches once per model, preserves frozen raw and hidden schedules across concurrent locales", async () => {
    query(io.bus, [
      { stopUid: "TPE1", stopName: { En: " Taipei One " } },
      { stopUid: "KHH1", stopName: { En: "Kaohsiung One" } },
    ]);
    query(io.routes, [
      { subRouteUid: "route-TPE1", routeName: { En: "Taipei Bus" } },
    ]);
    const first = bus("TPE1");
    attachBusSchedule(first, 10, 9, "trip");
    const raw = freeze(
      attachInternalSchedule(
        route([first, bus("KHH1"), walk()]),
        10,
        20,
        false,
      ),
    );
    const before = JSON.stringify(raw);
    const [[en], [zh]] = await Promise.all([
      enrichRouteDisplayNames([raw], "en"),
      enrichRouteDisplayNames([raw], "zh-TW"),
    ]);
    expect(en.legs[0]).toMatchObject({
      fromDisplayName: "Taipei One",
      toDisplayName: "無英站",
      routeDisplayName: "Taipei Bus",
      departureStop: "同名站",
      fromNameEn: "Taipei One",
      intermediateStops: [
        {
          name: "同名站",
          nameEn: "Taipei One",
          displayName: "Taipei One",
          stationUid: "TPE1",
        },
      ],
    });
    expect(en.legs[1]).toMatchObject({ fromDisplayName: "Kaohsiung One" });
    expect(zh.legs[0]).toMatchObject({
      fromDisplayName: "同名站",
      routeDisplayName: "同名公車",
      fromNameEn: "Taipei One",
    });
    expect(en._scheduledDepartureTime).toBe(10);
    expect(en.legs[0]).toHaveProperty("_scheduledTripId", "trip");
    expect(Object.keys(en.legs[0])).not.toContain("_scheduledTripId");
    expect(JSON.stringify(raw)).toBe(before);
    expect(io.bus).toHaveBeenCalledTimes(2);
    expect(io.routes).toHaveBeenCalledTimes(2);
    expect(io.bus).toHaveBeenCalledWith({
      stopUid: { $in: ["TPE1", "missing", "KHH1"] },
    });
    expect(io.metro).not.toHaveBeenCalled();
    expect(io.train).not.toHaveBeenCalled();
  });
  it("renders English-only facilities, omits empty displays and clears stale locale presentation without mutating sources", async () => {
    const leg = walk();
    const facility = {
      osmId: "n1",
      category: "elevator" as const,
      tags: { "name:en": "Source Elevator" },
      location: {
        type: "Point" as const,
        coordinates: [121, 25] as [number, number],
      },
      importedAt: new Date(0),
    };
    leg.a11yFacilities = [
      facility,
      { ...facility, osmId: "n2", name: " ", tags: {} },
    ];
    const raw = freeze(route([leg]));
    const [en] = await enrichRouteDisplayNames([raw], "en");
    const enFacilities = (en.legs[0] as WalkLeg).a11yFacilities;
    expect(enFacilities[0]).toHaveProperty("displayName", "Source Elevator");
    expect(enFacilities[0]).not.toHaveProperty("name");
    expect(enFacilities[1]).not.toHaveProperty("displayName");
    const [zh] = await enrichRouteDisplayNames([en], "zh-TW");
    expect((zh.legs[0] as WalkLeg).a11yFacilities[0]).not.toHaveProperty(
      "displayName",
    );
    expect(enFacilities[0]).toHaveProperty("displayName", "Source Elevator");
    expect(facility).not.toHaveProperty("displayName");
  });
  it("omission preserves legacy DTO and introduces zero I/O even with CSR sources", async () => {
    const raw = freeze([route([bus("TPE1"), walk()])]);
    expect(await enrichRouteDisplayNames(raw)).toBe(raw);
    for (const fn of Object.values(io)) expect(fn).not.toHaveBeenCalled();
  });
  it("has four fixed batches for many legs, disambiguates train system plus ID and supports actual stationUID and legacy stationID", async () => {
    query(io.metro, [
      { stationUid: "TRTC1", stationName: { En: "Metro Source" } },
    ]);
    query(io.train, [
      {
        railSystem: "TRA",
        stationUID: "TRA-1",
        stationID: "1",
        stationName: { En: "Rail Source" },
      },
      {
        railSystem: "THSR",
        stationUID: "THSR-1",
        stationID: "1",
        stationName: { En: "High Speed Source" },
      },
    ]);
    const rail = (type: "TRA" | "THSR", id: string) =>
      ({
        type,
        departureStation: "同名站",
        arrivalStation: "同名站",
        departureStationUID: id,
        arrivalStationUID: "1",
        trainNo: "1",
        trainTypeName: "車種",
        departureTime: "10:00",
        arrivalTime: "10:10",
        rideMinutes: 10,
        waitInfo: { time: 0, source: "schedule" },
        polyline: [],
        departureStationA11y: [],
        arrivalStationA11y: [],
        facilityHighlights: [],
        intermediateStops: [{ name: "同名站", stationUid: "1" }],
      }) as AccessibleRoute["legs"][number];
    const metro = {
      ...rail("TRA", "1"),
      type: "METRO",
      railSystem: "TRTC",
      lineId: "R",
      lineUid: "TRTC-R",
      lineName: "紅線",
      departureStationUid: "TRTC1",
      arrivalStationUid: "TRTC1",
      direction: 0,
      stopsCount: 1,
    } as AccessibleRoute["legs"][number];
    const [en] = await enrichRouteDisplayNames(
      [
        route(
          Array.from({ length: 20 }, () => [
            bus("TPE1"),
            metro,
            rail("TRA", "TRA-1"),
            rail("THSR", "1"),
          ]).flat(),
        ),
      ],
      "en",
    );
    expect(en.legs[1]).toMatchObject({
      fromDisplayName: "Metro Source",
      routeDisplayName: "紅線",
    });
    expect(en.legs[2]).toMatchObject({
      fromDisplayName: "Rail Source",
      toDisplayName: "Rail Source",
    });
    expect(en.legs[3]).toMatchObject({ fromDisplayName: "High Speed Source" });
    for (const fn of Object.values(io)) expect(fn).toHaveBeenCalledTimes(1);
    expect(io.train.mock.calls[0][0].$or[0]).toMatchObject({
      railSystem: "TRA",
    });
    expect(io.train.mock.calls[0][0].$or[1]).toMatchObject({
      railSystem: "THSR",
    });
  });
  it("localizes the metro trip terminal by its own station ID, separately from the alighting station", async () => {
    query(io.metro, [
      { stationUid: "TRTC_BL01", stationName: { En: "Dingpu" } },
      { stationUid: "TRTC_BL12", stationName: { En: "Taipei Main Station" } },
    ]);
    const metro = (patch: Partial<MetroLeg>) =>
      ({
        type: "METRO",
        railSystem: "TRTC",
        lineId: "BL",
        lineUid: "TRTC_BL_BL-1_1",
        lineName: "板南線",
        departureStation: "市政府",
        arrivalStation: "台北車站",
        departureStationUid: "TRTC_BL18",
        arrivalStationUid: "TRTC_BL12",
        direction: 1,
        stopsCount: 6,
        rideMinutes: 10,
        waitInfo: { time: 0, source: "schedule" },
        polyline: [],
        departureStationA11y: [],
        arrivalStationA11y: [],
        facilityHighlights: [],
        ...patch,
      }) as MetroLeg;
    const legs = [
      metro({
        lineKey: "TRTC_BL",
        terminalStation: "頂埔",
        terminalStationUid: "TRTC_BL01",
      }),
      metro({ terminalStation: "亞東醫院", terminalStationUid: "TRTC_BL05" }),
      metro({}),
    ];

    const [en] = await enrichRouteDisplayNames([route(legs)], "en");
    const [zh] = await enrichRouteDisplayNames([route(legs)], "zh-TW");

    expect(io.metro.mock.calls[0][0].stationUid.$in).toEqual(
      expect.arrayContaining(["TRTC_BL01", "TRTC_BL05"]),
    );
    expect(JSON.parse(JSON.stringify(en.legs))).toMatchObject([
      {
        terminalStation: "頂埔",
        terminalNameEn: "Dingpu",
        terminalDisplayName: "Dingpu",
        toDisplayName: "Taipei Main Station",
        routeNameEn: "Bannan Line",
        routeDisplayName: "Bannan Line",
      },
      { terminalStation: "亞東醫院", terminalDisplayName: "亞東醫院" },
      { toDisplayName: "Taipei Main Station" },
    ]);
    expect(en.legs[1]).not.toHaveProperty("terminalNameEn");
    expect(en.legs[1]).toMatchObject({ routeDisplayName: "板南線" });
    expect(zh.legs[0]).toMatchObject({ routeDisplayName: "板南線" });
    expect(en.legs[2]).not.toHaveProperty("terminalStation");
    expect(en.legs[2]).not.toHaveProperty("terminalDisplayName");
    expect(zh.legs[0]).toMatchObject({ terminalDisplayName: "頂埔" });
  });

  it("blank/missing English and conflicting same-ID route records fall back without guessing", async () => {
    query(io.bus, [
      { stopUid: "TPE1", stopName: { En: "  " } },
      { stopUid: "missing", stopName: { Zh_tw: "無英站" } },
    ]);
    query(io.routes, [
      { subRouteUid: "route-TPE1", routeName: { En: "One" } },
      { subRouteUid: "route-TPE1", routeName: { En: "Two" } },
    ]);
    const [en] = await enrichRouteDisplayNames([route([bus("TPE1")])], "en");
    expect(en.legs[0]).toMatchObject({
      fromDisplayName: "同名站",
      toDisplayName: "無英站",
      routeDisplayName: "同名公車",
    });
    expect(en.legs[0]).not.toHaveProperty("fromNameEn");
    expect(en.legs[0]).not.toHaveProperty("routeNameEn");
  });

  it("lookup failures are fail-soft and log only safe constant text", async () => {
    io.bus.mockImplementation(() => {
      throw new Error("secret query endpoint");
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [en] = await enrichRouteDisplayNames([route([bus("TPE1")])], "en");
    expect(en.legs[0]).toMatchObject({
      fromDisplayName: "同名站",
      toDisplayName: "無英站",
      routeDisplayName: "同名公車",
    });
    expect(log).toHaveBeenCalledWith(
      "[accessible-route] source name lookup unavailable",
    );
    expect(log.mock.calls.flat().join()).not.toContain("secret");
    log.mockRestore();
  });
  it("retains facility canonical names and genuine OSM name:en in compact and leg payloads", async () => {
    const f = {
      osmId: "node/1",
      category: "elevator" as const,
      name: "電梯",
      location: {
        type: "Point" as const,
        coordinates: [121, 25] as [number, number],
      },
      tags: { "name:en": "Lift" },
    };
    const leg = walk();
    leg.a11yFacilities = [f as never];
    const raw = freeze({ ...route([leg]), facilities: { "node/1": f } });
    const [en] = await enrichRouteDisplayNames([raw], "en");
    expect(en.facilities?.["node/1"]).toMatchObject({
      name: "電梯",
      displayName: "Lift",
    });
    expect((en.legs[0] as WalkLeg).a11yFacilities[0]).toMatchObject({
      name: "電梯",
      displayName: "Lift",
    });
  });
  it("rejects duplicate and stale sidecars, never trusts saved display names", async () => {
    for (const entries of [
      [
        {
          index: 1,
          streetName: "同名路",
          nameEn: "wrong",
          displayName: "wrong",
        },
      ],
      [
        {
          index: 0,
          streetName: "異名路",
          nameEn: "wrong",
          displayName: "wrong",
        },
      ],
      [walk().stepStreetNames![0], walk().stepStreetNames![0]],
    ]) {
      const leg = walk();
      leg.stepStreetNames = entries;
      const [en] = await enrichRouteDisplayNames([route([leg])], "en");
      expect((en.legs[0] as WalkLeg).stepStreetNames).toEqual([]);
      const nav = generateNavInstructions(en, undefined, "en");
      expect(nav.ok && nav.data.instructions[0].text).toContain("同名路");
    }
    const [en] = await enrichRouteDisplayNames([route([walk()])], "en");
    expect((en.legs[0] as WalkLeg).stepStreetNames?.[0].displayName).toBe(
      "Source Road",
    );
  });
  it("remaps validated source provenance through merging without widening WALK9", () => {
    const leg = walk();
    leg.steps![0] = { ...machineStep, distanceM: 800 };
    const steps = normalizeWalkLegSteps(leg, true);
    const names = normalizedStreetNames(leg, steps, "en");
    expect(steps).toHaveLength(1);
    expect(names).toHaveLength(1);
    for (const step of steps) expect(Object.keys(step)).toHaveLength(9);
    const duplicateStreet = walk();
    duplicateStreet.steps = [
      { ...machineStep, relativeDirection: "CONTINUE" },
      { ...machineStep, relativeDirection: "CONTINUE" },
    ];
    duplicateStreet.stepStreetNames = [
      walk().stepStreetNames![0],
      { ...walk().stepStreetNames![0], index: 1, nameEn: "Other Road" },
    ];
    expect(
      normalizedStreetNames(
        duplicateStreet,
        normalizeWalkLegSteps(duplicateStreet, true),
        "en",
      ),
    ).toEqual([]);
  });
});
