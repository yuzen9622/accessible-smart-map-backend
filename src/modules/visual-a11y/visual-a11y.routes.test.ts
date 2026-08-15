import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./visual-a11y.service", () => ({
  findNearby: vi.fn(),
  syncFromOverpass: vi.fn(),
}));

import {
  buildTestApp,
  buildAuthorizationHeader,
} from "../../../tests/helpers/test-helpers";
import {
  buildDbUser,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";
import * as service from "./visual-a11y.service";

const app = buildTestApp();
const BASE = "/api/v1/a11y/visual-a11y";
const AUTH = buildAuthorizationHeader({
  _id: "user-abc",
  email: "user@test.com",
});

const sample = {
  _id: "66a1f2c3e4b5a6d7c8e9f0d4",
  osmNodeId: 656416266,
  type: "audio_signal",
  location: { type: "Point", coordinates: [121.5222732, 25.0522362] },
  properties: { buttonOperated: false, vibration: true, roadName: "中山北路" },
  updatedAt: "2026-06-25T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  // Real auth path: only the User.findById DB seam is stubbed.
  stubAuthUserLookup(buildDbUser({ _id: "user-abc", email: "user@test.com" }));
});

describe("GET /api/v1/a11y/visual-a11y", () => {
  it("returns 200 + nearby facilities for valid coordinates (default radius, no type)", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([sample] as any);
    const res = await request(app)
      .get(BASE)
      .query({ lat: 25.047, lng: 121.517 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(
      25.047,
      121.517,
      500,
      undefined,
    );
  });

  it("passes radius + type through to the service", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([] as any);
    const res = await request(app).get(BASE).query({
      lat: 25.047,
      lng: 121.517,
      radius: 1000,
      type: "tactile_paving",
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(
      25.047,
      121.517,
      1000,
      "tactile_paving",
    );
  });

  it("returns 400 when lat/lng are missing", async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findNearby)).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid type value", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ lat: 25.047, lng: 121.517, type: "elevator" });
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findNearby)).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/a11y/visual-a11y/sync", () => {
  it("returns 200 + the inserted/updated counts when authenticated", async () => {
    vi.mocked(service.syncFromOverpass).mockResolvedValue({
      inserted: 120,
      updated: 35,
    });
    const res = await request(app)
      .post(`${BASE}/sync`)
      .set("Authorization", AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ inserted: 120, updated: 35 });
  });

  it("returns 500 when the sync fails", async () => {
    vi.mocked(service.syncFromOverpass).mockRejectedValue(
      new Error("overpass down"),
    );
    const res = await request(app)
      .post(`${BASE}/sync`)
      .set("Authorization", AUTH);
    expect(res.status).toBe(500);
  });

  it("returns 401/403 without a valid Bearer token", async () => {
    const res = await request(app).post(`${BASE}/sync`);
    expect([401, 403]).toContain(res.status);
    expect(vi.mocked(service.syncFromOverpass)).not.toHaveBeenCalled();
  });
});
