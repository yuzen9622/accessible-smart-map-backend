import { describe, expect, it, vi } from "vitest";
import { scanRemainingCorridor, type CorridorProbes } from "./corridor-monitor";
import type { ConfirmedHazard } from "../hazard-report/hazard-report.types";
import type { RemainingCorridor } from "./navigation-session";

describe("scanRemainingCorridor", () => {
  const sampleCorridor: RemainingCorridor = {
    ground: [
      {
        legIndex: 0,
        legType: "WALK",
        coords: [
          [121.5, 25.0],
          [121.501, 25.0],
          [121.502, 25.0],
        ],
      },
    ],
    transit: [
      {
        legIndex: 1,
        legType: "METRO",
        railSystem: "TRTC",
        stations: [{ stationUid: "BL11", stationName: "忠孝復興" }],
      },
    ],
  };

  it("finds confirmed hazards within 25m corridor", async () => {
    const hazard: ConfirmedHazard = {
      id: "h-1",
      hazardType: "obstacle",
      severity: "blocking",
      description: "障礙物",
      coordinates: [121.5005, 25.00005],
    };
    const probes: CorridorProbes = {
      findHazards: vi.fn(async (): Promise<ConfirmedHazard[]> => [hazard]),
      probeElevators: vi.fn(async () => []),
    };

    const findings = await scanRemainingCorridor(sampleCorridor, probes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "hazard",
      hazardId: "h-1",
      severity: "blocking",
    });
  });

  it("ignores hazards outside 25m corridor", async () => {
    const farHazard: ConfirmedHazard = {
      id: "h-far",
      hazardType: "obstacle",
      severity: "blocking",
      coordinates: [121.5005, 25.001],
    };
    const probes: CorridorProbes = {
      findHazards: vi.fn(async (): Promise<ConfirmedHazard[]> => [farHazard]),
      probeElevators: vi.fn(async () => []),
    };

    const findings = await scanRemainingCorridor(sampleCorridor, probes);
    expect(findings).toHaveLength(0);
  });

  it("discards hazard results when query limit is reached (saturation protection)", async () => {
    const saturatedList: ConfirmedHazard[] = new Array(60)
      .fill(0)
      .map((_, i) => ({
        id: `h-${i}`,
        hazardType: "obstacle",
        severity: "blocking",
        coordinates: [121.5005, 25.00005],
      }));

    const probes: CorridorProbes = {
      findHazards: vi.fn(async (): Promise<ConfirmedHazard[]> => saturatedList),
      probeElevators: vi.fn(async () => []),
    };

    const findings = await scanRemainingCorridor(sampleCorridor, probes);
    expect(findings).toHaveLength(0); // Safely discarded on saturation
  });

  it("strictly truncates ground geometry lookahead at 3000m", async () => {
    // Sparse diagonal long segment from Taipei (~25.0) spanning 10km
    const longCorridor: RemainingCorridor = {
      ground: [
        {
          legIndex: 0,
          legType: "WALK",
          coords: [
            [121.5, 25.0],
            [121.5, 25.1], // ~11.1 km long
          ],
        },
      ],
      transit: [],
    };

    let queriedRadius = 0;
    const probes: CorridorProbes = {
      findHazards: vi.fn(async (_center, radiusM) => {
        queriedRadius = radiusM;
        return [];
      }),
      probeElevators: vi.fn(async () => []),
    };

    await scanRemainingCorridor(longCorridor, probes);
    expect(queriedRadius).toBeLessThanOrEqual(1600); // Bounding circle radius of 3km segment is ~1500m
  });

  it("gathers elevator outages for upcoming metro stations", async () => {
    const probes: CorridorProbes = {
      findHazards: vi.fn(async () => []),
      probeElevators: vi.fn(async () => [
        {
          railSystem: "TRTC",
          stationId: "BL11",
          stationName: "忠孝復興",
          elevatorKey: "e-2",
          keyword: "維修",
          description: "2號出口電梯維修",
        },
      ]),
    };

    const findings = await scanRemainingCorridor(sampleCorridor, probes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "facility",
      stationId: "BL11",
      keyword: "維修",
    });
  });
});
