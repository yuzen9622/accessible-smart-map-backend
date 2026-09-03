import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ERROR_MESSAGE,
  TRAFFIC_MSG,
  TRAFFIC_REASON,
} from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import type { RoadIncident, TrafficFlowCollection } from "../../types/traffic";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";

vi.mock("./traffic-flow.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./traffic-flow.service")>();
  return {
    ...actual,
    getTrafficFlowCollection: vi.fn(),
    getTrafficFlowByBbox: vi.fn(),
  };
});

vi.mock("./road-incident.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./road-incident.service")>();
  return {
    ...actual,
    getActiveRoadIncidents: vi.fn(),
    getRoadIncidents: vi.fn(),
  };
});

import * as incidentService from "./road-incident.service";
import * as flowService from "./traffic-flow.service";

let app: Awaited<ReturnType<typeof startTestServer>>;

const FLOW_URL = "/api/v1/traffic/flow";
const INCIDENTS_URL = "/api/v1/traffic/incidents";

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/v1/traffic/flow", () => {
  const mockCollection: TrafficFlowCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.51, 25.04],
            [121.52, 25.05],
          ],
        },
        properties: {
          sectionId: "SEC-1",
          roadName: "忠孝東路",
          city: "Taipei",
          trafficLevel: "light",
          congestionLevel: 1,
          congestionLabel: "順暢",
          speedKmh: 45,
          travelTimeSec: 60,
        },
      },
    ],
    meta: {
      cities: ["Taipei"],
      bbox: [121.5, 25.02, 121.56, 25.07],
      count: 1,
      levelCounts: { "1": 1 },
      liveUpdatedAt: "2026-09-03T16:00:00.000Z",
      geometryImportedAt: "2026-09-03T00:00:00.000Z",
    },
  };

  it("returns 200 with FeatureCollection and OK message when live traffic is active", async () => {
    vi.mocked(flowService.getTrafficFlowCollection).mockResolvedValue(
      mockCollection,
    );

    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.50,25.02,121.56,25.07", minLevel: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: TRAFFIC_MSG.OK,
      data: mockCollection,
    });
  });

  it("returns 200 with FLOW_LIVE_DEGRADED message when liveUpdatedAt is null", async () => {
    const degradedCollection: TrafficFlowCollection = {
      ...mockCollection,
      meta: {
        ...mockCollection.meta,
        liveUpdatedAt: null,
      },
    };
    vi.mocked(flowService.getTrafficFlowCollection).mockResolvedValue(
      degradedCollection,
    );

    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.50,25.02,121.56,25.07" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe(TRAFFIC_MSG.FLOW_LIVE_DEGRADED);
  });

  it("returns 400 when neither bbox nor city is provided", async () => {
    const res = await request(app).get(FLOW_URL);

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe(ResponseCode.INVALID_INPUT);
  });

  it("returns 400 when bbox format is invalid", async () => {
    const res = await request(app).get(FLOW_URL).query({ bbox: "121.5,25.0" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when bbox min is greater than max", async () => {
    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.60,25.08,121.50,25.02" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when bbox span exceeds TRAFFIC_FLOW_MAX_BBOX_DEG", async () => {
    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.0,24.0,122.0,25.5" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when unknown query parameter is passed (strict mode)", async () => {
    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.50,25.02,121.56,25.07", unknownParam: "123" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 500 with SECTION_DB_ERROR when geometry is unavailable", async () => {
    vi.mocked(flowService.getTrafficFlowCollection).mockRejectedValue(
      new flowService.TrafficSectionUnavailableError(
        "No traffic section geometries",
      ),
    );

    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.50,25.02,121.56,25.07" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      status: "error",
      code: ResponseCode.INTERNAL_ERROR,
      message: TRAFFIC_MSG.SECTION_DB_ERROR,
      data: {
        reason: TRAFFIC_REASON.SECTION_DB_ERROR,
        suggestion:
          "請先執行 npx ts-node src/scripts/import-traffic-sections.ts",
      },
    });
  });

  it("returns 400 when city is not in supported white-list", async () => {
    const res = await request(app).get(FLOW_URL).query({ city: "UnknownCity" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when bbox exceeds WGS84 bounds", async () => {
    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "185.0,25.0,185.1,25.1" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when bbox has zero or negative area (max <= min)", async () => {
    const res1 = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.5,25.0,121.5,25.1" }); // maxLng === minLng

    expect(res1.status).toBe(400);
    expect(res1.body.ok).toBe(false);

    const res2 = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.6,25.0,121.5,25.1" }); // maxLng < minLng

    expect(res2.status).toBe(400);
    expect(res2.body.ok).toBe(false);
  });

  it("returns 500 when an unexpected internal error occurs", async () => {
    vi.mocked(flowService.getTrafficFlowCollection).mockRejectedValue(
      new Error("Unexpected DB crash"),
    );

    const res = await request(app)
      .get(FLOW_URL)
      .query({ bbox: "121.50,25.02,121.56,25.07" });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe(ResponseCode.INTERNAL_ERROR);
    expect(res.body.message).toBe(ERROR_MESSAGE.INTERNAL);
  });
});

describe("GET /api/v1/traffic/incidents", () => {
  const mockIncidents: RoadIncident[] = [
    {
      incidentId: "INC-001",
      title: "路面施工",
      description: "封閉外側車道",
      severity: "advisory",
      roadName: "信義路五段",
      location: { lat: 25.033, lng: 121.565 },
      startTime: "2026-09-03T10:00:00Z",
    },
  ];

  it("returns 200 with list of incidents and INCIDENT_OK message", async () => {
    vi.mocked(incidentService.getActiveRoadIncidents).mockResolvedValue(
      mockIncidents,
    );

    const res = await request(app)
      .get(INCIDENTS_URL)
      .query({ bbox: "121.50,25.02,121.56,25.07" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: TRAFFIC_MSG.INCIDENT_OK,
      data: mockIncidents,
    });
  });

  it("returns 200 with empty array when no incidents found", async () => {
    vi.mocked(incidentService.getActiveRoadIncidents).mockResolvedValue([]);

    const res = await request(app).get(INCIDENTS_URL).query({ city: "Taipei" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it("returns 400 when bbox format is invalid", async () => {
    const res = await request(app)
      .get(INCIDENTS_URL)
      .query({ bbox: "invalid,bbox" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when bbox span exceeds maximum degree", async () => {
    const res = await request(app)
      .get(INCIDENTS_URL)
      .query({ bbox: "120.0,23.0,121.5,24.5" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when city is not in supported white-list", async () => {
    const res = await request(app)
      .get(INCIDENTS_URL)
      .query({ city: "Malicious/City" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when bbox has inverted coordinates", async () => {
    const res = await request(app)
      .get(INCIDENTS_URL)
      .query({ bbox: "121.5,25.2,121.6,25.1" }); // minLat > maxLat

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when unknown query parameter is passed", async () => {
    const res = await request(app)
      .get(INCIDENTS_URL)
      .query({ city: "Taipei", extra: "forbidden" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 500 when unexpected error occurs", async () => {
    vi.mocked(incidentService.getActiveRoadIncidents).mockRejectedValue(
      new Error("Service exception"),
    );

    const res = await request(app).get(INCIDENTS_URL).query({ city: "Taipei" });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe(ResponseCode.INTERNAL_ERROR);
  });
});
