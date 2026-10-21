import { afterEach, describe, expect, it, vi } from "vitest";
import { getPairTimetableTrips } from "./bus-pair-timetable";

const serviceDay = Date.parse("2026-10-21T00:00:00+08:00") / 1000;
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 3600 + m * 60;
};
const call = (id: string, hhmm: string) => ({
  stop: { gtfsId: `1:${id}`, name: id, lat: 24.1, lon: 120.6 },
  scheduledArrival: clock(hhmm),
  scheduledDeparture: clock(hhmm),
});
const departures = (
  route: string,
  trip: string,
  calls: ReturnType<typeof call>[],
) => ({
  pattern: { route: { gtfsId: `1:${route}` } },
  stoptimes: [{ serviceDay, trip: { gtfsId: `1:${trip}`, stoptimes: calls } }],
});

afterEach(() => vi.unstubAllGlobals());

describe("timetable trips between two stops", () => {
  it("returns trips that reach the alight stop, sliced to the ride", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          stops: [
            {
              gtfsId: "1:B",
              stoptimesForPatterns: [
                departures("TXG12_0", "t12", [
                  call("O", "20:40"),
                  call("B", "20:48"),
                  call("M", "20:52"),
                  call("A", "20:57"),
                  call("Z", "21:10"),
                ]),
                departures("TXG65_0", "t65", [
                  call("B", "20:50"),
                  call("X", "21:00"),
                ]),
              ],
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const trips = await getPairTimetableTrips({
      boards: ["B"],
      alights: ["A"],
      now: Date.parse("2026-10-21T20:46:00+08:00"),
      perPattern: 4,
      signal: AbortSignal.timeout(1000),
    });
    expect(trips).toEqual([
      {
        tripId: "t12",
        subRouteUid: "TXG12",
        direction: 0,
        stops: ["B", "M", "A"].map((id, i) => ({
          stopUid: id,
          name: id,
          lat: 24.1,
          lng: 120.6,
          arrivalAt: Date.parse(
            `2026-10-21T20:${["48", "52", "57"][i]}:00+08:00`,
          ),
          departureAt: Date.parse(
            `2026-10-21T20:${["48", "52", "57"][i]}:00+08:00`,
          ),
        })),
      },
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables.ids).toEqual([
      "1:B",
    ]);
  });

  it("asks nothing when no route serves the pair", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await getPairTimetableTrips({
        boards: [],
        alights: [],
        now: 0,
        perPattern: 4,
        signal: AbortSignal.timeout(1000),
      }),
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
