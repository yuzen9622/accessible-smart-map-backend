import type { SupportedLang } from "../types/lang";
import type {
  VenueRoute,
  VenueStepType,
} from "../modules/accessible-route/venue-leg.types";
import type {
  NavInstruction,
  NavInstructionType,
} from "../modules/nav-instructions/nav-instructions.types";

const VENUE_STEP_TYPE: Record<VenueStepType, NavInstructionType> = {
  depart: "depart",
  walk: "turn",
  enter: "turn",
  exit: "turn",
  elevator: "facility",
  escalator: "facility",
  stairs: "facility",
  steps: "facility",
  ramp: "facility",
  arrive: "arrive",
};

export function venueGateInstruction(
  language: SupportedLang = "zh-TW",
): string {
  return language === "en"
    ? "You have reached the campus gate. Indoor directions follow."
    : "已到達校門，接下來是校內路線";
}

export type VenueNavInstruction = NavInstruction & {
  legType: "VENUE";
  driver: "manual";
  venueStepType: VenueStepType;
  buildingId: string | null;
  levelRef: string | null;
};

/** Indoor progress is confirmed by the user because GPS cannot distinguish floors. */
export function venueNavInstructions(
  leg: VenueRoute | undefined,
  legIndex: number,
  polylineIndex: number,
): VenueNavInstruction[] {
  let cumulativeDistanceM = 0;
  return (leg?.steps ?? []).map((step) => {
    const instruction: VenueNavInstruction = {
      text: step.instruction,
      type: VENUE_STEP_TYPE[step.type],
      legIndex,
      legType: "VENUE",
      polylineIndex,
      distanceM: step.distanceM > 0 ? Math.round(step.distanceM) : null,
      cumulativeDistanceM: Math.round(cumulativeDistanceM),
      bearing: null,
      relativeDirection: null,
      maneuver: null,
      streetName: null,
      stairs: step.type === "stairs" || step.type === "steps",
      driver: "manual",
      venueStepType: step.type,
      buildingId: step.buildingId,
      levelRef: step.levelRef,
      ...(step.fromLevelRef ? { fromLevelRef: step.fromLevelRef } : {}),
      ...(step.toLevelRef ? { toLevelRef: step.toLevelRef } : {}),
    };
    cumulativeDistanceM += step.distanceM;
    return instruction;
  });
}
