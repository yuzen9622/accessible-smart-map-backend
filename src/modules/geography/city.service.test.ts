import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaiwanCityEn } from "../../types/transit";

vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));
vi.mock("../../adapters/nlsc.adapter", () => ({
  getNlscAdministrativeArea: vi.fn(),
}));
import { getCity } from "../../adapters/google.adapter";
import { getNlscAdministrativeArea } from "../../adapters/nlsc.adapter";
import { resolveCity } from "./city.service";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("resolveCity provider order", () => {
  it("uses NLSC's city without calling Google", async () => {
    vi.mocked(getNlscAdministrativeArea).mockResolvedValue({
      city: TaiwanCityEn.KinmenCounty,
    });
    await expect(resolveCity(24.4325, 118.3186)).resolves.toBe(
      TaiwanCityEn.KinmenCounty,
    );
    expect(getNlscAdministrativeArea).toHaveBeenCalledWith(24.4325, 118.3186);
    expect(getCity).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it("waits for NLSC's null before falling back to Google", async () => {
    let finish!: (area: null) => void;
    vi.mocked(getNlscAdministrativeArea).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.mocked(getCity).mockResolvedValue(TaiwanCityEn.NewTaipei);
    const pending = resolveCity(25.01484, 121.46328);
    expect(getCity).not.toHaveBeenCalled();
    finish(null);
    await expect(pending).resolves.toBe(TaiwanCityEn.NewTaipei);
    expect(getCity).toHaveBeenCalledWith(25.01484, 121.46328);
    expect(console.info).toHaveBeenCalledWith(
      "[city] NLSC unavailable; falling back to Google",
    );
  });

  it("preserves null when neither provider can resolve a city", async () => {
    vi.mocked(getNlscAdministrativeArea).mockResolvedValue(null);
    vi.mocked(getCity).mockResolvedValue(null);
    await expect(resolveCity(25, 121)).resolves.toBeNull();
    expect(getCity).toHaveBeenCalledTimes(1);
  });
});
