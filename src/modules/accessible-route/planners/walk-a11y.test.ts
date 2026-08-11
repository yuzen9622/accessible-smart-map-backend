import { describe, expect, it } from "vitest";
import {
  deriveWalkA11yDetails,
  unknownWalkA11yDetails,
  type WalkA11yFacility,
} from "./walk-a11y";

const line: [number, number][] = [
  [0, 0],
  [0.001, 0],
];

const facility = (
  osmId: string,
  category: string,
  tags: Record<string, unknown>,
  coordinates: [number, number] = [0, 0],
): WalkA11yFacility => ({
  osmId,
  category,
  tags,
  location: { coordinates },
});

describe("WALK B12 a11y details", () => {
  it("uses explicit unknowns when no source-backed facility data is attached", () => {
    expect(unknownWalkA11yDetails()).toEqual({
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
    });
    expect(deriveWalkA11yDetails([], line)).toEqual(unknownWalkA11yDetails());
  });

  it("faithfully derives surface, width, incline, crossing/kerb, and accessible toilet tags", () => {
    const details = deriveWalkA11yDetails([
      facility("way/crossing", "kerb_cut", {
        surface: "asphalt",
        width: "1.25 m",
        incline: "-6.5%",
        highway: "crossing",
        kerb: "lowered",
      }),
      facility(
        "node/toilet",
        "toilet",
        { amenity: "toilets", "toilets:wheelchair": "yes" },
        [0.0005, 0],
      ),
    ], line);

    expect(details).toEqual({
      maxSlopePercent: 6.5,
      crossings: 1,
      crossingsWithCurbRamp: 1,
      minPathWidthCm: 125,
      surfaceType: "paved",
      restPoints: [{ type: "accessible_toilet", distanceM: 56 }],
    });
  });

  it("accepts genuine numeric and unit-qualified OSM tag variants without inventing missing observations", () => {
    const details = deriveWalkA11yDetails([
      facility("way/gravel", "wheelchair_accessible", {
        surface: "fine_gravel",
        incline: 4,
        width: "3 ft 6 in",
      }),
      facility("node/crossing", "wheelchair_accessible", {
        highway: "crossing",
      }),
    ], line);

    expect(details).toMatchObject({
      maxSlopePercent: 4,
      crossings: 1,
      // A crossing without an explicit kerb/ramp tag remains unknown, not zero.
      crossingsWithCurbRamp: null,
      minPathWidthCm: 106.68,
      surfaceType: "gravel",
      restPoints: [],
    });
  });
});
