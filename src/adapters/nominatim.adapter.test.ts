import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

import axios from "axios";
import { lookupOsmPlace } from "./nominatim.adapter";

const mockGet = axios.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NOMINATIM_BASE_URL;
});

describe("lookupOsmPlace", () => {
  it("requests extratags and keeps only string OSM tags", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          osm_type: "node",
          osm_id: 123456,
          lat: "25.0339",
          lon: "121.5645",
          display_name: "台北101, 信義區, 臺北市",
          class: "tourism",
          type: "attraction",
          address: { city: "臺北市" },
          extratags: { wheelchair: "yes", ramp: "no", invalid: true },
        },
      ],
    });

    const place = await lookupOsmPlace("node", "123456");

    expect(mockGet).toHaveBeenCalledWith(
      "https://nominatim.openstreetmap.org/lookup",
      expect.objectContaining({
        params: expect.objectContaining({
          osm_ids: "N123456",
          format: "jsonv2",
          addressdetails: 1,
          extratags: 1,
        }),
      }),
    );
    expect(place?.tags).toEqual({ wheelchair: "yes", ramp: "no" });
  });

  it("keeps the class/type classification when extratags are empty", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          osm_type: "way",
          osm_id: 987654,
          lat: "25.0339",
          lon: "121.5645",
          display_name: "市府站電梯, 信義區, 臺北市",
          class: "highway",
          type: "elevator",
          address: { city: "臺北市" },
          extratags: {},
        },
      ],
    });

    const place = await lookupOsmPlace("way", "987654");

    expect(place).toMatchObject({
      placeClass: "highway",
      placeType: "elevator",
      tags: {},
    });
  });
});
