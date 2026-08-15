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

vi.mock("./welfare.service", () => ({
  findNearby: vi.fn(),
  findAll: vi.fn(),
  findById: vi.fn(),
}));

import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import * as service from "./welfare.service";

let app: Awaited<ReturnType<typeof startTestServer>>;
const BASE = "/api/v1/a11y/welfare";

const sample = {
  _id: "66a1f2c3e4b5a6d7c8e9f0d4",
  name: "新北市愛維養護中心",
  county: "新北市",
  district: "八里區",
  type: "全日型住宿式機構",
  geocoded: true,
};

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/v1/a11y/welfare/nearby", () => {
  it("returns 200 + nearby institutions for valid coordinates", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([sample] as any);
    const res = await request(app)
      .get(`${BASE}/nearby`)
      .query({ lat: 25.05, lng: 121.51 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(
      25.05,
      121.51,
      1000,
    );
  });

  it("returns 400 when lat/lng are missing", async () => {
    const res = await request(app).get(`${BASE}/nearby`);
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findNearby)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/a11y/welfare", () => {
  it("passes county/type filters through to the service", async () => {
    vi.mocked(service.findAll).mockResolvedValue([sample] as any);
    const res = await request(app)
      .get(BASE)
      .query({ county: "臺北市", type: "日間型機構" });
    expect(res.status).toBe(200);
    expect(vi.mocked(service.findAll)).toHaveBeenCalledWith({
      county: "臺北市",
      type: "日間型機構",
    });
  });

  it("returns 200 with no filters", async () => {
    vi.mocked(service.findAll).mockResolvedValue([] as any);
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/a11y/welfare/:id", () => {
  it("returns 200 + the institution when found", async () => {
    vi.mocked(service.findById).mockResolvedValue(sample as any);
    const res = await request(app).get(`${BASE}/66a1f2c3e4b5a6d7c8e9f0d4`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe(sample.name);
  });

  it("returns 404 when not found", async () => {
    vi.mocked(service.findById).mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/66a1f2c3e4b5a6d7c8e9f0d4`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get(`${BASE}/not-an-objectid`);
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findById)).not.toHaveBeenCalled();
  });
});
