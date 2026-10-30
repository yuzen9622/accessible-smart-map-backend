import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metroFind: vi.fn(),
  bathroomFind: vi.fn(),
  osmFind: vi.fn(),
  parkingFind: vi.fn(),
  parkingLotFind: vi.fn(),
  parkingSpaceFind: vi.fn(),
  parkAreaFind: vi.fn(),
  parkEntranceFind: vi.fn(),
}));

vi.mock("../../model/a11y.model", () => ({
  default: { find: mocks.metroFind },
}));
vi.mock("../../model/bathroom.model", () => ({
  default: { find: mocks.bathroomFind },
}));
vi.mock("../../model/osm-a11y.model", () => ({
  default: { find: mocks.osmFind },
}));
vi.mock("../../model/disabled-parking.model", () => ({
  default: { find: mocks.parkingFind },
}));
vi.mock("../../model/parking-lot.model", () => ({
  default: { find: mocks.parkingLotFind },
}));
vi.mock("../../model/parking-space.model", () => ({
  default: { find: mocks.parkingSpaceFind },
}));
vi.mock("../../model/park-area.model", () => ({
  default: { find: mocks.parkAreaFind },
}));
vi.mock("../../model/park-entrance.model", () => ({
  default: { find: mocks.parkEntranceFind },
}));

import { findNearbyA11yRowsInBounds } from "./a11y.repository";

function leanQuery<T>(docs: T[]) {
  return { lean: vi.fn().mockResolvedValue(docs) };
}

describe("findNearbyA11yRowsInBounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metroFind.mockReturnValue(leanQuery([]));
    mocks.osmFind.mockReturnValue(leanQuery([]));
    mocks.bathroomFind.mockResolvedValue([]);
    mocks.parkingFind.mockResolvedValue([]);
  });

  it("queries each collection once with the same GeoJSON polygon", async () => {
    const bounds: [number, number, number, number] = [
      120.68, 24.13, 120.69, 24.14,
    ];

    await findNearbyA11yRowsInBounds(bounds);

    const polygon = {
      type: "Polygon",
      coordinates: [
        [
          [120.68, 24.13],
          [120.69, 24.13],
          [120.69, 24.14],
          [120.68, 24.14],
          [120.68, 24.13],
        ],
      ],
    };
    const expectedGeo = { $geoWithin: { $geometry: polygon } };

    expect(mocks.metroFind).toHaveBeenCalledTimes(1);
    expect(mocks.bathroomFind).toHaveBeenCalledTimes(1);
    expect(mocks.osmFind).toHaveBeenCalledTimes(1);
    expect(mocks.parkingFind).toHaveBeenCalledTimes(1);
    expect(mocks.metroFind).toHaveBeenCalledWith({ location: expectedGeo });
    expect(mocks.bathroomFind).toHaveBeenCalledWith({
      type: "無障礙廁所",
      location: expectedGeo,
    });
    expect(mocks.osmFind).toHaveBeenCalledWith({ location: expectedGeo });
    expect(mocks.parkingFind).toHaveBeenCalledWith({ location: expectedGeo });
  });
});
