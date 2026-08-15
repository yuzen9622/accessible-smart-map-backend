import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute, WalkLeg } from "../../types/route";
import { applyConfirmedHazardPlanning } from "./accessible-route.service";
import {
  MAX_HAZARD_QUERY_RADIUS_M,
  type ConfirmedHazardInput,
} from "./planners/hazard-routing";

const walkLeg = (polyline: [number, number][]): WalkLeg => ({
  type: "WALK",
  from: "起點",
  to: "終點",
  distanceM: 120,
  minutesEst: 2,
  polyline,
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
});

const route = (id: string, polyline: [number, number][]): AccessibleRoute => ({
  routeId: id,
  routeName: id,
  totalMinutes: 10,
  transferCount: 0,
  legs: [walkLeg(polyline)],
  accessibilityHighlights: [],
});

const routes = (): AccessibleRoute[] => [
  route("affected", [
    [121, 25],
    [121.001, 25],
  ]),
  route("clear", [
    [121, 25.002],
    [121.001, 25.002],
  ]),
];

const confirmedHazard: ConfirmedHazardInput = {
  id: "h-1",
  hazardType: "construction",
  severity: "blocking",
  coordinates: [121.0005, 25.00005],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("confirmed-hazard query integration fail-open behavior", () => {
  it("queries a bounded candidate corridor before applying a verified match", async () => {
    const candidates = routes();
    const lookup = vi.fn().mockResolvedValue([confirmedHazard]);

    const plan = await applyConfirmedHazardPlanning(candidates, lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    const [center, radiusM, limit] = lookup.mock.calls[0];
    expect(center).toMatchObject({
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
    expect(radiusM).toBeLessThanOrEqual(MAX_HAZARD_QUERY_RADIUS_M);
    expect(limit).toBe(101); // 100 safe results + one saturation sentinel
    expect(plan.selectionApplied).toBe(true);
    expect(plan.routes[0]).toMatchObject({
      routeId: "clear",
      hazardAdvisory: { avoided: [{ id: "h-1" }] },
    });
  });

  it("fails open without an advisory or rerank when the confirmed-hazard query fails", async () => {
    const candidates = routes();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const plan = await applyConfirmedHazardPlanning(candidates, async () => {
      throw new Error("mongo unavailable");
    });

    expect(plan).toMatchObject({
      selectionApplied: false,
      allCandidatesAffected: false,
    });
    expect(plan.routes).toBe(candidates);
    expect(plan.routes.map((candidate) => candidate.routeId)).toEqual([
      "affected",
      "clear",
    ]);
    expect(plan.routes.some((candidate) => candidate.hazardAdvisory)).toBe(
      false,
    );
  });

  it("fails open without an advisory or rerank when geometry matching rejects bad data", async () => {
    const candidates = routes();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const plan = await applyConfirmedHazardPlanning(candidates, async () => [
      {
        ...confirmedHazard,
        coordinates: [Infinity, 25],
      } as ConfirmedHazardInput,
    ]);

    expect(plan).toMatchObject({
      selectionApplied: false,
      allCandidatesAffected: false,
    });
    expect(plan.routes).toBe(candidates);
    expect(plan.routes.some((candidate) => candidate.hazardAdvisory)).toBe(
      false,
    );
    expect(plan.routes.some((candidate) => candidate.warnings?.length)).toBe(
      false,
    );
  });
});
