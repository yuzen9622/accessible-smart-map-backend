import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./campus.service", () => ({
  findNearby: vi.fn(),
  findAll: vi.fn(),
  findByCampusId: vi.fn(),
  listSchools: vi.fn(),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./campus.service";

const app = buildTestApp();
const BASE = "/api/v1/a11y/campus";

const summary = {
  campusId: 29,
  schoolId: 33,
  schoolName: "國立臺中科技大學",
  branchName: "三民校區",
  city: "臺中市",
  address: "臺中市北區三民路三段129號",
  phone: "04-22195000",
  buildingCount: 120,
  facilityCount: 680,
  facTypeSummary: [
    { code: "elevator", label: "無障礙電梯", count: 24 },
    { code: "accessible_toilet", label: "無障礙廁所", count: 130 },
  ],
};

const detail = {
  ...summary,
  _id: "66a1f2c3e4b5a6d7c8e9f0d4",
  facilities: [
    {
      facUid: "F1",
      facTypeId: 8,
      type: "elevator",
      facType: "無障礙電梯",
      floors: ["1"],
      floorIds: ["L1"],
    },
  ],
  importedAt: "2026-06-24T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/v1/a11y/campus/facility-types", () => {
  it("returns the canonical facility-type registry", async () => {
    const res = await request(app).get(`${BASE}/facility-types`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(13);
    const elevator = res.body.data.find((t: any) => t.code === "elevator");
    expect(elevator).toMatchObject({
      id: 8,
      code: "elevator",
      label: "無障礙電梯",
    });
  });
});

describe("GET /api/v1/a11y/campus/nearby", () => {
  it("returns 200 + nearby campus summaries for valid coordinates", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([summary] as any);
    const res = await request(app)
      .get(`${BASE}/nearby`)
      .query({ lat: 25.05, lng: 121.51 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].facTypeSummary).toEqual(summary.facTypeSummary);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(
      25.05,
      121.51,
      1000,
      undefined,
    );
  });

  it("passes the type code through to the service", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([] as any);
    const res = await request(app)
      .get(`${BASE}/nearby`)
      .query({ lat: 25.05, lng: 121.51, type: "elevator" });
    expect(res.status).toBe(200);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(
      25.05,
      121.51,
      1000,
      "elevator",
    );
  });

  it("returns 400 for an unknown type code", async () => {
    const res = await request(app)
      .get(`${BASE}/nearby`)
      .query({ lat: 25.05, lng: 121.51, type: "無障礙電梯" });
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findNearby)).not.toHaveBeenCalled();
  });

  it("returns 400 (INVALID_INPUT) when lat is missing", async () => {
    const res = await request(app).get(`${BASE}/nearby`).query({ lng: 121.51 });
    expect(res.status).toBe(400);
    expect(res.body.data.errors).toBeDefined();
    expect(vi.mocked(service.findNearby)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/a11y/campus", () => {
  it("passes city / type / schoolId / sort filters and pagination through", async () => {
    vi.mocked(service.findAll).mockResolvedValue({
      items: [summary],
      totalCount: 1,
      page: 1,
      totalPages: 1,
    } as any);
    const res = await request(app).get(BASE).query({
      city: "台中市",
      type: "elevator",
      schoolId: 33,
      sort: "facilities",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(vi.mocked(service.findAll)).toHaveBeenCalledWith({
      city: "台中市",
      type: "elevator",
      keyword: undefined,
      schoolId: 33,
      sort: "facilities",
      page: 1,
      limit: 20,
    });
  });

  it("passes the keyword through to the service", async () => {
    vi.mocked(service.findAll).mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      totalPages: 0,
    } as any);
    const res = await request(app).get(BASE).query({ keyword: "中科大" });
    expect(res.status).toBe(200);
    expect(vi.mocked(service.findAll)).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "中科大", page: 1, limit: 20 }),
    );
  });

  it("returns 400 for a negative schoolId", async () => {
    const res = await request(app).get(BASE).query({ schoolId: -1 });
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findAll)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/a11y/campus/schools", () => {
  it("returns 200 + paginated school directory", async () => {
    vi.mocked(service.listSchools).mockResolvedValue({
      items: [
        {
          schoolId: 33,
          schoolName: "國立臺中科技大學",
          city: "臺中市",
          branchCount: 2,
          facilityCount: 900,
        },
      ],
      totalCount: 1,
      page: 1,
      totalPages: 1,
    } as any);
    const res = await request(app)
      .get(`${BASE}/schools`)
      .query({ city: "台中市" });
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].schoolId).toBe(33);
    expect(vi.mocked(service.listSchools)).toHaveBeenCalledWith({
      city: "台中市",
      keyword: undefined,
      page: 1,
      limit: 50,
    });
  });
});

describe("GET /api/v1/a11y/campus/:campusId", () => {
  it("returns 200 + full detail when found", async () => {
    vi.mocked(service.findByCampusId).mockResolvedValue(detail as any);
    const res = await request(app).get(`${BASE}/29`);
    expect(res.status).toBe(200);
    expect(res.body.data.facilities).toHaveLength(1);
    expect(res.body.data.facilities[0].type).toBe("elevator");
    expect(vi.mocked(service.findByCampusId)).toHaveBeenCalledWith(29);
  });

  it("returns 404 when not found", async () => {
    vi.mocked(service.findByCampusId).mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/999999`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a negative campusId", async () => {
    const res = await request(app).get(`${BASE}/-5`);
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findByCampusId)).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-integer campusId", async () => {
    const res = await request(app).get(`${BASE}/not-an-int`);
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findByCampusId)).not.toHaveBeenCalled();
  });
});

describe("OpenAPI document", () => {
  it("registers the campus paths", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const paths = res.body.paths ?? {};
    expect(paths["/a11y/campus/facility-types"]).toBeDefined();
    expect(paths["/a11y/campus/nearby"]).toBeDefined();
    expect(paths["/a11y/campus/schools"]).toBeDefined();
    expect(paths["/a11y/campus"]).toBeDefined();
    expect(paths["/a11y/campus/{campusId}"]).toBeDefined();
  });
});
