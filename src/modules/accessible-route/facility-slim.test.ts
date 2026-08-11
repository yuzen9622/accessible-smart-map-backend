import { describe, expect, it } from "vitest";
import { compactRoutes, slimFacility, slimRoutes } from "./facility-slim";
import { deriveWalkA11yDetails } from "./planners/walk-a11y";
import type { IOsmA11y } from "../../types";
import type { AccessibleRoute } from "../../types/route";

const baseFacility: IOsmA11y = {
  _id: "1",
  osmId: "way/1",
  category: "wheelchair_accessible",
  location: { type: "Point", coordinates: [121.5, 25.03] },
  importedAt: new Date(),
} as unknown as IOsmA11y;

describe("slimFacility", () => {
  it("keeps the handrail tag, so a downstream stairs/handrail check can still see it after slimming", () => {
    const slim = slimFacility({
      ...baseFacility,
      tags: { highway: "steps", handrail: "yes", some_unrelated_tag: "x" },
    });

    expect(slim.tags).toEqual({ highway: "steps", handrail: "yes" });
  });

  it("retains exact B12 WALK details through slim and compact facility projections", () => {
    const polyline: [number, number][] = [[121.56, 25.04], [121.561, 25.04]];
    const crossing: IOsmA11y = {
      ...baseFacility,
      osmId: "way/crossing",
      category: "kerb_cut",
      tags: {
        highway: "crossing",
        footway: "crossing",
        kerb: "lowered",
        incline: "5%",
        width: "1.2m",
        surface: "asphalt",
      },
    };
    const toilet: IOsmA11y = {
      ...baseFacility,
      osmId: "node/toilet",
      category: "toilet",
      tags: { amenity: "toilets", "toilets:wheelchair": "yes" },
      location: { type: "Point", coordinates: [121.5605, 25.04] },
    };
    const details = deriveWalkA11yDetails([crossing, toilet], polyline);
    const routes: AccessibleRoute[] = [{
      routeId: "b12-compact",
      routeName: "步行",
      totalMinutes: 2,
      transferCount: 0,
      accessibilityHighlights: [],
      legs: [{
        type: "WALK",
        from: "起點",
        to: "終點",
        distanceM: 100,
        minutesEst: 2,
        polyline,
        a11yFacilities: [crossing, toilet],
        ...details,
      }],
    }];

    slimRoutes(routes);
    compactRoutes(routes);

    const walk = routes[0].legs[0];
    expect(walk.type).toBe("WALK");
    if (walk.type !== "WALK") return;
    expect({
      maxSlopePercent: walk.maxSlopePercent,
      crossings: walk.crossings,
      crossingsWithCurbRamp: walk.crossingsWithCurbRamp,
      minPathWidthCm: walk.minPathWidthCm,
      surfaceType: walk.surfaceType,
      restPoints: walk.restPoints,
    }).toEqual(details);
    expect(walk.a11yFacilities).toEqual([]);
    expect(walk.a11yRefs).toEqual(["way/crossing", "node/toilet"]);
    expect(routes[0].facilities?.["way/crossing"]?.tags).toMatchObject({
      footway: "crossing",
      incline: "5%",
      width: "1.2m",
    });
  });
});
