import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeValhallaRoutes } from "./valhalla.adapter";
import {
  VALHALLA_BASE_URL,
  VALHALLA_MAX_EXCLUDE_LOCATIONS,
  VALHALLA_ROUTE_PATH,
} from "../config/valhalla";

vi.mock("axios", () => ({ default: { post: vi.fn(), isAxiosError: vi.fn() } }));
const post = vi.mocked(axios.post);
const isAxiosError = vi.mocked(axios.isAxiosError);

const trip = {
  summary: { length: 1.2, time: 180 },
  legs: [
    {
      summary: { length: 1.2, time: 180 },
      shape: "abc",
      maneuvers: [
        {
          type: 1,
          instruction: "出發",
          length: 0.1,
          time: 20,
          begin_shape_index: 0,
          end_shape_index: 1,
          street_names: ["道路"],
        },
      ],
    },
  ],
};

describe("computeValhallaRoutes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("posts lat/lon locations, costing and two alternatives", async () => {
    post.mockResolvedValue({ data: { trip, alternates: [{ trip }] } });
    const result = await computeValhallaRoutes({
      origin: { lat: 25, lng: 121 },
      destination: { lat: 25.1, lng: 121.1 },
      costing: "motorcycle",
      computeAlternatives: true,
    });
    expect(post).toHaveBeenCalledWith(
      `${VALHALLA_BASE_URL}${VALHALLA_ROUTE_PATH}`,
      expect.objectContaining({
        costing: "motorcycle",
        alternates: 2,
        locations: [
          { lat: 25, lon: 121, type: "break" },
          { lat: 25.1, lon: 121.1, type: "break" },
        ],
      }),
      expect.any(Object),
    );
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.trips).toHaveLength(2);
      expect(result.trips[0].legs[0].maneuvers?.[0].stairs).toBe(false);
    }
  });

  it.each(["pedestrian", "auto", "motorcycle"] as const)(
    "excludes ferries via costing_options for %s",
    async (costing) => {
      post.mockResolvedValue({ data: { trip } });
      await computeValhallaRoutes({
        origin: { lat: 1, lng: 2 },
        destination: { lat: 3, lng: 4 },
        costing,
      });
      const body = post.mock.calls[0][1] as {
        costing_options: Record<
          string,
          { exclude_ferries: boolean; use_ferry: number }
        >;
      };
      expect(body.costing_options[costing]).toEqual({
        exclude_ferries: true,
        use_ferry: 0,
      });
    },
  );

  it("adds wheelchair costing and a stair penalty for pedestrian fallback", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 25, lng: 121 },
      destination: { lat: 25.1, lng: 121.1 },
      costing: "pedestrian",
      wheelchair: true,
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      costing_options: {
        pedestrian: {
          type: "wheelchair",
          step_penalty: 600,
          exclude_ferries: true,
          use_ferry: 0,
        },
      },
    });
  });

  it("omits alternatives when waypoints exist", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 5, lng: 6 },
      waypoints: [{ lat: 3, lng: 4 }],
      costing: "auto",
      computeAlternatives: true,
    });
    expect(post.mock.calls[0][1]).not.toHaveProperty("alternates");
  });

  it("omits exclude_locations when none are requested", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
    });
    expect(post.mock.calls[0][1]).not.toHaveProperty("exclude_locations");

    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
      excludeLocations: [],
    });
    expect(post.mock.calls[1][1]).not.toHaveProperty("exclude_locations");
  });

  it("sends exclude_locations as top-level lat/lon points", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
      excludeLocations: [
        { lat: 25.0439, lng: 121.5445 },
        { lat: 25.0401, lng: 121.5502 },
      ],
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      exclude_locations: [
        { lat: 25.0439, lon: 121.5445 },
        { lat: 25.0401, lon: 121.5502 },
      ],
    });
  });

  it("truncates exclude_locations to the deployment limit", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
      excludeLocations: Array.from(
        { length: VALHALLA_MAX_EXCLUDE_LOCATIONS + 10 },
        (_, i) => ({ lat: 25 + i / 1000, lng: 121 }),
      ),
    });
    const body = post.mock.calls[0][1] as { exclude_locations: unknown[] };
    expect(body.exclude_locations).toHaveLength(VALHALLA_MAX_EXCLUDE_LOCATIONS);
    expect(body.exclude_locations[0]).toEqual({ lat: 25, lon: 121 });
  });

  it("omits date_time when dateTime is not requested", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
    });
    expect(post.mock.calls[0][1]).not.toHaveProperty("date_time");
  });

  it("serializes date_time when dateTime is provided", async () => {
    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
      dateTime: { type: 0 },
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      date_time: { type: 0 },
    });

    post.mockResolvedValue({ data: { trip } });
    await computeValhallaRoutes({
      origin: { lat: 1, lng: 2 },
      destination: { lat: 3, lng: 4 },
      costing: "auto",
      dateTime: { type: 1, value: "2026-09-04T08:30" },
    });
    expect(post.mock.calls[1][1]).toMatchObject({
      date_time: { type: 1, value: "2026-09-04T08:30" },
    });
  });

  it("rejects malformed alternatives without partial trips", async () => {
    post.mockResolvedValue({ data: { trip, alternates: [{}] } });
    expect(
      await computeValhallaRoutes({
        origin: { lat: 1, lng: 2 },
        destination: { lat: 3, lng: 4 },
        costing: "auto",
      }),
    ).toEqual({ status: "UPSTREAM_ERROR", trips: [] });
  });

  it("classifies Valhalla 442 as no route", async () => {
    const error = { response: { status: 400, data: { error_code: 442 } } };
    post.mockRejectedValue(error);
    isAxiosError.mockReturnValue(true);
    expect(
      await computeValhallaRoutes({
        origin: { lat: 1, lng: 2 },
        destination: { lat: 3, lng: 4 },
        costing: "pedestrian",
      }),
    ).toEqual({
      status: "NO_ROUTE",
      trips: [],
      httpStatus: 400,
      errorCode: 442,
    });
  });

  it("classifies malformed 2xx and network failures as upstream errors", async () => {
    post.mockResolvedValueOnce({ data: { trip: { summary: {}, legs: [] } } });
    expect(
      (
        await computeValhallaRoutes({
          origin: { lat: 1, lng: 2 },
          destination: { lat: 3, lng: 4 },
          costing: "auto",
        })
      ).status,
    ).toBe("UPSTREAM_ERROR");
    post.mockRejectedValueOnce(new Error("timeout"));
    isAxiosError.mockReturnValue(false);
    expect(
      (
        await computeValhallaRoutes({
          origin: { lat: 1, lng: 2 },
          destination: { lat: 3, lng: 4 },
          costing: "auto",
        })
      ).status,
    ).toBe("UPSTREAM_ERROR");
  });
});
