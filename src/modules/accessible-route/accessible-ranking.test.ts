import { describe, expect, it } from "vitest";
import type { AccessibleRoute } from "../../types/route";
import { rankRoutesForMode } from "./accessible-ranking";
import { compareRoutesByArrival } from "./bus-stop-pair-candidates";

const at = (hhmm: string) => `2026-11-05T${hhmm}:00+08:00`;

/** Departs 08:52; legs only carry what the ranking reads. */
function route(
  id: string,
  arrival: string,
  walkM: number,
  opts: {
    transfers?: number;
    lowFloorBuses?: number;
    walkOnly?: boolean;
    degraded?: boolean;
    vehicle?: "BUS" | "METRO" | "THSR" | "TRA";
  } = {},
): AccessibleRoute {
  const buses = opts.walkOnly ? 0 : (opts.transfers ?? 0) + 1;
  const lowFloor = opts.lowFloorBuses ?? 0;
  const legs = [
    { type: "WALK", distanceM: walkM },
    ...Array.from({ length: buses }, (_, i) => ({
      type: opts.vehicle ?? "BUS",
      isLowFloor: i < lowFloor,
    })),
  ];
  const totalMinutes =
    (Date.parse(at(arrival)) - Date.parse(at("08:52"))) / 60_000;
  return {
    routeId: id,
    departureTime: at("08:52"),
    arrivalTime: at(arrival),
    totalMinutes,
    transferCount: opts.transfers ?? 0,
    totalWalkDistanceM: walkM,
    degraded: opts.degraded,
    legs,
  } as unknown as AccessibleRoute;
}

const ids = (routes: AccessibleRoute[]) => routes.map((r) => r.routeId);

describe("rankRoutesForMode", () => {
  it("keeps earliest-arrival order for modes without weights", () => {
    const routes = [
      route("walk", "09:10", 1500, { walkOnly: true }),
      route("late-bus", "09:30", 200),
      route("early-bus", "09:20", 900),
    ];
    for (const mode of ["normal", "visual_impaired"] as const) {
      expect(ids(rankRoutesForMode(routes, mode))).toEqual(
        ids([...routes].sort(compareRoutesByArrival)),
      );
    }
    expect(ids(rankRoutesForMode(routes, "normal"))).toEqual([
      "early-bus",
      "late-bus",
      "walk",
    ]);
  });

  it("takes a slightly later wheelchair route that rolls far less", () => {
    // Field case near 台中 大慶: bus 414 m by 09:25, metro 952 m by 09:29,
    // a 2.65 km roll by 09:49.
    const ranked = rankRoutesForMode(
      [
        route("metro", "09:29", 952),
        route("walk", "09:49", 2650, { walkOnly: true }),
        route("bus", "09:25", 414),
      ],
      "wheelchair",
    );
    expect(ids(ranked)).toEqual(["bus", "metro", "walk"]);
  });

  it("prefers less walking even when it arrives later, up to the cap", () => {
    // 1.7 km at 0.8 m/s is 35 min of rolling; 800 m is 17 min.
    const routes = [
      route("long-roll", "09:26", 1700, { walkOnly: true }),
      route("short-roll", "09:40", 800),
    ];
    expect(ids(rankRoutesForMode(routes, "wheelchair"))).toEqual([
      "short-roll",
      "long-roll",
    ]);
    // 21 min later than the earliest arrival exceeds the 20-min cap.
    const tooLate = [routes[0], route("short-roll", "09:47", 100)];
    expect(ids(rankRoutesForMode(tooLate, "wheelchair"))).toEqual([
      "long-roll",
      "short-roll",
    ]);
  });

  it("weighs wheelchair walking at 2.5x", () => {
    // 600 m more rolling (12.5 min) costs 18.75 extra minutes at 2.5x, so a
    // route arriving 18 min later with less rolling wins, 19 min later loses.
    const longer = route("longer", "09:20", 1000);
    expect(
      ids(
        rankRoutesForMode([longer, route("less", "09:38", 400)], "wheelchair"),
      ),
    ).toEqual(["less", "longer"]);
    expect(
      ids(
        rankRoutesForMode([longer, route("less", "09:39", 400)], "wheelchair"),
      ),
    ).toEqual(["longer", "less"]);
  });

  it("charges a transfer the larger of the minimum and the trip share", () => {
    // 68-min trip: 25% = 17 min beats the 8-min floor.
    const longTransfer = route("transfer", "10:00", 300, { transfers: 1 });
    expect(
      ids(
        rankRoutesForMode(
          [longTransfer, route("direct", "10:16", 300)],
          "wheelchair",
        ),
      ),
    ).toEqual(["direct", "transfer"]);
    expect(
      ids(
        rankRoutesForMode(
          [longTransfer, route("direct", "10:18", 300)],
          "wheelchair",
        ),
      ),
    ).toEqual(["transfer", "direct"]);
    // 20-min trip: 25% = 5 min, so the 8-min floor applies.
    const shortTransfer = route("transfer", "09:12", 300, { transfers: 1 });
    expect(
      ids(
        rankRoutesForMode(
          [shortTransfer, route("direct", "09:19", 300)],
          "wheelchair",
        ),
      ),
    ).toEqual(["direct", "transfer"]);
    expect(
      ids(
        rankRoutesForMode(
          [shortTransfer, route("direct", "09:21", 300)],
          "wheelchair",
        ),
      ),
    ).toEqual(["transfer", "direct"]);
  });

  it("lets a short walk-only route win on cost", () => {
    const ranked = rankRoutesForMode(
      [
        route("bus", "09:10", 300),
        route("walk", "09:00", 350, { walkOnly: true }),
      ],
      "wheelchair",
    );
    expect(ids(ranked)).toEqual(["walk", "bus"]);
  });

  it("charges each transfer at least the mode's minimum", () => {
    // Wheelchair: max(8 min, 25% of trip) per transfer.
    const direct = route("direct", "09:30", 300);
    const transfer = route("transfer", "09:24", 300, { transfers: 1 });
    expect(ids(rankRoutesForMode([transfer, direct], "wheelchair"))).toEqual([
      "direct",
      "transfer",
    ]);
    // Elderly: max(6 min, 20%); a 32-min transfer trip costs 6.4 min.
    const elderlyTransfer = route("transfer", "09:24", 300, { transfers: 1 });
    const elderlyDirect = route("direct", "09:31", 300);
    expect(
      ids(rankRoutesForMode([elderlyDirect, elderlyTransfer], "elderly")),
    ).toEqual(["transfer", "direct"]);
  });

  it("credits a confirmed low-floor bus instead of always preferring it", () => {
    const unknown = route("unknown", "09:20", 400);
    const lowSoon = route("low", "09:28", 400, { lowFloorBuses: 1 });
    const lowLate = route("low", "09:32", 400, { lowFloorBuses: 1 });
    expect(ids(rankRoutesForMode([unknown, lowSoon], "wheelchair"))).toEqual([
      "low",
      "unknown",
    ]);
    expect(ids(rankRoutesForMode([unknown, lowLate], "wheelchair"))).toEqual([
      "unknown",
      "low",
    ]);
  });

  it("credits metro and high-speed rail boardings like a low-floor bus", () => {
    const unknownBus = route("bus", "09:20", 400);
    for (const vehicle of ["METRO", "THSR"] as const) {
      const rail = route("rail", "09:28", 400, { vehicle });
      expect(ids(rankRoutesForMode([unknownBus, rail], "wheelchair"))).toEqual([
        "rail",
        "bus",
      ]);
    }
    // TRA platform heights vary, so it earns no step-free credit.
    const tra = route("rail", "09:28", 400, { vehicle: "TRA" });
    expect(ids(rankRoutesForMode([unknownBus, tra], "wheelchair"))).toEqual([
      "bus",
      "rail",
    ]);
  });

  it("never ranks a degraded route above an eligible one", () => {
    const ranked = rankRoutesForMode(
      [
        route("degraded", "09:00", 50, { degraded: true }),
        route("eligible", "09:40", 1200),
      ],
      "wheelchair",
    );
    expect(ids(ranked)).toEqual(["eligible", "degraded"]);
  });
});
