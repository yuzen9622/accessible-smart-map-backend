import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaiwanCityEn } from "../../types/transit";

vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));
vi.mock("../../adapters/nlsc.adapter", () => ({
  getNlscAdministrativeArea: vi.fn(),
}));
import { getCity } from "../../adapters/google.adapter";
import { getNlscAdministrativeArea } from "../../adapters/nlsc.adapter";
import { resolveBusCity } from "./bus.service";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getNlscAdministrativeArea).mockResolvedValue(null);
});

describe("resolveBusCity administrative lookup", () => {
  const location = { latitude: 25.01484, longitude: 121.46328 };

  it("uses NLSC on the GPS fallback and does not call Google", async () => {
    vi.mocked(getNlscAdministrativeArea).mockResolvedValue({
      city: TaiwanCityEn.NewTaipei,
    });
    await expect(resolveBusCity(undefined, location)).resolves.toBe(
      TaiwanCityEn.NewTaipei,
    );
    expect(getNlscAdministrativeArea).toHaveBeenCalledWith(
      location.latitude,
      location.longitude,
    );
    expect(getCity).not.toHaveBeenCalled();
  });

  it.each([TaiwanCityEn.NewTaipei, null])(
    "preserves Google fallback %s",
    async (city) => {
      vi.mocked(getCity).mockResolvedValue(city);
      await expect(resolveBusCity(undefined, location)).resolves.toBe(city);
      expect(getNlscAdministrativeArea).toHaveBeenCalledWith(
        location.latitude,
        location.longitude,
      );
      expect(getCity).toHaveBeenCalledWith(
        location.latitude,
        location.longitude,
      );
    },
  );

  it.each([
    ["新北市", TaiwanCityEn.NewTaipei],
    ["InterCity", "InterCity"],
  ])(
    "retains explicit bus scope %s without reverse geocoding",
    async (input, expected) => {
      await expect(resolveBusCity(input, location)).resolves.toBe(expected);
      expect(getNlscAdministrativeArea).not.toHaveBeenCalled();
      expect(getCity).not.toHaveBeenCalled();
    },
  );

  it("keeps unresolved city null without coordinates", async () => {
    await expect(resolveBusCity()).resolves.toBeNull();
    expect(getNlscAdministrativeArea).not.toHaveBeenCalled();
    expect(getCity).not.toHaveBeenCalled();
  });
});
