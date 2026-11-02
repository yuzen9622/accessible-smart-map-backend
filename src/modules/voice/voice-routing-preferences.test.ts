import { describe, expect, it, vi } from "vitest";
const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock("../user/user.service", () => ({
  getConfig,
  accessibilityModeFromProfile: (p: any) =>
    p?.mobilityAid === "manual_wheelchair"
      ? "wheelchair"
      : p?.visualAssistance
        ? "visual_impaired"
        : undefined,
}));
import { loadVoiceRoutingPreferences } from "./voice-routing-preferences";

describe("loadVoiceRoutingPreferences", () => {
  it("reads saved needs without inventing or writing profile data", async () => {
    getConfig.mockResolvedValue({
      accessibility: {
        mobilityAid: "manual_wheelchair",
        canUseStairs: false,
        needsElevator: true,
      },
    });
    expect(await loadVoiceRoutingPreferences("user")).toEqual({
      mode: "wheelchair",
      avoidStairs: true,
      requireElevator: true,
    });
    expect(
      await loadVoiceRoutingPreferences("user", { mode: "elderly" }),
    ).toEqual({ mode: "elderly", avoidStairs: true, requireElevator: true });
    getConfig.mockRejectedValueOnce(new Error("down"));
    expect(await loadVoiceRoutingPreferences("user")).toEqual({});
  });
});
