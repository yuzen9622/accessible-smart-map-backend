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

vi.mock("./venue.service", () => ({
  listVenues: vi.fn(),
  getVenueDetail: vi.fn(),
  planVenueRoute: vi.fn(),
  // registered into accessible-route by the app; unused by these routes
  resolveVenueArrival: vi.fn(),
  replanVenueLeg: vi.fn(),
  isVenueArrivalCurrent: vi.fn(),
}));

import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { generateOpenAPIDocument } from "../../openapi/document";
import { ResponseCode } from "../../types/code";
import { venueArrivalPlanner } from "../accessible-route/venue-arrival.port";
import * as service from "./venue.service";

let app: Awaited<ReturnType<typeof startTestServer>>;
const BASE = "/api/v1/a11y/venues";

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("composition root", () => {
  it("plugs the venue planner into accessible-route when the app starts", () => {
    const planner = venueArrivalPlanner();
    expect(planner.resolveVenueArrival).toBe(service.resolveVenueArrival);
    expect(planner.replanVenueLeg).toBe(service.replanVenueLeg);
    expect(planner.isVenueArrivalCurrent).toBe(service.isVenueArrivalCurrent);
  });
});

describe("GET /api/v1/a11y/venues", () => {
  it("returns venue summaries", async () => {
    vi.mocked(service.listVenues).mockResolvedValue([
      {
        venueId: "mini",
        name: "Mini",
        center: [120.68, 24.15],
        version: 2,
        importedAt: new Date(0),
        buildings: [],
      },
    ]);
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ venueId: "mini", version: 2 });
  });
});

describe("GET /api/v1/a11y/venues/:venueId", () => {
  it("returns 404 for an unknown venue", async () => {
    vi.mocked(service.getVenueDetail).mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, code: 404 });
  });

  it("rejects a malformed venue id before the service runs", async () => {
    const res = await request(app).get(`${BASE}/Not%20Valid`);
    expect(res.status).toBe(400);
    expect(service.getVenueDetail).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/a11y/venues/:venueId/route", () => {
  const route = {
    venueId: "mini",
    venueVersion: 3,
    steps: [],
    distanceM: 52,
    durationS: 98,
  };

  it("defaults to the wheelchair mode and zh-TW instructions", async () => {
    vi.mocked(service.planVenueRoute).mockResolvedValue({
      ok: true,
      route,
    } as never);
    const res = await request(app)
      .post(`${BASE}/mini/route`)
      .send({ fromPlaceId: "gate-main", toPlaceId: "a-room06@2F" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ venueVersion: 3, distanceM: 52 });
    expect(service.planVenueRoute).toHaveBeenCalledWith({
      venueId: "mini",
      fromPlaceId: "gate-main",
      toPlaceId: "a-room06@2F",
      mode: "wheelchair",
      lang: "zh-TW",
    });
  });

  it("rejects a client-supplied cost profile or an unknown mode", async () => {
    const withProfile = await request(app)
      .post(`${BASE}/mini/route`)
      .send({
        fromPlaceId: "a",
        toPlaceId: "b",
        profile: { relaxationLevel: 3 },
      });
    expect(withProfile.status).toBe(400);
    const badMode = await request(app)
      .post(`${BASE}/mini/route`)
      .send({ fromPlaceId: "a", toPlaceId: "b", mode: "flying" });
    expect(badMode.status).toBe(400);
    expect(service.planVenueRoute).not.toHaveBeenCalled();
  });

  it("passes a 404 for an unknown place through", async () => {
    vi.mocked(service.planVenueRoute).mockResolvedValue({
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: "查無此場域地點",
    });
    const res = await request(app)
      .post(`${BASE}/mini/route`)
      .send({ fromPlaceId: "x", toPlaceId: "y" });
    expect(res.status).toBe(404);
  });

  it("returns 422 NO_ACCESSIBLE_ROUTE with venueAccessibility", async () => {
    const venueAccessibility = {
      venueId: "mini",
      placeId: "b-lab",
      levelRef: "2F",
      stepFreeReachable: false as const,
    };
    vi.mocked(service.planVenueRoute).mockResolvedValue({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: "找不到符合無障礙需求的路線",
      data: { reason: "NO_ACCESSIBLE_ROUTE", venueAccessibility },
    });
    const res = await request(app)
      .post(`${BASE}/mini/route`)
      .send({ fromPlaceId: "gate-main", toPlaceId: "b-lab" });
    expect(res.status).toBe(422);
    expect(res.body.data).toEqual({
      reason: "NO_ACCESSIBLE_ROUTE",
      venueAccessibility,
    });
  });
});

describe("OpenAPI", () => {
  it("documents the venue endpoints", () => {
    const paths = generateOpenAPIDocument().paths ?? {};
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        "/a11y/venues",
        "/a11y/venues/{venueId}",
        "/a11y/venues/{venueId}/route",
      ]),
    );
    expect(
      Object.keys(paths["/a11y/venues/{venueId}/route"]?.post?.responses ?? {}),
    ).toEqual(expect.arrayContaining(["200", "404", "422"]));
  });
});
