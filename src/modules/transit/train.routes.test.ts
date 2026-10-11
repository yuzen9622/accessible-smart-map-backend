import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

// Keep router, validation, controller and train service real; stub only TDX I/O.
vi.mock("../../adapters/rail.adapter", () => ({
  fetchRailStationIndex: vi.fn(),
  fetchRailOdTimetable: vi.fn(),
  fetchRailStationTimetable: vi.fn(),
}));

import {
  fetchRailStationIndex,
  fetchRailOdTimetable,
  fetchRailStationTimetable,
} from "../../adapters/rail.adapter";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { generateOpenAPIDocument } from "../../openapi/document";
import { ResponseCode } from "../../types/code";

let app: Awaited<ReturnType<typeof startTestServer>>;
const BASE = "/api/v1/transit/train";
const stations = new Map([
  ["臺北", "1000"],
  ["臺中", "3300"],
]);
const cases = [
  {
    path: "/timetable",
    query: { originStation: "臺北", destinationStation: "臺中" },
  },
  { path: "/station-timetable", query: { station: "臺北" } },
  { path: "/stations", query: { query: "臺" } },
];

beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(app);
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchRailStationIndex).mockResolvedValue({
    ok: true,
    index: stations,
  });
  vi.mocked(fetchRailOdTimetable).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchRailStationTimetable).mockResolvedValue({
    ok: true,
    items: [],
  });
});

function expectUnavailable(res: request.Response) {
  expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
  expect(res.body).toEqual({
    ok: false,
    status: "error",
    code: ResponseCode.SERVICE_UNAVAILABLE,
    message: "火車時刻查詢暫時失敗，請稍後再試",
  });
}

describe("train HTTP error classification", () => {
  it.each(cases)(
    "$path returns 503 when the station index fails",
    async ({ path, query }) => {
      vi.mocked(fetchRailStationIndex).mockResolvedValue({
        ok: false,
        errorCode: "HTTP_ERROR",
      });
      expectUnavailable(
        await request(app)
          .get(BASE + path)
          .query(query),
      );
      expect(fetchRailOdTimetable).not.toHaveBeenCalled();
      expect(fetchRailStationTimetable).not.toHaveBeenCalled();
    },
  );

  it("returns 503 when resolving the destination fails after resolving the origin", async () => {
    vi.mocked(fetchRailStationIndex)
      .mockResolvedValueOnce({ ok: true, index: stations })
      .mockResolvedValueOnce({ ok: false, errorCode: "BUSY" });
    expectUnavailable(
      await request(app)
        .get(BASE + "/timetable")
        .query(cases[0].query),
    );
    expect(fetchRailOdTimetable).not.toHaveBeenCalled();
  });

  it("returns 503 when the OD timetable fetch fails", async () => {
    vi.mocked(fetchRailOdTimetable).mockResolvedValue({
      ok: false,
      errorCode: "NETWORK",
    });
    expectUnavailable(
      await request(app)
        .get(BASE + "/timetable")
        .query(cases[0].query),
    );
  });

  it("returns 503 when the station timetable fetch fails", async () => {
    vi.mocked(fetchRailStationTimetable).mockResolvedValue({
      ok: false,
      errorCode: "BAD_PAYLOAD",
    });
    expectUnavailable(
      await request(app)
        .get(BASE + "/station-timetable")
        .query(cases[1].query),
    );
  });

  it.each([
    {
      path: "/timetable",
      query: { originStation: "臺北", destinationStation: "臺北" },
    },
    {
      path: "/timetable",
      query: { originStation: "臺北", destinationStation: "不存在" },
    },
    {
      path: "/timetable",
      query: {
        originStation: "臺北",
        destinationStation: "臺中",
        departAfter: "24:00",
      },
    },
    { path: "/station-timetable", query: { station: "不存在" } },
    {
      path: "/station-timetable",
      query: { station: "臺北", date: "2026-02-30" },
    },
    { path: "/stations", query: { railSystem: "MRT" } },
  ])("$path keeps invalid input at 400: $query", async ({ path, query }) => {
    const res = await request(app)
      .get(BASE + path)
      .query(query);
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: ResponseCode.INVALID_INPUT,
    });
    expect(fetchRailOdTimetable).not.toHaveBeenCalled();
    expect(fetchRailStationTimetable).not.toHaveBeenCalled();
  });

  it.each(cases)(
    "$path retains 500 for unexpected exceptions",
    async ({ path, query }) => {
      vi.mocked(fetchRailStationIndex).mockRejectedValue(
        new Error("unexpected"),
      );
      const res = await request(app)
        .get(BASE + path)
        .query(query);
      expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
      expect(res.body.code).toBe(ResponseCode.INTERNAL_ERROR);
    },
  );

  it.each(cases)(
    "$path still returns 200 for successful upstream results",
    async ({ path, query }) => {
      const res = await request(app)
        .get(BASE + path)
        .query(query);
      expect(res.status).toBe(ResponseCode.OK);
      expect(res.body.ok).toBe(true);
    },
  );

  it("documents 400, 503 and 500 separately for all three endpoints", () => {
    const doc = generateOpenAPIDocument();
    for (const { path } of cases) {
      const responses = doc.paths?.["/transit/train" + path]?.get?.responses;
      expect(responses).toHaveProperty("400");
      expect(responses).toHaveProperty("503");
      expect(responses).toHaveProperty("500");
    }
  });
});
