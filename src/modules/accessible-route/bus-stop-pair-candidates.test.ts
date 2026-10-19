import { describe, expect, it } from "vitest";
import type { BusDepartureCandidate } from "../../types/route";
import {
  compareCandidateForMode,
  projectPublicCandidates,
  normalizeVehicleAccessibility,
  groupRoutesByTransitSkeleton,
} from "./bus-stop-pair-candidates";

export const candidate = (
  id: string,
  minute: number,
  arrival: number,
  vehicleAccessibility: BusDepartureCandidate["vehicleAccessibility"] = "unknown",
): BusDepartureCandidate => ({
  candidateId: id,
  routeName: id,
  subRouteUid: id,
  direction: 0,
  departureStopId: "A",
  arrivalStopId: "B",
  estimatedWaitMinutes: minute,
  boardingTime: `2026-10-18T08:${String(minute).padStart(2, "0")}:00+08:00`,
  alightingTime: `2026-10-18T${arrival === 60 ? "09:00" : `08:${String(arrival).padStart(2, "0")}`}:00+08:00`,
  boardingTimeSource: "realtime",
  alightingTimeSource: "realtime",
  vehicleAccessibility,
  hasLiftOrRamp: null,
  selected: false,
});

describe("physical stop-pair candidates", () => {
  it("retains global selected sixth service rather than the fifth boarding", () => {
    const all = [1, 2, 3, 4, 5].map((n) => candidate(String(n), n, 60));
    all.push(candidate("105", 6, 20));
    const projected = projectPublicCandidates(all, "normal", "105");
    expect(projected.map((c) => c.candidateId)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "105",
    ]);
    expect(projected.find((c) => c.selected)?.candidateId).toBe("105");
  });
  it("uses boarding, never alighting, and deterministic identity ties", () => {
    expect(
      [candidate("b", 2, 10), candidate("a", 1, 60)]
        .sort(compareCandidateForMode("normal"))
        .map((c) => c.candidateId),
    ).toEqual(["a", "b"]);
  });
  it("preserves low-floor bucket after selected replacement and excludes high-floor", () => {
    const all = [1, 2, 3, 4, 5].map((n) =>
      candidate(String(n), n + 10, 60, "low_floor"),
    );
    all.push(
      candidate("unknown", 1, 20),
      candidate("high", 0, 10, "high_floor"),
    );
    expect(
      projectPublicCandidates(all, "wheelchair", "unknown").map(
        (c) => c.candidateId,
      ),
    ).toEqual(["1", "2", "3", "4", "unknown"]);
  });
  it.each([
    [1, undefined, "low_floor"],
    [0, undefined, "high_floor"],
    [undefined, undefined, "unknown"],
    [0, 1, "low_floor"],
    [false, false, "high_floor"],
  ] as const)("normalizes vehicle %s/%s", (low, lift, want) =>
    expect(normalizeVehicleAccessibility(low, lift)).toBe(want),
  );
  it("groups canonical pairs independently of route-local direction, not reverse pairs", () => {
    const route = (
      id: string,
      direction: number,
      board = "A",
      alight = "B",
    ) => ({
      routeId: id,
      legs: [
        {
          type: "BUS",
          routeName: id,
          subRouteUid: id,
          direction,
          _canonicalDepartureStopId: board,
          _canonicalArrivalStopId: alight,
          cityCode: "TPE",
        },
      ],
    });
    const groups = groupRoutesByTransitSkeleton([
      route("14", 0),
      route("105", 1),
      route("reverse", 0, "B", "A"),
    ] as never);
    expect(groups.map((g) => g.members.length).sort()).toEqual([1, 2]);
  });
});
