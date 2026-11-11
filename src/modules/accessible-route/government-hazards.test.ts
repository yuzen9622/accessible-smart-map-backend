import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../traffic/road-incident.service", () => ({
  getActiveRoadIncidents: vi.fn(),
}));
vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));

import { getActiveRoadIncidents } from "../traffic/road-incident.service";
import type { AccessibleRoute } from "../../types/route";
import type { RoadIncident } from "../../types/traffic";
import { loadGovernmentHazards } from "./accessible-route.service";
import { pointToSegmentDistanceM } from "./planners/hazard-routing";

const route = {
  routeId: "r1",
  legs: [
    {
      type: "WALK",
      polyline: [
        [121.5, 25.0],
        [121.502, 25.0],
      ],
    },
  ],
} as unknown as AccessibleRoute;

const incident = (overrides: Partial<RoadIncident>): RoadIncident => ({
  incidentId: "379530000H_001-01-11501977-1",
  title: "道路施工",
  description: "道路維護",
  severity: "closure",
  location: { lat: 25.0001, lng: 121.501 },
  ...overrides,
});

beforeEach(() => {
  vi.mocked(getActiveRoadIncidents).mockReset();
});

describe("loadGovernmentHazards", () => {
  it("reuses segment calculations while keeping every nearby government event", async () => {
    const incidents = Array.from({ length: 48 }, (_, index) =>
      incident({
        incidentId: `closure-${index}`,
        location: { lat: 25.00001 + index * 0.000001, lng: 121.501 },
      }),
    );
    vi.mocked(getActiveRoadIncidents).mockResolvedValue(incidents);
    const sin = vi.spyOn(Math, "sin");
    try {
      for (const item of incidents)
        pointToSegmentDistanceM(
          [item.location.lng, item.location.lat],
          route.legs[0].polyline[0],
          route.legs[0].polyline[1],
        );
      const independentCalls = sin.mock.calls.length;
      sin.mockClear();
      const matched = await loadGovernmentHazards([route]);
      const sharedCalls = sin.mock.calls.length;
      expect(matched.map((item) => item.id)).toEqual(
        incidents.map((item) => `tdx:${item.incidentId}`),
      );
      expect(independentCalls).toBeGreaterThan(0);
      expect(sharedCalls).toBeLessThan(independentCalls);
    } finally {
      sin.mockRestore();
    }
  });

  it("isolates an invalid event point without losing a later valid event", async () => {
    vi.mocked(getActiveRoadIncidents).mockResolvedValue([
      incident({ incidentId: "invalid", points: [{ lat: 95, lng: 121.501 }] }),
      incident({ incidentId: "valid" }),
    ]);
    expect(
      (await loadGovernmentHazards([route])).map((item) => item.id),
    ).toEqual(["tdx:valid"]);
  });

  it("turns a nearby closure into a government construction hazard", async () => {
    vi.mocked(getActiveRoadIncidents).mockResolvedValue([
      incident({
        endTime: "2026-12-31T23:59:59+08:00",
        points: [
          { lat: 25.0001, lng: 121.501 },
          { lat: 25.0002, lng: 121.5012 },
        ],
      }),
    ]);

    const hazards = await loadGovernmentHazards([route]);

    expect(hazards).toEqual([
      {
        id: "tdx:379530000H_001-01-11501977-1",
        hazardType: "construction",
        severity: "difficult",
        source: "government",
        description: "道路施工｜道路維護（預計至 2026-12-31）",
        coordinates: [121.501, 25.0001],
        points: [
          [121.501, 25.0001],
          [121.5012, 25.0002],
        ],
      },
    ]);
  });

  it("includes footway works even when they are only advisories", async () => {
    vi.mocked(getActiveRoadIncidents).mockResolvedValue([
      incident({
        severity: "advisory",
        locationDescription: "中正路613號至重慶北路四段177號人行道更新",
      }),
    ]);

    const [hazard] = await loadGovernmentHazards([route]);

    expect(hazard).toMatchObject({
      severity: "difficult",
      description: "道路施工｜中正路613號至重慶北路四段177號人行道更新",
    });
  });

  it("ignores carriageway-only advisories", async () => {
    vi.mocked(getActiveRoadIncidents).mockResolvedValue([
      incident({ severity: "advisory" }),
    ]);
    expect(await loadGovernmentHazards([route])).toEqual([]);
  });

  it("ignores closures far from every candidate", async () => {
    vi.mocked(getActiveRoadIncidents).mockResolvedValue([
      incident({ location: { lat: 25.01, lng: 121.501 } }),
    ]);
    expect(await loadGovernmentHazards([route])).toEqual([]);
  });

  it("fails soft when the incident lookup throws", async () => {
    vi.mocked(getActiveRoadIncidents).mockRejectedValue(new Error("down"));
    expect(await loadGovernmentHazards([route])).toEqual([]);
  });
});
