import {
  venueGateInstruction,
  venueNavInstructions,
} from "../../utils/venue-nav-instructions";
import { DEFAULT_LANG } from "../../types/lang";
import { NAV_API_MSG } from "../../constants/messages";
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
 * while this module uses its localized instruction generator. This module also
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
 * Resolve the server-side route behind the token before generating instructions.
 * @param input The routeToken plus an optional current heading.
 * @returns Generated instructions or a bounded input error.
 */
export async function generateNavInstructionsFromInput(
  input: NavInstructionsInput,
): Promise<GenerateNavResult> {
  const { getRouteByToken } =
    await import("../accessible-route/route-token.service");
  const route = await getRouteByToken(input.routeToken, {
    includeVenueLegs: true,
  });
  if (!route) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      reason: "INVALID_ROUTE_TOKEN",
      message: NAV_API_MSG[input.language ?? DEFAULT_LANG].INVALID_TOKEN,
    };
  }
  const { venueLegs } = route;
  if (!venueLegs?.departure && !venueLegs?.arrival)
    return generateNavInstructions(route, input.userHeading, input.language);
  const outdoor = route.legs.length
    ? generateNavInstructions(route, input.userHeading, input.language)
    : null;
  if (outdoor && !outdoor.ok) return outdoor;
  const lastLeg = route.legs.at(-1);
  const instructions = [
    ...venueNavInstructions(venueLegs.departure, 0, 0),
    ...(outdoor?.ok
      ? outdoor.data.instructions.map((step) =>
          venueLegs.arrival && step.type === "arrive"
            ? { ...step, text: venueGateInstruction(input.language) }
            : step,
        )
      : []),
    ...venueNavInstructions(
      venueLegs.arrival,
      Math.max(0, route.legs.length - 1),
      Math.max(0, (lastLeg?.polyline.length ?? 1) - 1),
    ),
  ];
  let cumulativeDistanceM = 0;
  for (const instruction of instructions) {
    instruction.cumulativeDistanceM = Math.round(cumulativeDistanceM);
    cumulativeDistanceM += instruction.distanceM ?? 0;
  }
  return {
    ok: true,
    data: {
      instructions,
      initialBearing:
        instructions.find((step) => step.bearing !== null)?.bearing ?? 0,
      totalSteps: instructions.length,
      warnings: outdoor?.ok ? outdoor.data.warnings : [],
    },
  };
}
