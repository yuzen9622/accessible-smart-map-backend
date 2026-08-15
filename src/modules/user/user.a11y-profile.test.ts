import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/config.model", () => ({
  default: {
    findOneAndUpdate: vi.fn(),
  },
}));

import Config from "../../model/config.model";
import { getA11yProfile, updateA11yProfile } from "./user.service";

const configModel = Config as unknown as {
  findOneAndUpdate: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getA11yProfile", () => {
  it("upserts an empty Config doc and returns every field as null when unset", async () => {
    configModel.findOneAndUpdate.mockResolvedValue({ accessibility: undefined });

    const profile = await getA11yProfile("user-1");

    expect(configModel.findOneAndUpdate).toHaveBeenCalledWith(
      { user_id: "user-1" },
      { $setOnInsert: { user_id: "user-1" } },
      { returnDocument: "after", upsert: true },
    );
    expect(profile).toEqual({
      mobilityAid: null,
      canUseStairs: null,
      maxSlopePercent: null,
      needsAccessibleToilet: null,
      needsElevator: null,
      needsHandrail: null,
      visualAssistance: null,
      preferredFontScale: null,
    });
  });

  it("returns the stored profile fields when set", async () => {
    configModel.findOneAndUpdate.mockResolvedValue({
      accessibility: { mobilityAid: "manual_wheelchair", canUseStairs: false },
    });

    const profile = await getA11yProfile("user-1");

    expect(profile.mobilityAid).toBe("manual_wheelchair");
    expect(profile.canUseStairs).toBe(false);
    expect(profile.needsElevator).toBeNull();
  });
});

describe("updateA11yProfile", () => {
  it("only $sets the fields that were provided, namespaced under accessibility", async () => {
    configModel.findOneAndUpdate.mockResolvedValue({
      accessibility: { mobilityAid: "power_wheelchair", maxSlopePercent: 8 },
    });

    const profile = await updateA11yProfile("user-1", {
      mobilityAid: "power_wheelchair",
      maxSlopePercent: 8,
    });

    expect(configModel.findOneAndUpdate).toHaveBeenCalledWith(
      { user_id: "user-1" },
      {
        $set: {
          "accessibility.mobilityAid": "power_wheelchair",
          "accessibility.maxSlopePercent": 8,
        },
        $setOnInsert: { user_id: "user-1" },
      },
      { returnDocument: "after", upsert: true },
    );
    expect(profile.mobilityAid).toBe("power_wheelchair");
    expect(profile.maxSlopePercent).toBe(8);
  });

  it("ignores undefined fields instead of overwriting them with null", async () => {
    configModel.findOneAndUpdate.mockResolvedValue({ accessibility: { canUseStairs: true } });

    await updateA11yProfile("user-1", { canUseStairs: true, mobilityAid: undefined });

    expect(configModel.findOneAndUpdate).toHaveBeenCalledWith(
      { user_id: "user-1" },
      { $set: { "accessibility.canUseStairs": true }, $setOnInsert: { user_id: "user-1" } },
      { returnDocument: "after", upsert: true },
    );
  });
});
