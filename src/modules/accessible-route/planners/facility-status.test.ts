import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../config/fetch", () => ({
  tdxFetch: vi.fn(async () => ({ ok: true, json: async () => [] })),
}));
vi.mock("../../../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn(),
}));

import { fetchTaipeiMetroNotices } from "../../../adapters/taipei-metro-notice.adapter";
import type { AccessibleRoute, MetroLeg } from "../../../types/route";
import {
  overlayFacilityStatus,
  probeMetroElevatorOutages,
} from "./facility-status";

function metroRoute(
  railSystem: string,
  departureStation: string,
  arrivalStation: string,
): AccessibleRoute {
  const leg = {
    type: "METRO",
    railSystem,
    departureStation,
    arrivalStation,
    departureStationUid: `${railSystem}_X01`,
    arrivalStationUid: `${railSystem}_X02`,
    facilityHighlights: [],
  } as unknown as MetroLeg;
  return {
    legs: [leg],
    accessibilityHighlights: [],
  } as unknown as AccessibleRoute;
}

const recent = new Date(Date.now() - 60 * 60 * 1000);

beforeEach(() => {
  vi.mocked(fetchTaipeiMetroNotices).mockReset();
  vi.mocked(fetchTaipeiMetroNotices).mockResolvedValue([
    {
      postedAt: recent,
      line: "板南線",
      station: "頂埔站",
      description: "月台電梯暫停使用，進行檢修",
    },
  ]);
});

describe("overlayFacilityStatus — Taipei Metro notices", () => {
  it("warns on a TRTC leg touching a station with an active notice", async () => {
    const route = metroRoute("TRTC", "頂埔", "板橋");
    const affected = await overlayFacilityStatus([route]);

    expect(affected.has(route)).toBe(true);
    const leg = route.legs[0] as MetroLeg;
    expect(
      leg.facilityHighlights.some((h) =>
        h.includes("乘車站「頂埔」電梯暫停中"),
      ),
    ).toBe(true);
    expect(route.accessibilityHighlights.some((h) => h.includes("頂埔"))).toBe(
      true,
    );
  });

  it("leaves a route through unaffected stations alone", async () => {
    const route = metroRoute("TRTC", "板橋", "西門");
    const affected = await overlayFacilityStatus([route]);

    expect(affected.size).toBe(0);
    expect((route.legs[0] as MetroLeg).facilityHighlights).toEqual([]);
  });

  it("never applies Taipei notices to another metro system", async () => {
    const route = metroRoute("KRTC", "頂埔", "美麗島");
    const affected = await overlayFacilityStatus([route]);

    expect(affected.size).toBe(0);
    expect(fetchTaipeiMetroNotices).not.toHaveBeenCalled();
  });
});

describe("probeMetroElevatorOutages — Taipei Metro notices", () => {
  it("reports the notice for a corridor station", async () => {
    const outages = await probeMetroElevatorOutages([
      { railSystem: "TRTC", stationUid: "TRTC_BL01", stationName: "頂埔" },
    ]);

    expect(outages).toEqual([
      expect.objectContaining({
        stationId: "BL01",
        stationName: "頂埔",
        keyword: "暫停",
      }),
    ]);
  });
});
