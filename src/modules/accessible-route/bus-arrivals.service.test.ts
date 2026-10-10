import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { redisGet, redisSet, tdxFetch } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  tdxFetch: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisGet,
  redisSet,
  redisClient: {},
  redisReady: vi.fn(),
}));
vi.mock("../../config/fetch", () => ({ tdxFetch }));
import { storeBusPlan } from "./bus-plan.repository";
import type { AccessibleRoute } from "../../types/route";
import { getPlannedBusArrivals } from "./bus-arrivals.service";

const at = (time: string) => Date.parse(`2030-01-01T${time}:00+08:00`);
function plan(departure = "10:00") {
  return {
    legs: [
      { type: "WALK" },
      {
        type: "BUS",
        routeName: "307",
        subRouteName: "307 往撫遠街",
        subRouteUid: "TPE307",
        tdxCity: "Taipei",
        direction: 0,
        departureStop: "A",
        arrivalStop: "C",
        departureStopId: "TPE1",
        arrivalStopId: "TPE3",
        polyline: [
          [121, 25],
          [121.1, 25.1],
        ],
        scheduledTrip: {
          tripId: "trip-10",
          boardingReadyAt: at("09:58"),
          stops: [
            {
              stopUid: "TPE1",
              name: "A",
              arrivalAt: at(departure),
              departureAt: at(departure),
              lat: 25,
              lng: 121,
            },
            {
              stopUid: "TPE2",
              name: "B",
              arrivalAt: at("10:10"),
              departureAt: at("10:11"),
              lat: 25.05,
              lng: 121.05,
            },
            {
              stopUid: "TPE3",
              name: "C",
              arrivalAt: at("10:20"),
              lat: 25.1,
              lng: 121.1,
            },
          ],
        },
      },
    ],
  };
}
function eta(
  stop: number,
  minutes: number,
  plate = "BUS-10",
  scheduled = "10:00",
) {
  return {
    SubRouteUID: "TPE307",
    StopUID: `TPE${stop}`,
    Direction: 0,
    StopSequence: stop,
    PlateNumb: plate,
    ScheduledTime: scheduled,
    EstimateTime: minutes * 60,
    StopStatus: 0,
    UpdateTime: new Date().toISOString(),
  };
}
async function stops(token = "plan") {
  const result = await getPlannedBusArrivals(token, 1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.directions[0].stops;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("09:55"));
  // Round-trip JSON is intentional: internal non-enumerable OTP fields are gone.
  redisGet.mockResolvedValue(JSON.stringify(plan()));
  tdxFetch.mockResolvedValue({ ok: true, json: async () => [] });
});
afterEach(() => vi.useRealTimers());

describe("planned stop-by-stop arrivals through the stored route capability", () => {
  it("keeps every planned stop time at 09:00 for the 10:00 trip", async () => {
    vi.setSystemTime(at("09:00"));
    const rows = await stops();
    expect(rows.map((s) => [s.estimateMinutes, s.statusLabel])).toEqual([
      [null, "10:00"],
      [null, "10:10"],
      [null, "10:20"],
    ]);
    expect(tdxFetch).not.toHaveBeenCalled();
  });
  it("does not substitute the next run even when its ETA is close", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 5, "BUS-OLD", "09:50"), eta(2, 8, "BUS-OLD")],
    });
    expect(
      (await stops()).every((s) => s.estimateMinutes === null && !s.plateNumb),
    ).toBe(true);
  });
  it("uses one matched vehicle at each stop, with schedule fallback for a missing stop", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 8), eta(2, 1, "BUS-OLD"), eta(3, 25)],
    });
    expect(
      (await stops()).map((s) => [
        s.estimateMinutes,
        s.statusLabel,
        s.plateNumb,
      ]),
    ).toEqual([
      [8, "正常", "BUS-10"],
      [null, "10:10", undefined],
      [25, "正常", "BUS-10"],
    ]);
  });
  it("queries the public route name and scopes by UID rather than a display headsign", async () => {
    await stops();
    const url = tdxFetch.mock.calls[0][0];
    expect(url).toContain("/Taipei/307?");
    expect(url).toContain("SubRouteUID eq 'TPE307'");
    expect(url).not.toContain(encodeURIComponent("往撫遠街"));
  });
  it("returns the original schedule after a later poll fails", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 8), eta(2, 15)],
    });
    expect((await stops())[0].estimateMinutes).toBe(8);
    tdxFetch.mockRejectedValue(new Error("provider unavailable"));
    expect((await stops()).map((s) => s.statusLabel)).toEqual([
      "10:00",
      "10:10",
      "10:20",
    ]);
  });
  it("does not share matched ETAs across two tokens for the same bus line", async () => {
    redisGet.mockImplementation(async (key: string) =>
      JSON.stringify(plan(key.endsWith("later") ? "11:00" : "10:00")),
    );
    tdxFetch.mockResolvedValue({ ok: true, json: async () => [eta(1, 8)] });
    expect((await stops("earlier"))[0].estimateMinutes).toBe(8);
    expect((await stops("later"))[0]).toMatchObject({
      estimateMinutes: null,
      statusLabel: "11:00",
    });
  });
  it("rejects expired tokens and invalid/non-bus leg indexes without querying a next bus", async () => {
    expect(await getPlannedBusArrivals("plan", 0)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await getPlannedBusArrivals("plan", 99)).toMatchObject({
      ok: false,
      status: 400,
    });
    redisGet.mockResolvedValue(null);
    expect(await getPlannedBusArrivals("expired", 1)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(tdxFetch).not.toHaveBeenCalled();
  });
});

it("keeps a 09:00 plan matchable at 09:55 without extending the navigation token", async () => {
  vi.setSystemTime(at("09:00"));
  await storeBusPlan("long-plan", plan() as unknown as AccessibleRoute);
  expect(redisSet).toHaveBeenCalledTimes(1);
  const [key, raw, ttl] = redisSet.mock.calls[0];
  expect(key).toBe("bus-plan:long-plan");
  expect(ttl).toBe(110 * 60); // final arrival 10:20 + 30-minute grace
  const cached = JSON.parse(raw);
  expect(Object.keys(cached.legs)).toEqual(["1"]); // original all-modes index
  expect(cached.legs[1]).not.toHaveProperty("_scheduledTripId");
  const expiresAt = Date.now() + ttl * 1000;
  redisGet.mockImplementation(async (asked: string) =>
    asked === key && Date.now() < expiresAt ? raw : null,
  );
  vi.setSystemTime(at("09:55"));
  tdxFetch.mockResolvedValue({
    ok: true,
    json: async () => [eta(1, 8), eta(3, 25)],
  });
  expect((await stops("long-plan"))[0]).toMatchObject({
    estimateMinutes: 8,
    plateNumb: "BUS-10",
  });
  expect(redisSet).toHaveBeenCalledTimes(1); // reads cannot renew retention
  vi.setSystemTime(at("10:51"));
  expect(await getPlannedBusArrivals("long-plan", 1)).toMatchObject({
    ok: false,
    status: 404,
  });
});

it("caps bus-only snapshot retention and excludes unrelated route data", async () => {
  const route = plan();
  route.legs[1].scheduledTrip!.stops[2].arrivalAt =
    Date.now() + 72 * 60 * 60_000;
  await storeBusPlan("future", {
    ...route,
    userId: "private",
    canonicalRequest: { origin: "home" },
  } as unknown as AccessibleRoute);
  expect(redisSet.mock.calls[0][2]).toBe(48 * 60 * 60);
  expect(redisSet.mock.calls[0][1]).not.toContain("private");
  expect(redisSet.mock.calls[0][1]).not.toContain("home");
});
