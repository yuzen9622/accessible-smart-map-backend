import { beforeEach, describe, expect, it, vi } from "vitest";

const findMock = vi.fn();

vi.mock("../../model/campus-a11y.model", () => ({
  default: { find: (...args: unknown[]) => findMock(...args) },
}));

import CampusA11yModel from "../../model/campus-a11y.model";
import {
  findAllFacilities,
  findFacilitiesInBounds,
  findFacilitiesNearby,
} from "./campus.service";
import { toPublicId } from "./campus.util";

/** Builds the chainable `find().select().lean()` stub Mongoose exposes. */
function mockFind(docs: unknown[]) {
  findMock.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(docs) }),
  });
}

function campusDoc(facilities: unknown[]) {
  return {
    schoolId: 56,
    branchId: 1234,
    schoolName: "國立臺中科技大學",
    branchName: "三民校區",
    facilities,
  };
}

beforeEach(() => {
  findMock.mockReset();
});

describe("findAllFacilities", () => {
  it("flattens located facilities and skips ones without coordinates", async () => {
    mockFind([
      campusDoc([
        {
          facUid: "a",
          facTypeId: 8,
          facType: "無障礙電梯",
          floors: ["1"],
          location: { type: "Point", coordinates: [120.68, 24.15] },
        },
        { facUid: "b", facTypeId: 6, facType: "無障礙廁所", floors: [] },
      ]),
    ]);

    const places = await findAllFacilities();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      facUid: "a",
      campusId: toPublicId(1234),
      type: "elevator",
      facType: "無障礙電梯",
    });
  });
});

describe("findFacilitiesNearby", () => {
  it("keeps only facilities within radiusM and sorts nearest-first", async () => {
    const origin: [number, number] = [120.68, 24.15];
    mockFind([
      campusDoc([
        {
          facUid: "near",
          facTypeId: 8,
          floors: [],
          location: { type: "Point", coordinates: origin },
        },
        {
          facUid: "far",
          facTypeId: 8,
          floors: [],
          // ~1.5km east of origin — inside the 800m buffer campus query,
          // but outside a 200m radius.
          location: { type: "Point", coordinates: [120.695, 24.15] },
        },
        {
          facUid: "mid",
          facTypeId: 8,
          floors: [],
          // ~100m east of origin.
          location: { type: "Point", coordinates: [120.681, 24.15] },
        },
      ]),
    ]);

    const places = await findFacilitiesNearby(24.15, 120.68, 200);
    expect(places.map((p) => p.facUid)).toEqual(["near", "mid"]);
  });

  it("queries campuses with the radius plus buffer", async () => {
    mockFind([]);
    await findFacilitiesNearby(24.15, 120.68, 150);
    const query = findMock.mock.calls[0][0] as {
      location: { $near: { $maxDistance: number } };
    };
    expect(query.location.$near.$maxDistance).toBe(150 + 800);
  });
});

describe("findFacilitiesInBounds", () => {
  it("filters flattened facilities by their own coordinates", async () => {
    mockFind([
      campusDoc([
        {
          facUid: "inside",
          facTypeId: 8,
          floors: [],
          location: { type: "Point", coordinates: [120.685, 24.15] },
        },
        {
          facUid: "outside",
          facTypeId: 8,
          floors: [],
          location: { type: "Point", coordinates: [120.7, 24.15] },
        },
        { facUid: "unlocated", facTypeId: 8, floors: [] },
      ]),
    ]);

    const places = await findFacilitiesInBounds([120.68, 24.14, 120.69, 24.16]);
    expect(places.map((place) => place.facUid)).toEqual(["inside"]);
  });

  it("queries embedded facility locations with one geoWithin query", async () => {
    mockFind([]);
    const bounds: [number, number, number, number] = [
      120.68, 24.14, 120.69, 24.16,
    ];

    await findFacilitiesInBounds(bounds);

    expect(findMock).toHaveBeenCalledTimes(1);
    expect(findMock).toHaveBeenCalledWith({
      "facilities.location": {
        $geoWithin: {
          $geometry: {
            type: "Polygon",
            coordinates: [
              [
                [120.68, 24.14],
                [120.69, 24.14],
                [120.69, 24.16],
                [120.68, 24.16],
                [120.68, 24.14],
              ],
            ],
          },
        },
      },
    });
  });
});

it("uses the mocked model", () => {
  expect(CampusA11yModel.find).toBeTypeOf("function");
});
