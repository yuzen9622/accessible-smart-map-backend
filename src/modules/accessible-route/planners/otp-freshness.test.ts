import { describe, expect, it } from "vitest";
import { recountFromActiveDates, summariseFreshness } from "./otp-freshness";

const now = new Date("2026-10-02T03:00:00Z");
const trips = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ gtfsId: `t${i}` }));
const route = (agency: string, today: number, ahead: number) => ({
  agency: { gtfsId: `1:${agency}`, name: agency },
  patterns: [{ today: trips(today), ahead: trips(ahead) }],
});

describe("summariseFreshness", () => {
  it("flags an operator with no trips today as expired and the graph as stale", () => {
    const snapshot = summariseFreshness(
      {
        data: {
          serviceTimeRange: { end: 1_794_153_600 },
          routes: [
            route("THSR", 0, 0),
            route("THSR", 0, 0),
            route("TRA", 40, 38),
          ],
        },
      },
      now,
    );

    expect(snapshot.stale).toBe(true);
    expect(snapshot.serviceDate).toBe("20261002");
    expect(snapshot.lookaheadDate).toBe("20261009");
    expect(snapshot.agencies).toEqual([
      expect.objectContaining({
        agency: "1:THSR",
        routes: 2,
        tripsToday: 0,
        status: "expired",
      }),
      expect.objectContaining({
        agency: "1:TRA",
        tripsToday: 40,
        tripsInLookahead: 38,
        status: "ok",
      }),
    ]);
  });

  it("flags an operator that runs today but not on the lookahead date as expiring", () => {
    const snapshot = summariseFreshness(
      { data: { routes: [route("TRTC", 300, 0)] } },
      now,
    );

    expect(snapshot.stale).toBe(false);
    expect(snapshot.agencies[0].status).toBe("expiring");
    expect(snapshot.serviceEnd).toBeNull();
  });

  it("rejects a GraphQL error instead of reporting an empty graph as fresh", () => {
    expect(() =>
      summariseFreshness({ errors: [{ message: "boom" }] }, now),
    ).toThrow("boom");
  });

  it("recounts a headway-only operator from its trips' active dates", () => {
    const [entry] = summariseFreshness(
      { data: { routes: [route("TMRT", 0, 0)] } },
      now,
    ).agencies;
    expect(entry.status).toBe("expired");

    const recounted = recountFromActiveDates(
      entry,
      {
        data: {
          agency: {
            routes: [
              {
                patterns: [
                  {
                    trips: [
                      { activeDates: ["20261002", "20261009"] },
                      { activeDates: ["20261002"] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      "20261002",
      "20261009",
    );

    expect(recounted).toMatchObject({
      tripsToday: 2,
      tripsInLookahead: 1,
      status: "ok",
    });
  });
});
