/**
 * nav-instructions module type declarations — the turn-by-turn instruction
 * shapes the service produces and the result envelope it returns.
 */

import type { ResponseCode } from "../../types/code";

export type RelativeDirection =
  | "正前方"
  | "左前方"
  | "右前方"
  | "左側"
  | "右側"
  | "左後方"
  | "右後方"
  | "正後方";

export type NavInstructionType =
  | "turn"
  | "transit_board"
  | "transit_alight"
  | "facility"
  | "depart"
  | "arrive";

export type NavLegType =
  "WALK" | "DRIVE" | "MOTORCYCLE" | "BUS" | "METRO" | "THSR" | "TRA";

export type NavWarningCode =
  "WALK_STEPS_UNAVAILABLE" | "ORS_STEPS_UNAVAILABLE" | "ROAD_STEPS_UNAVAILABLE";

export interface NavInstruction {
  text: string;
  type: NavInstructionType;
  bearing: number | null;
  relativeDirection: RelativeDirection | null;
  distanceM: number | null;
  streetName: string | null;
  legType: NavLegType;
  stairs: boolean;
  legIndex: number;
  polylineIndex: number | null;
  cumulativeDistanceM: number;
}

export interface NavInstructionsResult {
  instructions: NavInstruction[];
  initialBearing: number;
  totalSteps: number;
  warnings: NavWarningCode[];
}

export interface NavRouteInput {
  routeId?: string;
  legs: unknown[];
}

export interface NavInstructionsInput {
  routeToken: string;
  userHeading?: number;
}

export type GenerateNavResult =
  | { ok: true; data: NavInstructionsResult }
  | { ok: false; status: ResponseCode; reason: string; message: string };
