import { describe, expect, it } from "vitest";
import { AccessibleRouteSchema } from "./accessible-route.schema";

const walkLeg = {
  type: "WALK" as const,
  from: "起點",
  to: "終點",
  distanceM: 120,
  minutesEst: 2,
  polyline: [[121.56, 25.04], [121.561, 25.04]],
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown" as const,
  restPoints: [],
};

const route = {
  routeId: "b12-walk",
  routeName: "步行",
  totalMinutes: 2,
  transferCount: 0,
  legs: [walkLeg],
  accessibilityHighlights: [],
};

describe("AccessibleRouteSchema B12 WALK details", () => {
  it("requires the stable explicit unknown-capable WALK detail shape", () => {
    expect(AccessibleRouteSchema.safeParse(route).success).toBe(true);
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{ ...walkLeg, maxSlopePercent: undefined }],
      }).success,
    ).toBe(false);
  });

  it("keeps WALK details strict, including strict rest-point objects", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [{
          ...walkLeg,
          restPoints: [{ type: "accessible_toilet", distanceM: 45, guessed: true }],
        }],
      }).success,
    ).toBe(false);
  });
});
