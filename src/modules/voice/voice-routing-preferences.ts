import { getConfig, accessibilityModeFromProfile } from "../user/user.service";
import type { RoutingPreferences } from "../../types/agent-route";

/** Read stored requirements once per voice session; never write or invent a profile. */
export async function loadVoiceRoutingPreferences(
  userId: string,
  supplied: RoutingPreferences = {},
): Promise<RoutingPreferences> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = await Promise.race([
      getConfig(userId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Profile lookup timed out")),
          2_000,
        );
      }),
    ]);
    const profile = config?.accessibility;
    return {
      mode: accessibilityModeFromProfile(profile) ?? "normal",
      ...(typeof profile?.canUseStairs === "boolean"
        ? { avoidStairs: !profile.canUseStairs }
        : {}),
      ...(typeof profile?.needsElevator === "boolean"
        ? { requireElevator: profile.needsElevator }
        : {}),
      ...supplied,
    };
  } catch {
    return supplied;
  } finally {
    clearTimeout(timer);
  }
}
