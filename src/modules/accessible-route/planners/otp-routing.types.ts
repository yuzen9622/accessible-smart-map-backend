/**
 * Type declarations for the OTP2 transit planner client (otp-routing.ts).
 */

import type { AccessibilityMode } from "../../../types/route";

export interface OtpStop {
  gtfsId: string;
  code?: string;
  lat?: number;
  lon?: number;
}
export interface OtpPlace {
  name?: string;
  stop?: OtpStop | null;
}
export interface OtpLeg {
  mode: string;
  startTime: number;
  endTime: number;
  duration?: number;
  distance?: number;
  from: OtpPlace;
  to: OtpPlace;
  route?: {
    gtfsId?: string;
    shortName?: string;
    longName?: string;
    type?: number;
    agency?: { gtfsId?: string };
  } | null;
  trip?: { gtfsId?: string; wheelchairAccessible?: string } | null;
  legGeometry?: { points?: string } | null;
  intermediatePlaces?: { name?: string; lat?: number; lon?: number; stop?: OtpStop | null }[] | null;
  steps?: OtpStep[] | null;
}
export interface OtpStep {
  distance?: number;
  lon?: number;
  lat?: number;
  relativeDirection?: string | null;
  absoluteDirection?: string | null;
  streetName?: string | null;
  area?: boolean | null;
  bogusName?: boolean | null;
}
export interface OtpItinerary {
  duration: number;
  walkDistance?: number;
  legs: OtpLeg[];
}

export interface PlanOtpRouteOptions {
  departureTime?: Date;
  maxTransfers?: 0 | 1 | 2;
  mode?: AccessibilityMode;
  limit?: number;
  /** Request step-free routing from OTP. Defaults to `mode === "wheelchair"`. */
  avoidStairs?: boolean;
}

export interface SnapStop {
  lat: number;
  lng: number;
  name: string;
}
