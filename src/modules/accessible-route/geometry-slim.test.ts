import { describe, expect, it } from "vitest";
import type { AccessibleRoute } from "../../types/route";
import {
  slimRouteGeometry,
  TRANSIT_SIMPLIFY_TOLERANCE_M,
} from "./geometry-slim";

const METRES_PER_DEGREE = 111_320;

function straightWithNoise(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [
    121.5 + i * 0.0001,
    25.0 + (i % 2 === 0 ? 0 : 0.00001),
  ]);
}

function distanceToPathM(
  p: [number, number],
  path: [number, number][],
): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const kx = Math.cos((a[1] * Math.PI) / 180) * METRES_PER_DEGREE;
    const px = (p[0] - a[0]) * kx;
    const py = (p[1] - a[1]) * METRES_PER_DEGREE;
    const bx = (b[0] - a[0]) * kx;
    const by = (b[1] - a[1]) * METRES_PER_DEGREE;
    const len2 = bx * bx + by * by;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
    best = Math.min(best, Math.hypot(px - t * bx, py - t * by));
  }
  return best;
}

function routeWith(
  type: string,
  polyline: [number, number][],
): AccessibleRoute {
  return { legs: [{ type, polyline }] } as unknown as AccessibleRoute;
}

describe("slimRouteGeometry", () => {
  it.each(["BUS", "METRO", "THSR", "TRA"])(
    "simplifies %s legs within tolerance and keeps the endpoints",
    (type) => {
      const original = straightWithNoise(500);
      const route = routeWith(
        type,
        original.map((p) => [...p] as [number, number]),
      );
      slimRouteGeometry([route]);
      const slim = route.legs[0].polyline;

      expect(slim.length).toBeLessThan(original.length / 10);
      expect(slim[0]).toEqual(original[0]);
      expect(slim[slim.length - 1]).toEqual(original[original.length - 1]);
      for (const p of original) {
        expect(distanceToPathM(p, slim)).toBeLessThanOrEqual(
          TRANSIT_SIMPLIFY_TOLERANCE_M + 0.2,
        );
      }
    },
  );

  it.each(["WALK", "DRIVE", "MOTORCYCLE"])(
    "keeps every point of %s legs so indices stay valid",
    (type) => {
      const original = straightWithNoise(500);
      const route = routeWith(type, original);
      slimRouteGeometry([route]);
      expect(route.legs[0].polyline).toHaveLength(original.length);
    },
  );

  it("rounds coordinates to 6 decimals on every leg", () => {
    const route = routeWith("WALK", [
      [121.123456789, 25.987654321],
      [121.2, 25.1],
    ]);
    slimRouteGeometry([route]);
    expect(route.legs[0].polyline[0]).toEqual([121.123457, 25.987654]);
  });

  it("rounds drive step polylines without dropping points", () => {
    const route = {
      legs: [
        {
          type: "DRIVE",
          polyline: [[121.1, 25.1]],
          steps: [
            { polyline: straightWithNoise(50).map(([x, y]) => [x + 1e-9, y]) },
          ],
        },
      ],
    } as unknown as AccessibleRoute;
    slimRouteGeometry([route]);
    const leg = route.legs[0] as { steps: { polyline: [number, number][] }[] };
    expect(leg.steps[0].polyline).toHaveLength(50);
    expect(leg.steps[0].polyline[0]).toEqual([121.5, 25]);
  });
});
