import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Replace the service seam; the controller's only job above it is the
// degradation-count → message mapping and the always-200 envelope.
vi.mock("./environment.service", () => ({
  getEnvironmentInfo: vi.fn(),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./environment.service";
import { ResponseCode } from "../../types/code";
import { ENV_MSG, ERROR_MESSAGE } from "../../constants/messages";

const app = buildTestApp();
const URL = "/api/v1/a11y/environment";

type Status = "ok" | "unavailable";

function envData(weather: Status, air: Status, cctv: Status) {
  return {
    location: { lat: 25.0478, lng: 121.5318 },
    weather: { status: weather, temperature: 28 },
    airQuality: { status: air, pm25: 12 },
    nearbyCctv: { status: cctv, cameras: [] },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/v1/a11y/environment", () => {
  it("returns 200 + the full aggregate with the all-ok message when no source degrades", async () => {
    const data = envData("ok", "ok", "ok");
    vi.mocked(service.getEnvironmentInfo).mockResolvedValue(data as any);

    const res = await request(app)
      .get(URL)
      .query({ lat: 25.0478, lng: 121.5318, radius: 500 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: ENV_MSG.OK,
      data,
    });
    expect(vi.mocked(service.getEnvironmentInfo)).toHaveBeenCalledWith(
      25.0478,
      121.5318,
      500,
    );
  });

  it("defaults radius to 500 when omitted", async () => {
    vi.mocked(service.getEnvironmentInfo).mockResolvedValue(
      envData("ok", "ok", "ok") as any,
    );

    const res = await request(app).get(URL).query({ lat: 25, lng: 121 });

    expect(res.status).toBe(200);
    expect(vi.mocked(service.getEnvironmentInfo)).toHaveBeenCalledWith(
      25,
      121,
      500,
    );
  });

  it("returns 200 with the partial message when one source is unavailable", async () => {
    vi.mocked(service.getEnvironmentInfo).mockResolvedValue(
      envData("ok", "unavailable", "ok") as any,
    );

    const res = await request(app).get(URL).query({ lat: 25, lng: 121 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe(ENV_MSG.partial(1));
  });

  it("returns 200 with the partial message counting all degraded sources", async () => {
    vi.mocked(service.getEnvironmentInfo).mockResolvedValue(
      envData("unavailable", "unavailable", "unavailable") as any,
    );

    const res = await request(app).get(URL).query({ lat: 25, lng: 121 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(ENV_MSG.partial(3));
  });

  it("rejects a missing lat with 400 + the error envelope (schema)", async () => {
    const res = await request(app).get(URL).query({ lng: 121 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: ResponseCode.INVALID_INPUT,
      message: "Invalid request.",
    });
    expect(res.body.data.errors.length).toBeGreaterThan(0);
    expect(vi.mocked(service.getEnvironmentInfo)).not.toHaveBeenCalled();
  });

  it("rejects a missing lng with 400 (schema)", async () => {
    const res = await request(app).get(URL).query({ lat: 25 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects an out-of-range lat with 400 (schema)", async () => {
    const res = await request(app).get(URL).query({ lat: 95, lng: 121 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects an out-of-range lng with 400 (schema)", async () => {
    const res = await request(app).get(URL).query({ lat: 25, lng: -200 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects a radius below the minimum with 400 (schema)", async () => {
    const res = await request(app)
      .get(URL)
      .query({ lat: 25, lng: 121, radius: 50 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects a radius above the maximum with 400 (schema)", async () => {
    const res = await request(app)
      .get(URL)
      .query({ lat: 25, lng: 121, radius: 5000 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects a non-integer radius with 400 (schema)", async () => {
    const res = await request(app)
      .get(URL)
      .query({ lat: 25, lng: 121, radius: 100.5 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("returns 500 with the generic internal message when the service throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(service.getEnvironmentInfo).mockRejectedValue(
      new Error("aggregate failed"),
    );

    const res = await request(app).get(URL).query({ lat: 25, lng: 121 });

    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
    expect(res.body).toEqual({
      ok: false,
      status: "error",
      code: ResponseCode.INTERNAL_ERROR,
      message: ERROR_MESSAGE.INTERNAL,
    });
  });
});
