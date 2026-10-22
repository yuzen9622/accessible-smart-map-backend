import { describe, expect, it, vi } from "vitest";
const { getCanonicalBusPair } = vi.hoisted(() => ({
  getCanonicalBusPair: vi.fn(),
}));
vi.mock("../transit/bus-stop-pair-eta.service", async (original) => ({
  ...(await original<typeof import("../transit/bus-stop-pair-eta.service")>()),
  getCanonicalBusPair,
}));
import {
  collectBusCandidates,
  selectedBusLeg,
} from "./bus-stop-pair-candidates";
import { createCandidateRequestBudget } from "../transit/bus-stop-pair-eta.service";
import type { BusDepartureCandidate, BusLeg } from "../../types/route";

const now = Date.parse("2026-10-21T20:14:00+08:00");
const at = (minute: number) => now + minute * 60000;
const iso = (minute: number) =>
  new Date(at(minute)).toISOString().replace("Z", "+00:00");
const leg: BusLeg = {
  type: "BUS",
  routeName: "73",
  subRouteUid: "TXG73",
  subRouteName: "73",
  departureStop: "豐樂公園",
  arrivalStop: "臺中車站(C月台)",
  departureStopId: "S1",
  arrivalStopId: "S2",
  direction: 0,
  tdxCity: "Taichung",
  polyline: [
    [120.64, 24.13],
    [120.68, 24.13],
  ],
  waitInfo: { time: null, source: "unavailable" },
  departureStopA11y: [],
  arrivalStopA11y: [],
};
const seed = (minute: number) => ({
  leg,
  candidate: {
    candidateId: `TXG73|0|trip-${minute}|${at(minute)}`,
    tripId: `trip-${minute}`,
    routeName: "73",
    subRouteUid: "TXG73",
    direction: 0,
    departureStopId: "S1",
    arrivalStopId: "S2",
    estimatedWaitMinutes: minute,
    boardingTime: iso(minute),
    alightingTime: iso(minute + 30),
    boardingTimeSource: "schedule",
    alightingTimeSource: "schedule",
    vehicleAccessibility: "unknown",
    hasLiftOrRamp: null,
    selected: false,
  } satisfies BusDepartureCandidate,
});
const board = { seq: 1, stopUID: "S1", lat: 24.13, lng: 120.64 };
const alight = { seq: 2, stopUID: "S2", lat: 24.13, lng: 120.68 };
const pairRoute = (subRouteUid: string, routeName: string) => ({
  subRouteUid,
  routeName: { Zh_tw: routeName },
  direction: 0,
  board,
  alight,
  stops: [board, alight],
});
const timetableTrip = (subRouteUid: string, minute: number) => ({
  tripId: `${subRouteUid}-trip-${minute}`,
  subRouteUid,
  direction: 0,
  stops: [board, alight].map((s, i) => ({
    stopUid: s.stopUID,
    name: s.stopUID,
    lat: s.lat,
    lng: s.lng,
    arrivalAt: at(minute + i * 10),
    departureAt: at(minute + i * 10),
  })),
});
const serveLive = (
  buses: { plate?: string; minute: number; alights?: false }[],
  extra: {
    routes?: ReturnType<typeof pairRoute>[];
    trips?: ReturnType<typeof timetableTrip>[];
  } = {},
) => {
  getCanonicalBusPair.mockResolvedValue({
    complete: true,
    vehicles: [],
    trips: extra.trips ?? [],
    routes: [
      {
        route: pairRoute("TXG73", "73"),
        eta: buses.map((b) => ({
          plateNumb: b.plate,
          boardingAt: at(b.minute),
          alightingAt: b.alights === false ? null : at(b.minute + 30),
        })),
      },
      ...(extra.routes ?? []).map((route) => ({ route, eta: [] })),
    ],
  });
};
const collectRaw = async (seeds: ReturnType<typeof seed>[]) => {
  const budget = createCandidateRequestBudget();
  try {
    const result = await collectBusCandidates({
      base: leg,
      seeds,
      canonicalBoard: "S1",
      canonicalAlight: "S2",
      now,
      budget,
      memo: new Map(),
    });
    expect(
      result.candidates.every((c) => result.materialized.has(c.candidateId)),
    ).toBe(true);
    return result;
  } finally {
    budget.close();
  }
};
const collect = async (seeds: ReturnType<typeof seed>[]) =>
  (await collectRaw(seeds)).candidates.map(
    (c) =>
      `${c.subRouteUid === "TXG73" ? "" : `${c.routeName} `}${c.boardingTimeSource}@${c.estimatedWaitMinutes}`,
  );

describe("timetable copies of live buses", () => {
  it("shows a tracked bus once, not again as its timetable trip", async () => {
    serveLive([{ plate: "788-U5", minute: 22 }]);
    expect(await collect([seed(22)])).toEqual(["realtime@22"]);
  });

  it("treats a trip slightly after a bus running early as that bus", async () => {
    serveLive([{ plate: "788-U5", minute: 18 }]);
    expect(await collect([seed(22)])).toEqual(["realtime@18"]);
  });

  it("keeps the next timetable trip after the tracked bus", async () => {
    serveLive([{ plate: "788-U5", minute: 22 }]);
    expect(await collect([seed(22), seed(40)])).toEqual([
      "realtime@22",
      "schedule@40",
    ]);
  });

  it("lists a boarding-only bus once, as its trip with the live boarding time", async () => {
    serveLive([{ plate: "788-U5", minute: 24, alights: false }]);
    const { candidates } = await collectRaw([seed(22)]);
    expect(candidates).toEqual([
      expect.objectContaining({
        candidateId: seed(22).candidate.candidateId,
        tripId: "trip-22",
        plateNumb: "788-U5",
        estimatedWaitMinutes: 24,
        boardingTimeSource: "realtime",
        alightingTime: iso(52),
        alightingTimeSource: "schedule",
      }),
    ]);
    expect(Date.parse(candidates[0].boardingTime ?? "")).toBe(at(24));
  });

  it("keeps matching a live-boarding trip by its timetable departure", async () => {
    serveLive([{ plate: "788-U5", minute: 24, alights: false }]);
    const tripLeg: BusLeg = {
      ...leg,
      scheduledTrip: {
        tripId: "trip-22",
        boardingReadyAt: now,
        stops: [
          { stopUid: "S1", name: "S1", departureAt: at(22) },
          { stopUid: "S2", name: "S2", arrivalAt: at(52) },
        ],
      },
    };
    const { candidates } = await collectRaw([{ ...seed(22), leg: tripLeg }]);
    const selected = selectedBusLeg(tripLeg, candidates[0], now);
    expect(selected._scheduledDepartureTime).toBe(at(22));
    expect(selected.waitInfo).toEqual({ time: 24, source: "realtime" });
  });

  it("never drops a bunched bus whose trip another bus already took", async () => {
    serveLive([
      { plate: "W", minute: 20, alights: false },
      { plate: "X", minute: 23, alights: false },
    ]);
    expect(await collect([seed(22), seed(27)])).toEqual([
      "realtime@20",
      "realtime@23",
      "schedule@27",
    ]);
  });

  it("does not lend a bus later than the trip's alighting to that trip", async () => {
    serveLive([{ plate: "788-U5", minute: 30, alights: false }]);
    const short = seed(22);
    short.candidate = { ...short.candidate, alightingTime: iso(28) };
    expect(await collect([short])).toEqual(["realtime@30", "schedule@22"]);
  });

  it("lists a trip shared by skeleton members once, with its live time", async () => {
    serveLive([{ plate: "788-U5", minute: 24, alights: false }]);
    expect(await collect([seed(22), seed(22)])).toEqual(["realtime@24"]);
  });

  it("prefers an untracked first-stop prediction over the timetable time", async () => {
    serveLive([{ minute: 38 }]);
    expect(await collect([seed(36)])).toEqual(["realtime@38"]);
  });

  it("gives one bus's live time only to the closest of the trips it twins", async () => {
    serveLive([{ plate: "788-U5", minute: 23, alights: false }]);
    expect(await collect([seed(18), seed(22)])).toEqual([
      "schedule@18",
      "realtime@23",
    ]);
  });
});

describe("every route between the same two stops", () => {
  it("lists other routes' timetable trips beside the live bus", async () => {
    serveLive([{ plate: "597-U8", minute: 2 }], {
      routes: [pairRoute("TXG12", "12")],
      trips: [timetableTrip("TXG12", 2), timetableTrip("TXG12", 82)],
    });
    expect(await collect([])).toEqual([
      "realtime@2",
      "12 schedule@2",
      "12 schedule@82",
    ]);
  });

  it("drops the timetable copy of a live bus and a trip the plan already has", async () => {
    serveLive([{ plate: "597-U8", minute: 22 }], {
      trips: [
        timetableTrip("TXG73", 22),
        { ...timetableTrip("TXG73", 40), tripId: "trip-40" },
      ],
    });
    expect(await collect([seed(40)])).toEqual(["realtime@22", "schedule@40"]);
  });
});
