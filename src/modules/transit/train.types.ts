import type { SupportedLang } from "../../types/lang";
import type { RailSystem } from "../../types/rail";
import type { ResponseCode } from "../../types/code";

export interface TrainServiceError {
  ok: false;
  error: string;
  /** Omitted for validation errors; upstream failures carry 503. */
  status?: ResponseCode.INVALID_INPUT | ResponseCode.SERVICE_UNAVAILABLE;
}

export interface TrainTimetableParams {
  lang?: SupportedLang;
  originStation: string;
  destinationStation: string;
  date?: string;
  departAfter?: string;
  arriveBy?: string;
  railSystem?: RailSystem;
}

export interface StationTimetableParams {
  lang?: SupportedLang;
  station: string;
  date?: string;
  departAfter?: string;
  railSystem?: RailSystem;
}

export interface StationSuggestParams {
  lang?: SupportedLang;
  query?: string;
  railSystem?: RailSystem;
}

export interface StationSuggestion {
  name: string;
  displayName?: string;
  stationID: string;
}

export type StationSuggestResult =
  | { ok: true; railSystem: RailSystem; stations: StationSuggestion[] }
  | TrainServiceError;

export interface TrainTimetableEntry {
  trainNo: string;
  trainType?: string;
  trainTypeDisplayName?: string;
  departureTime: string;
  arrivalTime: string;
  arrivesNextDay?: true;
  durationMinutes: number;
}

export interface StationTimetableEntry {
  trainNo: string;
  trainType?: string;
  trainTypeDisplayName?: string;
  direction?: number;
  destination?: string;
  destinationDisplayName?: string;
  departureTime: string;
  arrivalTime?: string;
}

export type TrainTimetableResult =
  | {
      ok: true;
      railSystem: RailSystem;
      date: string;
      origin: { name: string; stationID: string; displayName?: string };
      destination: { name: string; stationID: string; displayName?: string };
      totalCount: number;
      matchedCount: number;
      firstTrain: string | null;
      lastTrain: string | null;
      trains: TrainTimetableEntry[];
      note?: string;
    }
  | TrainServiceError;

export type StationTimetableResult =
  | {
      ok: true;
      railSystem: RailSystem;
      date: string;
      station: { name: string; stationID: string; displayName?: string };
      departAfter: string;
      totalCount: number;
      matchedCount: number;
      firstTrain: string | null;
      lastTrain: string | null;
      trains: StationTimetableEntry[];
      note?: string;
    }
  | TrainServiceError;
