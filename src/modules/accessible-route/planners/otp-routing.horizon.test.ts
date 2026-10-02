import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import captured from "./fixtures/otp-next-day-elderly.json";

const { post, busLean } = vi.hoisted(() => ({
  post: vi.fn(),
  busLean: vi.fn(),
}));
vi.mock("axios", () => ({ default: { create: () => ({ post }) } }));
vi.mock("../../../config/redis", () => ({ redisClient: null }));
vi.mock("../../../model/bus-stop.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: busLean }) }) },
}));
vi.mock("../../../model/metro-station.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../../model/train-station.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../../model/gtfs-trip.model", () => ({
  GtfsTrip: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const DEPARTURE = new Date("2026-10-05T12:30:00+08:00");
const empty = () => ({
  data: { data: { plan: { itineraries: [], routingErrors: [] } } },
});
type Query = {
  date: string;
  time: string;
  searchWindow: number;
  fromLat: number;
  maxTransfers: number;
};
const queryStart = (q: Query) => Date.parse(`${q.date}T${q.time}:00+08:00`);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("OTP_SEARCH_WINDOW_S", "3600");
  vi.stubEnv("OTP_SEARCH_WINDOW_WIDE_S", "7200");
  vi.stubEnv("OTP_CONTINUATION_WINDOW_S", "28800");
  vi.stubEnv("OTP_SEARCH_HORIZON_S", "86400");
  busLean.mockResolvedValue([]);
  post.mockResolvedValue(empty());
});
afterEach(() => vi.unstubAllEnvs());

describe("OTP absolute search horizon", () => {
  it.each(captured.cases)(
    "recovers captured elderly case $id after the former 18-hour cutoff",
    async (fixture) => {
      const firstDeparture =
        fixture.response.data.plan.itineraries[0].legs[0].startTime;
      busLean
        .mockResolvedValueOnce([fixture.snaps[0]])
        .mockResolvedValueOnce([fixture.snaps[1]]);
      post.mockImplementation(
        async (_url, { variables: q }: { variables: Query }) => {
          const snapped =
            q.fromLat === fixture.snaps[0].location.coordinates[1];
          const includesDeparture =
            queryStart(q) <= firstDeparture &&
            firstDeparture < queryStart(q) + q.searchWindow * 1000;
          return snapped && includesDeparture
            ? { data: structuredClone(fixture.response) }
            : empty();
        },
      );
      const { planOtpRouteDetailed } = await import("./otp-routing");
      const result = await planOtpRouteDetailed(
        fixture.origin,
        fixture.destination,
        {
          mode: "elderly",
          maxTransfers: 2,
          departureTime: DEPARTURE,
        },
      );
      expect(result.status).toBe("ok");
      expect(result.routes[0].transferCount).toBe(2);
      expect(result.routes[0].departureDate).toBe("2026-10-06");
      expect(
        result.routes[0].legs.filter((leg) => leg.type === "BUS"),
      ).toHaveLength(3);
      expect(post.mock.calls.at(-1)![1].variables).toMatchObject({
        date: "2026-10-06",
        time: "06:30",
        searchWindow: 21600,
        maxTransfers: 3,
      });
    },
  );

  it.each([3600, 7200, 28800])(
    "covers exactly 24 hours when the wide window is %i seconds",
    async (wide) => {
      vi.stubEnv("OTP_SEARCH_WINDOW_WIDE_S", String(wide));
      const { planOtpRouteDetailed } = await import("./otp-routing");
      const result = await planOtpRouteDetailed(
        captured.cases[0].origin,
        captured.cases[0].destination,
        {
          mode: "elderly",
          departureTime: DEPARTURE,
        },
      );
      expect(result).toEqual({ status: "no_route", routes: [] });
      const queries = post.mock.calls.map((call) => call[1].variables as Query);
      // The first query overlaps the widening; every continuation must join
      // the preceding window without a gap, including across Taipei midnight.
      let cursor = DEPARTURE.getTime() + wide * 1000;
      for (const query of queries.slice(2)) {
        expect(queryStart(query)).toBe(cursor);
        cursor += query.searchWindow * 1000;
      }
      expect(cursor).toBe(DEPARTURE.getTime() + 86400 * 1000);
      expect(queries.at(-1)!.searchWindow).toBeLessThanOrEqual(28800);
    },
  );

  it.each(["0", "-1", "NaN", "Infinity", ""])(
    "uses the 24-hour default for invalid horizon %s",
    async (value) => {
      vi.stubEnv("OTP_SEARCH_HORIZON_S", value);
      const { planOtpRouteDetailed } = await import("./otp-routing");
      await planOtpRouteDetailed(
        captured.cases[0].origin,
        captured.cases[0].destination,
        { departureTime: DEPARTURE },
      );
      const last = post.mock.calls.at(-1)![1].variables as Query;
      expect(queryStart(last) + last.searchWindow * 1000).toBe(
        DEPARTURE.getTime() + 86400000,
      );
    },
  );

  it("clips the final continuation to an explicit horizon", async () => {
    vi.stubEnv("OTP_SEARCH_HORIZON_S", "39600");
    const { planOtpRouteDetailed } = await import("./otp-routing");
    await planOtpRouteDetailed(
      captured.cases[0].origin,
      captured.cases[0].destination,
      { departureTime: DEPARTURE },
    );
    expect(
      post.mock.calls.map((call) => call[1].variables.searchWindow),
    ).toEqual([3600, 7200, 28800, 3600]);
  });

  it.each(["0", "-1", "NaN", "Infinity"])(
    "keeps advancing with invalid continuation window %s",
    async (value) => {
      vi.stubEnv("OTP_CONTINUATION_WINDOW_S", value);
      const { planOtpRouteDetailed } = await import("./otp-routing");
      await planOtpRouteDetailed(
        captured.cases[0].origin,
        captured.cases[0].destination,
        { departureTime: DEPARTURE },
      );
      expect(
        post.mock.calls.map((call) => call[1].variables.searchWindow),
      ).toEqual([3600, 7200, 28800, 28800, 21600]);
    },
  );

  it("clips quick queries when the horizon is shorter than both windows", async () => {
    vi.stubEnv("OTP_SEARCH_HORIZON_S", "1800");
    const { planOtpRouteDetailed } = await import("./otp-routing");
    await planOtpRouteDetailed(
      captured.cases[0].origin,
      captured.cases[0].destination,
      { departureTime: DEPARTURE },
    );
    expect(
      post.mock.calls.map((call) => call[1].variables.searchWindow),
    ).toEqual([1800, 1800]);
  });

  it("keeps the absolute horizon when continuation windows are shorter", async () => {
    vi.stubEnv("OTP_CONTINUATION_WINDOW_S", "21600");
    const { planOtpRouteDetailed } = await import("./otp-routing");
    await planOtpRouteDetailed(
      captured.cases[0].origin,
      captured.cases[0].destination,
      { departureTime: DEPARTURE },
    );
    expect(
      post.mock.calls.map((call) => call[1].variables.searchWindow),
    ).toEqual([3600, 7200, 21600, 21600, 21600, 14400]);
  });

  it("keeps a failed continuation unavailable instead of declaring no route", async () => {
    post
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty())
      .mockRejectedValueOnce({ code: "ETIMEDOUT" });
    const { planOtpRouteDetailed } = await import("./otp-routing");
    await expect(
      planOtpRouteDetailed(
        captured.cases[0].origin,
        captured.cases[0].destination,
        { departureTime: DEPARTURE },
      ),
    ).resolves.toEqual({ status: "unavailable", routes: [] });
    expect(post).toHaveBeenCalledTimes(3);
  });
});
