import { ResponseCode } from "../../types/code";
import type {
  RelativeDirection,
  NavInstructionType,
  NavLegType,
  NavInstruction,
  NavInstructionsResult,
  NavRouteInput,
  NavInstructionsInput,
  GenerateNavResult,
  NavWarningCode,
} from "./nav-instructions.types";

export type {
  RelativeDirection,
  NavInstructionType,
  NavLegType,
  NavInstruction,
  NavInstructionsResult,
  NavRouteInput,
  NavInstructionsInput,
  GenerateNavResult,
  NavWarningCode,
};

/**
 * The pure route-to-instructions engine lives in
 * `src/utils/nav-instructions-engine.ts` — a neutral layer outside
 * `src/modules/` — because `accessible-route` uses its WALK-step normalizer
 * while this module uses its Chinese instruction generator. This module also
 * depends on `accessible-route`'s `route-token.service` below, so owning the
 * engine in either feature module would close a module dependency cycle.
 */
export {
  calcBearing,
  degToCompassWord,
  calcRelativeDirection,
  nearestPolylineIndex,
  generateNavInstructions,
  generateNavStepsWithLegIndex,
  WARN_STEPS_UNAVAILABLE,
  WARN_WALK_STEPS_UNAVAILABLE,
  WARN_ROAD_STEPS_UNAVAILABLE,
} from "../../utils/nav-instructions-engine";
export type {
  VoiceNavStep,
  GenerateVoiceNavStepsResult,
} from "../../utils/nav-instructions-engine";

import { generateNavInstructions } from "../../utils/nav-instructions-engine";

/**
 * Resolve the preferred route token or use the compatible inline route before
 * generating instructions.
 * @param input Token/route input plus an optional current heading.
 * @returns Generated instructions or a bounded input error.
 */
export async function generateNavInstructionsFromInput(
  input: NavInstructionsInput,
): Promise<GenerateNavResult> {
  let route = input.route;
  if (input.routeToken) {
    const { getRouteByToken } =
      await import("../accessible-route/route-token.service");
    route = (await getRouteByToken(input.routeToken)) ?? undefined;
    if (!route) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        reason: "INVALID_ROUTE_TOKEN",
        message: "routeToken 無效或已過期",
      };
    }
  }
  if (!route) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      reason: "INVALID_ROUTE_INPUT",
      message: "請提供 route 或 routeToken",
    };
  }
  return generateNavInstructions(route, input.userHeading);
}
